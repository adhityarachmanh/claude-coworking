// Read-only views over Claude Code transcripts: full-text search across sessions (🔎 Cari percakapan)
// and a Markdown export of one session (⬇ Export .md). Only what was said is used — user prompts and
// assistant text — never thinking blocks or raw tool output. Every read is bounded (bytes per file,
// bytes overall, results), so a huge history can't stall the server.
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { isPrompt, listSessions, promptText, transcriptDir } from './transcripts.js';

export const SEARCH_LIMITS = Object.freeze({
  minQuery: 2,
  maxQuery: 200,
  maxResults: 100,
  defaultResults: 40,
  perSession: 5, // hits per session, so one long session doesn't fill the whole list
  sessions: 200, // newest sessions scanned per project
  fileBytes: 8 * 1024 * 1024, // tail of each transcript that is read
  totalBytes: 64 * 1024 * 1024, // across all files of one search (the scan is synchronous)
  context: 80, // characters of context on each side of a hit
});

export const EXPORT_LIMITS = Object.freeze({
  fileBytes: 64 * 1024 * 1024,
  markdownChars: 8 * 1024 * 1024,
  toolChars: 160,
});

// A Claude Code session id is a UUID. Strict here (the transcript name is built from it).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId = (id) => typeof id === 'string' && UUID.test(id);

export class ConversationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Lines of the last `bytes` of a file (the first, partial line is dropped when cut).
 * @returns {{ lines: string[], cut: boolean, read: number }}
 */
function readTail(file, bytes) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift();
    return { lines, cut: len < size, read: len };
  } finally {
    closeSync(fd);
  }
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The transcript of `sessionId` in this project's own folder: never a path outside it, never a symlink. */
export function transcriptFile(projectPath, sessionId) {
  if (!isSessionId(sessionId)) throw new ConversationError(400, 'sessionId tidak valid');
  const dir = path.resolve(transcriptDir(projectPath));
  const file = path.resolve(dir, `${sessionId}.jsonl`);
  if (path.dirname(file) !== dir) throw new ConversationError(400, 'sessionId tidak valid');
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    throw new ConversationError(404, 'Sesi tidak ditemukan');
  }
  if (!stat.isFile()) throw new ConversationError(404, 'Sesi tidak ditemukan');
  return file;
}

