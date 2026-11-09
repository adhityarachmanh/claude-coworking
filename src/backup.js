// "Cadangkan riwayat": the Claude Code history (~/.claude/projects and friends) plus the office's own data
// in one .zip, and restoring it on another machine (new SSD, reinstall) so old conversations continue —
// in the app's session history and with `claude --resume`.
//
// Archive layout (format BACKUP_FORMAT, version BACKUP_VERSION):
//   manifest.json              what is inside, where it came from (home, platform, project folders + their cwd)
//   claude/projects/**         every project's transcripts (.jsonl), subagent transcripts, memory/
//   claude/history.jsonl       prompt history (↑ in the CLI)
//   claude/file-history/**     checkpoints used by rewind
//   claude/plans/**            plan-mode plans
//   office/state.json          the office's state (folders, favorites, settings…; no paired-device hashes);
//                              backups made before data/chats existed carry the chats in it (`chats`)
//   office/chats/<id>.jsonl    each project's chat history (data/chats, see src/chat-store.js)
//   office/chats-opencode/<id>.jsonl  the same for OpenCode's workspace (data/chats-opencode, per-project engine)
//   opencode/sessions/<project>/<session>.json  OpenCode's own sessions via `opencode session export` (best effort)
//   office/usage.jsonl         token ledger
// Never included: login credentials (.credentials.json, ~/.claude.json), caches, logs.
//
// Restore treats the archive as untrusted: it adds, never replaces what is here (rules in restoreBackup). Project folders are renamed when the
// home folder differs (C:\Users\old\x → C:\Users\new\x), using Claude Code's folder naming; file contents
// stay as they were, except the `project` path of history.jsonl lines (it scopes ↑-history per project).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, renameSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CHAT_LIMIT, isChatId, parseChatFile } from './chat-store.js';
import { PROJECTS_DIR } from './transcripts.js';
import { ZipError, ZipReader, ZipWriter, crc32, unsafeEntryName } from './zip.js';

export const BACKUP_FORMAT = 'adhit-office-backup';
export const BACKUP_VERSION = 2;
// A session transcript written to this recently is treated as in use (a terminal session may be running).
const ACTIVE_WINDOW_MS = 60_000;
const SESSION_FILE = /^[0-9a-f-]{36}\.jsonl$/i;
const HEAD_BYTES = 256 * 1024;
const MAX_DEFAULT_UNPACKED = 64 * 1024 ** 3;
// usage.jsonl / history.jsonl of a backup are merged in memory: anything larger is skipped (with a warning).
const MAX_MERGE_BYTES = 64 * 1024 * 1024;
// A project's chat file in the archive (and in data/chats): the project id is the file name.
const CHAT_ENTRY = /^office\/chats(?:-(opencode))?\/([A-Za-z0-9_-]{1,64})\.jsonl$/;
/** { engine, id } of a chat entry name, or null (also for Windows device names: con, nul…). */
const chatEntryOf = (name) => {
  const m = CHAT_ENTRY.exec(name);
  return m && isChatId(m[2]) ? { engine: m[1] ?? 'claude', id: m[2] } : null;
};
const chatEntryId = (name) => chatEntryOf(name)?.id ?? null;

/** An import problem with its own HTTP status (ZipError = malformed/unsafe archive = 400). */
export class BackupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** ~/.claude and its projects folder, following the same override as the transcript reader (tests). */
export function claudeLocations() {
  return {
    projectsDir: PROJECTS_DIR,
    claudeDir: process.env.CLAUDE_PROJECTS_DIR ? path.dirname(PROJECTS_DIR) : path.join(os.homedir(), '.claude'),
  };
}

/** Claude Code's transcript folder name for a project path: every non-alphanumeric character becomes '-'. */
export const encodeProjectPath = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');

// ---------- export ----------

async function readdirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every regular file under `dir` as archive entries `prefix/...`. Symlinks/junctions are never followed. */
async function listFiles(dir, prefix, out, skipped) {
  for (const d of await readdirSafe(dir)) {
    const abs = path.join(dir, d.name);
    const name = `${prefix}/${d.name}`;
    if (d.isSymbolicLink()) {
      skipped.push(name);
    } else if (d.isDirectory()) {
      await listFiles(abs, name, out, skipped);
    } else if (d.isFile() && !d.name.endsWith('.import-tmp')) {
      // A name another OS allows but Windows can't hold (e.g. "a:b") would make the whole backup unimportable.
      if (unsafeEntryName(name)) {
        skipped.push(name);
        continue;
      }
      try {
        const st = await fs.stat(abs);
        out.push({ name, abs, size: st.size, mtime: st.mtimeMs });
      } catch {
        // vanished
      }
    }
  }
}

