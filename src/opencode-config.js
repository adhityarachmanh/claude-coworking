// Read and write the user's own OpenCode config (opencode.json / opencode.jsonc): global and per project.
// Nothing here starts OpenCode. Writes are explicit, validated, atomic, and always leave a backup of the previous file.
// OpenCode 2.2.5 reads more than one file per scope (later wins per key), so `sources`/`conflict` tell the editor
// which other file would override what it writes; backups live in the app's data folder, never next to the config.
// Every write and delete is contained: no symlink or junction may point it outside the scope's root folder.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonc } from './opencode-bin.js';

export const OPENCODE_CONFIG_LIMITS = Object.freeze({ bytes: 512 * 1024, agents: 50, name: 64, description: 500, model: 200, prompt: 20_000 });
const AGENT_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
const AGENT_MODES = new Set(['primary', 'subagent', 'all']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const BACKUP_KEEP = 10; // newest backups kept per target
const BACKUP_MAX_AGE_DAYS = 90;
const LEGACY_SCAN = 20; // newest legacy `<file>.bak-*` files looked at, never more
const MOVED_KEEP = 5; // newest `dot--` manual-recovery copies kept per scope folder
const MOVE_PREFIX = 'dot--'; // a `.opencode` file moved by consolidation never shows up as this target's backup
const SAFE_FOLDER = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LOCK_STALE = 'File berubah di luar aplikasi. Muat ulang lalu simpan lagi.';
const LOCK_MISSING = 'Muat ulang config lalu coba lagi.';
const WIN = process.platform === 'win32';
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
export class OpenCodeConfigError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code; // a machine-readable reason for a 409 ('lock-missing', 'stale'); null everywhere else
  }
}

/** The `opencode` folder inside the user's config root (XDG, HOME, or the test override). */
export function openCodeConfigRoot(env = process.env) {
  const base = env.OFFICE_OPENCODE_CONFIG_HOME || env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'opencode');
}

const configRoot = (home) => openCodeConfigRoot(home ? { OFFICE_OPENCODE_CONFIG_HOME: home } : process.env);
const existing = (dir, names) => names.map((name) => path.join(dir, name)).find((file) => existsSync(file));
const formatOf = (file, text) => {
  if (path.extname(file) === '.jsonc') return 'jsonc';
  try {
    JSON.parse(text);
    return 'json';
  } catch {
    return 'jsonc'; // comments or trailing commas: still valid for OpenCode, but a form save loses them
  }
};

/** The file this scope edits. Project root wins over `.opencode/`; an existing file is never silently replaced. */
export function configFile({ scope, projectPath, home } = {}) {
  if (scope === 'global') {
    const dir = configRoot(home);
    const file = existing(dir, ['opencode.json', 'opencode.jsonc', 'config.json']) ?? path.join(dir, 'opencode.json');
    return { path: file, exists: existsSync(file), format: path.extname(file) === '.jsonc' ? 'jsonc' : 'json' };
  }
  if (scope !== 'project') throw new OpenCodeConfigError(400, 'Cakupan config harus global atau project.');
  if (typeof projectPath !== 'string' || !projectPath) throw new OpenCodeConfigError(400, 'Project tidak valid.');
  const root = projectPath;
  const file = existing(root, ['opencode.json', 'opencode.jsonc'])
    ?? existing(path.join(root, '.opencode'), ['opencode.json', 'opencode.jsonc'])
    ?? path.join(root, 'opencode.json');
  return { path: file, exists: existsSync(file), format: path.extname(file) === '.jsonc' ? 'jsonc' : 'json' };
}

// ---------- paths: every write/delete stays inside the scope's root ----------

/** The real path when it exists, else the resolved one (a missing file is fine: it is about to be created). */
const realOrSelf = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

/** `child` at or below `parent` (case-insensitive on Windows, where paths are). */
const isInside = (parent, child) => {
  const fix = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
  const base = fix(parent);
  const target = fix(child);
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
};

const samePath = (a, b) => isInside(a, b) && isInside(b, a);

/**
 * A write or delete must land inside its scope, with no symlink or junction on the way: every existing component from
 * the scope root down to the file is checked (a junction is a symlink on Windows), and the file's real parent must
 * still be inside the real root. So a junctioned `.opencode/` (or a symlinked file) cannot redirect a write elsewhere.
 * The root itself may be a junction: only what is below it is judged.
 */
