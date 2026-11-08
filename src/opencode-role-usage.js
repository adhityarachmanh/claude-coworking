// 🧩 Role data for OpenCode sessions, read through its own API (`opencode api session.list`). Each session carries
// the agent that ran it (build/plan for the main thread, a role name for Mode tim subagents), so no transcript parsing
// and no SQLite access are needed. Numbers only; no message text is fetched.
import { openCodeApi } from './opencode-auth.js';

const CACHE_MS = 60_000;
const MAX_SESSIONS = 500;
let cache = { at: 0, key: null, map: new Map() };

const tokenTotal = (t) => (t?.input ?? 0) + (t?.output ?? 0) + (t?.reasoning ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0);

/**
 * All OpenCode sessions as `Map<sessionId, { agent, tokens, cost }>`, cached for a minute. A missing binary, a
 * stopped service or a malformed answer is an empty map (the report then shows "OpenCode tanpa rincian role").
 * @param {{ command: string, args: string[] }|null} opencode
 * @param {{ api?: Function, now?: () => number }} [options] api: tests inject a fake
 * @returns {Promise<Map<string, { agent: string, tokens: number, cost: number|null }>>}
 */
export async function openCodeRoleSessions(opencode, { api = openCodeApi, now = Date.now } = {}) {
  if (!opencode) return new Map();
  const at = now();
  const key = `${opencode.command}|${JSON.stringify(opencode.args ?? [])}`;
  if (cache.key === key && at - cache.at < CACHE_MS) return cache.map;
  let raw;
  try {
    raw = await api(opencode, 'session.list', { params: { limit: MAX_SESSIONS }, timeout: 5000 });
  } catch {
    // Service down / older CLI: keep the honest "no detail" path, and do not retry on every report for a minute.
    cache = { at, key, map: new Map() };
    return cache.map;
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
  const map = new Map();
  for (const session of list.slice(0, MAX_SESSIONS)) {
    const id = typeof session?.id === 'string' ? session.id : '';
    if (!/^ses_[\w-]{1,100}$/.test(id)) continue;
    map.set(id, {
      agent: typeof session.agent === 'string' ? session.agent.toLowerCase().trim() : '',
      tokens: tokenTotal(session.tokens),
      cost: typeof session.cost === 'number' && Number.isFinite(session.cost) ? session.cost : null,
    });
  }
  cache = { at, key, map };
  return map;
}
