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

/** Todo items for the pinned list above the composer (full text, unlike the office board). */
function todoItems(todos) {
  return todos.map((t) => ({ content: clip(t.content, 300), activeForm: t.activeForm ? clip(t.activeForm, 300) : undefined, status: t.status }));
}

export class StreamTranslator {
  /**
   * @param {{ office(evt): void, chat(msg): string, updateChat(id: string, patch: object): void, status?(patch: object): void }} sink
   * `status` (optional) receives live session state: `todos` and `context` ({ used, window }).
   */
  constructor(sink) {
    this.sink = sink;
    this.tools = new Map(); // tool_use_id -> { name, input, role, label, screen, chatId, agent?, background? }
    this.toolRoles = new Map(); // tool_use_id -> role, kept after the call returns (background tasks point back at it)
    this.bgShellRoles = []; // roles of `run_in_background` shells whose task hasn't been seen yet
    this.agentRoles = new Map(); // Agent tool_use_id -> office role of that subagent
    this.tasks = new Map(); // TaskCreate id -> { subject, status }
    this.lastBuilder = null; // role that last edited product code (who gets QA's bug report)
    // One chat bubble per API message: `done` = finished text blocks, `live` = block being streamed.
    this.lastAssistant = null;
    this.streamMessageId = null;
    this.flushTimer = null;
    this.lastThink = 0;
    this.liveThinking = null; // { chatId, text } while a thinking block streams
    this.contextUsed = 0; // tokens in the context of the latest main-thread API call
    this.contextWindow = 0; // from the result's modelUsage (or /context); kept across turns
    this.retryChatId = null; // one "retrying…" line per turn, updated in place
    this.bgTasks = new Map(); // task_id -> background/foreground task (Bash, subagent) for /tasks
  }

  status(patch) {
    this.sink.status?.(patch);
  }

  /**
   * Who is at work right now: open tool calls and running subagents per role ({ qa: { tools: 1, agents: 0 } }).
   * Sent as status (part of every snapshot) so an office rebuilt after a page refresh keeps those characters
   * typing — replayed history is not live and doesn't restart animations by itself.
   */
  emitWorking() {
    const working = {};
    for (const info of this.tools.values()) {
      const w = (working[info.role] ??= { tools: 0, agents: 0 });
      if (info.agent) w.agents++;
      else w.tools++;
      w.label = info.label; // the latest one (insertion order): shown on the team card / monitor after a refresh
      if (info.screen) w.screen = info.screen;
    }
    // Shell commands left running in the background: their tool call already "returned", the work goes on.
    for (const t of this.bgTasks.values()) {
      if (t.kind !== 'shell' || t.status !== 'running' || !t.role) continue;
      if (t.toolUseId && this.tools.has(t.toolUseId)) continue; // still a foreground call, counted above
      const w = (working[t.role] ??= { tools: 0, agents: 0 });
      w.tools++;
      w.label ??= t.description ? `⏳ ${t.description}` : '⏳ Perintah di latar belakang';
      w.screen ??= 'terminal';
    }
    this.status({ working });
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
    this.emitWorking();
  }

