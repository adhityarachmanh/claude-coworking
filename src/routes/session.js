// ---------- a project's Claude Code session: prompts, shell, stop/reset, history, rewind ----------
// Reads allowed over WiFi: sessions, rewind-points. Everything else acts (refused there by the gate in server.js);
// `search` / `export-session` read, but expose the whole history: laptop and Tailscale only (src/remote.js).
import { AttachmentError, readAttachments } from '../attachments.js';
import { ConversationError, exportSession, searchSessions } from '../conversation.js';
import { DEMO_ID } from '../hub.js';
import { listSessions, sessionHistory } from '../transcripts.js';
import { openCodeSessions } from '../opencode-bin.js';
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
  })),
  router.post('/api/projects/:id/resume', withSession(async ({ hub, opencode }, req, res, { project, session }, body) => {
    const sessionId = String(body.sessionId ?? '');
    // Only a conversation of the active engine (a Claude transcript id means nothing to OpenCode and vice versa).
    const opencodeActive = hub.engine === 'opencode';
    const known = (opencodeActive ? await openCodeSessions(opencode, project.path, 200) : listSessions(project.path, 200)).some((s) => s.id === sessionId);
    if (!known) return json(res, 404, { error: 'Sesi tidak ditemukan' });
    session.resume(sessionId, opencodeActive ? [] : sessionHistory(project.path, sessionId));
    return ok(res);
  }));
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
