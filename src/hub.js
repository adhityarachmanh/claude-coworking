// Central state: project registry, per-project chat/events/status, approvals, SSE broadcast, persistence.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CHAT_LIMIT, ChatStore, isChatId } from './chat-store.js';
import { describeTool } from './roles.js';
import { basename, normalizePath, projectId } from './util.js';

const EVENT_LIMIT = 80;
// Biggest message taken from a backup (tool output is clipped long before this).
const MAX_IMPORTED_MESSAGE = 512 * 1024;

// ---------- where chat history lives ----------
// state.json used to hold every chat, so each new message or streamed update rewrote the whole file (~250 KB
// and growing). Chats now live in data/chats/<projectId>.jsonl (src/chat-store.js); state.json keeps the rest.
// - Writes stay debounced (scheduleSave, 800 ms). A flush appends one line per new message and one
//   {"_patch":id,…} line per message changed since (merged: a streamed reply is one line per flush, not per
//   delta); only projects that changed are touched. Patches rather than a debounced full rewrite: an append
//   is cheap and leaves the old bytes alone, so a crash can only tear the last line, which is skipped on load.
// - Compaction: when a file passes 2 × CHAT_LIMIT records it is rewritten (tmp + rename) with the current
//   chat; also at start when it has a broken line (so appends never follow a torn one) or after an import.
// - Load: every file is replayed at start (bounded by compaction, so small) and its last CHAT_LIMIT messages
//   kept; ids continue after the highest stored one (and after `chatSeq` in state.json, so a file that could
//   not be read at start never gets its ids handed out again); old shell rows are relabelled. A file that
//   can't be read (EBUSY/EPERM) is never rewritten, only appended to, and read again at each save.
// - Migration (first start after the change), idempotent and crash-safe by its order: a copy of state.json
//   (state.json.bak-chats-<time>, kept at least 7 days) → each project's JSONL written and read back to verify
//   → only then state.json rewritten without `chats`. A crash before the last step leaves `chats` in
//   state.json and the next start does it again.
//   Merging (mergeLegacyChat): app versions before ids continued across restarts stored the same id twice in
//   one project, and an older app run after the move starts its ids again; so one message is the same original
//   id + time + kind, never the id alone. The stored order is kept, never re-sorted: rows of a resumed
//   session (history: true) carry their transcript's older time after a "Melanjutkan sesi" divider with the
//   current one. Messages only in the file are interleaved by time (interleaveByTime); the newest
//   CHAT_LIMIT kept, and a repeated id gets a new one (the old id kept as `origId`, which is what makes
//   running the migration again recognise it).
//   When writing fails, the app stays on the old format for this run: chats are shown, kept in state.json
//   (not in data/chats) and the move is tried again at the next start.
export const DEMO_ID = 'demo';
export const DEFAULT_SETTINGS = { mode: 'manual', model: '', effort: '', team: true, engine: 'claude' };
// Which coding agent runs the project: Claude Code (stream-json) or OpenCode (ACP, src/acp-session.js).
export const ENGINES = ['claude', 'opencode'];
// What each engine keeps for itself in state.json (the inactive engine's set waits in persisted.workspaces).
const WORKSPACE_KEYS = ['settings', 'sessions', 'turns', 'interrupted'];
// OpenCode models are "provider/model" (optionally #variant), as `opencode models` lists them.
const OPENCODE_MODEL = /^[\w.-]+\/[\w.:@#/-]{1,120}$/;
// '' = Claude Code's own default; the rest map to `--effort`.
export const EFFORT_LEVELS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
// Claude Code's permission modes ('manual' is the app's name for its 'default'); bypassPermissions is left out on purpose.
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk'];
// '' = default; otherwise what `--model` / /model take: an alias (fable, opus[1m], opusplan…), a full
// claude-… id, or a model Claude Code itself listed. Anything else never reaches the command line.
const MODEL_ALIAS = /^(?:best|opusplan|(?:opus|sonnet|haiku|fable)(?:\[1m\])?)$/;
const MODEL_ID = /^claude-[\w.:[\]-]{1,76}$/;
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/** Highest counter behind the stored chat ids (`m<seq>`), so a restarted server never hands one out again. */
/**
 * Shell rows stored before the human labels existed ("$ cat > /tmp/x <<EOF …") get today's label from their
 * own stored input (the command and Claude's description), so old history reads like new rows.
 */
export function relabelShellRows(chats) {
  let changed = 0;
  for (const list of Object.values(isObject(chats) ? chats : {})) {
    for (const m of Array.isArray(list) ? list : []) {
      if (m?.kind !== 'tool' || (m.tool !== 'Bash' && m.tool !== 'PowerShell') || typeof m.input?.command !== 'string') continue;
      const label = describeTool(m.tool, m.input);
      if (label !== m.text) {
        m.text = label;
        changed++;
      }
    }
  }
  return changed;
}

function maxStoredSeq(chats) {
  let max = 0;
  for (const list of Object.values(isObject(chats) ? chats : {})) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      const n = Number(/^m(\d+)$/.exec(m?.id ?? '')?.[1]);
      if (n > max) max = n;
    }
  }
  return max;
}
/** One message, whatever id it carries now: its original id + time + kind (ids alone repeat, see the notes). */
const messageKey = (m) => `${m.origId ?? m.id}|${m.ts}|${m.kind}`;
const tsOf = (m) => (Number.isFinite(m.ts) ? m.ts : 0);

