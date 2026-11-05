// Discovers project folders: ones Claude Code has opened (~/.claude.json) + subfolders of a projects root.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SKIP = new Set(['node_modules', 'backup']);

/**
 * UNC and device paths (\\server\share, //server/share, \\?\…, \\.\…, NT \??\…). Merely stat-ing one makes
 * Windows connect over SMB and hand the server the user's NTLM hash, so they are refused before any fs call.
 */
export const isNetworkPath = (p) => /^([\\/]{2}|\\\?\?\\)/.test(String(p ?? '').trim());

export function isDirectory(p) {
  if (isNetworkPath(p)) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folder is really gone (ENOENT/ENOTDIR), not merely unreadable. A permission error, a busy drive or a network
 * timeout must not count as "missing": the purge action would throw the project's data away while the folder is
 * still there. Network paths are never probed (an SMB stat can leak an NTLM hash).
 */
export function isMissing(p) {
  if (!p || isNetworkPath(p)) return false;
  try {
    statSync(p);
    return false;
  } catch (err) {
    return err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
  }
}

/**
 * Is `dir` a strict subfolder of one of `roots`? Windows compares case-insensitively (path.relative does), and the
 * root itself is not "inside" itself. Used to keep the project list inside the folders the user chose.
 */
export function isInside(dir, roots = []) {
  if (!dir) return false;
  const target = path.resolve(dir);
  return roots.some((root) => {
    if (!root) return false;
    const rel = path.relative(path.resolve(root), target);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/**
 * Every subfolder of each root, plus folders Claude Code has opened **that live under those roots** (or under an
 * explicitly added folder, `extra`). A temp folder opened once by Claude Code must never join the project list.
 */
export function discoverProjects({ roots, extra = [] }) {
  const allowed = [...roots, ...extra].filter(Boolean);
  const found = [];
  try {
    const config = JSON.parse(readFileSync(process.env.CLAUDE_CONFIG_FILE ?? path.join(os.homedir(), '.claude.json'), 'utf8'));
    for (const dir of Object.keys(config.projects ?? {})) if (isDirectory(dir) && (isInside(dir, allowed) || allowed.some((r) => path.resolve(r) === path.resolve(dir)))) found.push([dir, 'claude']);
  } catch {
    // No Claude Code config yet.
  }
  for (const root of roots) {
    if (isNetworkPath(root)) continue;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) found.push([path.join(root, entry.name), 'folder']);
      }
    } catch {
      // Root not readable.
    }
  }
  return found;
}
