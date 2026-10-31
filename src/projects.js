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

/** Every subfolder of each root, plus every folder Claude Code has opened on this device. */
export function discoverProjects({ roots }) {
  const found = [];
  try {
    const config = JSON.parse(readFileSync(process.env.CLAUDE_CONFIG_FILE ?? path.join(os.homedir(), '.claude.json'), 'utf8'));
    for (const dir of Object.keys(config.projects ?? {})) if (isDirectory(dir)) found.push([dir, 'claude']);
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
