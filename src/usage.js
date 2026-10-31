// Token usage ledger (data/usage.jsonl). Every record carries the account that was logged in
// when the tokens were spent, so reports for different accounts never mix.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export class UsageLedger {
  constructor({ file, account }) {
    this.file = file;
    this.account = account; // () => { id, email, org } | null
    mkdirSync(path.dirname(file), { recursive: true });
  }

  /**
   * @param {{ source: 'web'|'cli', project: {id,name}, sessionId?: string, model: string,
   *           input: number, output: number, cacheRead: number, cacheWrite: number,
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
  }

  rows() {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
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

  query({ accountId, from = 0, to = Date.now() }) {
    return this.rows().filter((r) => r.account.id === accountId && r.ts >= from && r.ts <= to);
  }
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
  return {
    from,
    to,
    records: rows.length,
    totals: totals(rows),
    byModel: group(rows, (r) => r.model),
    byProject: group(rows, (r) => r.project ?? '(tanpa project)'),
    bySource: group(rows, (r) => (r.source === 'cli' ? 'CLI (terminal)' : 'Web')),
    groupBy,
    byPeriod: byPeriod(rows, { from, to, unit: groupBy }),
    topSessions: sessions,
  };
}