const assistantText = (e) =>
  (Array.isArray(e.message?.content) ? e.message.content : [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n')
    .trim();

/**
 * What was said in a transcript, in file order: { role, text, ts, messageId, tools }.
 * Assistant blocks of one API message are merged; sidechains (subagents) are skipped.
 */
function* said(lines, { tools = false } = {}) {
  let current = null;
  for (const line of lines) {
    if (!line) continue;
    const e = parse(line);
    if (!e || e.isSidechain) continue;
    const ts = Date.parse(e.timestamp) || 0;
    if (isPrompt(e)) {
      if (current) yield current;
      current = null;
      yield { role: 'user', text: promptText(e).trim(), ts, tools: [] };
    } else if (e.type === 'assistant') {
      const text = assistantText(e);
      const used = tools ? (e.message?.content ?? []).filter((b) => b?.type === 'tool_use').map(toolSummary) : [];
      if (!text && !used.length) continue;
      const id = e.message?.id;
      if (current && id && current.messageId === id) {
        if (text) current.text = current.text ? `${current.text}\n\n${text}` : text;
        current.tools.push(...used);
        continue;
      }
      if (current) yield current;
      current = { role: 'assistant', text, ts, messageId: id, tools: used };
    }
  }
  if (current) yield current;
}

// ---------- search ----------

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oneLine = (s) => s.replace(/\s+/g, ' ');

/** A hit with up to `context` characters around it, cut at word edges where possible. */
function snippet(text, index, length, context) {
  let from = Math.max(0, index - context);
  let to = Math.min(text.length, index + length + context);
  if (from > 0) {
    const space = text.indexOf(' ', from);
    if (space > -1 && space < index) from = space + 1;
  }
  if (to < text.length) {
    const space = text.lastIndexOf(' ', to);
    if (space > index + length) to = space;
  }
  return {
    before: (from > 0 ? '…' : '') + oneLine(text.slice(from, index)),
    match: oneLine(text.slice(index, index + length)),
    after: oneLine(text.slice(index + length, to)) + (to < text.length ? '…' : ''),
  };
}

/** Normalises a search request; throws ConversationError(400) for an unusable query. */
export function searchQuery(q) {
  const query = String(q ?? '').replace(/\s+/g, ' ').trim();
  if (query.length < SEARCH_LIMITS.minQuery) throw new ConversationError(400, `Kata kunci minimal ${SEARCH_LIMITS.minQuery} huruf`);
  return query.slice(0, SEARCH_LIMITS.maxQuery);
}

/**
 * Case-insensitive search through the sessions of one or more projects.
 * @param {{ id: string, path: string }[]} projects searched in the given order
 * @returns {{ query: string, results: object[], truncated: boolean, sessions: number }}
 */
export function searchSessions(projects, q, { limit = SEARCH_LIMITS.defaultResults } = {}) {
  const query = searchQuery(q);
  const max = Math.min(Math.max(1, Number(limit) || SEARCH_LIMITS.defaultResults), SEARCH_LIMITS.maxResults);
  const re = new RegExp(escapeRegExp(query), 'gi');
  // A raw line can only hold a hit if it contains the query (when the query survives JSON escaping as-is).
  const lowered = query.toLowerCase();
  const prefilter = !/["\\\u0000-\u001f]/.test(query) && /^[\x20-\x7e]*$/.test(query) ? lowered : null;
  const results = [];
  let budget = SEARCH_LIMITS.totalBytes;
  let truncated = false;
  let scanned = 0;
  outer: for (const project of projects) {
    for (const s of listSessions(project.path, SEARCH_LIMITS.sessions)) {
      if (results.length >= max || budget <= 0) {
        truncated = true;
        break outer;
      }
      let file;
      try {
        file = transcriptFile(project.path, s.id);
      } catch {
        continue;
      }
      let tail;
      try {
        tail = readTail(file, Math.min(SEARCH_LIMITS.fileBytes, budget));
      } catch {
        continue;
      }
      budget -= tail.read;
      if (tail.cut) truncated = true;
      scanned++;
      const lines = prefilter ? tail.lines.filter((l) => l.toLowerCase().includes(prefilter)) : tail.lines;
      let hits = 0;
      for (const m of said(lines)) {
        re.lastIndex = 0;
        const found = re.exec(m.text);
        if (!found) continue;
        results.push({
          projectId: project.id,
          sessionId: s.id,
          title: s.title,
          source: s.source,
          role: m.role,
          ts: m.ts || s.updated,
          snippet: snippet(m.text, found.index, found[0].length, SEARCH_LIMITS.context),
        });
        if (++hits >= SEARCH_LIMITS.perSession || results.length >= max) break;
      }
    }
  }
  return { query, results, truncated, sessions: scanned };
}

// ---------- export ----------

const TOOL_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'];

function toolSummary(block) {
  const input = block?.input && typeof block.input === 'object' ? block.input : {};
  const key = TOOL_FIELDS.find((k) => typeof input[k] === 'string' && input[k].trim());
  let detail = key ? oneLine(input[key]).trim() : '';
  if (detail.length > EXPORT_LIMITS.toolChars) detail = `${detail.slice(0, EXPORT_LIMITS.toolChars - 1)}…`;
  return { name: String(block?.name ?? 'tool').replace(/[^\w:.-]/g, '').slice(0, 60) || 'tool', detail };
}

/** Inline code that survives any backticks inside the text. */
function inlineCode(text) {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

const stamp = (ts) => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');

/** File name for the download: the title as a slug, plus the first 8 characters of the id. */
function fileName(title, sessionId) {
  const slug = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '')
    .toLowerCase();
  return `${slug || 'sesi'}-${sessionId.slice(0, 8)}.md`;
}

/**
 * One session as Markdown: title, dates, then each user prompt and assistant reply (no thinking),
 * optionally with a one-line summary of each tool call.
 * @returns {{ filename: string, markdown: string, messages: number, truncated: boolean }}
 */
export function exportSession(projectPath, sessionId, { tools = false, projectName = '' } = {}) {
  const file = transcriptFile(projectPath, sessionId);
  const meta = listSessions(projectPath, 500).find((s) => s.id === sessionId);
  const { lines, cut } = readTail(file, EXPORT_LIMITS.fileBytes);
  const messages = [...said(lines, { tools })];
  const title = oneLine(meta?.title ?? messages.find((m) => m.role === 'user')?.text ?? 'Percakapan').trim() || 'Percakapan';
  const first = messages.find((m) => m.ts)?.ts;
  const last = messages.findLast((m) => m.ts)?.ts;
  const head = [
    `# ${title.replace(/^#+\s*/, '')}`,
    '',
    `- **Sesi:** \`${sessionId}\``,
    ...(projectName ? [`- **Project:** ${oneLine(projectName)}`] : []),
    ...(first ? [`- **Tanggal:** ${stamp(first)}${last && last !== first ? ` — ${stamp(last)}` : ''}`] : []),
    `- **Pesan:** ${messages.length}`,
    ...(cut ? ['', '> ⚠ Transcript sangat besar: hanya bagian terakhirnya yang diekspor.'] : []),
  ];
  const parts = [head.join('\n')];
  let size = parts[0].length;
  let truncated = cut;
  for (const m of messages) {
    const lines = [`## ${m.role === 'user' ? '🧑 Kamu' : '✳ Claude'}${m.ts ? ` · ${stamp(m.ts)}` : ''}`];
    if (m.text) lines.push('', m.text);
    if (m.tools.length) lines.push('', ...m.tools.map((t) => `- 🔧 **${t.name}**${t.detail ? ` ${inlineCode(t.detail)}` : ''}`));
    const block = lines.join('\n');
    if (size + block.length > EXPORT_LIMITS.markdownChars) {
      parts.push('> ⚠ Export dipotong: percakapan melebihi batas ukuran.');
      truncated = true;
      break;
    }
    parts.push(block);
    size += block.length + 2;
  }
  return { filename: fileName(title, sessionId), markdown: `${parts.join('\n\n---\n\n')}\n`, messages: messages.length, truncated };
}
