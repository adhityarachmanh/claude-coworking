// OpenCode as a project's engine, over the Agent Client Protocol (`opencode acp`: JSON-RPC 2.0, one JSON per line on
// stdio). ACP updates are turned into Claude Code stream-json messages and fed to the same StreamTranslator, so the
// office, chat, approval cards, queue, notifications and reports work unchanged. See docs/design-opencode.md.
//
// The session class is built from ClaudeSession (acpSessionClass below) so the queue bookkeeping, `!` shell,
// "Lanjutkan" after a restart, idle shutdown and status come along; only the protocol parts are replaced.
import path from 'node:path';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mergePermission, readUserPermission } from './opencode-bin.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { attachmentChips } from './attachments.js';
import { PERMISSION_MODES } from './hub.js';
import { describeTool, inferRole } from './roles.js';
import { StreamTranslator } from './translator.js';
import { clip, truncate } from './util.js';

const HANDSHAKE_TIMEOUT_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 8000;
const STDERR_TAIL = 4000;
const OPENCODE_SESSION = /^ses_[\w-]{1,100}$/;
const POINTS_CACHE_MS = 5000; // ⏪ the rewind list is reused this long (see rewindPoints)
/** What a prompt / `!` shell gets while a rewind runs (409 from the routes). */
export const REWINDING_MESSAGE = 'Rewind sedang berjalan. Tunggu sebentar, lalu kirim lagi.';
/**
 * What the UI may offer for an OpenCode project (config.engines.opencode.caps, read by public/js/core/engine-caps.js).
 * Effort = OpenCode's per-model "effort" config option (thought level); Mode tim = the roles as OpenCode subagents.
 * Rewind = OpenCode's session.revert (conversation, with or without its file snapshots; no "code only").
 * Questions = OpenCode's `question` tool through ACP form elicitation; plan = our own card after a 📋 plan turn.
 * Long shells: found among the service's shells (src/opencode-shells.js) for live output, the stuck detector,
 * ⧗ Pindah ke latar, stop and the /tasks panel. /mcp: live status + OAuth login through the service (src/opencode-mcp.js).
 * Not (yet): full session export.
 */
export const OPENCODE_CAPS = Object.freeze({
  effort: true,
  team: true,
  rewind: true,
  mcp: true, // the configured servers + ＋ Tambah (opencode mcp add); live status/login stay inside OpenCode
  bgTasks: true, // the service's shells (src/opencode-shells.js): ⧗ Tugas latar, output, stop, Ctrl+B
  askQuestion: true,
  exportSession: false,
  mirror: true, // sessions opened in a terminal, from the shared background service (src/opencode-mirror.js)
  modes: Object.freeze(['manual', 'acceptEdits', 'auto', 'plan']),
});

/**
 * What we offer at `initialize`. fs/terminal stay with OpenCode. `elicitation.form`: OpenCode 2.x then sends its
 * `question` tool (and other simple forms) as `elicitation/create`; without it the question is cancelled and the
 * model is told to continue without an answer.
 */
export const CLIENT_CAPABILITIES = Object.freeze({ fs: Object.freeze({ readTextFile: false, writeTextFile: false }), terminal: false, elicitation: Object.freeze({ form: Object.freeze({}) }) });

/** 📋 Rencana dulu: what "Setujui" sends to OpenCode (now in build) after the plan turn. */
export const PLAN_APPROVED_PROMPT = 'Rencana disetujui. Kerjakan sekarang sesuai rencana di atas.';
/**
 * ✕ Tolak: Claude Code tells the model "denied" and the turn goes on; OpenCode ends the whole turn. So the app
 * continues it with this note (and the user's reason, when given): the model carries on without that step.
 */
export const rejectedPrompt = (label, reason) =>
  `Saya menolak izin untuk: ${label}.${reason ? ` Alasan: ${reason}` : ''} Jangan jalankan langkah itu. Lanjutkan pekerjaannya dengan cara lain, atau tanyakan dulu kalau tidak bisa tanpa langkah itu.`;

const MAX_FORM_FIELDS = 10;
const MAX_FORM_OPTIONS = 30;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * An `elicitation/create` form schema (flat JSON Schema object, MCP style) → the questions of our question card.
 * OpenCode's `question` tool: q0, q1… = one question each (string + oneOf = one choice, array + items.anyOf =
 * several), `<key>_custom` = its "type your own answer" companion. Unknown shapes are left out (unanswered).
 * @returns {{ key: string, custom: string|null, type: string, question: string, header: string,
 *   options: { value: string|boolean, label: string, description?: string }[], multiSelect: boolean }[]}
 */
