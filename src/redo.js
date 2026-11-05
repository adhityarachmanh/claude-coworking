// ---------- ⏪↩ Redo after a code rewind: the uncommitted working-tree changes a rewind threw away ----------
// A code rewind (Claude Code's file checkpoints, OpenCode's revert) overwrites the worktree. Before it runs, the
// routes snapshot the uncommitted changes here: a `git stash create` commit for the tracked files plus a copy of
// every untracked file. After the rewind the bundle is sealed with the new hashes, and "redo" puts the changes
// back (writing the current bytes to <bundle>/undo/ first, so an overwrite is never a blind one).
//
// Only git repositories: a non-git folder has no HEAD to compare with, so a code rewind there is refused by the
// route (409) before anything changes. Conversation-only rewinds never touch this module. No new dependencies.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ID = /^rd_[a-z0-9]{8,40}$/;
const PROJECT_ID = /^[\w-]{1,64}$/;
const MAX_FILE = 5 * 1024 * 1024; // one untracked file copied into the bundle
const MAX_TOTAL = 50 * 1024 * 1024; // all untracked copies together
const KEEP = 5; // newest bundles per project
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // older than this: dropped on capture/list
const GIT_BUFFER = 64 * 1024 * 1024; // `git show` of one file
// A stash commit needs an author. It never enters the user's history (no ref points at it): a fallback identity
// only keeps the snapshot working in a repository where git has none configured.
const STASH_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Adhit Office',
  GIT_AUTHOR_EMAIL: 'office@localhost',
  GIT_COMMITTER_NAME: 'Adhit Office',
  GIT_COMMITTER_EMAIL: 'office@localhost',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
};

/** A redo request that cannot be served; `status` is the HTTP answer (400 bad id, 404 unknown, 409 not ready). */
export class RedoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function git(cwd, args, { timeout = 15000, encoding = 'utf8' } = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout, encoding, windowsHide: true, maxBuffer: GIT_BUFFER, env: STASH_ENV },
      (err, out, errOut) => resolve({ ok: !err, out, err: String(errOut || err?.message || '').trim() }),
    );
  });
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isSha = (value) => /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(String(value ?? '').trim());

/** The data folder of one project's bundles; the id is validated before it ever reaches a path. */
function projectDir(dataDir, projectId) {
  if (!PROJECT_ID.test(String(projectId ?? ''))) throw new RedoError(400, 'Project tidak dikenal.');
  return path.join(dataDir, 'redo', projectId);
}

function bundleDir(dataDir, projectId, id) {
  if (!ID.test(String(id ?? ''))) throw new RedoError(400, 'Id undo tidak valid.');
  return path.join(projectDir(dataDir, projectId), id);
}

/** `rel` resolved under `root`; null for an absolute path, a NUL or anything that climbs out of the folder. */
function resolveInside(root, rel) {
  const clean = String(rel ?? '');
  if (!clean || clean.includes('\0') || path.isAbsolute(clean)) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, clean);
  return full !== base && full.startsWith(base + path.sep) ? full : null;
}

/** Like resolveInside, and no path segment (the file included) may be a symlink: never write through a link. */
async function safeTarget(root, rel) {
  const full = resolveInside(root, rel);
  if (!full) return null;
  const base = path.resolve(root);
  let dir = base;
  for (const part of path.relative(base, full).split(path.sep)) {
    dir = path.join(dir, part);
    if ((await lstat(dir).catch(() => null))?.isSymbolicLink()) return null;
  }
  return full;
}

/** Write via a temporary file in the same folder, then rename: a half-written bundle or file never exists. */
async function writeAtomic(full, bytes) {
  await mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, bytes);
  try {
    await rename(tmp, full);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** sha256 of a regular file inside the project; null when it is missing or must not be read (symlink). */
async function currentHash(root, rel) {
  const full = await safeTarget(root, rel);
  if (!full) return null;
  const st = await lstat(full).catch(() => null);
  if (!st?.isFile()) return null;
  return sha256(await readFile(full));
}

/** Parses `git status --porcelain -z`: NUL-separated entries, a rename's original path in the next entry. */
function parseStatus(out) {
  const parts = String(out).split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (!raw || raw.length < 4) continue;
    const code = raw.slice(0, 2);
    const file = raw.slice(3);
    const moved = /[RC]/.test(code);
    entries.push(moved ? { code, path: file, from: parts[++i] || null } : { code, path: file });
  }
  return entries;
}

