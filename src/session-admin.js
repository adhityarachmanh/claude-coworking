// 🕘 Riwayat sesi: delete, fork, rename, export of a past conversation — both engines, no terminal needed.
// Claude Code: transcripts in ~/.claude/projects/<project>/<id>.jsonl; delete moves them to data/trash (never rm).
// OpenCode: its own store through `opencode api` (session.remove / session.fork / session.update, and for ⏪ Rewind
// session.message.list / session.revert.stage / session.revert.commit) and `opencode session export`.
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

// ---------- ⏪ Rewind (OpenCode 2.x: session.message.list + session.revert.stage / commit) ----------
// stage { messageID, files } hides that message and everything after it and, unless files is false, puts every file
// changed by the later assistant turns back to its snapshot from before them; commit deletes the hidden messages
// (OpenCode also commits a staged revert itself at the next prompt). There is no "files only" revert.

const MESSAGE_ID = /^msg_[\w-]{1,100}$/;
const CURSOR = /^[\w=-]{1,2000}$/;
const POINTS = 80; // as many prompts as Claude's rewind list shows
const PAGE = 200; // OpenCode's maximum page size
const PLAN_PAGES = 5; // newest 1000 messages at most for the preview

export const validMessageId = (id) => MESSAGE_ID.test(String(id ?? ''));

/** The session's prompts (user messages), newest first: `[{ uuid: msg_…, text (full), ts }]`. */
export async function openCodeRewindPoints({ opencode, sessionId }) {
  if (!validSessionId('opencode', sessionId)) throw new SessionAdminError(400, 'Id sesi tidak valid.');
  const list = await openCodeApi(opencode, 'session.message.list', { params: { sessionID: sessionId, type: 'user', order: 'desc', limit: POINTS } });
  return (Array.isArray(list) ? list : [])
    .filter((m) => m?.type === 'user' && validMessageId(m.id))
    .map((m) => ({ uuid: m.id, text: String(m.text ?? '').slice(0, 60_000), ts: Number(m.time?.created) || null }));
}

/**
 * Dry run of a rewind to just before `messageId`: the files OpenCode would put back (those recorded in the snapshots
 * of the assistant messages after it, as SessionRevert.plan does). `found` false = the prompt is not among the newest
 * PLAN_PAGES pages (the list is then unknown, the rewind itself still works).
 */
export async function openCodeRevertPlan({ opencode, sessionId, messageId }) {
  if (!validSessionId('opencode', sessionId)) throw new SessionAdminError(400, 'Id sesi tidak valid.');
  if (!validMessageId(messageId)) throw new SessionAdminError(400, 'Pesan tidak dikenal.');
  const files = new Set();
  let cursor = null;
  for (let page = 0; page < PLAN_PAGES; page++) {
    const params = { sessionID: sessionId, limit: PAGE, ...(cursor ? { cursor } : { order: 'desc' }) }; // desc: cursor.next = older
    const res = await openCodeApi(opencode, 'session.message.list', { params, full: true });
    const list = Array.isArray(res?.data) ? res.data : [];
    for (const m of list) {
      if (m?.id === messageId) {
        if (m.type !== 'user') throw new SessionAdminError(400, 'Pesan itu bukan pesanmu.');
        return { found: true, files: [...files].slice(0, 500) };
      }
      if (m?.type === 'assistant' && m.snapshot?.start) for (const f of Array.isArray(m.snapshot.files) ? m.snapshot.files : []) if (typeof f === 'string' && f) files.add(f.slice(0, 1000));
    }
    cursor = res?.cursor?.next;
    if (list.length < PAGE || !CURSOR.test(String(cursor ?? ''))) break;
  }
  return { found: false, files: [...files].slice(0, 500) };
}

/**
 * Rewinds the session to just before `messageId` (that prompt and everything after it are deleted), with its file
 * changes when `files` is true. Returns the files OpenCode put back.
 */
export async function revertOpenCodeSession({ opencode, projectPath, sessionId, messageId, files }) {
  if (!validSessionId('opencode', sessionId)) throw new SessionAdminError(400, 'Id sesi tidak valid.');
  if (!validMessageId(messageId)) throw new SessionAdminError(400, 'Pesan tidak dikenal.');
  const params = { sessionID: sessionId };
  let staged;
  try {
    staged = await openCodeApi(opencode, 'session.revert.stage', { params, body: { messageID: messageId, files: Boolean(files) } });
  } catch (err) {
    // `opencode api` reports the HTTP status on stderr ("HTTP 404 Not Found"); the JSON reason is on stdout.
    if (/\b409\b|Busy/i.test(err.message)) throw new SessionAdminError(409, 'OpenCode masih bekerja di sesi ini. Hentikan dulu, lalu coba lagi.');
    if (/\b404\b|NotFound/i.test(err.message)) throw new SessionAdminError(404, 'Pesan itu tidak ada lagi di sesi OpenCode.');
    throw new SessionAdminError(502, `Rewind OpenCode gagal: ${err.message}`);
  }
  let committed = true;
  try {
    await openCodeApi(opencode, 'session.revert.commit', { params });
  } catch {
    committed = false; // still staged: OpenCode commits it before the next prompt (the conversation is already cut)
  }
  clearSessionCache(projectPath);
  const restored = (Array.isArray(staged?.files) ? staged.files : []).map((f) => f?.file ?? f?.path).filter((f) => typeof f === 'string').slice(0, 500);
  return { files: restored, committed };
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
