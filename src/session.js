// Runs one long-lived headless Claude Code process per project and bridges it to the web, as a thin
// client of Claude Code's own control protocol (the one its IDE extensions speak):
//   - prompts go in over stdin (stream-json) and Claude Code queues them itself, so a message sent
//     mid-turn reaches Claude at the next tool boundary, exactly as in the CLI;
//   - permission prompts (`can_use_tool` control requests) are answered from the browser;
//   - mode / model / effort switches, rewind, MCP and background tasks are control requests, so they
//     do what the CLI's Shift+Tab, /model, /effort, Esc Esc, /mcp and /tasks do.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acpSessionClass } from './acp-session.js';
import { autoContext, classifyEffort } from './effort-classifier.js';
import { shortModelLabel, tierFor, classifierModelFor } from './model-auto.js';
import { killTree } from './proc.js';
import { attachmentChips, contentBlocks } from './attachments.js';
import { PERMISSION_MODES } from './hub.js';
import { HttpError } from './routes/http.js';
import { ENGINE_LABEL, bridgeNote, needsBridge, otherChat } from './handoff.js';
import { describeTool, inferRole } from './roles.js';
import { promptChain } from './transcripts.js';
import { StreamTranslator } from './translator.js';
import { clip, truncate } from './util.js';

const IDLE_SHUTDOWN_MS = 20 * 60 * 1000;
const INTERRUPT_GRACE_MS = 6000;
const STDERR_TAIL = 4000;
const SHELL_TIMEOUT_MS = 2 * 60 * 1000;
const SHELL_OUTPUT = 30000;
const CONTROL_TIMEOUT_MS = 30_000;
const CATALOG_TIMEOUT_MS = 60_000;
// Server stopping mid-turn: how long Claude Code gets to end the turn after the interrupt (it then writes the
// interruption to its transcript, so `--resume` continues from a clean point) before its process tree is killed.
export const SHUTDOWN_GRACE_MS = 3000;
// What "Lanjutkan" sends to the cut-short session (the conversation, tool results included, is in its transcript).
export const CONTINUE_PROMPT = 'Lanjutkan pekerjaan yang terputus tadi (server Adhitron sempat di-restart di tengah giliranmu). Periksa dulu kondisi terakhir, lalu teruskan.';
const UUID = /^[0-9a-f-]{36}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' };

/** The app's "manual" is Claude Code's `default` permission mode (the CLI flag accepts both names). */
const cliMode = (mode) => (mode === 'manual' ? 'default' : mode);
const appMode = (mode) => (mode === 'default' ? 'manual' : mode);
// Only the team setting (subagents + system prompt) needs a fresh process; mode/model/effort switch live.
const restartKey = (s) => String(s.team);

const streamArgs = (claude) => [...claude.args, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

/** Trims tool input to what the approval card needs to show. */
function previewInput(tool, input = {}) {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return { command: clip(input.command, 4000), description: input.description };
    case 'Write':
      return { file_path: input.file_path, content: clip(input.content, 3000) };
    case 'Edit':
      return { file_path: input.file_path, old_string: clip(input.old_string, 1500), new_string: clip(input.new_string, 1500) };
    case 'MultiEdit':
      return { file_path: input.file_path, edits: (input.edits ?? []).slice(0, 3) };
    case 'AskUserQuestion':
      return { questions: input.questions ?? [] };
    case 'ExitPlanMode':
      return { plan: clip(input.plan, 12000) };
    case 'WebFetch':
      return { url: input.url, prompt: input.prompt };
    default:
      return { json: clip(JSON.stringify(input, null, 2), 3000) };
  }
}

/** What the browser needs from Claude Code's `initialize` answer: the /model picker and slash commands. */
function catalogOf(init) {
  return {
    models: (init.models ?? [])
      .filter((m) => m?.value && !m.disabled)
      .map((m) => ({ value: m.value, displayName: m.displayName ?? m.value, description: clip(m.description ?? '', 160), efforts: m.supportedEffortLevels ?? [] })),
    commands: (init.commands ?? [])
      .filter((c) => c?.name)
      .map((c) => ({ name: c.name, description: clip(c.description ?? '', 200), argumentHint: c.argumentHint || undefined, aliases: c.aliases?.length ? c.aliases : undefined })),
    version: init.claude_code_version ?? null,
  };
}

export class SessionManager {
  constructor({ hub, claude, opencode = null, agents, teamPrompt, ledger, account }) {
    this.hub = hub;
    this.claude = claude;
    this.opencode = opencode; // src/opencode-bin.js: the engine of projects set to OpenCode
    this.agents = agents;
    this.teamPrompt = teamPrompt;
    this.ledger = ledger;
    this.account = account;
    this.sessions = new Map();
    this.taskQueue = null; // 📋 Antrian, set by server.js: a waiting item blocks a project's engine switch
  }

  /**
   * The team as files for `--agents <file>` and `--append-system-prompt-file` (inline they overflow Windows'
   * command line). Content-addressed names: a process still running with the previous team keeps its files;
   * older ones are pruned (only the newest few stay).
   */
  teamFiles() {
    const dir = path.join(this.hub.dataDir ?? os.tmpdir(), 'team');
    const agents = JSON.stringify(this.agents);
    const hash = createHash('sha256').update(agents).update('\0').update(this.teamPrompt ?? '').digest('hex').slice(0, 16);
    const agentsFile = path.join(dir, `agents-${hash}.json`);
    const promptFile = path.join(dir, `lead-${hash}.md`);
    if (!existsSync(agentsFile) || !existsSync(promptFile)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(promptFile, this.teamPrompt ?? '', 'utf8');
      writeFileSync(agentsFile, agents, 'utf8'); // written last: its presence means both are complete
      this.pruneTeamFiles(dir, hash);
    }
    return { agentsFile, promptFile };
  }

  /**
   * Mode tim for OpenCode: one config file (OPENCODE_CONFIG) with the roles as subagents (`agents`, OpenCode 2.x
   * schema: description + system prompt, mode subagent) and the Lead's prompt as `instructions`. Same hash and
   * pruning as teamFiles; the user's own OpenCode config stays as it is (this is one more layer).
   */
  openCodeTeamConfig() {
    const { agentsFile } = this.teamFiles();
    const hash = path.basename(agentsFile).match(/-([0-9a-f]{16})\./)[1];
    const dir = path.dirname(agentsFile);
    const configFile = path.join(dir, `opencode-${hash}.json`);
    if (!existsSync(configFile)) {
      const leadFile = path.join(dir, `opencode-lead-${hash}.md`);
      writeFileSync(leadFile, `${this.teamPrompt ?? ''}\n\nIn OpenCode, delegate with the \`subagent\` tool: \`agent\` = the role name above (pm, ba, backend…), \`prompt\` = the task.\n`, 'utf8');
      const agents = {};
      for (const [name, a] of Object.entries(this.agents)) agents[name] = { description: a.description ?? name, system: a.prompt ?? '', mode: 'subagent' };
      writeFileSync(configFile, JSON.stringify({ agents, instructions: [leadFile] }), 'utf8'); // last: complete once present
    }
    return configFile;
  }