export function elicitationFields(schema) {
  const props = schema?.type === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
  if (!props) return [];
  const fields = [];
  for (const [key, p] of Object.entries(props)) {
    if (!/^[\w.-]{1,64}$/.test(key) || !p || typeof p !== 'object') continue;
    if (key.endsWith('_custom') && props[key.slice(0, -'_custom'.length)]) continue; // the card's own typed answer
    if (!['string', 'array', 'boolean', 'number', 'integer'].includes(p.type)) continue;
    let options;
    if (p.type === 'boolean') options = [{ value: true, label: 'Ya' }, { value: false, label: 'Tidak' }];
    else {
      const raw = p.type === 'array' ? (p.items?.anyOf ?? p.items?.enum) : (p.oneOf ?? p.enum);
      options = (Array.isArray(raw) ? raw : []).slice(0, MAX_FORM_OPTIONS).flatMap((c, i) => {
        if (typeof c === 'string') return [{ value: c, label: str(p.enumNames?.[i], 200) || c.slice(0, 200) }];
        if (typeof c?.const !== 'string') return [];
        return [{ value: c.const, label: str(c.title, 200) || c.const.slice(0, 200), description: str(c.description, 500) || undefined }];
      });
      if (p.type === 'array' && !options.length) continue; // a list without choices can't be answered on the card
    }
    const custom = props[`${key}_custom`]?.type === 'string' ? `${key}_custom` : null;
    fields.push({ key, custom, type: p.type, question: str(p.description, 2000) || str(p.title, 2000) || key, header: str(p.title, 60), options, multiSelect: p.type === 'array' });
    if (fields.length >= MAX_FORM_FIELDS) break;
  }
  return fields;
}

/**
 * The card's answers (question text → the picked labels joined with ", ", a typed answer first) → the form's
 * `content`: option labels back to their values, a typed answer into `<key>_custom` (or the field itself when
 * it has no choices). An unanswered or unusable question is left out.
 */
export function elicitationContent(fields, answers = {}) {
  const content = {};
  for (const f of fields) {
    const text = typeof answers?.[f.question] === 'string' ? answers[f.question].trim().slice(0, 4000) : '';
    if (!text) continue;
    const byLabel = (label) => f.options.find((o) => o.label === label);
    if (f.type === 'boolean') {
      if (byLabel(text)) content[f.key] = byLabel(text).value;
    } else if (f.type === 'number' || f.type === 'integer') {
      const n = Number(text.replace(',', '.'));
      if (Number.isFinite(n) && (f.type === 'number' || Number.isInteger(n))) content[f.key] = n;
    } else if (f.type === 'array') {
      // labels may contain ", " themselves: the longest run of parts that is a label wins
      const parts = text.split(', ');
      const picked = [];
      const own = [];
      for (let i = 0; i < parts.length; ) {
        let j = parts.length;
        while (j > i && !byLabel(parts.slice(i, j).join(', '))) j--;
        if (j > i) {
          picked.push(byLabel(parts.slice(i, j).join(', ')).value);
          i = j;
        } else own.push(parts[i++]);
      }
      if (picked.length) content[f.key] = [...new Set(picked)];
      if (own.length && f.custom) content[f.custom] = own.join(', ');
    } else if (byLabel(text)) content[f.key] = byLabel(text).value;
    else if (!f.options.length) content[f.key] = text;
    else if (f.custom) content[f.custom] = text;
  }
  return content;
}

/** OpenCode's `question` tool input ({ question, header, options, multiple }) → AskUserQuestion's questions. */
const askQuestions = (list) =>
  (Array.isArray(list) ? list : []).slice(0, MAX_FORM_FIELDS).map((q) => ({
    question: str(q?.question, 2000),
    header: str(q?.header, 60),
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, MAX_FORM_OPTIONS).map((o) => ({ label: str(o?.label, 200), description: str(o?.description, 500) })),
    multiSelect: q?.multiple === true,
  }));

/** Ledger account for OpenCode turns: its providers (OpenCode Go, Gemini…) are not a Claude account. */
export const OPENCODE_ACCOUNT = Object.freeze({ id: 'opencode', email: 'OpenCode', org: null });

/**
 * The app's permission mode → OpenCode `permission` config (passed per process in OPENCODE_CONFIG_CONTENT, so the
 * user's own OpenCode config files are never touched). "ask" makes OpenCode send session/request_permission.
 */
export function permissionConfig(mode, user = {}) {
  const base =
    mode === 'auto' ? { edit: 'allow', bash: 'allow', webfetch: 'allow' }
    : mode === 'dontAsk' ? { edit: 'deny', bash: 'deny', webfetch: 'deny' } // like Claude: never ask, refuse
    : mode === 'acceptEdits' ? { edit: 'allow', bash: 'ask', webfetch: 'ask' }
    : { edit: 'ask', bash: 'ask', webfetch: 'ask' }; // manual, plan
  // The user's own rules are kept, never loosened by the mode: see mergePermission (src/opencode-bin.js).
  return mergePermission(base, user, mode);
}

/**
 * OpenCode's primary agent: 📋 Rencana dulu = its read-only "plan" agent; otherwise the agent picked in
 * Pengaturan giliran (build, or a custom primary agent from the user's OpenCode config), "build" by default.
 */
