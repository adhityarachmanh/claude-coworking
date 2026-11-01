// 📋 Antrian: prompts the user lines up for a project, sent one at a time by the server whenever that project's
// session is idle (not busy, no permission prompt waiting, no cut-short turn to deal with). This sits on top of
// Claude Code's own queue (a prompt sent mid-turn, src/session.js): an item is only sent once the previous turn
// has fully ended, so each item gets a turn of its own and its own result.
//
// Stored with the office state (state.json → persisted.queues), so it survives a restart. After a restart a queue
// that was running is paused ("dijeda karena restart"): nothing is sent until the user resumes it.
// The queue also pauses itself when an item fails (error, stopped with Esc, Claude Code exited) or the account
// hits its usage limit (rate_limit_event with status "rejected"), and tells the user in the project's chat.
// A queue can also have a budget (output tokens and/or cost in USD, counted from each finished item's result):
// once it is used up the queue pauses ('budget'). It is only checked between items: a running turn is never cut.
import { randomBytes } from 'node:crypto';

export const QUEUE_LIMITS = Object.freeze({ items: 30, text: 20000, finished: 20 });
/** Why a queue is paused: by the user, by a server restart, after a failed item, by the usage limit, by its budget. */
export const PAUSE_REASONS = ['user', 'restart', 'failed', 'rate_limit', 'budget'];
/** Allowed budget limits (both inclusive): output tokens (integer) and cost in USD (rounded to cents). */
export const BUDGET_LIMITS = Object.freeze({ tokensOut: Object.freeze({ min: 1000, max: 100_000_000 }), costUsd: Object.freeze({ min: 0.01, max: 10000 }) });
const STATUSES = new Set(['waiting', 'running', 'done', 'failed']);
const ID = /^q_[a-f0-9]{12}$/;
const TEXT_JUNK = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A request the queue refuses; `status` is the HTTP status, the message is shown to the user as is. */
export class QueueError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Validates a prompt for the queue; throws QueueError with a user-facing reason. */
export function cleanText(input) {
  const text = String(input ?? '').replace(/\r\n?/g, '\n').replace(TEXT_JUNK, '').trim();
  if (!text) throw new QueueError(400, 'Isi prompt antrian kosong.');
  if (text.length > QUEUE_LIMITS.text) throw new QueueError(400, `Prompt antrian maksimal ${QUEUE_LIMITS.text} karakter.`);
  return text;
}

// ---------- budget ----------

const emptyBudget = () => ({ tokensOut: null, costUsd: null, spentTokensOut: 0, spentCostUsd: 0, since: null });
const validTokens = (v) => Number.isInteger(v) && v >= BUDGET_LIMITS.tokensOut.min && v <= BUDGET_LIMITS.tokensOut.max;
const validCost = (v) => Number.isFinite(v) && v >= BUDGET_LIMITS.costUsd.min && v <= BUDGET_LIMITS.costUsd.max;
const cents = (v) => Math.round(v * 100) / 100;
/** True when at least one limit is set. */
export const hasBudget = (b) => b?.tokensOut != null || b?.costUsd != null;
/** True when a set limit is used up. */
export const budgetExceeded = (b) => (b?.tokensOut != null && b.spentTokensOut >= b.tokensOut) || (b?.costUsd != null && b.spentCostUsd >= b.costUsd);
/** 12345 -> "12.345" (Indonesian thousands separator, independent of the runtime's locale data). */
const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Validates the limits of POST queue-budget; throws QueueError with a user-facing reason. null (or absent) = no limit. */
export function cleanBudget(input) {
  const body = isObject(input) ? input : {};
  const tokensOut = body.tokensOut ?? null;
  const costUsd = body.costUsd ?? null;
  if (tokensOut !== null && !validTokens(tokensOut)) {
    throw new QueueError(400, `Batas token output harus bilangan bulat ${thousands(BUDGET_LIMITS.tokensOut.min)}–${thousands(BUDGET_LIMITS.tokensOut.max)}, atau kosong.`);
  }
  if (costUsd !== null && !validCost(costUsd)) {
    throw new QueueError(400, `Batas biaya harus angka $${BUDGET_LIMITS.costUsd.min.toFixed(2)}–$${BUDGET_LIMITS.costUsd.max}, atau kosong.`);
  }
  return { tokensOut, costUsd: costUsd === null ? null : cents(costUsd) };
}

