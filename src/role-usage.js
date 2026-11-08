// 🧩 Per-role usage estimate for 📊 Laporan.
//
// The ledger is the source of truth for tokens and cost, but it records a turn as one row: subagent tokens are not
// split per role. Claude Code writes each subagent's transcript separately (agent-*.jsonl + .meta.json with its
// agentType), so their raw token counts give a *proportion*. This module uses that proportion to split each session's
// ledger total between the Lead (main thread) and the roles — the table always adds up to the real ledger, and is
// explicitly an estimate (cache reads and sessions without a transcript make the split approximate).
//
// Privacy: only numbers, model names and agent types are read; no prompt or answer text is kept or returned.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CATALOG, GENERALIST, LEAD_ID } from './role-catalog.js';
import { toRole } from './roles.js';
import { transcriptDir } from './transcripts.js';

const MAX_FILE_BYTES = 64 * 1024 * 1024; // a huge transcript is skipped, not loaded into the server
const MAX_CACHED = 240;
const MAX_SESSIONS = 120; // pathological reports fall back to Lead for the smallest sessions
const cache = new Map(); // file + mtime + size + range -> { tokens }

const usageTokens = (u) =>
  (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);

const roleLabel = (role) => (role === LEAD_ID ? 'Lead (utama)' : (CATALOG[role]?.title ?? role));

/** A subagent's agentType → an office role, without recording unknown names (a report must not change role memory). */
function roleFor(agentType) {
  const key = String(agentType ?? '').toLowerCase().trim();
  if (!key) return GENERALIST;
  if (CATALOG[key]) return key;
  return toRole(key) ?? GENERALIST;
}

/**
 * Assistant tokens in one transcript file within [from, to]. A line without a parseable timestamp is included (it
 * cannot be placed, and dropping it would distort the share). Cached by mtime/size/range; a live session invalidates
 * its old entry on the next append.
 */
function fileTokens(file, from, to) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  const key = `${file}|${st.mtimeMs}|${st.size}|${from}|${to}`;
  if (cache.has(key)) return cache.get(key);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let tokens = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a torn line is skipped, like the other transcript readers
    }
    if (row.type !== 'assistant') continue;
    const ts = Date.parse(row.timestamp ?? row.ts ?? '');
    if (Number.isFinite(ts) && (ts < from || ts > to)) continue;
    tokens += usageTokens(row.message?.usage);
  }
  const out = { tokens };
  cache.set(key, out);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return out;
}