function assertWritable(file, target = {}) {
  const { scope, projectPath, home } = target;
  if (scope !== 'global' && (typeof projectPath !== 'string' || !projectPath)) throw new OpenCodeConfigError(400, 'Project tidak valid.');
  const root = path.resolve(scope === 'global' ? configRoot(home) : projectPath);
  const resolved = path.resolve(String(file ?? ''));
  const label = scope === 'global' ? 'config OpenCode' : 'project';
  if (isInside(root, resolved) && !samePath(root, resolved)) {
    let current = root;
    for (const part of path.relative(root, resolved).split(path.sep)) {
      current = path.join(current, part);
      let stat;
      try {
        stat = lstatSync(current);
      } catch {
        break; // missing from here on: the rest will be created
      }
      if (stat.isSymbolicLink()) throw new OpenCodeConfigError(400, 'File atau folder config ini symlink/junction. Ubah file aslinya lewat editor lain.');
    }
    if (isInside(realOrSelf(root), realOrSelf(path.dirname(resolved)))) return;
  }
  throw new OpenCodeConfigError(400, `File config harus berada di dalam folder ${label}, tanpa symlink/junction.`);
}

// ---------- reading ----------

/** One file OpenCode may read: `valid` is false when it is missing or does not parse (never an error). */
const sourceOf = (file, kind, format) => {
  const source = { path: file, kind, exists: false, format, valid: false };
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return source; // missing: the normal case for a scope nobody configured yet
  }
  if (!stat.isFile()) return source;
  source.exists = true;
  if (stat.size > OPENCODE_CONFIG_LIMITS.bytes) return source; // too large for the editor to load as a config
  try {
    parseJsonc(readFileSync(file, 'utf8'));
    source.valid = true;
  } catch {
    source.valid = false; // a broken file is still listed: the JSON tab can fix it
  }
  return source;
};

/**
 * Every file OpenCode reads for a scope, in precedence order (verified with `opencode debug config`, 2.2.5):
 * global `~/.config/opencode/opencode.json`, then the project root, then the project's `.opencode/`. In one folder
 * only `opencode.json` is read when both `opencode.json` and `opencode.jsonc` exist. The global legacy `config.json`
 * is listed too (kind `legacy`): the app may still edit it, but OpenCode 2 does not read it.
 */
export function configSources({ scope, projectPath, home } = {}) {
  if (scope === 'global') {
    const dir = configRoot(home);
    return [
      sourceOf(path.join(dir, 'opencode.json'), 'global', 'json'),
      sourceOf(path.join(dir, 'opencode.jsonc'), 'global', 'jsonc'),
      sourceOf(path.join(dir, 'config.json'), 'legacy', 'json'),
    ];
  }
  if (scope !== 'project') throw new OpenCodeConfigError(400, 'Cakupan config harus global atau project.');
  if (typeof projectPath !== 'string' || !projectPath) throw new OpenCodeConfigError(400, 'Project tidak valid.');
  const dot = path.join(projectPath, '.opencode');
  return [
    sourceOf(path.join(projectPath, 'opencode.json'), 'project', 'json'),
    sourceOf(path.join(projectPath, 'opencode.jsonc'), 'project', 'jsonc'),
    sourceOf(path.join(dot, 'opencode.json'), 'dot-opencode', 'json'),
    sourceOf(path.join(dot, 'opencode.jsonc'), 'dot-opencode', 'jsonc'),
  ];
}

/** How a source is named in a user-facing sentence (short, recognisable). */
const sourceLabel = (source) => (source.kind === 'dot-opencode' ? `.opencode/${path.basename(source.path)}` : path.basename(source.path));

/** A `.jsonc` next to an `opencode.json` in the same folder is never read: OpenCode takes the `.json`. */
const shadowedByJson = (source, all) =>
  source.format === 'jsonc' && all.some((other) => other.format === 'json' && other.kind === source.kind && path.dirname(other.path) === path.dirname(source.path));

/**
 * null, or what a second existing file means for the file the editor writes: every source OpenCode reads, the last
 * one that wins per key, and a sentence the UI can show as it is. The legacy `config.json` is not counted.
 */
function conflictOf(sources, targetPath) {
  const present = sources.filter((source) => source.exists && source.kind !== 'legacy');
  if (present.length < 2) return null;
  const others = present.filter((source) => source.path !== targetPath).map((source) => source.path);
  if (!others.length) return null;
  const read = present.filter((source) => !shadowedByJson(source, present));
  const winner = read[read.length - 1] ?? present[present.length - 1];
  const sameFolder = read.length < present.length;
  const message = `OpenCode membaca config berikut secara berurutan: ${read.map(sourceLabel).join(', ')}. Nilai dari ${sourceLabel(winner)} yang menang per kunci.`
    + `${sameFolder ? ' Di folder yang sama hanya opencode.json yang dibaca, opencode.jsonc diabaikan.' : ''}`
    + ` Aplikasi ini hanya mengubah ${path.basename(targetPath)}.`;
  return { others, effective: winner.path, sameFolder, message };
}

const validateObject = (config, where = 'Config') => {
  if (!isObject(config)) throw new OpenCodeConfigError(400, `${where} harus berupa objek JSON.`);
  const visit = (value, depth) => {
    if (depth > 30) throw new OpenCodeConfigError(400, 'Config terlalu dalam.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new OpenCodeConfigError(400, `Kunci config tidak diizinkan: ${key}.`);
      visit(child, depth + 1);
    }
  };
  visit(config, 0);
  return config;
};

