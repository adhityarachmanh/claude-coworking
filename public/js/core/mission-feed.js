// 🛰 Mission Control: the current mission (everything since the latest prompt) as a mission-control dashboard —
// stations per role (GO / HOLD / FAIL / DONE / STBY), a comms log of who handed what to whom, a per-role timeline and
// telemetry. Derived only from the project's real chat rows and office events. Pure: office/mission.js draws it.
import { terminalFeed } from './terminal-feed.js';

const TAIL_MS = 4000; // a finished step is shown at least this long on the timeline
const MERGE_MS = 5000; // segments of one role closer than this become one bar
const BUCKETS = 8;
const RANK = { hold: 0, go: 1, fail: 2, done: 3, stby: 4 };
const NAMES = { claude: 'LEAD', pm: 'PM' };

const firstLine = (s) => String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
const clip = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * @param {object[]} chat  the project's chat messages (state.chats[project])
 * @param {{ now?: number, coordinator?: string, team?: string[], events?: object[] }} options
 *   team: the roles on the team in their order (the Lead included or not); events: office events (test results)
 */
export function missionFeed(chat, { now = Date.now(), coordinator = 'claude', team = [], events = [] } = {}) {
  const all = Array.isArray(chat) ? chat.filter((m) => m && typeof m === 'object') : [];
  const lastPrompt = all.findLastIndex((m) => m.kind === 'user');
  const rows = lastPrompt >= 0 ? all.slice(lastPrompt) : all;
  const ts = (m) => (Number.isFinite(m.ts) ? m.ts : now);
  const start = rows.length ? ts(rows[0]) : now;
  const roleOf = (m) => (!m.role || m.role === 'claude' ? coordinator : m.role);
  const fromOf = (m) => {
    const from = m.from ?? 'claude';
    return from === 'claude' && coordinator !== 'claude' && m.role !== coordinator ? coordinator : from;
  };
  const name = (r) => NAMES[r] ?? r;

  // telemetry
  let steps = 0;
  let delegations = 0;
  let cost = null;
  let tokensOut = 0;
  for (const m of rows) {
    if (m.kind === 'tool') steps++;
    else if (m.kind === 'delegate') delegations++;
    else if (m.kind === 'result') {
      if (Number.isFinite(m.meta?.costUsd)) cost = (cost ?? 0) + m.meta.costUsd;
      if (Number.isFinite(m.meta?.tokensOut)) tokensOut += m.meta.tokensOut;
    }
  }

  // when a delegation ended: its last subagent row (or the delegation itself)
  const delegationEnd = new Map();
  for (const m of rows) if (m.kind === 'delegate' && m.toolUseId) delegationEnd.set(m.toolUseId, ts(m));
  for (const m of rows) if (m.parentToolUseId && delegationEnd.has(m.parentToolUseId)) delegationEnd.set(m.parentToolUseId, Math.max(delegationEnd.get(m.parentToolUseId), ts(m)));

  // comms log
  const log = [];
  const holds = [];
  const entry = (t, text, tone) => log.push({ t: Math.max(0, t - start), text: clip(text), tone });
  for (const m of rows) {
    const t = ts(m);
    if (m.kind === 'user') entry(t, `LEAD ← kamu: ${firstLine(m.text)}`, 'info');
    else if (m.kind === 'delegate') {
      const from = fromOf(m);
      entry(t, `${name(from)} → ${m.role}: ${firstLine(m.text)}`, 'info');
      const end = (delegationEnd.get(m.toolUseId) ?? t) + TAIL_MS;
      if (m.status === 'ok') entry(end, `${m.role} → ${name(from)}: ✔ laporan`, 'ok');
      else if (m.status === 'fail') entry(end, `${m.role} → ${name(from)}: ✖ gagal`, 'bad');
    } else if (m.kind === 'approval' && m.status === 'pending') {
      entry(t, `${roleOf(m)}: ⚠ HOLD ${firstLine(m.text)}`, 'warn');
      holds.push({ role: roleOf(m), text: clip(firstLine(m.text)) });
    } else if (m.kind === 'tool' && m.status === 'fail') {
      entry(t, `${roleOf(m)}: ✖ gagal (${firstLine(m.input?.command) || m.tool})`, 'bad');
    }
  }
  log.sort((a, b) => a.t - b.t);

  // timeline: one lane per role, its rows' spans merged into bars
  const spans = new Map();
  const span = (role, a, b) => {
    if (!spans.has(role)) spans.set(role, []);
    spans.get(role).push([a, Math.min(now, Math.max(b, a))]);
  };
  for (const m of rows) {
    const t = ts(m);
    if (m.kind === 'delegate') span(m.role, t, m.status === 'running' ? now : (delegationEnd.get(m.toolUseId) ?? t) + TAIL_MS);
    else if (m.kind === 'tool') span(roleOf(m), t, m.status === 'running' ? now : t + Math.max(TAIL_MS, (m.elapsed ?? 0) * 1000));
    else if (m.kind === 'approval') span(roleOf(m), t, m.status === 'pending' ? now : t + TAIL_MS);
  }
  const timeline = [...spans.entries()]
    .map(([role, list]) => {
      const segs = [];
      for (const [a, b] of list.sort((x, y) => x[0] - y[0])) {
        const last = segs.at(-1);
        if (last && a - last[1] <= MERGE_MS) last[1] = Math.max(last[1], b);
        else segs.push([a, b]);
      }
      return { role, segs };
    })
    .sort((a, b) => a.segs[0][0] - b.segs[0][0]);

  // stations: the terminal panels' state and newest line, plus an activity sparkline over the mission
  const panels = terminalFeed(rows, { coordinator, events, maxLines: 1, nameOf: (r) => (r === 'claude' ? 'Lead' : r === 'pm' ? 'PM' : r) });
  const width = Math.max(1, now - start);
  const sparkOf = (role) => {
    const b = new Array(BUCKETS).fill(0);
    for (const m of rows) {
      const r = m.kind === 'delegate' || m.kind === 'approval' ? (m.kind === 'approval' ? roleOf(m) : m.role) : m.kind === 'tool' ? roleOf(m) : null;
      if (r !== role) continue;
      b[Math.min(BUCKETS - 1, Math.floor(((ts(m) - start) / width) * BUCKETS))]++;
    }
    return b;
  };
  const roles = [...new Set([...team, ...panels.keys()])].filter((r) => r !== 'claude');
  const order = new Map(roles.map((r, i) => [r, i]));
  const stations = roles
    .map((role) => {
      const p = panels.get(role);
      const state = !p ? 'stby' : p.state === 'ask' ? 'hold' : p.state === 'busy' ? 'go' : p.state === 'error' ? 'fail' : p.lines.length ? 'done' : 'stby';
      return { role, state, what: p?.lines.at(-1)?.text ?? '', spark: sparkOf(role), ...(p?.tests ? { tests: p.tests } : {}) };
    })
    .sort((a, b) => RANK[a.state] - RANK[b.state] || order.get(a.role) - order.get(b.role));

  const running = rows.some((m) => (m.kind === 'tool' || m.kind === 'delegate') && m.status === 'running');
  return {
    start,
    elapsedMs: rows.length ? Math.max(0, now - start) : 0,
    prompt: lastPrompt >= 0 ? clip(firstLine(all[lastPrompt].text), 120) : '',
    phase: !rows.length ? 'idle' : holds.length ? 'hold' : running ? 'go' : 'done',
    stations,
    log,
    holds,
    timeline,
    telemetry: { steps, delegations, costUsd: cost === null ? null : Math.round(cost * 1e4) / 1e4, tokensOut },
  };
}