/** The folder a project's transcripts belong to: the `cwd` of its newest transcripts' first entries. */
async function projectCwd(dir) {
  const files = [];
  for (const d of await readdirSafe(dir)) {
    if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
    try {
      files.push({ file: path.join(dir, d.name), mtime: (await fs.stat(path.join(dir, d.name))).mtimeMs });
    } catch {
      // vanished
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of files.slice(0, 5)) {
    let fh;
    try {
      fh = await fs.open(file, 'r');
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
      for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
        try {
          const cwd = JSON.parse(line)?.cwd;
          if (typeof cwd === 'string' && cwd) return cwd;
        } catch {
          // partial or non-JSON line
        }
      }
    } catch {
      // unreadable
    } finally {
      await fh?.close();
    }
  }
  return null;
}

/** Adds one file, streamed; a transcript still being appended to is cut at its size when it was listed. */
async function addFile(zip, f) {
  let fh;
  try {
    fh = await fs.open(f.abs, 'r');
  } catch {
    return false; // vanished since it was listed
  }
  try {
    const size = Math.min(f.size, (await fh.stat()).size);
    const source = size ? fh.createReadStream({ start: 0, end: size - 1, autoClose: false }) : Readable.from([]);
    await zip.add(f.name, source, { size, mtime: f.mtime });
    return true;
  } finally {
    await fh.close();
  }
}

/**
 * Streams a complete backup into `out` (not ended here).
 * @param {import('node:stream').Writable} out
 * @param {{ state: object, usageFile?: string, chatsDir?: string, appVersion?: string, homeDir?: string,
 *           locations?: { projectsDir: string, claudeDir: string }, zip64?: boolean }} options
 *   chatsDir: data/chats (flushed by the caller first); its *.jsonl go in as office/chats/
 * @returns {Promise<{ files: number, bytes: number, skipped: string[] }>}
 */
export async function writeBackup(out, { state, usageFile, chatsDir, engineChats = {}, opencodeSessions = [], appVersion = null, homeDir = os.homedir(), locations = claudeLocations(), zip64 = false }) {
  const { projectsDir, claudeDir } = locations;
  const files = [];
  const skipped = [];
  const projects = [];
  for (const d of await readdirSafe(projectsDir)) {
    if (!d.isDirectory()) continue;
    if (unsafeEntryName(d.name)) {
      skipped.push(`claude/projects/${d.name}`);
      continue;
    }
    const from = files.length;
    await listFiles(path.join(projectsDir, d.name), `claude/projects/${d.name}`, files, skipped);
    const own = files.slice(from);
    projects.push({
      folder: d.name,
      cwd: await projectCwd(path.join(projectsDir, d.name)),
      sessions: own.filter((f) => SESSION_FILE.test(f.name.split('/')[3] ?? '') && f.name.split('/').length === 4).length,
      files: own.length,
      bytes: own.reduce((sum, f) => sum + f.size, 0),
    });
  }
  try {
    const st = await fs.stat(path.join(claudeDir, 'history.jsonl'));
    if (st.isFile()) files.push({ name: 'claude/history.jsonl', abs: path.join(claudeDir, 'history.jsonl'), size: st.size, mtime: st.mtimeMs });
  } catch {
    // no prompt history yet
  }
  for (const dir of ['file-history', 'plans']) await listFiles(path.join(claudeDir, dir), `claude/${dir}`, files, skipped);
  if (usageFile) {
    try {
      const st = await fs.stat(usageFile);
      files.push({ name: 'office/usage.jsonl', abs: usageFile, size: st.size, mtime: st.mtimeMs });
    } catch {
      // no usage recorded yet
    }
    // Rotated ledgers (src/usage.js): every archive is part of the history.
    const archiveDir = path.join(path.dirname(usageFile), 'usage-archive');
    for (const d of await readdirSafe(archiveDir)) {
      if (!d.isFile() || !/^usage-[\w-]+\.jsonl$/.test(d.name)) continue;
      try {
        const st = await fs.stat(path.join(archiveDir, d.name));
        files.push({ name: `office/usage-archive/${d.name}`, abs: path.join(archiveDir, d.name), size: st.size, mtime: st.mtimeMs });
      } catch {
        // vanished meanwhile
      }
    }
  }
  // engineChats: { opencode: data/chats-opencode } → office/chats-opencode/ (each engine's workspace)
  for (const [prefix, dir] of [['chats', chatsDir], ...Object.entries(engineChats).map(([e, d]) => [`chats-${e}`, d])]) {
    if (!dir) continue;
    for (const d of await readdirSafe(dir)) {
      const name = `office/${prefix}/${d.name}`;
      if (!d.isFile() || !chatEntryId(name)) continue; // symlinks, *.tmp of a compaction, anything else
      try {
        const st = await fs.stat(path.join(dir, d.name));
        files.push({ name, abs: path.join(dir, d.name), size: st.size, mtime: st.mtimeMs });
      } catch {
        // vanished (project forgotten meanwhile)
      }
    }
  }

  const stateBuf = Buffer.from(JSON.stringify(state ?? {}));
  const sessionBuffers = [];
  for (const session of opencodeSessions) {
    const projectId = String(session?.projectId ?? '');
    const sessionId = String(session?.sessionId ?? '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId) || !/^ses_[A-Za-z0-9_-]{1,100}$/.test(sessionId)) continue;
    if (!Buffer.isBuffer(session.data) || !session.data.length) continue;
    sessionBuffers.push({ name: `opencode/sessions/${projectId}/${sessionId}.json`, data: session.data });
  }
  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    app: { name: 'Adhit Office', version: appVersion },
    platform: process.platform,
    homeDir,
    claudeDir,
    projects,
    counts: {
      files: files.length + 1 + sessionBuffers.length,
      bytes: files.reduce((sum, f) => sum + f.size, 0) + stateBuf.length + sessionBuffers.reduce((sum, s) => sum + s.data.length, 0),
      sessions: projects.reduce((s, p) => s + p.sessions, 0),
      opencodeSessions: sessionBuffers.length,
    },
    skipped,
  };
  const zip = new ZipWriter(out, { zip64 });
  await zip.add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  await zip.add('office/state.json', stateBuf);
  let written = 2;
  for (const f of files) if (await addFile(zip, f)) written++;
  for (const session of sessionBuffers) {
    await zip.add(session.name, session.data);
    written++;
  }
  return { files: written, bytes: await zip.finish(), skipped };
}

