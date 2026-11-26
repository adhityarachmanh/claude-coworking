// 🧩 Ekstensi Claude Code without the terminal: plugins (`claude plugin …`), your own subagents (.claude/agents/*.md)
// and a view of the hooks in the settings files. Plugins go through Claude Code's own CLI (it owns their config);
// agents are plain Markdown files with front matter, written only at the two fixed agent folders.
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileTree } from './proc.js';
import { childEnv } from './child-env.js';
import { settingsFile, userConfigDir } from './permissions.js';

export class AdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Runs the claude CLI without a terminal; resolves { ok, out, err } (never rejects on a non-zero exit). */
export function runClaude(bin, args, { cwd, timeout = 120_000 } = {}) {
  if (!bin) return Promise.reject(new AdminError(404, 'Claude Code tidak ditemukan.'));
  return new Promise((resolve) => {
    execFileTree(bin.command, [...bin.args, ...args], { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: childEnv({ CI: '1', NO_COLOR: '1' }) }, (error, out, err) => {
      const strip = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      resolve({ ok: !error, timedOut: Boolean(error?.killed), out: strip(out), err: strip(err) });
    });
  });
}

const firstLine = (r) => `${r.err}\n${r.out}`.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('at ')) ?? 'Gagal.';

// `claude purge` exits 1 with this message when the folder has no Claude Code data (a new project, an OpenCode
// project, or a second purge). That is an empty plan, not a failure.
const NO_DATA = /no claude code project data/i;

/** `claude purge <path> --dry-run`: the deletion plan only, never deletes. Both streams: the warnings live on stderr. */
export async function claudePurgePlan(claude, projectPath) {
  const r = await runClaude(claude, ['purge', projectPath, '--dry-run'], { cwd: os.homedir(), timeout: 60_000 });
  const text = [r.out, r.err].filter(Boolean).join('\n').trim();
  if (!r.ok && !NO_DATA.test(text)) throw new AdminError(400, `Rencana purge gagal: ${firstLine(r)}`);
  return { output: r.ok ? text : '' };
}

/** `claude purge <path> --yes`: deletes Claude Code's local state for one project (never the project folder). */
export async function claudePurgeProject(claude, projectPath) {
  const r = await runClaude(claude, ['purge', projectPath, '--yes'], { cwd: os.homedir(), timeout: 120_000 });
  const text = [r.out, r.err].filter(Boolean).join('\n').trim();
  if (!r.ok && !NO_DATA.test(text)) throw new AdminError(400, `Purge gagal: ${firstLine(r)}`);
  return { output: r.ok ? text : '' };
}

// ---------- plugins ----------

// First character a letter or digit: the id is a CLI argument and must never read as an option ("--x").
const PLUGIN_ID = /^[A-Za-z0-9][\w.@/-]{0,199}$/;
let pluginCache = null; // { at, data } — the marketplace list is large (thousands) and changes rarely

/** Installed plugins + the marketplace catalog (cached 5 min; any change clears it). */
export async function listPlugins(bin, { force = false } = {}) {
  if (!force && pluginCache && Date.now() - pluginCache.at < 5 * 60_000) return pluginCache.data;
  const r = await runClaude(bin, ['plugin', 'list', '--json', '--available'], { timeout: 120_000 });
  if (!r.ok) throw new AdminError(502, firstLine(r));
  let parsed;
  try {
    parsed = JSON.parse(r.out);
  } catch {
    throw new AdminError(502, 'Daftar plugin tidak terbaca.');
  }
  const installed = (parsed.installed ?? []).map((p) => ({ id: p.id, version: p.version ?? '', scope: p.scope ?? '', enabled: p.enabled !== false, hasUserConfig: p.hasUserConfig === true }));
  const have = new Set(installed.map((p) => p.id));
  const available = (parsed.available ?? [])
    .filter((p) => p?.pluginId && !have.has(p.pluginId))
    .map((p) => ({ id: p.pluginId, name: p.name ?? p.pluginId, description: String(p.description ?? '').slice(0, 300), installs: p.installCount ?? p.installs ?? null }));
  pluginCache = { at: Date.now(), data: { installed, available } };
  return pluginCache.data;
}

