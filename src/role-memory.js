// 🧭 Pemetaan peran yang dipelajari: who in the office does work whose name no rule in src/roles.js knows
// (an MCP server, a skill, a subagent type, a script, a program). Three sources, the first that has the name wins:
//   1. <project>/.office-roles.json  { "mcp:hubspot": "pm" }: this project's, shared with its team through its own
//      git (the user decides whether to commit it)
//   2. this laptop's mappings in state.json (`roleMap.entries`): the user's corrections ("manual") and the AI's
//      answers ("ai"); never pushed anywhere, carried by 💾 Backup with the rest of state.json
//   3. the shared map shipped with the app (src/role-map.shared.json): mappings proposed with "🌐 Semua pengguna"
//      and merged into the app's repository; every install gets them with its next update, no tokens
//   4. the built-in rules (src/roles.js)
// Names the rules fell back on are listed (`roleMap.unknown`) for the user to map. With 🤖 AI on (off by default)
// they are also sent in small batches to the active engine's cheapest model: only the names and a tool name as
// a hint (never code, paths, commands or chat), each name once; the answer is stored and reused for good.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readOnlyOpenCodeEnv, readUserPermission } from './opencode-bin.js';
import { execFileTree } from './proc.js';
import { CATALOG_IDS } from './role-catalog.js';

export const PROJECT_FILE = '.office-roles.json';
export const ROLE_KEY = /^(mcp|skill|agent|script|cmd):[\w.@+:-]{1,100}$/;
const VALID_ROLES = new Set([...CATALOG_IDS, 'claude']); // `claude` = the Lead (coordination)
const MAX_UNKNOWN = 200;
const MAX_ENTRIES = 1000;
const BATCH = 12;
const RETRY_AFTER_MS = 24 * 3600_000; // a name the AI could not map is asked again a day later at the earliest
const PROJECT_RECHECK_MS = 3000;

export class RoleMapError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const cleanKey = (key) => {
  const k = String(key ?? '').toLowerCase().trim();
  return ROLE_KEY.test(k) ? k : null;
};
const cleanRole = (role) => (VALID_ROLES.has(role) ? role : null);

export class RoleMemory {
  /**
   * @param {{ hub: { persisted: object, scheduleSave(): void, broadcast?(type: string, data: object): void },
   *   classify?: ((items: {key: string, hint: string}[]) => Promise<Record<string, string>|null>) | null,
   *   aiDelayMs?: number, now?: () => number }} options
   */
  constructor({ hub, classify = null, aiDelayMs = 20_000, now = Date.now, sharedFile = null }) {
    this.hub = hub;
    this.sharedFile = sharedFile;
    this.shared = sharedFile ? readMapFile(sharedFile) : {};
    this.classify = classify;
    this.aiDelayMs = aiDelayMs;
    this.now = now;
    this.projects = new Map(); // project path -> { checkedAt, mtime, map }
    this.queue = new Set();
    this.timer = null;
    this.busy = false;
    this.lastError = '';
    const stored = isObject(hub.persisted.roleMap) ? hub.persisted.roleMap : {};
    this.state = hub.persisted.roleMap = {
      ai: stored.ai === true,
      entries: cleanEntries(stored.entries),
      unknown: cleanUnknown(stored.unknown),
    };
    if (this.state.ai) for (const key of Object.keys(this.state.unknown)) this.queue.add(key);
    if (this.queue.size) this.scheduleAi();
  }

  /** The learned role of a name: this project's file, then this laptop's; null when neither has it. */
  lookup(key, projectPath) {
    const k = cleanKey(key);
    if (!k) return null;
    return this.projectMap(projectPath)[k] ?? this.state.entries[k]?.role ?? this.shared[k] ?? null;
  }

  /** The rules fell back on this name: listed for the user, and queued for the AI when it is on. */
  noteUnknown(key, hint, projectPath) {
    const k = cleanKey(key);
    if (!k || this.lookup(k, projectPath)) return;
    const at = new Date(this.now()).toISOString();
    const u = this.state.unknown[k];
    if (u) {
      u.count++;
      u.lastAt = at;
      // counted in memory every time; written at most once a minute per name
      if (this.now() - (u.savedAt ?? 0) < 60_000) return;
      u.savedAt = this.now();
    } else {
      this.state.unknown[k] = { hint: clip(hint), count: 1, firstAt: at, lastAt: at, savedAt: this.now() };
      const keys = Object.keys(this.state.unknown);
      if (keys.length > MAX_UNKNOWN) delete this.state.unknown[keys.sort((a, b) => this.state.unknown[a].lastAt.localeCompare(this.state.unknown[b].lastAt))[0]];
      this.changed();
    }
    this.hub.scheduleSave();
    if (this.state.ai) {
      this.queue.add(k);
      this.scheduleAi();
    }
  }