  pruneTeamFiles(dir, keep, max = 6) {
    try {
      const files = readdirSync(dir).filter((f) => /^(agents|lead|opencode|opencode-lead)-[0-9a-f]{16}.(json|md)$/.test(f) && !f.includes(keep));
      // oldest first by modification time (readdir order is by name, i.e. random for hashes)
      const age = new Map();
      for (const f of files) {
        const h = f.match(/-([0-9a-f]{16})./)[1];
        age.set(h, Math.max(age.get(h) ?? 0, statSync(path.join(dir, f)).mtimeMs));
      }
      const hashes = [...age.keys()].sort((a, b) => age.get(a) - age.get(b));
      for (const h of hashes.slice(0, Math.max(0, hashes.length - (max - 1)))) {
        for (const f of files.filter((name) => name.includes(h))) rmSync(path.join(dir, f), { force: true });
      }
    } catch {
      // best effort: stale files only cost a few KB
    }
  }

  /**
   * After a Claude Code login/logout every running Claude process still holds the old credentials: idle ones
   * respawn on the next prompt, busy ones finish their turn first (see becameIdle). OpenCode sessions are left
   * alone (their provider credentials are separate: openCodeAccountChanged).
   */
  accountChanged() {
    for (const session of this.sessions.values()) {
      if (session.engine !== 'claude') continue;
      if (session.busy) session.staleAccount = true;
      else session.closeChild();
    }
    this.probeCatalog(); // which models are offered depends on the account
  }

  /** After an OpenCode provider login/logout: idle OpenCode processes restart with the new credentials. */
  openCodeAccountChanged() {
    for (const session of this.sessions.values()) {
      if (session.engine !== 'opencode') continue;
      if (session.busy) session.restartPending = true;
      else session.closeChild();
    }
  }

  /**
   * A plan turn is about to start (build or revision): if Model Auto / Effort Auto is on, classify its text (the
   * APPROVED plan, not the short "kerjakan" that started it) and apply the result before the turn begins. While the
   * classifier runs, `planPreparing` tells every client to show the same loading row as a normal build. One chat line
   * reports both choices, so a slow classifier never looks like a stuck app. Returns null when both are manual.
   */
  async preparePlanTurn(projectId, text = '', kind = 'build') {
    const settings = this.hub.settingsFor(projectId);
    if (!settings.effortAuto && !settings.modelAuto) return null;
    const engine = this.hub.engineOf(projectId);
    this.hub.setStatus(projectId, { planPreparing: kind });
    try {
      const auto = await classifyEffort({
        engine,
        claude: this.claude,
        opencode: this.opencode,
        classifierModel: classifierModelFor(engine, settings.modelTiers),
        text: String(text ?? ''),
        context: autoContext(this.hub, projectId),
      });
      const patch = {};
      let autoEffort = null;
      let autoModel = null;
      if (settings.effortAuto) {
        const effort = auto.effort ?? auto.level;
        patch.effort = effort;
        patch.effortAuto = true;
        autoEffort = { ...auto, level: effort };
      }
      if (settings.modelAuto) {
        const tier = tierFor(auto.level, engine, settings.modelTiers);
        // Report the model even when it already matches: the user asked what Auto picked for this plan turn.
        autoModel = { tier: tier.key, label: tier.label, model: tier.model, reason: auto.reason ?? '' };
        if (tier.model !== settings.model) {
          patch.model = tier.model;
          patch.modelAuto = true;
        }
      }
      if (Object.keys(patch).length) {
        this.hub.updateSettings(projectId, patch);
        const session = this.sessions.get(projectId);
        if (session?.applyAutoSettings) await session.applyAutoSettings(patch);
      }
      const parts = [];
      if (autoEffort) parts.push(`Effort ${EFFORT_LABEL[autoEffort.level] ?? String(autoEffort.level)}`);
      if (autoModel) parts.push(`Model ${autoModel.label} → ${shortModelLabel(autoModel.model)}`);
      if (parts.length) {
        const why = String(autoModel?.reason ?? autoEffort?.reason ?? '').trim().slice(0, 80);
        this.hub.chat(projectId, { kind: 'info', modelAuto: Boolean(autoModel), text: `⚙️ Auto ${kind}: ${parts.join(' · ')}${why ? ` — ${why}` : ''}` });
      }
      return { autoEffort, autoModel };
    } finally {
      this.hub.setStatus(projectId, { planPreparing: null });
    }
  }

  /**
   * opencode.json changed: idle OpenCode processes are let go so the next turn reads the new agents/config. Busy
   * ones get a pending restart (the caller normally refuses while a turn runs). Returns how many were touched.
   */
  openCodeConfigChanged(projectId = null) {
    let changed = 0;
    for (const session of this.sessions.values()) {
      if (session.engine !== 'opencode' || (projectId && session.id !== projectId)) continue;
      changed++;
      if (session.busy) session.restartPending = true;
      else session.closeChild();
    }
    return changed;
  }