/**
 * install | uninstall | enable | disable | update. An install whose marketplace declares a command to run is not
 * accepted blindly: the command comes back (needsConfirm) and only runs after the user saw it (acceptCommand = its sha256).
 */
export async function pluginAction(bin, { action, id, scope = 'user', acceptCommand = null, cwd }) {
  if (!['install', 'uninstall', 'enable', 'disable', 'update'].includes(action)) throw new AdminError(400, 'Aksi plugin tidak dikenal.');
  if (!PLUGIN_ID.test(String(id ?? ''))) throw new AdminError(400, 'Id plugin tidak valid.');
  const args = ['plugin', action, id, '--json'];
  if (action === 'install') {
    args.push('-s', ['user', 'project', 'local'].includes(scope) ? scope : 'user');
    if (acceptCommand) {
      if (!/^[0-9a-f]{64}$/i.test(acceptCommand)) throw new AdminError(400, 'Konfirmasi perintah tidak valid.');
      args.push('--accept-command', acceptCommand);
    }
  }
  const r = await runClaude(bin, args, { cwd, timeout: 300_000 });
  pluginCache = null;
  let result = null;
  try {
    result = JSON.parse(r.out.trim().split('\n').at(-1));
  } catch {
    // older CLI: plain text
  }
  const shown = result?.shownCommand;
  if (!r.ok && shown?.sha256) return { ok: false, needsConfirm: true, command: String(shown.command ?? shown.display ?? '').slice(0, 2000), sha256: shown.sha256 };
  if (!r.ok) throw new AdminError(502, result?.error ?? result?.message ?? firstLine(r));
  return { ok: true, message: result?.message ?? firstLine({ out: r.out, err: '' }) };
}

// ---------- marketplaces (`claude plugin marketplace …`) ----------

const MP_NAME = /^[\w.-]{1,200}$/;
const MP_SOURCE = /^[^\s\x00-\x1f]{1,500}$/; // a URL, a path or owner/repo; never an option

/** 🏪 Configured marketplaces, as `claude plugin marketplace list --json` reports them. */
export async function listMarketplaces(bin) {
  const r = await runClaude(bin, ['plugin', 'marketplace', 'list', '--json'], { timeout: 60_000 });
  if (!r.ok) throw new AdminError(502, firstLine(r));
  let parsed;
  try {
    parsed = JSON.parse(r.out.trim());
  } catch {
    throw new AdminError(502, 'Daftar marketplace tidak terbaca.');
  }
  return (Array.isArray(parsed) ? parsed : []).slice(0, 100).map((m) => ({
    name: String(m.name ?? '').slice(0, 200),
    source: String(m.source ?? '').slice(0, 60),
    repo: String(m.repo ?? '').slice(0, 300),
  }));
}

/** ℹ `claude plugin details`: the component inventory and projected token cost, as text (no JSON in 2.1.331). */
export async function pluginDetails(bin, id) {
  if (!PLUGIN_ID.test(String(id ?? ''))) throw new AdminError(400, 'Id plugin tidak valid.');
  const r = await runClaude(bin, ['plugin', 'details', String(id)], { timeout: 60_000 });
  if (!r.ok) throw new AdminError(502, firstLine(r));
  return { text: r.out.trimEnd().slice(-20_000) };
}

const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 80)).slice(0, 50) : []);

/** The `plugin configure --json` answer: schema/choices/inputs plus which options are set (never a sensitive value). */
function cleanConfigure(parsed) {
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const inputs = {};
  for (const [k, v] of Object.entries(obj(parsed?.inputs)).slice(0, 50)) if (typeof v === 'string') inputs[String(k).slice(0, 80)] = v.slice(0, 2000);
  return { schema: obj(parsed?.schema), choices: obj(parsed?.choices), inputs, configured: names(parsed?.configured), unconfigured: names(parsed?.unconfigured) };
}

/**
 * ⚙ `claude plugin configure`: without values, the declared options (JSON); with values, saves them through stdin so
 * a secret never becomes an argument. Only single-line strings, bounded, as the CLI itself requires.
 */
