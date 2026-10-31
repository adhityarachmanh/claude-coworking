// Translates Claude Code `--output-format stream-json` messages into office events and chat messages.
import { agentRole, describeTool, extractTodos, inferRole, screenFor } from './roles.js';
import { clip, firstSentence, truncate } from './util.js';

const DELEGATE_TOOLS = new Set(['Agent', 'Task']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Who writes product code — the people QA hands a bug back to.
const BUILDER_ROLES = new Set(['frontend', 'backend', 'dba', 'devops', 'ui-ux', 'security', 'freelancer']);
const IGNORED_TOOLS = new Set(['SubagentHandback']); // harness plumbing, not work
const ASYNC_LAUNCH = /async agent launched|launched successfully|running in the background/i;
const THINK_THROTTLE_MS = 4000;
const STREAM_FLUSH_MS = 80;
const OUTPUT_LIMIT = 3000;

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[gambar]' : '')).join('\n');
  return '';
}

/** What the expandable tool row shows as "input" (like the CLI's tool header + diff). */
function inputDetail(tool, input = {}) {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return { command: clip(input.command, 2000), description: input.description };
    case 'Edit':
      return { file: input.file_path, old: clip(input.old_string, 2000), new: clip(input.new_string, 2000) };
    case 'MultiEdit':
      return { file: input.file_path, edits: (input.edits ?? []).slice(0, 5).map((e) => ({ old: clip(e.old_string, 800), new: clip(e.new_string, 800) })) };
    case 'Write':
      return { file: input.file_path, content: clip(input.content, 2000) };
    case 'Read':
      return { file: input.file_path, range: input.offset ? `baris ${input.offset}–${input.offset + (input.limit ?? 2000)}` : undefined };
    case 'NotebookEdit':
      return { file: input.notebook_path, content: clip(input.new_source, 2000) };
    case 'Grep':
      return { pattern: input.pattern, path: input.path, glob: input.glob };
    case 'Glob':
      return { pattern: input.pattern, path: input.path };
    case 'WebFetch':
      return { url: input.url, prompt: input.prompt };
    case 'WebSearch':
      return { query: input.query };
    case 'TodoWrite':
      return { todos: (input.todos ?? []).map((t) => ({ content: t.content, status: t.status })) };
    default:
      return { json: clip(JSON.stringify(input, null, 2), 1500) };
  }
}

const lastNumber = (text, pattern) => {
  const all = [...text.matchAll(pattern)];
  return all.length ? Number(all.at(-1)[1]) : null;
};

/**
 * Pass/fail counts from a test runner's output (node:test, TAP, jest, vitest, pest, pytest,
 * mocha, cargo, go, phpunit). Null when the output has no recognizable summary.
 */