/** A stored budget that still looks right (absent in older state.json files; bad values fall back to "no limit"). */
function restoreBudget(raw) {
  if (!isObject(raw)) return emptyBudget();
  const budget = {
    tokensOut: validTokens(raw.tokensOut) ? raw.tokensOut : null,
    costUsd: validCost(raw.costUsd) ? cents(raw.costUsd) : null,
    spentTokensOut: Number.isFinite(raw.spentTokensOut) && raw.spentTokensOut >= 0 ? raw.spentTokensOut : 0,
    spentCostUsd: Number.isFinite(raw.spentCostUsd) && raw.spentCostUsd >= 0 ? raw.spentCostUsd : 0,
    since: Number.isFinite(raw.since) ? raw.since : null,
  };
  return hasBudget(budget) ? budget : emptyBudget();
}

/** A stored item that still looks right (a hand-edited or older state.json never breaks the queue). */
function cleanItem(raw) {
  if (!isObject(raw) || !ID.test(String(raw.id)) || typeof raw.text !== 'string' || !raw.text.trim() || !STATUSES.has(raw.status)) return null;
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    id: raw.id,
    text: raw.text.slice(0, QUEUE_LIMITS.text),
    status: raw.status,
    createdAt: num(raw.createdAt) ?? Date.now(),
    updatedAt: num(raw.updatedAt) ?? Date.now(),
    startedAt: num(raw.startedAt),
    endedAt: num(raw.endedAt),
    chatId: typeof raw.chatId === 'string' ? raw.chatId : null,
    resultChatId: typeof raw.resultChatId === 'string' ? raw.resultChatId : null,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 500) : null,
    meta: isObject(raw.meta) ? raw.meta : null,
  };
}

export class TaskQueue {
  /**
   * @param {{ hub: import('./hub.js').Hub, sessions: { get(project): any, stopping?: boolean },
   *           delayMs?: number, now?: () => number }} options
   *   delayMs: how long after the session went idle the next item is sent (never from inside a session callback)
   */
  constructor({ hub, sessions, delayMs = 400, now = () => Date.now() }) {
    this.hub = hub;
    this.sessions = sessions;
    this.delayMs = delayMs;
    this.now = now;
    this.timers = new Map(); // project id -> pending dispatch check
    this.dispatching = null; // project id while session.prompt() runs (its own status updates are ignored)
    this.rev = 0;
    this.queues = this.restore(hub.persisted.queues);
    hub.persisted.queues = this.queues;
    hub.observers?.add((type, data) => this.observe(type, data));
  }

  /** After the projects are known: every page gets each queue's numbers (status.taskQueue) from the snapshot. */
  start() {
    for (const id of Object.keys(this.queues)) this.publish(id, { save: false });
  }

  /**
   * Stored queues as they were at the last stop. An item still "running" was cut off by the stop (its turn is
   * handled by the "Lanjutkan" notice); a queue that was still going is paused until the user resumes it.
   */
  restore(stored) {
    const queues = {};
    let changed = false;
    for (const [id, raw] of Object.entries(isObject(stored) ? stored : {})) {
      if (!/^[\w-]{1,64}$/.test(id) || !isObject(raw)) continue;
      const items = (Array.isArray(raw.items) ? raw.items : []).map(cleanItem).filter(Boolean);
      const q = { paused: raw.paused === true, reason: PAUSE_REASONS.includes(raw.reason) ? raw.reason : null, pausedAt: Number.isFinite(raw.pausedAt) ? raw.pausedAt : null, items, budget: restoreBudget(raw.budget) };
      if (!q.paused) q.reason = null;
      for (const item of items) {
        if (item.status !== 'running') continue;
        Object.assign(item, { status: 'failed', endedAt: this.now(), updatedAt: this.now(), error: 'Server berhenti saat item ini berjalan.' });
        changed = true;
      }
      if (!q.paused && items.some((i) => i.status === 'waiting')) {
        Object.assign(q, { paused: true, reason: 'restart', pausedAt: this.now() });
        changed = true;
      }
      if (items.length || q.paused || hasBudget(q.budget)) queues[id] = q;
    }
    if (changed) {
      this.hub.persisted.queues = queues;
      this.hub.save();
    }
    return queues;
  }

  // ---------- reading ----------

  /** The queue as the API returns it (a copy). */
  view(id) {
    const q = this.queues[id];
    return {
      project: id,
      paused: q?.paused ?? false,
      reason: q?.reason ?? null,
      pausedAt: q?.pausedAt ?? null,
      items: structuredClone(q?.items ?? []),
      limits: QUEUE_LIMITS,
      budget: { ...(q?.budget ?? emptyBudget()) },
    };
  }

