// 📈 Pola kerja: aggregate the usage ledger into "where did the work and the money go". Pure: no I/O, no dates from
// the clock unless `now` is passed, so the numbers are testable.
const DAY = 86_400_000;
export const INSIGHT_DAYS = Object.freeze([7, 30, 90]);
const num = (v) => (Number.isFinite(v) ? v : 0);

export function insightSummary(rows, { now = Date.now(), days = 30 } = {}) {
  const range = INSIGHT_DAYS.includes(days) ? days : 30;
  const from = now - range * DAY;
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && Number.isFinite(r.ts) && r.ts >= from && r.ts <= now);
  const projects = new Map();
  const models = new Map();
  const hours = Array(24).fill(0);
  const sessions = new Set();
  let costUsd = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let requests = 0;
  let turns = 0;
  for (const r of list) {
    const tokens = num(r.input) + num(r.output) + num(r.cacheRead) + num(r.cacheWrite);
    const cost = num(r.costUsd);
    costUsd += cost;
    input += num(r.input);
    output += num(r.output);
    cacheRead += num(r.cacheRead);
    cacheWrite += num(r.cacheWrite);
    requests += num(r.requests);
    turns += num(r.turns);
    if (typeof r.sessionId === 'string' && r.sessionId) sessions.add(r.sessionId);
    hours[new Date(r.ts).getHours()] += Math.max(1, num(r.requests));
    const pid = typeof r.projectId === 'string' && r.projectId ? r.projectId : 'none';
    const project = projects.get(pid) ?? { id: pid, name: typeof r.project === 'string' && r.project ? r.project : 'Tanpa project', costUsd: 0, tokens: 0, requests: 0 };
    project.costUsd += cost;
    project.tokens += tokens;
    project.requests += num(r.requests);
    projects.set(pid, project);
    const model = typeof r.model === 'string' && r.model ? r.model : 'unknown';
    const entry = models.get(model) ?? { model, costUsd: 0, tokens: 0, requests: 0 };
    entry.costUsd += cost;
    entry.tokens += tokens;
    entry.requests += num(r.requests);
    models.set(model, entry);
  }
  const top = (map) => [...map.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens).slice(0, 8);
  const busiest = hours.indexOf(Math.max(...hours));
  // Same definition as the report's hit rate: how much of the context sent was served from the prompt cache.
  const contextIn = input + cacheRead + cacheWrite;
  return {
    days: range,
    from,
    costUsd,
    tokens: input + output + cacheRead + cacheWrite,
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheHitRate: contextIn ? cacheRead / contextIn : 0,
    requests,
    turns,
    sessions: sessions.size,
    activeProjects: projects.size,
    hours,
    busiestHour: hours[busiest] > 0 ? busiest : null,
    projects: top(projects),
    models: top(models),
  };
}
