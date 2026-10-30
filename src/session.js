// Runs one long-lived headless Claude Code process per project and bridges it to the web:
// prompts go in over stdin (stream-json), events come out over stdout, and permission
// prompts (`can_use_tool` control requests) are answered from the browser.
import { spawn } from 'node:child_process';
import { describeTool, inferRole } from './roles.js';
import { StreamTranslator } from './translator.js';
import { clip, truncate } from './util.js';

const IDLE_SHUTDOWN_MS = 20 * 60 * 1000;
const INTERRUPT_GRACE_MS = 6000;
const STDERR_TAIL = 4000;

const settingsKey = (s) => `${s.mode}|${s.model}|${s.team}`;

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

export class SessionManager {
  constructor({ hub, claude, agents, teamPrompt }) {
    this.hub = hub;
    this.claude = claude;
    this.agents = agents;
    this.teamPrompt = teamPrompt;
    this.sessions = new Map();
  }

  get(project) {
    let session = this.sessions.get(project.id);
    if (!session) {
      session = new ClaudeSession(this, project);
      this.sessions.set(project.id, session);
    }
    return session;
  }

  shutdown() {
    for (const session of this.sessions.values()) session.kill();
  }
}

class ClaudeSession {
  constructor(manager, project) {
    this.m = manager;
    this.hub = manager.hub;
    this.project = project;
    this.id = project.id;
    this.child = null;
    this.busy = false;
    this.queue = [];
    this.autoApprove = false;
    this.restartPending = false;
    this.stderr = '';
  }

  // ---------- public ----------

  /** @param images [{ mediaType, data(base64) }] pasted/dropped in the browser */
  prompt(text, images = []) {
    const chatId = this.hub.chat(this.id, {
      kind: 'user',
      text,
      source: 'web',
      images: images.length || undefined,
      queued: this.busy || this.queue.length > 0,
    });
    this.queue.push({ text, images, chatId });
    this.pump();
  }

  /** Continue an existing Claude Code session (from the CLI or an earlier web session). */
  resume(sessionId, history) {
    this.stop();
    this.closeChild();
    this.autoApprove = false;
    this.hub.setSessionId(this.id, sessionId);
    this.hub.chat(this.id, { kind: 'divider', text: `Melanjutkan sesi ${sessionId.slice(0, 8)}` });
    for (const msg of history) this.hub.chat(this.id, msg);
  }