const parseConfig = (text) => {
  let config;
  try {
    config = parseJsonc(String(text ?? ''));
  } catch (err) {
    throw new OpenCodeConfigError(400, `Config bukan JSON/JSONC yang valid: ${err.message}`);
  }
  return validateObject(config);
};

const agentsView = (config) => {
  const agents = isObject(config.agent) ? config.agent : {};
  return Object.entries(agents)
    .filter(([, a]) => isObject(a))
    .map(([name, a]) => ({
      name,
      mode: AGENT_MODES.has(a.mode) ? a.mode : '',
      model: typeof a.model === 'string' ? a.model : '',
      description: typeof a.description === 'string' ? a.description : '',
      prompt: typeof a.system === 'string' ? a.system : typeof a.prompt === 'string' ? a.prompt : '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Whether consolidateProjectConfig would accept this scope right now: project scope, an existing `.opencode` config,
 * and at least two sources it would merge (a `.jsonc` shadowed by its sibling `.json` is not one of them).
 */
function consolidatableOf(scope, sources) {
  if (scope !== 'project') return false;
  const present = sources.filter((source) => source.exists);
  if (!present.some((source) => source.kind === 'dot-opencode')) return false;
  return present.filter((source) => !shadowedByJson(source, present)).length >= 2;
}

/**
 * One scope: the file the editor changes (`path`), its text/config/agents, `hash` of those bytes (the optimistic
 * lock of a save), every `sources` file OpenCode reads, `conflict` when another existing file would override it, and
 * `consolidatable` when merging the project's files would work now (never global).
 */
export function readOpenCodeConfig({ scope, projectPath, home } = {}) {
  const file = configFile({ scope, projectPath, home });
  let text = '';
  let config = {};
  let format = file.format;
  let parseError = null;
  let hash = null;
  if (file.exists) {
    const bytes = readFileSync(file.path); // the hash must be of the bytes on disk, not of a re-encoded string
    if (bytes.length > OPENCODE_CONFIG_LIMITS.bytes) throw new OpenCodeConfigError(413, 'Config OpenCode terlalu besar (maks 512 KB).');
    hash = createHash('sha256').update(bytes).digest('hex');
    text = bytes.toString('utf8');
    try {
      config = parseConfig(text);
    } catch (err) {
      if (!(err instanceof OpenCodeConfigError) || err.status !== 400) throw err;
      parseError = err.message; // keep the raw text so the JSON tab can fix a broken file
    }
    format = formatOf(file.path, text);
  }
  const sources = configSources({ scope, projectPath, home });
  return {
    scope,
    path: file.path,
    exists: file.exists,
    format,
    text,
    config,
    agents: agentsView(config),
    parseError,
    hash,
    sources,
    conflict: conflictOf(sources, file.path),
    consolidatable: consolidatableOf(scope, sources),
  };
}

// ---------- writes ----------

/** `dataDir/opencode-config-backups`: one folder per scope (`global`, or the project's id). */
export function backupRoot(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('dataDir is required for OpenCode config backups');
  return path.join(dataDir, 'opencode-config-backups');
}

/** A folder only the user can enter (0700); Windows ignores the mode, so it is best effort there. */
const ensurePrivateDir = (dir) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows: ACLs, not modes
  }
};

/** A file only the user can read (0600). */
const writePrivate = (file, data) => {
  writeFileSync(file, data, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: ACLs, not modes
  }
};

/**
 * Writes `data` next to `file` first and renames it over the target, so a crash or a full disk never leaves a half
 * written config. A new file is 0600; an existing one keeps its own mode. Any failure (write or rename) removes the
 * `.tmp-<random>` file again: nothing extra is ever left in the config folder.
 */
function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // new file: 0600
  }
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    try {
      chmodSync(tmp, mode);
    } catch {
      // Windows: ACLs, not modes
    }
    try {
      renameSync(tmp, file);
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      unlinkSync(file); // Windows will not replace a file another process holds open
      renameSync(tmp, file);
    }
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing of ours to clean up
    }
    throw err;
  }
}

// ---------- backups (in the app's data folder, never next to the config) ----------

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
const backupName = (base) => `${stamp()}-${randomBytes(2).toString('hex').slice(0, 3)}-${base}`;

