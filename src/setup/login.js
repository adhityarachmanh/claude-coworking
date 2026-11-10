// Login needs a terminal: Claude and OpenCode both ask questions or open a browser. On Windows setup writes a tiny
// .cmd launcher (the portable npm prefix and Node on PATH) and opens it in its own window, so login can outlive the
// setup process. No user input ever becomes a shell fragment.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TARGETS = Object.freeze({
  claude: { label: 'Claude Code', command: 'claude' },
  opencode: { label: 'OpenCode', command: 'opencode auth login' },
});

function targetInfo(target) {
  if (typeof target !== 'string' || !Object.hasOwn(TARGETS, target)) throw new TypeError(`Target login tidak dikenal: ${target}`);
  return TARGETS[target];
}

/** The command a login terminal runs: only Claude or OpenCode. */
export function loginCommand(target) {
  return targetInfo(target).command;
}

function cmdEscape(value) {
  return String(value).replaceAll('%', '%%');
}

/**
 * Writes <runtime.root>/login/<target>.cmd with the runtime's npm prefix and Node folder prepended to PATH.
 * @returns {string} absolute path of the launcher
 */
export function writeLoginLauncher({ runtime, target, platform = process.platform } = {}) {
  const info = targetInfo(target);
  if (platform !== 'win32') {
    const err = new Error('Launcher login hanya untuk Windows.');
    err.code = 'UNSUPPORTED';
    throw err;
  }
  if (!runtime || typeof runtime !== 'object') throw new TypeError('runtime wajib diisi.');
  if (typeof runtime.root !== 'string' || !runtime.root) throw new TypeError('runtime.root wajib diisi.');
  if (typeof runtime.npmPrefix !== 'string' || !runtime.npmPrefix) throw new TypeError('runtime.npmPrefix wajib diisi.');
  const nodeDir = typeof runtime.nodeDir === 'string' && runtime.nodeDir ? runtime.nodeDir : runtime.node;
  if (typeof nodeDir !== 'string' || !nodeDir) throw new TypeError('runtime.node wajib diisi.');
  const dir = path.join(runtime.root, 'login');
  const file = path.join(dir, `${target}.cmd`);
  const content = [
    '@echo off',
    `set "PATH=${cmdEscape(runtime.npmPrefix)};${cmdEscape(nodeDir)};%PATH%"`,
    `title Adhitron - Login ${info.label}`,
    info.command,
    '',
  ].join('\r\n');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

/**
 * Opens the launcher in a new console window. Returns {ok:false, code:'UNSUPPORTED'} off Windows instead of throwing,
 * because setup simply skips the step there.
 */
export function openLoginTerminal({ runtime, target, platform = process.platform, spawnImpl = spawn } = {}) {
  targetInfo(target);
  if (platform !== 'win32') return { ok: false, code: 'UNSUPPORTED' };
  const launcher = writeLoginLauncher({ runtime, target, platform });
  let child;
  try {
    // One command string: `start "" "<launcher>"` keeps a path with spaces intact through cmd /c parsing.
    child = spawnImpl('cmd.exe', ['/d', '/s', '/c', `start "" "${launcher}"`], {
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
  } catch (err) {
    return { ok: false, code: 'SPAWN_FAILED', error: err.message };
  }
  child?.on?.('error', () => {});
  child?.unref?.();
  return { ok: true, launcher };
}
