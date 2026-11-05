// Token usage ledger (data/usage.jsonl). Every record carries the account that was logged in
// when the tokens were spent, so reports for different accounts never mix.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class UsageLedger {
  constructor({ file, account, maxBytes = 8 * 1024 * 1024, archiveDir }) {
    this.file = file;
    this.account = account; // () => { id, email, org } | null
    this.maxBytes = maxBytes; // rotate the active file once it grows past this (kept reports fast to read)
    this.archiveDir = archiveDir ?? path.join(path.dirname(file), 'usage-archive');
    this.cache = { sig: '', rows: [] }; // parsed rows, rebuilt when a file changes
    mkdirSync(path.dirname(file), { recursive: true });
  }

  /**
   * @param {{ engine?: 'claude'|'opencode', source: 'web'|'cli', project: {id,name}, sessionId?: string,
   *           model: string, input: number, output: number, cacheRead: number, cacheWrite: number,
   *           costUsd?: number|null, requests?: number, turns?: number,
   *           account?: {id,email,org}|null }} entry  account defaults to whoever is logged in now
   */
  record(entry) {
    const account = entry.account ?? this.account(); // web sessions pass the account they started with
    if (!account) return; // logged out: nothing can be attributed
    const total = (entry.input ?? 0) + (entry.output ?? 0) + (entry.cacheRead ?? 0) + (entry.cacheWrite ?? 0);
    if (!total) return;
    const row = {
      ts: Date.now(),
      account,
      engine: engineOf({ engine: entry.engine, account }), // an explicit engine wins; else the account tells
      source: entry.source,
      project: entry.project?.name ?? null,
      projectId: entry.project?.id ?? null,
      sessionId: entry.sessionId ?? null,
      model: entry.model || 'unknown',
      input: entry.input ?? 0,
      output: entry.output ?? 0,
      cacheRead: entry.cacheRead ?? 0,
      cacheWrite: entry.cacheWrite ?? 0,
      costUsd: typeof entry.costUsd === 'number' ? entry.costUsd : null,
      requests: entry.requests ?? 0,
      turns: entry.turns ?? 0,
    };
    appendFileSync(this.file, `${JSON.stringify(row)}\n`);
    this.cache.sig = '';
    this.maybeRotate();
  }

  /** Archive files first, then the active file: names carry a timestamp, so sorting is chronological. */
  files() {
    const out = [];
    try {
      for (const name of readdirSync(this.archiveDir)) if (/^usage-[\w-]+\.jsonl$/.test(name)) out.push(path.join(this.archiveDir, name));
    } catch {
      // no archive yet
    }
    out.sort();
    if (existsSync(this.file)) out.push(this.file);
    return out;
  }

  signature(files) {
    return files.map((file) => {
      const st = statSync(file);
      return `${path.basename(file)}:${st.size}:${st.mtimeMs}`;
    }).join('|');
  }

  /**
   * Moves the active file into data/usage-archive/ when it passes maxBytes and starts a fresh one. Reports read every
   * archive, so nothing is lost; the active file stays small for the common case. A failure is harmless (it is tried
   * again on the next record).
   */
  maybeRotate() {
    try {
      if (statSync(this.file).size < this.maxBytes) return false;
      mkdirSync(this.archiveDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
      let dest = path.join(this.archiveDir, `usage-${stamp}.jsonl`);
      for (let i = 2; existsSync(dest); i++) dest = path.join(this.archiveDir, `usage-${stamp}-${i}.jsonl`);
      renameSync(this.file, dest);
      writeFileSync(this.file, '');
      this.cache.sig = '';
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Adds rows from a restored backup, skipping malformed rows and ones already on record (same time,
   * account, session, model and token counts). Every query reads the file, so they count at once.
   * @returns {number} rows added
   */
  importRows(rows) {
    const key = (r) => [r.ts, r.account.id, r.source, r.projectId, r.sessionId, r.model, r.input, r.output, r.cacheRead, r.cacheWrite, r.requests, r.turns].join('|');
    const seen = new Set(this.rows().filter(validRow).map(key));
    const fresh = [];
    for (const r of rows) {
      if (!validRow(r) || seen.has(key(r))) continue;
      seen.add(key(r));
      fresh.push(r);
    }
    if (fresh.length) {
      appendFileSync(this.file, fresh.map((r) => `${JSON.stringify(r)}\n`).join(''));
      this.cache.sig = '';
      this.maybeRotate();
    }
    return fresh.length;
  }

  rows() {
    const files = this.files();
    let sig = '';
    try {
      sig = this.signature(files);
    } catch {
      // a file vanished while listing: read what is there (no cache)
    }
    if (sig && sig === this.cache.sig) return this.cache.rows;
    const rows = [];
    for (const file of files) {
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line) continue;
          try {
            rows.push(JSON.parse(line));
          } catch {
            // a torn line (a crash mid-append): skipped, never a crash
          }
        }
      } catch {
        // unreadable right now: the other files still count
      }
    }
    rows.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    this.cache = { sig, rows };
    return rows;
  }

  /** Accounts that have usage on record (for the report's account picker). */
  accounts() {
    const seen = new Map();
    for (const r of this.rows()) {
      const a = seen.get(r.account.id) ?? { ...r.account, first: r.ts, last: r.ts, tokens: 0 };
      a.last = Math.max(a.last, r.ts);
      a.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
      seen.set(r.account.id, a);
    }
    return [...seen.values()].sort((a, b) => b.last - a.last);
  }

  /**
   * Rows of one account in [from, to]. The explicit `'all'` means every account (the combined report, so one PDF
   * can show Claude and OpenCode side by side); a missing id stays strict (no rows), so a caller that forgets it can
   * never sum every account by accident.
   */
  /** Deletes every ledger row of one project (a purged folder), from the active file and the archives. Backed up first. */
  removeProject(projectId) {
    let removed = 0;
    for (const file of this.files()) {
      let lines;
      try {
        lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      } catch {
        continue;
      }
      const keep = lines.filter((line) => {
        try {
          return JSON.parse(line).projectId !== projectId;
        } catch {
          return true; // an unreadable line is kept: never lose data over a cleanup
        }
      });
      if (keep.length === lines.length) continue;
      try {
        copyFileSync(file, `${file}.bak-purge-${Date.now()}`);
      } catch {
        // the backup is best-effort; the rows are still removed below
      }
      writeFileSync(file, keep.length ? `${keep.join('\n')}\n` : '');
      removed += lines.length - keep.length;
    }
    if (removed) this.cache.sig = '';
    return removed;
  }

  query({ accountId, from = 0, to = Date.now() } = {}) {
    const all = accountId === 'all';
    return this.rows().filter((r) => (all || r.account.id === accountId) && r.ts >= from && r.ts <= to);
  }
}

