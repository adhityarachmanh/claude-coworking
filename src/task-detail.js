// Live detail of a background task for the task monitor (⧗ Tugas latar): what a subagent is doing, step by step.
// Read-only. Claude Code writes every subagent's transcript next to the session's own:
//   <projects dir>/<encoded project path>/<sessionId>/subagents/agent-<agentId>.jsonl (+ .meta.json: toolUseId, agentType)
// Only ever reads inside that folder: the client sends a task id, never a path; names come from readdir and are
// checked again after resolving. The answer is a short summary of the last steps, never the raw transcript.
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describeTool } from './roles.js';
import { PROJECTS_DIR, transcriptDir } from './transcripts.js';
import { clip, truncate } from './util.js';

export const DETAIL_MAX_STEPS = 200; // newest steps returned
export const DETAIL_MAX_BYTES = 1024 * 1024; // read from the end of the transcript (one Write of a big file is one long line)
export const DETAIL_MAX_ANSWER = 200 * 1024; // the JSON sent to the browser
const META_MAX_BYTES = 16 * 1024;
const HEAD_BYTES = 32 * 1024;
const MAX_FILES = 500; // subagents scanned per session (newest first)
const SESSION_ID = /^[0-9a-f-]{36}$/i;
const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,80})\.jsonl$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const HIDDEN_TOOLS = new Set(['SubagentHandback']); // harness plumbing: its message is the final report

/** Inside `root` (resolved, not the root itself)? */
const inside = (root, p) => {
  const r = path.resolve(root);
  const x = path.resolve(p);
  return x !== r && x.startsWith(r + path.sep);
};

/** A plain file (no symlink pointing out of the folder), or null. */
function fileStat(file) {
  try {
    const st = lstatSync(file);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** Up to `bytes` from the start or the end of a file, with the cut line dropped; `cut` = something was left out. */
function readPart(file, { fromEnd, bytes }) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    const lines = buf.toString('utf8').split('\n');
    const cut = len < size;
    if (cut && fromEnd) lines.shift();
    if (cut && !fromEnd) lines.pop();
    return { lines, cut };
  } finally {
    closeSync(fd);
  }
}

function parse(line) {
  if (!line.trim()) return null;
  try {
    const e = JSON.parse(line);
    return e && typeof e === 'object' ? e : null;
  } catch {
    return null;
  }
}

function readMeta(jsonl) {
  const file = jsonl.replace(/\.jsonl$/, '.meta.json');
  if (!fileStat(file)) return null;
  try {
    return parse(readPart(file, { fromEnd: false, bytes: META_MAX_BYTES }).lines.join('\n'));
  } catch {
    return null;
  }
}

/** The subagents folder of a session (null if the ids don't check out or it would leave the projects folder). */
export function subagentsDir(projectPath, sessionId, root = PROJECTS_DIR) {
  if (!SESSION_ID.test(String(sessionId ?? ''))) return null;
  const dir = path.join(transcriptDir(projectPath), sessionId, 'subagents');
  return inside(root, dir) ? dir : null;
}

/**
 * The transcript of the subagent behind `task`: by the Agent call's tool_use_id in the meta file, else by the task
 * id (Claude Code uses the agent id as task id), else the newest one with the same description and type.
 */
