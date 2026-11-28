// 📜 Catatan rilis Adhitron: reads the CHANGELOG.md that ships beside the app (scripts/build-*.mjs copies it) and
// returns its sections. Read-only and cheap: no CLI, no model, no user data — only the version and the changelog.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseReleaseNotes } from '../release-notes.js';
import { json } from './http.js';

/** Folders that may hold the bundle (dev checkout, installed app, portable build), in order. */
function candidateDirs() {
  return [...new Set([process.env.OFFICE_APP_DIR, process.cwd(), path.dirname(process.execPath)].filter(Boolean))];
}

function changelogFile() {
  for (const dir of candidateDirs()) {
    const file = path.join(dir, 'CHANGELOG.md');
    if (existsSync(file)) return file;
  }
  return null;
}

function appVersion(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

export function register(router) {
  router.post('/api/release-notes', (ctx, req, res) => {
    const file = changelogFile();
    const missing = () => json(res, 404, { error: 'Catatan rilis tidak ditemukan di instalasi ini.' });
    if (!file) return missing();
    let markdown;
    try {
      markdown = readFileSync(file, 'utf8');
    } catch {
      return missing();
    }
    return json(res, 200, { version: appVersion(path.dirname(file)), sections: parseReleaseNotes(markdown) });
  }, { maxBody: 1024 });
}