export async function pluginConfigure(bin, { id, values = null } = {}) {
  if (!PLUGIN_ID.test(String(id ?? ''))) throw new AdminError(400, 'Id plugin tidak valid.');
  if (values == null) {
    const r = await runClaude(bin, ['plugin', 'configure', String(id), '--json'], { timeout: 30_000 });
    if (!r.ok) throw new AdminError(502, firstLine(r));
    let parsed;
    try {
      parsed = JSON.parse(r.out.trim().split('\n').filter(Boolean).at(-1));
    } catch {
      throw new AdminError(502, 'Opsi plugin tidak terbaca.');
    }
    return cleanConfigure(parsed);
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new AdminError(400, 'Nilai opsi tidak valid.');
  const clean = {};
  for (const [key, value] of Object.entries(values).slice(0, 50)) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) throw new AdminError(400, 'Nama opsi tidak valid.');
    const text = String(value ?? '');
    if (text.length > 2000 || /[\r\n]/.test(text)) throw new AdminError(400, 'Nilai opsi harus satu baris, maksimal 2000 karakter.');
    clean[key] = text;
  }
  const r = await new Promise((resolve) => {
    execFileTree(
      bin.command,
      [...bin.args, 'plugin', 'configure', String(id), '--values-stdin', '--json'],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: childEnv({ CI: '1', NO_COLOR: '1' }), input: JSON.stringify(clean) },
      (err, out, errOut) => resolve({ ok: !err, out: String(out ?? ''), err: String(errOut ?? '') }),
    );
  });
  let result = null;
  try {
    result = JSON.parse(r.out.trim().split('\n').filter(Boolean).at(-1));
  } catch {
    // older CLI: plain text
  }
  if (!r.ok) throw new AdminError(502, firstLine({ out: r.out, err: r.err }));
  pluginCache = null;
  return { ok: true, saved: names(result?.saved), unconfigured: names(result?.unconfigured) };
}

/** 🖥 `claude daemon status`: text plus whether the supervisor is running (it exits 1 while stopped). */
export async function daemonStatus(bin) {
  const r = await runClaude(bin, ['daemon', 'status'], { timeout: 15_000 });
  const text = `${r.out}\n${r.err}`.trim().slice(0, 4000);
  return { running: r.ok && !/not running/i.test(text), text };
}

/** 🧹 `claude plugin prune`: orphaned auto-installed dependencies, previewed first and removed with `-y`. */
export async function pluginPrune(bin, { confirm = false } = {}) {
  const r = await runClaude(bin, ['plugin', 'prune', ...(confirm ? ['-y'] : ['--dry-run'])], { timeout: 120_000 });
  if (!r.ok) throw new AdminError(502, firstLine(r));
  const text = `${r.out}\n${r.err}`.trim();
  if (confirm) pluginCache = null;
  return { ok: true, confirmed: confirm, text: text.slice(-4000) };
}

/** add (a URL/path/owner-repo) | remove (a configured name) | update (one name, or every marketplace). */
export async function marketplaceAction(bin, { action, source = '', name = '' }) {
  if (!['add', 'remove', 'update'].includes(action)) throw new AdminError(400, 'Aksi marketplace tidak dikenal.');
  const args = ['plugin', 'marketplace', action];
  if (action === 'add') {
    const src = String(source ?? '').trim();
    if (!MP_SOURCE.test(src) || src.startsWith('-')) throw new AdminError(400, 'Sumber marketplace tidak valid.');
    args.push(src);
  } else if (action === 'remove') {
    if (!MP_NAME.test(String(name ?? ''))) throw new AdminError(400, 'Nama marketplace tidak valid.');
    args.push(String(name));
  } else if (name) {
    if (!MP_NAME.test(String(name ?? ''))) throw new AdminError(400, 'Nama marketplace tidak valid.');
    args.push(String(name));
  }
  // `marketplace update` without a name prints no JSON line, so --json is only added when a name is given.
  if (action !== 'update' || name) args.push('--json');
  const r = await runClaude(bin, args, { timeout: 300_000 });
  pluginCache = null;
  let result = null;
  try {
    result = JSON.parse(r.out.trim().split('\n').at(-1));
  } catch {
    // older CLI or update-all: plain text
  }
  if (!r.ok) throw new AdminError(502, result?.error ?? result?.message ?? firstLine(r));
  return { ok: true, message: result?.message ?? firstLine({ out: r.out, err: '' }), marketplaces: await listMarketplaces(bin) };
}

