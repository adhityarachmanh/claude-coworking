// Central state: project registry, per-project chat/events/status, approvals, SSE broadcast, persistence.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { basename, normalizePath, projectId } from './util.js';

const EVENT_LIMIT = 80;
const CHAT_LIMIT = 250;
export const DEMO_ID = 'demo';
export const DEFAULT_SETTINGS = { mode: 'manual', model: '', effort: '', team: true };
// '' = Claude Code's own default; the rest map to `--effort`.
export const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
// Claude Code's permission modes ('manual' is the app's name for its 'default'); bypassPermissions is left out on purpose.
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk'];
// '' = default; otherwise what `--model` / /model take: an alias (fable, opus[1m], opusplan…), a full
// claude-… id, or a model Claude Code itself listed. Anything else never reaches the command line.
const MODEL_ALIAS = /^(?:best|opusplan|(?:opus|sonnet|haiku|fable)(?:\[1m\])?)$/;
const MODEL_ID = /^claude-[\w.:[\]-]{1,76}$/;
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

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
    const empty = { roots: [], custom: [], favorites: [], settings: {}, sessions: {}, chats: {}, activity: {} };
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
    this.persisted.favorites = this.persisted.favorites.filter((f) => f !== id);
    for (const key of ['settings', 'sessions', 'chats', 'activity']) delete this.persisted[key][id];
    this.runtime.delete(id);
    project.sources = project.sources.filter((s) => s !== 'custom');
    if (!project.sources.length) this.projects.delete(id);
    this.save();
    this.broadcast('projects', this.listProjects());
    return true;
  }

  listProjects() {
    return [...this.projects.values()].map((p) => ({ ...p, lastActivity: this.persisted.activity[p.id] ?? 0, favorite: this.persisted.favorites.includes(p.id) }));
  }

  /** Starred projects stay on top of the picker on every device (stored server-side). */
  setFavorite(id, on) {
    const rest = this.persisted.favorites.filter((f) => f !== id);
    this.persisted.favorites = on ? [...rest, id] : rest;
    this.scheduleSave();
    this.broadcast('projects', this.listProjects());
  }

  settingsFor(id) {
    return { ...DEFAULT_SETTINGS, ...this.persisted.settings[id] };
  }

  /** `base` with the valid fields of `patch` (anything unknown or malformed is ignored). */
  cleanSettings(base, patch) {
    const next = { ...base };
    if (!isObject(patch)) return next;
    if (PERMISSION_MODES.includes(patch.mode)) next.mode = patch.mode;
    if (patch.model === '' || patch.model === 'default') next.model = '';
    else if (typeof patch.model === 'string' && this.knownModel(patch.model)) next.model = patch.model;
    if (EFFORT_LEVELS.includes(patch.effort)) next.effort = patch.effort;
    if (typeof patch.team === 'boolean') next.team = patch.team;
    return next;
  }

  updateSettings(id, patch) {
    const next = this.cleanSettings(this.settingsFor(id), patch);
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

  /**
   * What Claude Code itself offers (its `initialize` answer): the /model picker's models and the
   * slash commands with their descriptions. `replace` drops commands that no longer exist (the
   * startup probe); a project's session only adds its own commands.
   */
  setCatalog({ models, commands, version }, { replace = false } = {}) {
    const prev = this.persisted.catalog ?? {};
    const byName = new Map(replace ? [] : (prev.commands ?? []).map((c) => [c.name, c]));
    for (const c of commands ?? []) byName.set(c.name, c);
    const next = {
      models: models?.length ? models : (prev.models ?? []),
      commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      version: version ?? prev.version ?? null,
    };
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    this.persisted.catalog = next;
    this.scheduleSave();
    this.config = { ...this.config, ...this.catalogConfig() };
    this.broadcast('config', this.config);
  }

  knownModel(model) {
    return MODEL_ALIAS.test(model) || MODEL_ID.test(model) || (this.persisted.catalog?.models ?? []).some((m) => m.value === model);
  }

  catalogConfig() {
    const c = this.persisted.catalog ?? {};
    return { models: c.models ?? [], commands: c.commands ?? [], cliVersion: c.version ?? null };
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

  // ---------- backup ----------

  /** The office state a backup carries: everything persisted except paired-device hashes and the CLI catalog cache. */
  exportState() {
    const { remote: _remote, catalog: _catalog, ...rest } = this.persisted;
    const chats = {};
    for (const [id, rt] of this.runtime) if (id !== DEMO_ID && rt.chat.length) chats[id] = rt.chat.slice(-CHAT_LIMIT);
    return structuredClone({ ...rest, chats: { ...this.persisted.chats, ...chats } });
  }

  /**
   * Restoring a backup, step 1: project roots and manually added folders, moved to this home folder.
   * A backup may come from anyone, so a folder is only taken when `accept` allows it (the server: strictly
   * below this home, existing, not UNC); the others are returned in `skipped`. Adds only; nothing is removed.
   * @param {object} imported  office/state.json of the backup (untrusted)
   * @param {{ mapPath: (p: string) => string, roots: string[], accept: (p: string) => boolean }} options
   *   roots: the roots in effect now (the default root too, so adding one doesn't drop it)
   * @returns {{ roots: number, custom: number, skipped: string[] }}
   */
  mergeFolders(imported, { mapPath, roots, accept }) {
    const result = { roots: 0, custom: 0, skipped: [] };
    const paths = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === 'string' && p.trim()) : []).slice(0, 500).map((p) => mapPath(p.trim()));
    const nextRoots = roots.map((r) => path.resolve(r));
    for (const p of paths(imported.roots)) {
      if (nextRoots.some((r) => projectId(r) === projectId(p))) continue;
      if (!accept(p)) {
        result.skipped.push(p);
        continue;
      }
      nextRoots.push(path.resolve(p));
      result.roots++;
    }
    if (result.roots) this.persisted.roots = nextRoots;
    for (const p of paths(imported.custom)) {
      if (this.persisted.custom.some((c) => projectId(c) === projectId(p))) continue;
      if (!accept(p)) {
        result.skipped.push(p);
        continue;
      }
      this.persisted.custom.push(normalizePath(p));
      result.custom++;
    }
    if (result.roots || result.custom) this.scheduleSave();
    return result;
  }

  /**
   * Restoring a backup, step 2: per-project data, keyed by project id. `idMap` maps the backup's ids to
   * projects of this machine (ids hash the path, so a new home means new ids); unknown ids are dropped.
   * Only fills gaps: favorites are added, settings only where this machine has none, activity keeps the
   * latest time. Never restored, because a backup may come from someone else:
   * - the permission mode (always the default "manual": a backup must not switch a project to auto-accept);
   * - the session a project continues (a planted transcript must not be resumed with the next prompt) —
   *   restored sessions are listed in "Riwayat sesi" and the user picks one to continue;
   * - chats (a resumed session shows its history from the transcript).
   * @param {object} imported
   * @param {Map<string, string>} idMap
   */
  mergeProjectData(imported, idMap) {
    const added = { favorites: 0, settings: 0 };
    const entries = (v) => (isObject(v) ? Object.entries(v) : []);
    for (const id of Array.isArray(imported.favorites) ? imported.favorites : []) {
      const to = idMap.get(id);
      if (!to || this.persisted.favorites.includes(to)) continue;
      this.persisted.favorites.push(to);
      added.favorites++;
    }
    for (const [id, settings] of entries(imported.settings)) {
      const to = idMap.get(id);
      if (!to || this.persisted.settings[to]) continue;
      const { mode: _mode, ...safe } = isObject(settings) ? settings : {}; // model, effort, team (validated)
      this.persisted.settings[to] = this.cleanSettings(DEFAULT_SETTINGS, safe);
      if (this.runtime.has(to)) this.setStatus(to, this.persisted.settings[to]);
      added.settings++;
    }
    for (const [id, ts] of entries(imported.activity)) {
      const to = idMap.get(id);
      if (to && Number.isFinite(ts) && ts > (this.persisted.activity[to] ?? 0) && ts <= Date.now()) this.persisted.activity[to] = ts;
    }
    this.scheduleSave();
    return added;
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

  /** After a conversation rewind: the prompt and everything after it are greyed out (still readable). */
  markRewound(id, uuid, text) {
    const chat = this.rt(id).chat;
    let at = chat.findLastIndex((m) => m.kind === 'user' && m.uuid === uuid);
    if (at < 0) at = chat.findLastIndex((m) => m.kind === 'user' && m.text?.trim() === text?.trim());
    if (at < 0) return;
    for (const m of chat.slice(at)) if (!m.rewound && m.kind !== 'divider') this.updateChat(id, m.id, { rewound: true });
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