// ---------- path remapping ----------

/**
 * Maps paths under the backup's home folder to this machine's home (and back). Windows paths compare
 * case-insensitively. Paths outside the home folder are left as they are.
 */
export function makeRemap(oldHome, newHome, oldPlatform = process.platform) {
  const oldWin = oldPlatform === 'win32';
  const newWin = process.platform === 'win32';
  const clean = (p, win) => (win ? String(p).replace(/\//g, '\\') : String(p)).replace(/[\\/]+$/, '');
  const fold = (s, win) => (win ? s.toLowerCase() : s);
  const oldSep = oldWin ? '\\' : '/';
  const oh = typeof oldHome === 'string' && oldHome ? clean(oldHome, oldWin) : null;
  const nh = clean(newHome, newWin);
  const identity = !oh || (oldWin === newWin && fold(oh, oldWin) === fold(nh, newWin));
  /** The part of `p` below `base` ('' = base itself), or null when `p` is elsewhere. */
  const below = (p, base, win, sep) => {
    const a = fold(p, win);
    const b = fold(base, win);
    if (a === b) return '';
    return a.startsWith(b + sep) ? p.slice(base.length + 1) : null;
  };

  function mapPath(p) {
    if (identity || typeof p !== 'string' || !p) return p;
    const rest = below(clean(p, oldWin), oh, oldWin, oldSep);
    if (rest == null) return p;
    return rest ? path.join(nh, ...rest.split(oldSep).filter(Boolean)) : nh;
  }

  function unmapPath(p) {
    if (identity || typeof p !== 'string' || !p) return p;
    const rest = below(clean(p, newWin), nh, newWin, path.sep);
    if (rest == null) return p;
    return rest ? [oh, ...rest.split(path.sep).filter(Boolean)].join(oldSep) : oh;
  }

  const encOld = oh ? encodeProjectPath(oh) : '';
  const encNew = encodeProjectPath(nh);
  /** New transcript folder name: from the project's cwd when known, else by the encoded home prefix. */
  function mapFolder(folder, cwd) {
    if (identity) return folder;
    if (typeof cwd === 'string' && cwd && encodeProjectPath(cwd).toLowerCase() === folder.toLowerCase()) {
      const mapped = mapPath(cwd);
      return mapped === cwd ? folder : encodeProjectPath(mapped);
    }
    const f = folder.toLowerCase();
    const e = encOld.toLowerCase();
    if (e && (f === e || f.startsWith(`${e}-`))) return encNew + folder.slice(encOld.length);
    return folder;
  }

  return { identity, oldHome: oh, newHome: nh, mapPath, unmapPath, mapFolder };
}

// ---------- restore ----------

const KNOWN_FILES = new Set(['manifest.json', 'office/state.json', 'office/usage.jsonl', 'claude/history.jsonl']);
const KNOWN_DIRS = /^claude\/(projects|file-history|plans)\/./;
const USAGE_ARCHIVE = /^office\/usage-archive\/usage-[\w-]+\.jsonl$/; // rotated ledgers (src/usage.js)
const OPENCODE_SESSION = /^opencode\/sessions\/([A-Za-z0-9_-]{1,64})\/(ses_[A-Za-z0-9_-]{1,100})\.json$/;
const isKnownEntry = (name) => KNOWN_FILES.has(name) || KNOWN_DIRS.test(name) || USAGE_ARCHIVE.test(name) || OPENCODE_SESSION.test(name) || Boolean(chatEntryId(name));

function parseJson(buf, what) {
  try {
    const value = JSON.parse(buf.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // fall through
  }
  throw new ZipError(`${what} bukan JSON yang valid.`);
}

const jsonLines = (buf) =>
  buf
    .toString('utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim());

/** Streams a file (or its first `bytes`) through `fn(chunk)`. */
async function eachChunk(file, fn, bytes) {
  if (bytes === 0) return;
  await pipeline(
    createReadStream(file, bytes == null ? {} : { start: 0, end: bytes - 1 }),
    new Writable({
      write(chunk, _enc, cb) {
        fn(chunk);
        cb();
      },
    }),
  );
}

async function fileCrc(file) {
  let crc = 0;
  await eachChunk(file, (chunk) => (crc = crc32(chunk, crc)));
  return crc;
}

async function sha1Prefix(file, bytes) {
  const hash = createHash('sha1');
  await eachChunk(file, (chunk) => hash.update(chunk), bytes);
  return hash.digest('hex');
}

/** `target` is strictly below `base` (not `base` itself). Case-insensitive on Windows (path.relative is). */
const inside = (base, target) => {
  const rel = path.relative(base, target);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/**
 * Whether a folder named by a backup (roots, added folders, project paths) may be used on this machine:
 * absolute, strictly below this home folder (not the home itself, not a drive root, never UNC — those are
 * outside any home). The caller still checks it exists (isDirectory refuses network paths before any I/O).
 */
export function isUnderHome(p, home = os.homedir()) {
  return typeof p === 'string' && path.isAbsolute(p) && !/^([\\/]{2}|\\\?\?\\)/.test(p) && inside(path.resolve(home), path.resolve(p));
}

/** `dir` (resolved through links) must be `base` or inside it. */
async function assertInside(base, dir, name) {
  const realBase = await fs.realpath(base);
  const real = await fs.realpath(dir);
  if (real !== realBase && !inside(realBase, real)) throw new ZipError(`Entri "${name}" mengarah keluar folder tujuan (symlink/junction).`);
}

/** Resolves `parts` under `base` and makes its folder, refusing anything that ends up outside `base` (also via links). */
async function safeTarget(base, parts) {
  const dest = path.resolve(base, ...parts);
  if (!inside(base, dest)) throw new ZipError(`Entri "${parts.join('/')}" keluar dari folder tujuan.`);
  await fs.mkdir(base, { recursive: true });
  const realBase = await fs.realpath(base);
  // Before creating folders: the deepest existing one must already be inside (no junction to elsewhere).
  let existing = path.dirname(dest);
  for (;;) {
    try {
      await fs.lstat(existing);
      break;
    } catch {
      existing = path.dirname(existing);
    }
  }
  const realExisting = await fs.realpath(existing);
  if (realExisting !== realBase && !inside(realBase, realExisting)) throw new ZipError(`Entri "${parts.join('/')}" mengarah keluar folder tujuan (symlink/junction).`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const realParent = await fs.realpath(path.dirname(dest));
  if (realParent !== realBase && !inside(realBase, realParent)) throw new ZipError(`Entri "${parts.join('/')}" mengarah keluar folder tujuan (symlink/junction).`);
  return dest;
}

/** A file that can't be replaced now (another program holds it open) is reported, not fatal. */
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * What `restoreBackup` would find in the archive, without writing anything: projects (with their session count),
 * chat history files per engine, and which shared data travels with it. Used by the import dialog's preview.
 * @param {string} zipFile
 * @param {{ maxUnpacked?: number }} [ctx]
 */
export async function previewBackup(zipFile, ctx = {}) {
  const { maxUnpacked = MAX_DEFAULT_UNPACKED } = ctx;
  const reader = await ZipReader.open(zipFile);
  try {
    const entries = reader.entries.filter((e) => !e.isDir);
    for (const e of entries) if (!isKnownEntry(e.name)) throw new ZipError(`Entri "${e.name}" bukan bagian dari backup Adhit Office.`);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const manifestEntry = byName.get('manifest.json');
    if (!manifestEntry) throw new ZipError('Ini bukan backup Adhit Office (manifest.json tidak ada).');
    const manifest = parseJson(await reader.read(manifestEntry, 16 * 1024 * 1024), 'manifest.json');
    if (manifest.format !== BACKUP_FORMAT) throw new ZipError('Ini bukan backup Adhit Office (format tidak dikenal).');
    if (!(Number(manifest.version) <= BACKUP_VERSION)) throw new BackupError(400, 'Backup dibuat oleh versi Adhit Office yang lebih baru. Perbarui app ini dulu.');
    const unpacked = entries.reduce((sum, e) => sum + e.usize, 0);
    if (unpacked > maxUnpacked) throw new BackupError(413, 'Isi backup terlalu besar untuk dipulihkan.');

    const cwdOf = new Map((Array.isArray(manifest.projects) ? manifest.projects : []).filter((p) => typeof p?.folder === 'string').map((p) => [p.folder, typeof p.cwd === 'string' ? p.cwd : null]));
    const projects = new Map();
    const chats = { claude: 0, opencode: 0 };
    let fileHistory = 0;
    let plans = 0;
    let opencodeSessions = 0;
    for (const e of entries) {
      const parts = e.name.split('/');
      if (OPENCODE_SESSION.test(e.name)) opencodeSessions += 1;
      if (parts[0] === 'claude' && parts[1] === 'projects' && parts[2]) {
        const p = projects.get(parts[2]) ?? { folder: parts[2], cwd: cwdOf.get(parts[2]) ?? null, sessions: 0, files: 0 };
        if (parts.length === 4 && SESSION_FILE.test(parts[3])) p.sessions += 1;
        else p.files += 1;
        projects.set(parts[2], p);
      } else if (parts[0] === 'claude' && parts[1] === 'file-history') {
        fileHistory += 1;
      } else if (parts[0] === 'claude' && parts[1] === 'plans') {
        plans += 1;
      }
      const chat = chatEntryOf(e.name);
      if (chat) chats[chat.engine] += 1;
    }
    // Backups from before the effective-root fix have neither roots nor explicit project paths: a project whose
    // only history is OpenCode cannot be mapped on import. Warn before restoring instead of silently dropping it.
    let legacy = false;
    const stateEntry = byName.get('office/state.json');
    if (stateEntry && chats.opencode > 0) {
      try {
        const state = parseJson(await reader.read(stateEntry, 16 * 1024 * 1024), 'office/state.json');
        legacy = !(Array.isArray(state.roots) && state.roots.length) && !(Array.isArray(state.projects) && state.projects.length);
      } catch {
        legacy = false;
      }
    }
    return {
      format: manifest.format,
      version: Number(manifest.version) || 1,
      createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
      source: { homeDir: typeof manifest.homeDir === 'string' ? manifest.homeDir : null, platform: typeof manifest.platform === 'string' ? manifest.platform : null, appVersion: manifest.app?.version ?? null },
      entries: entries.length,
      unpackedBytes: unpacked,
      projects: [...projects.values()].sort((a, b) => b.sessions - a.sessions),
      sessions: [...projects.values()].reduce((sum, p) => sum + p.sessions, 0),
      chats,
      chatSessions: chats.claude + chats.opencode,
      opencodeSessions,
      legacy,
      includes: { state: byName.has('office/state.json'), usage: byName.has('office/usage.jsonl'), history: byName.has('claude/history.jsonl'), fileHistory, plans },
    };
  } finally {
    await reader.close();
  }
}

/**
 * Restores a backup archive into this machine's Claude folder; the office state is returned for the hub to merge.
 *
 * The archive is untrusted (it may come from someone else): it can add, never take over what is here.
 * Merge rules (nothing is deleted; every write is atomic: extracted + verified next to it, then renamed):
 * - Session transcripts (*.jsonl under projects/, subagents included; append-only): written when missing.
 *   When present, the backup's version replaces it only if it is a strict continuation (the local bytes are
 *   its prefix); a diverging one is skipped with a warning (no second copy: it would show up as a duplicate
 *   session). A transcript of a running session (active id, or written to in the last minute) is never touched.
 * - Other files under projects/ (memory, meta), file-history/, plans/: written when missing; identical
 *   (size + CRC) skipped; different → never replaced, the backup's version is saved as "<name>.from-backup"
 *   (-2, -3…) with a warning. Memory added to a project folder this machine already had is always reported.
 * - history.jsonl: unique lines of both, ordered by `timestamp`; `project` paths remapped to this home.
 * - usage.jsonl: rows merged without duplicates through the ledger.
 *   (Both up to maxMergeBytes, 64 MB; larger is skipped with a warning.)
 * - state.json: parsed and returned (the server merges it into the hub, see Hub.mergeFolders / mergeProjectData).
 * - office/chats/<id>.jsonl: parsed (newest CHAT_LIMIT messages; each file and all of them together up to
 *   maxMergeBytes, the rest skipped with a warning) and returned as `chats`
 *   by the backup's project id; never written as files here (Hub.mergeProjectData merges them by message).
 *
 * @param {string} zipFile
 * @param {{ locations?: { projectsDir: string, claudeDir: string }, homeDir?: string, activeSessions?: Set<string>,
 *           only?: Iterable<string>, parts?: { state?: boolean, usage?: boolean, history?: boolean },
 *           onFileWritten?: (file: string) => void, ledger?: { importRows(rows: object[]): number },
 *           maxUnpacked?: number, now?: number }} [ctx]
 *   `only`: project folder keys (from `previewBackup`) to restore; absent = every project.
 *   `parts`: which shared data merges (office state, token ledger, prompt history); absent = all three.
 */
export async function restoreBackup(zipFile, ctx = {}) {
  const {
    locations = claudeLocations(),
    homeDir = os.homedir(),
    activeSessions = new Set(),
    onFileWritten = () => {},
    ledger = null,
    maxUnpacked = MAX_DEFAULT_UNPACKED,
    maxMergeBytes = MAX_MERGE_BYTES,
    now = Date.now(),
  } = ctx;
  const { projectsDir, claudeDir } = locations;
  // Which shared data comes back (the UI's checkboxes); transcripts/files always follow `only`.
  const keep = { state: ctx.parts?.state !== false, usage: ctx.parts?.usage !== false, history: ctx.parts?.history !== false };
  const reader = await ZipReader.open(zipFile);
  try {
    const entries = reader.entries.filter((e) => !e.isDir);
    // Zip-slip & co: every name was checked by the reader; here it must also be one of ours. Checked for
    // the whole archive before a single byte is written.
    for (const e of entries) if (!isKnownEntry(e.name)) throw new ZipError(`Entri "${e.name}" bukan bagian dari backup Adhit Office.`);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const manifestEntry = byName.get('manifest.json');
    if (!manifestEntry) throw new ZipError('Ini bukan backup Adhit Office (manifest.json tidak ada).');
    const manifest = parseJson(await reader.read(manifestEntry, 16 * 1024 * 1024), 'manifest.json');
    if (manifest.format !== BACKUP_FORMAT) throw new ZipError('Ini bukan backup Adhit Office (format tidak dikenal).');
    if (!(Number(manifest.version) <= BACKUP_VERSION)) throw new BackupError(400, 'Backup dibuat oleh versi Adhit Office yang lebih baru. Perbarui app ini dulu.');

    const unpacked = entries.reduce((sum, e) => sum + e.usize, 0);
    if (unpacked > maxUnpacked) throw new BackupError(413, 'Isi backup terlalu besar untuk dipulihkan.');
    await fs.mkdir(projectsDir, { recursive: true });
    try {
      const { bavail, bsize } = await fs.statfs(projectsDir);
      if (bavail * bsize < unpacked) throw new BackupError(507, `Ruang disk tidak cukup: butuh sekitar ${Math.ceil(unpacked / 1024 ** 2)} MB.`);
    } catch (err) {
      if (err instanceof BackupError) throw err; // statfs unsupported here: just try
    }

    const remap = makeRemap(manifest.homeDir, homeDir, manifest.platform);
    const cwdOf = new Map((Array.isArray(manifest.projects) ? manifest.projects : []).filter((p) => typeof p?.folder === 'string').map((p) => [p.folder, typeof p.cwd === 'string' ? p.cwd : null]));
    // Selective restore: only these project folders (and their chat files) come back; shared data still merges.
    const only = ctx.only == null ? null : new Set([...ctx.only].filter((f) => typeof f === 'string' && f));
    // Chat files are named with the project id the SOURCE machine gave the folder: compute it the same way.
    const sourceId = (p) => {
      let key = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
      if (manifest.platform === 'win32') key = key.toLowerCase();
      return createHash('sha1').update(key).digest('hex').slice(0, 10);
    };
    const selectedChatIds = only ? new Set([...only].map((f) => cwdOf.get(f)).filter(Boolean).map(sourceId)) : null;
    const summary = {
      projects: 0,
      sessions: { added: 0, updated: 0, skipped: 0 },
      files: { added: 0, copies: 0, skipped: 0 }, // copies: saved next to a differing local file (.from-backup)
      history: { added: 0 },
      usage: { added: 0 },
      remapped: [],
      warnings: [],
      source: { createdAt: manifest.createdAt ?? null, homeDir: manifest.homeDir ?? null, platform: manifest.platform ?? null, appVersion: manifest.app?.version ?? null },
    };
    const warn = (text) => {
      if (summary.warnings.length < 200) summary.warnings.push(text);
    };

    // Transcript folder names on this machine.
    const folders = new Map(); // backup folder -> { folder, cwd, sessions }
    for (const e of entries) {
      const parts = e.name.split('/');
      if (parts[1] !== 'projects' || parts.length < 4 || folders.has(parts[2])) continue;
      if (only && !only.has(parts[2])) continue; // not selected in the import preview
      const from = parts[2];
      const cwd = cwdOf.get(from) ?? null;
      let to = remap.mapFolder(from, cwd);
      if (!/^[A-Za-z0-9-]{1,255}$/.test(to)) {
        warn(`Nama folder project "${to}" tidak valid di sini; folder asli "${from}" dipakai.`);
        to = from;
      }
      const newCwd = cwd ? remap.mapPath(cwd) : null;
      folders.set(from, { folder: to, cwd: newCwd, sessions: 0 });
      if (to !== from) summary.remapped.push({ from, to, cwd, newCwd });
    }
    summary.projects = folders.size;

    // Project folders this machine already had: memory restored into them is always reported (it steers Claude).
    const preexisting = new Set([...folders.values()].map((f) => f.folder).filter((f) => existsSync(path.join(projectsDir, f))));

    /**
     * Extracts `entry` next to `dest` (verified size + CRC), lets `accept(tmp)` decide, then renames it into place.
     * @returns {Promise<boolean>} whether it was written
     */
    async function writeAtomic(entry, dest, base, accept = async () => true) {
      const tmp = `${dest}.${process.pid}.import-tmp`; // not *.jsonl: the live mirror ignores it
      try {
        await reader.extractTo(entry, tmp);
        if (!(await accept(tmp))) return false;
        // The reader already clamps the archive's time to now; it keeps the "last used" order of sessions.
        if (entry.mtime) await fs.utimes(tmp, new Date(entry.mtime), new Date(entry.mtime));
        await assertInside(base, path.dirname(dest), entry.name); // nothing swapped in a link meanwhile
        renameSync(tmp, dest);
        onFileWritten(dest); // same tick as the rename: the mirror sees history, not new live activity
        return true;
      } finally {
        await fs.rm(tmp, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {}); // gone after a rename
      }
    }

    /** A free "<name>.from-backup[-N]" next to `dest`, or null when one of them already holds these bytes. */
    async function sideBySide(dest, entry) {
      for (let i = 1; i <= 20; i++) {
        const candidate = `${dest}.from-backup${i > 1 ? `-${i}` : ''}`;
        let st;
        try {
          st = await fs.lstat(candidate);
        } catch {
          return candidate;
        }
        if (st.isFile() && st.size === entry.usize && (await fileCrc(candidate)) === entry.crc) return null;
      }
      return undefined; // too many copies already
    }

    async function place(entry, base, parts, { session = false, memory = false, counter }) {
      const label = entry.name.replace(/^claude\//, '');
      const dest = await safeTarget(base, parts);
      let st = null;
      try {
        st = await fs.lstat(dest);
      } catch {
        // not there yet
      }
      try {
        if (st && !st.isFile()) {
          warn(`Dilewati, di tujuan bukan file biasa: ${label}`);
          return counter.skipped++;
        }
        if (!st) {
          await writeAtomic(entry, dest, base);
          if (memory) warn(`Memori project ditambahkan ke project yang sudah ada di laptop ini, periksa isinya: ${label}`);
          return counter.added++;
        }
        if (session) {
          const id = parts.find((p) => activeSessions.has(p.replace(/\.jsonl$/, '')));
          if (id || now - st.mtimeMs < ACTIVE_WINDOW_MS) {
            if (entry.usize !== st.size) warn(`Tidak ditimpa karena sesinya sedang berjalan: ${label}`);
            return counter.skipped++;
          }
          if (entry.usize <= st.size) return counter.skipped++; // ours is as long or longer
          // Only a continuation of the transcript here may replace it (same bytes, then more).
          const isContinuation = async (tmp) => (await sha1Prefix(dest, st.size)) === (await sha1Prefix(tmp, st.size));
          if (await writeAtomic(entry, dest, base, isContinuation)) return counter.updated++;
          warn(`Tidak ditimpa: transcript di backup bukan lanjutan transcript di laptop ini: ${label}`);
          return counter.skipped++;
        }
        if (entry.usize === st.size && (await fileCrc(dest)) === entry.crc) return counter.skipped++;
        // A file this machine already has is never replaced: the backup's version goes next to it.
        const copy = await sideBySide(dest, entry);
        if (copy === null) return counter.skipped++; // saved next to it by an earlier import
        if (copy === undefined) {
          warn(`Dilewati (terlalu banyak salinan .from-backup): ${label}`);
          return counter.skipped++;
        }
        await writeAtomic(entry, copy, base);
        warn(`Sudah ada dan berbeda, tidak ditimpa. Versi backup disimpan sebagai ${path.basename(copy)}: ${label}`);
        return counter.copies++;
      } catch (err) {
        if (!LOCKED.has(err?.code)) throw err;
        warn(`Tidak bisa ditulis (sedang dipakai program lain): ${label}`);
        return counter.skipped++;
      }
    }

    /** usage/history are read whole: bounded, a larger one is skipped with a warning. */
    const mergeable = (entry) => {
      if (entry.usize <= maxMergeBytes) return true;
      warn(`Dilewati, terlalu besar untuk digabung (${Math.round(entry.usize / 1024 ** 2)} MB): ${entry.name}`);
      return false;
    };

    let state = null;
    const chats = {};
    const engineChats = {}; // engine -> { project id -> messages }, other workspaces than Claude Code's
    const opencodeSessions = [];
    let chatBytes = 0; // every chat file is read into memory: bounded together, like usage/history
    let opencodeBytes = 0;
    for (const e of entries) {
      const parts = e.name.split('/');
      if (e.name === 'manifest.json') continue;
      if (e.name === 'office/state.json') {
        if (keep.state) state = parseJson(await reader.read(e, 64 * 1024 * 1024), 'office/state.json');
      } else if (chatEntryId(e.name)) {
        const { engine, id } = chatEntryOf(e.name);
        if (selectedChatIds && !selectedChatIds.has(id)) continue; // chat of a project the user did not pick
        if (!mergeable(e)) continue;
        if (chatBytes + e.usize > maxMergeBytes) {
          warn(`Dilewati, riwayat chat di backup terlalu besar secara total: ${e.name}`);
          continue;
        }
        chatBytes += e.usize;
        const list = parseChatFile(await reader.read(e, maxMergeBytes), CHAT_LIMIT);
        if (engine === 'claude') chats[id] = list;
        else (engineChats[engine] ??= {})[id] = list;
      } else if (e.name === 'office/usage.jsonl' || /^office\/usage-archive\/usage-[\w-]+\.jsonl$/.test(e.name)) {
        if (!keep.usage || !ledger || !mergeable(e)) continue;
        const rows = [];
        for (const line of jsonLines(await reader.read(e, maxMergeBytes))) {
          try {
            rows.push(JSON.parse(line));
          } catch {
            // broken line
          }
        }
        summary.usage.added = (summary.usage.added ?? 0) + ledger.importRows(rows);
      } else if (e.name === 'claude/history.jsonl') {
        if (keep.history && mergeable(e)) summary.history.added = await mergeHistory(e);
      } else if (OPENCODE_SESSION.test(e.name)) {
        if (!mergeable(e) || opencodeBytes + e.usize > maxMergeBytes) {
          warn(`Sesi OpenCode dilewati karena terlalu besar: ${e.name}`);
          continue;
        }
        const [, projectId, sessionId] = OPENCODE_SESSION.exec(e.name);
        const data = await reader.read(e, maxMergeBytes);
        try {
          const parsed = JSON.parse(data.toString('utf8'));
          if (parsed?.info?.id !== sessionId) throw new Error('id');
          opencodeBytes += data.length;
          opencodeSessions.push({ projectId, sessionId, data });
        } catch {
          warn(`Sesi OpenCode tidak valid: ${e.name}`);
        }
      } else if (parts[1] === 'projects') {
        if (only && !only.has(parts[2])) continue; // not selected in the import preview
        const target = parts.length >= 4 ? folders.get(parts[2]) : null;
        const rest = target ? [target.folder, ...parts.slice(3)] : parts.slice(2);
        const isSession = parts.length === 4 && SESSION_FILE.test(parts[3]);
        if (isSession && target) target.sessions++;
        const memory = Boolean(target) && parts[3] === 'memory' && preexisting.has(target.folder);
        await place(e, projectsDir, rest, { session: e.name.endsWith('.jsonl'), memory, counter: isSession ? summary.sessions : summary.files });
      } else {
        await place(e, path.join(claudeDir, parts[1]), parts.slice(2), { counter: summary.files });
      }
    }

    /** history.jsonl: unique lines of both files, by timestamp; project paths moved to this home. */
    async function mergeHistory(entry) {
      const dest = await safeTarget(claudeDir, ['history.jsonl']);
      let local = [];
      try {
        local = jsonLines(await fs.readFile(dest));
      } catch {
        // none yet
      }
      const seen = new Set(local.map((l) => l.trim()));
      const added = [];
      for (const raw of jsonLines(await reader.read(entry, maxMergeBytes))) {
        let line = raw;
        try {
          const obj = JSON.parse(raw);
          const mapped = remap.mapPath(obj?.project);
          if (typeof obj?.project === 'string' && mapped !== obj.project) line = JSON.stringify({ ...obj, project: mapped });
        } catch {
          // kept as is
        }
        if (seen.has(line.trim())) continue;
        seen.add(line.trim());
        added.push(line);
      }
      if (!added.length) return 0;
      // Lines without a timestamp keep the time of the line before them (they stay where they were).
      const keyed = (lines) => {
        let last = 0;
        return lines.map((line) => {
          let ts = null;
          try {
            const t = JSON.parse(line)?.timestamp;
            ts = typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : null;
          } catch {
            // no time
          }
          if (Number.isFinite(ts)) last = ts;
          return { line, ts: Number.isFinite(ts) ? ts : last };
        });
      };
      const all = [...keyed(local), ...keyed(added)].sort((a, b) => a.ts - b.ts); // stable: ties keep order
      const tmp = `${dest}.${process.pid}.import-tmp`;
      try {
        await fs.writeFile(tmp, `${all.map((x) => x.line).join('\n')}\n`);
        renameSync(tmp, dest);
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
      return added.length;
    }

    return {
      manifest,
      summary,
      state,
      chats,
      engineChats,
      opencodeSessions,
      remap,
      projects: [...folders.values()],
    };
  } finally {
    await reader.close();
  }
}