/** A stable folder name that can never leave the backup root: safe ids as they are, anything else hashed. */
const folderId = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  // "global" is the global scope's own folder: a project id spelling it gets a hash instead
  return SAFE_FOLDER.test(raw) && raw !== 'global' ? raw : `x${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
};
const scopeFolder = (target) => {
  if (target?.scope === 'global') return 'global';
  const id = folderId(target?.projectId);
  if (id) return id;
  if (typeof target?.projectPath === 'string' && target.projectPath) return folderId(path.basename(target.projectPath)) ?? 'project';
  let dir = path.dirname(String(target?.path ?? ''));
  if (path.basename(dir) === '.opencode') dir = path.dirname(dir);
  return folderId(path.basename(dir)) ?? 'project';
};

/** The target's own folder inside the backup root (checked, so no id can escape it). */
const backupFolder = (target, dataDir) => {
  const root = path.resolve(backupRoot(dataDir));
  const dir = path.resolve(root, scopeFolder(target));
  if (!isInside(root, dir) || samePath(root, dir)) throw new Error('backup folder outside the backup root');
  return dir;
};

/** The backup root and the target's folder, both private (0700), before anything is written into them. */
const ensureBackupDir = (target, dataDir) => {
  ensurePrivateDir(path.resolve(backupRoot(dataDir)));
  const dir = backupFolder(target, dataDir);
  ensurePrivateDir(dir);
  return dir;
};

/** The file a backup target edits: the caller may pass only { scope, projectPath }, or an explicit path. */
const targetPathOf = (target) => (typeof target?.path === 'string' && target.path ? target.path : configFile(target).path);

/** Copies `file` into the target's backup folder, byte for byte; null when there is no such file. */
function backupOne(target, dataDir, file = targetPathOf(target)) {
  if (!existsSync(file)) return null;
  const dir = ensureBackupDir(target, dataDir);
  const base = path.basename(file);
  let name = backupName(base);
  for (let i = 0; i < 4 && existsSync(path.join(dir, name)); i++) name = backupName(base); // same second, same random
  const dest = path.join(dir, name);
  const bytes = readFileSync(file);
  writePrivate(dest, bytes);
  return { id: name, path: dest, at: new Date().toISOString(), bytes: bytes.length };
}

/** A copy of the target's current file (the undo point of every write), or null when there is no file yet. */
export function writeBackup(target, dataDir) {
  return backupOne(target, dataDir);
}

/**
 * Moves one `.opencode` file into the backup folder (`dot--` prefix: it is a manual recovery copy, never one of the
 * root's restorable backups). A rename is atomic; another volume falls back to copy and only then unlink.
 */
function moveToBackups(target, dataDir, file) {
  if (!existsSync(file)) return null;
  const dir = ensureBackupDir(target, dataDir);
  const base = path.basename(file);
  let name = `${MOVE_PREFIX}${backupName(base)}`;
  for (let i = 0; i < 4 && existsSync(path.join(dir, name)); i++) name = `${MOVE_PREFIX}${backupName(base)}`;
  const dest = path.join(dir, name);
  try {
    renameSync(file, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err; // another volume: copy first, unlink only once the copy is there
    const bytes = readFileSync(file);
    writePrivate(dest, bytes);
    try {
      unlinkSync(file);
    } catch (unlinkErr) {
      try {
        unlinkSync(dest);
      } catch {
        // the original is still in place, which is what matters
      }
      throw unlinkErr;
    }
  }
  const stat = statSync(dest);
  return { id: name, path: dest, at: new Date(stat.mtimeMs).toISOString(), bytes: stat.size };
}

const readDirSafe = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** One backup file on disk: stat only (no read), so listing a folder never loads the files themselves. */
function statBackup(full, id, legacy, targetFile) {
  let stat;
  try {
    stat = lstatSync(full); // lstat: a symlink planted in the backup folder is not a backup
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return {
    id,
    name: path.basename(full),
    path: full,
    legacy,
    at: new Date(stat.mtimeMs).toISOString(),
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    valid: false,
    format: path.extname(targetFile) === '.jsonc' ? 'jsonc' : 'json',
  };
}

const byNewest = (a, b) => b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id);

/** The app's own backups of one target (`dot--` copies belong to consolidation, not to this history). */
function scanOwn(target, dataDir) {
  const file = targetPathOf(target);
  const base = path.basename(file);
  const dir = backupFolder(target, dataDir);
  const entries = [];
  for (const found of readDirSafe(dir)) {
    if (!found.isFile() || !found.name.endsWith(`-${base}`) || found.name.startsWith(MOVE_PREFIX)) continue;
    const entry = statBackup(path.join(dir, found.name), found.name, false, file);
    if (entry) entries.push(entry);
  }
  return entries.sort(byNewest);
}

/** The newest legacy `<file>.bak-*` files still next to the config: stat only, never more than LEGACY_SCAN. */
function scanLegacy(target) {
  const file = targetPathOf(target);
  const base = path.basename(file);
  const dir = path.dirname(file);
  const entries = [];
  for (const found of readDirSafe(dir)) {
    if (!found.isFile() || !found.name.startsWith(`${base}.bak-`)) continue; // never the config file itself
    const entry = statBackup(path.join(dir, found.name), `legacy:${found.name}`, true, file);
    if (entry) entries.push(entry);
  }
  return entries.sort(byNewest).slice(0, LEGACY_SCAN);
}

/**
 * Whether a listed backup can be restored: size first, then the same strict parser a save uses (an object, no
 * prototype keys, sane depth), so a crafted backup is listed invalid and can never be written back.
 */
function fillValidity(entry, targetFile) {
  if (entry.bytes > OPENCODE_CONFIG_LIMITS.bytes) return entry; // too big to check (and to restore)
  try {
    const text = readFileSync(entry.path, 'utf8');
    parseConfig(text);
    entry.valid = true;
    entry.format = formatOf(targetFile, text);
  } catch {
    entry.valid = false;
  }
  return entry;
}

/** Manual-recovery copies (`dot--…`) have their own budget: newest 5 per scope folder, none older than 90 days. */
function pruneMoved(dir, targetFile) {
  const entries = readDirSafe(dir)
    .filter((found) => found.isFile() && found.name.startsWith(MOVE_PREFIX))
    .map((found) => statBackup(path.join(dir, found.name), found.name, false, targetFile))
    .filter(Boolean)
    .sort(byNewest);
  const cutoff = Date.now() - BACKUP_MAX_AGE_DAYS * 86_400_000;
  for (const [index, entry] of entries.entries()) {
    if (index < MOVED_KEEP && (index === 0 || entry.mtimeMs >= cutoff)) continue; // the newest always stays
    try {
      unlinkSync(entry.path); // only inside the backup folder
    } catch {
      // best effort: a stale copy only costs a few KB
    }
  }
}

const backupView = ({ mtimeMs, path: _path, ...view }) => view;

/**
 * The target's backups, newest first: id, name, at, bytes, valid, format, legacy. Prunes only inside the app's own
 * folder (never a file next to the config): the target's history to `keep` newest and `maxAgeDays`, and the `dot--`
 * recovery copies to 5 newest / 90 days. The config file is never touched.
 */
export function listBackups(target, dataDir, { keep = BACKUP_KEEP, maxAgeDays = BACKUP_MAX_AGE_DAYS } = {}) {
  const file = targetPathOf(target);
  const where = { ...target, path: file };
  const own = scanOwn(where, dataDir);
  const legacy = scanLegacy(where);
  pruneMoved(backupFolder(where, dataDir), file);
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const doomed = own.filter((entry, index) => index >= keep || (index > 0 && entry.mtimeMs < cutoff)); // the newest always stays
  for (const entry of doomed) {
    try {
      unlinkSync(entry.path); // only a file inside the backup folder is ever deleted
    } catch {
      // best effort: a stale backup only costs a few KB
    }
  }
  const removed = new Set(doomed.map((entry) => entry.path));
  return [...own.filter((entry) => !removed.has(entry.path)), ...legacy]
    .sort(byNewest)
    .map((entry) => backupView(fillValidity(entry, file)));
}

/** Only an id this target's own list shows is accepted: no separators, no traversal, no other target's file. */
const findBackup = (target, dataDir, id) => {
  if (typeof id !== 'string' || !id || id.length > 300 || /[\\/]/.test(id) || id.includes('..')) return null;
  const file = targetPathOf(target);
  const where = { ...target, path: file };
  const entry = scanOwn(where, dataDir).find((item) => item.id === id) ?? scanLegacy(where).find((item) => item.id === id);
  return entry ? fillValidity(entry, file) : null;
};

/** One backup's text, for a preview (and to decide whether it can be restored at all). */
export function readBackup(target, dataDir, id) {
  const entry = findBackup(target, dataDir, id);
  if (!entry) throw new OpenCodeConfigError(404, 'Cadangan tidak ditemukan.');
  if (entry.bytes > OPENCODE_CONFIG_LIMITS.bytes) throw new OpenCodeConfigError(413, 'Cadangan terlalu besar (maks 512 KB).');
  let text;
  try {
    text = readFileSync(entry.path, 'utf8');
  } catch {
    throw new OpenCodeConfigError(404, 'Cadangan tidak ditemukan.');
  }
  return { id: entry.id, at: entry.at, bytes: entry.bytes, valid: entry.valid, format: entry.format, text };
}

/**
 * The editor's optimistic lock. Mandatory: no `baseHash` means the caller did not read the file first (409);
 * `null` is only right for a file that does not exist yet; anything else must equal the hash on disk now.
 */
function assertBaseHash(baseHash, currentHash) {
  if (baseHash === undefined) throw new OpenCodeConfigError(409, LOCK_MISSING, 'lock-missing');
  if (baseHash === null) {
    if (currentHash === null) return;
    throw new OpenCodeConfigError(409, LOCK_STALE, 'stale');
  }
  if (typeof baseHash !== 'string' || !baseHash || baseHash !== currentHash) throw new OpenCodeConfigError(409, LOCK_STALE, 'stale');
}

/** Puts one backup back, byte for byte (comments included). The current file is backed up first as the undo point. */
export function restoreBackup(target, dataDir, id, { baseHash } = {}) {
  const file = targetPathOf(target);
  assertWritable(file, target);
  const view = readOpenCodeConfig({ scope: target.scope, projectPath: target.projectPath, home: target.home });
  assertBaseHash(baseHash, view.hash);
  const where = { ...target, path: file };
  const entry = findBackup(where, dataDir, id);
  if (!entry) throw new OpenCodeConfigError(404, 'Cadangan tidak ditemukan.');
  if (!entry.valid) throw new OpenCodeConfigError(400, 'Cadangan ini bukan JSON/JSONC yang valid, jadi tidak bisa dipulihkan.');
  let bytes;
  try {
    bytes = readFileSync(entry.path);
  } catch {
    throw new OpenCodeConfigError(404, 'Cadangan tidak ditemukan.'); // pruned between the listing and the read
  }
  const backup = writeBackup(where, dataDir);
  writeFileAtomic(file, bytes);
  return { ...readOpenCodeConfig({ scope: target.scope, projectPath: target.projectPath, home: target.home }), restored: true, backup: backup?.path ?? null };
}

/** The form's model/small-model/agents merged into the existing config; unknown keys stay untouched. */
export function mergeForm(base, form = {}) {
  const config = validateObject(JSON.parse(JSON.stringify(isObject(base) ? base : {})));
  if (!isObject(form)) throw new OpenCodeConfigError(400, 'Form config tidak valid.');
  for (const [key, field] of [['model', 'model'], ['small_model', 'smallModel']]) {
    const value = form[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new OpenCodeConfigError(400, `${field} harus berupa teks.`);
    const clean = value.trim();
    if (!clean) delete config[key];
    else if (clean.length > OPENCODE_CONFIG_LIMITS.model) throw new OpenCodeConfigError(400, `${field} maksimal ${OPENCODE_CONFIG_LIMITS.model} karakter.`);
    else config[key] = clean;
  }
  if (form.agents === undefined) return config;
  if (!Array.isArray(form.agents)) throw new OpenCodeConfigError(400, 'Daftar agent tidak valid.');
  if (form.agents.length > OPENCODE_CONFIG_LIMITS.agents) throw new OpenCodeConfigError(400, `Maksimal ${OPENCODE_CONFIG_LIMITS.agents} agent.`);
  if (config.agent !== undefined && !isObject(config.agent)) throw new OpenCodeConfigError(400, 'Bagian "agent" bukan objek. Perbaiki lewat tab JSON dulu.');
  const old = isObject(config.agent) ? config.agent : {};
  for (const [name, agent] of Object.entries(old)) {
    if (!isObject(agent)) throw new OpenCodeConfigError(400, `Agent "${name}" bukan objek. Perbaiki lewat tab JSON dulu.`);
  }
  const next = {};
  const seen = new Set();
  for (const item of form.agents) {
    if (!isObject(item)) throw new OpenCodeConfigError(400, 'Data agent tidak valid.');
    const name = String(item.name ?? '').trim();
    if (!AGENT_NAME.test(name)) throw new OpenCodeConfigError(400, 'Nama agent tidak valid (huruf/angka, -, _, titik; maks 64).');
    if (seen.has(name)) throw new OpenCodeConfigError(400, `Nama agent ganda: ${name}.`);
    seen.add(name);
    const agent = isObject(old[name]) ? old[name] : {};
    for (const [key, field, max] of [['description', 'description', OPENCODE_CONFIG_LIMITS.description], ['model', 'model', OPENCODE_CONFIG_LIMITS.model], ['mode', 'mode', 20]]) {
      const value = item[field];
      if (value === undefined) continue;
      if (typeof value !== 'string') throw new OpenCodeConfigError(400, `${field} agent ${name} harus berupa teks.`);
      const clean = value.trim();
      if (!clean) delete agent[key];
      else if (key === 'mode' && !AGENT_MODES.has(clean)) throw new OpenCodeConfigError(400, `Mode agent ${name} tidak dikenal.`);
      else if (clean.length > max) throw new OpenCodeConfigError(400, `${field} agent ${name} terlalu panjang.`);
      else agent[key] = clean;
    }
    if (item.prompt !== undefined) {
      if (typeof item.prompt !== 'string') throw new OpenCodeConfigError(400, `prompt agent ${name} harus berupa teks.`);
      const prompt = item.prompt.trim();
      const key = Object.hasOwn(agent, 'system') ? 'system' : Object.hasOwn(agent, 'prompt') ? 'prompt' : 'system';
      if (!prompt) delete agent[key];
      else if (prompt.length > OPENCODE_CONFIG_LIMITS.prompt) throw new OpenCodeConfigError(400, `Prompt agent ${name} maksimal ${OPENCODE_CONFIG_LIMITS.prompt} karakter.`);
      else agent[key] = prompt;
    }
    next[name] = agent;
  }
  if (Object.keys(next).length) config.agent = next;
  else delete config.agent;
  return validateObject(config);
}

// ---------- custom providers (OpenAI-compatible, 👤 Akun → OpenCode) ----------

/** The package field this feature's blocks carry; an overwrite is only allowed on our own blocks (or no package). */
export const CUSTOM_PROVIDER_PACKAGE = '@opencode/ai/providers/openai-compatible';
const PROVIDER_ID = /^[A-Za-z0-9][\w.-]{0,63}$/;

/**
 * Writes one custom OpenAI-compatible provider into the global config: `providers.<id>` with OpenCode's
 * openai-compatible package, the base URL and models, and the env var name the API key is expected under. The key
 * itself is never written here — it goes to OpenCode's credential store. Everything else in the config is kept as
 * it is, a previous file is backed up first, and an existing block of the same id is replaced whole (never merged).
 * @param {{ id: string, name: string, baseURL: string, models: string[], home?: string, dataDir?: string }} input
 * @returns {{ ok: true, path: string, backup: string|null }}
 */
export function addCustomProvider({ id, name, baseURL, models, home, dataDir } = {}) {
  if (!PROVIDER_ID.test(String(id ?? ''))) throw new OpenCodeConfigError(400, 'ID provider tidak valid.');
  const current = readOpenCodeConfig({ scope: 'global', home });
  if (current.parseError) throw new OpenCodeConfigError(400, 'Config OpenCode global tidak valid. Perbaiki lewat ⚙ → Config OpenCode dulu.');
  const config = validateObject(JSON.parse(JSON.stringify(isObject(current.config) ? current.config : {})));
  const env = `${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  const block = {
    name,
    package: CUSTOM_PROVIDER_PACKAGE,
    settings: { baseURL },
    models: Object.fromEntries(models.map((model) => [model, {}])),
    env: [env],
  };
  config.providers = { ...(isObject(config.providers) ? config.providers : {}), [id]: block };
  assertWritable(current.path, { scope: 'global', home });
  const backup = writeBackup({ scope: 'global', path: current.path }, dataDir);
  writeFileAtomic(current.path, `${JSON.stringify(config, null, 2)}\n`);
  return { ok: true, path: current.path, backup: backup?.path ?? null };
}

