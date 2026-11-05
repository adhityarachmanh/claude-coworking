// ---------- audit of account changes (👤 Akun: the Claude account and OpenCode's provider logins) ----------
// One append-only line per action in data/auth-audit.jsonl (state.json stays small; the file is never rewritten):
//   { ts, action, engine, provider, actor, ok, detail }
// action: login-start / login-code / login-cancel / logout / oauth-start / oauth-complete / login-key / cancel.
// actor: 'laptop', or the name of the paired phone that did it. detail: a short reason, never a secret.
// A failed action is written too (ok: false), so the user can see a login that did not work.
// Never a token, an API key, an OAuth code or an email: the detail is scrubbed and cut, and a caller must not pass
// secrets in at all. A torn last line (a crash mid-append) is skipped when reading back, never a crash.
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

export const AUDIT_FILE = 'auth-audit.jsonl';
const AUDIT_LIMITS = Object.freeze({ limit: 100, detail: 200, actor: 80 });
const ACTIONS = /^[a-z][\w-]{0,39}$/; // what a handler may write (and what is accepted when reading back)
const PROVIDER = /^[\w.-]{1,100}$/;
const ENGINES = new Set(['claude', 'opencode']);
/** Only the tail is read: showing the last actions never means loading a file that grows forever. */
const READ_MAX_BYTES = 256 * 1024;

const CONTROL = /[\u0000-\u001f\u007f]+/g;
const EMAIL = /[^\s@<>()"']+@[^\s@<>()"']+\.[^\s@<>()"']{2,}/g;
// Key/OAuth-token shapes seen from the providers (sk-…, ghp_…, xoxb-…, a JWT) — belt and braces, callers pass none.
const SECRET = /\b(?:sk|pk|rk|ghp|gho|ghs|ghr|github_pat|xox[abposr]|eyJ)[-_A-Za-z0-9.]{8,}\b/g;

/** data/auth-audit.jsonl of this process (OFFICE_DATA_DIR wins, exactly like server.js DATA_DIR). */
const defaultDataDir = () => process.env.OFFICE_DATA_DIR ?? path.join(process.cwd(), 'data');

/**
 * One line of free text: no control characters, no email, no token-shaped secret, whitespace collapsed, cut to
 * `max`. null when nothing is left.
 */
function safeText(value, max = AUDIT_LIMITS.detail) {
  const text = String(value ?? '')
    .replace(CONTROL, ' ')
    .replace(EMAIL, '[email]')
    .replace(SECRET, '[rahasia]')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : null;
}

/**
 * One entry with only the known fields (validated): what recordAuth writes and what recentAuth trusts from disk.
 * @returns {object|null} null when the entry is not an auth action at all
 */
function cleanAuthEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const action = typeof raw.action === 'string' ? raw.action.trim() : '';
  const ts = Number(raw.ts);
  if (!ACTIONS.test(action) || !ENGINES.has(raw.engine) || !Number.isFinite(ts)) return null;
  return {
    ts,
    action,
    engine: raw.engine,
    provider: PROVIDER.test(String(raw.provider ?? '')) ? String(raw.provider) : null,
    actor: safeText(raw.actor, AUDIT_LIMITS.actor) ?? 'laptop',
    ok: raw.ok === true,
    detail: safeText(raw.detail, AUDIT_LIMITS.detail),
  };
}

/**
 * Appends one auth action to data/auth-audit.jsonl. Never throws: a locked or full disk must not break a login or
 * a logout (the failure is only logged). `ts` defaults to now.
 * @param {{ ts?: number, action: string, engine: 'claude'|'opencode', provider?: string|null,
 *           actor?: string, ok?: boolean, detail?: string|null }} entry
 * @param {{ dataDir?: string }} [options]
 * @returns {object|null} the entry as written (null when it was refused or could not be written)
 */
export function recordAuth(entry, { dataDir = defaultDataDir() } = {}) {
  const clean = cleanAuthEntry({ ts: Date.now(), ...entry });
  if (!clean) {
    console.error('Audit akun tidak valid (dilewati): aksi, mesin atau waktu tidak dikenal.');
    return null;
  }
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(path.join(dataDir, AUDIT_FILE), `${JSON.stringify(clean)}\n`);
    return clean;
  } catch (err) {
    console.error(`Menulis audit akun gagal: ${err.message}`);
    return null;
  }
}

/**
 * The last actions, newest first. A torn or hand-edited line is skipped, and a missing file is an empty list.
 * @param {number} [limit] 1–100 (default 50)
 * @param {{ dataDir?: string }} [options]
 */
export function recentAuth(limit = 50, { dataDir = defaultDataDir() } = {}) {
  const raw = Number(limit);
  const n = Number.isFinite(raw) ? Math.min(AUDIT_LIMITS.limit, Math.max(1, Math.trunc(raw))) : 50;
  let text;
  try {
    const file = path.join(dataDir, AUDIT_FILE);
    const size = statSync(file).size;
    const start = Math.max(0, size - READ_MAX_BYTES);
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(file, 'r');
    let read = 0;
    try {
      // A single readSync may come back short: fill the buffer before parsing it.
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, start + read);
        if (!n) break;
        read += n;
      }
    } finally {
      closeSync(fd);
    }
    text = buffer.subarray(0, read).toString('utf8');
  } catch {
    return []; // no audit yet (or unreadable right now)
  }
  const entries = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && entries.length < n; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = cleanAuthEntry(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      // a torn last line (the server died mid-append) or a hand edit: skipped, the rest still reads
    }
  }
  return entries;
}
