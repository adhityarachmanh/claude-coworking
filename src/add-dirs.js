// Folder tambahan: extra folders Claude Code may access outside the project (CLI `--add-dir`). Pure rules only.
// A stored path is absolute, resolves to a real folder, is never a network/UNC path, and the list is capped. The
// state.json copy is sanitized on read as well, so a hand-edited file can never put junk into spawn arguments.
import os from 'node:os';
import path from 'node:path';
import { isDirectory, isNetworkPath } from './projects.js';

export const ADD_DIR_LIMIT = 10;
export const ADD_DIR_MAX_LENGTH = 500;

export class AddDirError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** `~`, `~/x` and `~\x` become paths under `home`; anything else is trimmed and returned as it is. */
export function expandHome(value, home = os.homedir()) {
  const text = String(value ?? '').trim();
  if (text === '~') return home;
  if (/^~[\\/]/.test(text)) return path.join(home, text.slice(2));
  return text;
}

/** Windows paths are case-insensitive: two spellings of the same folder are one entry. */
const pathKey = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

/**
 * The stored list, cleaned: only absolute, non-network paths of a sane length survive, duplicates collapse, and
 * the cap applies. Malformed entries (a hand-edited state.json) are dropped rather than thrown.
 */
export function cleanAddDirs(list, { home = os.homedir() } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const value = expandHome(raw, home);
    if (!value || value.length > ADD_DIR_MAX_LENGTH) continue;
    if (isNetworkPath(value) || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    if (seen.has(pathKey(resolved))) continue;
    seen.add(pathKey(resolved));
    out.push(resolved);
    if (out.length >= ADD_DIR_LIMIT) break;
  }
  return out;
}

/** Adds one folder after validating it; throws AddDirError (400/409) with a message the UI shows as it is. */
export function addDirectory({ list, value, home = os.homedir(), exists = isDirectory } = {}) {
  const text = expandHome(value, home);
  if (!text) throw new AddDirError(400, 'Path folder tidak boleh kosong.');
  if (isNetworkPath(text)) throw new AddDirError(400, 'Folder jaringan (\\\\server\\share) tidak didukung. Pakai folder di laptop ini.');
  if (!path.isAbsolute(text)) throw new AddDirError(400, 'Path folder tambahan harus absolut (mis. C:\\kerja\\pustaka).');
  const resolved = path.resolve(text);
  if (resolved.length > ADD_DIR_MAX_LENGTH) throw new AddDirError(400, `Path folder maksimal ${ADD_DIR_MAX_LENGTH} karakter.`);
  if (!exists(resolved)) throw new AddDirError(400, 'Folder tidak ditemukan.');
  const current = cleanAddDirs(list, { home });
  if (current.some((dir) => pathKey(dir) === pathKey(resolved))) throw new AddDirError(409, 'Folder itu sudah ada di daftar.');
  if (current.length >= ADD_DIR_LIMIT) throw new AddDirError(400, `Maksimal ${ADD_DIR_LIMIT} folder tambahan.`);
  return [...current, resolved];
}

/** Removes one folder. The folder itself need not exist any more: a deleted folder must still be removable. */
export function removeDirectory({ list, value, home = os.homedir() } = {}) {
  const resolved = path.resolve(expandHome(value, home));
  const current = cleanAddDirs(list, { home });
  const next = current.filter((dir) => pathKey(dir) !== pathKey(resolved));
  if (next.length === current.length) throw new AddDirError(404, 'Folder itu tidak ada di daftar.');
  return next;
}

/** What the dialog shows: the stored path and whether the folder is still there. */
export function addDirViews(list, { exists = isDirectory } = {}) {
  return cleanAddDirs(list).map((dir) => ({ path: dir, exists: Boolean(exists(dir)) }));
}