// ---------- 🖥 Claude background sessions (`claude agents --json`, agent view) ----------

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,79}$/; // the short id used by attach/logs/stop/respawn/rm; never an option
const AGENT_REF = /^[A-Za-z0-9][\w .-]{0,119}$/; // an id or part of a name; never an option
const AGENT_STATES = new Set(['working', 'blocked', 'done', 'failed', 'stopped']);
const AGENT_STATUS = new Set(['busy', 'waiting', 'idle']);

/** One entry of `claude agents --json`, sanitized: a newer CLI cannot leak huge/odd fields into the page. */
function cleanBackgroundAgent(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    id: typeof a.id === 'string' && AGENT_ID.test(a.id) ? a.id : null,
    name: typeof a.name === 'string' ? a.name.slice(0, 120) : '',
    kind: a.kind === 'interactive' ? 'interactive' : 'background',
    state: AGENT_STATES.has(a.state) ? a.state : null,
    status: AGENT_STATUS.has(a.status) ? a.status : null,
    waitingFor: typeof a.waitingFor === 'string' ? a.waitingFor.slice(0, 80) : null,
    cwd: typeof a.cwd === 'string' ? a.cwd.slice(0, 500) : '',
    startedAt: Number.isFinite(a.startedAt) ? a.startedAt : null,
    sessionId: typeof a.sessionId === 'string' ? a.sessionId.slice(0, 80) : null,
    pid: Number.isInteger(a.pid) ? a.pid : null,
  };
}

/**
 * The sessions Claude Code's supervisor knows: live ones (interactive + background) and, with `all`, finished
 * background sessions too. `cwd` scopes the list to sessions started under a project (the CLI is project-aware).
 */
export async function listBackgroundAgents(bin, { all = true, cwd = null } = {}) {
  const args = ['agents', '--json', ...(all ? ['--all'] : [])];
  if (cwd) args.push('--cwd', cwd);
  const r = await runClaude(bin, args, { timeout: 30_000 });
  if (!r.ok) throw new AdminError(502, firstLine(r));
  let parsed;
  try {
    parsed = JSON.parse(r.out.trim() || '[]');
  } catch {
    throw new AdminError(502, 'Daftar sesi latar tidak terbaca.');
  }
  return (Array.isArray(parsed) ? parsed : []).map(cleanBackgroundAgent).filter(Boolean).slice(0, 100);
}

/** stop | respawn | rm for one background session id. `attach` is terminal-only and is never offered here. */
export async function backgroundAgentAction(bin, { action, id }) {
  if (!['stop', 'respawn', 'rm'].includes(action)) throw new AdminError(400, 'Aksi sesi latar tidak dikenal.');
  if (!AGENT_ID.test(String(id ?? ''))) throw new AdminError(400, 'Id sesi tidak valid.');
  const r = await runClaude(bin, [action, String(id)], { timeout: action === 'respawn' ? 90_000 : 30_000 });
  if (!r.ok) throw new AdminError(502, firstLine(r));
  return { ok: true, message: firstLine({ out: r.out, err: '' }) };
}

/** Start a new background session (`claude --bg`), optionally named; it runs in the project folder. */
export async function startBackgroundAgent(bin, { prompt, name = '', cwd } = {}) {
  const text = String(prompt ?? '').trim();
  if (!text) throw new AdminError(400, 'Prompt sesi latar masih kosong.');
  if (text.length > 4000) throw new AdminError(400, 'Prompt sesi latar maksimal 4000 karakter.');
  const args = ['--bg'];
  const label = String(name ?? '').trim();
  if (label) {
    if (!/^[A-Za-z0-9][\w .-]{0,59}$/.test(label)) throw new AdminError(400, 'Nama sesi: huruf, angka, spasi, titik atau minus (maks 60).');
    args.push('--name', label);
  }
  args.push(text);
  const r = await runClaude(bin, args, { cwd, timeout: 30_000 });
  if (!r.ok) throw new AdminError(502, firstLine(r));
  return { ok: true, output: `${r.out}\n${r.err}`.trim().slice(-2000) };
}

