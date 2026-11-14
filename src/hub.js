// Central state: project registry, per-project chat/events/status, approvals, SSE broadcast, persistence.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { BUDGET_KEYS, BUDGET_MAX_USD, cents, cleanLimits, cleanProjectBudgets } from './budget.js';
import { cleanRoutines } from './routines.js';
import { CHAT_LIMIT, ChatStore, isChatId } from './chat-store.js';
import { EFFORT_LEVELS } from './effort.js';
import { MODEL_TIERS } from './model-auto.js';
import { GO_PLANS } from './opencode-go.js';
import { DEFAULT_MODE, isMode, migrateMode, normalizeMode } from './modes.js';
import { describeTool } from './roles.js';
import { migrateTeamNames } from './role-catalog.js';
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
export const DEFAULT_SETTINGS = { mode: DEFAULT_MODE, model: '', modelAuto: false, effort: '', effortAuto: false, team: true, engine: 'claude', modelTiers: {} };
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
// Claude Code's permission modes are an implementation detail now: the app only stores build/plan (src/modes.js).
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
/** 🏷/📦 A hand-edited or older state.json must not inject junk: only a short tag, booleans, auto-archive days. */
function cleanSessionMeta(raw) {
  if (!isObject(raw)) return {};
  const out = {};
  for (const [projectId, per] of Object.entries(raw)) {
    if (!projectId || !isObject(per)) continue;
    const sessions = {};
    for (const [sessionId, meta] of Object.entries(per)) {
      if (!sessionId || sessionId.length > 200 || !isObject(meta)) continue;
      const tag = typeof meta.tag === 'string' ? meta.tag.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      const archived = meta.archived === true;
      const pinned = meta.pinned === true; // explicitly kept out of the automatic archive
      if (tag || archived || pinned) sessions[sessionId] = { ...(tag ? { tag } : {}), ...(archived ? { archived: true } : {}), ...(pinned ? { pinned: true } : {}) };
    }
    if (Object.keys(sessions).length) out[projectId] = sessions;
  }
  return out;
}

/** 🗂 Parent groups (related repos referenced under one named group): { id, name, members }. Folder semantics:
 *  a project belongs to at most one group. Sessions are never moved — the group only points at its members. */
const GROUP_NAME_MAX = 60;const cleanGroupMembers = (value) => [...new Set((Array.isArray(value) ? value : []).filter((m) => typeof m === 'string' && m).slice(0, 12))];
const cleanProjectGroups = (value) => {
  const groups = (Array.isArray(value) ? value : [])
    .filter((g) => isObject(g) && typeof g.id === 'string' && /^[\w-]{4,32}$/.test(g.id))
    .map((g) => ({
      id: g.id,
      name: (String(g.name ?? '').trim() || 'Grup').slice(0, GROUP_NAME_MAX),
      members: cleanGroupMembers(g.members),
    }))
    .filter((g) => g.members.length)
    .filter((g, i, all) => all.findIndex((x) => x.id === g.id) === i);
  const owned = new Set();
  for (const g of groups) g.members = g.members.filter((m) => (owned.has(m) ? false : (owned.add(m), true)));
  return groups;
};
/** A group's writable input: a real name, and — when members were sent — at least one that exists. */
const cleanGroupInput = (name, members, projects) => {
  const cleanName = String(name ?? '').trim();
  if (!cleanName || cleanName.length > GROUP_NAME_MAX) return null; // a too-long name is refused, not clamped
  const list = cleanGroupMembers(members);
  if (Array.isArray(members) && members.length && !list.length) return null;
  if (list.some((m) => !projects.has(m))) return null;
  return { name: cleanName, members: list };
};

/** ⚡ Remote power (Bardi/Tuya via a self-hosted bridge): where the bridge lives, its token, and how long after a
 *  graceful shutdown the bridge may cut the power. The bridge is remote → https only; clearing the URL disables. */
const REMOTE_POWER_DELAY_MAX = 600;
const cleanRemotePower = (raw) => {
  const url = String(raw?.bridgeUrl ?? '').trim();
  const token = String(raw?.token ?? '').trim();
  const delay = Number(raw?.offDelaySec);
  if (raw?.offDelaySec !== undefined && (!Number.isInteger(delay) || delay < 0 || delay > REMOTE_POWER_DELAY_MAX)) return null;
  const offDelaySec = Number.isFinite(delay) ? delay : 120;
  if (!url) return { bridgeUrl: '', token: '', offDelaySec };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !token || token.length > 200) return null; // url set but no token → useless, refused
  return { bridgeUrl: url.replace(/\/+$/, ''), token, offDelaySec };
};