async function readBundle({ dataDir, projectId, id }) {
  if (!ID.test(String(id ?? ''))) throw new RedoError(400, 'Id undo tidak valid.');
  const dir = bundleDir(dataDir, projectId, id);
  let bundle;
  try {
    bundle = JSON.parse(await readFile(path.join(dir, 'bundle.json'), 'utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) throw new RedoError(409, 'Data undo rusak.');
    throw new RedoError(404, 'Undo tidak ditemukan. Mungkin sudah kedaluwarsa.');
  }
  if (bundle?.v !== 1 || bundle.id !== id || bundle.projectId !== projectId || !Array.isArray(bundle.paths)) {
    throw new RedoError(409, 'Data undo rusak.');
  }
  return { bundle, dir };
}

const summaryOf = (bundle) => ({
  id: bundle.id,
  createdAt: bundle.createdAt,
  engine: bundle.engine,
  files: bundle.paths.length,
  status: bundle.status,
  unsupported: bundle.unsupported?.length ?? 0,
});

async function saveBundle(dir, bundle) {
  await writeAtomic(path.join(dir, 'bundle.json'), JSON.stringify(bundle, null, 2));
}

/**
 * Drops bundles that are not worth keeping: older than 7 days, or beyond the 5 newest of the project. Called on
 * capture and list; never throws (a bundle that cannot be read is dropped as well).
 */
export async function pruneRedo({ dataDir, projectId }) {
  const dir = projectDir(dataDir, projectId);
  const names = await readdir(dir).catch(() => []);
  const bundles = [];
  for (const name of names) {
    if (!ID.test(name)) continue;
    const found = await readBundle({ dataDir, projectId, id: name })
      .then((r) => r.bundle)
      .catch(() => null);
    if (!found) {
      await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
      continue;
    }
    bundles.push(found);
  }
  bundles.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const now = Date.now();
  const drop = bundles.filter((b, i) => i >= KEEP || now - (b.createdAt ?? 0) > TTL_MS).map((b) => b.id);
  for (const id of drop) await rm(path.join(dir, id), { recursive: true, force: true }).catch(() => {});
  return { kept: bundles.length - drop.length, dropped: drop.length };
}

/**
 * Snapshots the uncommitted changes of a git project before a code rewind. `{ ok:false, reason }` when the folder
 * is not a repository or the snapshot itself failed — the route then refuses the code rewind before anything moves.
 */
export async function captureRedo({ projectPath, dataDir, projectId, engine }) {
  const repo = await git(projectPath, ['rev-parse', '--show-toplevel']);
  if (!repo.ok) return { ok: false, reason: 'bukan repo git' };

  const status = await git(projectPath, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (!status.ok) return { ok: false, reason: 'status git gagal' };

  // The tracked changes as a commit object (no ref, nothing stored in the user's stash list); empty when clean.
  const stash = await git(projectPath, ['stash', 'create']);
  const stashSha = stash.ok && isSha(stash.out) ? stash.out.trim() : null;

  const id = `rd_${randomBytes(6).toString('hex')}`;
  const dir = bundleDir(dataDir, projectId, id);
  const paths = [];
  const unsupported = [];
  const seen = new Set();
  const add = (rel, before, existed) => {
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    paths.push({ path: rel, before, beforeHash: null, existed });
  };
  for (const entry of parseStatus(status.out)) {
    if (entry.code === '??') add(entry.path, 'untracked', true);
    else if (/D/.test(entry.code)) add(entry.path, 'absent', false);
    else add(entry.path, 'tracked', true);
    // A rename: the new path is the change, the old one did not exist before the rewind (redo deletes it again).
    if (/R/.test(entry.code) && entry.from) add(entry.from, 'absent', false);
  }

  let copied = 0;
  for (const entry of paths) {
    if (!entry.existed) continue;
    const full = resolveInside(projectPath, entry.path);
    if (!full) {
      entry.skip = 'path tidak aman';
      continue;
    }
    const st = await lstat(full).catch(() => null);
    if (!st) {
      entry.existed = false;
      entry.before = 'absent';
      continue;
    }
    if (st.isSymbolicLink()) {
      entry.skip = 'symlink';
      continue;
    }
    if (!st.isFile()) {
      entry.skip = 'bukan file biasa';
      continue;
    }
    if (entry.before === 'untracked') {
      if (st.size > MAX_FILE) {
        entry.skip = 'lebih dari 5 MB';
        continue;
      }
      const bytes = await readFile(full);
      if (copied + bytes.length > MAX_TOTAL) {
        entry.skip = 'batas 50 MB';
        continue;
      }
      const dest = resolveInside(path.join(dir, 'untracked'), entry.path);
      if (!dest) {
        entry.skip = 'path tidak aman';
        continue;
      }
      await writeAtomic(dest, bytes);
      copied += bytes.length;
      entry.beforeHash = sha256(bytes);
      continue;
    }
    entry.beforeHash = sha256(await readFile(full));
  }

  const kept = [];
  for (const entry of paths) {
    if (entry.skip) unsupported.push({ path: entry.path, reason: entry.skip });
    else kept.push(entry);
  }
  // A tracked change with no stash commit cannot be restored later: refuse before the rewind instead.
  if (!stashSha && kept.some((entry) => entry.existed && entry.before === 'tracked')) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: 'snapshot git gagal' };
  }

  const bundle = {
    v: 1,
    id,
    projectId,
    engine: engine === 'opencode' ? 'opencode' : 'claude',
    createdAt: Date.now(),
    stash: stashSha,
    paths: kept,
    unsupported,
    status: 'captured',
  };
  await saveBundle(dir, bundle);
  await pruneRedo({ dataDir, projectId });
  return { ok: true, id, files: kept.length, unsupported };
}

/** After the rewind: every path's content now, so a later user change can be recognised as a conflict. */
export async function sealRedo({ dataDir, projectId, id, projectPath }) {
  const { bundle, dir } = await readBundle({ dataDir, projectId, id });
  if (bundle.status !== 'captured') throw new RedoError(409, 'Undo ini sudah disiapkan.');
  for (const entry of bundle.paths) entry.afterHash = await currentHash(projectPath, entry.path);
  bundle.status = 'ready';
  await saveBundle(dir, bundle);
  return { id: bundle.id, files: bundle.paths.length, createdAt: bundle.createdAt };
}

/** What a redo would do, without touching a file: restore or delete each path, and which ones changed since. */
export async function previewRedo({ dataDir, projectId, id, projectPath }) {
  const { bundle } = await readBundle({ dataDir, projectId, id });
  if (bundle.status !== 'ready') throw new RedoError(409, 'Undo ini belum siap (rewind belum selesai).');
  const files = [];
  let conflicts = 0;
  for (const entry of bundle.paths) {
    const conflict = (await currentHash(projectPath, entry.path)) !== (entry.afterHash ?? null);
    if (conflict) conflicts++;
    files.push({ path: entry.path, action: entry.existed ? 'restore' : 'delete', conflict });
  }
  return { id: bundle.id, createdAt: bundle.createdAt, files, conflicts, unsupported: bundle.unsupported ?? [] };
}

/** The bytes a path had before the rewind: the stash commit for a tracked file, the copy for an untracked one. */
async function beforeBytes(bundle, dir, projectPath, entry) {
  if (entry.before === 'tracked' && bundle.stash) {
    const res = await git(projectPath, ['show', `${bundle.stash}:${entry.path}`], { encoding: 'buffer' });
    if (res.ok) return res.out;
  }
  const copy = resolveInside(path.join(dir, 'untracked'), entry.path);
  if (!copy) return null;
  return readFile(copy).catch(() => null);
}

/** Removes now-empty parent folders, never above the project root; a non-empty folder stops it. */
async function pruneEmptyDirs(root, from) {
  const base = path.resolve(root);
  let cur = path.resolve(from);
  while (cur !== base && cur.startsWith(base + path.sep)) {
    const entries = await readdir(cur).catch(() => null);
    if (!entries?.length) {
      const gone = await rm(cur, { force: false }).then(() => true).catch(() => false);
      if (!gone) return;
      cur = path.dirname(cur);
      continue;
    }
    return;
  }
}

/**
 * Puts the captured changes back. A file changed since the seal is a conflict: skipped unless `overwrite` is set.
 * Before each restored/deleted path the current bytes are kept in <bundle>/undo/. Never writes outside the project.
 */
export async function applyRedo({ dataDir, projectId, id, projectPath, overwrite = false }) {
  const { bundle, dir } = await readBundle({ dataDir, projectId, id });
  if (bundle.status !== 'ready') throw new RedoError(409, 'Undo ini belum siap (rewind belum selesai).');
  const result = { restored: 0, skipped: 0, deleted: 0, conflicts: 0 };
  for (const entry of bundle.paths) {
    const now = await currentHash(projectPath, entry.path);
    const conflict = now !== (entry.afterHash ?? null);
    if (conflict) result.conflicts++;
    if (conflict && !overwrite) {
      result.skipped++;
      continue;
    }
    const full = await safeTarget(projectPath, entry.path);
    if (!full) {
      result.skipped++;
      continue;
    }
    const st = await lstat(full).catch(() => null);
    if (st && !st.isFile()) {
      result.skipped++; // a folder where a file belongs: never replaced silently
      continue;
    }
    // Back up what is there right now (a conflicted file too, before it is overwritten).
    if (st?.isFile()) {
      const backup = resolveInside(path.join(dir, 'undo'), entry.path);
      if (!backup) {
        result.skipped++;
        continue;
      }
      try {
        await writeAtomic(backup, await readFile(full));
      } catch {
        result.skipped++;
        continue;
      }
    }
    if (!entry.existed) {
      if (!st) continue; // already absent: nothing to delete
      if (!st.isFile()) {
        result.skipped++;
        continue;
      }
      await rm(full, { force: true });
      await pruneEmptyDirs(projectPath, path.dirname(full));
      result.deleted++;
      continue;
    }
    const bytes = await beforeBytes(bundle, dir, projectPath, entry);
    if (!bytes) {
      result.skipped++;
      continue;
    }
    await writeAtomic(full, bytes);
    result.restored++;
  }
  return result;
}

/** The ready bundles of a project, newest first (prunes first, as capture does). */
export async function listRedo({ dataDir, projectId }) {
  const dir = projectDir(dataDir, projectId);
  await pruneRedo({ dataDir, projectId });
  const names = await readdir(dir).catch(() => []);
  const bundles = [];
  for (const name of names) {
    if (!ID.test(name)) continue;
    const bundle = await readBundle({ dataDir, projectId, id: name })
      .then((r) => r.bundle)
      .catch(() => null);
    if (bundle?.status === 'ready') bundles.push(summaryOf(bundle));
  }
  return { bundles: bundles.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)) };
}