/**
 * Two chats joined without re-sorting either: each keeps its own order (a resumed session's history rows
 * keep their place after their divider, older times and all); at each step the next row of `extra` goes
 * first only when it is older than the next row of `base` (ties: base first).
 */
export function interleaveByTime(base, extra) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < base.length && j < extra.length) out.push(tsOf(extra[j]) < tsOf(base[i]) ? extra[j++] : base[i++]);
  return out.concat(base.slice(i), extra.slice(j));
}

/**
 * The chat of one project from state.json (`legacy`) joined with its file (`fromFile`: an earlier, cut-short
 * migration, or this app before an older one ran). The file's copy of a message wins (it may carry later
 * updates, and takes the stored message's place). The stored order is the base; messages only in the file are
 * interleaved by time. Newest `limit` kept, repeated ids given new ones from `nextId()`.
 * @returns {{ merged: object[], unique: number }}  unique: distinct messages before the limit
 */
export function mergeLegacyChat(fromFile, legacy, limit, nextId) {
  const byKey = new Map();
  for (const m of legacy) if (isObject(m) && typeof m.id === 'string' && !byKey.has(messageKey(m))) byKey.set(messageKey(m), m);
  const onlyInFile = [];
  for (const m of fromFile) {
    if (!isObject(m) || typeof m.id !== 'string') continue;
    if (byKey.has(messageKey(m))) byKey.set(messageKey(m), m); // keeps its place
    else onlyInFile.push(m);
  }
  const seen = new Set();
  const extra = onlyInFile.filter((m) => !seen.has(messageKey(m)) && seen.add(messageKey(m)));
  const all = interleaveByTime([...byKey.values()], extra);
  const merged = all.slice(-limit);
  const used = new Set();
  for (let i = 0; i < merged.length; i++) {
    if (used.has(merged[i].id)) merged[i] = { ...merged[i], origId: merged[i].origId ?? merged[i].id, id: nextId() };
    used.add(merged[i].id);
  }
  return { merged, unique: all.length };
}

const BAK_PREFIX = 'state.json.bak-chats';
const BAK_KEEP_MS = 7 * 86_400_000;

