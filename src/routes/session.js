// ---------- a project's Claude Code session: prompts, shell, stop/reset, history, rewind ----------
// Reads allowed over WiFi: sessions, rewind-points. Everything else acts (refused there by the gate in server.js);
// `search` / `export-session` read, but expose the whole history: laptop and Tailscale only (src/remote.js).
// `redo-conversation` acts too (it moves the conversation / imports a session): refused over WiFi by the same gate.
import { AttachmentError, attachmentChips, readAttachments } from '../attachments.js';
import { budgetStop, consumeBudgetOverride } from '../budget.js';
import { ConversationError, exportSession, SEARCH_LIMITS, searchSessions } from '../conversation.js';
import { searchOpenCodeSessions } from '../opencode-search.js';
import { REWINDING_MESSAGE } from '../acp-session.js';
import { checkTurn } from '../concurrency.js';
import { autoContext, classifyEffort } from '../effort-classifier.js';
import { DEMO_ID } from '../hub.js';
import { QUEUE_LIMITS } from '../queue.js';
import { shortModelLabel, tierFor, classifierModelFor } from '../model-auto.js';
import { listSessions, sessionHistory } from '../transcripts.js';
import { openCodeSessions } from '../opencode-bin.js';
import { importOpenCodeSession, OpenCodeAdminError } from '../opencode-admin.js';
import { deleteSession, exportOpenCodeSession, forkOpenCodeSession, listTrashedSessions, renameClaudeSession, renameOpenCodeSession, restoreTrashedSession, SessionAdminError, TRASH_RETENTION_DAYS, validSessionId } from '../session-admin.js';
import { applyRedo, captureRedo, conversationOf, listRedo, previewRedo, RedoError, sealRedo } from '../redo.js';
import { ZipWriter } from '../zip.js';

/** Runs a 🕘 Riwayat sesi action; SessionAdminError / OpenCode errors become JSON with their status. */
async function admin(res, fn) {
  try {
    return json(res, 200, await fn());
  } catch (err) {
    const status = err instanceof SessionAdminError || err instanceof OpenCodeAdminError ? err.status : (err.status ?? 502);
    return json(res, status, { error: err.message });
  }
}
import { answer, json } from './http.js';

/** Like answer(), but an error's own HTTP status (4xx/5xx) is kept; anything else stays 400. */
async function rewindAnswer(res, promise) {
  try {
    return json(res, 200, (await promise) ?? {});
  } catch (err) {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 400;
    return json(res, status, { error: err.message });
  }
}
import { claudeOnly, withProject, withSession } from './project.js';

/** Like rewindAnswer(), for the undo/redo of a code rewind (src/redo.js): its own status, else 500. */
async function redoAnswer(res, promise) {
  try {
    return json(res, 200, await promise);
  } catch (err) {
    const status = err instanceof RedoError ? err.status : (Number.isInteger(err.status) ? err.status : 500);
    return json(res, status, { error: err.message });
  }
}

/**
 * What the conversation half of a redo bundle needs, read BEFORE the rewind: Claude Code keeps its transcript (only
 * the resume position moves), OpenCode's commit deletes the messages, so its session JSON is exported first.
 * null = nothing to come back to (no conversation yet) or the export failed: the rewind still runs, just without a
 * conversation redo.
 */
async function conversationRedo({ hub, opencode, project, session }) {
  const engine = hub.engineOf(project.id);
  const sessionId = hub.sessionIdFor(project.id);
  if (!sessionId) return null;
  if (engine === 'claude') return { engine, sessionId, leaf: session?.chainLeaf ?? null };
  if (!opencode) return null;
  const title = hub.statusFor(project.id)?.title ?? null;
  try {
    const data = await exportOpenCodeSession({ opencode, projectPath: project.path, sessionId, sanitize: false });
    return { engine, sessionId, data, title };
  } catch (err) {
    console.error(`Percakapan ${sessionId} tidak bisa diekspor sebelum rewind (${project.name}): ${err.message}`);
    return null;
  }
}

const ok = (res) => json(res, 200, { ok: true });

/**
 * A prompt that arrives while the global turn limit is full joins 📋 Antrian instead of being refused: the queue's
 * own dispatch waits for the same limit, so it runs as soon as a slot frees. A paused queue is never filled
 * silently (the user would see nothing happen), and a full queue keeps the old refusal.
 * The prompt's chat bubble is made here, once (`queued`, its position): the queue reuses it when the turn starts.
 * `deferAuto`: Effort/Model Auto is classified at dispatch (src/queue.js), not while the prompt waits.
 */