  /**
   * Maps a name to a role (or removes the mapping: `role` null). `scope` 'project' writes the project's
   * .office-roles.json (and drops this laptop's own mapping of the name, so the project's is the one in force).
   */
  set(key, role, { scope = 'local', projectPath = null } = {}) {
    const k = cleanKey(key);
    if (!k) throw new RoleMapError(400, 'Nama tidak valid.');
    const r = role == null || role === '' ? null : cleanRole(role);
    if (role != null && role !== '' && !r) throw new RoleMapError(400, 'Role tidak dikenal.');
    if (scope === 'project') {
      if (!projectPath) throw new RoleMapError(400, 'Pilih project dulu.');
      const map = { ...this.readProjectFile(projectPath) };
      if (r) map[k] = r;
      else delete map[k];
      this.writeProjectFile(projectPath, map);
      if (r) delete this.state.entries[k];
    } else if (r) {
      this.state.entries[k] = { role: r, by: 'manual', at: new Date(this.now()).toISOString() };
      const keys = Object.keys(this.state.entries);
      if (keys.length > MAX_ENTRIES) delete this.state.entries[keys[0]];
    } else delete this.state.entries[k];
    if (r) {
      delete this.state.unknown[k];
      this.queue.delete(k);
    }
    this.hub.scheduleSave();
    this.changed();
    return this.list(projectPath);
  }

  /** Drops a name from the "not recognised" list (it comes back when it is used again). */
  dismiss(key) {
    const k = cleanKey(key);
    if (k) delete this.state.unknown[k];
    this.queue.delete(k);
    this.hub.scheduleSave();
    this.changed();
  }

