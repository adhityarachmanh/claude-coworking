// Central state: project registry, per-project chat/events/status, approvals, SSE broadcast, persistence.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUDGET_KEYS, BUDGET_MAX_USD, cents, cleanLimits } from './budget.js';
import { CHAT_LIMIT, ChatStore, isChatId } from './chat-store.js';
import { EFFORT_LEVELS } from './effort.js';
import { MODEL_TIERS } from './model-auto.js';
import { GO_PLANS } from './opencode-go.js';
import { describeTool } from './roles.js';
import { basename, normalizePath, projectId } from './util.js';
import { isMissing } from './projects.js';

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
export const DEFAULT_SETTINGS = { mode: 'manual', model: '', modelAuto: false, effort: '', effortAuto: false, team: true, engine: 'claude', modelTiers: {} };
// Which coding agent runs the project: Claude Code (stream-json) or OpenCode (ACP, src/acp-session.js).
export const ENGINES = ['claude', 'opencode'];
// Per-project data per engine lives in `settings[id].engine`, `engineSettings[id][engine]` and
// `sessionsByEngine[id][engine]`. The old app-wide switch parked the inactive engine's set in
// `persisted.workspaces[engine]`; Stage 2 flattens that on load (migrateWorkspaces) and the field never returns.
// OpenCode models are "provider/model" (optionally #variant), as `opencode models` lists them.
const OPENCODE_MODEL = /^[\w.-]+\/[\w.:@#/-]{1,120}$/;
// A stored conversation id per engine. A value of another shape (or the other engine's kind) could resume the
// wrong conversation — or nothing at all — so migration and restore only keep these.
const SESSION_ID = { claude: /^[0-9a-f-]{36}$/i, opencode: /^ses_[\w-]{1,100}$/ };
const validSessionFor = (engine, id) => typeof id === 'string' && SESSION_ID[engine]?.test(id) === true;
// A model/agent remembered by an older state.json: bounded and without whitespace/control characters (it becomes
// an argv element). The effort is checked against the levels the app offers.
const STORED_MODEL = /^\S{1,200}$/;
const STORED_AGENT = /^[\w.-]{1,60}$/;
// '' = Default. none / minimal: offered by some OpenCode models (their own levels, from `model.list`).
// Auto is a separate boolean (`effortAuto`): a generated level must never be sent as `--effort auto`.
// Claude Code's permission modes ('manual' is the app's name for its 'default'); bypassPermissions is left out on purpose.
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk'];
// '' = default; otherwise what `--model` / /model take: an alias (fable, opus[1m], opusplan…), a full
// claude-… id, or a model Claude Code itself listed. Anything else never reaches the command line.
const MODEL_ALIAS = /^(?:best|opusplan|(?:opus|sonnet|haiku|fable)(?:\[1m\])?)$/;
const MODEL_ID = /^claude-[\w.:[\]-]{1,76}$/;
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/**
 * The {model, effort, agent} an older state.json remembered for one engine: only values the app itself could have
 * written survive (an empty value means Default / build). Used by the one-way `workspaces` migration only; a
 * backup goes through Hub.cleanSettings, which also knows the models of the running engine.
 */
function storedEngineValues(raw) {
  const s = isObject(raw) ? raw : {};
  return {
    model: typeof s.model === 'string' && STORED_MODEL.test(s.model) ? s.model : '',
    effort: EFFORT_LEVELS.includes(s.effort) ? s.effort : '',
    agent: s.agent === '' || (typeof s.agent === 'string' && STORED_AGENT.test(s.agent)) ? s.agent : '',
  };
}
/** The engine that state.json's `settings` give a project, else its app-wide default (`state.engine`). */
const stateEngineOf = (state, id) => (ENGINES.includes(state?.settings?.[id]?.engine) ? state.settings[id].engine : state?.engine ?? 'claude');
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
    this.chatStores = {}; // engine -> its own chat store (data/chats, data/chats-opencode), set in load()
    this.storedChats = {}; // "<engine>:<project id>" -> chat read at start (the same array becomes rt(id).chat)
    this.legacyChats = null; // migration failed: the raw `chats` of state.json, written back (old format) this run
    this.migrationSeq = 0; // highest id handed out by the migration (repeated ids renumbered)
    this.persisted = this.load();
    // A hand-edited or older state.json can hold anything in the budget: only a valid limit survives (else off).
    this.persisted.budget = cleanLimits(this.persisted.budget);
    // Ids continue after the stored chats: browsers find a bubble by id, so an id reused after a restart
    // would send a new reply's live updates to an old bubble (the new one stays empty until a reload).
    // chatSeq: the counter at the last save, for chat files that could not be read now.
    this.seq = Math.max(maxStoredSeq(this.storedChats), this.migrationSeq, Number.isSafeInteger(this.persisted.chatSeq) ? this.persisted.chatSeq : 0);
    // Stage 2: the old app-wide switch's parking lot is flattened here, once, before anything else reads it.
    // save() (not writeState) so a chat migration that failed this run keeps its `chats` in state.json too.
    if (this.migrateWorkspaces()) this.save();
    this.prunePreProjectBackups();
    this.closeStaleReplies();
    this.projects.set(DEMO_ID, { id: DEMO_ID, name: 'Demo kantor', path: null, sources: ['demo'], virtual: true });
  }

  load() {
    // turns: the turn running right now per project (written when it starts, removed when it ends); one left
    // over at start means the server died mid-turn. interrupted: turns cut short by a server stop, kept until
    // the user continues or dismisses them (see recoverTurns / interruptTurn).
    const empty = { roots: [], custom: [], favorites: [], settings: {}, engineSettings: {}, sessions: {}, sessionsByEngine: {}, activity: {}, turns: {}, interrupted: {}, engine: 'claude', opencodeGoPlan: 'go', budget: { dailyUsd: null, weeklyUsd: null, monthlyUsd: null } };
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
    rest.opencodeGoPlan = Object.hasOwn(GO_PLANS, rest.opencodeGoPlan) ? rest.opencodeGoPlan : 'go';
    this.openChats();
    if (legacy !== undefined) this.migrateChats(legacy, rest);
    else if (parsedOk) this.pruneChatBackups();
    return { ...empty, ...rest };
  }

  /**
   * Stage 2, one-way: the older app-wide switch parked the inactive engine's {settings, sessions, turns,
   * interrupted} under `persisted.workspaces[engine]`. It is flattened into the per-project fields and the parking
   * lot is removed, so nothing is read or written there any more. Idempotent: a second start finds no `workspaces`.
   *
   * What is kept, and from where (the newer value always wins):
   * - `engineSettings[id][engine]`: an entry already here was written later by Stage 1 (a switch or a settings
   *   change) and wins as a whole; the parked settings only fill an engine this project has no entry for yet.
   *   Empty or malformed parked values are dropped, never allowed to overwrite anything.
   * - `sessionsByEngine[id][engine]`: same rule (a stored id wins; the parked one only fills a gap) and the id must
   *   look like that engine's conversation id. The old single `sessions` map belongs to the project's current
   *   engine: it seeds (or is mirrored from) that entry when one side is missing, so a project that switched
   *   engine under Stage 1 keeps its conversation.
   * - `turns` / `interrupted` of a parked engine are NOT carried: they belong to a turn of that engine, and a
   *   switch must never resume the wrong one (Stage 1 refuses a switch while a "Lanjutkan" waits).
   * Before anything is written, state.json is copied to `state.json.pre-per-project-<time>` (best effort). With
   * no parked data there is nothing to migrate: no copy is made and the state is only normalized.
   * @returns {boolean} true when state.json changed (the caller saves once)
   */
  /**
   * Stage 2 keeps a state.json copy before the one-way migration. Those copies hold the whole old state, so only the
   * newest few are kept and older ones age out; a failed delete is harmless.
   */
  prunePreProjectBackups({ keep = 5, maxAgeDays = 30 } = {}) {
    try {
      const dir = path.dirname(this.file);
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const files = readdirSync(dir)
        .filter((name) => /^state\.json\.pre-per-project-\d+$/.test(name))
        .map((name) => {
          const file = path.join(dir, name);
          try {
            return { file, at: statSync(file).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.at - a.at);
      for (const [i, entry] of files.entries()) {
        if (i < keep && entry.at >= cutoff) continue;
        try {
          unlinkSync(entry.file);
        } catch {
          // locked by an antivirus or already gone: next start tries again
        }
      }
    } catch {
      // no data folder yet
    }
  }

  migrateWorkspaces() {
    const state = this.persisted;
    const hasKey = Object.prototype.hasOwnProperty.call(state, 'workspaces');
    const workspaces = isObject(state.workspaces) ? state.workspaces : null;
    delete state.workspaces; // after this run the field has no meaning (exportState never carries it either)
    const parked = [];
    for (const engine of ENGINES) {
      const ws = workspaces?.[engine];
      if (!isObject(ws)) continue;
      const settings = isObject(ws.settings) ? ws.settings : {};
      const sessions = isObject(ws.sessions) ? ws.sessions : {};
      if (Object.keys(settings).length || Object.keys(sessions).length) parked.push({ engine, settings, sessions });
    }
    const normalized = this.ensureProjectEngines(state);
    // Nothing parked and no old key: this start changes nothing at all (and makes no copy).
    if (!parked.length && !hasKey && !normalized) return false;
    if (parked.length) this.backupBeforePerProject();
    const engineSettings = (state.engineSettings = isObject(state.engineSettings) ? state.engineSettings : {});
    const byEngine = (state.sessionsByEngine = isObject(state.sessionsByEngine) ? state.sessionsByEngine : {});
    const sessions = (state.sessions = isObject(state.sessions) ? state.sessions : {});
    for (const { engine, settings: parkedSettings, sessions: parkedSessions } of parked) {
      for (const [id, raw] of Object.entries(parkedSettings)) {
        if (!isChatId(id)) continue;
        const per = (engineSettings[id] = isObject(engineSettings[id]) ? engineSettings[id] : {});
        if (isObject(per[engine])) continue; // written later (Stage 1): the newer value wins as a whole
        const values = storedEngineValues(raw);
        if (values.model || values.effort || values.agent) per[engine] = values;
      }
      for (const [id, sessionId] of Object.entries(parkedSessions)) {
        if (!isChatId(id) || !validSessionFor(engine, sessionId)) continue;
        const per = (byEngine[id] = isObject(byEngine[id]) ? byEngine[id] : {});
        if (!per[engine]) per[engine] = sessionId;
      }
    }
    // The legacy single `sessions` map belongs to the project's current engine: keep that conversation on both
    // sides (one may have been written by Stage 1, the other by an older app).
    for (const id of new Set([...Object.keys(byEngine), ...Object.keys(sessions)])) {
      if (!isChatId(id)) continue;
      const engine = stateEngineOf(state, id);
      const per = (byEngine[id] = isObject(byEngine[id]) ? byEngine[id] : {});
      if (!per[engine] && validSessionFor(engine, sessions[id])) per[engine] = sessions[id];
      if (!sessions[id] && per[engine]) sessions[id] = per[engine];
    }
    // Every project has its own engine from now on (the app-wide one is only the default for new projects);
    // ensureProjectEngines() did that above.
    return true;
  }

  /**
   * `settings[id].engine` for every project that has settings, defaulting to the app-wide engine. Only the
   * project's own choice is this server's; the field is what makes a project stay on its engine when the
   * default changes. @returns {boolean} whether a value was added
   */
  ensureProjectEngines(state = this.persisted) {
    let changed = false;
    const settings = (state.settings = isObject(state.settings) ? state.settings : {});
    for (const [id, raw] of Object.entries(settings)) {
      if (!isChatId(id) || ENGINES.includes(raw?.engine)) continue;
      settings[id] = { ...(isObject(raw) ? raw : {}), engine: state.engine };
      changed = true;
    }
    return changed;
  }

  /**
   * Copy of state.json before the per-project migration changes it, for a manual rollback. It is **redacted**: the
   * paired phones, their push subscriptions and the VAPID private key (`remote`) are dropped, because a backup file
   * never carries them either; project settings, chats, usage and session ids stay so a rollback is still useful.
   */
  backupBeforePerProject() {
    const copy = path.join(this.dataDir, `state.json.pre-per-project-${Date.now()}`);
    try {
      const raw = readFileSync(this.file, 'utf8');
      let output = raw;
      try {
        const state = JSON.parse(raw);
        delete state.remote;
        delete state.push;
        output = `${JSON.stringify(state, null, 2)}\n`;
      } catch {
        // unreadable JSON: keep the raw bytes rather than losing the only rollback copy
      }
      writeFileSync(copy, output);
      console.log(`state.json sebelum migrasi mesin per project disalin (tanpa data perangkat) ke ${copy}`);
    } catch (err) {
      console.error(`Gagal menyalin state.json sebelum migrasi mesin per project (migrasi tetap jalan): ${err.message}`);
    }
  }

  /** The chat files of one engine's workspace: Claude Code keeps data/chats (as before), others their own folder. */
  chatDir(engine) {
    return path.join(this.dataDir, engine === 'claude' ? 'chats' : `chats-${engine}`);
  }

  /** The key of one project's chat in one engine's workspace (both are kept side by side). */
  chatKey(engine, id) {
    return `${engine}:${id}`;
  }

  /**
   * Loads BOTH engines' workspaces at start (Stage 1: one engine per project, both histories kept). Nothing is
   * migrated or copied between them: switching a project only changes which one is shown (setProjectEngine).
   */
  openChats() {
    this.chatStores = {};
    this.storedChats = {};
    for (const engine of ENGINES) {
      const store = new ChatStore(this.chatDir(engine), { limit: CHAT_LIMIT });
      this.chatStores[engine] = store;
      for (const id of store.list()) {
        if (id === DEMO_ID) continue;
        const list = store.load(id);
        if (list.length) this.storedChats[this.chatKey(engine, id)] = list;
      }
    }
  }

  /** The default engine's store (callers that only know the app-wide/default workspace). */
  get chatStore() {
    return this.chatStores[this.persisted?.engine ?? 'claude'];
  }

  /** One engine's chat store. */
  chatStoreFor(engine) {
    return this.chatStores[engine] ?? this.chatStores.claude;
  }

  /** True while any engine's chat file still has records that were not written to disk. */
  get chatsDirty() {
    return Object.values(this.chatStores).some((store) => store?.dirty);
  }

  /**
   * A reply still "typing" when the server died (forced kill: its last update never saved) can't finish
   * any more: it is closed, or it would show as typing forever (an empty one is then hidden by the page).
   */
  closeStaleReplies() {
    for (const [key, list] of Object.entries(this.storedChats)) {
      const split = key.indexOf(':');
      const engine = key.slice(0, split);
      const id = key.slice(split + 1);
      let closed = 0;
      for (const m of list) {
        if (!m?.streaming) continue;
        m.streaming = false;
        closed++;
      }
      if (relabelShellRows({ [id]: list }) + closed) this.chatStoreFor(engine).rewrite(id);
    }
  }

  /** The app-wide DEFAULT engine (👤 Akun): projects that do not have one of their own yet start on it. */
  get engine() {
    return this.persisted.engine;
  }

  /** The engine one project runs on: its own choice, else the app-wide default. */
  engineOf(id) {
    const own = this.persisted?.settings?.[id]?.engine;
    return ENGINES.includes(own) ? own : (this.persisted?.engine ?? 'claude');
  }

  /**
   * Stage 1: changing the app-wide engine only changes the DEFAULT for new projects. Every project keeps its own
   * engine (`settings[id].engine`), its own conversations and its own chat history; nothing is closed or moved.
   */
  setDefaultEngine(engine) {
    if (!ENGINES.includes(engine) || engine === this.persisted.engine) return false;
    this.persisted.engine = engine;
    this.save();
    this.broadcast('engine', { engine });
    return true;
  }

  /** The OpenCode Go plan the user picked (OpenCode does not report it): go | plus | teams. */
  goPlan() {
    return Object.hasOwn(GO_PLANS, this.persisted.opencodeGoPlan) ? this.persisted.opencodeGoPlan : 'go';
  }

  setGoPlan(plan) {
    if (!Object.hasOwn(GO_PLANS, plan)) return false;
    this.persisted.opencodeGoPlan = plan;
    this.save();
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
      // Chats in state.json predate OpenCode: they are Claude Code's history (data/chats).
      const key = this.chatKey('claude', id);
      const { merged, unique } = mergeLegacyChat(this.storedChats[key] ?? [], list, CHAT_LIMIT, () => `m${++seq}`);
      if (!merged.length) continue;
      this.storedChats[key] = merged;
      plan.push({ id, merged, unique });
    }
    this.migrationSeq = seq;
    // 2. Safety copy, files written and verified, then state.json without chats.
    try {
      copyFileSync(this.file, path.join(this.dataDir, `${BAK_PREFIX}-${Date.now()}`));
      for (const { id, merged, unique } of plan) {
        if (merged.length !== Math.min(unique, CHAT_LIMIT) || new Set(merged.map((m) => m.id)).size !== merged.length) throw new Error(`chat ${id}: jumlah/id pesan tidak cocok`);
        this.chatStoreFor('claude').writeAll(id, merged); // refuses a file that could not be read (it would be overwritten)
        if (JSON.stringify(this.chatStoreFor('claude').read(id).messages) !== JSON.stringify(merged)) throw new Error(`chat ${id} tidak sama setelah ditulis`);
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

  /** One project's chat in `engine`'s workspace right now (its runtime, else what was read at start). */
  chatFor(engine, id) {
    const rt = this.runtime.get(id);
    if (rt && this.engineOf(id) === engine) return rt.chat;
    return (this.storedChats[this.chatKey(engine, id)] ??= []);
  }

  /** A project's chat in the workspace of the engine it runs on. */
  chatOf(id) {
    return this.chatFor(this.engineOf(id), id);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 800);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.persisted.chatSeq = this.seq;
    if (this.legacyChats) {
      // The migration failed this run: Claude's chats stay in state.json as before (raw entries kept). The other
      // engines' files are unaffected and still flushed.
      this.chatStoreFor('claude').discardPending();
      const chats = { ...this.legacyChats };
      const ids = new Set();
      for (const key of Object.keys(this.storedChats)) if (key.startsWith('claude:')) ids.add(key.slice('claude:'.length));
      for (const id of this.runtime.keys()) if (this.engineOf(id) === 'claude') ids.add(id);
      for (const id of ids) {
        const list = this.chatFor('claude', id);
        if (id !== DEMO_ID && list.length) chats[id] = list.slice(-CHAT_LIMIT);
      }
      for (const engine of ENGINES) {
        if (engine === 'claude') continue;
        try {
          this.chatStoreFor(engine).flush((id) => this.chatFor(engine, id));
        } catch (err) {
          console.error(`Menyimpan riwayat chat ${engine} gagal: ${err.message}`);
        }
      }
      this.writeState({ ...this.persisted, chats });
      return;
    }
    for (const engine of ENGINES) {
      const store = this.chatStoreFor(engine);
      try {
        store.flush((id) => this.chatFor(engine, id));
      } catch (err) {
        // Kept pending and retried with the next save; the rest of the state is still written.
        console.error(`Menyimpan riwayat chat ${engine} gagal: ${err.message}`);
      }
      // A file that could not be read at start: once it can, its whole history (with what was appended since) is shown.
      for (const id of [...store.unreadable]) {
        const list = store.reload(id);
        if (!list) continue;
        const chat = this.chatFor(engine, id);
        chat.splice(0, chat.length, ...list);
      }
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
    // A project keeps its own engine. One seen for the first time (or stored by an older app without the field)
    // starts on the app-wide default; changing the default later never moves an existing project.
    const stored = this.persisted.settings?.[project.id];
    if (!ENGINES.includes(stored?.engine)) {
      this.persisted.settings ??= {};
      this.persisted.settings[project.id] = { ...stored, engine: this.persisted.engine };
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

  /**
   * Forgets a project completely: its settings, sessions, activity, turns, queue and chat, plus its entry in the
   * list. Used for a folder the user never wanted (e.g. a temp folder an old CLI session created), so it works even
   * when the folder is gone or was never in `custom`. The usage ledger is cleaned by the caller (src/routes/projects.js).
   */
  purgeProject(id) {
    const project = this.projects.get(id);
    this.persisted.custom = (this.persisted.custom ?? []).filter((p) => projectId(p) !== id);
    this.persisted.favorites = this.persisted.favorites.filter((f) => f !== id);
    for (const key of ['settings', 'sessions', 'activity', 'turns', 'interrupted', 'queues', 'sessionsByEngine', 'engineSettings']) if (this.persisted[key]) delete this.persisted[key][id];
    if (this.legacyChats) delete this.legacyChats[id];
    // Both engines' histories are removed (switching never copied anything, so one may live in each store).
    for (const engine of ENGINES) {
      delete this.storedChats[this.chatKey(engine, id)];
      try {
        this.chatStoreFor(engine).remove(id);
      } catch (err) {
        console.error(`Menghapus riwayat chat ${engine} ${id} gagal: ${err.message}`);
      }
    }
    this.runtime.delete(id);
    this.projects.delete(id);
    this.save();
    this.broadcast('projects', this.listProjects());
    return Boolean(project) || true;
  }

  /** Removes a manually added folder and its stored chat/settings. Discovered folders stay listed. */
  forgetProject(id) {
    const project = this.projects.get(id);
    if (!project?.sources.includes('custom')) return false;
    this.persisted.custom = this.persisted.custom.filter((p) => projectId(p) !== id);
    this.persisted.favorites = this.persisted.favorites.filter((f) => f !== id);
    for (const key of ['settings', 'sessions', 'activity', 'turns', 'interrupted', 'queues', 'sessionsByEngine', 'engineSettings']) if (this.persisted[key]) delete this.persisted[key][id];
    if (this.legacyChats) delete this.legacyChats[id];
    for (const engine of ENGINES) {
      delete this.storedChats[this.chatKey(engine, id)];
      try {
        this.chatStoreFor(engine).remove(id);
      } catch (err) {
        console.error(`Menghapus riwayat chat ${engine} ${id} gagal: ${err.message}`);
      }
    }
    this.runtime.delete(id);
    project.sources = project.sources.filter((s) => s !== 'custom');
    if (!project.sources.length) this.projects.delete(id);
    this.save();
    this.broadcast('projects', this.listProjects());
    return true;
  }

  listProjects() {
    return [...this.projects.values()].map((p) => ({
      ...p,
      lastActivity: this.persisted.activity[p.id] ?? 0,
      favorite: this.persisted.favorites.includes(p.id),
      // The folder is gone (moved, deleted, a temp folder from an old CLI session): the picker may offer a safe purge.
      // Only ENOENT/ENOTDIR: an unreadable or temporarily offline folder is not an orphan.
      missing: Boolean(p.path) && isMissing(p.path),
    }));
  }

  /** Starred projects stay on top of the picker on every device (stored server-side). */
  setFavorite(id, on) {
    const rest = this.persisted.favorites.filter((f) => f !== id);
    this.persisted.favorites = on ? [...rest, id] : rest;
    this.scheduleSave();
    this.broadcast('projects', this.listProjects());
  }

  settingsFor(id) {
    const engine = this.engineOf(id);
    const settings = { ...DEFAULT_SETTINGS, ...this.persisted.settings[id], engine };
    // A hand-edited state.json could hold anything here; ladders are validated when they are written instead.
    if (!isObject(settings.modelTiers)) settings.modelTiers = {};
    return settings;
  }

  /**
   * The model/effort/agent one engine keeps for a project. Switching to that engine puts them back exactly as they
   * were; the fields themselves stay shared (`mode`, `team`, `modelTiers`), the models differ per engine.
   */
  engineSettingsFor(id, engine) {
    const saved = this.persisted.engineSettings?.[id]?.[engine];
    return {
      model: typeof saved?.model === 'string' ? saved.model : '',
      effort: typeof saved?.effort === 'string' ? saved.effort : '',
      agent: typeof saved?.agent === 'string' ? saved.agent : '',
    };
  }

  /** Remembers what an engine had for a project (called on every model/effort/agent change). */
  rememberEngineSettings(id, engine, settings) {
    if (!ENGINES.includes(engine) || !settings) return;
    const all = (this.persisted.engineSettings ??= {});
    const per = (all[id] ??= {});
    per[engine] = {
      model: typeof settings.model === 'string' ? settings.model : '',
      effort: typeof settings.effort === 'string' ? settings.effort : '',
      agent: typeof settings.agent === 'string' ? settings.agent : '',
    };
  }

  /**
   * settings.modelTiers after `patch`: one Model Auto ladder per engine, only the four tier names, each a model
   * the engine accepts. '' clears a slot (the default model returns); an invalid entry is dropped and the
   * previous value stays, so a bad model never reaches the command line. Unknown engines and keys are ignored.
   */
  cleanModelTiers(base, patch) {
    const next = isObject(base) ? { ...base } : {};
    if (!isObject(patch)) return next;
    for (const engine of ENGINES) {
      const tiers = patch[engine];
      if (!isObject(tiers)) continue;
      const ladder = { ...(isObject(next[engine]) ? next[engine] : {}) };
      let changed = false;
      for (const tier of MODEL_TIERS) {
        const raw = tiers[tier];
        if (typeof raw !== 'string') continue;
        const model = raw.trim();
        if (model.length > 200) continue; // dropped: the previous value stays
        // The same rules the model picker is held to: an alias/id Claude Code knows, or provider/model.
        if (model && !(engine === 'opencode' ? OPENCODE_MODEL.test(model) : this.knownModel(model))) continue;
        if (model) ladder[tier] = model;
        else delete ladder[tier];
        changed = true;
      }
      if (!changed) continue;
      if (Object.keys(ladder).length) next[engine] = ladder;
      else delete next[engine];
    }
    return next;
  }

  /** `base` with the valid fields of `patch` (anything unknown or malformed is ignored). */
  cleanSettings(base, patch) {
    const next = { ...base };
    if (!isObject(patch)) return next;
    if (PERMISSION_MODES.includes(patch.mode)) next.mode = patch.mode;
    // The engine is this project's own choice; a target engine decides which models/agents are valid.
    const engine = ENGINES.includes(patch.engine) ? patch.engine : (ENGINES.includes(next.engine) ? next.engine : (this.persisted?.engine ?? 'claude'));
    if (ENGINES.includes(patch.engine)) next.engine = patch.engine;
    // Picking a model by hand (or Default) is a manual choice: only an explicit modelAuto: true keeps Auto on.
    // 'auto' is never stored as a model: Model Auto keeps the concrete model in `model` and its flag in `modelAuto`.
    if (patch.model === '' || patch.model === 'default') {
      next.model = '';
      if (patch.modelAuto !== true) next.modelAuto = false;
    } else if (typeof patch.model === 'string' && patch.model !== 'auto' && (engine === 'opencode' ? OPENCODE_MODEL.test(patch.model) : this.knownModel(patch.model))) {
      next.model = patch.model;
      if (patch.modelAuto !== true) next.modelAuto = false;
    }
    if (typeof patch.modelAuto === 'boolean') next.modelAuto = patch.modelAuto;
    if (EFFORT_LEVELS.includes(patch.effort)) {
      next.effort = patch.effort;
      // Picking a level is a manual choice; only an explicit effortAuto keeps Auto on.
      if (patch.effortAuto !== true) next.effortAuto = false;
    }
    if (typeof patch.effortAuto === 'boolean') next.effortAuto = patch.effortAuto;
    // Model Auto's own ladder (🎚️): models the running engine accepts, so a saved tier is always usable.
    if (patch.modelTiers !== undefined) next.modelTiers = this.cleanModelTiers(base.modelTiers, patch.modelTiers);
    // OpenCode's primary agent (build, or a custom one from the user's opencode.json); '' = build
    if (patch.agent === '' || (typeof patch.agent === 'string' && /^[\w.-]{1,60}$/.test(patch.agent))) next.agent = patch.agent;
    if (typeof patch.team === 'boolean') next.team = patch.team;
    return next;
  }

  /**
   * The stored global usage budget with the valid fields of `patch` applied (💰 Batas pemakaian): only dailyUsd /
   * weeklyUsd / monthlyUsd, each a dollar amount 0.01…10000 rounded to cents; null, '' or 0 turns a limit off.
   * A malformed value is ignored (the stored one stays), so a hand-edited state.json can never put a limit out of
   * range; the route validates first and answers 400 (src/budget.js cleanBudgetPatch).
   */
  cleanBudget(patch) {
    const next = cleanLimits(this.persisted?.budget);
    if (!isObject(patch)) return next;
    for (const key of BUDGET_KEYS) {
      if (!(key in patch)) continue;
      const raw = patch[key];
      if (raw === null || raw === '' || raw === 0) {
        next[key] = null;
        continue;
      }
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.trim().replace(',', '.')) : NaN;
      if (!Number.isFinite(value) || value < 0 || value > BUDGET_MAX_USD) continue; // the stored value stays
      next[key] = value > 0 ? cents(value) : null;
    }
    return next;
  }

  /**
   * Saves the global usage budget and tells open pages (`budget` event; a client fetches the spending itself with
   * POST /api/budget). Written at once: a limit someone just set must survive a crash right after it.
   * @returns {{ dailyUsd: number|null, weeklyUsd: number|null, monthlyUsd: number|null }} the budget now stored
   */
  setBudget(patch) {
    this.persisted.budget = this.cleanBudget(patch);
    this.save();
    this.broadcast('budget', this.persisted.budget);
    return this.persisted.budget;
  }

  updateSettings(id, patch) {
    const before = this.settingsFor(id);
    const next = this.cleanSettings(before, patch);
    if (next.engine !== before.engine) {
      // Each engine keeps its own model/effort/agent here: park the old one and load the target's saved values.
      this.rememberEngineSettings(id, before.engine, before);
      const saved = this.engineSettingsFor(id, next.engine);
      next.model = saved.model;
      next.effort = saved.effort;
      next.agent = saved.agent;
    }
    this.rememberEngineSettings(id, next.engine, next);
    this.persisted.settings[id] = next;
    this.scheduleSave();
    this.setStatus(id, this.settingsFor(id));
  }

  /**
   * Stage 1: one project changes engine. Both histories are kept side by side and nothing is copied or migrated:
   * the runtime shows the target engine's chat as it was left, with a divider saying what happened. Refused while
   * the old migration still holds chats in state.json. The caller (SessionManager.setProjectEngine) makes sure
   * nothing is running in this project.
   */
  setProjectEngine(id, engine) {
    if (!ENGINES.includes(engine)) throw Object.assign(new Error('Mesin tidak dikenal.'), { status: 400 });
    const from = this.engineOf(id);
    if (engine === from) return false;
    if (this.legacyChats) throw Object.assign(new Error('Riwayat chat lama belum selesai dipindahkan (lihat log server). Restart aplikasi dulu, lalu coba lagi.'), { status: 409 });
    this.save(); // both stores on disk before the runtime moves to the other list
    if (this.chatsDirty) throw Object.assign(new Error('Riwayat chat belum tersimpan ke disk (file sedang dikunci?). Coba lagi sebentar.'), { status: 409 });
    const before = this.settingsFor(id);
    const shown = this.chatFor(engine, id); // the target history, exactly as it was left
    this.rememberEngineSettings(id, from, before);
    const saved = this.engineSettingsFor(id, engine);
    this.persisted.settings[id] = { ...before, engine, model: saved.model, effort: saved.effort, agent: saved.agent };
    this.rememberEngineSettings(id, engine, this.persisted.settings[id]);
    const rt = this.rt(id);
    rt.chat = shown;
    rt.events = [];
    const sessionId = this.sessionIdFor(id);
    if (sessionId) this.persisted.sessions[id] = sessionId; // compatibility mirror
    else delete this.persisted.sessions[id];
    Object.assign(rt.status, { activeModel: null, sessionId, interrupted: publicTurn(this.persisted.interrupted[id]), ...this.settingsFor(id) });
    const label = (e) => (e === 'opencode' ? 'OpenCode' : 'Claude Code');
    // A divider in the NEW history; the old one stays exactly as it was (never copied).
    this.chat(id, { kind: 'divider', text: `Mesin project diganti ke ${label(engine)}; riwayat ${label(from)} tetap tersimpan.` });
    this.save();
    this.setStatus(id, this.settingsFor(id));
    // Open pages reload into the project's other history (the same event the app-wide switch used to send).
    this.broadcast('engine', { engine, project: id });
    this.broadcast('projects', this.listProjects());
    return true;
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
    const engine = this.engineOf(id);
    const byEngine = this.persisted.sessionsByEngine?.[id];
    if (byEngine && engine in byEngine) return byEngine[engine] ?? null;
    // Older state: `sessions` was the only map, and its id belonged to the then app-wide engine.
    return engine === this.persisted.engine ? (this.persisted.sessions[id] ?? null) : null;
  }

  setSessionId(id, sessionId) {
    const engine = this.engineOf(id);
    const byEngine = (this.persisted.sessionsByEngine ??= {});
    const per = (byEngine[id] ??= {});
    if (sessionId) {
      per[engine] = sessionId;
      this.persisted.sessions[id] = sessionId; // compatibility mirror for older readers
    } else {
      delete per[engine];
      delete this.persisted.sessions[id];
    }
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
   * cache. Chats are not in it: the backup takes both engines' chat folders as files (save() first).
   * Per-project data travels with it: `settings[id].engine`, `engineSettings` (model/effort/agent per engine) and
   * `sessionsByEngine` (the conversation id per engine). `workspaces` was the old app-wide switch's parking lot,
   * flattened by the Stage 2 migration: never exported, and stripped here so an old state.json cannot bring it
   * back through a save on this machine.
   */
  exportState() {
    const { remote: _remote, catalog: _catalog, turns: _turns, interrupted: _interrupted, queues: _queues, backupSchedule: _backupSchedule, backupRuns: _backupRuns, chatSeq: _chatSeq, workspaces: _workspaces, ...rest } = this.persisted;
    return structuredClone(rest);
  }

  /** The chats a backup carries as office/chats: Claude Code's folder (always kept, whatever the projects run on). */
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
   * - the single `sessions` map (it is derived from `sessionsByEngine`, see below).
   * Per-engine data ("Mesin per project") does come along, because a backup should give a new laptop the same
   * setup: `settings[id].engine`, `engineSettings[id][engine]` (model/effort/agent) and
   * `sessionsByEngine[id][engine]` (the conversation to continue). The project's engine is taken from the backup
   * when it is a known engine and OpenCode is installed here; OpenCode is left out (engine falls back to Claude
   * Code, its settings/sessions are not restored) when it is not. An `engineSettings` entry this machine already
   * has wins over the backup's, and a session id must have that engine's shape, so a malformed archive changes
   * nothing. The mode still never comes from a backup.
   * Chats (office/chats/*.jsonl, or `chats` inside the state.json of older backups) are merged by message:
   * one already here (same original id, time and kind) is skipped, others are added under a new id (another
   * machine's m12 is not this one's), in the backup's order, interleaved by time with the chat here (neither
   * re-sorted), the newest CHAT_LIMIT kept. Display only: nothing in
   * them runs, a pending approval/running tool comes back as cancelled.
   * @param {object} imported
   * @param {Map<string, string>} idMap
   * @param {Record<string, object[]>} [chats]  the backup's chat files, by the backup's project id
   * @returns {{ favorites: number, settings: number, engines: number, engineSettings: number, sessions: number,
   *   chats: number }} how many of each were added/restored
   */
  mergeProjectData(imported, idMap, chats = {}) {
    const added = { favorites: 0, settings: 0, engines: 0, engineSettings: 0, sessions: 0, chats: 0 };
    const entries = (v) => (isObject(v) ? Object.entries(v) : []);
    // A backup from a machine with OpenCode, imported where it is not installed: those projects come back on
    // Claude Code (openCode false also keeps the OpenCode model/settings/sessions out below).
    const openCode = Boolean(this.config?.engines?.opencode?.available);
    const engineFromBackup = (raw) => {
      if (!ENGINES.includes(raw)) return null; // unknown engine: ignored, never a crash
      return raw === 'opencode' && !openCode ? 'claude' : raw;
    };
    const settingsMap = (this.persisted.settings = isObject(this.persisted.settings) ? this.persisted.settings : {});
    const engineSettings = (this.persisted.engineSettings = isObject(this.persisted.engineSettings) ? this.persisted.engineSettings : {});
    const byEngine = (this.persisted.sessionsByEngine = isObject(this.persisted.sessionsByEngine) ? this.persisted.sessionsByEngine : {});
    for (const id of Array.isArray(imported.favorites) ? imported.favorites : []) {
      const to = idMap.get(id);
      if (!to || this.persisted.favorites.includes(to)) continue;
      this.persisted.favorites.push(to);
      added.favorites++;
    }
    // What each engine remembered for the project. An entry already here (Stage 1, this machine) wins.
    for (const [id, per] of entries(imported.engineSettings)) {
      const to = idMap.get(id);
      if (!to || !isObject(per)) continue;
      for (const engine of ENGINES) {
        if (engine === 'opencode' && !openCode) continue;
        if (!isObject(per[engine])) continue;
        const target = (engineSettings[to] ??= {});
        if (isObject(target[engine])) continue;
        const raw = per[engine];
        const values = this.cleanSettings({ ...DEFAULT_SETTINGS, engine }, { model: raw.model, effort: raw.effort, agent: raw.agent });
        const stored = { model: values.model, effort: values.effort, agent: values.agent };
        if (!stored.model && !stored.effort && !stored.agent) continue; // nothing usable: no empty entry
        target[engine] = stored;
        added.engineSettings++;
      }
    }
    // The conversation to continue, per engine. A session id of this machine (or one already restored) wins.
    // OpenCode's own session store is NOT in the backup, so its ids would dangle on another laptop: only Claude's
    // transcript-backed ids are restored (the transcript files are in the archive).
    for (const [id, per] of entries(imported.sessionsByEngine)) {
      const to = idMap.get(id);
      if (!to || !isObject(per)) continue;
      for (const engine of ['claude']) {
        if (!validSessionFor(engine, per[engine])) continue; // malformed/wrong-engine id: ignored
        const target = (byEngine[to] ??= {});
        if (target[engine]) continue;
        target[engine] = per[engine];
        added.sessions++;
      }
    }
    for (const [id, settings] of entries(imported.settings)) {
      const to = idMap.get(id);
      if (!to) continue;
      const raw = isObject(settings) ? settings : {};
      // "No settings yet": a fresh entry may hold only the project's own engine (seeded by Hub.upsertProject).
      const local = settingsMap[to];
      const hasOwn = isObject(local) && Object.keys(local).some((k) => k !== 'engine');
      const current = this.engineOf(to);
      const wanted = engineFromBackup(raw.engine);
      const target = wanted ?? current;
      const switched = Boolean(wanted) && wanted !== current;
      if (!hasOwn) {
        // mode: never restored (see above); model/effort/agent are validated for the engine they are for.
        const { mode: _mode, engine: _engine, ...safe } = raw;
        const validated = this.cleanSettings({ ...DEFAULT_SETTINGS, engine: target }, safe);
        settingsMap[to] = { ...validated, engine: target };
        if (this.runtime.has(to)) this.setStatus(to, this.settingsFor(to));
        added.settings++;
      } else if (switched) {
        // This machine's own settings stay; only the engine (and the values that engine remembers) comes back.
        this.rememberEngineSettings(to, current, this.settingsFor(to));
        settingsMap[to] = { ...this.settingsFor(to), engine: target, ...this.engineSettingsFor(to, target) };
        if (this.runtime.has(to)) this.setStatus(to, this.settingsFor(to));
      }
      if (switched) added.engines++;
    }
    // The single map is a mirror of the project's current engine (older readers).
    const sessions = (this.persisted.sessions = isObject(this.persisted.sessions) ? this.persisted.sessions : {});
    for (const to of new Set([...Object.keys(byEngine), ...Object.keys(sessions)])) {
      if (!isChatId(to) || sessions[to]) continue;
      const own = byEngine[to]?.[this.engineOf(to)];
      if (own) sessions[to] = own;
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
   * A backup's chats of another engine's workspace (office/chats-opencode): merged into that engine's chat files,
   * by message like importChat. @returns {number} added
   */
  importEngineChats(engine, idMap, chats) {
    if (!ENGINES.includes(engine) || engine === 'claude' || !isObject(chats)) return 0; // Claude's come as `chats`
    const store = this.chatStoreFor(engine);
    let added = 0;
    for (const [from, list] of Object.entries(chats)) {
      const id = idMap.get(from);
      if (!id || id === DEMO_ID || !isChatId(id) || !Array.isArray(list)) continue;
      if (store.unreadable.has(id)) continue; // unreadable now: never overwritten
      const chat = this.chatFor(engine, id);
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
      const merged = interleaveByTime(chat, fresh).slice(-CHAT_LIMIT);
      chat.splice(0, chat.length, ...merged);
      store.rewrite(id);
      added += fresh.length;
    }
    return added;
  }

  /** The other engines' chat folders a backup carries too (by engine). */
  backupEngineChats() {
    return Object.fromEntries(ENGINES.filter((e) => e !== 'claude').map((e) => [e, this.chatDir(e)]));
  }

  /**
   * Adds a backup's messages to a project's chat (rules in mergeProjectData). A backup's `chats` are Claude
   * Code's: they always go to data/chats, never into another engine's history.
   * @returns {number} added
   */
  importChat(id, list, engine = 'claude') {
    const store = this.chatStoreFor(engine);
    if (store.unreadable.has(id)) return 0; // its file can't be read now: it would be overwritten
    const keyOf = messageKey;
    const chat = this.chatFor(engine, id);
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
    store.rewrite(id);
    return fresh.length;
  }

  // ---------- runtime state ----------

  rt(id) {
    let rt = this.runtime.get(id);
    if (!rt) {
      rt = {
        events: [],
        chat: this.chatFor(this.engineOf(id), id),
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
    if (id !== DEMO_ID) this.chatStoreFor(this.engineOf(id)).append(id, message);
    this.touch(id);
    this.broadcast('chat', message);
    this.scheduleSave();
    return message.id;
  }

  updateChat(id, chatId, patch) {
    const message = this.rt(id).chat.findLast((m) => m.id === chatId);
    if (!message) return;
    Object.assign(message, patch);
    if (id !== DEMO_ID) this.chatStoreFor(this.engineOf(id)).patch(id, chatId, patch);
    this.broadcast('chat_update', { project: id, id: chatId, patch });
    this.scheduleSave();
  }

  /**
   * After a conversation rewind: the prompt and everything after it are greyed out (still readable). Claude Code:
   * found by its uuid, else its text. OpenCode passes the chat entry itself (`chatId`, see AcpSession.chatEntryFor).
   * Returns the chat entry's text (what goes back into the box), or null.
   */
  markRewound(id, uuid, text, chatId = null) {
    const chat = this.rt(id).chat;
    let at = chatId ? chat.findLastIndex((m) => m.kind === 'user' && m.id === chatId) : chat.findLastIndex((m) => m.kind === 'user' && m.uuid === uuid);
    if (at < 0 && !chatId) at = chat.findLastIndex((m) => m.kind === 'user' && m.text?.trim() === text?.trim());
    if (at < 0) return null;
    for (const m of chat.slice(at)) if (!m.rewound && m.kind !== 'divider') this.updateChat(id, m.id, { rewound: true });
    return chat[at].text ?? null;
  }

  /**
   * 🔄 The opposite of markRewound (a conversation redo): every greyed-out message is readable — and continuable —
   * again. Returns how many were cleared.
   */
  unmarkRewound(id) {
    let cleared = 0;
    for (const m of this.rt(id).chat) {
      if (!m.rewound) continue;
      this.updateChat(id, m.id, { rewound: false });
      cleared++;
    }
    return cleared;
  }

  setStatus(id, patch) {
    const status = this.rt(id).status;
    Object.assign(status, patch);
    this.broadcast('status', status);
  }

  /** A project's live status as last sent to the browser (the same object, not a copy). */
  statusFor(id) {
    return this.rt(id).status;
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
    for (const key of Object.keys(this.storedChats)) {
      const id = key.slice(key.indexOf(':') + 1);
      if (this.projects.has(id)) this.rt(id);
    }
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
