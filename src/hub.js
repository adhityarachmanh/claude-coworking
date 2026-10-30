// Central state: project registry, per-project chat/events/status, approvals, SSE broadcast, persistence.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { basename, normalizePath, projectId } from './util.js';

const EVENT_LIMIT = 80;
const CHAT_LIMIT = 250;
export const DEMO_ID = 'demo';
export const DEFAULT_SETTINGS = { mode: 'manual', model: '', team: true };

export class Hub {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'state.json');
    this.dataDir = dataDir;
    this.projects = new Map();
    this.runtime = new Map();
    this.approvals = new Map(); // id -> { approval, onResolve }
    this.clients = new Set();
    this.seq = 0;
    this.persisted = this.load();
    this.projects.set(DEMO_ID, { id: DEMO_ID, name: 'Demo kantor', path: null, sources: ['demo'], virtual: true });
  }

  load() {
    const empty = { roots: [], custom: [], settings: {}, sessions: {}, chats: {}, activity: {} };
    try {
      return { ...empty, ...JSON.parse(readFileSync(this.file, 'utf8')) };
    } catch {
      return empty;
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 800);
  }

  save() {
    clearTimeout(this.saveTimer);
    const chats = {};
    for (const [id, rt] of this.runtime) if (id !== DEMO_ID && rt.chat.length) chats[id] = rt.chat.slice(-CHAT_LIMIT);
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...this.persisted, chats }));
    renameSync(tmp, this.file);
  }

  // ---------- projects ----------

  upsertProject(dir, source) {
    const id = projectId(dir);
    let project = this.projects.get(id);
    let changed = false;
    if (!project) {
      const normalized = normalizePath(dir);
      project = { id, name: basename(normalized), path: normalized, sources: [] };
      this.projects.set(id, project);
      changed = true;
    }
    if (!project.sources.includes(source)) {
      project.sources.push(source);
      changed = true;
    }
    if (changed && this.ready) this.broadcast('projects', this.listProjects());
    return project;
  }

  addCustomProject(dir) {
    const project = this.upsertProject(dir, 'custom');
    if (!this.persisted.custom.includes(project.path)) {
      this.persisted.custom.push(project.path);
      this.scheduleSave();
    }
    this.broadcast('projects', this.listProjects());
    return project;
  }

  /** Removes a manually added folder and its stored chat/settings. Discovered folders stay listed. */
  forgetProject(id) {
    const project = this.projects.get(id);
    if (!project?.sources.includes('custom')) return false;
    this.persisted.custom = this.persisted.custom.filter((p) => projectId(p) !== id);
    for (const key of ['settings', 'sessions', 'chats', 'activity']) delete this.persisted[key][id];
    this.runtime.delete(id);
    project.sources = project.sources.filter((s) => s !== 'custom');
    if (!project.sources.length) this.projects.delete(id);
    this.save();
    this.broadcast('projects', this.listProjects());
    return true;
  }

  listProjects() {
    return [...this.projects.values()].map((p) => ({ ...p, lastActivity: this.persisted.activity[p.id] ?? 0 }));
  }

  settingsFor(id) {
    return { ...DEFAULT_SETTINGS, ...this.persisted.settings[id] };
  }

  updateSettings(id, patch) {
    const next = { ...this.settingsFor(id) };
    if (['manual', 'acceptEdits', 'auto', 'plan'].includes(patch.mode)) next.mode = patch.mode;
    if (['', 'opus', 'sonnet', 'haiku'].includes(patch.model)) next.model = patch.model;
    if (typeof patch.team === 'boolean') next.team = patch.team;
    this.persisted.settings[id] = next;
    this.scheduleSave();
    this.setStatus(id, next);
  }

  /** Slash commands reported by Claude Code (skills, custom commands, plugins) for autocomplete. */
  setSlashCommands(list) {
    const next = [...new Set(list.map(String))].sort();
    if (JSON.stringify(next) === JSON.stringify(this.persisted.slashCommands)) return;
    this.persisted.slashCommands = next;
    this.scheduleSave();
    this.config = { ...this.config, slashCommands: [...new Set([...(this.config?.slashCommands ?? []), ...next])].sort() };
    this.broadcast('config', this.config);
  }

  sessionIdFor(id) {
    return this.persisted.sessions[id] ?? null;
  }

  setSessionId(id, sessionId) {
    if (sessionId) this.persisted.sessions[id] = sessionId;
    else delete this.persisted.sessions[id];
    this.scheduleSave();
    this.setStatus(id, { sessionId: sessionId ?? null });
  }

  // ---------- runtime state ----------

  rt(id) {
    let rt = this.runtime.get(id);
    if (!rt) {
      rt = {
        events: [],
        chat: this.persisted.chats[id] ?? [],
        status: { project: id, alive: false, busy: false, cliBusy: false, queue: 0, pending: 0, activeModel: null, activeRoles: [], sessionId: this.sessionIdFor(id), ...this.settingsFor(id) },
      };
      this.runtime.set(id, rt);
    }
    return rt;
  }

  touch(id) {
    this.persisted.activity[id] = Date.now();
  }

  office(id, evt) {
    const rt = this.rt(id);
    const event = { id: ++this.seq, ts: Date.now(), project: id, ...evt };
    rt.events.push(event);
    if (rt.events.length > EVENT_LIMIT) rt.events.shift();
    this.touch(id);
    this.broadcast('office', event);
  }

  chat(id, msg) {
    const rt = this.rt(id);
    const message = { id: `m${++this.seq}`, ts: Date.now(), project: id, ...msg };
    rt.chat.push(message);
    if (rt.chat.length > CHAT_LIMIT) rt.chat.shift();
    this.touch(id);
    this.broadcast('chat', message);
    this.scheduleSave();
    return message.id;
  }

  updateChat(id, chatId, patch) {
    const message = this.rt(id).chat.findLast((m) => m.id === chatId);
    if (!message) return;
    Object.assign(message, patch);
    this.broadcast('chat_update', { project: id, id: chatId, patch });
    this.scheduleSave();
  }

  setStatus(id, patch) {
    const status = this.rt(id).status;
    Object.assign(status, patch);
    this.broadcast('status', status);
  }

  // ---------- approvals ----------

  requestApproval(projectId, data, onResolve) {
    const approval = { status: 'pending', ts: Date.now(), project: projectId, ...data };
    this.approvals.set(approval.id, { approval, onResolve });
    this.broadcast('approval', approval);
    this.refreshPending(projectId);
    return approval;
  }

  resolveApproval(id, decision) {
    const entry = this.approvals.get(id);
    if (!entry || entry.approval.status !== 'pending') return false;
    const { approval } = entry;
    approval.status = decision.cancelled ? 'cancelled' : decision.allow ? 'allowed' : 'denied';
    this.approvals.delete(id);
    if (approval.chatId) this.updateChat(approval.project, approval.chatId, { status: approval.status });
    this.broadcast('approval', approval);
    this.refreshPending(approval.project);
    entry.onResolve(decision);
    return true;
  }

  cancelApprovals(projectId) {
    for (const { approval } of [...this.approvals.values()]) {
      if (approval.project === projectId) this.resolveApproval(approval.id, { allow: false, cancelled: true });
    }
  }

  refreshPending(projectId) {
    const pending = [...this.approvals.values()].filter((a) => a.approval.project === projectId).length;
    this.setStatus(projectId, { pending });
  }

  // ---------- SSE ----------

  broadcast(type, data) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  snapshot() {
    for (const id of Object.keys(this.persisted.chats)) if (this.projects.has(id)) this.rt(id);
    const statuses = {};
    const chats = {};
    const events = {};
    for (const [id, rt] of this.runtime) {
      statuses[id] = rt.status;
      if (rt.chat.length) chats[id] = rt.chat.slice(-150);
      if (rt.events.length) events[id] = rt.events.slice(-40);
    }
    return {
      config: this.config,
      projects: this.listProjects(),
      statuses,
      chats,
      events,
      approvals: [...this.approvals.values()].map((a) => a.approval),
    };
  }
}