/**
 * Removes one custom OpenAI-compatible provider block from the global config: only a block this feature wrote (its
 * own package, or one without a package field) — a block another feature wrote is refused with a 409. Everything
 * else is kept as it is, the previous file is backed up first, and `providers` itself is deleted when the removal
 * leaves it empty (a clean config carries no empty object).
 * @param {{ id: string, home?: string, dataDir?: string }} input
 * @returns {{ ok: true, path: string, backup: string|null }}
 */
export function removeCustomProvider({ id, home, dataDir } = {}) {
  if (!PROVIDER_ID.test(String(id ?? ''))) throw new OpenCodeConfigError(400, 'ID provider tidak valid.');
  const current = readOpenCodeConfig({ scope: 'global', home });
  if (current.parseError) throw new OpenCodeConfigError(400, 'Config OpenCode global tidak valid. Perbaiki lewat ⚙ → Config OpenCode dulu.');
  const providers = isObject(current.config) && isObject(current.config.providers) ? current.config.providers : null;
  if (!providers || !Object.hasOwn(providers, id)) {
    throw new OpenCodeConfigError(404, `Provider kustom "${id}" tidak ditemukan di config OpenCode.`);
  }
  const pkg = isObject(providers[id]) ? providers[id].package : undefined;
  if (typeof pkg === 'string' && pkg !== CUSTOM_PROVIDER_PACKAGE) {
    throw new OpenCodeConfigError(409, `ID "${id}" bukan provider kustom yang dibuat aplikasi (package ${pkg}). Hapus lewat ⚙ → Config OpenCode.`);
  }
  const config = validateObject(JSON.parse(JSON.stringify(isObject(current.config) ? current.config : {})));
  delete config.providers[id];
  if (!Object.keys(config.providers).length) delete config.providers;
  assertWritable(current.path, { scope: 'global', home });
  const backup = writeBackup({ scope: 'global', path: current.path }, dataDir);
  writeFileAtomic(current.path, `${JSON.stringify(config, null, 2)}\n`);
  return { ok: true, path: current.path, backup: backup?.path ?? null };
}