/** `claude logs <id|name>`: the most recent output, bounded before it reaches the browser. */
export async function backgroundAgentLogs(bin, ref) {
  if (!AGENT_REF.test(String(ref ?? ''))) throw new AdminError(400, 'Sesi tidak valid.');
  const r = await runClaude(bin, ['logs', String(ref)], { timeout: 30_000 });
  if (!r.ok) throw new AdminError(502, firstLine(r));
  return { text: r.out.trimEnd().slice(-20_000) };
}

/** 📜 The tail of the supervisor log (`~/.claude/daemon.log`), for diagnosing agent view without a terminal. */
export function backgroundDaemonLog({ lines = 200 } = {}) {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    const text = readFileSync(path.join(dir, 'daemon.log'), 'utf8');
    const tail = text.split('\n').slice(-Math.max(1, Math.min(2000, Number(lines) || 200))).join('\n');
    return { exists: true, text: tail.slice(-20_000) };
  } catch {
    return { exists: false, text: '' };
  }
}

// ---------- your own subagents (.claude/agents/*.md) ----------

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,49}$/;

const agentDir = (scope, projectPath, home = os.homedir()) => (scope === 'user' ? path.join(home, '.claude', 'agents') : path.join(projectPath, '.claude', 'agents'));

/** "---\nname: x\ndescription: y\n---\nprompt" → { meta, prompt } (simple key: value front matter). */
export function parseAgent(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!m) return { meta: {}, prompt: String(text) };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, prompt: m[2] };
}

const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

/** The agents of a project (scope project) and the user's (scope user). */
export function listAgents(projectPath, home) {
  const out = [];
  for (const scope of ['project', 'user']) {
    const dir = agentDir(scope, projectPath, home);
    let names = [];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of names) {
      try {
        const file = path.join(dir, f);
        if (statSync(file).size > 256 * 1024) continue;
        const { meta, prompt } = parseAgent(readFileSync(file, 'utf8'));
        out.push({ scope, file: f, name: meta.name || f.slice(0, -3), description: meta.description ?? '', tools: meta.tools ?? '', model: meta.model ?? '', prompt });
      } catch {
        // unreadable: skipped
      }
    }
  }
  return out;
}

