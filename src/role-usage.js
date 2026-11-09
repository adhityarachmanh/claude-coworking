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
import { engineOf } from './usage.js';

const MAX_FILE_BYTES = 64 * 1024 * 1024; // a huge transcript is skipped, not loaded into the server
const MAX_CACHED = 240;
const MAX_SESSIONS = 120; // pathological reports fall back to "no detail" for the smallest sessions
const UNKNOWN_ROLE = 'unknown';
const OPENCODE_UNKNOWN_ROLE = 'opencode-unknown';
const OPENCODE_LEAD_AGENTS = new Set(['', 'build', 'plan', 'default']);
const cache = new Map(); // file + mtime + size -> [{ ts, tokens }] (parsed once per file version)

const usageTokens = (u) =>
  (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);

const roleLabel = (role) =>
  role === OPENCODE_UNKNOWN_ROLE
    ? 'OpenCode (tanpa rincian role)'
    : role === UNKNOWN_ROLE
      ? 'Tanpa rincian role'
      : role === LEAD_ID
        ? 'Lead (utama)'
        : (CATALOG[role]?.title ?? role);

/** A subagent's agentType → an office role, without recording unknown names (a report must not change role memory). */
function roleFor(agentType) {
  const key = String(agentType ?? '').toLowerCase().trim();
  if (!key) return GENERALIST;
  if (CATALOG[key]) return key;
  return toRole(key) ?? GENERALIST;
}

/** OpenCode's session agent: build/plan = main thread (Lead); role names = Mode tim subagents. */
function roleForOpenCode(agent) {
  const key = String(agent ?? '').toLowerCase().trim();
  if (OPENCODE_LEAD_AGENTS.has(key)) return LEAD_ID;
  if (!key || key === '(none)') return UNKNOWN_ROLE;
  if (CATALOG[key]) return key;
  return toRole(key) ?? GENERALIST;
}

/**
 * Assistant tokens per line in one transcript file, with timestamps, cached by file version. Range filtering happens
 * on every call, so repeated reports with a different `to` reuse the parse. A line without a parseable timestamp is
 * kept with `ts: null` (it cannot be placed, and dropping it would distort the share).
 * @returns {{ ts: number|null, tokens: number }[] | null}
 */
function fileEntries(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  if (cache.has(key)) return cache.get(key);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a torn line is skipped, like the other transcript readers
    }
    if (row.type !== 'assistant') continue;
    const tokens = usageTokens(row.message?.usage);
    if (!tokens) continue;
    const ts = Date.parse(row.timestamp ?? row.ts ?? '');
    entries.push({ ts: Number.isFinite(ts) ? ts : null, tokens });
  }
  cache.set(key, entries);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return entries;
}

