// A throw-free snapshot of the tools setup cares about: what is installed, where it came from, what version it
// answers, and (only from cached account data, never a new auth spawn) whether Claude is logged in. `cleanToolView`
// is the only shape that may leave the server: fixed fields, no absolute paths, no stack traces, home as ~.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaude } from '../claude-bin.js';
import { findOpenCode } from '../opencode-bin.js';
import { readRuntimeState, runtimePaths } from './runtime.js';
import { findTailscale, tailscaleIp } from './tailscale.js';

export const TOOL_IDS = Object.freeze(['node', 'npm', 'claude', 'opencode', 'git', 'tailscale', 'winget']);

const LABELS = Object.freeze({
  node: 'Node.js',
  npm: 'npm',
  claude: 'Claude Code',
  opencode: 'OpenCode',
  git: 'Git',
  tailscale: 'Tailscale',
  winget: 'winget',
});

const OPTIONAL = Object.freeze({
  node: false,
  npm: false,
  claude: false,
  opencode: true,
  git: true,
  tailscale: true,
  winget: true,
});

const RUNTIME_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

function item(id, patch = {}) {
  return {
    id,
    label: LABELS[id],
    optional: OPTIONAL[id],
    state: 'missing',
    version: null,
    login: null,
    origin: null,
    ...patch,
  };
}