  /** The few numbers the session bar shows (in the project's status, so every page has them from the snapshot). */
  summary(id) {
    const q = this.queues[id];
    if (!q) return null;
    const count = (s) => q.items.filter((i) => i.status === s).length;
    const b = q.budget;
    const budget = hasBudget(b) ? { tokensOut: b.tokensOut, costUsd: b.costUsd, spentTokensOut: b.spentTokensOut, spentCostUsd: b.spentCostUsd } : null;
    return { waiting: count('waiting'), running: count('running'), failed: count('failed'), done: count('done'), paused: q.paused, reason: q.reason, budget, rev: this.rev };
  }

  // ---------- changes (every one is a write: refused over plain WiFi by the server's gate) ----------

  q(id) {
    return (this.queues[id] ??= { paused: false, reason: null, pausedAt: null, items: [], budget: emptyBudget() });
  }

  item(id, itemId) {
    const item = this.queues[id]?.items.find((i) => i.id === String(itemId ?? ''));
    if (!item) throw new QueueError(404, 'Item antrian tidak ditemukan (mungkin sudah dihapus).');
    return item;
  }

  add(id, text) {
    const clean = cleanText(text);
    const q = this.q(id);
    if (q.items.filter((i) => i.status === 'waiting' || i.status === 'running').length >= QUEUE_LIMITS.items) {
      throw new QueueError(400, `Antrian maksimal ${QUEUE_LIMITS.items} item. Tunggu sebagian selesai atau hapus yang tidak perlu.`);
    }
    const now = this.now();
    const item = { id: `q_${randomBytes(6).toString('hex')}`, text: clean, status: 'waiting', createdAt: now, updatedAt: now, startedAt: null, endedAt: null, chatId: null, resultChatId: null, error: null, meta: null };
    q.items.push(item);
    this.trimFinished(q);
    this.changed(id);
    return item;
  }

  update(id, itemId, text) {
    const item = this.item(id, itemId);
    if (item.status !== 'waiting') throw new QueueError(409, 'Hanya item yang masih menunggu yang bisa diubah.');
    item.text = cleanText(text);
    item.updatedAt = this.now();
    this.changed(id);
    return item;
  }

  remove(id, itemId) {
    const item = this.item(id, itemId);
    if (item.status === 'running') throw new QueueError(409, 'Item ini sedang berjalan. Hentikan dulu (Stop / Esc), lalu hapus.');
    const q = this.queues[id];
    q.items = q.items.filter((i) => i !== item);
    this.changed(id);
  }

  /** New order of the waiting items (ids, first = next to run). Must name exactly the waiting items. */
  reorder(id, order) {
    const q = this.queues[id];
    const waiting = q?.items.filter((i) => i.status === 'waiting') ?? [];
    const ids = Array.isArray(order) ? order.map(String) : [];
    if (ids.length !== waiting.length || new Set(ids).size !== ids.length || !waiting.every((i) => ids.includes(i.id))) {
      throw new QueueError(409, 'Urutan antrian sudah berubah di perangkat lain. Muat ulang lalu coba lagi.');
    }
    const byId = new Map(waiting.map((i) => [i.id, i]));
    let next = 0;
    // Finished and running items keep their places; the waiting slots are filled in the new order.
    q.items = q.items.map((i) => (i.status === 'waiting' ? byId.get(ids[next++]) : i));
    this.changed(id);
  }

  /** A failed item goes back to waiting, at the front (it runs next once the queue is resumed). */
  retry(id, itemId) {
    const item = this.item(id, itemId);
    if (item.status !== 'failed') throw new QueueError(409, 'Hanya item yang gagal yang bisa diulang.');
    const q = this.queues[id];
    if (q.items.filter((i) => i.status === 'waiting' || i.status === 'running').length >= QUEUE_LIMITS.items) throw new QueueError(400, `Antrian maksimal ${QUEUE_LIMITS.items} item.`);
    Object.assign(item, { status: 'waiting', startedAt: null, endedAt: null, chatId: null, resultChatId: null, error: null, meta: null, updatedAt: this.now() });
    q.items = [item, ...q.items.filter((i) => i !== item)];
    this.changed(id);
  }

  /** Removes the finished items (done and failed). */
  clearFinished(id) {
    const q = this.queues[id];
    if (!q) return;
    q.items = q.items.filter((i) => i.status === 'waiting' || i.status === 'running');
    this.changed(id);
  }