/** The engines a row can be attributed to. `source` (web/cli) is a separate dimension. */
export const ENGINES = ['claude', 'opencode'];

const isEngine = (value) => ENGINES.includes(value);

/**
 * Engine that spent the tokens: the stored `engine` when it is one we know, otherwise the account it
 * was recorded under. Rows written before `engine` existed have no field, so their engine is derived
 * here instead of rewriting data/usage.jsonl (the account is the fallback). A row without either is
 * `unknown` rather than a guessed engine.
 */
export function engineOf(row) {
  if (isEngine(row?.engine)) return row.engine;
  if (row?.account?.id === 'opencode') return 'opencode';
  if (row?.account?.id) return 'claude';
  return 'unknown';
}

/** Engine bucket for a summary. `engineOf` already keeps an unattributable row in its own `unknown` bucket. */
const engineKey = engineOf;

/** web/cli, or unknown for a row imported without a source (so the engine × source table still reconciles). */
const sourceKey = (row) => (row.source === 'cli' ? 'cli' : row.source === 'web' ? 'web' : 'unknown');

const COUNTS = ['input', 'output', 'cacheRead', 'cacheWrite'];
/** The shape record() writes: a time, an account id and non-negative token counts. */
function validRow(r) {
  return Boolean(r && typeof r === 'object' && Number.isFinite(r.ts) && typeof r.account?.id === 'string' && r.account.id && COUNTS.every((k) => Number.isFinite(r[k]) && r[k] >= 0));
}

const sum = (rows, key) => rows.reduce((acc, r) => acc + (r[key] ?? 0), 0);

function group(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.entries()].map(([key, items]) => ({ key, ...totals(items) })).sort((a, b) => b.total - a.total);
}

