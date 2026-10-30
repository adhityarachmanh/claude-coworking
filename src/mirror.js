// Mirrors Claude Code CLI sessions into the office in real time by tailing the transcripts
// Claude Code already writes to ~/.claude/projects. Read-only: nothing is installed into the CLI.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamTranslator } from './translator.js';
import { truncate } from './util.js';

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const END_TURN_DELAY_MS = 2000; // wait for a turn_duration record before closing quietly
const SWEEP_MS = 2000;
const HOT_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_READ = 4 * 1024 * 1024;
const SUBAGENT_FILE = /[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/;
const INTERRUPTED = /^\[Request interrupted/;

const entries = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

function readMeta(file) {
  try {
    return JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

export class TranscriptMirror {
  constructor(hub) {
    this.hub = hub;
    this.files = new Map(); // file -> { offset, rest: Buffer, mtime }
    this.sessions = new Map(); // CLI session id -> mirror state
    this.timers = new Map(); // file -> debounce timer
  }

  start() {
    if (!existsSync(ROOT)) return false;
    // Existing history is skipped: the office shows what happens from now on.
    for (const file of this.listTranscripts()) this.track(file, true);
    try {
      this.watcher = watch(ROOT, { recursive: true }, (_event, name) => name && this.schedule(path.join(ROOT, name)));
    } catch {
      this.watcher = null; // no recursive watch on this platform: the sweep below still works
    }
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    return true;
  }

  stop() {
    this.watcher?.close();
    clearInterval(this.sweepTimer);
  }

  listTranscripts() {
    const files = [];
    for (const dir of entries(ROOT)) {
      if (!dir.isDirectory()) continue;
      const projectDir = path.join(ROOT, dir.name);
      for (const entry of entries(projectDir)) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(projectDir, entry.name));
        else if (entry.isDirectory()) {
          const subDir = path.join(projectDir, entry.name, 'subagents');
          for (const sub of entries(subDir)) if (sub.isFile() && sub.name.endsWith('.jsonl')) files.push(path.join(subDir, sub.name));
        }
      }
    }
    return files;
  }

  track(file, fromEnd) {
    try {
      const st = statSync(file);
      this.files.set(file, { offset: fromEnd ? st.size : 0, rest: Buffer.alloc(0), mtime: st.mtimeMs });
    } catch {
      // vanished
    }
  }

  schedule(file) {
    if (!file.endsWith('.jsonl')) return;
    clearTimeout(this.timers.get(file));
    this.timers.set(file, setTimeout(() => {
      this.timers.delete(file);
      this.read(file);
    }, 100));
  }

  sweep() {
    const now = Date.now();
    for (const [file, st] of this.files) if (now - st.mtime < HOT_MS) this.read(file);
    if (!this.watcher) for (const file of this.listTranscripts()) if (!this.files.has(file)) this.read(file);
    for (const [id, session] of this.sessions) if (now - session.lastSeen > SESSION_TTL_MS) this.sessions.delete(id);
  }

  read(file) {
    if (!this.files.has(file)) this.track(file, false); // new file: read from the start
    const st = this.files.get(file);
    if (!st) return;
    let size;
    try {
      const stat = statSync(file);
      size = stat.size;
      st.mtime = stat.mtimeMs;
    } catch {
      return;
    }
    if (size < st.offset) {
      st.offset = size; // rewritten: don't replay
      st.rest = Buffer.alloc(0);
    }
    if (size === st.offset) return;

    const len = Math.min(size - st.offset, MAX_READ);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, len, st.offset);
    } finally {
      closeSync(fd);
    }
    st.offset += len;
    // Split on raw newline bytes so a UTF-8 character cut at the chunk edge stays intact.
    const chunk = st.rest.length ? Buffer.concat([st.rest, buf]) : buf;
    const cut = chunk.lastIndexOf(0x0a);
    if (cut < 0) {
      st.rest = chunk;
      return;
    }
    st.rest = chunk.subarray(cut + 1);
    for (const line of chunk.subarray(0, cut).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        this.ingest(file, entry);
      } catch (err) {
        console.error('mirror:', err.message);
      }
    }
  }

  // ---------- transcript → office ----------

  ingest(file, entry) {
    if (!['user', 'assistant', 'system'].includes(entry.type)) return;
    // Sessions started from the web ("sdk-cli") are already shown by their own runner.
    if (entry.entrypoint !== 'cli' || !entry.sessionId || !entry.cwd) return;
    const session = this.session(entry.sessionId, entry.cwd);
    const sub = SUBAGENT_FILE.exec(file);
    if (sub) this.ingestSubagent(session, file, sub[1], entry);
    else this.ingestMain(session, entry);
  }

  session(id, cwd) {
    let s = this.sessions.get(id);
    if (!s) {
      const pid = this.hub.upsertProject(cwd, 'cli').id;
      s = { id, pid, turnOpen: false, endTimer: null, agents: new Map(), queued: new Map(), lastSeen: Date.now() };
      s.translator = new StreamTranslator({
        office: (evt) => this.hub.office(pid, { source: 'cli', ...evt }),
        chat: (msg) => this.hub.chat(pid, { source: 'cli', ...msg }),
        updateChat: (chatId, patch) => this.hub.updateChat(pid, chatId, patch),
      });
      this.sessions.set(id, s);
    }
    s.lastSeen = Date.now();
    return s;
  }

  ingestMain(s, entry) {
    if (entry.type === 'system') {
      if (entry.subtype === 'turn_duration') this.endTurn(s, { durationMs: entry.durationMs });
      else if (entry.subtype === 'compact_boundary') s.translator.handle({ type: 'system', subtype: 'compact_boundary' });
      return;
    }
    const content = entry.message?.content;

    if (entry.type === 'user') {
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
      if (INTERRUPTED.test(text)) return this.endTurn(s, { interrupted: true });
      if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) {
        this.ensureTurn(s);
        s.translator.handle({ type: 'user', message: entry.message, parent_tool_use_id: null });
        return;
      }
      const origin = entry.origin ?? {};
      if (origin.handback && s.agents.has(origin.from)) s.translator.finishAgent(s.agents.get(origin.from));
      // Only what the user typed counts as a prompt (not slash commands, reminders, hand-backs).
      if (entry.promptSource === 'typed' && !entry.isMeta && text.trim()) this.startTurn(s, text);
      return;
    }

    this.ensureTurn(s);
    s.translator.handle({ type: 'assistant', message: entry.message, parent_tool_use_id: null });
    clearTimeout(s.endTimer);
    if (entry.message?.stop_reason === 'end_turn') s.endTimer = setTimeout(() => this.endTurn(s, {}), END_TURN_DELAY_MS);
  }

  ingestSubagent(s, file, agentId, entry) {
    if (!s.agents.has(agentId)) {
      const meta = readMeta(file);
      if (!meta?.toolUseId) {
        // Meta file not written yet: hold the entries until it is.
        if (!s.queued.has(agentId)) s.queued.set(agentId, []);
        s.queued.get(agentId).push(entry);
        return;
      }
      s.agents.set(agentId, meta.toolUseId);
      s.translator.registerAgent(meta.toolUseId, meta.agentType);
      const held = s.queued.get(agentId) ?? [];
      s.queued.delete(agentId);
      for (const e of held) this.ingestSubagent(s, file, agentId, e);
    }
    const parent = s.agents.get(agentId);
    const content = entry.message?.content;
    if (entry.type === 'assistant') {
      s.translator.handle({ type: 'assistant', message: entry.message, parent_tool_use_id: parent });
      if (Array.isArray(content) && content.some((b) => b.type === 'tool_use' && b.name === 'SubagentHandback')) s.translator.finishAgent(parent);
    } else if (entry.type === 'user' && Array.isArray(content)) {
      s.translator.handle({ type: 'user', message: entry.message, parent_tool_use_id: parent });
    }
  }

  startTurn(s, text) {
    if (s.turnOpen) this.endTurn(s, {});
    s.turnOpen = true;
    this.hub.chat(s.pid, { kind: 'user', text, source: 'cli' });
    this.hub.office(s.pid, { kind: 'prompt', role: 'claude', label: truncate(text, 120), source: 'cli' });
    this.hub.setStatus(s.pid, { cliBusy: true, cliSession: s.id });
  }

  ensureTurn(s) {
    if (s.turnOpen) return;
    s.turnOpen = true;
    this.hub.setStatus(s.pid, { cliBusy: true, cliSession: s.id });
  }

  endTurn(s, { durationMs, interrupted }) {
    clearTimeout(s.endTimer);
    if (!s.turnOpen) return;
    s.turnOpen = false;
    if (interrupted) s.translator.handle({ type: 'result', subtype: 'interrupted', is_error: true, result: 'Dihentikan di terminal' });
    else s.translator.handle({ type: 'result', subtype: 'success', is_error: false, duration_ms: durationMs, quiet: !durationMs, permission_denials: [] });
    this.hub.setStatus(s.pid, { cliBusy: false });
  }
}