/** Tokens in one file within [from, to]; untimestamped lines always count. */
function fileTokens(file, from, to) {
  const entries = fileEntries(file);
  if (!entries) return null;
  let tokens = 0;
  for (const entry of entries) if (entry.ts == null || (entry.ts >= from && entry.ts <= to)) tokens += entry.tokens;
  return { tokens };
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
 * divided by the raw transcript proportions. A session without a readable transcript (OpenCode's own store, a deleted
 * transcript, a session the mirror never saw) goes to the explicit **"Tanpa rincian role"** row — not to the Lead.
 * @param {object[]} rows ledger rows already filtered by account and period
 * @param {{ hub?: object, from?: number, to?: number, opencodeSessions?: Map<string, { agent: string }> }} options
 *   opencodeSessions: `opencode api session.list` mapped by session id (src/opencode-role-usage.js)
 * @returns {{ roles: object[], totalTokens: number, coverage: object, note: string, estimated: true }}
 */
export function roleUsage(rows, { hub = null, from = 0, to = Date.now(), opencodeSessions = null } = {}) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.projectId ?? ''}|${row.sessionId ?? ''}`;
    const g = groups.get(key) ?? { projectId: row.projectId ?? null, sessionId: row.sessionId ?? null, tokens: 0, costUsd: null, engine: null, agent: null };
    g.tokens += n(row.input) + n(row.output) + n(row.cacheRead) + n(row.cacheWrite);
    if (typeof row.costUsd === 'number') g.costUsd = (g.costUsd ?? 0) + row.costUsd;
    const engine = engineOf(row);
    if (!g.engine) g.engine = engine;
    else if (g.engine !== engine) g.engine = 'mixed';
    const agent = typeof row.agent === 'string' && row.agent.trim() ? row.agent.trim().toLowerCase() : null;
    if (agent) {
      if (!g.agent) g.agent = agent;
      else if (g.agent !== agent) g.agent = 'mixed';
    }
    groups.set(key, g);
  }
  // Pathological report: keep the biggest sessions, the rest is explicitly "no detail" (never guessed).
  const list = [...groups.values()].sort((a, b) => b.tokens - a.tokens);
  const used = list.slice(0, MAX_SESSIONS);
  const skipped = list.slice(MAX_SESSIONS);
  const totals = new Map();
  let totalTokens = 0;
  let knownTokens = 0;
  let unknownTokens = 0;
  let sessionsKnown = 0;
  for (const g of used) {
    totalTokens += g.tokens;
    if (g.tokens <= 0) continue;
    const projectPath = g.projectId ? hub?.projects?.get?.(g.projectId)?.path ?? null : null;
    const shares = g.sessionId ? sharesForSession(projectPath, g.sessionId, from, to) : null;
    const rawTotal = shares ? shares.lead + [...shares.sub.values()].reduce((sum, x) => sum + x.tokens, 0) : 0;
    if (!shares || !(rawTotal > 0)) {
      // OpenCode keeps its own session list: a session's agent is its role (no transcript needed). New ledger rows
      // carry that agent themselves, so the report survives a deleted session; older rows fall back to session.list.
      const agent = g.agent && g.agent !== 'mixed' ? g.agent : opencodeSessions?.get?.(g.sessionId)?.agent ?? null;
      if (g.engine === 'opencode' && agent) {
        const role = roleForOpenCode(agent);
        if (role === UNKNOWN_ROLE) {
          add(totals, OPENCODE_UNKNOWN_ROLE, g.tokens, g.costUsd, g.costUsd != null);
          unknownTokens += g.tokens;
        } else {
          sessionsKnown += 1;
          knownTokens += g.tokens;
          add(totals, role, g.tokens, g.costUsd, g.costUsd != null, role === LEAD_ID ? 0 : 1);
        }
        continue;
      }
      add(totals, g.engine === 'opencode' ? OPENCODE_UNKNOWN_ROLE : UNKNOWN_ROLE, g.tokens, g.costUsd, g.costUsd != null);
      unknownTokens += g.tokens;
      continue;
    }
    sessionsKnown += 1;
    knownTokens += g.tokens;
    add(totals, LEAD_ID, (g.tokens * shares.lead) / rawTotal, g.costUsd == null ? null : (g.costUsd * shares.lead) / rawTotal, g.costUsd != null);
    for (const [role, x] of shares.sub) {
      const share = x.tokens / rawTotal;
      add(totals, role, g.tokens * share, g.costUsd == null ? null : g.costUsd * share, g.costUsd != null, x.agents);
    }
  }
  for (const g of skipped) {
    totalTokens += g.tokens;
    if (g.tokens <= 0) continue;
    add(totals, g.engine === 'opencode' ? OPENCODE_UNKNOWN_ROLE : UNKNOWN_ROLE, g.tokens, g.costUsd, g.costUsd != null);
    unknownTokens += g.tokens;
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
  const sessions = list.filter((g) => g.tokens > 0).length;
  const percent = totalTokens > 0 ? knownTokens / totalTokens : 0;
  return {
    roles,
    totalTokens: Math.round(totalTokens),
    coverage: {
      percent,
      knownTokens: Math.round(knownTokens),
      unknownTokens: Math.round(unknownTokens),
      sessionsWithTranscript: sessionsKnown,
      sessions,
    },
    estimated: true,
    note:
      `Rincian role tersedia untuk ${Math.round(percent * 100)}% token (${sessionsKnown} dari ${sessions} sesi). ` +
      'Sesi OpenCode memakai agent dari session list (build/plan = Lead, nama role = subagent). ' +
      'Sisanya masuk "OpenCode (tanpa rincian role)" atau "Tanpa rincian role" karena tidak ditemukan di store/transcript. ' +
      'Total tabel tetap sama dengan total laporan; cache read membuat pembagiannya perkiraan.',
  };
}