/** 📚 Runbooks: saved prompt sequences; only valid entries survive a hand-edited state.json. */
function cleanRunbooks(raw) {
  if (!isObject(raw)) return {};
  const out = {};
  for (const [projectId, list] of Object.entries(raw)) {
    if (!projectId || !Array.isArray(list)) continue;
    const books = [];
    for (const book of list.slice(0, 50)) {
      if (!isObject(book)) continue;
      const name = typeof book.name === 'string' ? book.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      const prompts = (Array.isArray(book.prompts) ? book.prompts : [])
        .filter((p) => typeof p === 'string' && p.trim())
        .slice(0, 20)
        .map((p) => p.trim().slice(0, 4000));
      if (!name || !prompts.length) continue;
      const id = typeof book.id === 'string' && /^rb_[A-Za-z0-9_-]{1,40}$/.test(book.id) ? book.id : `rb_${Math.random().toString(36).slice(2, 12)}`;
      const history = (Array.isArray(book.history) ? book.history : [])
        .slice(-5)
        .map((v) => ({
          name: typeof v?.name === 'string' ? v.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
          prompts: (Array.isArray(v?.prompts) ? v.prompts : []).filter((p) => typeof p === 'string' && p.trim()).slice(0, 20).map((p) => p.trim().slice(0, 4000)),
          savedAt: Number(v?.savedAt) || 0,
        }))
        .filter((v) => v.name && v.prompts.length);
      books.push({ id, name, prompts, createdAt: Number(book.createdAt) || Date.now(), updatedAt: Number(book.updatedAt) || Date.now(), history });
    }
    if (books.length) out[projectId] = books;
  }
  return out;
}

