// Lists past Claude Code sessions of a project (CLI and web) and extracts their chat history,
// so a session can be continued from the web with its earlier conversation visible.
import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAttachmentBlock, safeName } from '../public/js/core/attachment-rules.js';
import { truncate } from './util.js';

// Overridable so tests can use a throwaway folder.
const ROOT = process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects');
/** Where Claude Code keeps its transcripts (~/.claude/projects, or CLAUDE_PROJECTS_DIR). */
export const PROJECTS_DIR = ROOT;
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

// `!command` output the web app sends ahead of a prompt (the CLI's own tags): not part of what was typed.
const SHELL_CONTEXT = /^(?:\s*<bash-input>[\s\S]*?<\/bash-input>\s*<bash-stdout>[\s\S]*?<\/bash-stdout>(?:<bash-stderr>[\s\S]*?<\/bash-stderr>)?)+\s*/;

// 📎 Text attachments travel as their own text blocks (src/attachments.js): they are not what was typed.
export const promptText = (e) =>
  (typeof e.message?.content === 'string'
    ? e.message.content
    : (e.message?.content ?? []).filter((b) => b.type === 'text' && !parseAttachmentBlock(b.text)).map((b) => b.text).join('\n')
  ).replace(SHELL_CONTEXT, '');

const base64Bytes = (data) => {
  const s = String(data ?? '');
  return Math.max(0, Math.floor((s.length * 3) / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0));
};

/** 📎 A prompt's attachments as chat chips ({ kind, name, size }); the content itself stays out of the bubble. */
export function promptAttachments(e) {
  if (!Array.isArray(e.message?.content)) return [];
  let images = 0;
  return e.message.content.flatMap((b) => {
    if (b.type === 'image') return [{ kind: 'image', name: `gambar-${++images}`, size: base64Bytes(b.source?.data) }];
    if (b.type === 'document') return [{ kind: 'pdf', name: safeName(b.title || 'dokumen.pdf'), size: base64Bytes(b.source?.data) }];
    const att = b.type === 'text' ? parseAttachmentBlock(b.text) : null;
    return att ? [{ kind: 'text', name: safeName(att.name), size: att.size }] : [];
  });
}

/** A real user prompt (typed in the CLI or sent from the web), not a reminder/command/hand-back. */
export function isPrompt(e) {
  if (e?.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary) return false;
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
      let customTitle = null; // set with /rename: wins over the generated title, as in the CLI
      let prompts = 0;
      for (const line of readSlice(file, true, HEAD_BYTES)) {
        const e = parse(line);
        if (e?.type === 'ai-title' && (e.title || e.aiTitle)) title = e.title ?? e.aiTitle;
        if (e?.type === 'custom-title' && e.customTitle) customTitle = e.customTitle;
        if (isPrompt(e)) prompts++;
      }
      return {
        id,
        title: truncate(customTitle ?? title ?? first ?? '(tanpa judul)', 90),
        source: entrypoint === 'sdk-cli' ? 'web' : 'cli',
        updated: mtime,
        sizeKb: Math.round(size / 1024),
        recentPrompts: prompts,
      };
    });
}

const CHAIN_BYTES = 64 * 1024 * 1024;

/**
 * The prompts of a session's current conversation, oldest first: the chain from the newest entry
 * (or `leaf`, right after a rewind) back through parentUuid — what Esc Esc in the CLI lists.
 * Branches abandoned by an earlier rewind are not on the chain, so they drop out.
 * `parentUuid` is where a conversation rewind to before that prompt resumes (--resume-session-at).
 */
export function promptChain(projectPath, sessionId, { leaf: leafUuid = null } = {}) {
  if (!SESSION_ID.test(sessionId)) return [];
  let lines;
  try {
    lines = readSlice(path.join(transcriptDir(projectPath), `${sessionId}.jsonl`), true, CHAIN_BYTES);
  } catch {
    return [];
  }
  const byUuid = new Map();
  let leaf = null;
  for (const line of lines) {
    const e = parse(line);
    if (!e?.uuid || e.isSidechain) continue;
    byUuid.set(e.uuid, e);
    if (e.type === 'user' || e.type === 'assistant' || e.type === 'system') leaf = e;
  }
  if (leafUuid) leaf = byUuid.get(leafUuid) ?? leaf;
  const prompts = [];
  const seen = new Set();
  // After a compaction the chain continues through logicalParentUuid.
  for (let e = leaf; e && !seen.has(e.uuid); e = byUuid.get(e.parentUuid ?? e.logicalParentUuid)) {
    seen.add(e.uuid);
    if (isPrompt(e)) prompts.push({ uuid: e.uuid, parentUuid: e.parentUuid ?? null, text: promptText(e).trim(), ts: Date.parse(e.timestamp) || 0 });
  }
  return prompts.reverse();
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
      const attachments = promptAttachments(e);
      messages.push({ kind: 'user', text: promptText(e), source: e.entrypoint === 'sdk-cli' ? 'web' : 'cli', ts, history: true, ...(attachments.length && { attachments }) });
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
