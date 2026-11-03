// OpenCode as a project's engine, over the Agent Client Protocol (`opencode acp`: JSON-RPC 2.0, one JSON per line on
// stdio). ACP updates are turned into Claude Code stream-json messages and fed to the same StreamTranslator, so the
// office, chat, approval cards, queue, notifications and reports work unchanged. See docs/design-opencode.md.
//
// The session class is built from ClaudeSession (acpSessionClass below) so the queue bookkeeping, `!` shell,
// "Lanjutkan" after a restart, idle shutdown and status come along; only the protocol parts are replaced.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { attachmentChips } from './attachments.js';
import { describeTool, inferRole } from './roles.js';
import { StreamTranslator } from './translator.js';
import { clip, truncate } from './util.js';

const HANDSHAKE_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 8000;
const STDERR_TAIL = 4000;
/**
 * What the UI may offer for an OpenCode project (config.engines.opencode.caps, read by public/js/core/engine-caps.js).
 * Effort = OpenCode's per-model "effort" config option (thought level); Mode tim = the roles as OpenCode subagents.
 * Not (yet): rewind, MCP management, background tasks, interactive questions, session export or mirror.
 */
export const OPENCODE_CAPS = Object.freeze({
  effort: true,
  team: true,
  rewind: false,
  mcp: false,
  bgTasks: false,
  askQuestion: false,
  exportSession: false,
  mirror: false,
  modes: Object.freeze(['manual', 'acceptEdits', 'auto', 'plan']),
});

/** Ledger account for OpenCode turns: its providers (OpenCode Go, Gemini…) are not a Claude account. */
export const OPENCODE_ACCOUNT = Object.freeze({ id: 'opencode', email: 'OpenCode', org: null });

/**
 * The app's permission mode → OpenCode `permission` config (passed per process in OPENCODE_CONFIG_CONTENT, so the
 * user's own OpenCode config files are never touched). "ask" makes OpenCode send session/request_permission.
 */
export function permissionConfig(mode) {
  if (mode === 'auto') return { edit: 'allow', bash: 'allow', webfetch: 'allow' };
  if (mode === 'dontAsk') return { edit: 'deny', bash: 'deny', webfetch: 'deny' }; // like Claude: never ask, refuse
  if (mode === 'acceptEdits') return { edit: 'allow', bash: 'ask', webfetch: 'ask' };
  return { edit: 'ask', bash: 'ask', webfetch: 'ask' }; // manual, plan
}

/** OpenCode's agent mode: its read-only "plan" agent for 📋 Rencana dulu, "build" otherwise. */
const agentMode = (mode) => (mode === 'plan' ? 'plan' : 'build');
/** Settings that only a fresh process can change (the permission config and the team are read at start). */
const processKey = (s) => JSON.stringify([permissionConfig(s.mode), Boolean(s.team)]);

/**
 * The app's effort → a value of OpenCode's `effort` option for the current model (its values differ per model, e.g.
 * low | high | max | default). Nearest offered level; '' (Default) → "default". null when the model has no effort.
 */