/** A message from a backup that still looks like one, made inert (or null). */
function cleanImportedMessage(m) {
  if (!isObject(m) || typeof m.id !== 'string' || m.id.length > 40 || typeof m.kind !== 'string' || !Number.isFinite(m.ts) || m.ts > Date.now()) return null;
  if (JSON.stringify(m).length > MAX_IMPORTED_MESSAGE) return null;
  const { streaming: _streaming, ...rest } = m;
  if (rest.status === 'pending') rest.status = 'cancelled';
  else if (rest.status === 'running') rest.status = 'cancel';
  if (typeof rest.origId !== 'string') delete rest.origId;
  // Links into sessions/tasks of the other machine (rewind by uuid, task detail) mean nothing here.
  delete rest.uuid;
  delete rest.sessionId;
  delete rest.taskId;
  rest.imported = true;
  return rest;
}

/** What the browser gets of a cut-short turn (status `interrupted`): enough for the notice and the "Lanjutkan" button. */
const publicTurn = (t) => (t ? { reason: t.reason, at: t.at, startedAt: t.startedAt, sessionId: t.sessionId, prompt: t.prompt ? t.prompt.slice(0, 300) : null, attachments: t.attachments || 0 } : null);

export class Hub {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'state.json');
    this.dataDir = dataDir;
    this.projects = new Map();
    this.runtime = new Map();
    this.approvals = new Map(); // id -> { approval, onResolve }
    this.clients = new Set();
    this.observers = new Set(); // server-side listeners to every broadcast, fn(type, data) (📋 Antrian, src/queue.js)
    // Per-client redaction: event type -> fn(data), what a redacted client (a plain-HTTP WiFi phone: sniffable) gets
    // instead of `data`. Streams in `redacted` get that view; everyone else gets `data` unchanged.
    this.redactors = new Map();
    this.redacted = new WeakSet();
    this.chatStore = null; // the active engine's chats (chatDir), set in load()
    this.storedChats = {}; // project id -> chat read at start (the same array becomes rt(id).chat)
    this.legacyChats = null; // migration failed: the raw `chats` of state.json, written back (old format) this run
    this.migrationSeq = 0; // highest id handed out by the migration (repeated ids renumbered)
    this.persisted = this.load();
    this.closeStaleReplies();
    // Ids continue after the stored chats: browsers find a bubble by id, so an id reused after a restart
    // would send a new reply's live updates to an old bubble (the new one stays empty until a reload).
    // chatSeq: the counter at the last save, for chat files that could not be read now.
    this.seq = Math.max(maxStoredSeq(this.storedChats), this.migrationSeq, Number.isSafeInteger(this.persisted.chatSeq) ? this.persisted.chatSeq : 0);
    this.projects.set(DEMO_ID, { id: DEMO_ID, name: 'Demo kantor', path: null, sources: ['demo'], virtual: true });
  }

  load() {
    // turns: the turn running right now per project (written when it starts, removed when it ends); one left
    // over at start means the server died mid-turn. interrupted: turns cut short by a server stop, kept until
    // the user continues or dismisses them (see recoverTurns / interruptTurn).
    const empty = { roots: [], custom: [], favorites: [], settings: {}, sessions: {}, activity: {}, turns: {}, interrupted: {}, engine: 'claude', workspaces: {} };
    let stored = {};
    let parsedOk = false;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (isObject(parsed)) {
        stored = parsed;
        parsedOk = true;
      }
    } catch {
      // none yet, or unreadable: starts empty (as before)
    }
    const { chats: legacy, ...rest } = stored;
    rest.engine = ENGINES.includes(rest.engine) ? rest.engine : 'claude';
    this.openChats(rest.engine);
    if (legacy !== undefined) this.migrateChats(legacy, rest);
    else if (parsedOk) this.pruneChatBackups();
    return { ...empty, ...rest };
  }

  /** The chat files of one engine's workspace: Claude Code keeps data/chats (as before), others their own folder. */
  chatDir(engine) {
    return path.join(this.dataDir, engine === 'claude' ? 'chats' : `chats-${engine}`);
  }

  /** Points the chat store at `engine`'s folder and reads its chats (storedChats). */
  openChats(engine) {
    this.chatStore = new ChatStore(this.chatDir(engine), { limit: CHAT_LIMIT });
    this.storedChats = {};
    for (const id of this.chatStore.list()) {
      if (id === DEMO_ID) continue;
      const list = this.chatStore.load(id);
      if (list.length) this.storedChats[id] = list;
    }
  }

  /**
   * A reply still "typing" when the server died (forced kill: its last update never saved) can't finish
   * any more: it is closed, or it would show as typing forever (an empty one is then hidden by the page).
   */
  closeStaleReplies() {
    for (const [id, list] of Object.entries(this.storedChats)) {
      let closed = 0;
      for (const m of list) {
        if (!m?.streaming) continue;
        m.streaming = false;
        closed++;
      }
      if (relabelShellRows({ [id]: list }) + closed) this.chatStore.rewrite(id);
    }
  }

  /** The engine every project runs on now (Akun): each engine is its own workspace (switchEngine). */
  get engine() {
    return this.persisted.engine;
  }

  /**
   * Switches the app to another engine's workspace. Each engine keeps its own chats (data/chats vs
   * data/chats-<engine>), conversation ids, per-project settings (models differ) and cut-short turns: switching
   * back shows the other engine's history exactly as it was left. Shared: projects, favourites, activity, team.
   * The caller (SessionManager.switchEngine) makes sure no turn is running and the processes are closed.
   */
  switchEngine(engine) {
    if (!ENGINES.includes(engine) || engine === this.persisted.engine) return false;
    // Chats still in state.json (a migration that failed): they belong to Claude Code, nothing may mix with them.
    if (this.legacyChats) throw Object.assign(new Error('Riwayat chat lama belum selesai dipindahkan (lihat log server). Restart aplikasi dulu, lalu coba lagi.'), { status: 409 });
    this.save(); // the current chats and state on disk before the store moves
    // A chat file that could not be written (locked by an antivirus…): its messages only live in this store.
    if (this.chatStore.dirty) throw Object.assign(new Error('Riwayat chat belum tersimpan ke disk (file sedang dikunci?). Coba lagi sebentar.'), { status: 409 });
    const from = this.persisted.engine;
    const workspaces = isObject(this.persisted.workspaces) ? this.persisted.workspaces : {};
    const parked = {};
    for (const key of WORKSPACE_KEYS) parked[key] = this.persisted[key] ?? {};
    const next = isObject(workspaces[engine]) ? workspaces[engine] : {};
    for (const key of WORKSPACE_KEYS) this.persisted[key] = isObject(next[key]) ? next[key] : {};
    this.persisted.workspaces = { ...workspaces, [from]: parked };
    delete this.persisted.workspaces[engine];
    this.persisted.engine = engine;
    this.openChats(engine);
    this.closeStaleReplies();
    this.seq = Math.max(this.seq, maxStoredSeq(this.storedChats)); // ids stay unique across both workspaces
    for (const [id, rt] of this.runtime) {
      rt.chat = this.storedChats[id] ?? [];
      rt.events = [];
      Object.assign(rt.status, { activeModel: null, sessionId: this.sessionIdFor(id), interrupted: publicTurn(this.persisted.interrupted[id]), ...this.settingsFor(id) });
    }
    this.save();
    this.broadcast('engine', { engine });
    return true;
  }

  /** Safety copies of state.json from the chat migration: removed once older than 7 days (moved for good by then). */
  pruneChatBackups(now = Date.now()) {
    let names = [];
    try {
      names = readdirSync(this.dataDir).filter((n) => n.startsWith(BAK_PREFIX));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const file = path.join(this.dataDir, name);
        if (now - statSync(file).mtimeMs > BAK_KEEP_MS) rmSync(file, { force: true });
      } catch {
        // in use or gone: next start
      }
    }
  }

  /** Moves the chats of an older state.json into data/chats (order and safety: see the notes at the top). */
  migrateChats(legacy, rest) {
    // 1. In memory, nothing on disk yet: what the chats become (shown this run whether or not the write works).
    let seq = Math.max(maxStoredSeq(this.storedChats), maxStoredSeq(legacy));
    const plan = [];
    for (const [id, list] of Object.entries(isObject(legacy) ? legacy : {})) {
      if (id === DEMO_ID || !isChatId(id) || !Array.isArray(list)) continue;
      const { merged, unique } = mergeLegacyChat(this.storedChats[id] ?? [], list, CHAT_LIMIT, () => `m${++seq}`);
      if (!merged.length) continue;
      this.storedChats[id] = merged;
      plan.push({ id, merged, unique });
    }
    this.migrationSeq = seq;
    // 2. Safety copy, files written and verified, then state.json without chats.
    try {
      copyFileSync(this.file, path.join(this.dataDir, `${BAK_PREFIX}-${Date.now()}`));
      for (const { id, merged, unique } of plan) {
        if (merged.length !== Math.min(unique, CHAT_LIMIT) || new Set(merged.map((m) => m.id)).size !== merged.length) throw new Error(`chat ${id}: jumlah/id pesan tidak cocok`);
        this.chatStore.writeAll(id, merged); // refuses a file that could not be read (it would be overwritten)
        if (JSON.stringify(this.chatStore.read(id).messages) !== JSON.stringify(merged)) throw new Error(`chat ${id} tidak sama setelah ditulis`);
      }
      this.writeState(rest);
    } catch (err) {
      console.error(`Memindahkan riwayat chat ke data/chats gagal (dicoba lagi saat start berikutnya; state.json tetap menyimpannya): ${err.message}`);
      this.legacyChats = isObject(legacy) ? legacy : {};
    }
  }

  /** state.json, atomically (tmp + rename). */
  writeState(state) {
    mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.file);
  }

  /** A project's chat in memory now (its runtime, else what was read at start). */
  chatOf(id) {
    return this.runtime.get(id)?.chat ?? this.storedChats[id] ?? [];
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 800);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.persisted.chatSeq = this.seq;
    if (this.legacyChats) {
      // The migration failed this run: chats stay in state.json as before (raw entries it could not use kept).
      this.chatStore.discardPending();
      const chats = { ...this.legacyChats };
      for (const id of new Set([...Object.keys(this.storedChats), ...this.runtime.keys()])) {
        const list = this.chatOf(id);
        if (id !== DEMO_ID && list.length) chats[id] = list.slice(-CHAT_LIMIT);
      }
      this.writeState({ ...this.persisted, chats });
      return;
    }
    try {
      this.chatStore.flush((id) => this.chatOf(id));
    } catch (err) {
      // Kept pending and retried with the next save; the rest of the state is still written.
      console.error(`Menyimpan riwayat chat gagal: ${err.message}`);
    }
    // A file that could not be read at start: once it can, its whole history (with what was appended since) is shown.
    for (const id of [...this.chatStore.unreadable]) {
      const list = this.chatStore.reload(id);
      if (!list) continue;
      const chat = this.runtime.get(id)?.chat ?? (this.storedChats[id] ??= []);
      chat.splice(0, chat.length, ...list);
    }
    this.writeState(this.persisted);
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
    for (const key of ['settings', 'sessions', 'activity', 'turns', 'interrupted', 'queues']) if (this.persisted[key]) delete this.persisted[key][id];
    if (this.legacyChats) delete this.legacyChats[id];
    delete this.storedChats[id];
    try {
      this.chatStore.remove(id);
    } catch (err) {
      console.error(`Menghapus riwayat chat ${id} gagal: ${err.message}`);
    }
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
    return { ...DEFAULT_SETTINGS, ...this.persisted.settings[id], engine: this.persisted.engine };
  }

  /** `base` with the valid fields of `patch` (anything unknown or malformed is ignored). */
  cleanSettings(base, patch) {
    const next = { ...base };
    if (!isObject(patch)) return next;
    if (PERMISSION_MODES.includes(patch.mode)) next.mode = patch.mode;
    // The engine is app-wide (switchEngine), not a per-project setting: a patch can't change it.
    const engine = this.persisted?.engine ?? 'claude';
    if (patch.model === '' || patch.model === 'default') next.model = '';
    else if (typeof patch.model === 'string' && (engine === 'opencode' ? OPENCODE_MODEL.test(patch.model) : this.knownModel(patch.model))) next.model = patch.model;
    if (EFFORT_LEVELS.includes(patch.effort)) next.effort = patch.effort;
    // OpenCode's primary agent (build, or a custom one from the user's opencode.json); '' = build
    if (patch.agent === '' || (typeof patch.agent === 'string' && /^[\w.-]{1,60}$/.test(patch.agent))) next.agent = patch.agent;
    if (typeof patch.team === 'boolean') next.team = patch.team;
    return next;
  }

  updateSettings(id, patch) {
    const { engine: _engine, ...next } = this.cleanSettings(this.settingsFor(id), patch);
    this.persisted.settings[id] = next;
    this.scheduleSave();
    this.setStatus(id, this.settingsFor(id));
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
    // A new conversation's id arrives after its first turn started: the running-turn marker follows it.
    const turn = this.persisted.turns[id];
    if (turn && sessionId && turn.sessionId !== sessionId) {
      turn.sessionId = sessionId;
      this.save();
    } else this.scheduleSave();
    this.setStatus(id, { sessionId: sessionId ?? null });
  }

  // ---------- turns cut short by a server stop ----------

  /**
   * A turn started (or moved on to the next prompt). Written to disk at once: if the server is then killed
   * (crash, Stop-Process -Force) this marker is what tells the next start that the turn was cut short.
   * @param {string} id project id
   * @param {{ sessionId: string|null, prompt: string|null, uuid: string|null, attachments?: number }} turn
   *   attachments: how many 📎 files the prompt carried (so "Lanjutkan" can say a resend goes without them)
   */
  beginTurn(id, { sessionId, prompt, uuid, attachments = 0 }) {
    const prev = this.persisted.turns[id];
    this.persisted.turns[id] = {
      sessionId: sessionId ?? null,
      prompt: prompt == null ? null : String(prompt).slice(0, 2000),
      uuid: uuid ?? null,
      ...(attachments > 0 && { attachments: Math.min(Number(attachments) || 0, 100) }), // 📎 a count only, never contents
      startedAt: prev?.startedAt ?? Date.now(),
    };
    this.save();
  }

  /** The turn ended (result, Esc, Claude Code exited): nothing to recover. */
  endTurn(id) {
    if (!this.persisted.turns[id]) return;
    delete this.persisted.turns[id];
    this.scheduleSave();
  }

  /**
   * This project's turn was cut short: kept (on disk at once) until the user continues or dismisses it.
   * @param {'shutdown'|'crash'|'exit'} reason  server stopped cleanly · server died (found at the next start) ·
   *   Claude Code itself exited mid-turn
   * @param {{ announced?: boolean }} options  announced: the chat already says so (no notice at the next start)
   */
  interruptTurn(id, reason = 'shutdown', { announced = false } = {}) {
    const turn = this.persisted.turns[id];
    if (!turn) return null;
    delete this.persisted.turns[id];
    const cut = { ...turn, reason, at: Date.now(), announced };
    this.persisted.interrupted[id] = cut;
    this.save();
    if (this.runtime.has(id)) this.setStatus(id, { interrupted: publicTurn(cut) });
    return cut;
  }

  interruptedFor(id) {
    return this.persisted.interrupted[id] ?? null;
  }

  /** The user continued, dismissed, or moved on (new prompt, other session): the notice goes away. */
  clearInterrupted(id) {
    if (!this.persisted.interrupted[id]) return;
    delete this.persisted.interrupted[id];
    this.scheduleSave();
    if (this.runtime.has(id)) this.setStatus(id, { interrupted: null });
  }

  /**
   * At start. A turn still marked as running was cut short without a clean shutdown (crash, forced kill).
   * Each cut-short turn gets one notice in its chat (once, not again on every restart) and shows in the
   * status (`interrupted`) until the user continues or dismisses it.
   * @returns {string[]} ids of the projects with a cut-short turn
   */
  recoverTurns() {
    for (const id of Object.keys(this.persisted.turns)) this.interruptTurn(id, 'crash');
    const ids = Object.keys(this.persisted.interrupted);
    for (const id of ids) {
      const turn = this.persisted.interrupted[id];
      this.rt(id).status.interrupted = publicTurn(turn);
      if (turn.announced) continue;
      turn.announced = true;
      const what = turn.reason === 'crash' ? 'Server berhenti mendadak (crash / dimatikan paksa)' : 'Server di-restart';
      this.chat(id, {
        kind: 'info',
        level: 'warning',
        interruptedTurn: true,
        text: `⚠ ${what} saat Claude sedang bekerja — giliran terputus. Pilih “Lanjutkan” di atas kotak pesan untuk melanjutkan di sesi yang sama.`,
      });
    }
    if (ids.length) this.save();
    return ids;
  }

  // ---------- backup ----------

  /**
   * The office state a backup carries: everything persisted except paired-device hashes and the CLI catalog
   * cache. Chats are not in it: the backup takes data/chats/*.jsonl as files (save() first, so they are current).
   */
  exportState() {
    const { remote: _remote, catalog: _catalog, turns: _turns, interrupted: _interrupted, queues: _queues, backupSchedule: _backupSchedule, backupRuns: _backupRuns, chatSeq: _chatSeq, engine: _engine, workspaces, ...rest } = this.persisted;
    // A backup holds Claude Code's history (backupChatsDir): with another engine active, Claude's parked settings.
    if (this.persisted.engine !== 'claude') {
      const claude = isObject(workspaces?.claude) ? workspaces.claude : {};
      rest.settings = isObject(claude.settings) ? claude.settings : {};
      rest.sessions = isObject(claude.sessions) ? claude.sessions : {};
    }
    return structuredClone(rest);
  }

  /** The chats a backup carries: Claude Code's (on disk complete: switchEngine flushed them before parking). */
  backupChatsDir() {
    return this.chatDir('claude');
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
   *   restored sessions are listed in "Riwayat sesi" and the user picks one to continue.
   * Chats (office/chats/*.jsonl, or `chats` inside the state.json of older backups) are merged by message:
   * one already here (same original id, time and kind) is skipped, others are added under a new id (another
   * machine's m12 is not this one's), in the backup's order, interleaved by time with the chat here (neither
   * re-sorted), the newest CHAT_LIMIT kept. Display only: nothing in
   * them runs, a pending approval/running tool comes back as cancelled.
   * @param {object} imported
   * @param {Map<string, string>} idMap
   * @param {Record<string, object[]>} [chats]  the backup's chat files, by the backup's project id
   */
  mergeProjectData(imported, idMap, chats = {}) {
    const added = { favorites: 0, settings: 0, chats: 0 };
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
    for (const source of [imported.chats, chats]) {
      for (const [id, list] of entries(source)) {
        const to = idMap.get(id);
        if (to && to !== DEMO_ID && isChatId(to) && Array.isArray(list)) added.chats += this.importChat(to, list);
      }
    }
    this.scheduleSave();
    return added;
  }

  /**
   * A backup's chats of another engine's workspace (office/chats-opencode): merged into that engine's chat files
   * while it is parked (import runs with Claude Code active), by message like importChat. @returns {number} added
   */
  importEngineChats(engine, idMap, chats) {
    if (!ENGINES.includes(engine) || engine === this.persisted.engine || !isObject(chats)) return 0;
    const store = new ChatStore(this.chatDir(engine), { limit: CHAT_LIMIT });
    let added = 0;
    for (const [from, list] of Object.entries(chats)) {
      const id = idMap.get(from);
      if (!id || id === DEMO_ID || !isChatId(id) || !Array.isArray(list)) continue;
      let chat;
      try {
        chat = store.read(id).messages;
      } catch {
        continue; // unreadable now: never overwritten
      }
      const known = new Set(chat.map(messageKey));
      const fresh = [];
      for (const raw of list.slice(-CHAT_LIMIT)) {
        const m = cleanImportedMessage(raw);
        if (!m || known.has(messageKey(m))) continue;
        known.add(messageKey(m));
        fresh.push({ ...m, origId: m.origId ?? m.id, id: `m${++this.seq}`, project: id });
      }
      if (!fresh.length) continue;
      relabelShellRows({ [id]: fresh });
      store.writeAll(id, interleaveByTime(chat, fresh).slice(-CHAT_LIMIT));
      added += fresh.length;
    }
    return added;
  }

  /** The other engines' chat folders a backup carries too (by engine). */
  backupEngineChats() {
    return Object.fromEntries(ENGINES.filter((e) => e !== 'claude').map((e) => [e, this.chatDir(e)]));
  }

  /** Adds a backup's messages to a project's chat (rules in mergeProjectData). @returns {number} added */
  importChat(id, list) {
    if (this.chatStore.unreadable.has(id)) return 0; // its file can't be read now: it would be overwritten
    const keyOf = messageKey;
    const chat = this.runtime.get(id)?.chat ?? (this.storedChats[id] ??= []);
    const known = new Set(chat.map(keyOf));
    const fresh = [];
    for (const raw of list.slice(-CHAT_LIMIT)) {
      const m = cleanImportedMessage(raw);
      if (!m || known.has(keyOf(m))) continue;
      known.add(keyOf(m));
      fresh.push({ ...m, origId: m.origId ?? m.id, id: `m${++this.seq}`, project: id });
    }
    if (!fresh.length) return 0;
    relabelShellRows({ [id]: fresh });
    const merged = interleaveByTime(chat, fresh).slice(-CHAT_LIMIT); // both keep their own order
    chat.splice(0, chat.length, ...merged); // in place: the runtime and the stored chat stay one array
    this.chatStore.rewrite(id);
    return fresh.length;
  }

  // ---------- runtime state ----------

  rt(id) {
    let rt = this.runtime.get(id);
    if (!rt) {
      rt = {
        events: [],
        chat: this.storedChats[id] ?? [],
        status: { project: id, alive: false, busy: false, cliBusy: false, queue: 0, pending: 0, activeModel: null, activeRoles: [], working: {}, cliWorking: {}, sessionId: this.sessionIdFor(id), interrupted: publicTurn(this.persisted.interrupted[id]), ...this.settingsFor(id) },
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
    if (id !== DEMO_ID) this.chatStore.append(id, message);
    this.touch(id);
    this.broadcast('chat', message);
    this.scheduleSave();
    return message.id;
  }

  updateChat(id, chatId, patch) {
    const message = this.rt(id).chat.findLast((m) => m.id === chatId);
    if (!message) return;
    Object.assign(message, patch);
    if (id !== DEMO_ID) this.chatStore.patch(id, chatId, patch);
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
    // Answered from a phone's notification (src/push.js): the laptop shows "dijawab dari HP" (redacted on WiFi).
    if (decision.answeredBy) approval.answeredBy = decision.answeredBy;
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

  /** `data` as one client may see it: the redactor of `type` for a redacted client, else `data` itself. */
  viewFor(type, data, redacted) {
    const redact = redacted ? this.redactors.get(type) : null;
    return redact ? redact(data) : data;
  }

  broadcast(type, data) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const redact = this.redactors.get(type);
    let reduced = null; // built once per broadcast, only if a redacted client is listening
    for (const res of this.clients) {
      if (redact && this.redacted.has(res)) res.write((reduced ??= `event: ${type}\ndata: ${JSON.stringify(redact(data))}\n\n`));
      else res.write(frame);
    }
    for (const fn of this.observers) fn(type, data); // server-side: always the full data
  }

  snapshot() {
    for (const id of Object.keys(this.storedChats)) if (this.projects.has(id)) this.rt(id);
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