const agentMode = (s) => (s.mode === 'plan' ? 'plan' : s.agent || 'build');
/** Settings that only a fresh process can change (the permission config and the team are read at start). */
const processKey = (s) => JSON.stringify([permissionConfig(s.mode), Boolean(s.team)]);

/** OpenCode's slash commands (available_commands_update) for the app's autocomplete. */
const cleanCommands = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((c) => typeof c?.name === 'string' && /^[\w:.-]{1,60}$/.test(c.name))
    .slice(0, 200)
    .map((c) => ({ name: c.name, description: String(c.description ?? '').slice(0, 200), argumentHint: typeof c.input?.hint === 'string' ? c.input.hint.slice(0, 80) : undefined }));

/**
 * The app's effort → a value of OpenCode's `effort` option for the current model (its values differ per model, e.g.
 * low | high | max | default). Nearest offered level; '' (Default) → "default". null when the model has no effort.
 */
const EFFORT_CANDIDATES = { '': ['default'], none: ['none', 'minimal', 'low'], minimal: ['minimal', 'low', 'none'], low: ['low', 'minimal'], medium: ['medium', 'default'], high: ['high'], xhigh: ['xhigh', 'max', 'high'], max: ['max', 'xhigh', 'high'] };
export function effortValue(effort, configOptions) {
  const values = (configOptions ?? []).find((o) => o.id === 'effort')?.options?.map((o) => o.value) ?? [];
  if (effort && values.includes(effort)) return effort; // the model's own level, picked from its list
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
  if (t === 'question') return { name: 'AskUserQuestion', input: { questions: askQuestions(input.questions) } };
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
    this.lastText = ''; // the last finished assistant message of the turn (reset per turn by the session)
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
    if (!t?.parts.length) return;
    this.lastText = t.parts.join(''); // the turn's last answer: in 📋 plan mode, the plan on the approval card
    this.emit({ type: 'assistant', message: { id: t.id, content: [{ type: 'text', text: this.lastText }] } });
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
/**
 * `@path` mentions of files inside the project → ACP resource_link blocks (the text keeps the mention), so OpenCode
 * knows the real file like in its own TUI. Only existing files below the project folder; at most 20.
 */
export function mentionLinks(text, projectPath) {
  if (!projectPath) return [];
  const root = path.resolve(projectPath);
  const links = [];
  const seen = new Set();
  for (const m of String(text).matchAll(/(?:^|\s)@([\w./\\:-]+[\w/\\])/g)) {
    const abs = path.resolve(root, m[1]);
    if (seen.has(abs) || !(abs + path.sep).startsWith(root + path.sep) || abs === root) continue;
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    seen.add(abs);
    links.push({ type: 'resource_link', uri: pathToFileURL(abs).href, name: path.relative(root, abs).replace(/\\/g, '/') });
    if (links.length >= 20) break;
  }
  return links;
}

function promptBlocks(text, attachments = [], projectPath = null) {
  const blocks = [];
  const extra = [];
  for (const a of attachments) {
    if (a.kind === 'image' && a.data) blocks.push({ type: 'image', mimeType: a.mediaType, data: a.data });
    else if (typeof a.text === 'string') extra.push(`<file name="${a.name}">\n${a.text}\n</file>`);
    else extra.push(`(lampiran ${a.name} tidak bisa dikirim ke OpenCode)`);
  }
  blocks.unshift({ type: 'text', text: [text, ...extra].filter(Boolean).join('\n\n') });
  blocks.push(...mentionLinks(text, projectPath));
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
      // the routes answer 409 first and the queue waits for status.rewinding: this is the last guard
      if (this.rewinding) throw Object.assign(new Error(REWINDING_MESSAGE), { status: 409 });
      this.pointsCache = null; // a new prompt joins the rewind list
      this.dropPlanCard(); // a new prompt instead of an answer: the plan card is stale
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
      const item = { chatId, text, files: attachments.length, state: this.busy ? 'queued' : 'started', announced: false, blocks: promptBlocks(body, attachments, this.project.path) };
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
      this.rejection = null;
      if (this.adapter) this.adapter.lastText = '';
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
      // ✕ Tolak ended the turn (not ■ Stop): continued below with the rejection note, like Claude Code does.
      const rejection = this.rejection && !this.interrupting && !this.shuttingDown ? this.rejection : null;
      this.rejection = null;
      const stopped = (interrupted || this.interrupting) && !rejection;
      // A turn the user stopped reads "Dihentikan", like Claude's interrupted turns.
      this.adapter.finish({ ...msg, ok: ok || Boolean(rejection), interrupted: stopped, error: stopped ? stopNote : error || 'OpenCode gagal menyelesaikan giliran.' });
      this.recordTurnUsage(usage ?? {}, costUsd);
      this.interrupting = false;
      this.inflight.delete(uuid);
      this.pointsCache = null;
      const next = [...this.inflight.entries()].find(([, i]) => i.state === 'queued');
      if (next) this.runTurn(next[0], next[1]);
      this.afterProgress();
      if (rejection && !next) {
        this.hub.chat(this.id, { kind: 'info', text: '✕ Izin ditolak: OpenCode menghentikan gilirannya, jadi dilanjutkan dengan catatan penolakan (seperti Claude Code).' });
        // after this turn has fully let go (busy cleared), so the note starts now instead of waiting in the queue
        setTimeout(() => epoch === this.epoch && !this.shuttingDown && this.prompt(rejectedPrompt(rejection.label, rejection.reason)), 0);
      }
      // 📋 Rencana dulu: OpenCode's plan agent has no "exit plan" tool, so the finished plan turn gets the
      // approval card Claude's ExitPlanMode shows (not when more prompts are already waiting).
      if (ok && !stopped && !next && !this.shuttingDown && this.hub.settingsFor(this.id).mode === 'plan') this.offerPlan(this.adapter.lastText);
    }

    // ---------- 📋 plan card ----------

    /** The plan approval card for the turn's last answer (the plan); replaces an older card still open. */
    offerPlan(text) {
      const plan = String(text ?? '').trim();
      if (!plan) return;
      this.dropPlanCard();
      const id = `acp-plan-${this.id}-${randomUUID()}`;
      const input = { plan };
      const role = inferRole('ExitPlanMode', input, { projectPath: this.project.path });
      const label = describeTool('ExitPlanMode', input);
      const chatId = this.hub.chat(this.id, { kind: 'approval', role, text: label, approvalId: id, status: 'pending' });
      this.planCard = id;
      this.hub.requestApproval(
        this.id,
        { id, chatId, role, kind: 'plan', tool: 'ExitPlanMode', label, description: '', input: previewInput('ExitPlanMode', input), canAlways: false },
        (decision) => this.onPlanDecision(id, role, decision),
      );
      this.hub.office(this.id, { kind: 'huddle', role: 'pm', roles: ['pm', 'architect'], label: 'Rencana siap, minta persetujuan' });
      this.hub.office(this.id, { kind: 'ask', role, label, ask: 'plan' });
    }

    /**
     * Setujui = the mode picked on the card (✏️ auto-edit or 🛡️ tanya dulu; never 📋 again), so OpenCode leaves its
     * plan agent, then PLAN_APPROVED_PROMPT. Minta revisi with a note = that note as the next prompt, still in plan.
     */
    onPlanDecision(id, role, decision) {
      if (this.planCard === id) this.planCard = null;
      this.hub.office(this.id, { kind: 'ask_done', role, allowed: Boolean(decision.allow) });
      if (decision.cancelled) return;
      if (decision.allow) {
        const mode = PERMISSION_MODES.includes(decision.mode) && decision.mode !== 'plan' ? decision.mode : 'manual';
        this.hub.updateSettings(this.id, { mode });
        this.prompt(PLAN_APPROVED_PROMPT); // syncSettings switches the agent (or the process) before it is sent
      } else if (decision.message?.trim()) this.prompt(`Revisi rencananya: ${decision.message.trim()}`);
    }

    dropPlanCard() {
      const id = this.planCard;
      this.planCard = null;
      if (id) this.hub.resolveApproval(id, { allow: false, cancelled: true });
    }

    /** Esc: queued prompts are dropped, the running turn is cancelled (session/cancel), killed if it won't stop. */
    stop() {
      for (const [uuid, item] of this.inflight) {
        if (item.state === 'started') continue;
        this.inflight.delete(uuid);
        this.hub.updateChat(this.id, item.chatId, { queued: false, cancelled: true });
      }
      this.hub.cancelApprovals(this.id);
      // session/cancel ends the whole turn, subagents included (OpenCode runs them inside the turn)
      if (this.child && (this.busy || [...this.inflight.values()].some((i) => i.state === 'started'))) {
        this.interrupting = true;
        this.notify('session/cancel', { sessionId: this.acpSessionId });
        clearTimeout(this.killTimer);
        this.killTimer = setTimeout(() => this.busy && this.kill(), INTERRUPT_GRACE_MS);
      }
      // ■ Stop also ends this project's shells still running in the background (as it does for Claude Code)
      for (const id of this.translator?.runningTaskIds?.() ?? []) if (String(id).startsWith('oc:')) this.stopTask(id).catch(() => {});
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
      if (agentMode(s) !== agentMode(a)) {
        a.mode = s.mode;
        a.agent = s.agent;
        // chained into `ready`: the next session/prompt waits for the switch (an approved plan must reach build)
        const switched = this.ready.then(() => this.setOption('mode', agentMode(s)).catch((err) => this.controlFailed('mode', err)));
        switched.catch(() => {}); // a failed start is handled where `ready` was made
        this.ready = switched;
      } else Object.assign(a, { mode: s.mode, agent: s.agent });
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

    // ---------- shells of a turn (src/opencode-shells.js): live output, stuck detector, ⧗ Pindah ke latar ----------

    /** Every 15 s while a bash call has run 8 s+: finds it among the service's running shells and links it. */
    watchShells() {
      if (this.shellTimer) return;
      this.shellTimer = setInterval(() => this.linkShells().catch(() => {}), 15_000);
      this.shellTimer.unref?.();
    }

    /** ⏳ While a turn runs: the provider's refusals OpenCode is retrying (rate limits), once per attempt. */
    async checkRetries() {
      const id = this.openCodeSessionId();
      if (!id || !this.busy || this.retryLookup) return;
      this.retryLookup = true;
      try {
        const { openCodeApi } = await import('./opencode-auth.js');
        const { retryNote } = await import('./opencode-mirror.js');
        const list = await openCodeApi(this.m.opencode, 'session.message.list', { params: { sessionID: id, limit: '3', order: 'desc' }, timeout: 15_000 });
        this.retriesSeen ??= new Set();
        for (const m of Array.isArray(list) ? list : []) {
          const note = m?.type === 'assistant' ? retryNote(m.retry) : null;
          const key = `${m?.id}:${m?.retry?.attempt}`;
          if (!note || this.retriesSeen.has(key)) continue;
          this.retriesSeen.add(key);
          if (this.retriesSeen.size > 200) this.retriesSeen.clear();
          this.hub.chat(this.id, { kind: 'info', text: note });
          this.hub.office(this.id, { kind: 'say', role: 'claude', text: 'Provider membatasi, OpenCode mencoba lagi…' });
        }
      } finally {
        this.retryLookup = false;
      }
    }

    async linkShells() {
      this.checkRetries().catch(() => {});
      const t = this.translator;
      const waiting = t?.unlinkedShells?.().filter((s) => Date.now() - s.startedAt >= 8000) ?? [];
      // looked at while a turn runs, a bash call waits for its shell, or a shell of ours may still be running
      const tracking = t?.runningTaskIds?.().some((id) => String(id).startsWith('oc:'));
      if ((!waiting.length && !this.busy && !tracking) || !this.m.opencode || this.shellLookup) return;
      this.shellLookup = true;
      try {
        const { matchShell, runningShells } = await import('./opencode-shells.js');
        const shells = await runningShells(this.m.opencode, this.project.path);
        const taken = new Set([...t.linkedTaskIds()].map((id) => String(id).replace(/^oc:/, '')));
        for (const s of waiting) {
          const sh = matchShell(shells, s.command, taken);
          if (!sh) continue;
          taken.add(sh.id);
          t.linkShellTask(s.toolUseId, `oc:${sh.id}`);
        }
        // ⧗ Tugas latar: only shells linked to one of this session's bash calls (now or earlier). The service also
        // runs the shells of OpenCode sessions opened in a terminal in the same folder: never shown, read or stopped.
        const byTask = new Map([...t.tools.entries()].filter(([, i]) => i.taskId).map(([id, i]) => [i.taskId, id]));
        const ours = shells.filter((sh) => byTask.has(`oc:${sh.id}`) || t.bgTasks.has(`oc:${sh.id}`));
        t.syncShellTasks(ours.map((sh) => ({ id: `oc:${sh.id}`, command: sh.command, startedAt: sh.time?.started, toolUseId: byTask.get(`oc:${sh.id}`) ?? null })));
      } finally {
        this.shellLookup = false;
      }
    }

    /** The shell of a task id from the browser: only one of this session's own (linked to its bash call). */
    async ownShell(taskId) {
      const { OC_TASK } = await import('./opencode-shells.js');
      const m = OC_TASK.exec(String(taskId));
      const t = this.translator;
      const own = m && t && (t.bgTasks.has(taskId) || t.linkedTaskIds().has(taskId));
      if (!own) throw Object.assign(new Error('Tugas tidak ditemukan.'), { status: 404 });
      return m[1];
    }

    async taskOutput(taskId) {
      const id = await this.ownShell(taskId);
      const { shellOutput } = await import('./opencode-shells.js');
      return shellOutput(this.m.opencode, this.project.path, id);
    }

    async stopTask(taskId) {
      const shell = await this.ownShell(taskId);
      const { stopShell } = await import('./opencode-shells.js');
      await stopShell(this.m.opencode, this.project.path, shell);
      return { ok: true };
    }

    /** ⧗ Pindah ke latar (Ctrl+B): OpenCode's session.background; the turn goes on, the shell keeps running. */
    async backgroundTasks() {
      const id = this.openCodeSessionId();
      if (!id) throw Object.assign(new Error('Belum ada sesi OpenCode.'), { status: 409 });
      const { backgroundSession } = await import('./opencode-shells.js');
      await backgroundSession(this.m.opencode, id);
      return { ok: true };
    }

    /** /rename and the session bar title: OpenCode's session.update. */
    async rename(title) {
      const id = this.hub.sessionIdFor(this.id);
      if (!id) throw Object.assign(new Error('Belum ada sesi. Kirim pesan dulu.'), { status: 409 });
      const { renameOpenCodeSession } = await import('./session-admin.js');
      const clean = await renameOpenCodeSession({ opencode: this.m.opencode, projectPath: this.project.path, sessionId: id, title });
      this.hub.setStatus(this.id, { title: clean });
      return { title: clean };
    }

    // ---------- ⏪ rewind (Esc Esc): OpenCode's session.revert, see src/session-admin.js ----------

    /** The OpenCode session of this project, or null (none yet / a Claude id). */
    openCodeSessionId() {
      const id = this.hub.sessionIdFor(this.id);
      return this.m.opencode && OPENCODE_SESSION.test(String(id ?? '')) ? id : null;
    }

    /**
     * The session's prompts, newest first (`uuid` = OpenCode's message id `msg_…`), without empty ones. Kept for
     * POINTS_CACHE_MS (a read-only phone reopening the list must not start `opencode` every time); a prompt, a turn's
     * end or a rewind drops it.
     */
    async rewindPoints() {
      const sessionId = this.openCodeSessionId();
      if (!sessionId) return [];
      const c = this.pointsCache;
      const points = c?.sessionId === sessionId && Date.now() - c.at < POINTS_CACHE_MS ? c.points : await this.rewindPointsFull(sessionId);
      this.pointsCache = { sessionId, at: c?.points === points ? c.at : Date.now(), points };
      return points.filter((p) => p.text.trim()).map((p) => ({ ...p, text: truncate(p.text, 400) }));
    }

    /** Dry run: the files a rewind to just before this prompt would put back. OpenCode has no "code only". */
    async rewindPreview(uuid) {
      const sessionId = this.openCodeSessionId();
      if (!sessionId) throw Object.assign(new Error('Belum ada sesi OpenCode.'), { status: 409 });
      const { openCodeRevertPlan, rewindDeadline } = await import('./session-admin.js');
      const plan = await openCodeRevertPlan({ opencode: this.m.opencode, sessionId, messageId: String(uuid), budget: rewindDeadline() });
      return {
        canRewind: true,
        filesChanged: plan.files,
        filesUnknown: !plan.found, // older than the scanned messages: OpenCode still puts its files back
        codeOnly: false,
        note: 'OpenCode: pesan ini dan semua sesudahnya dihapus dari sesi OpenCode. Dengan “Kode & percakapan”, file yang diubah OpenCode sejak pesan ini dikembalikan dari snapshot-nya (perubahanmu sendiri di file itu ikut tertimpa).',
      };
    }

    /**
     * Back to just before one of your prompts: the conversation (OpenCode deletes that prompt and everything after
     * it), with or without the file changes since (its snapshots). Refused (409) while a turn runs or is queued, or
     * another rewind runs; while it runs, prompts, `!` shell and the queue wait (`rewinding`, see prompt()).
     * Everything within one deadline (src/session-admin.js rewindDeadline).
     */
    async rewind(uuid, { code = false, conversation = false } = {}) {
      if (!code && !conversation) throw Object.assign(new Error('Pilih kode, percakapan, atau keduanya.'), { status: 400 });
      if (!conversation) throw Object.assign(new Error('OpenCode tidak bisa mengembalikan kode saja. Pilih “Kode & percakapan” atau “Percakapan saja”.'), { status: 400 });
      if (this.rewinding) throw Object.assign(new Error('Rewind lain sedang berjalan. Tunggu sampai selesai.'), { status: 409 });
      const busy = () => this.turnActive() || this.inflight.size > 0;
      if (busy()) throw Object.assign(new Error('Hentikan dulu pekerjaan yang sedang berjalan (Esc).'), { status: 409 });
      const { revertOpenCodeSession, rewindDeadline, validMessageId } = await import('./session-admin.js');
      if (!validMessageId(uuid)) throw Object.assign(new Error('Pesan tidak dikenal.'), { status: 400 });
      if (this.rewinding) throw Object.assign(new Error('Rewind lain sedang berjalan. Tunggu sampai selesai.'), { status: 409 }); // came in during the import
      if (busy()) throw Object.assign(new Error('Hentikan dulu pekerjaan yang sedang berjalan (Esc).'), { status: 409 });
      this.setRewinding(true); // from here on no prompt can slip in between the checks and the revert
      this.dropPlanCard(); // its Setujui would send a prompt into the rewind
      try {
        const budget = rewindDeadline();
        const sessionId = this.openCodeSessionId();
        const points = sessionId ? await this.rewindPointsFull(sessionId, budget) : [];
        const point = points.find((p) => p.uuid === uuid);
        if (!point) throw Object.assign(new Error('Pesan itu tidak ada di percakapan ini.'), { status: 400 });
        const chatId = this.chatEntryFor(points, uuid); // before the revert: the chat still matches OpenCode's list
        // The ACP process holds the old conversation: the next prompt starts a fresh one that loads the shortened session.
        this.closeChild();
        const { files } = await revertOpenCodeSession({ opencode: this.m.opencode, projectPath: this.project.path, sessionId, messageId: uuid, files: code, budget });
        this.hub.clearInterrupted(this.id); // a cut-short turn after this point is gone
        this.shellContext = [];
        this.hub.setStatus(this.id, { todos: null, context: null, tasks: null });
        const text = (chatId && this.hub.markRewound(this.id, null, null, chatId)) ?? point.text;
        const what = code ? `Kode & percakapan${files.length ? ` (${files.length} file)` : ''}` : 'Percakapan';
        this.hub.chat(this.id, { kind: 'divider', text: `⏪ ${what} dikembalikan ke sebelum: “${truncate(text, 60)}”` });
        return { ok: true, text, filesRestored: files };
      } finally {
        this.pointsCache = null;
        this.setRewinding(false);
      }
    }

    /** `rewinding` on the session and in the status (the 📋 queue doesn't dispatch while it is set). */
    setRewinding(on) {
      this.rewinding = on;
      this.hub.setStatus(this.id, { rewinding: on });
    }

    /**
     * The chat entry of one of OpenCode's prompts. OpenCode's ids are not known when a prompt is sent (ACP returns
     * none), so: the same place counted from the newest, among the chat prompts that reached OpenCode (not
     * cancelled, not rewound before), if OpenCode's text contains it (OpenCode keeps `!` output and text attachments
     * around the prompt); else the nearest entry that fits. null = none fits (nothing is greyed out).
     */
    chatEntryFor(points, uuid) {
      const k = points.findIndex((p) => p.uuid === uuid);
      const want = String(points[k]?.text ?? '');
      const prompts = this.hub.rt(this.id).chat.filter((m) => m.kind === 'user' && !m.rewound && !m.cancelled).reverse();
      const fits = (m) => Boolean(m?.text?.trim()) && want.includes(m.text.trim());
      if (fits(prompts[k])) return prompts[k].id;
      let best = null;
      prompts.forEach((m, i) => {
        if (fits(m) && (!best || Math.abs(i - k) < Math.abs(best.i - k))) best = { i, id: m.id };
      });
      return best?.id ?? null;
    }

    /** The prompts with their full text (matching the chat entry needs more than the list's 400 characters). */
    async rewindPointsFull(sessionId, budget) {
      const { openCodeRewindPoints } = await import('./session-admin.js');
      return openCodeRewindPoints({ opencode: this.m.opencode, sessionId, budget });
    }

    /** /mcp: configured servers + their live state from OpenCode's service (src/opencode-mcp.js). */
    async mcpStatus() {
      const { openCodeMcpStatus } = await import('./opencode-mcp.js');
      return openCodeMcpStatus(this.m.opencode, this.project.path);
    }

    /** ↻ / ▶ / ⏸ / 🔑 login / pasted callback, through OpenCode's service. */
    async mcpAction(name, action, callbackUrl) {
      const { openCodeMcpAction } = await import('./opencode-mcp.js');
      return openCodeMcpAction(this.m.opencode, this.project.path, name, action, callbackUrl);
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
            // The user's own rules are merged in (a deny stays a deny): see permissionConfig.
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: permissionConfig(settings.mode, readUserPermission(this.project.path)) }),
            // Mode tim: the roles as subagents + the Lead's prompt, from a file (17 prompts pass Windows' 32 KB env limit).
            ...(settings.team && Object.keys(this.m.agents).length ? { OPENCODE_CONFIG: this.m.openCodeTeamConfig() } : {}),
          },
        });
      } catch (err) {
        this.hub.chat(this.id, { kind: 'error', text: `Gagal menjalankan OpenCode: ${err.message}` });
        return false;
      }
      this.child = child;
      this.applied = { mode: settings.mode, agent: settings.agent, model: settings.model, effort: settings.effort, team: settings.team };
      this.stderr = '';
      this.cost = null;
      this.translator = new StreamTranslator({
        office: (evt) => this.hub.office(this.id, evt),
        chat: (msg) => this.hub.chat(this.id, msg),
        updateChat: (chatId, patch) => this.hub.updateChat(this.id, chatId, patch),
        status: (patch) => this.hub.setStatus(this.id, patch),
        gitPushed: () => this.hub.ciWatch?.(this.id),
      }, { projectPath: this.project.path });
      this.adapter = new AcpAdapter((msg) => this.translator.handle(msg));
      this.spawnedAt = Date.now();
      this.watchShells();

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
      await this.rpc('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES }, HANDSHAKE_TIMEOUT_MS);
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
      // a custom agent that is gone (renamed in opencode.json): back to build, never an error at every start
      const agent = has('mode', agentMode(settings)) ? agentMode(settings) : agentMode({ mode: settings.mode });
      if (has('mode', agent)) options = (await this.setOption('mode', agent)) ?? options;
      this.configOptions = options;
      this.publishAgents();
      await this.applyEffort(settings.effort); // '' = OpenCode's default level, same as a later change back to Default
      const model = options.find((o) => o.id === 'model')?.currentValue ?? null;
      this.hub.setStatus(this.id, { activeModel: model });
    }

    async setOption(configId, value) {
      const res = await this.rpc('session/set_config_option', { sessionId: this.acpSessionId, configId, value }, RPC_TIMEOUT_MS);
      if (configId === 'model') this.hub.setStatus(this.id, { activeModel: value });
      if (res?.configOptions) this.configOptions = res.configOptions;
      else if (configId === 'model') this.configOptions = null; // the new model's effort levels are unknown: none sent
      this.publishAgents();
      return res?.configOptions ?? null;
    }

    /** OpenCode's primary agents (the `mode` option: build, plan and the user's own) for the Agent picker. */
    publishAgents() {
      const opt = (this.configOptions ?? []).find((o) => o.id === 'mode');
      if (!opt) return;
      const agents = (opt.options ?? []).filter((o) => typeof o.value === 'string' && /^[\w.-]{1,60}$/.test(o.value)).map((o) => ({ value: o.value, name: String(o.name ?? o.value).slice(0, 60), description: String(o.description ?? '').slice(0, 200) }));
      this.hub.setStatus(this.id, { agents, activeAgent: opt.currentValue ?? null });
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
      if (msg.method === 'elicitation/create' && msg.id != null) return this.onElicitation(msg);
      // fs/* and terminal/* are not offered in initialize; anything else gets "method not found".
      if (msg.id != null) this.send({ id: msg.id, error: { code: -32601, message: `Tidak didukung: ${msg.method}` } });
    }

    onUpdate(u) {
      if (this.loading && u?.sessionUpdate !== 'available_commands_update') return;
      if (u.sessionUpdate === 'usage_update') {
        if (Number.isFinite(u.cost?.amount)) this.cost = u.cost.amount;
        if (Number.isFinite(u.used) && Number.isFinite(u.size) && u.size > 0) this.hub.setStatus(this.id, { context: { used: u.used, window: u.size, autoCompactAt: null } });
        return;
      }
      if (u.sessionUpdate === 'available_commands_update') {
        this.hub.setStatus(this.id, { commands: cleanCommands(u.availableCommands) }); // autocomplete (suggest.js)
        return;
      }
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
      const role = this.translator.roleOf(id) ?? inferRole(name, input, { projectPath: this.project.path });
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
              this.rejection ??= { label: truncate(label, 200), reason: String(decision.message ?? '').trim().slice(0, 1000) };
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

    /**
     * `elicitation/create` (form): OpenCode's `question` tool asking the user. Shown as the same question card as
     * Claude's AskUserQuestion; Kirim jawaban → accept + content, Lewati → decline, Stop/closed → cancel.
     * Never auto-answered by "Izinkan semua" (that is for tools only, as with Claude).
     */
    onElicitation(msg) {
      const p = msg.params ?? {};
      const reply = (result) => this.send({ id: msg.id, result });
      const fields = (p.mode ?? 'form') === 'form' ? elicitationFields(p.requestedSchema) : [];
      if (!fields.length) return reply({ action: 'decline' }); // a URL elicitation (never offered) or an empty form
      if (this.rejectedThisTurn || this.interrupting) return reply({ action: 'cancel' });
      const input = { questions: fields.map(({ question, header, options, multiSelect }) => ({ question, header, multiSelect, options: options.map(({ label, description }) => ({ label, description })) })) };
      const toolId = typeof p.toolCallId === 'string' ? p.toolCallId : null;
      const role = (toolId && this.translator?.roleOf(toolId)) || inferRole('AskUserQuestion', input, { projectPath: this.project.path });
      const label = describeTool('AskUserQuestion', input);
      const message = str(p.message, 300);
      const approvalId = `acp-ask-${this.id}-${randomUUID()}`;
      const chatId = this.hub.chat(this.id, { kind: 'approval', role, text: label, approvalId, status: 'pending' });
      this.hub.requestApproval(
        this.id,
        // OpenCode's question tool titles every form "Questions": the first question says more
        { id: approvalId, chatId, role, kind: 'question', tool: 'AskUserQuestion', label, description: message && message !== 'Questions' ? message : '', input: previewInput('AskUserQuestion', input), canAlways: false },
        (decision) => {
          if (decision.allow) reply({ action: 'accept', content: elicitationContent(fields, decision.answers) });
          else reply({ action: decision.cancelled ? 'cancel' : 'decline' });
          this.hub.office(this.id, { kind: 'ask_done', role, allowed: Boolean(decision.allow) });
          this.updateStatus();
        },
      );
      this.hub.office(this.id, { kind: 'ask', role, label: truncate(label, 120), ask: 'question' });
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