const EFFORT_CANDIDATES = { '': ['default'], low: ['low', 'minimal'], medium: ['medium', 'default'], high: ['high'], xhigh: ['xhigh', 'max', 'high'], max: ['max', 'xhigh', 'high'] };
export function effortValue(effort, configOptions) {
  const values = (configOptions ?? []).find((o) => o.id === 'effort')?.options?.map((o) => o.value) ?? [];
  return (EFFORT_CANDIDATES[effort ?? ''] ?? []).find((v) => values.includes(v)) ?? null;
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .map((c) => c?.content?.text ?? c?.text ?? (c?.type === 'diff' ? `${c.path ?? ''} diubah` : ''))
    .filter(Boolean)
    .join('\n');

/**
 * An ACP tool call as a Claude Code tool (name + input), so roles.js (who in the office does it, which screen, the
 * label) and the approval card's preview work as for Claude. `kind`/`title`/`rawInput` as OpenCode sends them.
 */
export function mapTool({ kind, title = '', rawInput = {}, locations = [], content = [] } = {}) {
  const t = String(title).toLowerCase();
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const file = input.path ?? input.filePath ?? input.file_path ?? input.files?.[0]?.file ?? locations?.[0]?.path;
  const diff = (Array.isArray(content) ? content : []).find((c) => c?.type === 'diff');
  if (typeof input.command === 'string') return { name: 'Bash', input: { command: input.command, description: input.description } };
  if (t.startsWith('todo')) return { name: 'TodoWrite', input: { todos: Array.isArray(input.todos) ? input.todos : [] } };
  // OpenCode 2.x delegates with `subagent` ({ agent, prompt, description }); 1.x with `task` ({ subagent_type }).
  if (t === 'task' || t === 'agent' || t === 'subagent') return { name: 'Agent', input: { subagent_type: input.subagent_type ?? input.agent ?? 'general', description: input.description ?? title, prompt: input.prompt } };
  if (kind === 'read' || t === 'read') return { name: 'Read', input: { file_path: file } };
  if (kind === 'edit' || ['write', 'edit', 'patch', 'multiedit', 'apply_patch'].includes(t)) {
    const oldText = diff?.oldText ?? input.oldString ?? input.old_string;
    const newText = diff?.newText ?? input.newString ?? input.new_string ?? input.content;
    return oldText ? { name: 'Edit', input: { file_path: diff?.path ?? file, old_string: oldText, new_string: newText ?? '' } } : { name: 'Write', input: { file_path: diff?.path ?? file, content: newText ?? '' } };
  }
  if (kind === 'search' || ['grep', 'glob', 'list', 'codesearch'].includes(t)) return { name: t === 'glob' || t === 'list' ? 'Glob' : 'Grep', input: { pattern: input.pattern ?? input.query ?? title, path: input.path } };
  if (kind === 'fetch' || ['webfetch', 'fetch', 'websearch'].includes(t)) return t === 'websearch' ? { name: 'WebSearch', input: { query: input.query } } : { name: 'WebFetch', input: { url: input.url, prompt: input.prompt } };
  if (kind === 'execute' && !input.code) return { name: 'Bash', input: { command: title } };
  return { name: title || 'tool', input };
}

/** ACP `session/update` notifications → Claude Code stream-json messages for StreamTranslator. */
export class AcpAdapter {
  /** @param {(msg: object) => void} emit */
  constructor(emit) {
    this.emit = emit;
    this.tools = new Map(); // toolCallId -> { kind, title, rawInput, locations, content, started, done, parent }
    // Mode tim: a running `subagent` call's description -> its toolCallId. OpenCode streams the subagent's own tool
    // calls into the same session titled "<description>: <tool>"; they become that role's work (parent_tool_use_id).
    this.subagents = new Map(); // description -> [toolCallId, …] (several subagents may share one description)
    this.text = null; // { id, parts } — the assistant message being streamed
    this.planSeq = 0;
  }

  update(u) {
    switch (u?.sessionUpdate) {
      case 'agent_message_chunk': {
        const piece = u.content?.type === 'text' ? u.content.text : '';
        if (!piece) return;
        const id = u.messageId ?? 'acp-message';
        if (this.text?.id !== id) {
          this.flushText();
          this.text = { id, parts: [] };
          this.emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
        }
        this.text.parts.push(piece);
        this.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
        return;
      }
      case 'agent_thought_chunk':
        this.emit({ type: 'assistant', message: { id: 'acp-thinking', content: [{ type: 'thinking', thinking: '' }] } }); // the translator throttles
        return;
      case 'tool_call':
      case 'tool_call_update': {
        const info = this.toolInfo(u.toolCallId, u);
        if (u.status === 'in_progress' || u.status === 'completed' || u.status === 'failed') this.start(u.toolCallId);
        if ((u.status === 'completed' || u.status === 'failed') && !info.done) {
          info.done = true;
          const text = textOf(u.content) || (u.rawOutput?.error ? String(u.rawOutput.error) : u.status === 'completed' ? 'ok' : 'gagal');
          this.emit({ type: 'user', parent_tool_use_id: info.parent ?? null, message: { content: [{ type: 'tool_result', tool_use_id: u.toolCallId, content: clip(text, 8000), is_error: u.status === 'failed' }] } });
          for (const [desc, ids] of this.subagents) {
            const left = ids.filter((x) => x !== u.toolCallId);
            if (left.length) this.subagents.set(desc, left);
            else this.subagents.delete(desc);
          }
        }
        return;
      }
      case 'plan': {
        const todos = (u.entries ?? []).map((e) => ({ content: String(e.content ?? ''), status: ['pending', 'in_progress', 'completed'].includes(e.status) ? e.status : 'pending' }));
        const id = `acp-plan-${++this.planSeq}`;
        this.flushText();
        this.emit({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }] } });
        this.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
        return;
      }
      default:
    }
  }

  /** Merges what OpenCode said about a tool call so far (fields arrive spread over several updates). */
  toolInfo(id, u = {}) {
    const info = this.tools.get(id) ?? { kind: 'other', title: '', rawInput: {}, locations: [], content: [], started: false, done: false };
    if (u.kind) info.kind = u.kind;
    if (u.title) {
      // "<subagent description>: <tool>" → the subagent's own call, under its Agent row
      // the longest running description that prefixes the title (a description may itself contain ": ")
      const title = String(u.title);
      const desc = [...this.subagents.keys()].filter((d) => title.startsWith(`${d}: `)).sort((a, b) => b.length - a.length)[0];
      const parent = desc ? this.subagents.get(desc)[0] : undefined; // the oldest still running with that description
      if (parent && parent !== id) {
        info.parent = parent;
        info.title = title.slice(desc.length + 2);
      } else if (!info.parent) info.title = title;
    }
    if (u.rawInput && Object.keys(u.rawInput).length) info.rawInput = u.rawInput;
    if (u.locations?.length) info.locations = u.locations;
    if (u.content?.length) info.content = u.content;
    this.tools.set(id, info);
    return info;
  }

  /** The tool row (and the office's worker) starts once OpenCode knows what the tool does. */
  start(id) {
    const info = this.toolInfo(id);
    if (info.started) return mapTool(info);
    info.started = true;
    this.flushText(); // the text before a tool call ends there, as in Claude's messages
    const { name, input } = mapTool(info);
    // only a real description (not the "subagent" title fallback) can prefix the subagent's own calls
    const desc = info.rawInput?.description;
    if (name === 'Agent' && typeof desc === 'string' && desc) this.subagents.set(desc, [...(this.subagents.get(desc) ?? []), id]);
    this.emit({ type: 'assistant', parent_tool_use_id: info.parent ?? null, message: { id: `acp-tool-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
    return { name, input };
  }

  flushText() {
    const t = this.text;
    this.text = null;
    if (t?.parts.length) this.emit({ type: 'assistant', message: { id: t.id, content: [{ type: 'text', text: t.parts.join('') }] } });
  }

  /** The turn's result line (what Claude Code's `result` message carries). */
  finish({ ok, interrupted = false, error = '', durationMs, usage = {}, costUsd = null }) {
    this.flushText();
    const outputTokens = (usage.outputTokens ?? 0) + (usage.thoughtTokens ?? 0);
    this.emit({
      type: 'result',
      subtype: ok ? 'success' : interrupted ? 'interrupted' : 'error_during_execution',
      is_error: !ok,
      result: ok ? '' : error,
      duration_ms: durationMs,
      num_turns: 1,
      usage: { input_tokens: usage.inputTokens ?? 0, output_tokens: outputTokens, cache_read_input_tokens: usage.cachedReadTokens ?? 0 },
      total_cost_usd: costUsd ?? undefined,
      turnUsage: { costUsd: costUsd ?? 0, outputTokens },
      permission_denials: [],
    });
    this.tools.clear();
    this.subagents.clear();
  }
}

/** Prompt content for ACP: text plus 📎 images; text files ride along inside the text. */
function promptBlocks(text, attachments = []) {
  const blocks = [];
  const extra = [];
  for (const a of attachments) {
    if (a.kind === 'image' && a.data) blocks.push({ type: 'image', mimeType: a.mediaType, data: a.data });
    else if (typeof a.text === 'string') extra.push(`<file name="${a.name}">\n${a.text}\n</file>`);
    else extra.push(`(lampiran ${a.name} tidak bisa dikirim ke OpenCode)`);
  }
  blocks.unshift({ type: 'text', text: [text, ...extra].filter(Boolean).join('\n\n') });
  return blocks;
}

/**
 * Builds the OpenCode session class on top of ClaudeSession (passed in: a static import would be circular).
 * @param {typeof import('./session.js').ClaudeSession} ClaudeSession
 * @param {{ previewInput: Function, continuePrompt: string }} helpers
 */
export function acpSessionClass(ClaudeSession, { previewInput }) {
  return class AcpSession extends ClaudeSession {
    constructor(manager, project) {
      super(manager, project);
      this.engine = 'opencode';
      this.rpcSeq = 0;
      this.rpcPending = new Map(); // id -> { resolve, reject, timer }
      this.acpSessionId = null;
      this.ready = null;
      this.cost = null; // cumulative session cost from usage_update (per turn = difference)
      this.epoch = 0; // +1 whenever the process is let go (closeChild/kill): a late turn result is then ignored
    }

    get engineName() {
      return 'OpenCode';
    }

    // ---------- public ----------

    prompt(text, attachments = [], extra = {}) {
      this.hub.clearInterrupted(this.id);
      const uuid = randomUUID();
      const chatId = this.hub.chat(this.id, { kind: 'user', text, source: 'web', attachments: attachments.length ? attachmentChips(attachments) : undefined, queued: this.busy || undefined, uuid, ...extra });
      if (!this.m.opencode) {
        this.hub.updateChat(this.id, chatId, { queued: false, cancelled: true });
        this.hub.chat(this.id, { kind: 'error', text: 'OpenCode tidak ditemukan. Pasang dengan `npm i -g @opencode/cli`, atau set env OPENCODE_BIN.' });
        return { chatId };
      }
      this.syncSettings();
      if (!this.ensureChild()) {
        this.hub.updateChat(this.id, chatId, { queued: false, cancelled: true });
        return { chatId };
      }
      const context = this.shellContext.splice(0).join('\n');
      const body = context ? `${context}\n\n${text}` : text;
      const item = { chatId, text, files: attachments.length, state: this.busy ? 'queued' : 'started', announced: false, blocks: promptBlocks(body, attachments) };
      this.inflight.set(uuid, item);
      clearTimeout(this.idleTimer);
      if (item.state === 'started') this.runTurn(uuid, item);
      this.afterProgress();
      return { chatId };
    }

    /** One prompt = one ACP turn; the next queued prompt starts when this one ends. */
    runTurn(uuid, item) {
      item.state = 'started';
      this.hub.updateChat(this.id, item.chatId, { queued: false });
      this.announce(item);
      this.rejectedThisTurn = false;
      const epoch = this.epoch;
      const started = Date.now();
      const costBefore = this.cost;
      this.ready
        .then(() => this.rpc('session/prompt', { sessionId: this.acpSessionId, prompt: item.blocks }, 0))
        .then(
          (res) => this.endTurn(epoch, uuid, { ok: res?.stopReason !== 'cancelled' && res?.stopReason !== 'refusal', interrupted: res?.stopReason === 'cancelled', error: res?.stopReason === 'refusal' ? 'Model menolak permintaan ini.' : '', usage: res?.usage, started, costBefore }),
          (err) => {
            // After a rejected permission OpenCode cancels the turn; a parallel request it still had open then
            // fails the whole prompt with PermissionNotFoundError: that is a stop, not a crash.
            const stopped = this.interrupting || this.rejectedThisTurn || /PermissionNotFound/i.test(`${err.data?.errorName ?? ''} ${err.message}`);
            this.endTurn(epoch, uuid, { ok: false, interrupted: stopped, error: err.message, started, costBefore });
          },
        );
    }

    endTurn(epoch, uuid, { ok, interrupted, error, usage = {}, started, costBefore }) {
      if (epoch !== this.epoch || !this.translator) return; // the process was let go meanwhile (its queue is cleared)
      const costUsd = Number.isFinite(this.cost) ? Math.max(0, this.cost - (Number.isFinite(costBefore) ? costBefore : 0)) : null;
      const stopNote = this.shuttingDown ? 'Server dihentikan — giliran terputus' : 'Dihentikan oleh kamu';
      const msg = { durationMs: Date.now() - started, usage: usage ?? {}, costUsd };
      // A turn the user stopped reads "Dihentikan", like Claude's interrupted turns.
      this.adapter.finish({ ...msg, ok, interrupted: interrupted || this.interrupting, error: interrupted || this.interrupting ? stopNote : error || 'OpenCode gagal menyelesaikan giliran.' });
      this.recordTurnUsage(usage ?? {}, costUsd);
      this.interrupting = false;
      this.inflight.delete(uuid);
      const next = [...this.inflight.entries()].find(([, i]) => i.state === 'queued');
      if (next) this.runTurn(next[0], next[1]);
      this.afterProgress();
    }

    /** Esc: queued prompts are dropped, the running turn is cancelled (session/cancel), killed if it won't stop. */
    stop() {
      for (const [uuid, item] of this.inflight) {
        if (item.state === 'started') continue;
        this.inflight.delete(uuid);
        this.hub.updateChat(this.id, item.chatId, { queued: false, cancelled: true });
      }
      this.hub.cancelApprovals(this.id);
      if (this.child && [...this.inflight.values()].some((i) => i.state === 'started')) {
        this.interrupting = true;
        this.notify('session/cancel', { sessionId: this.acpSessionId });
        clearTimeout(this.killTimer);
        this.killTimer = setTimeout(() => this.busy && this.kill(), INTERRUPT_GRACE_MS);
      }
      this.afterProgress();
    }

    beginShutdown() {
      this.shuttingDown = true;
      this.hub.interruptTurn(this.id, 'shutdown');
      this.hub.cancelApprovals(this.id);
      this.interrupting = true;
      this.notify('session/cancel', { sessionId: this.acpSessionId });
    }

    /** Model and plan/build switch in the running process; another permission mode needs a fresh one. */
    syncSettings() {
      if (!this.child || !this.applied) return;
      const s = this.hub.settingsFor(this.id);
      const a = this.applied;
      if (processKey(s) !== processKey(a)) {
        if (this.busy) this.restartPending = true;
        else this.closeChild();
        return;
      }
      if (agentMode(s.mode) !== agentMode(a.mode)) {
        a.mode = s.mode;
        this.ready.then(() => this.setOption('mode', agentMode(s.mode))).catch((err) => this.controlFailed('mode', err));
      } else a.mode = s.mode;
      if (s.model !== a.model) {
        a.model = s.model;
        a.effort = s.effort;
        // a model has its own effort levels: the chosen effort is applied again after the switch
        if (s.model)
          this.ready
            .then(() => this.setOption('model', s.model))
            .then(
              () => this.applyEffort(s.effort).catch((err) => this.controlFailed('effort', err)),
              (err) => this.controlFailed('model', err),
            );
        else if (!this.busy) this.closeChild(); // back to OpenCode's own default: a fresh session picks it
      } else if (s.effort !== a.effort) {
        a.effort = s.effort;
        this.ready.then(() => this.applyEffort(s.effort)).catch((err) => this.controlFailed('effort', err));
      }
    }

    /** 🕘 Riwayat sesi lists Claude Code transcripts: only OpenCode's own sessions (ses_…) can continue here. */
    resume(sessionId, history) {
      if (!String(sessionId).startsWith('ses_')) throw Object.assign(new Error('Sesi ini milik Claude Code. Ganti mesin project ke Claude Code untuk melanjutkannya.'), { status: 409 });
      super.resume(sessionId, history);
    }

    rename() {
      return Promise.reject(Object.assign(new Error('Ganti judul sesi belum didukung untuk OpenCode.'), { status: 409 }));
    }

    rewindPoints() {
      return [];
    }

    async rewindPreview() {
      throw Object.assign(new Error('Rewind belum didukung untuk OpenCode.'), { status: 409 });
    }

    async rewind() {
      throw Object.assign(new Error('Rewind belum didukung untuk OpenCode.'), { status: 409 });
    }

    async mcpStatus() {
      throw Object.assign(new Error('Status MCP belum didukung untuk OpenCode.'), { status: 409 });
    }

    async mcpAction() {
      throw Object.assign(new Error('Pengaturan MCP belum didukung untuk OpenCode.'), { status: 409 });
    }

    refreshContext() {} // usage_update keeps the context meter current

    // ---------- process ----------

    spawn(settings) {
      const bin = this.m.opencode;
      if (!bin) return false;
      let child;
      try {
        child = spawn(bin.command, [...bin.args, 'acp'], {
          cwd: this.project.path,
          windowsHide: true,
          env: {
            ...process.env,
            OFFICE_MANAGED: '1',
            OPENCODE_DISABLE_AUTOUPDATE: '1',
            // Per-process config: the user's ~/.config/opencode stays untouched.
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: permissionConfig(settings.mode) }),
            // Mode tim: the roles as subagents + the Lead's prompt, from a file (17 prompts pass Windows' 32 KB env limit).
            ...(settings.team && Object.keys(this.m.agents).length ? { OPENCODE_CONFIG: this.m.openCodeTeamConfig() } : {}),
          },
        });
      } catch (err) {
        this.hub.chat(this.id, { kind: 'error', text: `Gagal menjalankan OpenCode: ${err.message}` });
        return false;
      }
      this.child = child;
      this.applied = { mode: settings.mode, model: settings.model, effort: settings.effort, team: settings.team };
      this.stderr = '';
      this.cost = null;
      this.translator = new StreamTranslator({
        office: (evt) => this.hub.office(this.id, evt),
        chat: (msg) => this.hub.chat(this.id, msg),
        updateChat: (chatId, patch) => this.hub.updateChat(this.id, chatId, patch),
        status: (patch) => this.hub.setStatus(this.id, patch),
      });
      this.adapter = new AcpAdapter((msg) => this.translator.handle(msg));

      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          this.onRpc(msg, child);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
      });
      child.stdin.on('error', () => {});
      child.on('error', (err) => this.hub.chat(this.id, { kind: 'error', text: `Gagal menjalankan OpenCode: ${err.message}` }));
      child.on('exit', (code) => this.onExit(child, code));
      this.handshaking = true;
      this.ready = this.handshake(settings).catch((err) => {
        if (child !== this.child) throw err;
        // Cold start: the first `opencode` call may still be bringing up its background service. One fresh
        // process, same queue (nothing was sent yet), before telling the user.
        if (!this.startRetried) {
          this.startRetried = true;
          this.child = null; // not detach(): the queued prompts and approvals stay
          child.removeAllListeners('exit');
          this.killTree(child.pid);
          this.spawn(settings);
          return this.ready;
        }
        this.hub.chat(this.id, { kind: 'error', text: `OpenCode gagal dimulai: ${err.message}${this.stderrTail()}` });
        throw err;
      });
      this.ready
        .then(() => {
          this.startRetried = false;
          this.handshaking = false;
        })
        .catch(() => child === this.child && this.closeChild());
      this.updateStatus();
      return true;
    }

    /** initialize, then continue the project's session (session/load) or start one, then model + mode. */
    async handshake(settings) {
      await this.rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, HANDSHAKE_TIMEOUT_MS);
      const cwd = this.project.path;
      const known = this.hub.sessionIdFor(this.id);
      let res = null;
      if (known?.startsWith('ses_')) {
        this.loading = true; // session/load replays the old conversation as updates: the chat already has it
        try {
          res = (await this.rpc('session/load', { sessionId: known, cwd, mcpServers: [] }, HANDSHAKE_TIMEOUT_MS)) ?? {};
          this.acpSessionId = known;
        } catch {
          res = null; // gone (deleted, other machine): start a new one
        } finally {
          this.loading = false;
        }
      }
      if (!res) {
        res = await this.rpc('session/new', { cwd, mcpServers: [] }, HANDSHAKE_TIMEOUT_MS);
        this.acpSessionId = res.sessionId;
        this.hub.setSessionId(this.id, res.sessionId);
      }
      let options = res.configOptions ?? [];
      const has = (id, value) => options.some((o) => o.id === id && (o.options ?? []).some((v) => v.value === value));
      if (settings.model && has('model', settings.model)) options = (await this.setOption('model', settings.model)) ?? options;
      if (has('mode', agentMode(settings.mode))) options = (await this.setOption('mode', agentMode(settings.mode))) ?? options;
      this.configOptions = options;
      await this.applyEffort(settings.effort); // '' = OpenCode's default level, same as a later change back to Default
      const model = options.find((o) => o.id === 'model')?.currentValue ?? null;
      this.hub.setStatus(this.id, { activeModel: model });
    }

    async setOption(configId, value) {
      const res = await this.rpc('session/set_config_option', { sessionId: this.acpSessionId, configId, value }, RPC_TIMEOUT_MS);
      if (configId === 'model') this.hub.setStatus(this.id, { activeModel: value });
      if (res?.configOptions) this.configOptions = res.configOptions;
      else if (configId === 'model') this.configOptions = null; // the new model's effort levels are unknown: none sent
      return res?.configOptions ?? null;
    }

    /** The app's effort on the current model (skipped when the model has no effort levels, or already has it). */
    async applyEffort(effort) {
      const value = effortValue(effort, this.configOptions);
      const current = (this.configOptions ?? []).find((o) => o.id === 'effort')?.currentValue;
      if (value && value !== current) await this.setOption('effort', value);
    }

    stderrTail() {
      const tail = this.stderr.trim().split('\n').slice(-4).join('\n');
      return tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : '';
    }

    detach() {
      this.epoch++;
      for (const p of this.rpcPending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('OpenCode berhenti.'));
      }
      this.rpcPending.clear();
      this.acpSessionId = null;
      this.ready = null;
      return super.detach();
    }

    closeChild() {
      const busy = this.busy;
      const child = this.detach();
      if (!child) return;
      if (busy) this.killTree(child.pid);
      else {
        child.stdin.end();
        // `opencode acp` may keep its server alive after stdin closes: make sure it goes.
        setTimeout(() => child.exitCode === null && this.killTree(child.pid), 3000).unref?.();
      }
      this.updateStatus();
    }

    onExit(child, code) {
      if (child !== this.child) return;
      if (this.handshaking && !this.startRetried) {
        // Died while starting (cold start): fail the handshake only; its retry keeps the queue (spawn above).
        for (const [id, p] of this.rpcPending) {
          clearTimeout(p.timer);
          this.rpcPending.delete(id);
          p.reject(new Error(`OpenCode berhenti saat mulai (exit ${code ?? '?'}).`));
        }
        return;
      }
      const wasBusy = this.busy;
      if (this.turnActive() && !this.interrupting && !this.m.stopping) this.hub.interruptTurn(this.id, 'exit', { announced: true });
      this.detach();
      if (wasBusy) {
        this.hub.chat(this.id, { kind: 'error', text: `OpenCode berhenti (exit ${code ?? '?'}).${this.stderrTail()}` });
        this.hub.office(this.id, { kind: 'error', role: 'claude', label: 'Proses berhenti' });
      }
      this.updateStatus();
    }

    // ---------- JSON-RPC ----------

    send(obj) {
      if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
    }

    notify(method, params) {
      if (this.child) this.send({ method, params });
    }

    /** A request to OpenCode; `timeout` 0 = none (a turn may take long; the process exiting rejects it). */
    rpc(method, params, timeout = RPC_TIMEOUT_MS) {
      if (!this.child) return Promise.reject(new Error('OpenCode tidak berjalan.'));
      const id = ++this.rpcSeq;
      return new Promise((resolve, reject) => {
        const timer = timeout ? setTimeout(() => {
          this.rpcPending.delete(id);
          reject(new Error(`OpenCode tidak menjawab (${method}).`));
        }, timeout) : null;
        this.rpcPending.set(id, { resolve, reject, timer });
        this.send({ id, method, params });
      });
    }

    onRpc(msg, child) {
      if (child !== this.child) return;
      if (msg.id != null && !msg.method) {
        const p = this.rpcPending.get(msg.id);
        if (!p) return;
        this.rpcPending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? 'OpenCode menolak permintaan ini.'), { data: msg.error.data }));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === 'session/update') return this.onUpdate(msg.params?.update ?? {});
      if (msg.method === 'session/request_permission' && msg.id != null) return this.onPermission(msg);
      // fs/* and terminal/* are not offered in initialize; anything else gets "method not found".
      if (msg.id != null) this.send({ id: msg.id, error: { code: -32601, message: `Tidak didukung: ${msg.method}` } });
    }

    onUpdate(u) {
      if (this.loading) return;
      if (u.sessionUpdate === 'usage_update') {
        if (Number.isFinite(u.cost?.amount)) this.cost = u.cost.amount;
        if (Number.isFinite(u.used) && Number.isFinite(u.size) && u.size > 0) this.hub.setStatus(this.id, { context: { used: u.used, window: u.size, autoCompactAt: null } });
        return;
      }
      if (u.sessionUpdate === 'available_commands_update') return;
      // Only during one of our turns: a late update after a stop must not reopen it (the office would stay "busy").
      if (!this.busy) return;
      this.adapter.update(u);
    }

    // ---------- permissions ----------

    onPermission(msg) {
      const { toolCall = {}, options = [] } = msg.params ?? {};
      const pick = (...kinds) => options.find((o) => kinds.includes(o.kind));
      const reply = (outcome) => this.send({ id: msg.id, result: { outcome } });
      const id = toolCall.toolCallId ?? `acp-perm-${msg.id}`;
      this.adapter.toolInfo(id, toolCall);
      const { name, input } = this.adapter.start(id);
      const role = this.translator.roleOf(id) ?? inferRole(name, input);
      const reject = pick('reject_once', 'reject_always');
      // After a "Tolak" OpenCode cancels the turn: its other requests are stale, answering "allow" would fail it.
      if (this.rejectedThisTurn || this.interrupting) return reply(reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' });
      if (this.autoApprove) {
        const once = pick('allow_once', 'allow_always');
        if (once) return reply({ outcome: 'selected', optionId: once.optionId });
      }
      const approvalId = `acp-${this.id}-${msg.id}-${this.rpcSeq}`;
      const label = describeTool(name, input);
      const chatId = this.hub.chat(this.id, { kind: 'approval', role, text: label, approvalId, status: 'pending' });
      this.hub.requestApproval(
        this.id,
        { id: approvalId, chatId, role, kind: 'tool', tool: name, label, description: '', input: previewInput(name, input), canAlways: Boolean(pick('allow_always')) },
        (decision) => {
          let option;
          if (decision.allow) {
            option = (decision.always && pick('allow_always')) || pick('allow_once', 'allow_always');
            if (decision.allowAll) this.autoApprove = true;
          } else {
            option = reject;
            if (!decision.cancelled) {
              this.rejectedThisTurn = true;
              this.hub.cancelApprovals(this.id); // the turn ends: close its other cards too
            }
          }
          reply(option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' });
          this.hub.office(this.id, { kind: 'ask_done', role, allowed: Boolean(decision.allow) });
          this.updateStatus();
        },
      );
      this.hub.office(this.id, { kind: 'ask', role, label: truncate(label, 120), ask: 'tool' });
    }

    // ---------- usage ----------

    recordTurnUsage(usage, costUsd) {
      if (!this.m.ledger) return;
      const input = usage.inputTokens ?? 0;
      const output = (usage.outputTokens ?? 0) + (usage.thoughtTokens ?? 0);
      const cacheRead = usage.cachedReadTokens ?? 0;
      if (!input && !output && !cacheRead) return;
      this.m.ledger.record({
        account: OPENCODE_ACCOUNT,
        source: 'web',
        project: this.project,
        sessionId: this.hub.sessionIdFor(this.id),
        model: this.hub.settingsFor(this.id).model || this.hub.statusFor?.(this.id)?.activeModel || 'opencode',
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        costUsd,
        turns: 1,
      });
    }
  };
}