export function totals(rows) {
  const input = sum(rows, 'input');
  const output = sum(rows, 'output');
  const cacheRead = sum(rows, 'cacheRead');
  const cacheWrite = sum(rows, 'cacheWrite');
  const known = rows.filter((r) => r.costUsd != null);
  const contextIn = input + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: contextIn + output,
    requests: sum(rows, 'requests'),
    turns: sum(rows, 'turns'),
    costUsd: known.length ? sum(known, 'costUsd') : null,
    costCoverage: rows.length ? known.length / rows.length : 0,
    cacheHitRate: contextIn ? cacheRead / contextIn : 0,
  };
}

/**
 * What a model actually cost in this ledger: recorded cost / recorded tokens × 1,000,000. Used for models
 * with no list price (Claude, or an OpenCode model missing from the catalog), as a blended effective price.
 * Only rows that carry a cost count, and a group without tokens has no usable price and is left out.
 * @param {object[]} rows ledger rows (see UsageLedger.query)
 * @returns {{ model: string, perMillion: number, records: number, tokens: number }[]}
 */
export function observedPrices(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (typeof r.costUsd !== 'number' || !Number.isFinite(r.costUsd)) continue;
    const tokens = (r.input ?? 0) + (r.output ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0);
    if (!tokens) continue;
    const model = r.model || 'unknown';
    const g = groups.get(model) ?? { cost: 0, tokens: 0, records: 0 };
    g.cost += r.costUsd;
    g.tokens += tokens;
    g.records++;
    groups.set(model, g);
  }
  return [...groups.entries()]
    .map(([model, g]) => ({ model, perMillion: Math.round((g.cost / g.tokens) * 1e6 * 1e6) / 1e6, records: g.records, tokens: g.tokens }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

export const PERIOD_UNITS = ['day', 'week', 'month'];

/** Local start of the day / week (Monday) / month containing `ts`. */
export function periodStart(ts, unit) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (unit === 'month') d.setDate(1);
  return d.getTime();
}

/** Start of the next period (calendar-aware: months differ in length, DST shifts days). */
function nextPeriod(start, unit) {
  const d = new Date(start);
  if (unit === 'month') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + (unit === 'week' ? 7 : 1));
  return d.getTime();
}

const MAX_PERIODS = 400;

/**
 * Totals per day/week/month across the whole range [from, to], oldest first. Empty periods are
 * kept so a chart shows the gaps; start/end are clipped to the range (a 7-day range that starts
 * on a Sunday opens with a one-day "week"). At most the latest 400 periods.
 */
export function byPeriod(rows, { from, to, unit = 'day' }) {
  const buckets = new Map(); // period start -> rows, in one pass
  for (const r of rows) {
    const key = periodStart(r.ts, unit);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const first = from || rows.reduce((min, r) => Math.min(min, r.ts), to); // no range start: begin at the first record
  const starts = [];
  for (let start = periodStart(first, unit); start <= to; start = nextPeriod(start, unit)) starts.push(start);
  return starts.slice(-MAX_PERIODS).map((start) => ({
    start: Math.max(start, first),
    end: Math.min(nextPeriod(start, unit) - 1, to),
    ...totals(buckets.get(start) ?? []),
  }));
}

/** Everything the report shows, for one account and period. */
export function summarize(rows, { from, to, groupBy = 'day' }) {
  const sessions = group(rows.filter((r) => r.sessionId), (r) => `${r.project ?? '-'}|${r.sessionId}`).slice(0, 10);
  // source is on every record the app writes; engine falls back to the account for rows written before it existed
  const engineSource = group(rows, (r) => `${engineKey(r)}:${sourceKey(r)}`);
  return {
    from,
    to,
    records: rows.length,
    totals: totals(rows),
    byModel: group(rows, (r) => r.model),
    byProject: group(rows, (r) => r.project ?? '(tanpa project)'),
    bySource: group(rows, (r) => (r.source === 'cli' ? 'CLI (terminal)' : 'Web')),
    byEngine: group(rows, engineKey),
    byEngineSource: engineSource.map(({ key, ...rest }) => {
      const at = key.indexOf(':');
      return { key, engine: key.slice(0, at), source: key.slice(at + 1), ...rest };
    }),
    groupBy,
    byPeriod: byPeriod(rows, { from, to, unit: groupBy }),
    topSessions: sessions,
  };
}