function metaOf(file) {
  try {
    return JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Raw token split of one session: main thread (Lead) + one entry per subagent role. `null` when no transcript can be
 * read; the caller then attributes the whole session to the Lead.
 * @returns {{ lead: number, sub: Map<string, { tokens: number, agents: number }> } | null}
 */
function sharesForSession(projectPath, sessionId, from, to) {
  if (!projectPath || !sessionId) return null;
  const dir = transcriptDir(projectPath);
  const main = fileTokens(path.join(dir, `${sessionId}.jsonl`), from, to);
  const subDir = path.join(dir, sessionId, 'subagents');
  let files;
  try {
    files = readdirSync(subDir, { withFileTypes: true });
  } catch {
    files = [];
  }
  const sub = new Map();
  let sawAny = Boolean(main);
  for (const entry of files) {
    if (!entry.isFile() || !/^agent-.+\.jsonl$/.test(entry.name)) continue;
    const file = path.join(subDir, entry.name);
    const tokens = fileTokens(file, from, to);
    if (!tokens) continue;
    sawAny = true;
    if (!tokens.tokens) continue;
    const meta = metaOf(file);
    const role = roleFor(meta?.agentType ?? meta?.agent_type ?? meta?.agent ?? '');
    const cur = sub.get(role) ?? { tokens: 0, agents: 0 };
    cur.tokens += tokens.tokens;
    cur.agents += 1;
    sub.set(role, cur);
  }
  if (!sawAny) return null;
  return { lead: main?.tokens ?? 0, sub };
}

const add = (map, role, tokens, costUsd, priced, delegations = 0) => {
  const cur = map.get(role) ?? { role, tokens: 0, costUsd: null, pricedTokens: 0, delegations: 0 };
  cur.tokens += tokens;
  cur.delegations += delegations;
  if (costUsd != null) {
    cur.costUsd = (cur.costUsd ?? 0) + costUsd;
    cur.pricedTokens += tokens;
  }
  map.set(role, cur);
};

/**
 * Split the report's ledger rows per role. Rows are grouped by (project, session); each group's tokens and cost are
 * divided by the raw transcript proportions. Sessions without a readable transcript go entirely to the Lead.
 * @param {object[]} rows ledger rows already filtered by account and period
 * @param {{ hub?: object, from?: number, to?: number }} options
 * @returns {{ roles: object[], totalTokens: number, note: string, estimated: true }}
 */
export function roleUsage(rows, { hub = null, from = 0, to = Date.now() } = {}) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.projectId ?? ''}|${row.sessionId ?? ''}`;
    const g = groups.get(key) ?? { projectId: row.projectId ?? null, sessionId: row.sessionId ?? null, tokens: 0, costUsd: null };
    g.tokens += n(row.input) + n(row.output) + n(row.cacheRead) + n(row.cacheWrite);
    if (typeof row.costUsd === 'number') g.costUsd = (g.costUsd ?? 0) + row.costUsd;
    groups.set(key, g);
  }
  // Pathological report: keep the biggest sessions, the rest is Lead-only.
  const list = [...groups.values()].sort((a, b) => b.tokens - a.tokens);
  const used = list.slice(0, MAX_SESSIONS);
  const skipped = list.slice(MAX_SESSIONS);
  const totals = new Map();
  let totalTokens = 0;
  for (const g of [...used, ...skipped]) {
    totalTokens += g.tokens;
    if (g.tokens <= 0) continue;
    const projectPath = g.projectId ? hub?.projects?.get?.(g.projectId)?.path ?? null : null;
    const shares = g.sessionId ? sharesForSession(projectPath, g.sessionId, from, to) : null;
    if (!shares) {
      add(totals, LEAD_ID, g.tokens, g.costUsd, g.costUsd != null);
      continue;
    }
    const rawTotal = shares.lead + [...shares.sub.values()].reduce((sum, x) => sum + x.tokens, 0);
    if (!(rawTotal > 0)) {
      add(totals, LEAD_ID, g.tokens, g.costUsd, g.costUsd != null);
      continue;
    }
    add(totals, LEAD_ID, (g.tokens * shares.lead) / rawTotal, g.costUsd == null ? null : (g.costUsd * shares.lead) / rawTotal, g.costUsd != null);
    for (const [role, x] of shares.sub) {
      const share = x.tokens / rawTotal;
      add(totals, role, g.tokens * share, g.costUsd == null ? null : g.costUsd * share, g.costUsd != null, x.agents);
    }
  }
  const roles = [...totals.values()]
    .filter((r) => r.tokens > 0)
    .map((r) => ({
      role: r.role,
      label: roleLabel(r.role),
      tokens: Math.round(r.tokens),
      share: totalTokens > 0 ? r.tokens / totalTokens : 0,
      costUsd: r.costUsd == null ? null : Math.round(r.costUsd * 100) / 100,
      costCoverage: r.tokens > 0 ? r.pricedTokens / r.tokens : 0,
      delegations: r.delegations,
    }))
    .sort((a, b) => b.tokens - a.tokens);
  return {
    roles,
    totalTokens: Math.round(totalTokens),
    estimated: true,
    note:
      'Perkiraan: total token/biaya laporan dibagi menurut proporsi token di transcript (main thread vs subagent). ' +
      'Cache read dan sesi tanpa transcript bisa membuat angka per role tidak presisi; jumlah tabel tetap sama dengan total laporan.',
  };
}
