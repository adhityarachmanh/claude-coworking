// Full-text search over OpenCode's own session store, read through `opencode api session.message.list`.
// Bounded like the Claude transcript search: a limited number of sessions, messages and results, so a huge
// history can never stall a search. Kept separate from src/conversation.js because OpenCode sessions are remote
// records, not files inside the project.
import { openCodeApi } from './opencode-auth.js';
import { openCodeSessions } from './opencode-bin.js';
import { SEARCH_LIMITS, searchQuery, snippet } from './conversation.js';

const SESSIONS_PER_PROJECT = 12;
const MAX_SESSIONS = 40;
const MESSAGES_PER_SESSION = 80;

const textOf = (message) => {
  if (message?.type === 'user') return String(message.text ?? '').trim();
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n')
    .trim();
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Search OpenCode sessions for one or more projects.
 * @param {{ id: string, path: string }[]} projects
 * @param {string} q
 * @param {{ opencode: object|null, limit?: number, api?: Function, list?: Function }} options
 * @returns {Promise<{ query: string, results: object[], truncated: boolean, sessions: number }>}
 */
export async function searchOpenCodeSessions(projects, q, { opencode = null, limit = SEARCH_LIMITS.defaultResults, api = openCodeApi, list = openCodeSessions } = {}) {
  const query = searchQuery(q);
  const max = Math.min(Math.max(1, Number(limit) || SEARCH_LIMITS.defaultResults), SEARCH_LIMITS.maxResults);
  if (!opencode) return { query, results: [], truncated: false, sessions: 0 };
  const re = new RegExp(escapeRegExp(query), 'gi');
  const results = [];
  let scanned = 0;
  let truncated = false;
  outer: for (const project of Array.isArray(projects) ? projects : []) {
    let sessions;
    try {
      sessions = await list(opencode, project.path, 30);
    } catch {
      continue;
    }
    let perProject = 0;
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!/^ses_[\w-]{1,100}$/.test(String(session?.id ?? ''))) continue;
      if (perProject++ >= SESSIONS_PER_PROJECT || scanned >= MAX_SESSIONS) {
        truncated = true;
        break outer;
      }
      let messages;
      try {
        messages = await api(opencode, 'session.message.list', { params: { sessionID: session.id, limit: MESSAGES_PER_SESSION, order: 'desc' }, timeout: 15_000 });
      } catch {
        continue;
      }
      scanned++;
      let hits = 0;
      for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
        const text = textOf(message);
        if (!text) continue;
        re.lastIndex = 0;
        const found = re.exec(text);
        if (!found) continue;
        results.push({
          projectId: project.id,
          sessionId: session.id,
          title: String(session.title ?? '').trim().slice(0, 90) || `Sesi ${session.id.slice(0, 8)}`,
          source: 'opencode',
          engine: 'opencode',
          role: message?.type === 'user' ? 'user' : 'assistant',
          ts: Number(message?.time?.created ?? session.updated) || 0,
          snippet: snippet(text, found.index, found[0].length, SEARCH_LIMITS.context),
        });
        if (++hits >= SEARCH_LIMITS.perSession || results.length >= max) break;
      }
      if (results.length >= max) {
        truncated = true;
        break outer;
      }
    }
  }
  results.sort((a, b) => b.ts - a.ts);
  return { query, results, truncated, sessions: scanned };
}
