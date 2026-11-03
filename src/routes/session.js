// ---------- a project's Claude Code session: prompts, shell, stop/reset, history, rewind ----------
// Reads allowed over WiFi: sessions, rewind-points. Everything else acts (refused there by the gate in server.js);
// `search` / `export-session` read, but expose the whole history: laptop and Tailscale only (src/remote.js).
import { AttachmentError, readAttachments } from '../attachments.js';
import { ConversationError, exportSession, searchSessions } from '../conversation.js';
import { DEMO_ID } from '../hub.js';
import { listSessions, sessionHistory } from '../transcripts.js';
import { openCodeSessions } from '../opencode-bin.js';
import { deleteSession, exportOpenCodeSession, forkOpenCodeSession, renameOpenCodeSession, SessionAdminError, validSessionId } from '../session-admin.js';

/** Runs a 🕘 Riwayat sesi action; SessionAdminError / OpenCode errors become JSON with their status. */
async function admin(res, fn) {
  try {
    return json(res, 200, await fn());
  } catch (err) {
    return json(res, err instanceof SessionAdminError ? err.status : (err.status ?? 502), { error: err.message });
  }
}
import { answer, json } from './http.js';
import { withSession } from './project.js';

const ok = (res) => json(res, 200, { ok: true });

export function register(router) {
  router.post('/api/projects/:id/prompt', withSession((ctx, req, res, { session }, body) => {
    const text = String(body.text ?? '').trim();
    let attachments;
    try {
      attachments = readAttachments(body); // type, magic bytes/UTF-8, size, count, name: never trust the browser
    } catch (err) {
      if (err instanceof AttachmentError) return json(res, err.status, { error: err.message });
      throw err;
    }
    if (!text && !attachments.length) return json(res, 400, { error: 'prompt kosong' });
    session.prompt((text || 'Lihat file terlampir.').slice(0, 50000), attachments);
    return ok(res);
  }));
  router.post('/api/projects/:id/shell', withSession((ctx, req, res, { session }, body) => {
    // A shell skips Claude's permission checks: plain-HTTP WiFi is already refused in handler() (read-only).
    const command = String(body.command ?? '').trim();
    if (!command) return json(res, 400, { error: 'Perintah kosong' });
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
    const sessions = hub.engine === 'opencode' ? await openCodeSessions(opencode, project.path) : listSessions(project.path);
    return json(res, 200, { sessions, engine: hub.engine, current: hub.sessionIdFor(project.id) });
  }));
  router.post('/api/projects/:id/resume', withSession(async ({ hub, opencode }, req, res, { project, session }, body) => {
    const sessionId = String(body.sessionId ?? '');
    // Only a conversation of the active engine (a Claude transcript id means nothing to OpenCode and vice versa).
    const opencodeActive = hub.engine === 'opencode';
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
    const result = await deleteSession({ engine: hub.engine, projectPath: project.path, sessionId, dataDir, opencode });
    console.log(`Sesi ${sessionId.slice(0, 12)} dihapus (${project.name})${result.trashed ? ` → ${result.trashed}` : ''}`);
    return { ok: true, ...result };
  })));
  // ⑂ Cabangkan: continue a copy; the original stays as it was. Claude Code: --fork-session on the next start.
  router.post('/api/projects/:id/session-fork', withSession(({ hub, opencode }, req, res, { project, session }, body) => admin(res, async () => {
    const sessionId = String(body.sessionId ?? '');
    if (!validSessionId(hub.engine, sessionId)) throw new SessionAdminError(400, 'Id sesi tidak valid.');
    if (session.turnActive()) throw new SessionAdminError(409, 'Tim sedang bekerja. Tunggu selesai atau hentikan dulu.');
    if (hub.engine === 'opencode') {
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
    if (hub.engine !== 'opencode') throw new SessionAdminError(409, 'Untuk Claude Code, buka sesinya lalu klik judulnya (/rename).');
    return { ok: true, title: await renameOpenCodeSession({ opencode, projectPath: project.path, sessionId: String(body.sessionId ?? ''), title: body.title }) };
  })));
  // ⬇ OpenCode: the session as OpenCode's own JSON (re-import with `opencode session import`).
  router.post('/api/projects/:id/session-export-json', withSession(({ opencode }, req, res, { project }, body) => admin(res, async () => {
    const sessionId = String(body.sessionId ?? '');
    return { name: `opencode-${project.name.replace(/[^\w.-]+/g, '_')}-${sessionId.slice(4, 16)}.json`, data: await exportOpenCodeSession({ opencode, projectPath: project.path, sessionId, sanitize: body.sanitize === true }) };
  })));
  router.post('/api/projects/:id/continue', withSession(({ hub }, req, res, { project, session }, body) => {
    // A turn cut short by a server restart: continue it in the same session, or just drop the notice.
    if (body.dismiss === true) {
      hub.clearInterrupted(project.id);
      return ok(res);
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
  // Esc Esc / /rewind
  router.post('/api/projects/:id/rewind-points', withSession((ctx, req, res, { session }) => json(res, 200, { points: session.rewindPoints() })));
  router.post('/api/projects/:id/rewind-preview', withSession((ctx, req, res, { session }, body) => answer(res, session.rewindPreview(String(body.uuid ?? '')))));
  router.post('/api/projects/:id/rewind', withSession((ctx, req, res, { session }, body) => {
    const options = { code: Boolean(body.code), conversation: Boolean(body.conversation) };
    return answer(res, session.rewind(String(body.uuid ?? ''), options));
  }));
  // 🔎 Cari percakapan / ⬇ Export .md: read-only, bounded reads of this project's transcripts (src/conversation.js).
  router.post('/api/projects/:id/search', withSession(({ hub }, req, res, { project }, body) =>
    conversation(res, () => {
      // all: every listed project, the active one first.
      const scope = body.all === true ? [project, ...[...hub.projects.values()].filter((p) => p.id !== project.id && p.id !== DEMO_ID && p.path)] : [project];
      return json(res, 200, searchSessions(scope, body.q, { limit: body.limit }));
    }),
  ));
  router.post('/api/projects/:id/export-session', withSession((ctx, req, res, { project }, body) =>
    conversation(res, () => json(res, 200, exportSession(project.path, body.sessionId, { tools: body.tools === true, projectName: project.name }))),
  ));
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