  setAi(enabled) {
    this.state.ai = enabled === true;
    if (this.state.ai) {
      for (const key of Object.keys(this.state.unknown)) this.queue.add(key);
      this.scheduleAi(1000);
    } else {
      this.queue.clear();
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.hub.scheduleSave();
    this.changed();
  }

  /** For the dialog: every mapping in force for this project and the names still not recognised. */
  list(projectPath) {
    const project = this.projectMap(projectPath);
    const entries = Object.entries(this.state.entries).map(([key, e]) => ({ key, role: e.role, by: e.by, at: e.at, source: 'local' }));
    for (const [key, role] of Object.entries(project)) entries.push({ key, role, by: 'project', at: null, source: 'project' });
    // the shared map, where neither this project nor this laptop says otherwise
    for (const [key, role] of Object.entries(this.shared)) if (!project[key] && !this.state.entries[key]) entries.push({ key, role, by: 'shared', at: null, source: 'shared' });
    entries.sort((a, b) => a.key.localeCompare(b.key));
    const unknown = Object.entries(this.state.unknown)
      .filter(([key]) => !project[key] && !this.shared[key])
      .map(([key, u]) => ({ key, hint: u.hint, count: u.count, lastAt: u.lastAt, aiTried: Boolean(u.aiTriedAt) }))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    return { ai: this.state.ai, aiAvailable: Boolean(this.classify), busy: this.busy, queued: this.queue.size, lastError: this.lastError, entries, unknown, projectFile: projectPath ? PROJECT_FILE : null, roles: [...VALID_ROLES] };
  }

  /**
   * 🌐 Semua pengguna (the app's maintainer, on its own clone): writes the mapping into the shared map in the app's
   * repository; it reaches everyone once committed, pushed and pulled by their update.
   */
  share(key, role, projectPath = null) {
    const k = cleanKey(key);
    const r = cleanRole(role);
    if (!k || !r) throw new RoleMapError(400, 'Nama atau role tidak valid.');
    if (!this.sharedFile) throw new RoleMapError(404, 'Pemetaan bersama tidak tersedia.');
    const map = { ...readMapFile(this.sharedFile), [k]: r };
    writeMapFile(this.sharedFile, map);
    this.shared = readMapFile(this.sharedFile);
    delete this.state.entries[k];
    delete this.state.unknown[k];
    this.queue.delete(k);
    this.hub.scheduleSave();
    this.changed();
    return this.list(projectPath);
  }

  // ---- the project's file ----

  projectMap(projectPath) {
    if (!projectPath) return {};
    const now = this.now();
    let c = this.projects.get(projectPath);
    if (c && now - c.checkedAt < PROJECT_RECHECK_MS) return c.map;
    let mtime = 0;
    try {
      mtime = statSync(path.join(projectPath, PROJECT_FILE)).mtimeMs;
    } catch {
      /* no file */
    }
    if (!c || c.mtime !== mtime) c = { mtime, map: mtime ? this.readProjectFile(projectPath) : {} };
    c.checkedAt = now;
    this.projects.set(projectPath, c);
    return c.map;
  }

  readProjectFile(projectPath) {
    return readMapFile(path.join(projectPath, PROJECT_FILE));
  }

  writeProjectFile(projectPath, map) {
    writeMapFile(path.join(projectPath, PROJECT_FILE), map);
    this.projects.delete(projectPath);
  }

  // ---- 🤖 AI for names no rule knows ----

  scheduleAi(delay = this.aiDelayMs) {
    if (!this.classify || !this.state.ai || this.timer || this.busy) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runAi().catch(() => {});
    }, delay);
    this.timer.unref?.();
  }

  async runAi() {
    if (!this.classify || !this.state.ai || this.busy) return;
    const now = this.now();
    const items = [...this.queue]
      .filter((key) => this.state.unknown[key] && !(now - (this.state.unknown[key].aiTriedAt ?? 0) < RETRY_AFTER_MS))
      .slice(0, BATCH)
      .map((key) => ({ key, hint: this.state.unknown[key].hint ?? '' }));
    for (const key of [...this.queue]) if (!this.state.unknown[key] || now - (this.state.unknown[key].aiTriedAt ?? 0) < RETRY_AFTER_MS) this.queue.delete(key);
    if (!items.length) return;
    this.busy = true;
    this.changed();
    let answer = null;
    try {
      answer = await this.classify(items);
      this.lastError = answer ? '' : 'AI tidak memberi jawaban yang bisa dibaca.';
    } catch (err) {
      this.lastError = String(err?.message ?? err).slice(0, 200);
    }
    const at = new Date(this.now()).toISOString();
    let mapped = 0;
    for (const { key } of items) {
      this.queue.delete(key);
      const role = cleanRole(answer?.[key]);
      if (role && !this.state.entries[key]) {
        this.state.entries[key] = { role, by: 'ai', at };
        delete this.state.unknown[key];
        mapped++;
      } else if (this.state.unknown[key]) this.state.unknown[key].aiTriedAt = this.now();
    }
    if (mapped) console.log(`Pemetaan peran (AI): ${mapped} nama baru dipetakan`);
    this.busy = false;
    this.hub.scheduleSave();
    this.changed();
    if (this.queue.size) this.scheduleAi();
  }

  changed() {
    this.hub.broadcast?.('role-map', { busy: this.busy, unknown: Object.keys(this.state.unknown).length });
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

/** A { "<kind>:<name>": "<role>" } file, invalid lines dropped; {} when missing or unreadable. */
function readMapFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const map = {};
    for (const [key, role] of Object.entries(isObject(raw) ? raw : {})) {
      const k = cleanKey(key);
      const r = cleanRole(role);
      if (k && r) map[k] = r;
    }
    return map;
  } catch {
    return {};
  }
}

/** Sorted by name, one per line (easy to review in a pull request), written atomically. */
function writeMapFile(file, map) {
  const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    throw new RoleMapError(500, `Gagal menulis ${path.basename(file)}: ${err.code ?? err.message}`);
  }
}

const clip = (s) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 80);

function cleanEntries(input) {
  const out = {};
  for (const [key, e] of Object.entries(isObject(input) ? input : {})) {
    const k = cleanKey(key);
    const role = cleanRole(e?.role);
    if (k && role) out[k] = { role, by: e.by === 'ai' ? 'ai' : 'manual', at: typeof e.at === 'string' ? e.at : null };
  }
  return out;
}

function cleanUnknown(input) {
  const out = {};
  for (const [key, u] of Object.entries(isObject(input) ? input : {})) {
    const k = cleanKey(key);
    if (!k || !isObject(u)) continue;
    const at = typeof u.lastAt === 'string' ? u.lastAt : new Date(0).toISOString();
    out[k] = { hint: clip(u.hint), count: Number.isFinite(u.count) ? u.count : 1, firstAt: typeof u.firstAt === 'string' ? u.firstAt : at, lastAt: at, ...(Number.isFinite(u.aiTriedAt) ? { aiTriedAt: u.aiTriedAt } : {}) };
  }
  return out;
}

