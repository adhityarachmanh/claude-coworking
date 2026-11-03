// 🕘 Riwayat sesi: delete, fork, rename, export of a past conversation — both engines, no terminal needed.
// Claude Code: transcripts in ~/.claude/projects/<project>/<id>.jsonl; delete moves them to data/trash (never rm).
// OpenCode: its own store through `opencode api` (session.remove / session.fork / session.update, and for ⏪ Rewind
// session.message.list / session.revert.stage / commit / clear) and `opencode session export`.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { openCodeApi } from './opencode-auth.js';
import { clearSessionCache } from './opencode-bin.js';
import { execFileTree } from './proc.js';
import { transcriptDir } from './transcripts.js';

const CLAUDE_ID = /^[0-9a-f-]{36}$/i;
const OPENCODE_ID = /^ses_[\w-]{1,100}$/;

export class SessionAdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const validSessionId = (engine, id) => (engine === 'opencode' ? OPENCODE_ID : CLAUDE_ID).test(String(id ?? ''));

/**
 * Deletes a past session. Claude Code: its transcript (and subagent folder) moves to <data>/trash/<project>/,
 * restorable by moving it back. OpenCode: removed from its store (session.remove), like `opencode session delete`.
 */
export async function deleteSession({ engine, projectPath, sessionId, dataDir, opencode }) {
  if (!validSessionId(engine, sessionId)) throw new SessionAdminError(400, 'Id sesi tidak valid.');
  if (engine === 'opencode') {
    await openCodeApi(opencode, 'session.remove', { params: { sessionID: sessionId } });
    clearSessionCache(projectPath);
    return { trashed: null };
  }
  const dir = transcriptDir(projectPath);
  const file = path.join(dir, `${sessionId}.jsonl`);
  if (!existsSync(file)) throw new SessionAdminError(404, 'Sesi tidak ditemukan.');
  const trash = path.join(dataDir, 'trash', path.basename(dir));
  mkdirSync(trash, { recursive: true });
  const stamp = Date.now();
  renameSync(file, path.join(trash, `${sessionId}-${stamp}.jsonl`));
  const sub = path.join(dir, sessionId); // subagent transcripts of that session
  if (existsSync(sub)) renameSync(sub, path.join(trash, `${sessionId}-${stamp}`));
  return { trashed: trash };
}

/** OpenCode: a copy of the session (session.fork) to continue on its own; returns the new id. */
export async function forkOpenCodeSession({ opencode, projectPath, sessionId }) {
  if (!validSessionId('opencode', sessionId)) throw new SessionAdminError(400, 'Id sesi tidak valid.');
  const info = await openCodeApi(opencode, 'session.fork', { params: { sessionID: sessionId }, body: {} });
  const id = info?.id ?? info?.sessionID;
  if (!validSessionId('opencode', id)) throw new SessionAdminError(502, 'OpenCode tidak mengembalikan sesi baru.');
  clearSessionCache(projectPath);
  return id;
}

/** OpenCode: the session's title (session.update), for any listed session. */
export async function renameOpenCodeSession({ opencode, projectPath, sessionId, title }) {
  if (!validSessionId('opencode', sessionId)) throw new SessionAdminError(400, 'Id sesi tidak valid.');
  const clean = String(title ?? '').trim().slice(0, 200);
  if (!clean) throw new SessionAdminError(400, 'Nama sesi kosong.');
  await openCodeApi(opencode, 'session.update', { params: { sessionID: sessionId }, body: { title: clean } });
  clearSessionCache(projectPath);
  return clean;
}

// ---------- ⏪ Rewind (OpenCode 2.x: session.message.list + session.revert.stage / commit / clear) ----------
// stage { messageID, files } hides that message and everything after it and, unless files is false, puts every file
// changed by the later assistant turns back to its snapshot from before them; commit deletes the hidden messages
// (OpenCode also commits a staged revert itself at the next prompt); clear undoes a staged revert (files too).
// There is no "files only" revert. Message list paging (2.2.5): cursor = base64url JSON { id, order, direction }.

const MESSAGE_ID = /^msg_[\w-]{1,100}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,2000}={0,2}$/; // base64url (OpenCode 2.2.5 writes it without padding)
const POINTS = 80; // as many prompts as Claude's rewind list shows
const PAGE = 200; // OpenCode's maximum page size
const MAX_PAGES = 50; // a runaway cursor stops here (the deadline usually does first)
const DEADLINE_MS = 60_000; // one preview / one rewind: all its `opencode api` runs together
const CLEANUP_MS = 15_000; // kept back from the stage for its commit / clear