  stop() {
    for (const item of this.queue) this.hub.updateChat(this.id, item.chatId, { queued: false, cancelled: true });
    this.queue = [];
    this.hub.cancelApprovals(this.id);
    if (this.busy && this.child) {
      this.interrupting = true;
      this.write({ type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } });
      clearTimeout(this.killTimer);
      this.killTimer = setTimeout(() => this.busy && this.kill(), INTERRUPT_GRACE_MS);
    }
    this.updateStatus();
  }

  reset() {
    this.stop();
    this.closeChild();
    this.hub.setSessionId(this.id, null);
    this.autoApprove = false;
    this.hub.chat(this.id, { kind: 'divider', text: 'Sesi baru' });
  }

  // ---------- process lifecycle ----------

  pump() {
    if (this.busy || !this.queue.length) return this.updateStatus();
    if (!this.m.claude) {
      const item = this.queue.shift();
      this.hub.updateChat(this.id, item.chatId, { queued: false });
      this.hub.chat(this.id, { kind: 'error', text: 'Claude Code tidak ditemukan. Pastikan `claude` terpasang, atau set env CLAUDE_BIN.' });
      return this.updateStatus();
    }
    const settings = this.hub.settingsFor(this.id);
    if (this.child && this.childKey !== settingsKey(settings)) {
      // Mode/model changed: restart the process (the conversation resumes via --resume).
      this.restartPending = true;
      this.closeChild();
      return;
    }
    if (!this.child && !this.spawn(settings)) return;

    const item = this.queue.shift();
    this.hub.updateChat(this.id, item.chatId, { queued: false });
    this.busy = true;
    clearTimeout(this.idleTimer);
    const content = item.images?.length
      ? [
          ...item.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
          { type: 'text', text: item.text },
        ]
      : item.text;
    this.write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' });
    this.hub.office(this.id, { kind: 'prompt', role: 'claude', label: truncate(item.text, 120) });
    this.updateStatus();
  }

  spawn(settings) {
    const args = [
      ...this.m.claude.args,
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', settings.mode,
    ];
    if (settings.model) args.push('--model', settings.model);
    if (settings.team && Object.keys(this.m.agents).length) {
      args.push('--agents', JSON.stringify(this.m.agents), '--append-system-prompt', this.m.teamPrompt);
    }
    const sessionId = this.hub.sessionIdFor(this.id);
    if (sessionId) args.push('--resume', sessionId);

    let child;
    try {
      child = spawn(this.m.claude.command, args, {
        cwd: this.project.path,
        env: { ...process.env, OFFICE_MANAGED: '1' },
        windowsHide: true,
      });
    } catch (err) {
      this.hub.chat(this.id, { kind: 'error', text: `Gagal menjalankan Claude Code: ${err.message}` });
      return false;
    }

    this.child = child;
    this.childKey = settingsKey(settings);
    this.stderr = '';
    this.translator = new StreamTranslator({
      office: (evt) => this.hub.office(this.id, evt),
      chat: (msg) => this.hub.chat(this.id, msg),
      updateChat: (chatId, patch) => this.hub.updateChat(this.id, chatId, patch),
    });

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
    this.updateStatus();
    return true;
  }

  closeChild() {
    clearTimeout(this.idleTimer);
    if (this.child && !this.busy) this.child.stdin.end();
    else if (this.child) this.kill();
  }

  kill() {
    const pid = this.child?.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      // Kill the whole tree: Claude Code may have shells/test runners running.
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      this.child.kill('SIGTERM');
    }
  }

  onExit(child, code) {
    if (child !== this.child) return;
    clearTimeout(this.killTimer);
    clearTimeout(this.idleTimer);
    const wasBusy = this.busy;
    this.child = null;
    this.busy = false;
    this.hub.cancelApprovals(this.id);
    if (wasBusy) {
      const detail = this.stderr.trim().split('\n').slice(-6).join('\n');
      this.hub.chat(this.id, { kind: 'error', text: `Claude Code berhenti (exit ${code ?? '?'}).${detail ? `\n\n\`\`\`\n${detail}\n\`\`\`` : ''}` });
      this.hub.office(this.id, { kind: 'error', role: 'claude', label: 'Proses berhenti' });
    }
    this.updateStatus();
    if (this.restartPending || this.queue.length) {
      this.restartPending = false;
      this.pump();
    }
  }

  // ---------- protocol ----------

  write(obj) {
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  onMessage(msg, child) {
    if (child !== this.child) return;
    if (msg.type === 'control_request') return this.onControlRequest(msg);
    if (msg.type === 'control_response') return;
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (msg.session_id && msg.session_id !== this.hub.sessionIdFor(this.id)) this.hub.setSessionId(this.id, msg.session_id);
      this.hub.setStatus(this.id, { activeModel: msg.model ?? null });
      if (Array.isArray(msg.slash_commands)) this.hub.setSlashCommands(msg.slash_commands);
    }
    if (msg.type === 'result' && this.interrupting) {
      // The CLI reports an interrupted turn as a normal success; label it for the UI.
      msg = { ...msg, subtype: 'interrupted', is_error: true, result: 'Dihentikan oleh kamu' };
    }
    this.translator.handle(msg);
    if (msg.type === 'result') {
      this.busy = false;
      this.interrupting = false;
      clearTimeout(this.killTimer);
      this.idleTimer = setTimeout(() => this.closeChild(), IDLE_SHUTDOWN_MS);
      this.updateStatus();
      this.pump();
    }
  }

  onControlRequest(msg) {
    const req = msg.request ?? {};
    if (req.subtype !== 'can_use_tool') {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported: ${req.subtype}` } });
      return;
    }
    const kind = req.tool_name === 'AskUserQuestion' ? 'question' : req.tool_name === 'ExitPlanMode' ? 'plan' : 'tool';
    const role = this.translator.roleOf(req.tool_use_id) ?? inferRole(req.tool_name, req.input ?? {});
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
    this.hub.office(this.id, { kind: 'ask', role, label });
  }

  respond(requestId, req, role, decision) {
    let response;
    if (decision.allow) {
      response = { behavior: 'allow', updatedInput: decision.answers ? { ...req.input, answers: decision.answers } : req.input };
      if (decision.always && req.permission_suggestions?.length) response.updatedPermissions = req.permission_suggestions;
      if (decision.allowAll) this.autoApprove = true;
    } else {
      response = { behavior: 'deny', message: decision.message || 'Ditolak oleh user dari web Claude Coworking.' };
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.hub.office(this.id, { kind: 'ask_done', role, allowed: Boolean(decision.allow) });
  }

  updateStatus() {
    this.hub.setStatus(this.id, { alive: Boolean(this.child), busy: this.busy, queue: this.queue.length, autoApprove: this.autoApprove });
  }
}
