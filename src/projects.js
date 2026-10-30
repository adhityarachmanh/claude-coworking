// Discovers project folders: ones Claude Code has opened (~/.claude.json) + subfolders of a projects root.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SKIP = new Set(['node_modules', 'backup']);

export function isDirectory(p) {
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
    const config = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    for (const dir of Object.keys(config.projects ?? {})) if (isDirectory(dir)) found.push([dir, 'claude']);
  } catch {
    // No Claude Code config yet.
  }
  for (const root of roots) {
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