  setPaused(id, paused, reason = 'user') {
    const q = this.q(id);
    if (paused) Object.assign(q, { paused: true, reason, pausedAt: this.now() });
    else {
      const budgetPause = q.reason === 'budget';
      Object.assign(q, { paused: false, reason: null, pausedAt: null });
      // Resuming a budget pause starts a new budget window (otherwise it would pause again after one item).
      // A budget used up under another pause (an item failed and went over) is not reset silently:
      // dispatch() pauses again with reason "budget" and says so in the chat.
      if (budgetPause && budgetExceeded(q.budget)) Object.assign(q.budget, { spentTokensOut: 0, spentCostUsd: 0, since: this.now() });
    }
    this.changed(id);
  }

  /** Sets the budget limits (validated); spending starts again from 0. Both null = no budget. */
  setBudget(id, input) {
    const { tokensOut, costUsd } = cleanBudget(input);
    const q = this.q(id);
    q.budget = tokensOut === null && costUsd === null ? emptyBudget() : { tokensOut, costUsd, spentTokensOut: 0, spentCostUsd: 0, since: this.now() };
    // A budget pause is no longer about this budget: it stays paused (the user resumes it) but is labelled as such.
    if (q.paused && q.reason === 'budget') q.reason = 'user';
    this.changed(id);
  }

  /** The project was forgotten (⚙ → hapus folder): its queue goes too. */
  forget(id) {
    if (!this.queues[id]) return;
    clearTimeout(this.timers.get(id));
    delete this.queues[id];
    this.changed(id);
  }

  /** Keeps the most recent finished items only (the list never grows without bound). */
  trimFinished(q) {
    const finished = q.items.filter((i) => i.status === 'done' || i.status === 'failed');
    const drop = new Set(finished.slice(0, Math.max(0, finished.length - QUEUE_LIMITS.finished)));
    if (drop.size) q.items = q.items.filter((i) => !drop.has(i));
  }

  /** Saved at once (small, and a queue must not lose items to a crash), published, and maybe the next item sent. */
  changed(id) {
    const q = this.queues[id];
    if (q && !q.items.length && !q.paused && !hasBudget(q.budget)) delete this.queues[id];
    this.publish(id);
    this.schedule(id);
  }

  publish(id, { save = true } = {}) {
    this.rev++;
    if (save) this.hub.save();
    if (this.hub.projects.has(id)) this.hub.setStatus(id, { taskQueue: this.summary(id) });
    this.hub.broadcast('queue', { project: id, rev: this.rev });
  }

  // ---------- running ----------

  /** What the hub broadcasts: a turn's result, a session going idle (or away). */
  observe(type, data) {
    // Server stopping: its turns end as "interrupted"; restore() at the next start records them (paused: restart).
    if (this.sessions.stopping) return;
    if (type === 'chat' && data?.kind === 'result' && data.source !== 'cli') return this.onResult(data.project, data);
    if (type === 'status' && data?.project && this.queues[data.project]) this.onStatus(data);
  }

  running(id) {
    return this.queues[id]?.items.find((i) => i.status === 'running') ?? null;
  }

  onResult(id, msg) {
    const item = this.running(id);
    if (!item) return;
    const stopped = !msg.ok && /dihentikan/i.test(msg.text ?? '');
    this.finish(id, item, msg.ok ? { status: 'done' } : { status: 'failed', error: msg.text || 'Giliran berakhir dengan error.' }, msg);
    if (!msg.ok) this.pauseFor(id, 'failed', stopped ? 'item dihentikan' : 'item gagal');
    this.checkBudget(id); // no-op when the failure above already paused it
  }

  /**
   * Between items only (called after an item's result): a used-up budget pauses the queue before the next item
   * is sent. A running turn is never cut short by the budget, so the spending can end a little above the limit.
   */
  checkBudget(id) {
    const q = this.queues[id];
    const b = q?.budget;
    if (!q || q.paused || !budgetExceeded(b) || !q.items.some((i) => i.status === 'waiting')) return;
    const why = [];
    if (b.tokensOut != null && b.spentTokensOut >= b.tokensOut) why.push(`batas token antrian tercapai (${thousands(b.spentTokensOut)} / ${thousands(b.tokensOut)} token output)`);
    if (b.costUsd != null && b.spentCostUsd >= b.costUsd) why.push(`batas biaya antrian tercapai ($${b.spentCostUsd.toFixed(2)} / $${b.costUsd.toFixed(2)})`);
    this.pauseFor(id, 'budget', why.join(' dan '));
  }