export function parseTestSummary(output) {
  const text = String(output ?? '').slice(-8000);
  let m = text.match(/^[ℹ#] pass (\d+)[\s\S]*?^[ℹ#] fail (\d+)/m); // node --test, TAP
  if (m) return { passed: Number(m[1]), failed: Number(m[2]) };
  m = text.match(/\bOK \((\d+) tests?\b/); // phpunit, all green
  if (m) return { passed: Number(m[1]), failed: 0 };
  m = text.match(/\bTests: (\d+), Assertions: \d+(?:, Errors: (\d+))?(?:, Failures: (\d+))?/); // phpunit, failures
  if (m) {
    const failed = Number(m[2] ?? 0) + Number(m[3] ?? 0);
    return { passed: Number(m[1]) - failed, failed };
  }
  const passed = lastNumber(text, /(\d+) (?:passed|passing)\b/g);
  const failed = lastNumber(text, /(\d+) (?:failed|failing)\b/g);
  if (passed == null && failed == null) {
    const goFails = (text.match(/^--- FAIL:/gm) ?? []).length; // go test
    if (goFails) return { passed: (text.match(/^--- PASS:/gm) ?? []).length, failed: goFails };
    return null;
  }
  return { passed: passed ?? 0, failed: failed ?? 0 };
}

export class StreamTranslator {
  /** @param {{ office(evt): void, chat(msg): string, updateChat(id: string, patch: object): void }} sink */
  constructor(sink) {
    this.sink = sink;
    this.tools = new Map(); // tool_use_id -> { name, input, role, label, screen, chatId, agent?, background? }
    this.agentRoles = new Map(); // Agent tool_use_id -> office role of that subagent
    this.tasks = new Map(); // TaskCreate id -> { subject, status }
    this.lastBuilder = null; // role that last edited product code (who gets QA's bug report)
    // One chat bubble per API message: `done` = finished text blocks, `live` = block being streamed.
    this.lastAssistant = null;
    this.streamMessageId = null;
    this.flushTimer = null;
    this.lastThink = 0;
  }

  /** Role of whoever issued this tool call (used for permission prompts). */
  roleOf(toolUseId) {
    return this.tools.get(toolUseId)?.role;
  }

  /** Lets a caller that knows a subagent's type up front (CLI mirror) attribute its work. */
  registerAgent(toolUseId, agentType) {
    if (!this.agentRoles.has(toolUseId)) this.agentRoles.set(toolUseId, agentRole(agentType));
  }

  /** Marks a (background) subagent as done; it walks back to whoever delegated with its report. */
  finishAgent(toolUseId, failed = false, report = '') {
    const info = this.tools.get(toolUseId);
    if (!info?.agent) return;
    this.tools.delete(toolUseId);
    this.sink.updateChat(info.chatId, { status: failed ? 'fail' : 'ok', ...(report ? { output: clip(report, OUTPUT_LIMIT) } : {}) });
    this.sink.office({
      kind: 'agent_stop',
      role: info.role,
      label: info.label,
      from: info.from,
      failed,
      ...(report ? { report: firstSentence(report, 70) } : {}),
    });
  }

  handle(msg) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'compact_boundary') this.sink.chat({ kind: 'info', text: 'Konteks percakapan dipadatkan (compact).' });
        else if (msg.subtype === 'thinking_tokens') this.think(msg.parent_tool_use_id);
        break;
      case 'stream_event':
        this.onStream(msg);
        break;
      case 'assistant':
        this.onAssistant(msg);
        break;
      case 'user':
        this.onUser(msg);
        break;
      case 'result':
        this.onResult(msg);
        break;
      case 'rate_limit_event': {
        const info = msg.rate_limit_info ?? {};
        if (info.status && !info.status.startsWith('allowed')) {
          const reset = info.resetsAt ? ` — reset ${new Date(info.resetsAt * 1000).toLocaleTimeString('id-ID')}` : '';
          this.sink.chat({ kind: 'info', text: `Batas pemakaian: ${info.status}${reset}` });
        }
        break;
      }
    }
  }

  parentRole(parentId) {
    return parentId ? (this.agentRoles.get(parentId) ?? 'freelancer') : null;
  }

  think(parentId) {
    const now = Date.now();
    if (now - this.lastThink < THINK_THROTTLE_MS) return;
    this.lastThink = now;
    this.sink.office({ kind: 'think', role: this.parentRole(parentId) ?? 'claude' });
  }

  // ---------- assistant text (streamed word by word, then finalized) ----------

  bubbleFor(messageId) {
    if (this.lastAssistant?.messageId === messageId && messageId) return this.lastAssistant;
    const chatId = this.sink.chat({ kind: 'assistant', text: '', streaming: true });
    this.lastAssistant = { messageId, chatId, done: '', live: '' };
    return this.lastAssistant;
  }

  bubbleText(b) {
    return [b.done, b.live].filter(Boolean).join('\n\n');
  }

  onStream(msg) {
    if (msg.parent_tool_use_id) return; // subagents speak through office bubbles only
    const e = msg.event ?? {};
    if (e.type === 'message_start') {
      this.streamMessageId = e.message?.id ?? null;
    } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      const bubble = this.bubbleFor(this.streamMessageId);
      bubble.live += e.delta.text;
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          if (this.lastAssistant) this.sink.updateChat(this.lastAssistant.chatId, { text: this.bubbleText(this.lastAssistant), streaming: true });
        }, STREAM_FLUSH_MS);
      }
    }
  }

  onAssistant(msg) {
    const parentId = msg.parent_tool_use_id ?? null;
    const parentRole = this.parentRole(parentId);
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) this.onText(block.text, parentId, parentRole, msg.message.id);
      else if (block.type === 'thinking') this.think(parentId);
      else if (block.type === 'tool_use') this.onToolUse(block, parentRole);
    }
  }

  onText(text, parentId, parentRole, messageId) {
    if (parentId) {
      this.sink.office({ kind: 'say', role: parentRole, text: firstSentence(text) });
      return;
    }
    // The finished block replaces whatever was streamed for it.
    const bubble = this.bubbleFor(messageId);
    bubble.done = bubble.done ? `${bubble.done}\n\n${text}` : text;
    bubble.live = '';
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.sink.updateChat(bubble.chatId, { text: bubble.done, streaming: false });
    this.sink.office({ kind: 'say', role: 'claude', text: firstSentence(text) });
  }

  closeBubble() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const b = this.lastAssistant;
    if (b?.live) this.sink.updateChat(b.chatId, { text: this.bubbleText(b), streaming: false });
    else if (b && !b.done) this.sink.updateChat(b.chatId, { text: '', streaming: false });
    this.lastAssistant = null;
  }

  // ---------- tools ----------

  onToolUse(block, parentRole) {
    const input = block.input ?? {};
    if (IGNORED_TOOLS.has(block.name)) return;
    if (DELEGATE_TOOLS.has(block.name)) {
      const agentType = input.subagent_type ?? 'general-purpose';
      const role = agentRole(agentType);
      const from = parentRole ?? 'claude'; // a subagent can hand work to another specialist
      const label = truncate(input.description ?? input.prompt, 80);
      this.agentRoles.set(block.id, role);
      const chatId = this.sink.chat({ kind: 'delegate', role, from, agentType, text: label, status: 'running', input: { prompt: clip(input.prompt, 3000) } });
      this.tools.set(block.id, { name: block.name, role, from, label, chatId, agent: true, background: Boolean(input.run_in_background) });
      this.sink.office({ kind: 'delegate', role, from, label, agentType });
      return;
    }

    const role = parentRole ?? inferRole(block.name, input);
    if (EDIT_TOOLS.has(block.name) && BUILDER_ROLES.has(role)) this.lastBuilder = role;
    // Planning happens around a table: the PM and tech lead meet before work starts / to present it.
    if (block.name === 'EnterPlanMode') this.sink.office({ kind: 'huddle', role: 'pm', roles: ['pm', 'architect', 'ba'], label: 'Susun rencana dulu sebelum eksekusi' });
    if (block.name === 'ExitPlanMode') this.sink.office({ kind: 'huddle', role: 'pm', roles: ['pm', 'architect'], label: 'Rencana siap, minta persetujuan' });
    const label = describeTool(block.name, input);
    const screen = screenFor(block.name, input);
    const chatId = this.sink.chat({
      kind: 'tool',
      role,
      tool: block.name,
      text: label,
      status: 'running',
      input: inputDetail(block.name, input),
      ...(parentRole ? { sub: true } : {}),
    });
    this.tools.set(block.id, { name: block.name, input, role, label, screen, chatId });
    this.sink.office({ kind: 'tool_start', role, label, tool: block.name, screen, inferred: !parentRole });

    const todos = extractTodos(block.name, input);
    if (todos) this.sink.office({ kind: 'board', items: todos });
    if (block.name === 'TaskUpdate' && input.taskId != null) {
      const task = this.tasks.get(String(input.taskId));
      if (task) {
        if (input.status) task.status = input.status;
        if (input.subject) task.subject = input.subject;
        this.emitTasks();
      }
    }
  }

  emitTasks() {
    const items = [...this.tasks.values()]
      .filter((t) => t.status !== 'deleted')
      .map((t) => ({ content: truncate(t.subject, 60), status: t.status }));
    this.sink.office({ kind: 'board', items });
  }

  onUser(msg) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const info = this.tools.get(block.tool_use_id);
      if (!info) continue;
      const text = resultText(block.content);
      const failed = Boolean(block.is_error);

      if (info.agent) {
        // A background agent "returns" immediately but keeps working; it finishes later.
        if (!failed && ASYNC_LAUNCH.test(text)) {
          info.background = true;
          continue;
        }
        this.finishAgent(block.tool_use_id, failed, text);
        continue;
      }

      this.tools.delete(block.tool_use_id);
      this.sink.updateChat(info.chatId, { status: failed ? 'fail' : 'ok', output: clip(text, OUTPUT_LIMIT) });
      this.sink.office({ kind: failed ? 'tool_fail' : 'tool_end', role: info.role, label: info.label, tool: info.name, screen: info.screen });

      // A test run: QA cheers on green, or takes the bug to whoever last touched the code.
      if (info.screen === 'tests') {
        const summary = parseTestSummary(text);
        if (summary) {
          const to = summary.failed && this.lastBuilder !== info.role ? this.lastBuilder : null;
          const label = summary.failed ? `${summary.failed} test gagal` : `${summary.passed} test lulus`;
          this.sink.office({ kind: 'tests', role: info.role, ...summary, label, ...(to ? { to } : {}) });
        }
      }

      if (info.name === 'TaskCreate' && !failed) {
        const id = text.match(/#(\d+)/)?.[1] ?? text.match(/\btask\s+(\d+)/i)?.[1];
        if (id) {
          this.tasks.set(id, { subject: info.input.subject ?? info.label, status: 'pending' });
          this.emitTasks();
        }
      }
    }
  }

  onResult(msg) {
    this.closeBubble();
    const activeRoles = [];
    for (const [id, info] of this.tools) {
      if (info.agent && info.background) activeRoles.push(info.role);
      else {
        // Never got a result (interrupted or denied): close the line out.
        this.sink.updateChat(info.chatId, { status: 'cancel' });
        if (info.agent) this.sink.office({ kind: 'agent_stop', role: info.role, label: info.label });
        this.tools.delete(id);
      }
    }
    const ok = !msg.is_error && msg.subtype === 'success';
    if (msg.quiet && ok) {
      // CLI mirror: a turn ended without a timing record; close it without a stats line.
      this.sink.office({ kind: 'stop', role: 'claude', label: 'Selesai', activeRoles });
      return;
    }
    const u = msg.usage ?? {};
    const context = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    this.sink.chat({
      kind: 'result',
      ok,
      text: ok ? '' : truncate(msg.result ?? msg.subtype, 400),
      meta: {
        durationMs: msg.duration_ms,
        turns: msg.num_turns,
        tokensIn: context || undefined,
        tokensOut: u.output_tokens || undefined,
        costUsd: msg.total_cost_usd,
        denials: msg.permission_denials?.length ?? 0,
      },
    });
    const kind = ok ? 'stop' : msg.subtype === 'interrupted' ? 'halt' : 'error';
    this.sink.office({ kind, role: 'claude', label: ok ? 'Selesai' : 'Berhenti', activeRoles });
  }
}