export const validMessageId = (id) => MESSAGE_ID.test(String(id ?? ''));

/** A time budget shared by the `opencode api` runs of one preview or one rewind. */
export function rewindDeadline(ms = DEADLINE_MS, now = Date.now) {
  const end = now() + ms;
  return { left: () => end - now() };
}

/** The timeout one run may use: what is left of the budget minus `reserve`; 504 when that is under a second. */
function share(budget, reserve = 0) {
  const ms = (budget ?? rewindDeadline()).left() - reserve;
  if (ms < 1000) throw new SessionAdminError(504, 'OpenCode terlalu lama menjawab. Coba lagi sebentar lagi.');
  return ms;
}

const hasTag = (err, re) => re.test(String(err?.tag ?? '')) || re.test(String(err?.message ?? ''));
const isNotFound = (err) => err?.httpStatus === 404 || hasTag(err, /NotFound|\b404\b/i);
/** OpenCode's "not found", told apart: the whole session, or only the message. */
const notFound = (err) =>
  hasTag(err, /SessionNotFound|Session not found/i) ? new SessionAdminError(404, 'Sesi OpenCode ini tidak ditemukan lagi (mungkin dihapus di OpenCode).') : new SessionAdminError(404, 'Pesan itu tidak ada lagi di sesi OpenCode.');
/** A failed message list as an HTTP error the route keeps. */
const listError = (err) => (err instanceof SessionAdminError ? err : isNotFound(err) ? notFound(err) : new SessionAdminError(err?.timedOut ? 504 : 502, `Daftar pesan OpenCode tidak terbaca: ${err?.message}`));

/** The session's prompts (user messages), newest first: `[{ uuid: msg_…, text (full, may be empty), ts }]`. */
export async function openCodeRewindPoints({ opencode, sessionId, budget }) {
  if (!validSessionId('opencode', sessionId)) throw new SessionAdminError(400, 'Id sesi tidak valid.');
  let list;
  try {
    list = await openCodeApi(opencode, 'session.message.list', { params: { sessionID: sessionId, type: 'user', order: 'desc', limit: POINTS }, timeout: share(budget) });
  } catch (err) {
    throw listError(err);
  }
  return (Array.isArray(list) ? list : [])
    .filter((m) => m?.type === 'user' && validMessageId(m.id))
    .map((m) => ({ uuid: m.id, text: String(m.text ?? '').slice(0, 60_000), ts: Number(m.time?.created) || null }));
}

/**
 * Dry run of a rewind to just before `messageId`: the files OpenCode would put back (those recorded in the snapshots
 * of the assistant messages after it, as SessionRevert.plan does). Scans newest first as far back as the rewind
 * points reach (POINTS prompts), within the budget. `found` false = not reached (out of time, or older than the
 * points): the list is then unknown, the rewind itself still works.
 */
export async function openCodeRevertPlan({ opencode, sessionId, messageId, budget = rewindDeadline() }) {
  if (!validSessionId('opencode', sessionId)) throw new SessionAdminError(400, 'Id sesi tidak valid.');
  if (!validMessageId(messageId)) throw new SessionAdminError(400, 'Pesan tidak dikenal.');
  const files = new Set();
  const result = (found) => ({ found, files: [...files].slice(0, 500) });
  let cursor = null;
  let prompts = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = { sessionID: sessionId, limit: PAGE, ...(cursor ? { cursor } : { order: 'desc' }) }; // desc: cursor.next = older
    let res;
    try {
      res = await openCodeApi(opencode, 'session.message.list', { params, full: true, timeout: share(budget) });
    } catch (err) {
      if (page === 0) throw listError(err);
      return result(false); // out of time further back: unknown, not an error
    }
    const list = Array.isArray(res?.data) ? res.data : [];
    for (const m of list) {
      if (m?.id === messageId) {
        if (m.type !== 'user') throw new SessionAdminError(400, 'Pesan itu bukan pesanmu.');
        return result(true);
      }
      if (m?.type === 'user' && ++prompts >= POINTS) return result(false); // past the oldest rewind point
      if (m?.type === 'assistant' && m.snapshot?.start) for (const f of Array.isArray(m.snapshot.files) ? m.snapshot.files : []) if (typeof f === 'string' && f) files.add(f.slice(0, 1000));
    }
    cursor = res?.cursor?.next;
    if (list.length < PAGE || !CURSOR.test(String(cursor ?? ''))) break;
  }
  return result(false);
}