function runTool(run, command, args, timeout) {
  try {
    const result = run(command, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result && typeof result === 'object' && Number.isInteger(result.status) && result.status !== 0) {
      return { ok: false, error: Object.assign(new Error(`exit ${result.status}`), { code: 'EXIT_NONZERO' }) };
    }
    const text = result && typeof result === 'object' ? String(result.stdout ?? '') : String(result ?? '');
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function failedState(error) {
  if (error?.code === 'ENOENT' || error?.code === 'EACCES' || /not found|tidak ditemukan|command not found/i.test(String(error?.message ?? ''))) {
    return 'missing';
  }
  return 'unknown';
}

/** `v24.11.0` → `24.11.0`, `git version 2.45.1.windows.1` → `2.45.1.windows.1`; null when there is no version token. */
function cleanVersion(value) {
  const match = /v?(\d[\w.+-]*)/i.exec(String(value ?? ''));
  if (!match) return null;
  const token = match[1].replace(/[.+-]+$/, '');
  return token || null;
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function runtimeInfo(runtimeDir) {
  if (typeof runtimeDir !== 'string' || !runtimeDir) return null;
  try {
    const paths = runtimePaths({ runtimeDir });
    const state = readRuntimeState(runtimeDir);
    const current = readText(path.join(paths.nodeRoot, 'current.txt'));
    const stateVersion = state?.node?.version ?? state?.version;
    const version = [current, stateVersion].find((value) => typeof value === 'string' && RUNTIME_VERSION.test(value.trim()));
    if (!version) return null;
    const dir = path.join(paths.nodeRoot, version.trim());
    // The portable runtime is ALWAYS the Windows layout (installNodeRuntime downloads the win-x64 zip on every host).
    const exe = path.join(dir, 'node.exe');
    if (!existsSync(exe)) return null;
    const npmCli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return {
      version: cleanVersion(version),
      exe,
      npmCli: existsSync(npmCli) ? npmCli : null,
    };
  } catch {
    return null;
  }
}

function accountLogin(account) {
  if (account == null) return null;
  try {
    if (typeof account === 'boolean') return account;
    if ('current' in account) return Boolean(account.current);
    if ('loggedIn' in account) return Boolean(account.loggedIn);
    return Boolean(account.id || account.email);
  } catch {
    return null;
  }
}

function inside(pathValue, root) {
  if (typeof pathValue !== 'string' || !pathValue || typeof root !== 'string' || !root) return false;
  try {
    const relative = path.relative(path.resolve(root), path.resolve(pathValue));
    return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function binOrigin(bin, runtimeDir) {
  if (!bin) return null;
  if (inside(bin.command, runtimeDir)) return 'runtime';
  if ((bin.args ?? []).some((arg) => typeof arg === 'string' && path.isAbsolute(arg) && inside(arg, runtimeDir))) return 'runtime';
  return 'system';
}

function probeOpenCodeLogin(bin, run) {
  const result = runTool(run, bin.command, [...bin.args, 'auth', 'list'], 5000);
  if (!result.ok) return null;
  const text = result.text.trim();
  if (!text) return false;
  return !/(?:^|\n)\s*(?:0\s+credentials|no credentials|belum ada|tidak ada)\b/i.test(text);
}

/**
 * @param {object} [options]
 * @param {string} [options.runtimeDir]
 * @param {NodeJS.Platform} [options.platform]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {{ current?: object|null }} [options.account] AccountService or { current }
 * @param {boolean} [options.deep] allow a short `opencode auth list` (default: never spawn auth)
 * @param {typeof execFileSync} [options.run] execFileSync-compatible, used by tests
 */
export function probeTools({ runtimeDir, platform = process.platform, env = process.env, account, deep = false, run = execFileSync } = {}) {
  const root = runtimeDir ?? env?.OFFICE_RUNTIME_DIR ?? null;
  const rt = runtimeInfo(root);
  const login = accountLogin(account);

  const probe = (id, fn) => {
    try {
      return fn();
    } catch (err) {
      return item(id, { state: failedState(err) });
    }
  };

  return [
    probe('node', () => {
      if (rt) return item('node', { state: 'ready', version: rt.version, origin: 'runtime' });
      const result = runTool(run, 'node', ['--version'], 5000);
      if (result.ok) return item('node', { state: 'ready', version: cleanVersion(result.text), origin: 'system' });
      return item('node', { state: failedState(result.error) });
    }),
    probe('npm', () => {
      if (rt?.npmCli) {
        const result = runTool(run, rt.exe, [rt.npmCli, '--version'], 5000);
        if (result.ok) return item('npm', { state: 'ready', version: cleanVersion(result.text), origin: 'runtime' });
      }
      const result = runTool(run, 'npm', ['--version'], 5000);
      if (result.ok) return item('npm', { state: 'ready', version: cleanVersion(result.text), origin: 'system' });
      return item('npm', { state: failedState(result.error) });
    }),
    probe('claude', () => {
      const bin = findClaude();
      if (!bin) return item('claude', { login });
      const origin = binOrigin(bin, root);
      const result = runTool(run, bin.command, [...bin.args, '--version'], 7000);
      if (!result.ok) return item('claude', { state: failedState(result.error), login, origin });
      return item('claude', { state: 'ready', version: cleanVersion(result.text), login, origin });
    }),
    probe('opencode', () => {
      const bin = findOpenCode();
      if (!bin) return item('opencode');
      const origin = binOrigin(bin, root);
      const result = runTool(run, bin.command, [...bin.args, '--version'], 7000);
      const openCodeLogin = deep ? probeOpenCodeLogin(bin, run) : null;
      if (!result.ok) return item('opencode', { state: failedState(result.error), login: openCodeLogin, origin });
      return item('opencode', { state: 'ready', version: cleanVersion(result.text), login: openCodeLogin, origin });
    }),
    probe('git', () => {
      const result = runTool(run, 'git', ['--version'], 5000);
      if (result.ok) return item('git', { state: 'ready', version: cleanVersion(result.text), origin: 'system' });
      return item('git', { state: failedState(result.error) });
    }),
    probe('tailscale', () => {
      const bin = findTailscale({ env, platform, run });
      if (!bin) return item('tailscale');
      const ip = tailscaleIp(bin, { run });
      return item('tailscale', { state: 'ready', login: Boolean(ip), origin: 'system' });
    }),
    probe('winget', () => {
      if (platform !== 'win32') return item('winget');
      const result = runTool(run, 'winget', ['--version'], 5000);
      if (result.ok) return item('winget', { state: 'ready', version: cleanVersion(result.text), origin: 'system' });
      return item('winget', { state: failedState(result.error) });
    }),
  ];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrub(value, home) {
  let text = String(value);
  if (home) {
    for (const variant of new Set([home, home.replaceAll('\\', '/')])) {
      text = text.split(variant).join('~');
      if (process.platform === 'win32') text = text.replace(new RegExp(escapeRegExp(variant), 'gi'), '~');
    }
  }
  text = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s/.test(line))
    .join('\n');
  text = text.replace(/\s+at\s+(?:async\s+)?[^\n()]*\([^)]*\)/g, '');
  text = text.replace(/[A-Za-z]:[\\/][^\s"'<>|]*/g, '~path');
  text = text.replace(/\\\\[^\s"'<>|]+/g, '~path');
  text = text.replace(/(^|[\s("'=])\/(?:[^\s"'<>)]+)/g, '$1~path');
  return text.replace(/\s+/g, ' ').trim();
}

const SAFE_STATES = new Set(['ready', 'missing', 'unknown']);
const SAFE_ORIGINS = new Set(['runtime', 'system']);

/** The UI view: whitelisted fields only, home abbreviated, absolute paths and stack frames removed. */
export function cleanToolView(items) {
  if (!Array.isArray(items)) return [];
  const home = (() => {
    try {
      return os.homedir();
    } catch {
      return '';
    }
  })();
  return items
    .filter((entry) => entry && typeof entry === 'object' && Object.hasOwn(LABELS, entry.id))
    .map((entry) => {
      const id = entry.id;
      return {
        id,
        label: LABELS[id],
        optional: OPTIONAL[id],
        state: SAFE_STATES.has(entry.state) ? entry.state : 'unknown',
        version: typeof entry.version === 'string' ? scrub(entry.version, home) : null,
        login: typeof entry.login === 'boolean' ? entry.login : null,
        origin: SAFE_ORIGINS.has(entry.origin) ? entry.origin : null,
      };
    });
}
