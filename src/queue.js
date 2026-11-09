// 📋 Antrian: prompts the user lines up for a project, sent one at a time by the server whenever that project's
// session is idle (not busy, no permission prompt waiting, no cut-short turn to deal with). This sits on top of
// Claude Code's own queue (a prompt sent mid-turn, src/session.js): an item is only sent once the previous turn
// has fully ended, so each item gets a turn of its own and its own result.
//
// Stored with the office state (state.json → persisted.queues), so it survives a restart. An item's attachment bytes
// live next to it in data/queue-files/<project>/<item>/ (only their name/kind/size are in state.json), so they survive
// a restart too. After a restart a queue that was running is paused ("dijeda karena restart"): nothing runs until the
// user resumes it.
// The queue also pauses itself when an item fails (error, stopped with Esc, Claude Code exited) or the account
// hits its usage limit (rate_limit_event with status "rejected"), and tells the user in the project's chat.
// A queue can also have a budget (output tokens and/or cost in USD, counted from each finished item's result):
// once it is used up the queue pauses ('budget'). It is only checked between items: a running turn is never cut.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { budgetStop, consumeBudgetOverride } from './budget.js';
import { activeCount, activeProjects, maxConcurrentOf } from './concurrency.js';
import { cleanAutoLevel } from './effort.js';
import { tierFor } from './model-auto.js';

export const QUEUE_LIMITS = Object.freeze({ items: 30, text: 20000, finished: 20 });
/** Why a queue is paused: by the user, by a server restart, after a failed item, by the usage limit, by its budget,
 *  or because the account/provider under it changed (👤 Akun). */
export const PAUSE_REASONS = ['user', 'restart', 'failed', 'rate_limit', 'budget', 'account'];
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

const ATTACHMENT_KIND = new Set(['image', 'text', 'pdf']);
const ATTACHMENT_FILE = /^a-\d{1,3}$/;
function cleanAttachmentMeta(raw) {
  if (!isObject(raw) || !ATTACHMENT_KIND.has(raw.kind) || typeof raw.name !== 'string' || typeof raw.file !== 'string' || !ATTACHMENT_FILE.test(raw.file)) return null;
  const size = Number(raw.size);
  return {
    kind: raw.kind,
    name: raw.name.slice(0, 200),
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    mediaType: typeof raw.mediaType === 'string' ? raw.mediaType.slice(0, 100) : '',
    file: raw.file,
  };
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
    routineId: typeof raw.routineId === 'string' ? raw.routineId.slice(0, 40) : null,
    retried: raw.retried === true,
    runbookId: /^rb_[A-Za-z0-9_-]{1,40}$/.test(String(raw.runbookId ?? '')) ? raw.runbookId : null,
    runbookIndex: Number.isInteger(raw.runbookIndex) && raw.runbookIndex >= 0 ? raw.runbookIndex : null,
    engine: raw.engine === 'opencode' || raw.engine === 'claude' ? raw.engine : null, // the engine it was sent to
    pinned: raw.pinned === true, // 📌 runs before interactive prompts (ignored once the item starts)
    autoDeferred: raw.autoDeferred === true, // Effort/Model Auto is classified at dispatch (queued at the turn limit)
    autoLevel: cleanAutoLevel(raw.autoLevel) ?? cleanAutoLevel(raw.effort), // the Model Auto tier decision
    effort: cleanAutoLevel(raw.effort) ?? cleanAutoLevel(raw.autoLevel), // the Effort Auto thinking decision
    effortReason: typeof raw.effortReason === 'string' ? raw.effortReason.slice(0, 300) : null,
    effortSource: raw.effortSource === 'llm' || raw.effortSource === 'fallback' ? raw.effortSource : null,
    effortModel: typeof raw.effortModel === 'string' ? raw.effortModel.slice(0, 120) : null,
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).map(cleanAttachmentMeta).filter(Boolean).slice(0, 20),
  };
}

export class TaskQueue {
  /**
   * @param {{ hub: import('./hub.js').Hub, sessions: { get(project): any, stopping?: boolean },
   *           delayMs?: number, now?: () => number,
   *           classify?: (projectId: string, text: string, attachments: any[]) => Promise<{level: string, reason?: string,
   *             source?: string, model?: string}|null>|null }} options
   *   delayMs: how long after the session went idle the next item is sent (never from inside a session callback)
   *   classify: Effort/Model Auto for an item that was queued at the global turn limit (run at dispatch, once)
   */
  constructor({ hub, sessions, ledger = null, delayMs = 400, now = () => Date.now(), classify = null, metrics = null }) {
    this.hub = hub;
    this.sessions = sessions;
    this.ledger = ledger;
    this.delayMs = delayMs;
    this.now = now;
    this.classify = typeof classify === 'function' ? classify : null;
    this.metrics = metrics && typeof metrics.queueStart === 'function' ? metrics : null;
    this.fairTimer = null; // one global timer that picks the oldest waiting item across projects (fair order)
    this.classifying = new Set(); // item ids whose deferred Auto classification is in flight (never twice at once)
    this.durations = new Map(); // project id -> recent turn durations (ms), for the waiting estimate
    this.dispatching = new Set(); // project ids whose prompt is being taken (own status updates ignored) or classified
    this.rev = 0;
    this.queues = this.restore(hub.persisted.queues);
    hub.persisted.queues = this.queues;
    hub.observers?.add((type, data) => this.observe(type, data));
  }

