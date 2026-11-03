// 🖥 Sesi OpenCode dari terminal: OpenCode opened in a terminal (TUI, `opencode run`) works through the same background
// service the app's `opencode acp` uses. Every few seconds the running sessions are listed (`session.active`); one the
// app did not start is read (`session.message.list`) and shown in its project's office and chat as a terminal
// session (source 'cli'), like the Claude Code transcript mirror (src/mirror.js). Read-only: nothing is sent to it.
import path from 'node:path';
import { openCodeApi } from './opencode-auth.js';
import { StreamTranslator } from './translator.js';
import { truncate } from './util.js';

const POLL_MS = 5000;
const MESSAGES = '40';

/** OpenCode's own tool (name + input) → the Claude Code tool the translator knows, so roles / labels / screens match. */
export function nativeTool(name, input = {}) {
  const n = String(name ?? '').toLowerCase();
  const file = input.filePath ?? input.file_path ?? input.path;
  switch (n) {
    case 'bash':
      return { name: 'Bash', input: { command: input.command ?? '', description: input.description } };
    case 'read':
      return { name: 'Read', input: { file_path: file } };
    case 'write':
      return { name: 'Write', input: { file_path: file, content: input.content ?? '' } };
    case 'edit':
    case 'patch':
    case 'multiedit':
      return { name: 'Edit', input: { file_path: file, old_string: input.oldString ?? '', new_string: input.newString ?? '' } };
    case 'glob':
      return { name: 'Glob', input: { pattern: input.pattern, path: input.path } };
    case 'grep':
      return { name: 'Grep', input: { pattern: input.pattern, path: input.path } };
    case 'list':
      return { name: 'Glob', input: { pattern: '*', path: input.path } };
    case 'webfetch':
      return { name: 'WebFetch', input: { url: input.url } };
    case 'websearch':
      return { name: 'WebSearch', input: { query: input.query } };
    case 'todowrite':
      return { name: 'TodoWrite', input: { todos: Array.isArray(input.todos) ? input.todos : [] } };
    case 'task':
    case 'subagent':
      return { name: 'Agent', input: { subagent_type: input.agent ?? input.subagent_type ?? 'general', description: input.description ?? '', prompt: input.prompt ?? '' } };
    default:
      return { name: String(name ?? 'tool'), input };
  }
}

/**
 * ⏳ The provider refused a request and OpenCode retries it (an assistant message's `retry`): the chat line, like
 * Claude Code's "Batas pemakaian". null for anything else. HTTP 429 / a rate-limit type reads as a usage limit.
 */