  onStatus(status) {
    const id = status.project;
    if (this.dispatching === id) return; // the session's own updates while it takes the prompt
    const item = this.running(id);
    if (item && !status.busy) {
      // The turn is over without a result: Claude Code exited, the session was reset or the process detached.
      this.finish(id, item, { status: 'failed', error: 'Giliran berhenti tanpa hasil (Claude Code berhenti atau sesi direset).' });
      this.pauseFor(id, 'failed', 'item berhenti tanpa hasil');
      return;
    }
    if (!item) this.schedule(id);
  }

  /**
   * Called for every rate_limit_event of a session. "rejected" = the account is out of quota: every queue that
   * is still going pauses (the limit is per account, not per project).
   */
  onRateLimit(id, info) {
    if (info?.status !== 'rejected') return;
    for (const [pid, q] of Object.entries(this.queues)) {
      if (q.paused || !(q.items.some((i) => i.status === 'waiting') || this.running(pid))) continue;
      this.pauseFor(pid, 'rate_limit', 'batas pemakaian akun Claude tercapai');
    }
  }

  finish(id, item, patch, msg = null) {
    const meta = msg?.meta
      ? { durationMs: msg.meta.durationMs ?? null, costUsd: msg.meta.costUsd ?? null, turns: msg.meta.turns ?? null, tokensOut: msg.meta.tokensOut ?? null }
      : null;
    Object.assign(item, { error: null, ...patch, endedAt: this.now(), updatedAt: this.now(), resultChatId: msg?.id ?? null, meta });
    const b = this.queues[id].budget;
    if (msg && hasBudget(b)) {
      // Every finished turn counts (done or failed): it was spent either way.
      const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
      b.spentTokensOut += n(msg.meta?.tokensOut);
      b.spentCostUsd = Math.round((b.spentCostUsd + n(msg.meta?.costUsd)) * 1e6) / 1e6; // no float dust
    }
    this.trimFinished(this.queues[id]);
    this.changed(id);
  }

  pauseFor(id, reason, why) {
    const q = this.queues[id];
    if (!q || q.paused) return;
    const waiting = q.items.filter((i) => i.status === 'waiting').length;
    Object.assign(q, { paused: true, reason, pausedAt: this.now() });
    this.changed(id);
    if (waiting) this.hub.chat(id, { kind: 'info', level: 'warning', queue: true, text: `📋 Antrian dijeda: ${why}. ${waiting} item masih menunggu — buka 📋 Antrian untuk melanjutkan.` });
  }

  /** Looks again shortly (never synchronously: status updates arrive from inside session callbacks). */
  schedule(id) {
    const q = this.queues[id];
    if (!q || q.paused || this.timers.has(id) || !q.items.some((i) => i.status === 'waiting')) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.dispatch(id);
    }, this.delayMs);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** True when the project's session can take the next item now. */
  idle(id) {
    const st = this.hub.runtime.get(id)?.status;
    if (!st) return true; // no runtime yet: nobody is working in it
    return !st.busy && !st.pending && !st.interrupted && !st.cliBusy && !st.queue;
  }

  dispatch(id) {
    const q = this.queues[id];
    if (!q || q.paused || this.running(id) || this.sessions.stopping) return;
    const item = q.items.find((i) => i.status === 'waiting');
    if (item && budgetExceeded(q.budget)) return this.checkBudget(id); // used up while the queue was empty or paused
    const project = this.hub.projects.get(id);
    if (!item || !project || project.virtual || !this.idle(id)) return;
    const session = this.sessions.get(project);
    Object.assign(item, { status: 'running', startedAt: this.now(), updatedAt: this.now(), error: null });
    this.dispatching = id;
    let sent;
    try {
      sent = session.prompt(item.text, [], { queueItem: item.id });
    } catch (err) {
      sent = null;
      item.error = err.message;
    } finally {
      this.dispatching = null;
    }
    item.chatId = sent?.chatId ?? null;
    if (!session.busy) {
      // Never reached Claude Code (not installed, failed to start): the reason is already in the chat.
      this.finish(id, item, { status: 'failed', error: item.error ?? 'Claude Code tidak bisa dijalankan.' });
      this.pauseFor(id, 'failed', 'Claude Code tidak bisa dijalankan');
      return;
    }
    this.changed(id);
  }

  /** One line for the log. */
  describe(id) {
    const s = this.summary(id);
    return s ? `${s.waiting} menunggu${s.paused ? `, dijeda (${s.reason})` : ''}` : 'kosong';
  }
}