/** Creates or replaces <dir>/<name>.md. Renaming removes the old file (same scope). */
export function saveAgent(projectPath, { scope, name, previous, description, tools = '', model = '', prompt }, home) {
  const sc = scope === 'user' ? 'user' : 'project';
  if (!AGENT_NAME.test(String(name ?? ''))) throw new AdminError(400, 'Nama agent: huruf kecil, angka dan minus (maks 50), mis. code-reviewer.');
  if (!oneLine(description)) throw new AdminError(400, 'Deskripsi wajib: Claude memakainya untuk memilih kapan agent ini dipanggil.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new AdminError(400, 'Instruksi (system prompt) agent kosong.');
  if (Buffer.byteLength(prompt) > 200 * 1024) throw new AdminError(413, 'Instruksi terlalu panjang.');
  if (tools && !/^[\w*(),.: -]{1,500}$/.test(tools)) throw new AdminError(400, 'Daftar tools: nama dipisah koma, mis. Read, Grep, Glob.');
  if (model && !/^[\w.[\]-]{1,60}$/.test(model)) throw new AdminError(400, 'Model tidak valid.');
  const dir = agentDir(sc, projectPath, home);
  mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${name}`, `description: ${oneLine(description)}`, ...(tools ? [`tools: ${oneLine(tools)}`] : []), ...(model ? [`model: ${model}`] : []), '---', '', prompt.trim(), ''];
  const file = path.join(dir, `${name}.md`);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, lines.join('\n'), 'utf8');
  renameSync(tmp, file);
  if (previous && previous !== name && AGENT_NAME.test(previous)) rmSync(path.join(dir, `${previous}.md`), { force: true });
  return { scope: sc, name };
}

export function deleteAgent(projectPath, { scope, name }, home) {
  if (!AGENT_NAME.test(String(name ?? ''))) throw new AdminError(400, 'Nama agent tidak valid.');
  rmSync(path.join(agentDir(scope === 'user' ? 'user' : 'project', projectPath, home), `${name}.md`), { force: true });
  return { ok: true };
}

// ---------- hooks (view + edit) ----------

/** Hook events Claude Code recognizes (one source for the server and the editor). */
export const HOOK_EVENTS = Object.freeze([
  'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PermissionRequest',
  'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay',
  'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'Stop', 'StopFailure',
  'InstructionsLoaded', 'ConfigChange', 'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate',
  'WorktreeRemove', 'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'Elicitation',
  'ElicitationResult', 'SessionEnd',
]);

export const HOOK_LIMITS = Object.freeze({ command: 2000, matcher: 200, timeout: 3600, hooks: 100, bytes: 1024 * 1024 });

export class HookError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MATCHER = /^[\x20-\x7e]{0,200}$/;
const validHookEvent = (event) => HOOK_EVENTS.includes(String(event ?? ''));

/** The hooks configured in each settings file: [{ scope, source, file, event, matcher, handlers }]. */
export function listHooks(projectPath, userDir = userConfigDir()) {
  const files = [
    ['user', 'Semua project (~/.claude/settings.json)', path.join(userDir, 'settings.json')],
    ['project', 'Project (.claude/settings.json)', path.join(projectPath, '.claude', 'settings.json')],
    ['local', 'Project, pribadi (.claude/settings.local.json)', path.join(projectPath, '.claude', 'settings.local.json')],
  ];
  const out = [];
  for (const [scope, source, file] of files) {
    let hooks;
    try {
      const info = lstatSync(file);
      if (info.isSymbolicLink() || info.size > HOOK_LIMITS.bytes) continue;
      hooks = JSON.parse(readFileSync(file, 'utf8')).hooks;
    } catch {
      continue;
    }
    if (!hooks || typeof hooks !== 'object') continue;
    for (const [event, groups] of Object.entries(hooks)) {
      for (const g of Array.isArray(groups) ? groups : []) {
        const handlers = (Array.isArray(g?.hooks) ? g.hooks : []).map((h) => {
          if (h?.type === 'command') return { type: 'command', command: String(h.command ?? ''), timeout: Number.isInteger(h.timeout) ? h.timeout : undefined };
          return { type: String(h?.type ?? '?'), label: `${h?.type ?? '?'}${h?.url ? ` ${h.url}` : ''}` };
        });
        out.push({ scope, source, file, event, matcher: String(g?.matcher ?? ''), handlers });
      }
    }
  }
  return out;
}

const loadHooksFile = (file) => {
  let text;
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink()) throw new HookError(409, `${path.basename(file)} berupa symlink; ubah langsung di file aslinya.`);
    if (info.size > HOOK_LIMITS.bytes) throw new HookError(409, `${path.basename(file)} terlalu besar (> 1 MB).`);
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof HookError) throw err;
    if (err.code === 'ENOENT') return { exists: false, data: {}, indent: 2 };
    throw new HookError(500, `Tidak bisa membaca ${path.basename(file)}: ${err.code ?? err.message}`);
  }
  let data;
  try {
    data = text.trim() ? JSON.parse(text.replace(/^\uFEFF/, '')) : {};
  } catch (err) {
    throw new HookError(409, `${path.basename(file)} bukan JSON yang valid (${err.message}). Perbaiki file itu dulu; Adhitron tidak akan menimpanya.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HookError(409, `${path.basename(file)} harus berisi objek JSON ({ … }).`);
  return { exists: true, data, indent: text.match(/^[{[]\r?\n([ \t]+)/)?.[1] ?? 2 };
};

const writeSettingsFile = (file, data, indent) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.settings-${Date.now().toString(36)}.tmp`);
  writeFileSync(temp, `${JSON.stringify(data, null, indent)}\n`);
  // Windows: an editor (or Claude itself) may hold settings.json open for a moment; retry the replace briefly.
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      renameSync(temp, file);
      return;
    } catch (err) {
      lastError = err;
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
  try {
    unlinkSync(temp);
  } catch {
    // already gone
  }
  throw new HookError(500, `Tidak bisa menyimpan ${path.basename(file)}: ${lastError?.code ?? lastError?.message ?? 'unknown'}`);
};

/**
 * Adds or replaces one command hook: `hooks[event]` is a list of groups; a group is
 * `{ matcher?, hooks: [{ type: "command", command, timeout? }] }`. Everything else in the file is preserved.
 */
export function saveHook({ projectPath, userDir = userConfigDir(), scope, event, matcher, command, timeout }) {
  if (!validHookEvent(event)) throw new HookError(400, 'Event hook tidak dikenal.');
  if (matcher !== undefined && matcher !== null && matcher !== '' && !MATCHER.test(String(matcher))) {
    throw new HookError(400, 'Matcher hook tidak valid (maks 200 karakter, tanpa baris baru).');
  }
  const commandText = String(command ?? '').trim();
  if (!commandText) throw new HookError(400, 'Perintah hook tidak boleh kosong.');
  if (commandText.length > HOOK_LIMITS.command) throw new HookError(400, `Perintah hook maksimal ${HOOK_LIMITS.command} karakter.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(commandText)) throw new HookError(400, 'Perintah hook tidak boleh memuat karakter kontrol.');
  const parsedTimeout = timeout === undefined || timeout === null || timeout === '' ? undefined : Number(timeout);
  if (parsedTimeout !== undefined && (!Number.isInteger(parsedTimeout) || parsedTimeout < 0 || parsedTimeout > HOOK_LIMITS.timeout)) {
    throw new HookError(400, `Timeout hook harus bilangan bulat 0–${HOOK_LIMITS.timeout} detik.`);
  }
  const file = settingsFile(projectPath, scope, userDir);
  const { data, indent } = loadHooksFile(file);
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) data.hooks = {};
  if (data.hooks[event] !== undefined && !Array.isArray(data.hooks[event])) {
    throw new HookError(400, `Bagian hooks.${event} bukan array. Perbaiki lewat editor JSON dulu.`);
  }
  const matcherText = matcher ? String(matcher) : '';
  const hook = { type: 'command', command: commandText, ...(parsedTimeout !== undefined ? { timeout: parsedTimeout } : {}) };
  const groups = data.hooks[event] ?? [];
  const groupIndex = groups.findIndex((g) => g && typeof g === 'object' && String(g.matcher ?? '') === matcherText);
  if (groupIndex === -1) {
    data.hooks[event] = groups;
    if (groups.length >= HOOK_LIMITS.hooks) throw new HookError(400, `Maksimal ${HOOK_LIMITS.hooks} hook per event.`);
    groups.push({ ...(matcherText ? { matcher: matcherText } : {}), hooks: [hook] });
  } else {
    const group = groups[groupIndex];
    const handlers = Array.isArray(group.hooks) ? group.hooks : [];
    // Only the matching command handler is replaced: other commands and non-command handlers in the same group stay.
    const at = handlers.findIndex((h) => h?.type === 'command' && String(h.command ?? '').trim() === commandText);
    if (at === -1) handlers.push(hook);
    else {
      const kept = handlers[at];
      handlers[at] = { ...kept, type: 'command', command: commandText };
      if (parsedTimeout !== undefined) handlers[at].timeout = parsedTimeout;
      else delete handlers[at].timeout;
    }
    group.hooks = handlers;
  }
  writeSettingsFile(file, data, indent);
  return { hook: { event, matcher: matcherText || undefined, command: commandText, timeout: parsedTimeout } };
}