/**
 * Save one scope. `mode: 'json'` writes the typed text (comments in JSONC stay); `mode: 'form'` merges the form.
 * The old file is copied into the app's backup folder first and the new one is written atomically; an invalid
 * request changes nothing. `baseHash` is the `hash` the editor read (mandatory): when it no longer matches, somebody
 * else changed the file and the save is refused (409).
 */
export function saveOpenCodeConfig({ scope, projectPath, projectId, home, dataDir, mode = 'form', text, form, baseHash } = {}) {
  const current = readOpenCodeConfig({ scope, projectPath, home });
  assertWritable(current.path, { scope, projectPath, home });
  assertBaseHash(baseHash, current.hash);
  let config;
  let output;
  if (mode === 'json') {
    if (typeof text !== 'string' || !text.trim()) throw new OpenCodeConfigError(400, 'Isi config masih kosong.');
    if (Buffer.byteLength(text) > OPENCODE_CONFIG_LIMITS.bytes) throw new OpenCodeConfigError(413, 'Config OpenCode terlalu besar (maks 512 KB).');
    config = parseConfig(text);
    output = text;
  } else if (mode === 'form') {
    if (current.parseError) throw new OpenCodeConfigError(400, 'Config saat ini tidak valid. Perbaiki lewat tab JSON dulu.');
    config = mergeForm(current.config, form);
    output = `${JSON.stringify(config, null, 2)}\n`;
  } else throw new OpenCodeConfigError(400, 'Mode simpan tidak dikenal.');
  const backup = writeBackup({ scope, projectPath, projectId, path: current.path }, dataDir);
  writeFileAtomic(current.path, output);
  return { ...readOpenCodeConfig({ scope, projectPath, home }), backup: backup?.path ?? null };
}

