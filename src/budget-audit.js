// 💰 Audit of budget changes and one-shot overrides: data/budget-audit.jsonl, append-only.
// One line per action: { ts, action, scope, projectId, actor, ok, detail }. Never a secret; the detail is a short
// human label ("harian $20,00 · bulanan $100,00"). Best effort: a locked disk never blocks a budget save.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const BUDGET_AUDIT_FILE = 'budget-audit.jsonl';
const PRUNE_BYTES = 256 * 1024;
const PRUNE_DAYS = 180;
const PRUNE_MAX = 2000;
const ACTIONS = new Set(['save', 'override']);
const defaultDataDir = () => process.env.OFFICE_DATA_DIR ?? path.join(process.cwd(), 'data');

const text = (v, max = 200) => {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object' || !ACTIONS.has(raw.action) || !Number.isFinite(Number(raw.ts))) return null;
  return {
    ts: Number(raw.ts),
    action: raw.action,
    scope: raw.scope === 'project' ? 'project' : 'global',
    projectId: text(raw.projectId, 80),
    actor: text(raw.actor, 80) ?? 'laptop',
    ok: raw.ok !== false,
    detail: text(raw.detail, 300),
  };
}

function prune(file, now = Date.now()) {
  try {
    if (statSync(file).size < PRUNE_BYTES) return;
    const cutoff = now - PRUNE_DAYS * 24 * 60 * 60 * 1000;
    const kept = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((row) => row && Number(row.ts) >= cutoff)
      .slice(-PRUNE_MAX)
      .map((row) => JSON.stringify(row));
    writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '');
  } catch {
    // best effort: the file stays readable, only its size suffers
  }
}

/** The newest `limit` entries, newest first (an unreadable file is an empty list). */
export function recentBudget(limit = 20, { dataDir = defaultDataDir() } = {}) {
  const n = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 20;
  try {
    const file = path.join(dataDir, BUDGET_AUDIT_FILE);
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-n * 3)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((row) => row && ACTIONS.has(row.action) && Number.isFinite(row.ts))
      .slice(-n)
      .reverse();
  } catch {
    return [];
  }
}

export function recordBudget(entry, { dataDir = defaultDataDir(), now = Date.now() } = {}) {
  const clean = cleanEntry({ ts: now, ...entry });
  if (!clean) return null;
  try {
    mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, BUDGET_AUDIT_FILE);
    appendFileSync(file, `${JSON.stringify(clean)}\n`);
    prune(file, now);
    return clean;
  } catch (err) {
    console.error(`Menulis audit budget gagal: ${err.message}`);
    return null;
  }
}