function queueAtCapacity(hub, taskQueue, project, text, attachments, effort, gate, { deferAuto = false, metrics = null } = {}) {
  if (taskQueue.view(project.id).paused) {
    metrics?.capacityRefused?.();
    return { status: 429, body: { ...gate.body, error: `${gate.body.error} Antrian project ini sedang dijeda — lanjutkan dulu, lalu kirim lagi.` } };
  }
  try {
    // A queued item is capped at the queue's own text limit (20k); the direct path allows 50k. Truncating here keeps
    // a prompt that merely waits for a slot from failing with a queue validation error.
    const queueText = text.slice(0, QUEUE_LIMITS.text);
    const item = taskQueue.add(project.id, queueText, effort, attachments, deferAuto ? { autoDeferred: true } : {});
    metrics?.capacityQueued?.();
    const chatId = hub.chat(project.id, {
      kind: 'user',
      text: queueText,
      source: 'web',
      attachments: attachments.length ? attachmentChips(attachments) : undefined,
      queued: true,
      queueItem: item.id,
      queuePosition: taskQueue.positionFor(item.id),
    });
    taskQueue.attachChat(project.id, item.id, chatId);
    taskQueue.schedule(project.id);
    return { status: 200, body: { ok: true, queued: true, queueItem: item.id, chatId, queue: taskQueue.view(project.id) } };
  } catch (err) {
    metrics?.capacityRefused?.();
    return { status: 429, body: { ...gate.body, error: `${gate.body.error} ${err.message}` } };
  }
}

