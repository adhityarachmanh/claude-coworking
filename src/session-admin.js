// 🕘 Riwayat sesi: delete, fork, rename, export of a past conversation — both engines, no terminal needed.
// Claude Code: transcripts in ~/.claude/projects/<project>/<id>.jsonl; delete moves them to data/trash (never rm).
// OpenCode: its own store through `opencode api` (session.remove / session.fork / session.update) and
// `opencode session export`.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { openCodeApi } from './opencode-auth.js';
import { clearSessionCache } from './opencode-bin.js';
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

/** OpenCode: `opencode session export <id>` (JSON, re-importable with `opencode session import`). */
export function exportOpenCodeSession({ opencode, projectPath, sessionId, sanitize = false }) {
  if (!validSessionId('opencode', sessionId)) return Promise.reject(new SessionAdminError(400, 'Id sesi tidak valid.'));
  if (!opencode) return Promise.reject(new SessionAdminError(404, 'OpenCode belum terpasang.'));
  const args = [...opencode.args, 'session', 'export', sessionId, ...(sanitize ? ['--sanitize'] : [])];
  return new Promise((resolve, reject) => {
    execFile(opencode.command, args, { cwd: projectPath, encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
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
