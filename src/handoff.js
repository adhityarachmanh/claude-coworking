// 🔁 Context bridge for automatic engine switches: a project's conversation in one engine's workspace (Claude Code or
// OpenCode) is carried to the other as a note that rides with the next prompt. Built here from what the app already
// has — the other workspace's stored chat (prompts, answers, last tool steps) — with no model call and no git:
// free and instant. There is no manual handoff dialog any more; picking a model of the other engine moves the
// project and the bridge happens by itself (src/session.js).
import { ChatStore } from './chat-store.js';
import { redactSecrets } from './cli-bridge.js';

const MAX_MESSAGES = 30;
const MAX_PER_MESSAGE = 700;
const MAX_TOTAL = 14_000;
export const ENGINE_LABEL = { claude: 'Claude Code', opencode: 'OpenCode' };

// Shapes the generic redactor does not catch on its own (a bare token pasted into the chat, not a KEY=value).
// Redaction only touches this derived note: the stored chat is never rewritten.
const TOKEN_SHAPES = [
  [/\b(sk-[A-Za-z0-9_-]{8,})/g, '***'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})/g, '***'],
  [/\b(github_pat_[A-Za-z0-9_]{20,})/g, '***'],
  [/\b(xox[abp]-[A-Za-z0-9-]{10,})/g, '***'],
  [/\b(AIza[0-9A-Za-z_-]{20,})/g, '***'],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g, '***'],
];

/** A note leaves for another provider: recognised secrets are masked, never logged. */
export function redactNote(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of TOKEN_SHAPES) out = out.replace(pattern, replacement);
  return redactSecrets(out);
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+\n/g, '\n').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The other workspace's chat for this project (read straight from its folder: that engine is parked). */
export function otherChat(hub, from, projectId) {
  const store = new ChatStore(hub.chatDir(from), { limit: 250 });
  try {
    return store.read(projectId).messages;
  } catch {
    return [];
  }
}

const HEADER = (from) => `🔁 Konteks dari ${ENGINE_LABEL[from] ?? 'mesin sebelumnya'} (sesi sebelumnya di project ini). Teruskan pekerjaan dari sini; minta klarifikasi kalau ada yang belum jelas.`;

/**
 * The note an automatic engine switch carries (a model picked for the other engine): built from what the app
 * already holds — the other engine's prompts and answers, shortened, plus its last tool steps. Synchronous: no git,
 * no model call, no raw output. Thinking and raw tool payloads are never included.
 * @param {object[]} chat the source engine's messages (see otherChat)
 * @param {string} [from] the source engine (inferred from the rows when they carry it)
 * @returns {string} Markdown, at most MAX_TOTAL characters ('' when there is nothing to carry)
 */
export function bridgeNote(chat, from = (chat ?? []).findLast?.((m) => ENGINE_LABEL[m?.engine])?.engine ?? 'claude') {
  const list = Array.isArray(chat) ? chat : [];
  const talk = list.filter((m) => (m.kind === 'user' || m.kind === 'assistant') && String(m.text ?? '').trim());
  if (!talk.length) return '';
  const who = (m) => (m.kind === 'user' ? 'Saya' : (ENGINE_LABEL[from] ?? 'Mesin'));
  const lines = [];
  let total = 0;
  for (const m of talk.slice(-MAX_MESSAGES)) {
    const line = `**${who(m)}:** ${redactNote(clip(m.text, MAX_PER_MESSAGE))}`;
    if (total + line.length > MAX_TOTAL) break;
    lines.push(line);
    total += line.length;
  }
  const tools = list.filter((m) => m.kind === 'tool' && m.text && !m.sub).slice(-8).map((m) => `- ${redactNote(clip(m.text, 120))}`);
  const parts = [HEADER(from), '', `## Percakapan terakhir (${lines.length} pesan, dipadatkan)`, ...lines];
  if (tools.length) parts.push('', '## Langkah terakhir yang dijalankan', ...tools);
  return clip(parts.join('\n'), MAX_TOTAL);
}

export const otherEngine = (engine) => (engine === 'opencode' ? 'claude' : 'opencode');

/** The newest message time in a stored chat (0 when it has none). */
const lastTs = (list) => (Array.isArray(list) ? list : []).reduce((max, m) => (Number.isFinite(m?.ts) && m.ts > max ? m.ts : max), 0);

/**
 * Does an automatic switch to `to` still have something to carry? True when the other engine's chat has a message
 * newer than the last `contextBridge` note already written in `to`'s chat (so one switch bridges once, never again
 * while nothing new happened) and newer than `to`'s own conversation (a restart must not replay an old bridge
 * nobody asked for). Bridge notes themselves never count: going back and forth without new work carries nothing.
 * Pure and synchronous: it reads both stored chats, never a session or a model.
 */
export function needsBridge(hub, id, to) {
  const source = otherChat(hub, otherEngine(to), id).filter((m) => !m.contextBridge);
  const targetAll = otherChat(hub, to, id);
  const newest = lastTs(source);
  if (!newest) return false;
  return newest > lastTs(targetAll.filter((m) => m.contextBridge)) && newest > lastTs(targetAll.filter((m) => !m.contextBridge));
}