export function register(router) {
  router.post('/api/projects/:id/prompt', withSession(async ({ hub, claude, opencode, ledger, taskQueue, metrics }, req, res, { project, session }, body) => {
    // 💰 Hard stop: never start a paid turn while a configured window is at/over its limit. A running turn is not cut.
    const stop = budgetStop(hub, ledger, Date.now(), project.id);
    if (stop && !consumeBudgetOverride(hub)) return json(res, 409, { error: stop.message, code: 'budget' });
    // The provider of the active model was logged out (👤 Akun, routes/account.js): no silent replacement.
    if (hub.statusFor(project.id)?.modelStale) {
      return json(res, 409, { error: 'Model aktif tidak tersedia (provider sudah logout). Pilih model lain atau Default dulu.' });
    }
    const text = String(body.text ?? '').trim();
    let attachments;
    try {
      attachments = readAttachments(body); // type, magic bytes/UTF-8, size, count, name: never trust the browser
    } catch (err) {
      if (err instanceof AttachmentError) return json(res, err.status, { error: err.message });
      throw err;
    }
    if (!text && !attachments.length) return json(res, 400, { error: 'prompt kosong' });
    if (session.rewinding) return json(res, 409, { error: REWINDING_MESSAGE }); // ⏪ OpenCode rewind running
    const promptText = (text || 'Lihat file terlampir.').slice(0, 50000);
    const settings = hub.settingsFor(project.id);
    // Decided BEFORE the classifier runs: a prompt that must wait for a turn slot costs no model call — it joins
    // 📋 Antrian and Effort/Model Auto is classified at dispatch (src/queue.js). A paused/full queue keeps the 429.
    const preGate = checkTurn(hub, project.id, session);
    if (preGate) {
      const result = queueAtCapacity(hub, taskQueue, project, promptText, attachments, null, preGate, { deferAuto: settings.effortAuto || settings.modelAuto, metrics });
      return json(res, result.status, result.body);
    }
    let autoEffort = null;
    let autoModel = null;
    let autoPick = null; // the shared classification, also what a queued item runs with (Model Auto tiers at dispatch)
    // Effort Auto and Model Auto share one classification per prompt: one extra call, whichever is on.
    if (settings.effortAuto || settings.modelAuto) {
      if (session.busy) {
        // A message sent mid-turn joins the running turn; changing the effort/model now would change that turn.
        if (settings.effortAuto) autoEffort = { skipped: 'busy', reason: 'Mengikuti effort turn yang sedang berjalan' };
        if (settings.modelAuto) autoModel = { skipped: 'busy', reason: 'Mengikuti model turn yang sedang berjalan' };
      } else {
        const engine = hub.engineOf(project.id);
        const auto = await classifyEffort({ engine, claude, opencode, classifierModel: classifierModelFor(engine, settings.modelTiers), text, attachments, context: autoContext(hub, project.id) });
        autoPick = auto;
        const patch = {};
        if (settings.effortAuto) {
          autoEffort = auto;
          patch.effort = auto.level;
          patch.effortAuto = true;
        }
        if (settings.modelAuto) {
          const tier = tierFor(auto.level, hub.engineOf(project.id), settings.modelTiers);
          if (tier.model !== settings.model) {
            patch.model = tier.model;
            patch.modelAuto = true;
            autoModel = { tier: tier.key, label: tier.label, model: tier.model, reason: auto.reason ?? '' };
          }
        }
        if (Object.keys(patch).length) {
          hub.updateSettings(project.id, patch);
          session.syncSettings();
        }
      }
    }
    // Authoritative check, with no await between it and prompt(): the slot cannot change under us. When the limit is
    // full the prompt is queued (never lost), and the queue waits for the same slot before it sends.
    const lastGate = checkTurn(hub, project.id, session);
    if (lastGate) {
      const result = queueAtCapacity(hub, taskQueue, project, promptText, attachments, autoPick, lastGate, { metrics });
      return json(res, result.status, result.body);
    }
    session.prompt(promptText, attachments, autoEffort || autoModel ? { ...(autoEffort && { autoEffort }), ...(autoModel && { autoModel }) } : {});
    // After the user's bubble, before the reply: one line saying which model Auto picked and why.
    if (autoModel && !autoModel.skipped) {
      const why = String(autoModel.reason ?? '').trim().slice(0, 80);
      hub.chat(project.id, { kind: 'info', modelAuto: true, text: `🤖 Model Auto: ${autoModel.label} → ${shortModelLabel(autoModel.model)}${why ? ` — ${why}` : ''}` });
    }
    return json(res, 200, { ok: true, autoEffort, autoModel });
  }));
  // ✂ Ringkas konteks: the engine's own /compact as a normal prompt, so Claude Code's compact_boundary/auto-compact
  // status keeps working. Refused while anything runs, waits or asks: nothing is stopped to make room for it.
  router.post('/api/projects/:id/compact', withSession(({ hub, claude, opencode, ledger, metrics }, req, res, { project, session }, body) => {
    const stop = budgetStop(hub, ledger, Date.now(), project.id);
    if (stop && !consumeBudgetOverride(hub)) return json(res, 409, { error: stop.message, code: 'budget' });
    if (body.focus !== undefined && body.focus !== null && typeof body.focus !== 'string') return json(res, 400, { error: 'Fokus ringkasan harus berupa teks.' });
    const focus = String(body.focus ?? '').trim();
    if (focus.length > 300) return json(res, 400, { error: 'Fokus ringkasan maksimal 300 karakter.' });
    if (!session) return json(res, 404, { error: 'Sesi tidak ditemukan' });
    // Nothing to compact yet: no conversation and no process (a fresh project would only open an empty one).
    if (!hub.sessionIdFor(project.id) && !session.child) return json(res, 409, { error: 'Belum ada sesi untuk diringkas. Kirim pesan dulu.' });
    if (session.rewinding) return json(res, 409, { error: REWINDING_MESSAGE });
    if (session.turnActive?.() || session.busy || session.inflight?.size) return json(res, 409, { error: 'Tim sedang bekerja. Tunggu selesai atau hentikan dulu.' });
    if ([...hub.approvals.values()].some(({ approval }) => approval.project === project.id)) {
      return json(res, 409, { error: 'Masih ada permintaan izin yang menunggu jawaban. Jawab dulu, lalu ringkas konteks.' });
    }
    if (session.engine === 'opencode') {
      if (!opencode) return json(res, 409, { error: 'OpenCode tidak ditemukan di laptop ini. Pasang dengan `npm i -g @opencode/cli`, atau set env OPENCODE_BIN.' });
      // Only a command the agent itself advertises (available_commands_update): never a guess sent into a turn.
      const commands = hub.statusFor(project.id)?.commands ?? [];
      if (!commands.some((c) => c?.name === 'compact' || c?.value === 'compact')) {
        return json(res, 409, { error: 'Mesin OpenCode di sesi ini tidak menyediakan perintah /compact.' });
      }
      const gate = checkTurn(hub, project.id, session);
      if (gate) {
        metrics?.capacityRefused?.();
        return json(res, gate.status, gate.body);
      }
      session.prompt('/compact');
      return json(res, 200, { ok: true, engine: 'opencode', command: '/compact', ...(focus ? { ignoredFocus: true } : {}) });
    }
    if (!claude) return json(res, 409, { error: 'Claude Code tidak ditemukan di laptop ini. Pastikan `claude` terpasang, atau set env CLAUDE_BIN.' });
    const gate = checkTurn(hub, project.id, session);
    if (gate) {
      metrics?.capacityRefused?.();
      return json(res, gate.status, gate.body);
    }
    const command = focus ? `/compact ${focus}` : '/compact';
    session.prompt(command); // the CLI's own slash command, through the same queue and status as any prompt
    return json(res, 200, { ok: true, engine: 'claude', command });
  }));
  router.post('/api/projects/:id/shell', withSession((ctx, req, res, { session }, body) => {
    // A shell skips Claude's permission checks: plain-HTTP WiFi is already refused in handler() (read-only).
    const command = String(body.command ?? '').trim();
    if (!command) return json(res, 400, { error: 'Perintah kosong' });
    if (session.rewinding) return json(res, 409, { error: REWINDING_MESSAGE });
    session.shell(command.slice(0, 4000));
    return ok(res);
  }));
  router.post('/api/projects/:id/stop', withSession((ctx, req, res, { session }) => {
    session.stop();
    return ok(res);
  }));
  router.post('/api/projects/:id/reset', withSession((ctx, req, res, { session }) => {
    session.reset();
    return ok(res);
  }));
  // The active engine's conversations: Claude Code's transcripts, or OpenCode's own session list.
  router.post('/api/projects/:id/sessions', withSession(async ({ hub, opencode, ledger }, req, res, { project }) => {
    const engine = hub.engineOf(project.id);
    const sessions = engine === 'opencode' ? await openCodeSessions(opencode, project.path) : listSessions(project.path);
    // What each session actually used (the token ledger is keyed by sessionId): shown next to its date.
    const usage = new Map();
    for (const row of ledger?.query?.({ accountId: 'all', projectId: project.id }) ?? []) {
      if (!row?.sessionId) continue;
      const u = usage.get(row.sessionId) ?? { usd: 0, tokens: 0, known: 0, rows: 0 };
      u.rows += 1;
      u.tokens += positive(row.input) + positive(row.output) + positive(row.cacheRead) + positive(row.cacheWrite);
      if (typeof row.costUsd === 'number') {
        u.usd += row.costUsd;
        u.known += 1;
      }
      usage.set(row.sessionId, u);
    }
    for (const s of sessions) {
      const u = usage.get(s.id);
      if (u) s.usage = { usd: Math.round(u.usd * 100) / 100, tokens: u.tokens, rows: u.rows, known: u.known };
    }
    // 🏷/📦 What the user tagged or archived (persisted per project + session id), plus 📦 auto-archive by age.
    const meta = hub.sessionMetaMap(project.id);
    const autoDays = hub.sessionAutoArchiveDays(project.id);
    const cutoff = autoDays ? Date.now() - autoDays * 86_400_000 : 0;
    for (const s of sessions) {
      const m = meta[s.id] ?? {};
      if (m.tag) s.tag = m.tag;
      if (m.pinned) s.pinned = true;
      const auto = cutoff > 0 && s.updated < cutoff && m.pinned !== true;
      if (auto) s.autoArchived = true;
      if (m.archived === true || auto) s.archived = true;
    }
    return json(res, 200, { sessions, engine, current: hub.sessionIdFor(project.id), autoArchiveDays: autoDays });
  }));
  router.post('/api/projects/:id/resume', withSession(async ({ hub, opencode }, req, res, { project, session }, body) => {
    const sessionId = String(body.sessionId ?? '');
    // Only a conversation of the project's engine (a Claude transcript id means nothing to OpenCode and vice versa).
    const opencodeActive = hub.engineOf(project.id) === 'opencode';
    const known = (opencodeActive ? await openCodeSessions(opencode, project.path, 200) : listSessions(project.path, 200)).some((s) => s.id === sessionId);
    if (!known) return json(res, 404, { error: 'Sesi tidak ditemukan' });
    session.resume(sessionId, opencodeActive ? [] : sessionHistory(project.path, sessionId));
    return ok(res);
  }));
  // 🗑 Hapus: never the open conversation (start a new one first), never one running in a terminal.
  router.post('/api/projects/:id/session-delete', withSession(({ hub, opencode, dataDir }, req, res, { project }, body) => admin(res, async () => {
    const sessionId = String(body.sessionId ?? '');
    const st = hub.runtime.get(project.id)?.status ?? {};
    if (sessionId === hub.sessionIdFor(project.id)) throw new SessionAdminError(409, 'Ini percakapan yang sedang dibuka. Mulai sesi baru dulu, lalu hapus.');
    if (st.cliBusy && st.cliSession === sessionId) throw new SessionAdminError(409, 'Sesi ini sedang berjalan di terminal.');
    const result = await deleteSession({ engine: hub.engineOf(project.id), projectPath: project.path, sessionId, dataDir, opencode });
    console.log(`Sesi ${sessionId.slice(0, 12)} dihapus (${project.name})${result.trashed ? ` → ${result.trashed}` : ''}`);
    return { ok: true, ...result };
  })));
  // ↩ Sesi terhapus (Claude Code): what 🗑 moved to data/trash, with its title, and putting it back.
  router.post('/api/projects/:id/session-trash', withSession(({ hub, dataDir }, req, res, { project }) => admin(res, async () => {
    if (hub.engineOf(project.id) !== 'claude') return { sessions: [] };
    return { sessions: listTrashedSessions({ projectPath: project.path, dataDir }), retentionDays: TRASH_RETENTION_DAYS };
  })));
  router.post('/api/projects/:id/session-restore', withSession(({ hub, dataDir }, req, res, { project }, body) => admin(res, async () => {
    if (hub.engineOf(project.id) !== 'claude') throw new SessionAdminError(409, 'Pemulihan sesi hanya untuk Claude Code.');
    const result = restoreTrashedSession({ projectPath: project.path, dataDir, sessionId: String(body.sessionId ?? '') });
    console.log(`Sesi ${result.sessionId.slice(0, 12)} dipulihkan dari trash (${project.name})`);
    return { ok: true, ...result };
  })));
  // ⑂ Cabangkan: continue a copy; the original stays as it was. Claude Code: --fork-session on the next start.
  router.post('/api/projects/:id/session-fork', withSession(({ hub, opencode }, req, res, { project, session }, body) => admin(res, async () => {
    const sessionId = String(body.sessionId ?? '');
    if (!validSessionId(hub.engineOf(project.id), sessionId)) throw new SessionAdminError(400, 'Id sesi tidak valid.');
    if (session.turnActive()) throw new SessionAdminError(409, 'Tim sedang bekerja. Tunggu selesai atau hentikan dulu.');
    if (hub.engineOf(project.id) === 'opencode') {
      const forked = await forkOpenCodeSession({ opencode, projectPath: project.path, sessionId });
      session.resume(forked, []);
      hub.chat(project.id, { kind: 'divider', text: `Cabang dari sesi ${sessionId.slice(4, 12)}` });
      return { ok: true, sessionId: forked };
    }
    if (!listSessions(project.path, 200).some((s) => s.id === sessionId)) throw new SessionAdminError(404, 'Sesi tidak ditemukan');
    session.resume(sessionId, sessionHistory(project.path, sessionId));
    session.forkNext = true; // the next start gets --fork-session: a new id, the original transcript untouched
    hub.chat(project.id, { kind: 'divider', text: `Cabang dari sesi ${sessionId.slice(0, 8)}: pesan berikutnya memulai salinannya` });
    return { ok: true, sessionId };
  })));
  // ✎ Rename a listed session: OpenCode's own title, or a custom-title entry for Claude Code (the open one
  // keeps its title in the session bar, like /rename in the CLI).
  router.post('/api/projects/:id/session-rename', withSession(({ hub, opencode }, req, res, { project }, body) => admin(res, async () => {
    const sessionId = String(body.sessionId ?? '');
    if (hub.engineOf(project.id) === 'opencode') {
      return { ok: true, title: await renameOpenCodeSession({ opencode, projectPath: project.path, sessionId, title: body.title }) };
    }
    const st = hub.runtime.get(project.id)?.status ?? {};
    if (sessionId === hub.sessionIdFor(project.id)) throw new SessionAdminError(409, 'Ini percakapan yang sedang dibuka: klik judulnya di bar sesi untuk mengganti nama.');
    if (st.cliBusy && st.cliSession === sessionId) throw new SessionAdminError(409, 'Sesi ini sedang berjalan di terminal.');
    return { ok: true, title: renameClaudeSession({ projectPath: project.path, sessionId, title: body.title }) };
  })));
  // 🏷 Tag / 📦 archive a listed session: app-side metadata (state.json), not the transcript itself.
  router.post('/api/projects/:id/session-meta', withSession(({ hub }, req, res, { project }, body) => {
    const sessionId = String(body.sessionId ?? '');
    if (!validSessionId(hub.engineOf(project.id), sessionId)) return json(res, 400, { error: 'Id sesi tidak valid.' });
    const patch = {};
    if (Object.hasOwn(body, 'tag')) patch.tag = String(body.tag ?? '');
    if (Object.hasOwn(body, 'archived')) patch.archived = body.archived === true;
    if (Object.hasOwn(body, 'pinned')) patch.pinned = body.pinned === true;
    if (!Object.keys(patch).length) return json(res, 400, { error: 'Tidak ada yang diubah.' });
    const meta = hub.setSessionMeta(project.id, sessionId, patch);
    return json(res, 200, { ok: true, meta });
  }));
  // 📦 Auto-archive: sessions unused for N days show under 📦 Diarsipkan (0 = off). Per project, app-side.
  router.post('/api/projects/:id/session-auto-archive', withSession(({ hub }, req, res, { project }, body) => {
    try {
      return json(res, 200, { ok: true, days: hub.setSessionAutoArchive(project.id, body.days ?? 0) });
    } catch (err) {
      if (err.status) return json(res, err.status, { error: err.message });
      throw err;
    }
  }));
  // 🏷 Rename (or remove, with an empty `to`) one tag across every session of the project.
  router.post('/api/projects/:id/session-tags', withSession(({ hub }, req, res, { project }, body) => {
    const from = String(body.from ?? '').replace(/\s+/g, ' ').trim();
    const to = String(body.to ?? '').replace(/\s+/g, ' ').trim();
    if (!from || from.length > 40) return json(res, 400, { error: 'Tag yang diubah tidak valid.' });
    if (to.length > 40) return json(res, 400, { error: 'Nama tag baru terlalu panjang.' });
    return json(res, 200, { ok: true, changed: hub.renameSessionTag(project.id, from, to) });
  }));
  // ⬇ OpenCode: the session as OpenCode's own JSON (re-import with `opencode session import`).
  router.post('/api/projects/:id/session-export-json', withSession(({ opencode }, req, res, { project }, body) => admin(res, async () => {
    const sessionId = String(body.sessionId ?? '');
    return { name: `opencode-${project.name.replace(/[^\w.-]+/g, '_')}-${sessionId.slice(4, 16)}.json`, data: await exportOpenCodeSession({ opencode, projectPath: project.path, sessionId, sanitize: body.sanitize === true }) };
  })));
  // ⬆ OpenCode: `opencode session import` a JSON this app (or the CLI) exported. Laptop only and OpenCode-only.
  router.post('/api/projects/:id/session-import-json', withProject(({ hub, opencode }, req, res, { project }, body) => admin(res, async () => {
    if (hub.engineOf(project.id) !== 'opencode') throw new SessionAdminError(409, 'Import JSON hanya untuk sesi OpenCode. Pindah mesin project ke OpenCode dulu.');
    return importOpenCodeSession({ opencode, projectPath: project.path, data: body.data });
  })));
  router.post('/api/projects/:id/continue', withSession(({ hub, ledger, metrics }, req, res, { project, session }, body) => {
    // A turn cut short by a server restart: continue it in the same session, or just drop the notice.
    if (body.dismiss === true) {
      hub.clearInterrupted(project.id);
      return ok(res);
    }
    const stop = budgetStop(hub, ledger, Date.now(), project.id);
    if (stop && !consumeBudgetOverride(hub)) return json(res, 409, { error: stop.message, code: 'budget' });
    const gate = checkTurn(hub, project.id, session);
    if (gate) {
      metrics?.capacityRefused?.();
      return json(res, gate.status, gate.body);
    }
    try {
      return json(res, 200, session.continueInterrupted());
    } catch (err) {
      if (err.status) return json(res, err.status, { error: err.message });
      throw err;
    }
  }));
  router.post('/api/projects/:id/rename', withSession((ctx, req, res, { session }, body) => {
    const title = String(body.title ?? '').trim().slice(0, 200);
    if (!title) return json(res, 400, { error: 'Nama sesi kosong' });
    return answer(res, session.rename(title));
  }));
  // Esc Esc / /rewind. `uuid` = Claude Code's prompt uuid, or OpenCode's message id (msg_…). OpenCode reads its
  // store through `opencode api` (async); its errors carry a status (409 while a turn runs), Claude's stay 400.
  router.post('/api/projects/:id/rewind-points', withSession((ctx, req, res, { session }) => rewindAnswer(res, Promise.resolve(session.rewindPoints()).then((points) => ({ points })))));
  router.post('/api/projects/:id/rewind-preview', withSession((ctx, req, res, { session }, body) => rewindAnswer(res, session.rewindPreview(String(body.uuid ?? '')))));
  // ⏪↩ A rewind overwrites the uncommitted worktree and/or the conversation: snapshot what it throws away
  // (src/redo.js) first, so the response can carry the undo bundle. A folder without git (or a failed snapshot)
  // refuses the code rewind before anything moves; the conversation half is best effort (the rewind still runs).
  router.post('/api/projects/:id/rewind', withSession(async ({ hub, opencode, dataDir }, req, res, { project, session }, body) => {
    const uuid = String(body.uuid ?? '');
    const options = { code: Boolean(body.code), conversation: Boolean(body.conversation) };
    // 💬 Read before the rewind moves the position (Claude) or deletes the messages (OpenCode).
    const conversation = options.conversation ? await conversationRedo({ hub, opencode, project, session }) : null;
    let capture = null;
    if (options.code || conversation) {
      capture = await captureRedo({ projectPath: project.path, dataDir, projectId: project.id, engine: hub.engineOf(project.id), code: options.code, conversation });
      if (!capture.ok) {
        if (options.code) return json(res, 409, { error: `Tidak bisa menyiapkan undo untuk rewind ini (${capture.reason}).` });
        console.error(`Undo percakapan project ${project.id} tidak siap (${capture.reason}): rewind tetap dijalankan.`);
        capture = null;
      }
    }
    let result;
    try {
      result = await session.rewind(uuid, options);
    } catch (err) {
      // Nothing was rewound (or only part): the bundle stays 'captured' and is pruned later, never applied blindly.
      const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 400;
      return json(res, status, { error: err.message });
    }
    if (!capture) return json(res, 200, { ...(result ?? {}) });
    try {
      const sealed = await sealRedo({ dataDir, projectId: project.id, id: capture.id, projectPath: project.path });
      return json(res, 200, { ...(result ?? {}), redo: { id: sealed.id, files: sealed.files, conversation: Boolean(capture.conversation) } });
    } catch (err) {
      // The rewind is done already: report that success, just without a redo entry (the bundle is not listed).
      console.error(`Undo rewind ${capture.id} gagal disegel: ${err.message}`);
      return json(res, 200, { ...(result ?? {}) });
    }
  }));
  // ↩ Undo/redo of a code rewind: the list, a dry run, and the apply. Laptop/Tailscale only (no WiFi read).
  router.post('/api/projects/:id/redo-list', withProject(({ dataDir }, req, res, { project }) => redoAnswer(res, listRedo({ dataDir, projectId: project.id }))));
  router.post('/api/projects/:id/redo-preview', withProject(({ dataDir }, req, res, { project }, body) =>
    redoAnswer(res, previewRedo({ dataDir, projectId: project.id, id: String(body.id ?? ''), projectPath: project.path }))));
  router.post('/api/projects/:id/redo', withSession(({ dataDir }, req, res, { project, session }, body) => {
    if (session?.rewinding) return json(res, 409, { error: REWINDING_MESSAGE }); // file writes in flight
    return redoAnswer(res, applyRedo({ dataDir, projectId: project.id, id: String(body.id ?? ''), projectPath: project.path, overwrite: body.overwrite === true }));
  }));
  // 🔄 Redo the conversation half of a rewind. Claude Code: the transcript was never deleted, so going back to its
  // newest leaf and clearing the greyed-out chat is enough. OpenCode: the rewind deleted the messages, so the JSON
  // exported before it is imported as a NEW session and the conversation continues from that copy.
  // Laptop/Tailscale only (no WiFi read; server.js refuses it there by the read allowlist).
  router.post('/api/projects/:id/redo-conversation', withSession(async ({ hub, opencode, dataDir }, req, res, { project, session }, body) => {
    if (session?.rewinding) return json(res, 409, { error: REWINDING_MESSAGE });
    if (session?.turnActive()) return json(res, 409, { error: 'Tim sedang bekerja. Tunggu selesai atau hentikan dulu.' });
    try {
      const { conversation, data } = await conversationOf({ dataDir, projectId: project.id, id: String(body.id ?? '') });
      // Another conversation was opened since the rewind: this bundle no longer describes where the app is.
      const current = hub.sessionIdFor(project.id);
      if (current && current !== conversation.sessionId) {
        return json(res, 409, { error: 'Percakapan sudah berganti sejak rewind ini, jadi undo ini tidak bisa lagi mengembalikannya.' });
      }
      if (conversation.engine === 'claude') {
        // The transcript still has everything: only the position moved back, so the newest leaf is the way back.
        if (session) {
          session.resumeAt = null;
          session.chainLeaf = null;
          session.closeChild();
        }
        // A rewind to before the very first prompt forgot the session id (the transcript is still there).
        if (conversation.sessionId && !hub.sessionIdFor(project.id)) hub.setSessionId(project.id, conversation.sessionId);
        hub.unmarkRewound(project.id);
        hub.chat(project.id, { kind: 'info', text: '🔄 Percakapan dikembalikan ke posisi terakhir' });
        return json(res, 200, { ok: true, engine: 'claude', sessionId: hub.sessionIdFor(project.id) });
      }
      if (!opencode) return json(res, 502, { error: 'OpenCode tidak ditemukan di laptop ini. Pasang dengan `npm i -g @opencode/cli`, atau set env OPENCODE_BIN.' });
      // Nothing changes before the import succeeds: a failure is a 502 and the current session stays.
      const imported = await importOpenCodeSession({ opencode, projectPath: project.path, data });
      if (imported.sessionId) {
        hub.setSessionId(project.id, imported.sessionId);
        session?.closeChild(); // the next prompt starts a fresh process on the imported copy
      }
      hub.unmarkRewound(project.id);
      hub.chat(project.id, { kind: 'divider', text: '🔄 Percakapan dipulihkan sebagai salinan (sesi baru)' });
      return json(res, 200, { ok: true, engine: 'opencode', sessionId: hub.sessionIdFor(project.id) });
    } catch (err) {
      const status = err instanceof RedoError ? err.status : err instanceof OpenCodeAdminError ? 502 : (Number.isInteger(err.status) ? err.status : 502);
      return json(res, status, { error: err.message });
    }
  }));

  // 🔎 Cari percakapan / ⬇ Export .md: read-only, bounded reads of this project's transcripts (src/conversation.js).
  router.post('/api/projects/:id/search', withProject(async ({ hub, opencode }, req, res, { project }, body) => {
    try {
      // all: every listed project, the active one first.
      const scope = body.all === true ? [project, ...[...hub.projects.values()].filter((p) => p.id !== project.id && p.id !== DEMO_ID && p.path)] : [project];
      const limit = Number(body.limit) || SEARCH_LIMITS.defaultResults;
      const claude = searchSessions(scope, body.q, { limit });
      const opencodeResults = await searchOpenCodeSessions(scope, body.q, { opencode, limit });
      const max = Math.min(Math.max(1, limit), SEARCH_LIMITS.maxResults);
      const results = [...claude.results, ...opencodeResults.results].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, max);
      return json(res, 200, {
        query: claude.query,
        results,
        truncated: claude.truncated || opencodeResults.truncated || claude.results.length + opencodeResults.results.length > max,
        sessions: claude.sessions + opencodeResults.sessions,
      });
    } catch (err) {
      if (err instanceof ConversationError) return json(res, err.status, { error: err.message });
      throw err;
    }
  }));
  router.post('/api/projects/:id/export-session', withProject(claudeOnly((ctx, req, res, { project }, body) =>
    conversation(res, () => json(res, 200, exportSession(project.path, body.sessionId, { tools: body.tools === true, projectName: project.name }))), 'Export sesi')));
  // ⬇ Export some sessions at once: one .zip (Claude .md files, OpenCode .json files). Reads only.
  router.post('/api/projects/:id/sessions-export', withSession(async ({ hub, opencode }, req, res, { project }, body) => {
    const engine = hub.engineOf(project.id);
    const ids = [...new Set((Array.isArray(body.sessionIds) ? body.sessionIds : []).map((x) => String(x)))].slice(0, 25);
    if (!ids.length || ids.some((id) => !validSessionId(engine, id))) return json(res, 400, { error: 'Pilih sesi yang valid.' });
    try {
      const existing = engine === 'opencode' ? await openCodeSessions(opencode, project.path, 200) : listSessions(project.path, 200);
      const byId = new Map(existing.map((s) => [s.id, s]));
      const chosen = ids.filter((id) => byId.has(id));
      if (!chosen.length) return json(res, 404, { error: 'Sesi tidak ditemukan.' });
      const files = [];
      for (const id of chosen) {
        const name = `${safeFile(byId.get(id)?.title)}-${id.slice(0, 8)}`;
        if (engine === 'claude') {
          const out = exportSession(project.path, id, { tools: body.tools === true, projectName: project.name });
          files.push({ name: `${name}.md`, buf: Buffer.from(out.markdown) });
        } else {
          const data = await exportOpenCodeSession({ opencode, projectPath: project.path, sessionId: id });
          files.push({ name: `${name}.json`, buf: Buffer.from(JSON.stringify(data, null, 2)) });
        }
      }
      const zipName = `sesi-${safeFile(project.name)}-${new Date().toLocaleDateString('sv-SE')}.zip`;
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zipName}"`, 'Cache-Control': 'no-store' });
      const zip = new ZipWriter(res, { zip64: files.reduce((sum, f) => sum + f.buf.length, 0) > 0xffffffff });
      for (const f of files) await zip.add(f.name, f.buf);
      await zip.finish();
      res.end();
      return undefined;
    } catch (err) {
      if (res.headersSent) return res.destroy();
      const status = err instanceof ConversationError || err instanceof SessionAdminError ? err.status : (err.status ?? 502);
      return json(res, status, { error: err.message });
    }
  }));
}

/** A file name that is safe on every platform (Windows included), never empty. */
const safeFile = (s) => String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'sesi';
/** A non-negative number from an untrusted ledger row. */
const positive = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/** A ConversationError (bad query, unknown session, too large) goes back with its own status. */
function conversation(res, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConversationError) return json(res, err.status, { error: err.message });
    throw err;
  }
}