/** 📦 Only a whole number of days (0 = off) survives in state.json. */
function cleanSessionAutoArchive(raw) {
  if (!isObject(raw)) return {};
  const out = {};
  for (const [id, days] of Object.entries(raw)) {
    const n = Number(days);
    if (id && Number.isInteger(n) && n > 0 && n <= 3650) out[id] = n;
  }
  return out;
}
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
    this.engineChanges = new Map(); // project id -> engine it just left (a settings change, until its new session takes it)
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
    // ⏰ Tugas terjadwal: only valid routines survive; a missing list is fine for older state files.
    this.persisted.routines = cleanRoutines(this.persisted.routines);
    // 💰 Per-project budgets: only valid limits survive.
    this.persisted.projectBudgets = cleanProjectBudgets(this.persisted.projectBudgets);
    // 🏷/📦 Session tags and archive flags: only valid entries survive.
    this.persisted.sessionMeta = cleanSessionMeta(this.persisted.sessionMeta);
    this.persisted.sessionAutoArchive = cleanSessionAutoArchive(this.persisted.sessionAutoArchive);
    // 📚 Runbooks per project: valid prompt sequences only.
    this.persisted.runbooks = cleanRunbooks(this.persisted.runbooks);
    // 🗂 Archived projects: an id list; a hand-edited file cannot break the picker.
    this.persisted.archivedProjects = Array.isArray(this.persisted.archivedProjects) ? [...new Set(this.persisted.archivedProjects.filter((p) => typeof p === 'string' && p).slice(0, 500))] : [];
    // ⭐ Favorite models: ids the picker pins to the top; strings only, deduped, max 12.
    this.persisted.favoriteModels = Array.isArray(this.persisted.favoriteModels) ? [...new Set(this.persisted.favoriteModels.filter((v) => typeof v === 'string' && v && v.length <= 200))].slice(0, 12) : [];
    // 🗂 Parent groups: related repos (web + api + mobile = one product) referenced under one named group.
    // Sessions are never moved — the group only points at its members (see routes/groups.js).
    this.persisted.projectGroups = cleanProjectGroups(this.persisted.projectGroups);
    // ⚡ Remote power (optional): the self-hosted bridge that can boot/cut the PC when away (see bridge/).
    this.persisted.remotePower = cleanRemotePower(this.persisted.remotePower);
    this.persisted.queueRetryOnce = isObject(this.persisted.queueRetryOnce) ? Object.fromEntries(Object.entries(this.persisted.queueRetryOnce).filter(([id, on]) => id && on === true).slice(0, 500)) : {};
    // 🏷 Team names saved by an older version still hold the old defaults ("Adhit - QA"): rename exactly those
    // (custom names are untouched) and persist once, so the migration never runs again.
    const teamNames = migrateTeamNames(this.persisted.teamNames);
    const teamNamesMigrated = teamNames.changed;
    if (teamNamesMigrated) this.persisted.teamNames = teamNames.names;
    this.budgetOverrideUntil = 0; // one-shot "allow one turn" after a hard stop (memory only)
    // Ids continue after the stored chats: browsers find a bubble by id, so an id reused after a restart
    // would send a new reply's live updates to an old bubble (the new one stays empty until a reload).
    // chatSeq: the counter at the last save, for chat files that could not be read now.
    this.seq = Math.max(maxStoredSeq(this.storedChats), this.migrationSeq, Number.isSafeInteger(this.persisted.chatSeq) ? this.persisted.chatSeq : 0);
    // Stage 2: the old app-wide switch's parking lot is flattened here, once, before anything else reads it.
    // save() (not writeState) so a chat migration that failed this run keeps its `chats` in state.json too.
    const modesMigrated = this.migrateModes();
    if (this.migrateWorkspaces() || teamNamesMigrated || modesMigrated) this.save();
    this.prunePreProjectBackups();
    this.closeStaleReplies();
    this.projects.set(DEMO_ID, { id: DEMO_ID, name: 'Demo kantor', path: null, sources: ['demo'], virtual: true });
  }

  load() {
    // turns: the turn running right now per project (written when it starts, removed when it ends); one left
    // over at start means the server died mid-turn. interrupted: turns cut short by a server stop, kept until
    // the user continues or dismisses them (see recoverTurns / interruptTurn).
    const empty = { roots: [], custom: [], favorites: [], favoriteModels: [], projectGroups: [], remotePower: { bridgeUrl: '', token: '', offDelaySec: 120 }, settings: {}, engineSettings: {}, sessions: {}, sessionsByEngine: {}, activity: {}, turns: {}, interrupted: {}, engine: 'claude', opencodeGoPlan: 'go', budget: { dailyUsd: null, weeklyUsd: null, monthlyUsd: null }, projectBudgets: {}, routines: [] };
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
    // The queued engine switch ("ganti mesin setelah giliran selesai") is gone: a model picks the engine at once.
    delete rest.engineQueue;
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

  /**
   * One-way mode migration (src/modes.js): stored modes become build/plan. A legacy 'dontAsk' becomes Plan with a
   * pending choice, so it can never silently turn into a looser Build. Idempotent: a second run changes nothing.
   */
  migrateModes() {
    const settings = isObject(this.persisted?.settings) ? this.persisted.settings : null;
    if (!settings) return false;
    let changed = false;
    for (const raw of Object.values(settings)) {
      if (!isObject(raw)) continue;
      const next = migrateMode(raw.mode);
      if (!next) continue;
      raw.mode = next.mode;
      if (next.legacyMode) raw.legacyMode = next.legacyMode;
      if (next.pending) raw.modePendingChoice = true;
      else {
        raw.modeNotice = true; // non-blocking: "the modes are now Plan/Build; Build edits files automatically"
        delete raw.modePendingChoice;
      }
      changed = true;
    }
    return changed;
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
   * Loads BOTH engines' workspaces at start (one engine per project, both histories kept). Nothing is
   * migrated or copied between them: a model picks which engine runs the project (Hub.updateSettings), and the
   * panel shows both histories as one timeline (Hub.timeline).
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

  /** ⭐ Favorite models: app-level ids the picker pins above the provider groups. */
  favoriteModels() {
    return Array.isArray(this.persisted.favoriteModels) ? this.persisted.favoriteModels : [];
  }

  /** Pins/unpins one id; invalid values are refused (null). Re-pinning a pinned id is a no-op (position kept). */
  toggleFavoriteModel(value, on) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || id.length > 200 || !/^[\w.:@#/-]+$/.test(id)) return null;
    if (on && this.favoriteModels().includes(id)) return this.favoriteModels();
    const rest = this.favoriteModels().filter((v) => v !== id);
    const next = on ? [...rest, id].slice(0, 12) : rest;
    this.persisted.favoriteModels = next;
    this.save();
    if (this.config) {
      this.config = { ...this.config, favoriteModels: next };
      this.broadcast('config', this.config);
    }
    return next;
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

  /**
   * One project's history as a single flow: both engines' stored messages plus the live chat, each tagged with the
   * engine it came from, oldest first, cut to `limit`. A message present twice (the live list is also a stored
   * list) is only listed once. Records without a numeric time keep their place at the start.
   */
  timeline(id, limit = CHAT_LIMIT) {
    const seen = new Set();
    const all = [];
    const add = (list, engine) => {
      for (const m of Array.isArray(list) ? list : []) {
        if (!m?.id || seen.has(m.id)) continue;
        seen.add(m.id);
        all.push(typeof m.engine === 'string' ? m : { ...m, engine }); // older rows carry no engine yet
      }
    };
    for (const engine of ENGINES) add(this.storedChats[this.chatKey(engine, id)], engine);
    add(this.runtime.get(id)?.chat, this.engineOf(id));
    all.sort((a, b) => tsOf(a) - tsOf(b) || Number(/^m(\d+)$/.exec(a?.id ?? '')?.[1] ?? 0) - Number(/^m(\d+)$/.exec(b?.id ?? '')?.[1] ?? 0));
    const max = Number.isSafeInteger(limit) && limit > 0 ? limit : CHAT_LIMIT;
    return all.slice(-max);
  }

  /**
   * Starts a clean chat column for the project: both engines' histories for it are dropped (one flow is shown now),
   * while each engine's own transcript/session history is untouched (Riwayat sesi still lists it).
   */
  clearChat(id) {
    const live = this.engineOf(id);
    const rt = this.runtime.get(id);
    for (const engine of ENGINES) {
      try {
        this.chatStoreFor(engine).remove(id);
      } catch (err) {
        console.error(`Mengosongkan riwayat chat ${engine} ${id} gagal: ${err.message}`);
      }
      if (rt && engine === live) {
        rt.chat = [];
        this.storedChats[this.chatKey(engine, id)] = rt.chat;
      } else {
        delete this.storedChats[this.chatKey(engine, id)];
      }
    }
    if (this.legacyChats) delete this.legacyChats[id];
    this.broadcast('chat_reset', { project: id });
    this.scheduleSave();
  }

  /**
   * Retention for chat history: removes messages older than `cutoff` (ms) from BOTH engines' chat files.
   * Pending records are flushed first (save()); an engine whose writes still fail is skipped, so a file that is
   * not in sync is never rewritten. The engine's own transcript/session is never touched: only the panel history
   * (data/chats*, this app's own file). Messages without a valid `ts` are kept. Only projects that actually lost
   * something get a `chat_reset`, so open pages reload that chat.
   * @returns {{ removed: number, projects: number }} messages removed and projects changed
   */
  pruneChatsBefore(cutoff) {
    const result = { removed: 0, projects: 0 };
    if (!Number.isFinite(cutoff) || cutoff <= 0) return result;
    this.save(); // pending appends/patches land before any file is rewritten
    const touched = new Set();
    const droppedIds = new Map(); // project id -> message ids the open pages must drop
    const drop = (id, messages) => {
      const old = messages.filter((m) => Number.isFinite(m?.ts) && m.ts < cutoff);
      if (!old.length) return { old, kept: messages };
      const ids = droppedIds.get(id) ?? [];
      for (const m of old) if (m?.id) ids.push(m.id);
      droppedIds.set(id, ids);
      return { old, kept: messages.filter((m) => !Number.isFinite(m?.ts) || m.ts >= cutoff) };
    };
    for (const engine of ENGINES) {
      const store = this.chatStoreFor(engine);
      for (const id of store.list()) {
        if (id === DEMO_ID || store.unreadable.has(id)) continue; // an unreadable file is never rewritten
        // A write still pending for THIS project (a failed flush): never rewrite that file under it. Other projects
        // in the same engine are still pruned — one locked file must not stop the whole cleanup.
        if (store.pending?.has?.(id) || store.rewrites?.has?.(id)) {
          console.error(`Retensi chat ${engine} ${id} dilewati: masih ada perubahan yang belum tersimpan.`);
          continue;
        }
        let messages;
        try {
          const rt = this.runtime.get(id);
          messages = rt && this.engineOf(id) === engine ? rt.chat : store.read(id).messages;
        } catch (err) {
          console.error(`Retensi chat ${engine} ${id} dilewati: ${err.message}`);
          continue;
        }
        const { old, kept } = drop(id, messages);
        if (!old.length) continue;
        try {
          store.writeAll(id, kept); // atomic, and capped at CHAT_LIMIT
        } catch (err) {
          console.error(`Retensi chat ${engine} ${id} gagal: ${err.message}`);
          continue;
        }
        // The running chat and the copy read at start are the same array in the common case; replacing both is safe.
        const rt = this.runtime.get(id);
        if (rt && this.engineOf(id) === engine) rt.chat.splice(0, rt.chat.length, ...kept);
        const key = this.chatKey(engine, id);
        if (this.storedChats[key]) this.storedChats[key].splice(0, this.storedChats[key].length, ...kept);
        result.removed += old.length;
        touched.add(id);
      }
    }
    // A failed legacy migration keeps Claude's chats in state.json instead of the chat files: prune those too, so a
    // retention promise is not silently skipped forever. (Rare, transitional state.)
    if (this.legacyChats) {
      for (const [id, list] of Object.entries(this.legacyChats)) {
        if (id === DEMO_ID || !Array.isArray(list)) continue;
        const { old, kept } = drop(id, list);
        if (!old.length) continue;
        this.legacyChats[id] = kept.slice(-CHAT_LIMIT);
        const key = this.chatKey('claude', id);
        const stored = this.storedChats[key];
        if (stored) stored.splice(0, stored.length, ...this.legacyChats[id]);
        result.removed += old.length;
        touched.add(id);
      }
      if (touched.size) this.scheduleSave();
    }
    for (const [id, ids] of droppedIds) this.broadcast('chat_prune', { project: id, ids });
    result.projects = touched.size;
    return result;
  }

  /** How much `pruneChatsBefore(cutoff)` would remove, without writing anything. */
  chatRetentionCount(cutoff) {
    const result = { messages: 0, projects: 0 };
    if (!Number.isFinite(cutoff) || cutoff <= 0) return result;
    const projects = new Set();
    for (const engine of ENGINES) {
      const store = this.chatStoreFor(engine);
      for (const id of store.list()) {
        if (id === DEMO_ID || store.unreadable.has(id)) continue;
        let messages;
        try {
          const rt = this.runtime.get(id);
          messages = rt && this.engineOf(id) === engine ? rt.chat : store.read(id).messages;
        } catch {
          continue;
        }
        const old = messages.filter((m) => Number.isFinite(m?.ts) && m.ts < cutoff).length;
        if (!old) continue;
        result.messages += old;
        projects.add(id);
      }
    }
    result.projects = projects.size;
    return result;
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
    this.engineChanges.delete(id);
    this.persisted.custom = (this.persisted.custom ?? []).filter((p) => projectId(p) !== id);
    this.persisted.favorites = this.persisted.favorites.filter((f) => f !== id);
    this.persisted.archivedProjects = this.persisted.archivedProjects.filter((p) => p !== id);
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
    this.engineChanges.delete(id);
    this.persisted.custom = this.persisted.custom.filter((p) => projectId(p) !== id);
    this.persisted.favorites = this.persisted.favorites.filter((f) => f !== id);
    this.persisted.archivedProjects = this.persisted.archivedProjects.filter((p) => p !== id);
    this.removeProjectFromGroups(id); // a forgotten project also leaves its parent group
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
      archived: this.persisted.archivedProjects.includes(p.id),
      // The folder is gone (moved, deleted, a temp folder from an old CLI session): the picker may offer a safe purge.
      // Only ENOENT/ENOTDIR: an unreadable or temporarily offline folder is not an orphan.
      missing: Boolean(p.path) && isMissing(p.path),
      group: this.groupOf(p.id) ? { id: this.groupOf(p.id).id, name: this.groupOf(p.id).name } : null,
    }));
  }

  // ---------- 🗂 parent groups (related repos referenced under one named group; sessions never move) ----------

  projectGroups() {
    return Array.isArray(this.persisted.projectGroups) ? this.persisted.projectGroups : [];
  }

  /** The group a project belongs to (folder semantics: at most one), or null. */
  groupOf(projectId) {
    return this.projectGroups().find((g) => g.members.includes(projectId)) ?? null;
  }

  /** Creates a group: a trimmed unique name and members that exist; a member already in another group moves here. */
  createProjectGroup(name, members) {
    const clean = cleanGroupInput(name, members, this.projects);
    if (!clean) return null;
    const group = { id: randomBytes(4).toString('hex'), name: clean.name, members: clean.members };
    for (const g of this.persisted.projectGroups) g.members = g.members.filter((m) => !group.members.includes(m));
    this.persisted.projectGroups = [...this.projectGroups().filter((g) => g.members.length), group];
    this.save();
    this.broadcast('projects', this.listProjects());
    return group;
  }

  /** Renames, adds members (moving them out of their previous group) and/or removes members. */
  updateProjectGroup(id, { name, add, remove } = {}) {
    const group = this.projectGroups().find((g) => g.id === id);
    if (!group) return null;
    if (name !== undefined) {
      const clean = cleanGroupInput(name, [], this.projects);
      if (!clean) return null;
      group.name = clean.name;
    }
    const addIds = Array.isArray(add) ? add : [];
    const removeIds = Array.isArray(remove) ? remove : [];
    if (addIds.some((m) => typeof m !== 'string' || !this.projects.has(m))) return null;
    for (const other of this.persisted.projectGroups) if (other.id !== id) other.members = other.members.filter((m) => !addIds.includes(m));
    group.members = group.members.filter((m) => !removeIds.includes(m));
    for (const m of addIds) if (!group.members.includes(m)) group.members.push(m);
    this.persisted.projectGroups = this.projectGroups().filter((g) => g.members.length);
    this.save();
    this.broadcast('projects', this.listProjects());
    return group;
  }

  /** Dissolves a group only: its members' projects, sessions and data are untouched. */
  dissolveProjectGroup(id) {
    const rest = this.projectGroups().filter((g) => g.id !== id);
    if (rest.length === this.projectGroups().length) return null;
    this.persisted.projectGroups = rest;
    this.save();
    this.broadcast('projects', this.listProjects());
    return true;
  }

  /** A forgotten/purged project leaves every group; a group with no members left dissolves itself. */
  removeProjectFromGroups(projectId) {
    for (const g of this.projectGroups()) g.members = g.members.filter((m) => m !== projectId);
    this.persisted.projectGroups = this.projectGroups().filter((g) => g.members.length);
  }

  /** ⚡ Remote power: the self-hosted bridge config (url + token + power-cut delay), or an empty config when off. */
  remotePower() {
    return cleanRemotePower(this.persisted.remotePower);
  }

  /** Saves a validated config; the url is required https (the bridge is remote), an empty url disables. */
  setRemotePower(patch) {
    const clean = cleanRemotePower(patch);
    if (!clean) return null;
    this.persisted.remotePower = clean;
    this.save();
    return clean;
  }

  /** 🗂 Archive (hide from the picker) or show a project again; nothing is deleted. */
  setProjectArchived(id, on) {
    const rest = this.persisted.archivedProjects.filter((p) => p !== id);
    this.persisted.archivedProjects = on ? [...rest, id] : rest;
    this.save();
    this.broadcast('projects', this.listProjects());
    return on;
  }

  /**
   * 🧹 Clears one project's app-side data (chat history both engines, settings→engine only, activity, sessions,
   * turns, queue, session meta, runbooks) but keeps the project listed. Transcripts on disk are untouched.
   */
  clearProjectData(id) {
    const project = this.projects.get(id);
    if (!project) return false;
    const engine = this.engineOf(id);
    this.engineChanges.delete(id);
    for (const e of ENGINES) {
      delete this.storedChats[this.chatKey(e, id)];
      try {
        this.chatStoreFor(e).remove(id);
      } catch {
        // a locked or already gone chat file must not block the rest
      }
    }
    const rt = this.runtime.get(id);
    if (rt) {
      rt.chat = [];
      rt.events = [];
      if (rt.status) rt.status.sessionId = null;
    }
    for (const key of ['sessions', 'sessionsByEngine', 'activity', 'turns', 'interrupted', 'queues', 'engineSettings', 'sessionMeta', 'runbooks', 'sessionAutoArchive', 'queueRetryOnce']) {
      if (this.persisted[key]) delete this.persisted[key][id];
    }
    this.persisted.settings[id] = { engine };
    this.save();
    this.broadcast('projects', this.listProjects());
    return true;
  }

  /** 🔁 Retry a failed queue item once, automatically, on this project. */
  queueRetryOnceFor(id) {
    return this.persisted.queueRetryOnce?.[id] === true;
  }

  setQueueRetryOnce(id, on) {
    const map = (this.persisted.queueRetryOnce ??= {});
    if (on) map[id] = true;
    else delete map[id];
    if (!Object.keys(map).length) delete this.persisted.queueRetryOnce;
    this.scheduleSave();
    return Boolean(on);
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
    // A hand-edited/older state.json could hold anything here: the engines only ever see build/plan.
    settings.mode = normalizeMode(settings.mode);
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
    if (isMode(patch.mode)) {
      next.mode = patch.mode;
      // Only an explicit choice (the select, the migration banner, a plan approval) ends a pending decision.
      // A model/team/effort save that happens to carry the old mode must never clear the gate.
      if (patch.modeChosen === true) delete next.modePendingChoice;
    } else if (patch.mode === 'manual' || patch.mode === 'acceptEdits' || patch.mode === 'auto') {
      next.mode = 'build'; // an old tab: same vocabulary, auto-edit on; it can never turn permissions looser than Build
    }
    // 'dontAsk' from an old client is deliberately ignored: it must not silently become a looser Build.
    if (patch.modeNoticeSeen === true) delete next.modeNotice; // the one-time "mode changed" note was read
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

  /** The per-project budget now stored (all off when nothing real was saved). */
  projectBudgetFor(id) {
    return cleanLimits(this.persisted?.projectBudgets?.[id]);
  }

  /** Saves one project's own limits; clearing every field removes the entry. */
  setProjectBudget(id, patch) {
    const next = cleanLimits(this.persisted?.projectBudgets?.[id]);
    if (isObject(patch)) {
      for (const key of BUDGET_KEYS) {
        if (!(key in patch)) continue;
        const raw = patch[key];
        if (raw === null || raw === '' || raw === 0) {
          next[key] = null;
          continue;
        }
        const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.trim().replace(',', '.')) : NaN;
        if (!Number.isFinite(value) || value < 0 || value > BUDGET_MAX_USD) continue;
        next[key] = value > 0 ? cents(value) : null;
      }
    }
    this.persisted.projectBudgets ??= {};
    if (BUDGET_KEYS.some((key) => next[key] > 0)) this.persisted.projectBudgets[id] = next;
    else delete this.persisted.projectBudgets[id];
    this.save();
    this.broadcast('budget', this.persisted.budget);
    return next;
  }

  updateSettings(id, patch) {
    const before = this.settingsFor(id);
    const next = this.cleanSettings(before, patch);
    const engineChanged = next.engine !== before.engine;
    if (engineChanged) {
      // The engine follows the model picked for it. A model/effort/agent sent with this same patch is the user's
      // choice for the target engine and wins; otherwise that engine's own saved values come back exactly as they
      // were. Either way both engines stay remembered (engineSettings), so going back and forth loses nothing.
      this.rememberEngineSettings(id, before.engine, before);
      const saved = this.engineSettingsFor(id, next.engine);
      const sent = isObject(patch) ? patch : {};
      // Only values this patch actually set (and cleanSettings accepted) beat the engine's own saved values.
      const modelSent = typeof sent.model === 'string' && (sent.model === '' || sent.model === 'default' || next.model === sent.model);
      const effortSent = EFFORT_LEVELS.includes(sent.effort);
      const agentSent = sent.agent === '' || (typeof sent.agent === 'string' && STORED_AGENT.test(sent.agent));
      if (!modelSent) next.model = saved.model;
      if (!effortSent) next.effort = saved.effort;
      if (!agentSent) next.agent = saved.agent;
      // The next session this project creates (src/session.js) bridges the old engine's chat once.
      this.engineChanges.set(id, before.engine);
    }
    this.rememberEngineSettings(id, next.engine, next);
    this.persisted.settings[id] = next;
    if (patch.modeNoticeSeen === true) {
      // The one-time migration note is the same text for every project: one dismissal clears it everywhere,
      // so the banner does not reappear just because another project was migrated too.
      for (const [otherId, raw] of Object.entries(this.persisted.settings)) {
        if (otherId !== id && isObject(raw) && raw.modeNotice === true) {
          delete raw.modeNotice;
          if (this.runtime.has(otherId)) this.setStatus(otherId, this.settingsFor(otherId));
        }
      }
    }
    if (engineChanged) {
      // New messages belong to the target engine's store now; both are shown by timeline(). Resolve the store
      // array directly: chatFor() would still return the old runtime list (engineOf already points at the target).
      this.attachRuntimeChat(id, next.engine);
      // The "provider logged out" warning belongs to the model of the engine we just left.
      if (this.runtime.has(id)) this.setStatus(id, { modelStale: false });
    }
    this.scheduleSave();
    this.setStatus(id, this.settingsFor(id));
  }

  /**
   * Points a project's runtime at `engine`'s stored chat array. The old runtime list stays in storedChats under its
   * own engine, so writes and compaction can never mix the two workspaces.
   */
  attachRuntimeChat(id, engine) {
    const rt = this.runtime.get(id);
    if (!rt) return;
    rt.chat = (this.storedChats[this.chatKey(engine, id)] ??= []);
    rt.events = [];
    if (rt.status) Object.assign(rt.status, { activeModel: null, sessionId: this.sessionIdFor(id) });
  }

  /**
   * The engine a project just moved away from (a model picked for another engine), once: the new session carries
   * that chat as a context note (src/handoff.js bridgeNote) and writes one info line in the chat. No divider.
   * Memory only: a restart in between simply means no note (the next switch still works).
   */
  takeEngineFrom(id) {
    const from = this.engineChanges.get(id);
    this.engineChanges.delete(id);
    return from ?? null;
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

  // ---------- 🏷 tags / 📦 archive of a listed session (persisted per project + session id) ----------

  /** `{ tag?, archived? }` of one session, or null. */
  sessionMetaFor(id, sessionId) {
    const m = this.persisted.sessionMeta?.[id]?.[sessionId];
    return m && typeof m === 'object' ? m : null;
  }

  /** The whole project's map (sessionId → meta), safe to read while listing. */
  sessionMetaMap(id) {
    const m = this.persisted.sessionMeta?.[id];
    return m && typeof m === 'object' ? m : {};
  }

  /**
   * Sets (or clears) a session's 🏷 tag and/or 📦 archive flag. `tag: ''` and `archived: false` remove the field;
   * an entry with neither is dropped. @returns the stored meta (`{}` when nothing is left)
   */
  setSessionMeta(id, sessionId, patch) {
    const all = (this.persisted.sessionMeta ??= {});
    const per = (all[id] ??= {});
    const next = { ...(per[sessionId] ?? {}) };
    if (Object.hasOwn(patch, 'tag')) {
      const tag = typeof patch.tag === 'string' ? patch.tag.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      if (tag) next.tag = tag;
      else delete next.tag;
    }
    if (Object.hasOwn(patch, 'archived')) {
      if (patch.archived === true) next.archived = true;
      else delete next.archived;
    }
    if (Object.hasOwn(patch, 'pinned')) {
      if (patch.pinned === true) next.pinned = true;
      else delete next.pinned;
    }
    if (next.tag || next.archived || next.pinned) per[sessionId] = next;
    else delete per[sessionId];
    if (!Object.keys(per).length) delete all[id];
    this.scheduleSave();
    return next;
  }

  /** 📦 Days after which an unused session is shown as archived (0 = off). */
  sessionAutoArchiveDays(id) {
    const n = Number(this.persisted.sessionAutoArchive?.[id]);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  setSessionAutoArchive(id, days) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 0 || n > 3650) throw Object.assign(new Error('Jumlah hari tidak valid.'), { status: 400 });
    const map = (this.persisted.sessionAutoArchive ??= {});
    if (n > 0) map[id] = n;
    else delete map[id];
    if (!Object.keys(map).length) delete this.persisted.sessionAutoArchive;
    this.scheduleSave();
    return n;
  }

  /** 📚 The project's saved runbooks (a copy, newest last). */
  runbooksFor(id) {
    return [...(this.persisted.runbooks?.[id] ?? [])];
  }

  /** Creates (no `book.id`) or updates a runbook; throws a 400-status error with a user-facing reason. */
  saveRunbook(id, { id: bookId, name, prompts }) {
    const cleanName = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const cleanPrompts = (Array.isArray(prompts) ? prompts : [])
      .filter((p) => typeof p === 'string' && p.trim())
      .slice(0, 20)
      .map((p) => p.trim().slice(0, 4000));
    if (!cleanName) throw Object.assign(new Error('Nama runbook kosong.'), { status: 400 });
    if (!cleanPrompts.length) throw Object.assign(new Error('Runbook butuh minimal satu prompt.'), { status: 400 });
    const all = (this.persisted.runbooks ??= {});
    const list = (all[id] ??= []);
    let book = bookId ? list.find((b) => b.id === bookId) : null;
    if (book) {
      // 🕘 Keep the last 5 versions (name + prompts) before overwriting.
      book.history = [...(book.history ?? []), { name: book.name, prompts: [...book.prompts], savedAt: Date.now() }].slice(-5);
      Object.assign(book, { name: cleanName, prompts: cleanPrompts, updatedAt: Date.now() });
    } else {
      if (list.length >= 50) throw Object.assign(new Error('Maksimal 50 runbook per project.'), { status: 400 });
      book = { id: `rb_${Math.random().toString(36).slice(2, 12)}`, name: cleanName, prompts: cleanPrompts, createdAt: Date.now(), updatedAt: Date.now(), history: [] };
      list.push(book);
    }
    this.scheduleSave();
    return { ...book, prompts: [...book.prompts], history: (book.history ?? []).map((v) => ({ ...v, prompts: [...v.prompts] })) };
  }

  /** 🗑 Deletes a runbook of this project. @returns whether it existed */
  deleteRunbook(id, bookId) {
    const list = this.persisted.runbooks?.[id];
    if (!Array.isArray(list)) return false;
    const at = list.findIndex((b) => b.id === bookId);
    if (at < 0) return false;
    list.splice(at, 1);
    if (!list.length) delete this.persisted.runbooks[id];
    this.scheduleSave();
    return true;
  }

  /** 🏷 Rename (or remove, with an empty `to`) one tag across every session of a project. @returns how many changed */
  renameSessionTag(id, from, to) {
    const tag = typeof from === 'string' ? from.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    if (!tag) return 0;
    const next = typeof to === 'string' ? to.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    const per = this.persisted.sessionMeta?.[id];
    if (!per) return 0;
    let changed = 0;
    for (const meta of Object.values(per)) {
      if (meta.tag !== tag) continue;
      if (next) meta.tag = next;
      else delete meta.tag;
      changed += 1;
    }
    for (const [sessionId, meta] of Object.entries(per)) if (!meta.tag && !meta.archived && !meta.pinned) delete per[sessionId];
    if (!Object.keys(per).length) delete this.persisted.sessionMeta[id];
    if (changed) this.scheduleSave();
    return changed;
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
      // A restored engine also moves a runtime that already exists (its chat must belong to that store).
      if (target !== current && this.runtime.has(to)) this.attachRuntimeChat(to, target);
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
    // Each row remembers the engine that produced it: one timeline shows both engines' histories (timeline()).
    const message = { id: `m${++this.seq}`, ts: Date.now(), project: id, ...msg, engine: this.engineOf(id) };
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
    if (!approval.id || this.approvals.has(approval.id)) return null; // same id twice: never overwrite a waiting card
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
      // One flow for both engines (tagged per message); the panel's own bound stays 150 rows.
      const chat = this.timeline(id, 150);
      if (chat.length) chats[id] = chat;
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
