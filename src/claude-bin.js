// Locates the installed Claude Code binary so it can be spawned without a shell.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appPaths } from './app-paths.js';
import { childEnv } from './child-env.js';
import { runtimeBinDirs } from './setup/runtime.js';

const WIN = process.platform === 'win32';
const EXE = WIN ? 'claude.exe' : 'claude';

/**
 * True when `command --version` answers like Claude Code. A bare `claude.exe` on PATH can be a
 * version-manager shim (e.g. nvm-windows' `.nodejs\claude.exe`) that fails with
 * "CommandNotFound" when spawned from Node — every `auth status` then looks logged out.
 */
function answers(command) {
  try {
    const out = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    return /claude code/i.test(out);
  } catch {
    return false;
  }
}

/**
 * Folders of the portable setup runtime. Read lazily: a machine with Claude Code on PATH must not need the app's
 * data-folder layout at all.
 */
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

/** The npm package (real binary, an older cli.js, or the current cli-wrapper.cjs) in each folder. */
function findPackages(dirs) {
  for (const dir of dirs) {
    const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    const native = path.join(pkg, 'bin', EXE);
    if (existsSync(native)) return { command: native, args: [] };
    const cli = path.join(pkg, 'cli.js');
    if (existsSync(cli)) return { command: process.execPath, args: [cli] };
    // After a self-update while a session holds bin/claude.exe open, the installer leaves only
    // bin/claude.exe.old plus cli-wrapper.cjs. The wrapper still runs the installed CLI.
    const wrapper = path.join(pkg, 'cli-wrapper.cjs');
    if (existsSync(wrapper)) return { command: process.execPath, args: [wrapper] };
  }
  return null;
}

/** A bare binary in each folder, only if it really is Claude Code. */
function findDirect(dirs) {
  for (const dir of dirs) {
    const direct = path.join(dir, EXE);
    if (existsSync(direct) && answers(direct)) return { command: direct, args: [] };
  }
  return null;
}

function findIn(dirs) {
  return findPackages(dirs) ?? findDirect(dirs);
}

/**
 * Install folders a Windows version manager may keep off PATH. A version manager's shim on PATH can build its command
 * string without quoting a path that contains spaces, so the real package behind it is preferred when it can be found.
 */
export function windowsInstallDirs(env = process.env) {
  if (process.platform !== 'win32') return [];
  const dirs = [];
  const homes = [env.NVM_HOME, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'nvm'), env.APPDATA && path.join(env.APPDATA, 'nvm')].filter(Boolean);
  for (const home of homes) {
    const installs = path.join(home, 'installs');
    try {
      for (const version of readdirSync(installs)) dirs.push(path.join(installs, version));
    } catch {
      // this version manager is not present
    }
  }
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
  if (env.ProgramFiles) dirs.push(path.join(env.ProgramFiles, 'nodejs'));
  return dirs;
}

export function findClaude() {
  const override = process.env.CLAUDE_BIN;
  if (override) return /\.[cm]?js$/.test(override) ? { command: process.execPath, args: [override] } : { command: override, args: [] };

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const nativeDirs = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local')];

  // 1. The npm package itself: PATH has a .cmd shim on Windows; use the real binary behind it. Version-manager
  //    install folders are searched too (their shim on PATH is not a usable program).
  // 2. A bare binary (native installer, PATH; then the usual native install folders), if it really is Claude Code.
  // 3. The app's own portable runtime, only after the system PATH (the explicit override above still wins).
  return findPackages([...dirs, ...windowsInstallDirs()]) ?? findDirect([...nativeDirs, ...dirs]) ?? findIn(setupRuntimeDirs());
}