/** Best effort: undoes a staged revert (session.revert.clear), files included. true when OpenCode confirmed it. */
async function clearRevert(opencode, sessionId, budget) {
  try {
    await openCodeApi(opencode, 'session.revert.clear', { params: { sessionID: sessionId }, timeout: Math.max(10_000, budget.left()) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewinds the session to just before `messageId` (that prompt and everything after it are deleted), with its file
 * changes when `files` is true. Returns the files OpenCode put back. All or nothing: a stage that failed for another
 * reason than busy / not found (a timeout may still have staged it), or a commit that failed twice, is cleared again
 * (best effort) and reported as an error.
 */
export async function revertOpenCodeSession({ opencode, projectPath, sessionId, messageId, files, budget = rewindDeadline() }) {
  if (!validSessionId('opencode', sessionId)) throw new SessionAdminError(400, 'Id sesi tidak valid.');
  if (!validMessageId(messageId)) throw new SessionAdminError(400, 'Pesan tidak dikenal.');
  const params = { sessionID: sessionId };
  const undone = (cleared) => (cleared ? 'Tidak ada yang diubah: revert dibatalkan lagi.' : 'Pembatalannya juga gagal: OpenCode bisa menerapkan revert yang tertunda ini saat prompt berikutnya. Cek sesinya di OpenCode.');
  let staged;
  try {
    staged = await openCodeApi(opencode, 'session.revert.stage', { params, body: { messageID: messageId, files: Boolean(files) }, timeout: share(budget, CLEANUP_MS) });
  } catch (err) {
    if (err instanceof SessionAdminError) throw err; // no time left to even try
    // `opencode api` reports the HTTP status on stderr ("HTTP 404 Not Found"), the error's _tag on stdout.
    if (err.httpStatus === 409 || hasTag(err, /Busy|\b409\b/i)) throw new SessionAdminError(409, 'OpenCode masih bekerja di sesi ini. Hentikan dulu, lalu coba lagi.');
    if (isNotFound(err)) throw notFound(err);
    const cleared = await clearRevert(opencode, sessionId, budget);
    clearSessionCache(projectPath);
    throw new SessionAdminError(err.timedOut ? 504 : 502, `Rewind OpenCode gagal${err.timedOut ? ' (OpenCode tidak menjawab tepat waktu)' : ''}: ${err.message}. ${undone(cleared)}`);
  }
  let commitError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await openCodeApi(opencode, 'session.revert.commit', { params, timeout: Math.min(share(budget), 30_000) });
      commitError = null;
      break;
    } catch (err) {
      commitError = err;
      if (err instanceof SessionAdminError) break; // out of time: no second try
    }
  }
  if (commitError) {
    const cleared = await clearRevert(opencode, sessionId, budget);
    clearSessionCache(projectPath);
    throw new SessionAdminError(502, `Rewind OpenCode tidak bisa diselesaikan (commit gagal: ${commitError.message}). ${undone(cleared)}`);
  }
  clearSessionCache(projectPath);
  const restored = (Array.isArray(staged?.files) ? staged.files : []).map((f) => f?.file ?? f?.path).filter((f) => typeof f === 'string').slice(0, 500);
  return { files: restored, committed: true };
}

/** OpenCode: `opencode session export <id>` (JSON, re-importable with `opencode session import`). */
export function exportOpenCodeSession({ opencode, projectPath, sessionId, sanitize = false }) {
  if (!validSessionId('opencode', sessionId)) return Promise.reject(new SessionAdminError(400, 'Id sesi tidak valid.'));
  if (!opencode) return Promise.reject(new SessionAdminError(404, 'OpenCode belum terpasang.'));
  const args = [...opencode.args, 'session', 'export', sessionId, ...(sanitize ? ['--sanitize'] : [])];
  return new Promise((resolve, reject) => {
    execFileTree(opencode.command, args, { cwd: projectPath, encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(new SessionAdminError(502, 'Export sesi OpenCode gagal.'));
      const start = String(out).indexOf('{');
      try {
        resolve(JSON.parse(String(out).slice(start)));
      } catch {
        reject(new SessionAdminError(502, 'Hasil export OpenCode tidak terbaca.'));
      }
    });
  });
}