  handle(msg) {
    switch (msg.type) {
      case 'system':
        this.onSystem(msg);
        break;
      case 'tool_progress':
        this.onToolProgress(msg);
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

  /** Claude Code's system events, shown the way the CLI shows them. */
  onSystem(msg) {
    switch (msg.subtype) {
      case 'compact_boundary':
        this.sink.chat({ kind: 'info', text: 'Konteks percakapan dipadatkan (compact).' });
        this.status({ compacting: false });
        break;
      case 'thinking_tokens':
        this.think(msg.parent_tool_use_id);
        break;
      case 'status': // "✻ Compacting conversation…"
        this.status({ compacting: msg.status === 'compacting' });
        if (msg.compact_result === 'failed') this.sink.chat({ kind: 'error', text: `Gagal memadatkan konteks${msg.compact_error ? `: ${msg.compact_error}` : '.'}` });
        break;
      case 'api_retry': {
        const secs = Math.max(1, Math.round((msg.retry_delay_ms ?? 0) / 1000));
        const text = `⟳ API ${msg.error_status ?? 'tidak menjawab'} — mencoba lagi (${msg.attempt}/${msg.max_retries}) dalam ${secs} dtk`;
        if (this.retryChatId) this.sink.updateChat(this.retryChatId, { text });
        else this.retryChatId = this.sink.chat({ kind: 'info', text, level: 'warning' });
        break;
      }
      case 'informational': // level 'info' only shows in the CLI's transcript mode
        if (msg.content && msg.level !== 'info') this.sink.chat({ kind: 'info', text: truncate(msg.content, 600), level: msg.level });
        break;
      case 'notification':
        if (msg.text && msg.priority !== 'low') this.sink.chat({ kind: 'info', text: truncate(msg.text, 400), level: msg.priority === 'high' || msg.priority === 'immediate' ? 'warning' : 'notice' });
        break;
      case 'model_fallback':
        this.sink.chat({ kind: 'info', text: msg.content || `Model ${msg.original_model} tidak tersedia; memakai ${msg.fallback_model}.`, level: 'warning' });
        break;
      case 'local_command_output': // e.g. /voice — shown as assistant text, as in the CLI
        if (msg.content) this.sink.chat({ kind: 'assistant', text: msg.content });
        break;
      case 'session_title_changed':
        this.status({ title: msg.title || null });
        break;
      case 'task_started':
      case 'task_progress':
      case 'task_updated':
      case 'task_notification':
        this.onTask(msg);
        break;
      case 'background_tasks_changed':
        this.onBackgroundTasks(msg.tasks ?? []);
        break;
    }
  }

  /** "Running… (12s)" on a long tool call or subagent. */
  onToolProgress(msg) {
    const info = this.tools.get(msg.tool_use_id);
    const secs = msg.elapsed_time_seconds;
    if (!info || !(secs >= 3) || secs === info.elapsed) return;
    info.elapsed = secs;
    this.sink.updateChat(info.chatId, { elapsed: secs });
  }

  // ---------- background tasks (/tasks): Bash commands and subagents Claude Code runs as tasks ----------

  onTask(msg) {
    const id = msg.task_id;
    if (!id) return;
    const t = this.bgTasks.get(id) ?? { id, status: 'running', startedAt: Date.now() };
    if (msg.subtype === 'task_started') {
      Object.assign(t, { kind: msg.subagent_type ? 'agent' : 'shell', agent: msg.subagent_type ?? null, background: Boolean(msg.is_backgrounded), status: 'running' });
    } else if (msg.subtype === 'task_progress') {
      Object.assign(t, { summary: msg.summary ?? t.summary, lastTool: msg.last_tool_name ?? t.lastTool, tokens: msg.usage?.total_tokens ?? t.tokens, toolUses: msg.usage?.tool_uses ?? t.toolUses });
    } else if (msg.subtype === 'task_updated') {
      const p = msg.patch ?? {};
      if (p.status) t.status = p.status;
      if (p.is_backgrounded != null) t.background = p.is_backgrounded;
      if (p.error) t.error = truncate(p.error, 300);
      if (p.status && p.status !== 'running' && p.status !== 'pending') t.endedAt = Date.now();
    } else if (msg.subtype === 'task_notification') {
      Object.assign(t, { status: msg.status, summary: msg.summary ?? t.summary, endedAt: Date.now() });
    }
    if (msg.description) t.description = truncate(msg.description, 200);
    t.kind ??= 'shell';
    if (msg.tool_use_id) t.toolUseId = msg.tool_use_id;
    t.role ??=
      (t.toolUseId && this.toolRoles.get(t.toolUseId)) ||
      (t.agent ? agentRole(t.agent) : null) ||
      // A background shell without a tool_use_id: the oldest `run_in_background` call still waiting for its task.
      (t.kind === 'shell' && t.background && this.bgShellRoles.shift()) ||
      null;
    if (t.toolUseId && t.kind === 'shell') {
      const i = this.bgShellRoles.indexOf(t.role);
      if (t.background && i >= 0) this.bgShellRoles.splice(i, 1); // matched by id: not waiting anymore
    }
    this.bgTasks.set(id, t);
    this.settleTask(t);
    this.emitBgTasks();
  }

  /** tool_use_id -> role, bounded (only recent calls can still have a task running). */
  rememberRole(toolUseId, role) {
    this.toolRoles.set(toolUseId, role);
    if (this.toolRoles.size > 500) this.toolRoles.delete(this.toolRoles.keys().next().value);
  }

  /** A background subagent's task ended: its character reports back and stops working. */
  settleTask(t) {
    if (t.status === 'running' || t.status === 'pending' || t.kind !== 'agent') return;
    const toolUseId =
      (t.toolUseId && this.tools.get(t.toolUseId)?.agent && t.toolUseId) ||
      // No tool_use_id on the task: the oldest background agent of that role.
      [...this.tools].find(([, info]) => info.agent && info.background && info.role === t.role)?.[0];
    if (toolUseId) this.finishAgent(toolUseId, t.status === 'failed' || t.status === 'killed', t.summary ?? '');
  }

  /** Anything still running in the background (keeps the process from being closed while idle). */
  hasRunningTasks() {
    return [...this.bgTasks.values()].some((t) => t.status === 'running') || [...this.tools.values()].some((i) => i.agent && i.background);
  }

  /** The full set of live background tasks (replace semantics). */
  onBackgroundTasks(tasks) {
    const live = new Set();
    for (const x of tasks) {
      live.add(x.task_id);
      const t = this.bgTasks.get(x.task_id) ?? { id: x.task_id, status: 'running', startedAt: Date.now() };
      Object.assign(t, { background: true, kind: x.task_type === 'local_agent' || x.subagent_type ? 'agent' : 'shell', agent: x.subagent_type ?? t.agent ?? null });
      if (x.description) t.description = truncate(x.description, 200);
      if (x.tool_use_id) t.toolUseId = x.tool_use_id;
      t.role ??= (t.toolUseId && this.toolRoles.get(t.toolUseId)) || (t.agent ? agentRole(t.agent) : null);
      this.bgTasks.set(x.task_id, t);
    }
    for (const t of this.bgTasks.values()) {
      if (t.background && t.status === 'running' && !live.has(t.id)) {
        Object.assign(t, { status: 'completed', endedAt: Date.now() });
        this.settleTask(t);
      }
    }
    this.emitBgTasks();
  }

  emitBgTasks() {
    // Running first, then the most recent; finished ones stay a while so their output can be read.
    const list = [...this.bgTasks.values()].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt);
    for (const t of list.slice(20)) this.bgTasks.delete(t.id);
    this.status({ tasks: list.slice(0, 20).map((t) => ({ ...t })) });
    this.emitWorking(); // a background shell starting or ending changes who is at work
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
    } else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta' && e.delta.thinking) {
      this.streamThinking(e.delta.thinking);
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
    if (!parentId) this.noteContext(msg.message?.usage);
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) this.onText(block.text, parentId, parentRole, msg.message.id);
      else if (block.type === 'thinking') {
        this.think(parentId);
        if (!parentId) this.finishThinking(block.thinking);
      }
      else if (block.type === 'tool_use') this.onToolUse(block, parentRole);
    }
  }

  // ---------- thinking (collapsible "✻ Thinking" rows, main thread only) ----------

  streamThinking(delta) {
    if (!this.liveThinking) this.liveThinking = { chatId: this.sink.chat({ kind: 'thinking', text: '', streaming: true }), text: '' };
    this.liveThinking.text += delta;
    if (!this.thinkFlushTimer) {
      this.thinkFlushTimer = setTimeout(() => {
        this.thinkFlushTimer = null;
        if (this.liveThinking) this.sink.updateChat(this.liveThinking.chatId, { text: this.liveThinking.text, streaming: true });
      }, STREAM_FLUSH_MS);
    }
  }

  /** The finished block replaces the streamed text; models that hide their thinking send none. */
  finishThinking(text) {
    clearTimeout(this.thinkFlushTimer);
    this.thinkFlushTimer = null;
    const live = this.liveThinking;
    this.liveThinking = null;
    const final = text?.trim() ? text : (live?.text ?? '');
    if (live) this.sink.updateChat(live.chatId, { text: final, streaming: false });
    else if (final.trim()) this.sink.chat({ kind: 'thinking', text: final });
  }

  // ---------- context usage (status line) ----------

  noteContext(usage) {
    if (!usage) return;
    const used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    if (!used || used === this.contextUsed) return;
    this.contextUsed = used;
    this.status({ context: { used, window: this.contextWindow || null, autoCompactAt: this.autoCompactAt ?? null } });
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
      this.rememberRole(block.id, role);
      this.sink.office({ kind: 'delegate', role, from, label, agentType });
      this.emitWorking();
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
    this.rememberRole(block.id, role);
    if (input.run_in_background && this.bgShellRoles.push(role) > 50) this.bgShellRoles.shift();
    this.sink.office({ kind: 'tool_start', role, label, tool: block.name, screen, inferred: !parentRole });
    this.emitWorking();

    const todos = extractTodos(block.name, input);
    if (todos) {
      this.sink.office({ kind: 'board', items: todos });
      if (!parentRole) this.status({ todos: todoItems(input.todos) });
    }
    if (block.name === 'TaskUpdate' && input.taskId != null) {
      const task = this.tasks.get(String(input.taskId));
      if (task) {
        if (input.status) task.status = input.status;
        if (input.subject) task.subject = input.subject;
        if (input.activeForm) task.activeForm = input.activeForm;
        this.emitTasks();
      }
    }
  }

  emitTasks() {
    const items = [...this.tasks.values()]
      .filter((t) => t.status !== 'deleted')
      .map((t) => ({ content: truncate(t.subject, 60), status: t.status }));
    this.sink.office({ kind: 'board', items });
    this.status({
      todos: [...this.tasks.values()]
        .filter((t) => t.status !== 'deleted')
        .map((t) => ({ content: clip(t.subject, 300), activeForm: t.activeForm ? clip(t.activeForm, 300) : undefined, status: t.status })),
    });
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
      this.emitWorking();

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
          this.tasks.set(id, { subject: info.input.subject ?? info.label, activeForm: info.input.activeForm, status: 'pending' });
          this.emitTasks();
        }
      }
    }
  }

  onResult(msg) {
    this.closeBubble();
    if (this.liveThinking) this.finishThinking('');
    this.retryChatId = null;
    this.status({ compacting: false });
    // The context window comes only with the result (per model); the main model's is the largest.
    const windows = Object.values(msg.modelUsage ?? {}).map((u) => u.contextWindow).filter((n) => n > 0);
    if (windows.length) this.contextWindow = Math.max(...windows);
    if (this.contextUsed) this.status({ context: { used: this.contextUsed, window: this.contextWindow || null, autoCompactAt: this.autoCompactAt ?? null } });
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
    this.emitWorking(); // only background agents are still at work after the turn
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