export function retryNote(retry) {
  if (!retry || !Number.isFinite(retry.attempt)) return null;
  const err = retry.error ?? {};
  const status = Number.isFinite(err.status) ? err.status : null;
  const limited = status === 429 || /rate|limit|quota|overload/i.test(`${err.type ?? ''} ${err.message ?? ''}`);
  const what = limited ? 'Batas pemakaian provider tercapai' : 'Provider sedang bermasalah';
  const detail = truncate(String(err.message ?? '').replace(/\s+/g, ' ').trim(), 160);
  return `⏳ ${what}${status ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}. OpenCode mencoba lagi otomatis (percobaan ${retry.attempt}).`;
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .map((c) => c?.text ?? (c?.type === 'file' ? `${c.path ?? c.filename ?? 'file'}` : ''))
    .join('\n')
    .trim();

export class OpenCodeMirror {
  /**
   * @param {object} hub
   * @param {{ bin: object|null, ownSessions: () => Set<string>, skipDir?: (dir: string) => boolean, pollMs?: number }} options
   *   ownSessions: the app's own OpenCode sessions (never mirrored); skipDir: folders whose sessions are internal
   */
  constructor(hub, { bin, ownSessions, skipDir = () => false, pollMs = POLL_MS, api = openCodeApi }) {
    this.hub = hub;
    this.api = api;
    this.bin = bin;
    this.ownSessions = ownSessions;
    this.skipDir = skipDir;
    this.pollMs = pollMs;
    this.sessions = new Map(); // ses id -> { id, pid, dir, translator, seen: Set, tools: Map, turnOpen }
    this.ignored = new Set(); // sessions looked at and not shown (internal, a subagent's child session, outside projects)
    this.busy = false;
  }

  start() {
    if (!this.bin || this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy || this.hub.engine !== 'opencode' || this.hub.mirrorPaused) return;
    this.busy = true;
    try {
      const active = await this.api(this.bin, 'session.active', { timeout: 15_000 });
      const own = this.ownSessions();
      const running = Object.keys(active && typeof active === 'object' ? active : {}).filter((id) => /^ses/.test(id) && !own.has(id) && !this.ignored.has(id));
      for (const id of running) {
        const s = this.sessions.get(id) ?? (await this.open(id));
        if (s) await this.pull(s, true);
      }
      // finished since the last look: read the rest, then close the turn
      for (const s of this.sessions.values()) {
        if (!s.turnOpen || running.includes(s.id)) continue;
        await this.pull(s, false).catch(() => {});
        this.endTurn(s);
      }
    } finally {
      this.busy = false;
    }
  }

  async open(id) {
    const info = await this.api(this.bin, 'session.get', { params: { sessionID: id }, timeout: 15_000 }).catch(() => null);
    const dir = info?.location?.directory;
    if (!info || info.parentID || !dir || this.skipDir(path.resolve(dir))) {
      this.ignored.add(id);
      return null;
    }
    const pid = this.hub.upsertProject(dir, 'cli').id;
    const s = { id, pid, dir, seen: new Set(), tools: new Map(), texts: new Map(), turnOpen: false, since: Date.now() - 10 * 60_000 };
    s.translator = new StreamTranslator(
      {
        office: (evt) => this.hub.office(pid, { source: 'cli', ...evt }),
        chat: (msg) => this.hub.chat(pid, { source: 'cli', ...msg }),
        updateChat: (chatId, patch) => this.hub.updateChat(pid, chatId, patch),
        status: (patch) => {
          if (patch.todos !== undefined) this.hub.setStatus(pid, { todos: patch.todos });
          if (patch.working !== undefined) this.hub.setStatus(pid, { cliWorking: patch.working });
        },
        gitPushed: () => this.hub.ciWatch?.(pid),
      },
      { projectPath: dir },
    );
    this.sessions.set(id, s);
    return s;
  }

  /** New messages of a session (oldest first), from the latest prompt of the current turn on. */
  async pull(s, running) {
    const list = await this.api(this.bin, 'session.message.list', { params: { sessionID: s.id, limit: MESSAGES, order: 'desc' }, timeout: 15_000 });
    const msgs = (Array.isArray(list) ? list : []).slice().reverse();
    if (!s.started) {
      // first look: start at the prompt this running turn answers (older history is not replayed)
      const last = msgs.findLastIndex((m) => m.type === 'user');
      for (const m of msgs.slice(0, Math.max(0, last))) s.seen.add(m.id);
      s.started = true;
    }
    for (const m of msgs) this.ingest(s, m);
    if (running) this.ensureTurn(s);
  }

  ingest(s, m) {
    if (m.type === 'user') {
      if (s.seen.has(m.id)) return;
      s.seen.add(m.id);
      this.startTurn(s, String(m.text ?? ''));
      return;
    }
    if (m.type !== 'assistant' || !Array.isArray(m.content)) return;
    this.ensureTurn(s);
    const note = retryNote(m.retry);
    const retryKey = `${m.id}:retry:${m.retry?.attempt}`;
    if (note && !s.texts.has(retryKey)) {
      s.texts.set(retryKey, true);
      this.hub.chat(s.pid, { kind: 'info', text: note, source: 'cli' });
    }
    for (const [i, part] of m.content.entries()) {
      if (part.type === 'text') {
        // the whole answer once its message is complete (a streaming bubble per poll would flicker)
        const key = `${m.id}:${i}`;
        if (!m.time?.completed || s.texts.has(key) || !String(part.text ?? '').trim()) continue;
        s.texts.set(key, true);
        s.translator.handle({ type: 'assistant', message: { id: key, content: [{ type: 'text', text: part.text }] } });
      } else if (part.type === 'tool' && part.id) {
        const t = s.tools.get(part.id) ?? { started: false, ended: false };
        s.tools.set(part.id, t);
        const state = part.state ?? {};
        if (!t.started && state.status !== 'streaming') {
          t.started = true;
          const { name, input } = nativeTool(part.name, state.input ?? {});
          s.translator.handle({ type: 'assistant', message: { id: `oct-${part.id}`, content: [{ type: 'tool_use', id: part.id, name, input }] } });
        }
        if (t.started && !t.ended && (state.status === 'completed' || state.status === 'error')) {
          t.ended = true;
          const text = textOf(state.content) || (state.status === 'error' ? String(state.error?.message ?? 'gagal') : 'ok');
          s.translator.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: part.id, content: truncate(text, 8000), is_error: state.status === 'error' }] } });
        }
      }
    }
  }

  startTurn(s, text) {
    if (s.turnOpen) this.endTurn(s);
    s.turnOpen = true;
    if (text.trim()) {
      this.hub.chat(s.pid, { kind: 'user', text, source: 'cli' });
      this.hub.office(s.pid, { kind: 'prompt', role: 'claude', label: truncate(text, 120), source: 'cli' });
    }
    this.hub.setStatus(s.pid, { cliBusy: true, cliSession: s.id });
  }

  ensureTurn(s) {
    if (s.turnOpen) return;
    s.turnOpen = true;
    this.hub.setStatus(s.pid, { cliBusy: true, cliSession: s.id });
  }

  endTurn(s) {
    if (!s.turnOpen) return;
    s.turnOpen = false;
    s.translator.handle({ type: 'result', subtype: 'success', is_error: false, quiet: true, permission_denials: [] });
    this.hub.setStatus(s.pid, { cliBusy: false });
  }
}