/** Removes one command hook; a group with no command hooks left is dropped, and an empty event key is dropped too. */
export function deleteHook({ projectPath, userDir = userConfigDir(), scope, event, matcher, command }) {
  if (!validHookEvent(event)) throw new HookError(400, 'Event hook tidak dikenal.');
  const commandText = String(command ?? '').trim();
  const file = settingsFile(projectPath, scope, userDir);
  const { data, indent } = loadHooksFile(file);
  const groups = Array.isArray(data.hooks?.[event]) ? data.hooks[event] : null;
  if (!groups) throw new HookError(404, 'Hook tidak ditemukan.');
  const matcherText = matcher ? String(matcher) : '';
  let removed = false;
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    if (String(group.matcher ?? '') !== matcherText) continue;
    const handlers = Array.isArray(group.hooks) ? group.hooks : [];
    const before = handlers.length;
    group.hooks = handlers.filter((h) => !(h?.type === 'command' && String(h.command ?? '').trim() === commandText));
    if (group.hooks.length !== before) removed = true;
  }
  data.hooks[event] = groups.filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length);
  if (!data.hooks[event].length) delete data.hooks[event];
  if (!Object.keys(data.hooks).length) delete data.hooks;
  if (!removed) throw new HookError(404, 'Hook tidak ditemukan.');
  writeSettingsFile(file, data, indent);
  return { removed: true };
}

