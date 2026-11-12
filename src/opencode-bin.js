// Locates the installed OpenCode binary so it can be spawned without a shell (same idea as claude-bin.js).
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appPaths } from './app-paths.js';
import { execFileTree } from './proc.js';
import { runtimeBinDirs } from './setup/runtime.js';

const WIN = process.platform === 'win32';
const EXE = WIN ? 'opencode.exe' : 'opencode';

/** Folders of the portable setup runtime; read lazily so a PATH install never touches the app's data layout. */
function setupRuntimeDirs() {
  try {
    const runtimeDir =
      process.env.OFFICE_RUNTIME_DIR ||
      appPaths({ appDir: process.env.OFFICE_APP_DIR ?? process.cwd(), env: process.env, platform: process.platform }).runtimeDir;
    return runtimeBinDirs(runtimeDir);
  } catch {
    return [];
  }
}

/** The npm package's real binary in each folder. */
function findPackages(dirs) {
  for (const dir of dirs) {
    const native = path.join(dir, 'node_modules', '@opencode', 'cli', 'bin', EXE);
    if (existsSync(native)) return { command: native, args: [] };
  }
  return null;
}

/** A bare binary in each folder (other installers). */
function findDirect(dirs) {
  for (const dir of dirs) {
    const direct = path.join(dir, EXE);
    if (existsSync(direct)) return { command: direct, args: [] };
  }
  return null;
}

/** @returns {{ command: string, args: string[] } | null} */
export function findOpenCode() {
  const override = process.env.OPENCODE_BIN;
  if (override) return /\.[cm]?js$/.test(override) ? { command: process.execPath, args: [override] } : { command: override, args: [] };
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  // 1. The npm package (`@opencode/cli`): PATH has a shim; the real binary sits in bin/ behind it.
  // 2. A bare binary on PATH (other installers).
  // 3. The app's own portable runtime, after the system PATH (the explicit override above still wins).
  const system = findPackages(dirs) ?? findDirect(dirs);
  if (system) return system;
  const runtimeDirs = setupRuntimeDirs();
  return findPackages(runtimeDirs) ?? findDirect(runtimeDirs);
}

/**
 * `opencode models` → ["provider/model", …] (cached; the list only changes when providers do).
 * @returns {Promise<string[]>}
 */
let modelCache = null;
let variantCache = null; // { at, map: Map<'provider/model', string[]> }
export const EFFORT_ID = /^[a-z][\w-]{0,20}$/;

/**
 * Each model's own effort levels (OpenCode's `model.list` → `variants`, e.g. kimi-k3: [max], gemini: [minimal, low,
 * medium, high]; [] = the model has none). Cached like the model list; an empty or failed read is not cached.
 * @returns {Promise<Map<string, string[]>>}
 */
export async function openCodeModelEfforts(bin, { maxAgeMs = 10 * 60_000 } = {}) {
  if (variantCache && Date.now() - variantCache.at < maxAgeMs) return variantCache.map;
  const { openCodeApi } = await import('./opencode-auth.js');
  const list = await openCodeApi(bin, 'model.list', { timeout: 30_000 }).catch(() => null);
  const map = new Map();
  for (const m of Array.isArray(list) ? list : []) {
    const id = `${m?.providerID}/${m?.modelID ?? m?.id}`;
    if (!/^[\w.@-]+\/\S+$/.test(id)) continue;
    map.set(id, (Array.isArray(m.variants) ? m.variants : []).map((v) => v?.id).filter((v) => typeof v === 'string' && EFFORT_ID.test(v)));
  }
  if (map.size) variantCache = { at: Date.now(), map };
  return map;
}
/**
 * The models running ACP sessions offer (their configOptions "model"): the same list as `opencode models`, a stand-in
 * while that comes back empty (OpenCode's service just started and its catalog is still loading).
 */
export function modelsOffered(sessions) {
  const offered = new Set();
  for (const s of sessions) for (const o of s?.configOptions?.find?.((c) => c.id === 'model')?.options ?? []) if (typeof o?.value === 'string') offered.add(o.value);
  return [...offered].filter((v) => /^[\w.@-]+\/\S+$/.test(v));
}