export function findSubagentFile(projectPath, sessionId, task, root = PROJECTS_DIR) {
  const dir = subagentsDir(projectPath, sessionId, root);
  if (!dir) return null;
  let names;
  try {
    names = readdirSync(dir).filter((n) => AGENT_FILE.test(n));
  } catch {
    return null;
  }
  const files = names
    .map((name) => {
      const file = path.join(dir, name);
      const st = inside(dir, file) ? fileStat(file) : null;
      return st && { file, name, agentId: AGENT_FILE.exec(name)[1], mtime: st.mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES);
  const withMeta = files.map((f) => ({ ...f, meta: readMeta(f.file) }));
  const match =
    (task.toolUseId && withMeta.find((f) => f.meta?.toolUseId === task.toolUseId)) ||
    (SAFE_ID.test(String(task.id ?? '')) && withMeta.find((f) => f.agentId === task.id)) ||
    (task.description && withMeta.find((f) => f.meta?.description === task.description && (!task.agent || f.meta?.agentType === task.agent))) ||
    null;
  return match ? { file: match.file, agentId: match.agentId, agentType: match.meta?.agentType ?? null, mtime: match.mtime } : null;
}

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
const tsOf = (e) => Date.parse(e.timestamp) || null;

/** The part of a tool's input worth showing in full under its one-line label. */
function toolDetail(name, input) {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return clip(input.command, 300);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return truncate(input.file_path, 300);
    case 'NotebookEdit':
      return truncate(input.notebook_path, 300);
    case 'Grep':
    case 'Glob':
      return truncate([input.pattern, input.path, input.glob].filter(Boolean).join('  ·  '), 300);
    case 'WebFetch':
      return truncate(input.url, 300);
    case 'Agent':
    case 'Task':
      return truncate(input.description ?? input.prompt, 300);
    default:
      return '';
  }
}

/**
 * The last steps of a subagent transcript, oldest first: tool calls (label as in the chat, ok/error once their
 * result is in) and its short messages. `result` = the final report (SubagentHandback), `lastText` its last message.
 */
export function readAgentSteps(file, { maxSteps = DETAIL_MAX_STEPS, maxBytes = DETAIL_MAX_BYTES } = {}) {
  const { lines, cut } = readPart(file, { fromEnd: true, bytes: maxBytes });
  const steps = [];
  const byTool = new Map();
  let result = null;
  let lastText = null;
  for (const line of lines) {
    const e = parse(line);
    const content = e?.message?.content;
    if (!e || !Array.isArray(content)) continue;
    const ts = tsOf(e);
    if (e.type === 'assistant') {
      for (const b of content) {
        if (b?.type === 'tool_use' && typeof b.name === 'string') {
          const input = b.input && typeof b.input === 'object' ? b.input : {};
          if (HIDDEN_TOOLS.has(b.name)) {
            if (input.message) result = clip(String(input.message), 8000);
            continue;
          }
          const step = { type: 'tool', tool: truncate(b.name, 80), label: truncate(describeTool(b.name, input), 140), detail: toolDetail(b.name, input) || undefined, status: 'running', ts };
          steps.push(step);
          if (b.id) byTool.set(b.id, step);
        } else if (b?.type === 'text' && String(b.text ?? '').trim()) {
          lastText = String(b.text);
          steps.push({ type: 'text', text: clip(lastText.trim(), 400), ts });
        }
      }
    } else if (e.type === 'user') {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue;
        const step = byTool.get(b.tool_use_id);
        if (step) step.status = b.is_error ? 'error' : 'ok';
      }
    }
  }
  let kept = steps.slice(Math.max(0, steps.length - maxSteps));
  // Each step is already short; this only bounds the worst case (200 long messages) for a phone on WiFi.
  while (kept.length && JSON.stringify(kept).length > DETAIL_MAX_ANSWER - 20_000) kept = kept.slice(Math.ceil(kept.length / 10));
  return { steps: kept, truncated: cut || kept.length < steps.length, result, lastText: lastText && clip(lastText.trim(), 8000) };
}

/** The instruction the subagent was given (its first user message), shortened. */
function readPrompt(file) {
  for (const line of readPart(file, { fromEnd: false, bytes: HEAD_BYTES }).lines) {
    const e = parse(line);
    if (e?.type !== 'user' || e.isMeta) continue;
    const text = textOf(e.message?.content).trim();
    if (text) return clip(text, 1200);
  }
  return null;
}

/**
 * POST /api/projects/:id/task-detail. `task` is one of the session's own status.tasks (looked up by the caller).
 * Shell tasks: their command (the output itself comes from task-output). Agent tasks: the transcript summary.
 */
export function taskDetail(projectPath, sessionId, task, opts = {}) {
  const base = { taskId: task.id, kind: task.kind === 'agent' ? 'agent' : 'shell', status: task.status ?? null };
  if (base.kind === 'shell') return { ...base, command: task.command ?? null, steps: [], truncated: false, result: null };
  const found = findSubagentFile(projectPath, sessionId, task, opts.root ?? PROJECTS_DIR);
  if (!found) return { ...base, found: false, steps: [], truncated: false, result: null, prompt: null };
  const { steps, truncated, result, lastText } = readAgentSteps(found.file, opts);
  const done = task.status && task.status !== 'running' && task.status !== 'pending';
  return {
    ...base,
    found: true,
    agentId: found.agentId,
    agentType: found.agentType,
    prompt: readPrompt(found.file),
    steps,
    truncated,
    // The report it handed back; once it has ended without one, its last message is the closest thing.
    result: result ?? (done ? lastText : null),
    updatedAt: Math.round(found.mtime),
  };
}