/** Deep merge: objects recursively, arrays and scalars replaced by the later file. */
const mergeDeep = (first, later) => {
  if (!isObject(first) || !isObject(later)) return later;
  const merged = { ...first };
  for (const [key, value] of Object.entries(later)) merged[key] = Object.hasOwn(first, key) ? mergeDeep(first[key], value) : value;
  return merged;
};

/**
 * Folds the project's `.opencode/` config into the root file: deep merge (`.opencode` wins per key), the merged root
 * written atomically FIRST, then every `.opencode` config file moved into the backup folder. A failed move therefore
 * leaves the merged root and the original `.opencode` file both in place, which is the same effective config; the
 * error is reported, the root is not rolled back. Refused when only one source exists, when one of them does not
 * parse, or when any of them resolves outside the project (symlink/junction).
 * The moved copies are named `dot--…`: they stay for manual recovery, not as a restorable backup of the root file.
 */
export function consolidateProjectConfig({ projectPath, projectId, home, dataDir, baseHash } = {}) {
  if (typeof projectPath !== 'string' || !projectPath) throw new OpenCodeConfigError(400, 'Project tidak valid.');
  const target = readOpenCodeConfig({ scope: 'project', projectPath, home });
  const scope = { scope: 'project', projectPath, home };
  assertWritable(target.path, scope);
  assertBaseHash(baseHash, target.hash);
  const sources = configSources({ scope: 'project', projectPath, home }).filter((source) => source.exists);
  const read = sources.filter((source) => !shadowedByJson(source, sources));
  if (read.length < 2) throw new OpenCodeConfigError(400, 'Hanya ada satu file config project, jadi tidak ada yang perlu digabung.');
  for (const source of sources) assertWritable(source.path, scope); // read and consumed: never through a junction
  for (const source of read) {
    if (!source.valid) throw new OpenCodeConfigError(400, `File ${sourceLabel(source)} bukan JSON/JSONC yang valid. Perbaiki dulu sebelum menggabungkan.`);
  }
  let merged = {};
  for (const source of read) merged = mergeDeep(merged, parseConfig(readFileSync(source.path, 'utf8')));
  const rootFile = read.find((source) => source.kind === 'project')?.path ?? target.path;
  assertWritable(rootFile, scope);
  // Every `.opencode` file is moved (also one shadowed by its sibling .json), or it would apply again afterwards.
  const dotFiles = sources.filter((source) => source.kind === 'dot-opencode').map((source) => source.path);
  const backupTarget = { scope: 'project', projectPath, projectId, path: rootFile };
  writeBackup(backupTarget, dataDir); // the root file as it was
  writeFileAtomic(rootFile, `${JSON.stringify(merged, null, 2)}\n`); // first: the merged values are on disk
  const moved = [];
  const failed = [];
  for (const file of dotFiles) {
    try {
      moved.push(moveToBackups(backupTarget, dataDir, file));
    } catch {
      failed.push(path.basename(file)); // the root already holds these values: nothing to roll back
    }
  }
  if (failed.length) {
    throw new OpenCodeConfigError(500, `Config sudah digabung ke ${path.basename(rootFile)}, tetapi ${failed.join(', ')} tidak bisa dipindah ke folder backup. Pindahkan file itu manual.`);
  }
  const movedBackups = moved.filter(Boolean).map((entry) => entry.path);
  return {
    ...readOpenCodeConfig({ scope: 'project', projectPath, home }),
    consolidated: true,
    movedBackup: movedBackups[0] ?? null,
    movedBackups,
  };
}