// ---------- the classifier: one short question to the active engine's cheapest model ----------

export const CLASSIFY_MARKER = 'OFFICE-ROLE-MAP';
const ROLE_GUIDE =
  'pm (scope, prioritas, issue, rapat, pesan tim), ba (riset, kebutuhan, analisis), architect (tech lead: desain, review, membaca kode, API contract), ' +
  'ui-ux (desain, gambar, ikon, aksesibilitas), frontend (UI web), backend (server, API, integrasi layanan, pembayaran), dba (database, query, migrasi), ' +
  'qa (test, verifikasi, browser otomatis), security (keamanan, rahasia, audit kerentanan), devops (build, deploy, CI, cloud, monitoring, infrastruktur), ' +
  'writer (dokumentasi, konten), mobile (aplikasi HP), data (data, analitik, ML/AI, LLM), support (log, insiden, keluhan user), ' +
  'reviewer (review kode), compliance (privasi, legal, lisensi), freelancer (serba bisa / umum), claude (koordinasi Lead)';

export function classifyPrompt(items) {
  return [
    `${CLASSIFY_MARKER}: petakan setiap nama tool di bawah ke SATU peran tim IT yang paling tepat mengerjakannya.`,
    `Peran: ${ROLE_GUIDE}.`,
    'Awalan: mcp = server MCP, skill = skill agen, agent = tipe subagent, script = file skrip, cmd = program command line.',
    'Jawab HANYA satu objek JSON {"<nama>":"<id peran>"} tanpa penjelasan. Kalau benar-benar tidak tahu, pakai "claude".',
    'Nama:',
    ...items.map(({ key, hint }) => `- ${key}${hint && !key.endsWith(`:${hint}`) ? ` (contoh: ${hint})` : ''}`),
  ].join('\n');
}

/** First JSON object in the model's answer, or null. */
export function parseAnswer(text) {
  const m = /\{[\s\S]*\}/.exec(String(text ?? '').replace(/```(json)?/g, ''));
  if (!m) return null;
  try {
    const raw = JSON.parse(m[0]);
    if (!isObject(raw)) return null;
    const out = {};
    for (const [key, role] of Object.entries(raw)) {
      const k = cleanKey(key);
      if (k && typeof role === 'string') out[k] = role.toLowerCase().trim();
    }
    return out;
  } catch {
    return null;
  }
}

function run(command, args, { cwd, timeout, env }) {
  return new Promise((resolve) => {
    execFileTree(command, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, ...env } }, (err, out, errOut) =>
      resolve({ ok: !err, out: String(out ?? ''), err: String(errOut ?? ''), timedOut: Boolean(err?.killed) }),
    );
  });
}

/**
 * The classifier for the engine in use: Claude Code `-p` on Haiku, or `opencode run` on the user's default model,
 * read-only (no tools that change anything), in an empty folder under data/ so no project is read.
 */
export function engineClassifier({ engine, claude, opencode, dataDir }) {
  return async (items) => {
    const cwd = path.join(dataDir, 'role-ai');
    mkdirSync(cwd, { recursive: true });
    const prompt = classifyPrompt(items);
    let r;
    if (engine() === 'opencode') {
      if (!opencode) throw new Error('OpenCode tidak ditemukan.');
      r = await run(opencode.command, [...opencode.args, 'run', '--agent', 'plan', prompt], { cwd, timeout: 120_000, env: readOnlyOpenCodeEnv(process.env, readUserPermission(cwd)) });
    } else {
      if (!claude) throw new Error('Claude Code tidak ditemukan.');
      r = await run(claude.command, [...claude.args, '-p', prompt, '--model', 'haiku', '--output-format', 'text', '--permission-mode', 'plan', '--strict-mcp-config', '--disallowedTools', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Read', 'Glob', 'Grep', 'Task', 'Agent'], { cwd, timeout: 120_000 });
    }
    if (!r.ok) throw new Error(r.timedOut ? 'AI tidak menjawab dalam 2 menit.' : (r.err || r.out).trim().split('\n').at(-1)?.slice(0, 200) || 'AI gagal.');
    return parseAnswer(r.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  };
}