  /** After the projects are known: every page gets each queue's numbers (status.taskQueue) from the snapshot. */
  start() {
    for (const id of Object.keys(this.queues)) this.publish(id, { save: false });
    this.refreshQueuePositions();
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
      retryOnce: Boolean(this.hub.queueRetryOnceFor?.(id)),
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

  /** Where one item's attachment bytes live: data/queue-files/<project>/<item>/. */
  attachmentDir(id, itemId) {
    if (!/^[\w-]{1,64}$/.test(String(id)) || !ID.test(String(itemId))) throw new QueueError(400, 'Item antrian tidak valid.');
    return path.join(this.hub.dataDir, 'queue-files', id, itemId);
  }

  saveAttachments(id, itemId, items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return [];
    const dir = this.attachmentDir(id, itemId);
    mkdirSync(dir, { recursive: true });
    try {
      return list.map((a, i) => {
        const file = `a-${i}`;
        writeFileSync(path.join(dir, file), a.kind === 'text' ? String(a.text ?? '') : Buffer.from(String(a.data ?? ''), 'base64'));
        return { kind: a.kind, name: String(a.name ?? file).slice(0, 200), size: Number(a.size) || 0, mediaType: String(a.mediaType ?? '').slice(0, 100), file };
      });
    } catch {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
      throw new QueueError(500, 'Lampiran antrian gagal disimpan. Coba lagi.');
    }
  }

  loadAttachments(id, item) {
    const list = Array.isArray(item.attachments) ? item.attachments : [];
    if (!list.length) return [];
    const dir = this.attachmentDir(id, item.id);
    return list.map((a) => {
      const file = path.join(dir, a.file);
      if (!existsSync(file)) throw new QueueError(409, `Lampiran "${a.name}" untuk item antrian ini sudah tidak ada. Hapus item atau tambahkan ulang.`);
      const bytes = readFileSync(file);
      return {
        kind: a.kind,
        name: a.name,
        size: a.size,
        mediaType: a.mediaType,
        ...(a.kind === 'text' ? { text: bytes.toString('utf8') } : { data: bytes.toString('base64') }),
      };
    });
  }

  dropAttachments(id, itemId) {
    try {
      rmSync(this.attachmentDir(id, itemId), { recursive: true, force: true });
    } catch {}
  }

  dropProjectAttachments(id) {
    try {
      rmSync(path.join(this.hub.dataDir, 'queue-files', id), { recursive: true, force: true });
    } catch {}
  }

  add(id, text, effort = null, attachmentItems = [], extra = {}) {
    const clean = cleanText(text);
    const q = this.q(id);
    if (q.items.filter((i) => i.status === 'waiting' || i.status === 'running').length >= QUEUE_LIMITS.items) {
      throw new QueueError(400, `Antrian maksimal ${QUEUE_LIMITS.items} item. Tunggu sebagian selesai atau hapus yang tidak perlu.`);
    }
    const now = this.now();
    const itemId = `q_${randomBytes(6).toString('hex')}`;
    const attachments = this.saveAttachments(id, itemId, attachmentItems);
    const item = {
      id: itemId,
      text: clean,
      status: 'waiting',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
      chatId: null,
      resultChatId: null,
      error: null,
      meta: null,
      routineId: typeof extra?.routineId === 'string' ? extra.routineId.slice(0, 40) : null,
      retried: false,
      runbookId: /^rb_[A-Za-z0-9_-]{1,40}$/.test(String(extra?.runbookId ?? '')) ? extra.runbookId : null,
      runbookIndex: Number.isInteger(extra?.runbookIndex) && extra.runbookIndex >= 0 ? extra.runbookIndex : null,
      engine: null,
      pinned: false,
      autoDeferred: extra?.autoDeferred === true,
      autoLevel: cleanAutoLevel(effort?.level),
      effort: cleanAutoLevel(effort?.effort) ?? cleanAutoLevel(effort?.level),
      effortReason: typeof effort?.reason === 'string' ? effort.reason.slice(0, 300) : null,
      effortSource: effort?.source === 'llm' || effort?.source === 'fallback' ? effort.source : null,
      effortModel: typeof effort?.model === 'string' ? effort.model.slice(0, 120) : null,
      attachments,
    };
    q.items.push(item);
    this.trimFinished(q);
    this.changed(id);
    return item;
  }

  update(id, itemId, text, effort = null) {
    const item = this.item(id, itemId);
    if (item.status !== 'waiting') throw new QueueError(409, 'Hanya item yang masih menunggu yang bisa diubah.');
    item.text = cleanText(text);
    if (effort) {
      const level = cleanAutoLevel(effort.level) ?? item.autoLevel;
      item.autoLevel = level;
      item.effort = cleanAutoLevel(effort.effort) ?? level;
      item.effortReason = typeof effort.reason === 'string' ? effort.reason.slice(0, 300) : null;
      item.effortSource = effort.source === 'llm' || effort.source === 'fallback' ? effort.source : null;
      item.effortModel = typeof effort.model === 'string' ? effort.model.slice(0, 120) : null;
    }
    item.updatedAt = this.now();
    // The bubble made when the prompt joined the queue must show the edited text too.
    if (item.chatId) this.hub.updateChat(id, item.chatId, { text: item.text });
    this.changed(id);
    return item;
  }

  /**
   * 📌 Pin/unpin a waiting item. A pinned item goes before interactive prompts and scheduled routines across
   * projects. Running/finished items cannot be pinned (their order is already settled).
   */
  pin(id, itemId, pinned) {
    const item = this.item(id, itemId);
    if (item.status !== 'waiting') throw new QueueError(409, 'Hanya item yang masih menunggu yang bisa dipin.');
    item.pinned = pinned === true;
    item.updatedAt = this.now();
    this.changed(id);
    return item;
  }

  /**
   * Links a waiting item to the chat bubble the route already made for it (a prompt that joined 📋 Antrian at the
   * global turn limit). The same bubble starts its turn later, so it is never shown twice in the chat.
   */
  attachChat(id, itemId, chatId) {
    const item = this.item(id, itemId);
    item.chatId = typeof chatId === 'string' ? chatId : null;
    this.changed(id);
    return item;
  }

  /**
   * Every waiting item, in the exact order the fair scheduler would start them: interactive prompts before scheduled
   * routines/runbooks, then oldest first; a project's next item only becomes eligible after its previous one runs.
   * Paused and missing projects are left out (their items cannot start, so they must not take a position).
   */
  orderedWaiting() {
    const lists = new Map();
    for (const [pid, q] of Object.entries(this.queues)) {
      if (!q || q.paused) continue;
      if (this.running(pid) || this.dispatching.has(pid)) continue; // its turn/classification is already using a slot
      if (!this.idle(pid)) continue; // busy, waiting for an approval, rewinding…
      const project = this.hub.projects?.get?.(pid);
      if (!project || project.virtual) continue;
      const waiting = q.items.filter((i) => i.status === 'waiting');
      if (waiting.length) lists.set(pid, [...waiting]);
    }
    const out = [];
    while (lists.size) {
      let best = null;
      for (const [pid, list] of lists) {
        const item = list[0];
        const pinned = item.pinned === true;
        const interactive = !item.routineId && !item.runbookId;
        if (
          !best ||
          (pinned && !best.pinned) ||
          (pinned === best.pinned && interactive && !best.interactive) ||
          (pinned === best.pinned && interactive === best.interactive && (item.createdAt ?? 0) < (best.item.createdAt ?? 0))
        ) {
          best = { projectId: pid, item, pinned, interactive };
        }
      }
      out.push({ projectId: best.projectId, item: best.item });
      const list = lists.get(best.projectId);
      list.shift();
      if (!list.length) lists.delete(best.projectId);
    }
    return out;
  }

  /** The global queue position (1…N) of one waiting item, or null when it cannot start (paused/missing project). */
  positionFor(itemId) {
    const index = this.orderedWaiting().findIndex((entry) => entry.item.id === itemId);
    return index >= 0 ? index + 1 : null;
  }

  /**
   * The global queue position (1…N) of every waiting item, shown in its chat bubble. Only changes are written, and
   * only for items that have a bubble. Called on every change and at start, so a removed/finished item shifts the
   * rest — across projects too, matching the fair scheduler.
   */
  refreshQueuePositions() {
    const order = this.orderedWaiting();
    const positions = new Map();
    order.forEach((entry, i) =>
      positions.set(entry.item.id, { position: i + 1, etaMs: this.estimateWaitMs(entry.item, order) }),
    );
    for (const [pid, q] of Object.entries(this.queues)) {
      for (const item of q.items) {
        if (item.status !== 'waiting' || !item.chatId) continue;
        const next = positions.get(item.id) ?? null;
        const message = this.hub.rt?.(pid)?.chat?.findLast?.((m) => m.id === item.chatId);
        if (!message) continue;
        const patch = {};
        if (message.queuePosition !== (next?.position ?? null)) patch.queuePosition = next?.position ?? null;
        if ((message.queueEtaMs ?? null) !== (next?.etaMs ?? null)) patch.queueEtaMs = next?.etaMs ?? null;
        if (Object.keys(patch).length) this.hub.updateChat(pid, item.chatId, patch);
      }
    }
  }

  remove(id, itemId) {
    const item = this.item(id, itemId);
    if (item.status === 'running') throw new QueueError(409, 'Item ini sedang berjalan. Hentikan dulu (Stop / Esc), lalu hapus.');
    // The bubble says it was cancelled instead of keeping a position for an item that no longer waits.
    if (item.status === 'waiting' && item.chatId) this.hub.updateChat(id, item.chatId, { queued: false, cancelled: true, queuePosition: null });
    const q = this.queues[id];
    this.dropAttachments(id, item.id);
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
    Object.assign(item, { status: 'waiting', startedAt: null, endedAt: null, chatId: null, resultChatId: null, error: null, meta: null, engine: null, updatedAt: this.now() });
    q.items = [item, ...q.items.filter((i) => i !== item)];
    this.changed(id);
  }

  /** Removes the finished items (done and failed). */
  clearFinished(id) {
    const q = this.queues[id];
    if (!q) return;
    for (const item of q.items) if (item.status === 'done' || item.status === 'failed') this.dropAttachments(id, item.id);
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

  /**
   * An account or provider changed (👤 Akun): every queue that still has work pauses, so nothing runs on a model
   * that may no longer exist. A running item is not cut short — it finishes, and the paused queue holds the rest.
   * Nothing resumes by itself: the user checks the model in 📋 Antrian and continues. Each affected project's chat
   * gets one line, so the pause is never a mystery.
   */
  pauseAll(reason = 'account') {
    const why = PAUSE_REASONS.includes(reason) ? reason : 'account';
    let paused = 0;
    for (const [id, q] of Object.entries(this.queues)) {
      if (!q.items.some((i) => i.status === 'waiting' || i.status === 'running')) continue;
      Object.assign(q, { paused: true, reason: why, pausedAt: this.now() });
      this.changed(id); // saved + published at once (no dispatch: the queue is paused now)
      paused += 1;
      this.hub.chat(id, { kind: 'info', level: 'warning', queue: true, text: '📋 Antrian dijeda: akun berubah. Periksa model lalu lanjutkan.' });
    }
    return paused;
  }

  /**
   * ⏸ Jeda semua antrian yang masih punya pekerjaan, atas permintaan user. Antrian yang sudah dijeda karena
   * masalah lain (gagal, budget, akun, restart) tidak ditimpa alasannya. Giliran yang sedang berjalan tidak dipotong.
   * @returns {number} berapa antrian yang baru dijeda
   */
  pauseAllForUser() {
    let paused = 0;
    for (const [id, q] of Object.entries(this.queues)) {
      if (q.paused || !q.items.some((i) => i.status === 'waiting' || i.status === 'running')) continue;
      Object.assign(q, { paused: true, reason: 'user', pausedAt: this.now() });
      this.changed(id);
      paused += 1;
    }
    return paused;
  }

  /**
   * ▶ Lanjutkan hanya antrian yang dijeda oleh user. Antrian yang berhenti karena gagal/budget/akun/restart tetap
   * dijeda: masalahnya harus dilihat dulu, bukan dihapus oleh satu tombol.
   * @returns {number} berapa antrian yang dilanjutkan
   */
  resumeAllForUser() {
    let resumed = 0;
    for (const [id, q] of Object.entries(this.queues)) {
      if (!q.paused || q.reason !== 'user') continue;
      Object.assign(q, { paused: false, reason: null, pausedAt: null });
      this.changed(id);
      resumed += 1;
    }
    return resumed;
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
    this.dropProjectAttachments(id);
    delete this.queues[id];
    this.changed(id);
  }

  /** Keeps the most recent finished items only (the list never grows without bound). */
  trimFinished(q) {
    const finished = q.items.filter((i) => i.status === 'done' || i.status === 'failed');
    const drop = new Set(finished.slice(0, Math.max(0, finished.length - QUEUE_LIMITS.finished)));
    if (drop.size) {
      const projectId = Object.keys(this.queues).find((pid) => this.queues[pid] === q);
      if (projectId) for (const item of drop) this.dropAttachments(projectId, item.id);
      q.items = q.items.filter((i) => !drop.has(i));
    }
  }

  /** Saved at once (small, and a queue must not lose items to a crash), published, and maybe the next item sent. */
  changed(id) {
    const q = this.queues[id];
    if (q && !q.items.length && !q.paused && !hasBudget(q.budget)) delete this.queues[id];
    this.refreshQueuePositions(); // before the publish: the bubbles and the numbers stay in step
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
    if (type === 'chat' && data?.kind === 'result' && data.source !== 'cli') {
      this.noteTurnDuration(data.project, data.meta?.durationMs);
      return this.onResult(data.project, data);
    }
    // Every project status matters: a project without a queue can still hold the only concurrency slot, and the
    // queue waiting on that slot must be woken when it goes idle (scheduleAll in onStatus).
    if (type === 'status' && data?.project) this.onStatus(data);
  }

  running(id) {
    return this.queues[id]?.items.find((i) => i.status === 'running') ?? null;
  }

  /** Keeps the last ten turn durations of a project (memory only; the queue's finished items survive a restart). */
  noteTurnDuration(id, durationMs) {
    const value = Number(durationMs);
    if (!id || !Number.isFinite(value) || value <= 0 || value > 24 * 60 * 60 * 1000) return;
    const list = this.durations.get(id) ?? [];
    list.push(value);
    if (list.length > 10) list.shift();
    this.durations.set(id, list);
  }

  onResult(id, msg) {
    const item = this.running(id);
    if (!item) return;
    const stopped = !msg.ok && /dihentikan/i.test(msg.text ?? '');
    this.finish(id, item, msg.ok ? { status: 'done' } : { status: 'failed', error: msg.text || 'Giliran berakhir dengan error.' }, msg);
    if (!msg.ok) this.retryOrPause(id, item, stopped ? 'item dihentikan' : 'item gagal');
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
    try {
      const id = status.project;
      if (this.dispatching.has(id)) return; // the session's own updates while it takes the prompt
      const item = this.running(id);
      if (item && !status.busy) {
        // The turn is over without a result: Claude Code exited, the session was reset or the process detached.
        this.finish(id, item, { status: 'failed', error: `Giliran berhenti tanpa hasil (${this.engineName(item, id)} berhenti atau sesi direset).` });
        this.retryOrPause(id, item, 'item berhenti tanpa hasil');
        return;
      }
      if (!item) this.schedule(id);
    } finally {
      // A project going idle frees a concurrency slot for queues waiting on the global limit (src/concurrency.js).
      // A project that just started a turn may have queued items whose position is no longer "next".
      if (!status?.busy || this.queues[status?.project]?.items.some((i) => i.status === 'waiting' && i.chatId)) this.refreshQueuePositions();
      if (!status?.busy) this.scheduleAll();
    }
  }

  /**
   * Re-check every project's queue (a concurrency slot may have opened). One global timer picks the oldest waiting
   * item across all projects (`nextFair`), instead of every project racing its own timer: a busy project the user has
   * been waiting on must not lose the freed slot to a newer queue just because its timer fired first.
   */
  scheduleAll() {
    if (this.fairTimer || this.sessions?.stopping) return;
    if (this.nextFair() === null) return; // nothing waiting / no free slot: a status event will call us again
    this.armFair();
  }

  /** Arms the global timer (once); its tick sends one item and re-arms only if another candidate may fit. */
  armFair() {
    if (this.fairTimer) return;
    const timer = setTimeout(() => {
      this.fairTimer = null;
      const id = this.nextFair();
      if (id === null) return;
      this.runDispatch(id);
      // A project that just started is skipped by nextFair; an item that could not start (paused, budget, a full
      // limit) makes nextFair return null here, so this never polls without work to do.
      if (this.nextFair() !== null) this.armFair();
    }, this.delayMs);
    timer.unref?.();
    this.fairTimer = timer;
  }

  /**
   * The project whose waiting item should go next, or null when nothing can run now. Interactive prompts (typed by
   * the user) go before scheduled routines/runbooks; otherwise the oldest item wins across projects (FIFO).
   */
  nextFair() {
    if (this.sessions?.stopping) return null;
    if (!this.hasRoom()) return null;
    const candidates = [];
    for (const [id, q] of Object.entries(this.queues)) {
      if (q.paused) continue;
      if (this.running(id) || this.dispatching.has(id)) continue;
      if (!this.idle(id)) continue;
      const project = this.hub.projects?.get?.(id);
      if (!project || project.virtual) continue;
      const item = q.items.find((i) => i.status === 'waiting');
      if (!item) continue;
      const pinned = item.pinned === true;
      const interactive = !item.routineId && !item.runbookId;
      candidates.push({ id, pinned, interactive, createdAt: item.createdAt ?? 0 });
    }
    if (!candidates.length) return null;
    candidates.sort(
      (a, b) =>
        a.pinned === b.pinned
          ? a.interactive === b.interactive
            ? a.createdAt - b.createdAt
            : a.interactive
              ? -1
              : 1
          : a.pinned
            ? -1
            : 1,
    );
    return candidates[0].id;
  }

  /**
   * Whether a new turn fits now, counting the projects already being dispatched/classified that are not `busy` yet.
   * Without that reservation, two deferred-Auto dispatches could both start while one slot is free.
   */
  hasRoom(exceptId = null) {
    const limit = maxConcurrentOf(this.hub);
    if (limit <= 0) return true;
    let active = activeCount(this.hub);
    for (const pid of this.dispatching) {
      if (pid === exceptId) continue;
      if (this.hub.runtime.get(pid)?.status?.busy) continue; // already counted by activeProjects
      active += 1;
    }
    return active < limit;
  }

  /** dispatch() is async (a deferred Auto classification); its promise is never awaited by a timer. */
  runDispatch(id) {
    const run = this.dispatch(id);
    if (run && typeof run.catch === 'function') run.catch((err) => console.error(`Antrian ${id}: pengiriman gagal (${err?.message ?? err})`));
  }

  /**
   * Called for every rate_limit_event of a session. "rejected" = that engine's account is out of quota: every
   * queue still going on the SAME engine pauses (a Claude limit says nothing about OpenCode's providers).
   */
  onRateLimit(id, info) {
    if (info?.status !== 'rejected') return;
    const engine = this.hub.engineOf ? this.hub.engineOf(id) : this.hub.engine;
    for (const [pid, q] of Object.entries(this.queues)) {
      if (this.hub.engineOf && this.hub.engineOf(pid) !== engine) continue;
      if (q.paused || !(q.items.some((i) => i.status === 'waiting') || this.running(pid))) continue;
      this.pauseFor(pid, 'rate_limit', engine === 'opencode' ? 'batas pemakaian provider OpenCode tercapai' : 'batas pemakaian akun Claude tercapai');
    }
  }

  finish(id, item, patch, msg = null) {
    const meta = msg?.meta
      ? { durationMs: msg.meta.durationMs ?? null, costUsd: msg.meta.costUsd ?? null, turns: msg.meta.turns ?? null, tokensOut: msg.meta.tokensOut ?? null }
      : null;
    Object.assign(item, { error: null, ...patch, endedAt: this.now(), updatedAt: this.now(), resultChatId: msg?.id ?? null, meta });
    if (item.routineId) {
      this.hub.chat(id, { kind: 'info', ...(item.status === 'failed' ? { level: 'warning' } : {}), text: `⏰ Tugas terjadwal ${item.status === 'failed' ? 'gagal' : 'selesai'}: ${item.text.slice(0, 80)}` });
      const routine = this.hub.persisted?.routines?.find((r) => r.id === item.routineId);
      if (routine) {
        const entry = {
          status: item.status === 'failed' ? 'failed' : 'done',
          at: item.endedAt,
          durationMs: meta?.durationMs ?? null,
          costUsd: meta?.costUsd ?? null,
          error: item.status === 'failed' ? (item.error ?? 'Gagal') : null,
        };
        Object.assign(routine, {
          lastStatus: entry.status,
          lastEndedAt: entry.at,
          lastDurationMs: entry.durationMs,
          lastCostUsd: entry.costUsd,
          lastError: entry.error,
          history: [entry, ...(Array.isArray(routine.history) ? routine.history : [])].slice(0, 5),
        });
        this.hub.save?.();
        this.hub.broadcast?.('routines', this.hub.persisted.routines);
      }
    }
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

  /**
   * 🔁 A failed item with "retry once" on this project goes back to waiting exactly once (the next failure pauses).
   * Never for an item the user stopped: repeating a deliberate stop would be surprising.
   */
  retryOrPause(id, item, why) {
    const q = this.queues[id];
    if (q && this.hub.queueRetryOnceFor?.(id) && !item.retried && !/dihentikan/i.test(why)) {
      Object.assign(item, { status: 'waiting', retried: true, startedAt: null, endedAt: null, updatedAt: this.now() });
      this.changed(id);
      this.hub.chat?.(id, { kind: 'info', queue: true, text: `📋 Item antrian gagal (${why}) — dicoba ulang sekali.` });
      this.schedule(id);
      return;
    }
    this.pauseFor(id, 'failed', why);
  }

  /** Looks again shortly (never synchronously: status updates arrive from inside session callbacks). */
  schedule(id) {
    const q = this.queues[id];
    if (!q || q.paused || !q.items.some((i) => i.status === 'waiting')) return;
    // One global timer picks the oldest runnable item: a project's own timer must never jump the fair order.
    this.scheduleAll();
  }

  /**
   * The engine an item ran on (stored at dispatch), else the project's engine, for the messages the user reads:
   * switching a project's engine later does not rename what a running item was sent to.
   */
  engineName(item = null, id = null) {
    const engine = item?.engine ?? (id && this.hub.engineOf ? this.hub.engineOf(id) : this.hub.engine);
    return engine === 'opencode' ? 'OpenCode' : 'Claude Code';
  }

  /** True when the project's session can take the next item now. */
  idle(id) {
    const st = this.hub.runtime.get(id)?.status;
    if (!st) return true; // no runtime yet: nobody is working in it
    return !st.busy && !st.pending && !st.interrupted && !st.cliBusy && !st.queue && !st.rewinding; // ⏪ OpenCode rewind
  }

  /**
   * Sends the project's next waiting item. Async only for an item queued at the global turn limit whose Effort/Model
   * Auto was deferred (`autoDeferred`): its classifier runs here, once. Every other item runs synchronously up to
   * session.prompt(), exactly as before (the callers never await).
   */
  async dispatch(id) {
    if (this.dispatching.has(id)) return; // already taking this project's prompt (e.g. classifying for it)
    let q = this.queues[id];
    if (!q || q.paused || this.running(id) || this.sessions.stopping) return;
    const item = q.items.find((i) => i.status === 'waiting');
    if (!item) return;
    // Effort/Model Auto for a prompt that was queued while every slot was taken: classify now, not while it waited.
    // A failed classifier keeps the project's settings (level null) and never blocks the item.
    if (item.autoDeferred && this.classify && !this.classifying.has(item.id)) {
      // Nothing to classify yet if the turn cannot start: wait for a slot/idle session, then classify once.
      if (!this.hasRoom(id) || !this.idle(id)) return;
      this.classifying.add(item.id);
      this.dispatching.add(id);
      let auto = null;
      try {
        auto = await this.classify(id, item.text, this.loadAttachments(id, item));
      } catch (err) {
        console.error(`Klasifikasi Auto item antrian ${item.id} gagal: ${err?.message ?? err}`);
      } finally {
        this.classifying.delete(item.id);
        this.dispatching.delete(id);
        // The slot reservation is released here: another project must be able to take it even if this item was
        // cancelled/paused while the classifier ran (the caller's early returns must not strand the queue).
        this.scheduleAll();
      }
      Object.assign(item, {
        autoLevel: cleanAutoLevel(auto?.level),
        effort: cleanAutoLevel(auto?.effort) ?? cleanAutoLevel(auto?.level),
        effortReason: typeof auto?.reason === 'string' ? auto.reason.slice(0, 300) : null,
        effortSource: auto?.source === 'llm' || auto?.source === 'fallback' ? auto.source : null,
        effortModel: typeof auto?.model === 'string' ? auto.model.slice(0, 120) : null,
        autoDeferred: false,
        updatedAt: this.now(),
      });
      // The slot, the session or the queue can change while the classifier runs: never mark a turn running then.
      // `q.items.includes(item)` is the identity check: remove() during classification must really cancel it.
      q = this.queues[id];
      if (!q || q.paused || this.sessions.stopping) return;
      if (!q.items.includes(item) || item.status !== 'waiting' || this.running(id) || !this.idle(id) || !this.hasRoom(id)) return;
      this.scheduleAll(); // another project may use the slot while this one was only classifying
    }
    // 💰 The global budget is a hard stop too: hold the queue (and say why) instead of spending past the limit.
    const stop = budgetStop(this.hub, this.ledger, this.now(), id);
    if (stop && !consumeBudgetOverride(this.hub, this.now())) return this.pauseFor(id, 'budget', `budget ${stop.label} tercapai`);
    if (budgetExceeded(q.budget)) return this.checkBudget(id); // used up while the queue was empty or paused
    const project = this.hub.projects.get(id);
    if (!project || project.virtual || !this.idle(id)) return;
    // Global concurrency limit: do not even mark the item running. The next status event (a turn ending) wakes us.
    if (!this.hasRoom(id)) return;
    const session = this.sessions.get(project);
    const engine = this.hub.engineOf(id);
    Object.assign(item, { status: 'running', startedAt: this.now(), updatedAt: this.now(), error: null, engine });
    this.metrics?.queueStart?.({ waitMs: Number.isFinite(item.createdAt) ? Math.max(0, this.now() - item.createdAt) : 0 });
    let sent;
    try {
      this.dispatching.add(id);
      const settings = this.hub.settingsFor(id);
      const autoEffort = item.effort && settings.effortAuto
        ? { level: item.effort, reason: item.effortReason, source: item.effortSource, model: item.effortModel }
        : null;
      // Model Auto: the item keeps the classifier's level separately from the effort it applies.
      const autoLevel = item.autoLevel ?? item.effort;
      const autoModel = autoLevel && settings.modelAuto ? tierFor(autoLevel, engine, settings.modelTiers) : null;
      // A prompt queued at the turn limit already has its bubble: the session fills that one in instead of adding one.
      const queueChatId = typeof item.chatId === 'string' && item.chatId ? item.chatId : null;
      try {
        const patch = {};
        if (autoEffort) Object.assign(patch, { effort: autoEffort.level, effortAuto: true });
        if (autoModel) Object.assign(patch, { model: autoModel.model, modelAuto: true });
        if (Object.keys(patch).length) {
          this.hub.updateSettings(id, patch);
          session.syncSettings();
        }
        const files = this.loadAttachments(id, item);
        sent = session.prompt(item.text, files, { queueItem: item.id, ...(queueChatId ? { queueChatId } : {}), ...(autoEffort ? { autoEffort } : {}), ...(autoModel ? { autoModel: { tier: autoModel.key, label: autoModel.label, model: autoModel.model } } : {}) });
      } catch (err) {
        sent = null;
        item.error = err.message;
      }
    } finally {
      this.dispatching.delete(id);
      this.scheduleAll(); // a free slot may remain for another project after this dispatch
    }
    item.chatId = sent?.chatId ?? item.chatId; // never forget the bubble of a prompt that was already queued
    if (!session.busy) {
      // Never reached Claude Code (not installed, failed to start): the reason is already in the chat. A queued
      // bubble must not keep saying "antre" for a turn that never started.
      if (item.chatId) this.hub.updateChat(id, item.chatId, { queued: false, cancelled: true, queuePosition: null });
      const name = this.engineName(item, id);
      this.finish(id, item, { status: 'failed', error: item.error ?? `${name} tidak bisa dijalankan.` });
      this.pauseFor(id, 'failed', `${name} tidak bisa dijalankan`);
      return;
    }
    // ▶ A real start (the session accepted it): every observer knows, so a phone can announce it if enabled.
    // Only the project and item id: the payload must never carry prompt text.
    this.hub.broadcast('queue-start', { project: id, itemId: item.id });
    this.changed(id);
  }

  /**
   * The median turn duration of a project (or of all projects when it has no history yet), from the results seen
   * this run and the finished queue items stored with the queue. Null means "no idea yet" (no ETA shown).
   */
  typicalTurnMs(id = null) {
    const median = (list) => {
      const sorted = [...list].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
    };
    const finished = (pid) =>
      (this.queues[pid]?.items ?? [])
        .filter((i) => i.status === 'done' && Number.isFinite(i.meta?.durationMs) && i.meta.durationMs > 0)
        .map((i) => i.meta.durationMs)
        .slice(-10);
    if (id) {
      const own = this.durations.get(id) ?? [];
      if (own.length) return median(own);
      const stored = finished(id);
      if (stored.length) return median(stored);
    }
    const all = [];
    for (const pid of Object.keys(this.queues)) all.push(...finished(pid));
    for (const list of this.durations.values()) all.push(...list);
    return all.length ? median(all) : null;
  }

  /**
   * Rough time until `item` can start (ms), from the durations of the turns ahead. A free slot means ~0. Unknown
   * durations give null (the UI shows no estimate). Slots are simulated: the soonest running turn frees first,
   * each item ahead occupies it for that project's typical turn.
   */
  estimateWaitMs(item, order = this.orderedWaiting()) {
    const index = order.findIndex((entry) => entry.item.id === item.id);
    if (index < 0) return null;
    if (this.hasRoom()) return 0;
    const limit = maxConcurrentOf(this.hub);
    if (limit <= 0) return 0;
    const now = this.now();
    const slots = [];
    const withItem = new Set();
    for (const [pid, q] of Object.entries(this.queues)) {
      for (const it of q.items) {
        if (it.status !== 'running') continue;
        withItem.add(pid);
        const typical = this.typicalTurnMs(pid);
        if (typical == null) return null;
        const elapsed = Number.isFinite(it.startedAt) ? Math.max(0, now - it.startedAt) : 0;
        slots.push(Math.max(0, typical - elapsed));
      }
    }
    // A direct prompt can hold a slot without a queue item: use its project's typical time as the remainder.
    for (const pid of activeProjects(this.hub)) {
      if (withItem.has(pid)) continue;
      const typical = this.typicalTurnMs(pid);
      if (typical == null) return null;
      slots.push(typical);
    }
    while (slots.length < limit) slots.push(0);
    slots.sort((a, b) => a - b);
    for (let i = 0; i < index; i += 1) {
      const typical = this.typicalTurnMs(order[i].projectId);
      if (typical == null) return null;
      slots[0] += typical;
      slots.sort((a, b) => a - b);
    }
    return Math.round(Math.min(...slots));
  }

  /** One line for the log. */
  describe(id) {
    const s = this.summary(id);
    return s ? `${s.waiting} menunggu${s.paused ? `, dijeda (${s.reason})` : ''}` : 'kosong';
  }
}
