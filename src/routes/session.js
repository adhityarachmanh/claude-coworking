// ---------- a project's Claude Code session: prompts, shell, stop/reset, history, rewind ----------
// Reads allowed over WiFi: sessions, rewind-points. Everything else acts (refused there by the gate in server.js);
// `search` / `export-session` read, but expose the whole history: laptop and Tailscale only (src/remote.js).
// `redo-conversation` acts too (it moves the conversation / imports a session): refused over WiFi by the same gate.
import { AttachmentError, readAttachments } from '../attachments.js';
import { budgetStop } from '../budget.js';
import { ConversationError, exportSession, SEARCH_LIMITS, searchSessions } from '../conversation.js';
import { searchOpenCodeSessions } from '../opencode-search.js';
import { REWINDING_MESSAGE } from '../acp-session.js';
import { autoContext, classifyEffort } from '../effort-classifier.js';
import { DEMO_ID } from '../hub.js';
import { shortModelLabel, tierFor } from '../model-auto.js';
import { listSessions, sessionHistory } from '../transcripts.js';
import { openCodeSessions } from '../opencode-bin.js';
import { importOpenCodeSession, OpenCodeAdminError } from '../opencode-admin.js';
import { deleteSession, exportOpenCodeSession, forkOpenCodeSession, renameOpenCodeSession, SessionAdminError, validSessionId } from '../session-admin.js';
import { applyRedo, captureRedo, conversationOf, listRedo, previewRedo, RedoError, sealRedo } from '../redo.js';

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

export function register(router) {
  router.post('/api/projects/:id/prompt', withSession(async ({ hub, claude, opencode, ledger }, req, res, { project, session }, body) => {
    // 💰 Hard stop: never start a paid turn while a configured window is at/over its limit. A running turn is not cut.
    const stop = budgetStop(hub, ledger);
    if (stop) return json(res, 409, { error: stop.message, code: 'budget' });
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
    const settings = hub.settingsFor(project.id);
    let autoEffort = null;
    let autoModel = null;
    // Effort Auto and Model Auto share one classification per prompt: one extra call, whichever is on.
    if (settings.effortAuto || settings.modelAuto) {
      if (session.busy) {
        // A message sent mid-turn joins the running turn; changing the effort/model now would change that turn.
        if (settings.effortAuto) autoEffort = { skipped: 'busy', reason: 'Mengikuti effort turn yang sedang berjalan' };
        if (settings.modelAuto) autoModel = { skipped: 'busy', reason: 'Mengikuti model turn yang sedang berjalan' };
      } else {
        const auto = await classifyEffort({ engine: hub.engineOf(project.id), claude, opencode, currentModel: settings.model, text, attachments, context: autoContext(hub, project.id) });
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
    session.prompt((text || 'Lihat file terlampir.').slice(0, 50000), attachments, autoEffort || autoModel ? { ...(autoEffort && { autoEffort }), ...(autoModel && { autoModel }) } : {});
    // After the user's bubble, before the reply: one line saying which model Auto picked and why.
    if (autoModel && !autoModel.skipped) {
      const why = String(autoModel.reason ?? '').trim().slice(0, 80);
      hub.chat(project.id, { kind: 'info', modelAuto: true, text: `🤖 Model Auto: ${autoModel.label} → ${shortModelLabel(autoModel.model)}${why ? ` — ${why}` : ''}` });
    }
    return json(res, 200, { ok: true, autoEffort, autoModel });
  }));
  // ✂ Ringkas konteks: the engine's own /compact as a normal prompt, so Claude Code's compact_boundary/auto-compact
  // status keeps working. Refused while anything runs, waits or asks: nothing is stopped to make room for it.
  router.post('/api/projects/:id/compact', withSession(({ hub, claude, opencode, ledger }, req, res, { project, session }, body) => {
    const stop = budgetStop(hub, ledger);
    if (stop) return json(res, 409, { error: stop.message, code: 'budget' });
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
      session.prompt('/compact');
      return json(res, 200, { ok: true, engine: 'opencode', command: '/compact', ...(focus ? { ignoredFocus: true } : {}) });
    }
    if (!claude) return json(res, 409, { error: 'Claude Code tidak ditemukan di laptop ini. Pastikan `claude` terpasang, atau set env CLAUDE_BIN.' });
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
  router.post('/api/projects/:id/sessions', withSession(async ({ hub, opencode }, req, res, { project }) => {
    const engine = hub.engineOf(project.id);
    const sessions = engine === 'opencode' ? await openCodeSessions(opencode, project.path) : listSessions(project.path);
    return json(res, 200, { sessions, engine, current: hub.sessionIdFor(project.id) });
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
  // ✎ OpenCode: rename any listed session (Claude Code renames the open one with /rename).
  router.post('/api/projects/:id/session-rename', withSession(({ hub, opencode }, req, res, { project }, body) => admin(res, async () => {
    if (hub.engineOf(project.id) !== 'opencode') throw new SessionAdminError(409, 'Untuk Claude Code, buka sesinya lalu klik judulnya (/rename).');
    return { ok: true, title: await renameOpenCodeSession({ opencode, projectPath: project.path, sessionId: String(body.sessionId ?? ''), title: body.title }) };
  })));
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
  router.post('/api/projects/:id/continue', withSession(({ hub, ledger }, req, res, { project, session }, body) => {
    // A turn cut short by a server restart: continue it in the same session, or just drop the notice.
    if (body.dismiss === true) {
      hub.clearInterrupted(project.id);
      return ok(res);
    }
    const stop = budgetStop(hub, ledger);
    if (stop) return json(res, 409, { error: stop.message, code: 'budget' });
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
}

/** A ConversationError (bad query, unknown session, too large) goes back with its own status. */
function conversation(res, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConversationError) return json(res, err.status, { error: err.message });
    throw err;
  }
}