/** After a provider login/logout the model list changes. */
export function clearModelCache() {
  modelCache = null;
  variantCache = null;
}
export function openCodeModels(bin, { maxAgeMs = 10 * 60_000 } = {}) {
  if (!bin) return Promise.resolve([]);
  if (modelCache && Date.now() - modelCache.at < maxAgeMs) return modelCache.load;
  const load = new Promise((resolve) => {
    execFileTree(bin.command, [...bin.args, 'models'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) {
        modelCache = null; // try again next time
        return resolve([]);
      }
      // The FIRST slash splits provider from model; the model id itself may carry slashes
      // (river/Qwen/Qwen3.5-9B, river/deepseek-ai/DeepSeek-V4.1-Flash — the OpenRouter shape too). The same
      // shape hub.js validates for a stored model (OPENCODE_MODEL).
      const list = [...new Set(String(out).split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:#@/-]{1,120}$/.test(l)))];
      // An empty answer (OpenCode's background service still starting) is not kept: the next ask runs it again.
      if (!list.length && modelCache?.load === load) modelCache = null;
      resolve(list);
    });
  });
  modelCache = { at: Date.now(), load };
  return load;
}

/**
 * 🕘 Riwayat sesi with OpenCode: `opencode session list --format json` run in the project folder (its sessions
 * are per project), in the shape of transcripts.js listSessions. Never throws: [] when OpenCode can't answer.
 * @returns {Promise<{ id: string, title: string, source: 'opencode', updated: number }[]>}
 */
const sessionCache = new Map(); // project folder -> { at, load }: a phone polling the list spawns one process per 15 s
/** After a delete/fork/rename the list must be read again. */
export function clearSessionCache(cwd) {
  sessionCache.delete(cwd);
}
export function openCodeSessions(bin, cwd, limit = 30) {
  if (!bin || !cwd) return Promise.resolve([]);
  const hit = sessionCache.get(cwd);
  if (hit && Date.now() - hit.at < 15_000) return hit.load;
  const load = listOpenCodeSessions(bin, cwd, limit);
  sessionCache.set(cwd, { at: Date.now(), load });
  return load;
}

function listOpenCodeSessions(bin, cwd, limit) {
  return new Promise((resolve) => {
    execFileTree(bin.command, [...bin.args, 'session', 'list', '--format', 'json', '-n', String(limit)], { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      let list;
      try {
        list = JSON.parse(String(out));
      } catch {
        return resolve([]);
      }
      resolve(
        (Array.isArray(list) ? list : [])
          .filter((s) => typeof s?.id === 'string' && /^ses_[\w-]{1,100}$/.test(s.id))
          .map((s) => ({ id: s.id, title: String(s.title ?? '').trim().slice(0, 90) || '(tanpa judul)', source: 'opencode', updated: Number(s.updated ?? s.time?.updated ?? s.created) || 0 })),
      );
    });
  });
}

/** `opencode --version` → "2.0.18" ('' when it does not answer within 15 s). */
export function openCodeVersion(bin) {
  if (!bin) return Promise.resolve('');
  return new Promise((resolve) => {
    execFileTree(bin.command, [...bin.args, '--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }, (err, out) => {
      resolve(err ? '' : (String(out).match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? ''));
    });
  });
}

/** JSON with comments and trailing commas (opencode.jsonc), parsed without a dependency. */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0, inStr = false; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') (inStr = true), (out += c);
    else if (c === '/' && text[i + 1] === '/') while (i < text.length && text[i] !== '\n') i++;
    else if (c === '/' && text[i + 1] === '*') (i = text.indexOf('*/', i + 2)), (i = i < 0 ? text.length : i + 1);
    else out += c;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

// ---------- permission rules (the user's own, merged with the app's mode) ----------

/** OpenCode 2's `permissions` action names → the `permission` tool keys the app writes (others are the same). */
const V2_ACTION = Object.freeze({ __proto__: null, shell: 'bash', subagent: 'task' });
const ACTIONS = new Set(['allow', 'ask', 'deny']);
const isAction = (a) => ACTIONS.has(a);
/** Keys from a user file never name an object's internals (prototype pollution through "__proto__"…). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const safeKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= 500 && !FORBIDDEN_KEYS.has(k);
/** obj[key] only when it is obj's own property (never something inherited from Object.prototype). */
const ownValue = (obj, key) => (obj && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined);

/** Sets tool[pattern] = action as the last rule of that tool (OpenCode: the last matching rule wins). */
function addRule(merged, tool, pattern, action) {
  if (!isAction(action) || !safeKey(tool) || !safeKey(pattern)) return;
  // A later rule for every tool ("*") overrides what came before it for each tool: the global catch-all every
  // earlier rule, a global pattern the same pattern of each tool.
  if (tool === '*') {
    for (const other of Object.keys(merged)) {
      if (other === '*') continue;
      if (pattern === '*') delete merged[other];
      else delete merged[other][pattern];
    }
  }
  const rules = ownValue(merged, tool) ?? Object.create(null);
  if (pattern === '*') for (const key of Object.keys(rules)) delete rules[key]; // a later catch-all overrides them all
  delete rules[pattern];
  rules[pattern] = action;
  merged[tool] = rules;
}

/** One `permission` value (a string for every tool, or { tool: action | { pattern: action } }) into `merged`. */
function addPermission(merged, perm) {
  if (typeof perm === 'string') return addRule(merged, '*', '*', perm);
  if (!perm || typeof perm !== 'object' || Array.isArray(perm)) return;
  for (const [tool, rule] of Object.entries(perm)) {
    if (typeof rule === 'string') addRule(merged, tool, '*', rule);
    else if (rule && typeof rule === 'object' && !Array.isArray(rule)) for (const [pattern, action] of Object.entries(rule)) addRule(merged, tool, pattern, action);
  }
}

/** OpenCode 2's ordered `permissions: [{ action, resource, effect }]` into `merged`. */
function addPermissions(merged, list) {
  for (const rule of Array.isArray(list) ? list : []) {
    if (!rule || typeof rule.action !== 'string') continue;
    const tool = Object.hasOwn(V2_ACTION, rule.action) ? V2_ACTION[rule.action] : rule.action;
    addRule(merged, tool, typeof rule.resource === 'string' ? rule.resource : '*', rule.effect);
  }
}

/** The null-prototype working copy as plain objects (only safe keys ever got in). */
const plainRules = (merged) => Object.fromEntries(Object.entries(merged).map(([tool, rules]) => [tool, Object.fromEntries(Object.entries(rules))]));

/**
 * The user's own OpenCode permission rules (global ~/.config/opencode, then the project's opencode.json and
 * .opencode/), merged per tool in OpenCode's order. Both forms are read: `"permission"` (a string for every tool,
 * or { tool: action | { pattern: action } }) and OpenCode 2's ordered `"permissions": [{ action, resource, effect }]`
 * (action "shell" = bash, "subagent" = task, "*" = every tool). Every tool comes back as { pattern: action } with
 * "*" for "every tool" under the key "*". Read fresh at every spawn (small files); {} when none.
 */
export function readUserPermission(projectPath, home = os.homedir()) {
  const files = [];
  for (const dir of [path.join(home, '.config', 'opencode'), projectPath, projectPath && path.join(projectPath, '.opencode')]) {
    if (!dir) continue;
    for (const name of ['opencode.json', 'opencode.jsonc', 'config.json']) files.push(path.join(dir, name));
  }
  const merged = Object.create(null);
  for (const file of files) {
    let config;
    try {
      config = parseJsonc(readFileSync(file, 'utf8'));
    } catch {
      continue; // missing or not JSON: OpenCode itself reports a broken config
    }
    addPermission(merged, ownValue(config, 'permission'));
    addPermissions(merged, ownValue(config, 'permissions'));
  }
  return plainRules(merged);
}

/** deny > ask > allow: a merge never makes a rule looser than the stricter side. */
const STRICTNESS = { allow: 0, ask: 1, deny: 2 };
const stricter = (a, b) => (STRICTNESS[a] >= STRICTNESS[b] ? a : b);

/** A user rule (string or { pattern: action }) → its catch-all and its patterns in order (safe keys only). */
function splitRule(rule) {
  if (typeof rule === 'string') return { catchAll: rule, patterns: [] };
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return { catchAll: undefined, patterns: [] };
  const patterns = Object.keys(rule).filter((p) => p !== '*' && safeKey(p) && isAction(rule[p])).map((p) => [p, rule[p]]);
  return { catchAll: ownValue(rule, '*'), patterns };
}

/**
 * The app's mode (`base`: tool → action) merged with the user's own rules (readUserPermission). OpenCode layers
 * every config source and the last matching rule wins; the result is the LAST layer (OPENCODE_CONFIG_CONTENT), so
 * whatever is written here overrides the user's files and must never loosen them:
 * - the user's catch-all for a tool is the tool's own "*" (or plain string rule), else the global one (key "*",
 *   from `"permission": "deny"` or a v2 rule with action "*"): a tool rule the user wrote beats their global one;
 * - the written "*" is the stricter of that and the mode (deny > ask > allow): the mode never loosens it;
 * - patterns: the global ones, then the tool's own (they win), after "*"; a pattern deny always stays deny;
 * - mode "auto" turns the user's "ask" into allow (only explicit denies remain, like OpenCode's --auto);
 *   "dontAsk" turns everything that is not deny into deny; "readOnly" (one-shot runs) turns "ask" into deny.
 * @param {Record<string, 'allow'|'ask'|'deny'>} base
 */
export function mergePermission(base, user, mode) {
  const tune = (a) =>
    mode === 'plan' && a !== 'deny' ? 'deny'
    : mode === 'auto' && a === 'ask' ? 'allow'
    : mode === 'dontAsk' && a !== 'deny' ? 'deny'
    : mode === 'readOnly' && a === 'ask' ? 'deny'
    : a;
  const global = splitRule(ownValue(user, '*'));
  const out = {};
  for (const [tool, action] of Object.entries(base)) {
    const mine = splitRule(ownValue(user, tool));
    const userCatchAll = isAction(mine.catchAll) ? mine.catchAll : global.catchAll;
    const catchAll = isAction(userCatchAll) ? stricter(action, tune(userCatchAll)) : action;
    const patterns = {};
    for (const [pattern, a] of [...global.patterns, ...mine.patterns]) {
      delete patterns[pattern]; // the tool's own rule comes last (wins)
      patterns[pattern] = tune(a);
    }
    out[tool] = Object.keys(patterns).length ? { '*': catchAll, ...patterns } : catchAll;
  }
  return out;
}

/**
 * What a one-shot read-only `opencode run --agent plan` may use: reading the project (read, grep, glob, list),
 * nothing else. Written as `"*": "deny"` first: verified with `opencode debug agents` (2.2.5) that this layer comes
 * after the user's files (v1 `permission` and v2 `permissions` alike) and the last matching rule wins, so an MCP
 * tool or shell the user allowed is denied here too. OpenCode's own default asks before reading .env files;
 * nobody can answer in a one-shot run, so those stay closed (ask → deny).
 */
export const READ_ONLY_TOOLS = Object.freeze({ read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' });
const ENV_FILE_RULES = Object.freeze({ '*.env': 'ask', '*.env.*': 'ask', '*.env.example': 'allow' });

/**
 * Env for a one-shot read-only `opencode run` (role classifier, effort classifier): OPENCODE_CONFIG_CONTENT with
 * `{ "*": "deny", read/grep/glob/list }` on top of what that variable already holds (its other settings stay). The
 * user's own rules for the reading tools still apply (a deny stays, see mergePermission). Merged by the caller
 * over process.env, so no other variable is replaced.
 * @param {NodeJS.ProcessEnv} [env] the environment the child inherits
 * @param {object} [user] the user's rules (readUserPermission of the folder the run works in)
 */
export function readOnlyOpenCodeEnv(env = process.env, user = {}) {
  let config = {};
  try {
    const parsed = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
  } catch {
    // not JSON: OpenCode would refuse it anyway; only the lock is passed
  }
  // The variable's own `permission` was the last layer before: it joins the user's rules (OpenCode's .env asks first).
  const rules = Object.create(null);
  for (const [pattern, action] of Object.entries(ENV_FILE_RULES)) addRule(rules, 'read', pattern, action);
  for (const [tool, rule] of Object.entries(user ?? {})) addPermission(rules, { [tool]: rule });
  addPermission(rules, ownValue(config, 'permission'));
  const permission = { '*': 'deny', ...mergePermission(READ_ONLY_TOOLS, plainRules(rules), 'readOnly') };
  return { OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, permission }) };
}

/** The app's own Mode tim file: `data/team/opencode-<hash>.json` (session.js openCodeTeamConfig). */
const TEAM_CONFIG = /[\\/]team[\\/]opencode-[0-9a-f]{16}\.json$/i;

/**
 * The environment for a child `opencode` (the ACP session, or a one-shot `opencode run`). A terminal that itself
 * runs inside OpenCode exports OPENCODE_CONFIG (another project's team file), OPENCODE_SESSION_ID and friends; passed
 * on, they would make "Mode tim off" load that team, attach the child to the wrong session, and confuse its client.
 * A config path the user set themselves is kept: OPENCODE_CONFIG is dropped only when it points at one of our own
 * team files. The caller adds what this child needs on top (OPENCODE_CONFIG_CONTENT, OPENCODE_CONFIG for its team).
 */
export function childOpenCodeEnv(env = process.env) {
  const out = { ...env };
  for (const key of ['OPENCODE', 'OPENCODE_CLIENT', 'OPENCODE_SESSION_ID', 'OPENCODE_TERMINAL']) delete out[key];
  if (TEAM_CONFIG.test(String(out.OPENCODE_CONFIG ?? ''))) delete out.OPENCODE_CONFIG;
  return out;
}