// ---------- auto mode (user settings only) ----------

const AUTO_MODE_LISTS = { environment: 'environment', allow: 'allow', softDeny: 'soft_deny', hardDeny: 'hard_deny' };
const AUTO_MODE_LIMITS = { entries: 100, entry: 500 };

const autoModeFile = (userDir = userConfigDir()) => path.join(userDir, 'settings.json');

/** The `autoMode` block Claude's classifier reads (user settings only, per its docs). */
export function readAutoMode(userDir = userConfigDir()) {
  const file = autoModeFile(userDir);
  let data;
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink()) throw new HookError(409, 'settings.json berupa symlink; ubah langsung di file aslinya.');
    if (info.size > HOOK_LIMITS.bytes) throw new HookError(409, 'settings.json terlalu besar (> 1 MB).');
    data = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err instanceof HookError) throw err;
    if (err.code === 'ENOENT') return { environment: [], allow: [], softDeny: [], hardDeny: [], classifyAllShell: false };
    if (err instanceof SyntaxError) throw new HookError(409, `settings.json bukan JSON yang valid (${err.message}).`);
    throw new HookError(500, `Tidak bisa membaca settings.json: ${err.code ?? err.message}`);
  }
  const block = data && typeof data.autoMode === 'object' && !Array.isArray(data.autoMode) ? data.autoMode : {};
  const list = (key) => (Array.isArray(block[key]) ? block[key].filter((item) => typeof item === 'string') : []);
  return {
    environment: list('environment'),
    allow: list('allow'),
    softDeny: list('soft_deny'),
    hardDeny: list('hard_deny'),
    classifyAllShell: block.classifyAllShell === true,
  };
}

/** Saves the classifier rules to `~/.claude/settings.json`, preserving every other key. Laptop only at the route. */
export function saveAutoMode({ userDir = userConfigDir(), environment, allow, softDeny, hardDeny, classifyAllShell }) {
  const file = autoModeFile(userDir);
  const cleanList = (items, field) => {
    if (items === undefined) return undefined;
    if (!Array.isArray(items)) throw new HookError(400, `Daftar ${field} tidak valid.`);
    const out = [];
    for (const item of items) {
      if (typeof item !== 'string') throw new HookError(400, `Setiap entri ${field} harus berupa teks.`);
      const text = item.trim();
      if (!text) continue;
      if (text.length > AUTO_MODE_LIMITS.entry) throw new HookError(400, `Satu entri ${field} maksimal ${AUTO_MODE_LIMITS.entry} karakter.`);
      if (/[\u0000-\u001f\u007f]/.test(text)) throw new HookError(400, `Entri ${field} tidak boleh memuat karakter kontrol.`);
      out.push(text);
    }
    if (out.length > AUTO_MODE_LIMITS.entries) throw new HookError(400, `Maksimal ${AUTO_MODE_LIMITS.entries} entri ${field}.`);
    return out;
  };
  const nextLists = {};
  for (const [field, key] of Object.entries(AUTO_MODE_LISTS)) {
    const cleaned = cleanList(field === 'environment' ? environment : field === 'allow' ? allow : field === 'softDeny' ? softDeny : hardDeny, field);
    if (cleaned !== undefined) nextLists[key] = cleaned;
  }
  const { data, indent } = loadHooksFile(file);
  const block = data.autoMode && typeof data.autoMode === 'object' && !Array.isArray(data.autoMode) ? data.autoMode : {};
  for (const [key, value] of Object.entries(nextLists)) {
    if (value.length) block[key] = value;
    else delete block[key];
  }
  if (classifyAllShell === true) block.classifyAllShell = true;
  else if (classifyAllShell === false) delete block.classifyAllShell;
  if (Object.keys(block).length) data.autoMode = block;
  else delete data.autoMode;
  writeSettingsFile(file, data, indent);
  return readAutoMode(userDir);
}