  /**
   * Asks Claude Code what it offers — the models of its /model picker and the slash commands with
   * their descriptions — without a model call: a short-lived process answers `initialize` and exits.
   */
  probeCatalog(cwd = os.homedir()) {
    if (!this.claude) return Promise.resolve(null);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.claude.command, streamArgs(this.claude), { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, OFFICE_MANAGED: '1' } });
      } catch {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (catalog) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.end();
        if (catalog) this.hub.setCatalog(catalog, { replace: true });
        resolve(catalog);
      };
      const timer = setTimeout(() => {
        finish(null);
        child.kill();
      }, CATALOG_TIMEOUT_MS);
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.type === 'control_response' && msg.response?.request_id === 'office-catalog') {
            finish(msg.response.subtype === 'success' ? catalogOf(msg.response.response ?? {}) : null);
          }
        }
      });
      child.stdin.on('error', () => {});
      child.on('error', () => finish(null));
      child.on('exit', () => finish(null));
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'office-catalog', request: { subtype: 'initialize' } })}\n`);
    });
  }

  /** A project's session started: its own commands (project skills, plugins) join the list. */
  noteCatalog(init) {
    this.hub.setCatalog(catalogOf(init));
  }

  get(project) {
    const engine = this.hub.engineOf(project.id);
    // A model picked for the other engine moved this project: consumed once, whether or not a session exists yet.
    const from = this.hub.takeEngineFrom?.(project.id) ?? null;
    let session = this.sessions.get(project.id);
    if (session && session.engine !== engine) {
      // Never reuse the other engine's process for this history.
      if (session.turnActive() || session.busy || session.inflight?.size) {
        throw new HttpError(409, `Sesi ${session.engine === 'opencode' ? 'OpenCode' : 'Claude Code'} masih berjalan di project ini. Tunggu selesai atau hentikan dulu.`);
      }
      session.clearHandoffContext();
      session.closeChild();
      this.sessions.delete(project.id);
      session = null;
    }
    if (!session) {
      session = engine === 'opencode' ? new AcpSession(this, project) : new ClaudeSession(this, project);
      this.sessions.set(project.id, session);
      // The note from the engine this project just left goes with the next prompt (session-only, no divider, no
      // model call, no git). needsBridge also keeps a switch back and forth without new work from repeating it.
      if (from && from !== engine) {
        this.hub.save?.(); // the conversation that just ended must be on disk before it is read below
        if (needsBridge(this.hub, project.id, engine)) {
          const chat = otherChat(this.hub, from, project.id);
          const note = bridgeNote(chat, from);
          if (note) {
            const messages = chat.filter((m) => m.kind === 'user' || m.kind === 'assistant').length;
            session.setHandoffContext(note);
            this.hub.chat(project.id, {
              kind: 'info',
              contextBridge: { from, to: engine, messages },
              text: `🔁 Ringkasan konteks dari ${ENGINE_LABEL[from]} dikirim ke ${ENGINE_LABEL[engine]} (${messages} pesan).`,
            });
          }
        }
      }
    }
    return session;
  }

  /**
   * The server is stopping. Turns still running are recorded as cut short first (on disk, so even a hard
   * exit right after keeps the record), then interrupted like Esc so Claude Code closes the turn in its
   * transcript; whatever has not finished within `graceMs` is killed. Idle processes just get their stdin closed.
   */
  async shutdown({ graceMs = SHUTDOWN_GRACE_MS } = {}) {
    this.stopping = true;
    const all = [...this.sessions.values()];
    const running = all.filter((s) => s.child && s.turnActive());
    for (const s of running) s.beginShutdown();
    await Promise.all(running.map((s) => s.waitTurnEnd(graceMs)));
    for (const s of all) s.closeChild();
  }
}

export class ClaudeSession {
  constructor(manager, project) {
    this.engine = 'claude';
    this.m = manager;
    this.hub = manager.hub;
    this.project = project;
    this.id = project.id;
    this.child = null;
    this.busy = false;
    this.inflight = new Map(); // prompt uuid -> { chatId, text, state: 'queued' | 'started', announced }
    this.pending = new Map(); // control request id -> { resolve, reject, timer }
    this.requestSeq = 0;
    this.applied = null; // { mode, model, effort } of the running process
    this.resumeAt = null; // conversation rewind: --resume-session-at for the next start
    this.chainLeaf = null; // where the conversation stands after a rewind, until the next prompt
    this.autoApprove = false;
    this.restartPending = false;
    this.stderr = '';
    this.shellContext = []; // `!command` results not yet sent to Claude
    this.pendingHandoff = ''; // session-only context-bridge note: attached once to the next prompt, never written to a file
  }

  // ---------- public ----------

  /** Save a context-bridge note as session memory. It is sent once with the next prompt, never as its own turn. */
  setHandoffContext(text) {
    this.pendingHandoff = String(text ?? '').trim().slice(0, 20_000);
    this.hub.setStatus(this.id, { handoffReady: Boolean(this.pendingHandoff) });
    return this.pendingHandoff;
  }

  clearHandoffContext() {
    this.pendingHandoff = '';
    this.hub.setStatus(this.id, { handoffReady: false });
  }

  /** The pending note goes with this prompt; after that it lives in the session's own conversation history. */
  takeHandoffContext() {
    const text = this.pendingHandoff;
    if (!text) return '';
    this.pendingHandoff = '';
    this.hub.setStatus(this.id, { handoffReady: false });
    return text;
  }

  /**
   * @param attachments 📎 files checked by src/attachments.js readAttachments(): [{ kind, name, size, mediaType, data?, text? }]
   * @param extra more fields for the prompt's chat bubble (`queueItem`: sent from 📋 Antrian, src/queue.js).
   *   `queueChatId`: the bubble that was already made when the prompt joined the queue at the global turn limit —
   *   that same bubble starts the turn (never a second one next to it).
   * @returns {{ chatId: string }} the prompt's chat bubble
   */
  prompt(text, attachments = [], extra = {}) {
    this.hub.clearInterrupted(this.id); // the user carries on (or starts over): the cut-short notice is done
    const uuid = randomUUID();
    const { queueChatId, ...fields } = extra ?? {};
    // Only a bubble that is still in this project's chat can be reused: a trimmed/deleted one gets a fresh bubble.
    const queued = typeof queueChatId === 'string' ? this.hub.rt(this.id).chat.findLast((m) => m.id === queueChatId) : null;
    let chatId;
    if (queued) {
      chatId = queued.id;
      this.hub.updateChat(this.id, chatId, {
        queued: false,
        queuePosition: null,
        uuid,
        ...(fields.autoEffort && { autoEffort: fields.autoEffort }),
        ...(fields.autoModel && { autoModel: fields.autoModel }),
      });
    } else {
      chatId = this.hub.chat(this.id, { kind: 'user', text, source: 'web', attachments: attachments.length ? attachmentChips(attachments) : undefined, queued: this.busy || undefined, uuid, ...fields });
    }
    if (!this.m.claude) {
      this.hub.updateChat(this.id, chatId, { queued: false, cancelled: true });
      this.hub.chat(this.id, { kind: 'error', text: 'Claude Code tidak ditemukan. Pastikan `claude` terpasang, atau set env CLAUDE_BIN.' });
      return { chatId };
    }
    this.syncSettings(); // a mode/model switch reaches Claude Code before the prompt does
    if (!this.ensureChild()) {
      this.hub.updateChat(this.id, chatId, { queued: false, cancelled: true });
      return { chatId };
    }
    // The context-bridge note rides with this one prompt; the bubble still shows only what the user typed.
    const handoff = this.takeHandoffContext();
    // Shell output the user ran with `!` goes to Claude ahead of the prompt, not into the bubble.
    const context = this.shellContext.splice(0).join('\n');
    const body = [handoff ? `[KONTEKS SESI — INFORMASI, BUKAN PERMINTAAN BARU]\n${handoff}\n[/KONTEKS SESI]` : '', context, text].filter(Boolean).join('\n\n');
    const content = attachments.length ? contentBlocks(attachments, body) : body;
    // files: how many 📎 attachments rode along (only the count is ever kept, see Hub.beginTurn).
    const item = { chatId, text, files: attachments.length, state: this.busy ? 'queued' : 'started', announced: false };
    this.inflight.set(uuid, item);
    if (item.state === 'started') this.announce(item);
    this.chainLeaf = null;
    clearTimeout(this.idleTimer);
    this.write({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' });
    this.afterProgress();
    return { chatId };
  }

  /**
   * `!command` (bash mode, like the CLI): runs in the project folder without asking Claude, and the
   * output rides along as context with the next prompt, in the same tags the CLI uses.
   */
  shell(command) {
    const chatId = this.hub.chat(this.id, { kind: 'shell', text: command, status: 'running' });
    const [cmd, args] = process.platform === 'win32' ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', command]] : ['/bin/sh', ['-c', command]];
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd: this.project.path, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.hub.updateChat(this.id, chatId, { status: 'fail', output: err.message });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-SHELL_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-SHELL_OUTPUT); });
    const timer = setTimeout(() => this.killTree(child.pid), SHELL_TIMEOUT_MS);
    const finish = (code, error) => {
      clearTimeout(timer);
      const output = [stdout.trimEnd(), stderr.trimEnd(), error].filter(Boolean).join('\n');
      this.hub.updateChat(this.id, chatId, { status: code === 0 ? 'ok' : 'fail', exitCode: code, output: clip(output, 8000) || '(tanpa output)' });
      this.shellContext.push(
        `<bash-input>${command}</bash-input>\n<bash-stdout>${clip(stdout.trimEnd(), 8000)}</bash-stdout><bash-stderr>${clip([stderr.trimEnd(), error].filter(Boolean).join('\n'), 4000)}</bash-stderr>`,
      );
    };
    child.on('error', (err) => finish(-1, err.message));
    child.on('close', (code) => finish(code ?? -1));
  }

  /** Continue an existing Claude Code session (from the CLI or an earlier web session). */
  resume(sessionId, history) {
    this.stop();
    this.closeChild();
    this.autoApprove = false;
    this.resumeAt = null;
    this.chainLeaf = null;
    this.clearHandoffContext();
    this.hub.clearInterrupted(this.id);
    this.hub.setSessionId(this.id, sessionId);
    this.hub.setStatus(this.id, { todos: null, context: null, tasks: null, title: null }); // known again after the first turn
    this.hub.chat(this.id, { kind: 'divider', text: `Melanjutkan sesi ${sessionId.slice(0, 8)}` });
    for (const msg of history) this.hub.chat(this.id, msg);
  }

  /**
   * Stop / Esc: queued prompts leave Claude Code's queue, the running turn is interrupted — also a turn Claude Code
   * started by itself (reacting to a finished background task: no prompt of ours in flight) — and the background
   * tasks (run_in_background shells, background subagents) are stopped too. Otherwise one finishing a moment later
   * starts yet another turn, and Stop seemed to do nothing until the background was stopped by hand.
   */
  stop() {
    for (const [uuid, item] of this.inflight) {
      if (item.state === 'started') continue;
      this.request({ subtype: 'cancel_async_message', message_uuid: uuid })
        .then((r) => {
          if (r?.cancelled === false || !this.inflight.has(uuid)) return; // it already reached Claude
          this.inflight.delete(uuid);
          this.hub.updateChat(this.id, item.chatId, { queued: false, cancelled: true });
          this.afterProgress();
        })
        .catch(() => {});
    }
    this.hub.cancelApprovals(this.id);
    const running = [...this.inflight.values()].some((i) => i.state === 'started') || Boolean(this.autoTurn);
    if (this.child && running) {
      this.interrupting = true;
      this.request({ subtype: 'interrupt' }).catch(() => {});
      clearTimeout(this.killTimer);
      this.killTimer = setTimeout(() => this.turnActive() && this.kill(), INTERRUPT_GRACE_MS);
    }
    if (this.child) for (const taskId of this.translator?.runningTaskIds() ?? []) this.stopTask(taskId).catch(() => {});
    this.updateStatus();
  }

  reset() {
    this.stop();
    this.closeChild();
    this.hub.clearInterrupted(this.id);
    this.hub.setSessionId(this.id, null);
    this.hub.setStatus(this.id, { todos: null, context: null, tasks: null, title: null });
    this.shellContext = [];
    this.resumeAt = null;
    this.chainLeaf = null;
    this.autoApprove = false;
    this.clearHandoffContext();
    this.hub.clearChat(this.id); // a new session starts with an empty chat column; engine history stays in Riwayat sesi
  }

  // ---------- a turn cut short by a server stop ----------

  /**
   * "Lanjutkan": continues the cut-short turn in the same Claude Code session (the next start passes
   * `--resume <its id>`). A turn cut short before Claude Code even reported its session id has nothing to
   * resume: then its prompt is sent again instead.
   * 📎 Attachments: with a session id they are already in that conversation (Claude Code wrote the prompt with its
   * files to the transcript), so the fixed continue prompt needs nothing more. A resent prompt goes out as text only:
   * the file contents are never stored (state.json), so `lostAttachments` tells the browser how many did not go along.
   * @returns {{ ok: true, sessionId: string|null, resent: boolean, lostAttachments: number }}
   */
  continueInterrupted() {
    const turn = this.hub.interruptedFor(this.id);
    if (!turn) throw Object.assign(new Error('Tidak ada giliran terputus di project ini.'), { status: 404 });
    if (this.turnActive()) throw Object.assign(new Error('Tim sedang bekerja. Tunggu sampai selesai atau hentikan dulu.'), { status: 409 });
    if (turn.sessionId && turn.sessionId !== this.hub.sessionIdFor(this.id)) {
      // Defensive: switching sessions clears the notice, so normally this is already the current one.
      this.closeChild();
      this.resumeAt = null;
      this.chainLeaf = null;
      this.hub.setSessionId(this.id, turn.sessionId);
    }
    const resent = !turn.sessionId && Boolean(turn.prompt);
    this.prompt(resent ? turn.prompt : CONTINUE_PROMPT); // clears the notice
    return { ok: true, sessionId: turn.sessionId ?? null, resent, lostAttachments: resent ? turn.attachments || 0 : 0 };
  }

  /** A turn is running: one of our prompts, or a turn Claude Code started by itself. */
  turnActive() {
    return this.busy || Boolean(this.autoTurn);
  }

  /** Keeps the on-disk "turn in progress" marker in step with the turn (see Hub.beginTurn). */
  trackTurn() {
    if (this.m.stopping) return; // from here on the shutdown owns the marker
    if (!this.turnActive()) {
      if (this.marked) this.hub.endTurn(this.id);
      this.marked = null;
      return;
    }
    // The prompt the turn works on: the newest started one (several can share a turn).
    let uuid = null;
    let text = null;
    let files = 0;
    for (const [id, item] of this.inflight) if (item.state === 'started') [uuid, text, files] = [id, item.text, item.files ?? 0];
    const sessionId = this.hub.sessionIdFor(this.id);
    if (this.marked?.uuid === uuid && this.marked?.sessionId === sessionId) return;
    this.marked = { uuid, sessionId };
    this.hub.beginTurn(this.id, { sessionId, prompt: text, uuid, attachments: files });
  }

  /** Server stopping mid-turn: record the turn as cut short, then interrupt it like Esc. */
  beginShutdown() {
    this.shuttingDown = true;
    this.hub.interruptTurn(this.id, 'shutdown');
    // A permission prompt nobody can answer any more. The reason ends up in the transcript, so after "Lanjutkan"
    // Claude knows it was the restart, not the user, that refused.
    for (const { approval } of [...this.hub.approvals.values()]) {
      if (approval.project !== this.id) continue;
      this.hub.resolveApproval(approval.id, { allow: false, cancelled: true, message: 'Server Adhitron di-restart sebelum izin ini dijawab. Minta izin lagi bila masih perlu.' });
    }
    this.interrupting = true;
    this.request({ subtype: 'interrupt' }).catch(() => {});
  }

  /** Resolves once the running turn ended (its result arrived or the process exited), or after `ms`. */
  async waitTurnEnd(ms) {
    const deadline = Date.now() + ms;
    while (this.child && this.turnActive() && Date.now() < deadline) await sleep(50);
  }

  /** Settings changed: mode, model and effort switch in the running process, like Shift+Tab, /model and /effort. */
  syncSettings() {
    if (!this.child || !this.applied) return; // a new process gets them as flags
    const s = this.hub.settingsFor(this.id);
    const a = this.applied;
    // The team setting, and going back to the default effort, need a fresh process.
    if (restartKey(s) !== this.childKey || (a.effort && !s.effort)) {
      if (this.busy) this.restartPending = true;
      else this.closeChild();
      return;
    }
    if (s.mode !== a.mode) {
      a.mode = s.mode;
      this.request({ subtype: 'set_permission_mode', mode: cliMode(s.mode) }).catch((err) => this.controlFailed('mode izin', err));
    }
    if (s.model !== a.model) {
      const previous = a.model;
      a.model = s.model;
      this.request({ subtype: 'set_model', model: s.model || 'default' })
        .then((r) => {
          this.hub.setStatus(this.id, { activeModel: r?.model ?? null });
          this.refreshContext(); // another model can have another context window
        })
        .catch((err) => {
          // Unknown model: keep the one that works, as /model does.
          a.model = previous;
          this.hub.updateSettings(this.id, { model: previous });
          this.controlFailed('model', err);
        });
    }
    if (s.effort !== a.effort) {
      a.effort = s.effort;
      this.request({ subtype: 'apply_flag_settings', settings: { effortLevel: s.effort } }).catch((err) => this.controlFailed('effort', err));
    }
  }

  /** Apply Auto's model/effort to the running process and wait, so a plan's build turn starts with them. */
  async applyAutoSettings({ model, effort } = {}) {
    if (!this.child || !this.applied) return;
    const a = this.applied;
    if (typeof model === 'string' && model && model !== a.model) {
      const previous = a.model;
      a.model = model;
      try {
        const r = await this.request({ subtype: 'set_model', model });
        this.hub.setStatus(this.id, { activeModel: r?.model ?? null });
        this.refreshContext();
      } catch (err) {
        a.model = previous;
        this.hub.updateSettings(this.id, { model: previous, modelAuto: true });
        this.controlFailed('model', err);
      }
    }
    if (typeof effort === 'string' && effort && effort !== a.effort) {
      a.effort = effort;
      try {
        await this.request({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } });
      } catch (err) {
        this.controlFailed('effort', err);
      }
    }
  }

  // ---------- rewind (Esc Esc) ----------

  /** The current conversation's prompts, newest first. */
  rewindPoints() {
    const sessionId = this.hub.sessionIdFor(this.id);
    if (!sessionId) return [];
    return promptChain(this.project.path, sessionId, { leaf: this.chainLeaf })
      .filter((p) => UUID.test(String(p.uuid))) // the transcript is a file on disk: only well-formed ids reach the page
      .reverse()
      .slice(0, 80)
      .map(({ uuid, text, ts }) => ({ uuid, text: truncate(text, 400), ts }));
  }

  /** Which files a code rewind to just before this prompt would restore (dry run). */
  async rewindPreview(uuid) {
    if (!UUID.test(uuid)) throw new Error('Pesan tidak dikenal.');
    if (!this.ensureChild()) throw new Error('Claude Code tidak bisa dijalankan.');
    return this.request({ subtype: 'rewind_files', user_message_id: uuid, dry_run: true });
  }

  /**
   * Back to just before one of your prompts: the code (Claude Code's file checkpoints), the
   * conversation (the next start resumes at the entry before it), or both — the CLI's three choices.
   */
  async rewind(uuid, { code = false, conversation = false } = {}) {
    if (!code && !conversation) throw new Error('Pilih kode, percakapan, atau keduanya.');
    if (this.busy) throw new Error('Hentikan dulu pekerjaan yang sedang berjalan (Esc).');
    const sessionId = this.hub.sessionIdFor(this.id);
    const point = sessionId ? promptChain(this.project.path, sessionId, { leaf: this.chainLeaf }).find((p) => p.uuid === uuid) : null;
    if (!point) throw new Error('Pesan itu tidak ada di percakapan ini.');
    if (code) {
      if (!this.ensureChild()) throw new Error('Claude Code tidak bisa dijalankan.');
      const files = await this.request({ subtype: 'rewind_files', user_message_id: uuid });
      if (!files.canRewind) throw new Error(files.error || 'Perubahan file sejak pesan itu tidak bisa dikembalikan.');
    }
    if (conversation) {
      this.closeChild();
      this.clearHandoffContext(); // the conversation moved: session memory for the old position is stale
      this.hub.clearInterrupted(this.id); // the conversation moved: a cut-short turn after this point is gone
      if (point.parentUuid) {
        this.resumeAt = point.parentUuid;
        this.chainLeaf = point.parentUuid;
      } else {
        this.hub.setSessionId(this.id, null); // before the first prompt: an empty conversation
        this.chainLeaf = null;
      }
      this.shellContext = [];
      this.hub.setStatus(this.id, { todos: null, context: null, tasks: null });
      this.hub.markRewound(this.id, uuid, point.text);
    }
    const what = code && conversation ? 'Kode & percakapan' : code ? 'Kode' : 'Percakapan';
    this.hub.chat(this.id, { kind: 'divider', text: `⏪ ${what} dikembalikan ke sebelum: “${truncate(point.text, 60)}”` });
    return { ok: true, text: point.text };
  }

  // ---------- MCP servers (/mcp) ----------

  async mcpStatus() {
    if (!this.ensureChild()) throw new Error('Claude Code tidak bisa dijalankan.');
    const { mcpServers = [] } = await this.request({ subtype: 'mcp_status' });
    return mcpServers.map((s) => ({
      name: s.name,
      status: s.status,
      scope: s.scope ?? null,
      source: s.source ?? null,
      tools: Array.isArray(s.tools) ? s.tools.length : null,
      error: s.error ? truncate(s.error, 300) : null,
    }));
  }

  /** reconnect · enable · disable · login (OAuth: answers with the URL to open) · callback (pasted redirect URL). */
  async mcpAction(serverName, action, callbackUrl) {
    if (!this.ensureChild()) throw new Error('Claude Code tidak bisa dijalankan.');
    switch (action) {
      case 'reconnect':
        return this.request({ subtype: 'mcp_reconnect', serverName }, 60_000);
      case 'enable':
      case 'disable':
        return this.request({ subtype: 'mcp_toggle', serverName, enabled: action === 'enable' });
      case 'login':
        return this.request({ subtype: 'mcp_authenticate', serverName }, 60_000);
      case 'callback':
        return this.request({ subtype: 'mcp_oauth_callback_url', serverName, callbackUrl }, 60_000);
      default:
        throw new Error('Aksi MCP tidak dikenal.');
    }
  }

  // ---------- background tasks (/tasks, Ctrl+B) ----------

  taskOutput(taskId) {
    return this.request({ subtype: 'get_task_output', task_id: taskId });
  }

  stopTask(taskId) {
    return this.request({ subtype: 'stop_task', task_id: taskId });
  }

  /** Ctrl+B: the running Bash commands and subagents carry on in the background. */
  backgroundTasks() {
    return this.request({ subtype: 'background_tasks' });
  }

  /** /rename: the session's name in the history list (and in the CLI's /resume). */
  rename(title) {
    if (!this.hub.sessionIdFor(this.id)) return Promise.reject(new Error('Belum ada sesi. Kirim pesan dulu.'));
    if (!this.ensureChild()) return Promise.reject(new Error('Claude Code tidak bisa dijalankan.'));
    return this.request({ subtype: 'rename_session', title });
  }

  // ---------- process lifecycle ----------

  ensureChild() {
    return Boolean(this.child) || this.spawn(this.hub.settingsFor(this.id));
  }

  spawn(settings) {
    if (!this.m.claude) return false;
    const args = [
      ...streamArgs(this.m.claude),
      '--include-partial-messages',
      '--replay-user-messages', // prompts come back with their uuid: lifecycle + rewind points
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', settings.mode,
    ];
    if (settings.model) args.push('--model', settings.model);
    if (settings.effort) args.push('--effort', settings.effort);
    if (settings.team && Object.keys(this.m.agents).length) {
      // As files, not inline JSON: 17 roles' prompts exceed Windows' 32,767-char command line (spawn ENAMETOOLONG).
      // `--agents <file>` works with -p; the Lead's prompt goes the same way.
      const { agentsFile, promptFile } = this.m.teamFiles();
      args.push('--agents', agentsFile, '--append-system-prompt-file', promptFile);
    }
    const sessionId = this.hub.sessionIdFor(this.id);
    if (sessionId) {
      args.push('--resume', sessionId);
      if (this.resumeAt) args.push('--resume-session-at', this.resumeAt); // after a conversation rewind
      if (this.forkNext) args.push('--fork-session'); // ⑂ Cabangkan: a copy under a new id (Claude reports it in init)
    }
    this.forkNext = false;
    this.resumeAt = null;

    let child;
    try {
      child = spawn(this.m.claude.command, args, {
        cwd: this.project.path,
        // File checkpoints before every edit (always on in the interactive CLI): what rewind restores.
        env: { ...process.env, OFFICE_MANAGED: '1', CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true' },
        windowsHide: true,
      });
    } catch (err) {
      this.hub.chat(this.id, { kind: 'error', text: `Gagal menjalankan Claude Code: ${err.message}` });
      return false;
    }

    this.child = child;
    this.childKey = restartKey(settings);
    this.applied = { mode: settings.mode, model: settings.model, effort: settings.effort };
    this.lifecycleSeen = false;
    // Tokens are billed to the account whose credentials the process loaded at start.
    this.childAccount = this.m.account?.current ?? null;
    this.staleAccount = false;
    this.lastModelUsage = null; // modelUsage counts restart with the process
    this.stderr = '';
    this.translator = new StreamTranslator({
      office: (evt) => this.hub.office(this.id, evt),
      chat: (msg) => this.hub.chat(this.id, msg),
      updateChat: (chatId, patch) => this.hub.updateChat(this.id, chatId, patch),
      status: (patch) => this.hub.setStatus(this.id, patch),
      gitPushed: () => this.hub.ciWatch?.(this.id),
    }, { projectPath: this.project.path });

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
        this.onMessage(msg, child);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    child.stdin.on('error', () => {}); // EPIPE when the process dies mid-write
    child.on('error', (err) => {
      this.hub.chat(this.id, { kind: 'error', text: `Gagal menjalankan Claude Code: ${err.message}` });
    });
    child.on('exit', (code) => this.onExit(child, code));
    // The SDK's handshake: Claude Code answers with its commands, models and version.
    this.request({ subtype: 'initialize' }, CATALOG_TIMEOUT_MS)
      .then((init) => {
        this.m.noteCatalog(init);
        this.refreshContext();
      })
      .catch(() => {});
    this.updateStatus();
    return true;
  }

  /** Forgets the running process: its late output is ignored, open requests fail, queued prompts are dropped. */
  detach() {
    const child = this.child;
    this.child = null;
    this.applied = null;
    clearTimeout(this.idleTimer);
    clearTimeout(this.killTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Claude Code berhenti.'));
    }
    this.pending.clear();
    this.hub.cancelApprovals(this.id);
    for (const item of this.inflight.values()) this.hub.updateChat(this.id, item.chatId, item.state === 'started' ? { queued: false } : { queued: false, cancelled: true });
    this.inflight.clear();
    this.busy = false;
    this.autoTurn = false;
    this.interrupting = false;
    this.hub.setStatus(this.id, { working: {} }); // the process is gone: nobody it started is still at work
    return child;
  }

  /** Idle for a while: close the process — unless background tasks (agents, shells) are still running in it. */
  idleShutdown() {
    if (this.busy || this.autoTurn || this.translator?.hasRunningTasks()) {
      this.idleTimer = setTimeout(() => this.idleShutdown(), IDLE_SHUTDOWN_MS);
      return;
    }
    this.closeChild();
  }

  /**
   * Its settings files changed (🛡️ Aturan izin): Claude Code reads permission rules when it starts, so an
   * idle process is closed (the next prompt resumes the same session in a fresh one); a busy one, or one
   * with background tasks, finishes first. Returns 'none' | 'restarted' | 'pending'.
   */
  reloadSettings() {
    if (!this.child) return 'none';
    if (this.busy) {
      this.restartPending = true; // closed when the turn ends (becameIdle), like a team-setting change
      return 'pending';
    }
    // Background agents/shells still running: never cut them off; the process closes on its own once
    // they are done (idleShutdown), and the next one reads the new rules.
    if (this.autoTurn || this.translator?.hasRunningTasks()) return 'pending';
    this.closeChild();
    return 'restarted';
  }

  closeChild() {
    const busy = this.busy;
    const child = this.detach();
    if (!child) return;
    if (busy) this.killTree(child.pid);
    else child.stdin.end();
    this.updateStatus();
  }

  kill() {
    this.killTree(this.child?.pid);
  }

  killTree(pid) {
    killTree(pid); // the whole tree: Claude Code may have shells/test runners running (src/proc.js)
  }

  onExit(child, code) {
    if (child !== this.child) return; // closed on purpose
    const wasBusy = this.busy;
    // Claude Code died mid-turn on its own (not Esc): offer "Lanjutkan" as after a server restart. On a
    // Windows console Ctrl+C reaches it before the server's own shutdown, so this covers that race too.
    if (this.turnActive() && !this.interrupting && !this.m.stopping) this.hub.interruptTurn(this.id, 'exit', { announced: true });
    this.detach();
    if (wasBusy) {
      const detail = this.stderr.trim().split('\n').slice(-6).join('\n');
      this.hub.chat(this.id, { kind: 'error', text: `Claude Code berhenti (exit ${code ?? '?'}).${detail ? `\n\n\`\`\`\n${detail}\n\`\`\`` : ''}` });
      this.hub.office(this.id, { kind: 'error', role: 'claude', label: 'Proses berhenti' });
    }
    this.updateStatus();
  }

  // ---------- protocol ----------

  write(obj) {
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  /** A control request (what the SDK's Query methods send); resolves with Claude Code's answer. */
  request(request, timeout = CONTROL_TIMEOUT_MS) {
    if (!this.child) return Promise.reject(new Error('Claude Code tidak berjalan.'));
    const id = `office-${++this.requestSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Claude Code tidak menjawab.'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ type: 'control_request', request_id: id, request });
    });
  }

  onControlResponse(response) {
    const p = this.pending.get(response.request_id);
    if (!p) return;
    this.pending.delete(response.request_id);
    clearTimeout(p.timer);
    if (response.subtype === 'success') p.resolve(response.response ?? {});
    else p.reject(new Error(response.error || 'Claude Code menolak permintaan ini.'));
  }

  onMessage(msg, child) {
    if (child !== this.child) return;
    if (msg.type === 'control_request') return this.onControlRequest(msg);
    if (msg.type === 'control_response') return this.onControlResponse(msg.response ?? {});
    if (msg.type === 'command_lifecycle') return this.onLifecycle(msg);
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (msg.session_id && msg.session_id !== this.hub.sessionIdFor(this.id)) this.hub.setSessionId(this.id, msg.session_id);
      this.hub.setStatus(this.id, { activeModel: msg.model ?? null });
      if (Array.isArray(msg.slash_commands)) this.hub.setSlashCommands(msg.slash_commands);
    }
    // Claude Code changed mode itself (a plan approved, Shift+Tab in another client): follow it.
    if (msg.type === 'system' && msg.subtype === 'status' && msg.permissionMode) this.onModeReported(msg.permissionMode);
    if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
      this.m.account?.noteRateLimit(msg.rate_limit_info);
      this.m.onRateLimit?.(this.id, msg.rate_limit_info); // 📋 Antrian pauses when the quota is out (src/queue.js)
    }
    if (msg.type === 'result') this.recordUsage(msg);
    if (msg.type === 'result' && this.interrupting) {
      // The CLI reports an interrupted turn as a normal success; label it for the UI.
      msg = { ...msg, subtype: 'interrupted', is_error: true, result: this.shuttingDown ? 'Server dihentikan — giliran terputus' : 'Dihentikan oleh kamu' };
      this.interrupting = false;
    }
    // A turn Claude Code starts by itself (a background task finished and it reacts to the notification) has no
    // prompt of ours in flight, so `busy` stays false and the lead would sit idle: track it as its own turn.
    if (!this.busy && !this.autoTurn && (msg.type === 'assistant' || msg.type === 'stream_event')) {
      this.autoTurn = true;
      this.updateStatus();
    }
    this.translator.handle(msg);
    if (msg.type === 'result') {
      this.autoTurn = false;
      this.onTurnResult();
    }
  }

  /** Claude Code's own queue: each prompt goes queued → started → completed; several can share a turn. */
  onLifecycle({ command_uuid: uuid, state }) {
    this.lifecycleSeen = true;
    const item = this.inflight.get(uuid);
    if (!item || state === 'queued') return;
    if (state === 'started') {
      item.state = 'started';
      this.hub.updateChat(this.id, item.chatId, { queued: false });
      this.announce(item);
      this.updateStatus();
      return;
    }
    this.inflight.delete(uuid); // completed (or dropped)
    this.afterProgress();
  }

  announce(item) {
    if (item.announced) return;
    item.announced = true;
    this.hub.office(this.id, { kind: 'prompt', role: 'claude', label: truncate(item.text, 120) });
  }

  /** A turn ended: the prompts it worked on are done (their `completed` can come after the result). */
  onTurnResult() {
    if (this.lifecycleSeen) {
      for (const [uuid, item] of this.inflight) if (item.state === 'started') this.inflight.delete(uuid);
    } else {
      // A CLI without lifecycle events runs one queued prompt per turn, in order.
      const first = this.inflight.keys().next().value;
      if (first) this.inflight.delete(first);
      const next = this.inflight.values().next().value;
      if (next) {
        next.state = 'started';
        this.hub.updateChat(this.id, next.chatId, { queued: false });
        this.announce(next);
      }
    }
    this.afterProgress();
  }

  afterProgress() {
    const wasBusy = this.busy;
    this.busy = this.inflight.size > 0;
    if (wasBusy && !this.busy) this.becameIdle();
    this.updateStatus();
  }

  becameIdle() {
    this.interrupting = false;
    clearTimeout(this.killTimer);
    if (this.staleAccount || this.restartPending) {
      // The account or the team setting changed mid-turn: the next prompt starts a fresh process.
      this.restartPending = false;
      this.closeChild();
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.idleShutdown(), IDLE_SHUTDOWN_MS);
    this.refreshContext();
  }

  onModeReported(mode) {
    const next = appMode(mode);
    if (this.applied) this.applied.mode = next;
    if (PERMISSION_MODES.includes(next) && this.hub.settingsFor(this.id).mode !== next) this.hub.updateSettings(this.id, { mode: next });
  }

  /** Exact context usage, as /context counts it (from the last response; no extra model call). */
  refreshContext() {
    this.request({ subtype: 'get_context_usage', detail: 'summary' })
      .then((c) => {
        if (!c?.maxTokens) return;
        if (this.translator) Object.assign(this.translator, { contextWindow: c.maxTokens, autoCompactAt: c.isAutoCompactEnabled ? (c.autoCompactThreshold ?? null) : null });
        this.hub.setStatus(this.id, {
          context: { used: c.totalTokens ?? 0, window: c.maxTokens, autoCompactAt: c.isAutoCompactEnabled ? (c.autoCompactThreshold ?? null) : null },
        });
      })
      .catch(() => {});
  }

  controlFailed(what, err) {
    this.hub.chat(this.id, { kind: 'error', text: `Gagal mengganti ${what}: ${err.message}` });
  }

  /**
   * Token usage of the turn that just ended, per model (subagents included).
   * `modelUsage` is cumulative for the process, so prefer the per-turn field and
   * fall back to the difference from the previous result.
   */
  recordUsage(msg) {
    const perTurn = this.turnModelUsage(msg);
    // Per-turn totals (subagents included) for the result line and the 📋 queue budget: `total_cost_usd`
    // is cumulative for the process, so summing it per turn would count earlier turns again.
    const models = Object.values(perTurn);
    if (models.length) {
      const sum = (key) => models.reduce((n, u) => n + (Number.isFinite(u[key]) ? u[key] : 0), 0);
      msg.turnUsage = { costUsd: sum('costUSD'), outputTokens: sum('outputTokens') };
    }
    if (!this.m.ledger) return;
    Object.entries(perTurn).forEach(([model, u], i) => {
      this.m.ledger.record({
        account: this.childAccount,
        engine: 'claude',
        source: 'web',
        project: this.project,
        sessionId: msg.session_id ?? this.hub.sessionIdFor(this.id),
        model,
        input: u.inputTokens,
        output: u.outputTokens,
        cacheRead: u.cacheReadInputTokens,
        cacheWrite: u.cacheCreationInputTokens,
        costUsd: u.costUSD,
        turns: i === 0 ? 1 : 0,
      });
    });
  }

  /** Usage per model of the turn that just ended: the per-turn field, or the difference from the previous result. */
  turnModelUsage(msg) {
    let perTurn = msg.model_usage_since_last_result;
    if (!perTurn || typeof perTurn !== 'object') {
      perTurn = {};
      for (const [model, u] of Object.entries(msg.modelUsage ?? {})) {
        const prev = this.lastModelUsage?.[model] ?? {};
        perTurn[model] = Object.fromEntries(Object.entries(u).map(([k, v]) => [k, typeof v === 'number' ? v - (prev[k] ?? 0) : v]));
      }
      this.lastModelUsage = msg.modelUsage;
    }
    return perTurn;
  }

  onControlRequest(msg) {
    const req = msg.request ?? {};
    if (req.subtype !== 'can_use_tool') {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported: ${req.subtype}` } });
      return;
    }
    const kind = req.tool_name === 'AskUserQuestion' ? 'question' : req.tool_name === 'ExitPlanMode' ? 'plan' : 'tool';
    const role = this.translator.roleOf(req.tool_use_id) ?? inferRole(req.tool_name, req.input ?? {}, { projectPath: this.project.path });
    if (this.autoApprove && kind === 'tool') {
      this.respond(msg.request_id, req, role, { allow: true });
      return;
    }
    const label = describeTool(req.tool_name, req.input ?? {});
    const chatId = this.hub.chat(this.id, { kind: 'approval', role, text: label, approvalId: msg.request_id, status: 'pending' });
    this.hub.requestApproval(
      this.id,
      {
        id: msg.request_id,
        chatId,
        role,
        kind,
        tool: req.tool_name,
        label,
        description: req.description ?? '',
        input: previewInput(req.tool_name, req.input),
        canAlways: Boolean(req.permission_suggestions?.length),
      },
      (decision) => this.respond(msg.request_id, req, role, decision),
    );
    this.hub.office(this.id, { kind: 'ask', role, label, ask: kind }); // question / plan / tool look different in the office
  }

  respond(requestId, req, role, decision) {
    let response;
    if (decision.allow) {
      response = { behavior: 'allow', updatedInput: decision.answers ? { ...req.input, answers: decision.answers } : req.input };
      if (decision.always && req.permission_suggestions?.length) response.updatedPermissions = req.permission_suggestions;
      if (decision.allowAll) this.autoApprove = true;
      // Approving a plan also picks how the work continues, as the CLI's plan dialog does.
      if (req.tool_name === 'ExitPlanMode' && PERMISSION_MODES.includes(decision.mode)) {
        response.updatedPermissions = [{ type: 'setMode', mode: cliMode(decision.mode), destination: 'session' }];
        if (this.applied) this.applied.mode = decision.mode;
        this.hub.updateSettings(this.id, { mode: decision.mode });
      }
    } else {
      response = {
        behavior: 'deny',
        message: decision.cancelled && req.tool_name === 'ExitPlanMode' ? 'Selesai tanpa build; jangan lanjutkan rencana ini.' : decision.message || 'Ditolak oleh user dari web Adhitron.',
      };
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.hub.office(this.id, { kind: 'ask_done', role, allowed: Boolean(decision.allow) });
  }

  updateStatus() {
    const queue = [...this.inflight.values()].filter((i) => i.state !== 'started').length;
    this.trackTurn(); // on disk before the browser hears the turn started
    this.hub.setStatus(this.id, { alive: Boolean(this.child), busy: this.busy || Boolean(this.autoTurn), queue, autoApprove: this.autoApprove });
  }
}

// OpenCode projects: the same session, ACP instead of stream-json (src/acp-session.js).
const AcpSession = acpSessionClass(ClaudeSession, { previewInput });
