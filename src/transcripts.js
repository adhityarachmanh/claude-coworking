// Lists past Claude Code sessions of a project (CLI and web) and extracts their chat history,
// so a session can be continued from the web with its earlier conversation visible.
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { truncate } from './util.js';

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f-]{36}$/i;

/** Claude Code stores transcripts in a folder named after the path, non-alphanumerics → '-'. */
export function transcriptDir(projectPath) {
  return path.join(ROOT, path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-'));
}

function readSlice(file, fromEnd, bytes) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    const lines = buf.toString('utf8').split('\n');
    // Drop the partial line at the cut.
    if (fromEnd && len < size) lines.shift();
    if (!fromEnd && len < size) lines.pop();
    return lines;
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

const promptText = (e) =>
  typeof e.message?.content === 'string' ? e.message.content : (e.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

/** A real user prompt (typed in the CLI or sent from the web), not a reminder/command/hand-back. */
function isPrompt(e) {
  if (e?.type !== 'user' || e.isMeta || e.isSidechain) return false;
  if (Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === 'tool_result')) return false;
  if (e.promptSource && !['typed', 'sdk'].includes(e.promptSource)) return false;
  const text = promptText(e).trim();
  return Boolean(text) && !text.startsWith('<');
}

export function listSessions(projectPath, limit = 30) {
  const dir = transcriptDir(projectPath);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && SESSION_ID.test(f.slice(0, -6)));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const file = path.join(dir, f);
      const stat = statSync(file);
      return { id: f.slice(0, -6), file, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ id, file, mtime, size }) => {
      let first = null;
      let entrypoint = null;
      for (const line of readSlice(file, false, HEAD_BYTES)) {
        const e = parse(line);
        if (!e) continue;
        entrypoint ??= e.entrypoint ?? null;
        if (isPrompt(e)) {
          first = promptText(e);
          break;
        }
      }
      let title = null;
      let prompts = 0;
      for (const line of readSlice(file, true, HEAD_BYTES)) {
        const e = parse(line);
        if (e?.type === 'ai-title' && (e.title || e.aiTitle)) title = e.title ?? e.aiTitle;
        if (isPrompt(e)) prompts++;
      }
      return {
        id,
        title: truncate(title ?? first ?? '(tanpa judul)', 90),
        source: entrypoint === 'sdk-cli' ? 'web' : 'cli',
        updated: mtime,
        sizeKb: Math.round(size / 1024),
        recentPrompts: prompts,
      };
    });
}

/** Last user prompts and assistant replies of a session, as chat messages. */
export function sessionHistory(projectPath, sessionId, limit = 40) {
  if (!SESSION_ID.test(sessionId)) return [];
  const file = path.join(transcriptDir(projectPath), `${sessionId}.jsonl`);
  const messages = [];
  let current = null; // merge blocks of one assistant API message
  let lines;
  try {
    lines = readSlice(file, true, TAIL_BYTES);
  } catch {
    return [];
  }
  for (const line of lines) {
    const e = parse(line);
    if (!e || e.isSidechain) continue;
    const ts = Date.parse(e.timestamp) || Date.now();
    if (isPrompt(e)) {
      messages.push({ kind: 'user', text: promptText(e), source: e.entrypoint === 'sdk-cli' ? 'web' : 'cli', ts, history: true });
      current = null;
    } else if (e.type === 'assistant') {
      const text = (e.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
      if (!text) continue;
      if (current && current.messageId === e.message?.id) current.text += `\n\n${text}`;
      else {
        current = { kind: 'assistant', text, ts, messageId: e.message?.id, history: true };
        messages.push(current);
      }
    }
  }
  return messages.slice(-limit).map(({ messageId, ...m }) => m);
}
