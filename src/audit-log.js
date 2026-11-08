// 📜 A small local audit trail for data actions (backup export/import, verification, purge). No content, no secrets.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_LINES = 500;

const fileOf = (dataDir) => path.join(dataDir, 'audit.log');

/** Appends one action (never throws: the action itself already succeeded or failed on its own). */
export function recordAudit(dataDir, { action, detail = '' } = {}) {
  if (!dataDir || !action) return;
  const line = JSON.stringify({ at: Date.now(), action: String(action).slice(0, 40), detail: String(detail).slice(0, 200) });
  try {
    appendFileSync(fileOf(dataDir), `${line}\n`);
    const lines = readFileSync(fileOf(dataDir), 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) writeFileSync(fileOf(dataDir), `${lines.slice(-MAX_LINES).join('\n')}\n`);
  } catch {
    // the log is a convenience; never fail the action for it
  }
}

/** Newest first, at most `limit` entries. */
export function readAudit(dataDir, limit = 20) {
  try {
    return readFileSync(fileOf(dataDir), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-Math.max(1, limit))
      .reverse()
      .map((line) => {
        try {
          const entry = JSON.parse(line);
          return entry && Number.isFinite(entry.at) && typeof entry.action === 'string' ? entry : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
