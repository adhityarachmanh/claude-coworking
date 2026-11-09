// 📦 OpenCode sessions in a history backup: the official `opencode session export/import` CLI, never a live
// `opencode.db` copy (WAL + running service would make that inconsistent). Best effort: a broken/missing OpenCode
// only adds warnings; the rest of the backup still works.
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileTree } from './proc.js';

const LIST_TIMEOUT_MS = 15_000;
const EXPORT_TIMEOUT_MS = 30_000;
const IMPORT_TIMEOUT_MS = 30_000;
const MAX_EACH_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_SESSIONS = 200;
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,100}$/;

function run(bin, args, cwd, timeout) {
  return new Promise((resolve) => {
    if (!bin?.command) return resolve({ ok: false, out: '' });
    try {
      execFileTree(
        bin.command,
        [...(bin.args ?? []), ...args],
        { cwd, timeout, windowsHide: true, maxBuffer: MAX_EACH_BYTES },
        (err, out) => resolve({ ok: !err, out: String(out ?? '') }),
      );
    } catch {
      resolve({ ok: false, out: '' });
    }
  });
}

async function listSessions(bin, projectPath) {
  const result = await run(bin, ['session', 'list', '--format', 'json', '--max-count', '100'], projectPath, LIST_TIMEOUT_MS);
  if (!result.ok) return null;
  try {
    const list = JSON.parse(result.out);
    return Array.isArray(list)
      ? list
          .filter((s) => SESSION_ID.test(String(s?.id ?? '')))
          .map((s) => ({ id: s.id, title: typeof s.title === 'string' ? s.title.slice(0, 200) : '', updated: Number(s.updated) || 0 }))
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads every project's OpenCode sessions through the CLI. `projects` are `{ id, path }` from the hub.
 * @returns {Promise<{ sessions: {projectId:string, sessionId:string, title:string, data:Buffer}[], skipped: string[] }>}
 */
export async function collectOpenCodeSessions(bin, projects = [], options = {}) {
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const maxBytes = options.maxBytes ?? MAX_TOTAL_BYTES;
  const deadline = Date.now() + (options.maxMs ?? 120_000);
  const sessions = [];
  const skipped = [];
  const seen = new Set();
  let bytes = 0;
  const seenPaths = new Set();
  for (const project of projects) {
    if (sessions.length >= maxSessions || bytes >= maxBytes || Date.now() >= deadline) break;
    const cwd = String(project?.path ?? '');
    const key = cwd.toLowerCase();
    if (!cwd || !existsSync(cwd) || seenPaths.has(key)) continue;
    seenPaths.add(key);
    const list = await listSessions(bin, cwd);
    if (!list) continue;
    for (const session of list) {
      if (sessions.length >= maxSessions || bytes >= maxBytes || Date.now() >= deadline) break;
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      const exported = await run(bin, ['session', 'export', session.id], cwd, EXPORT_TIMEOUT_MS);
      if (!exported.ok || !exported.out.trim()) {
        skipped.push(`${project.id}/${session.id}`);
        continue;
      }
      const data = Buffer.from(exported.out);
      if (data.length > MAX_EACH_BYTES || bytes + data.length > maxBytes) {
        skipped.push(`${project.id}/${session.id} (terlalu besar)`);
        continue;
      }
      // A malformed export must not break the whole ZIP.
      try {
        const parsed = JSON.parse(data.toString('utf8'));
        if (!SESSION_ID.test(String(parsed?.info?.id ?? '')) || parsed.info.id !== session.id) throw new Error('id');
      } catch {
        skipped.push(`${project.id}/${session.id} (JSON tidak valid)`);
        continue;
      }
      sessions.push({ projectId: project.id, sessionId: session.id, title: session.title, data });
      bytes += data.length;
    }
  }
  if (Date.now() >= deadline && sessions.length) skipped.push('batas waktu ekspor sesi OpenCode');
  return { sessions, skipped };
}

/**
 * Imports the sessions of a backup through `opencode session import`. `resolveProject(projectId)` returns this
 * machine's path for the backup's project id (or null). Existing session ids are skipped, so importing twice is safe.
 * @param {{ sessions: {projectId:string, sessionId:string, data:Buffer}[], resolveProject: Function, tempDir: string,
 *           ids?: Map<string, Set<string>>, onWarning?: Function }} options
 */
export async function importOpenCodeSessions(bin, { sessions = [], resolveProject, tempDir, ids = new Map(), onWarning = () => {} } = {}) {
  const added = [];
  const skipped = [];
  if (!bin?.command) {
    if (sessions.length) onWarning('OpenCode tidak terpasang: sesi OpenCode tidak diimpor.');
    return { added, skipped };
  }
  for (const session of sessions) {
    const target = resolveProject(session.projectId) || resolveProject(String(session?.projectId ?? ''));
    if (!target || !existsSync(target)) {
      skipped.push(`${session.projectId}/${session.sessionId}`);
      continue;
    }
    if (!ids.has(target)) ids.set(target, new Set((await listSessions(bin, target))?.map((s) => s.id) ?? []));
    if (ids.get(target).has(session.sessionId)) {
      skipped.push(`${session.projectId}/${session.sessionId}`);
      continue;
    }
    const file = path.join(tempDir, `opencode-${session.sessionId}.json`);
    try {
      writeFileSync(file, session.data);
      const result = await run(bin, ['session', 'import', file, '--directory', target], target, IMPORT_TIMEOUT_MS);
      if (!result.ok) {
        onWarning(`Sesi OpenCode ${session.sessionId} gagal diimpor.`);
        skipped.push(`${session.projectId}/${session.sessionId}`);
        continue;
      }
      ids.get(target).add(session.sessionId);
      added.push({ projectId: session.projectId, sessionId: session.sessionId });
    } finally {
      rmSync(file, { force: true });
    }
  }
  return { added, skipped };
}
