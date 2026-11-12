// Installs one npm package into the portable runtime. npm runs through the runtime's own node.exe with a sanitized
// environment and a fixed argv (no shell). The package goes into a staging prefix first; only after npm exits cleanly
// and the package is verifiably there does it replace the real prefix, so a failed install never breaks the working
// Claude/OpenCode binaries.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { SETUP_TARGETS } from './packages.js';
import { runCapturedProcess } from './process.js';
import { cancelledError } from './runtime.js';

const MAX_HINT_CHARS = 4000;

/** npm's entry point inside a Windows Node.js zip: <nodeDir>/node_modules/npm/bin/npm-cli.js. */
export function npmCliPath(nodeDir) {
  if (typeof nodeDir !== 'string' || !nodeDir) throw new TypeError('nodeDir wajib diisi.');
  return path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/** The fixed argv used for `node npm-cli.js install …`; every value is a separate argument, never a shell string. */
export function npmInstallArgs({ npmCli, npmPrefix, npmrc, globalNpmrc, spec }) {
  for (const [name, value] of Object.entries({ npmCli, npmPrefix, npmrc, globalNpmrc, spec })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`${name} wajib diisi.`);
  }
  return [
    npmCli,
    'install',
    '-g',
    '--prefix',
    npmPrefix,
    '--userconfig',
    npmrc,
    '--globalconfig',
    globalNpmrc,
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    '--progress=false',
    spec,
  ];
}

/**
 * A copy of env without inherited Node/npm switches that can redirect npm's modules, loader, cache or config.
 * npm_config_* keys are case-insensitive on Windows, so all spellings are dropped before the portable ones are set.
 */
export function hardenedNpmEnv(env = process.env, { cache } = {}) {
  if (typeof cache !== 'string' || !cache) throw new TypeError('cache wajib diisi.');
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (/^npm_config_/i.test(key)) delete out[key];
    else if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete out[key];
  }
  out.npm_config_cache = cache;
  out.npm_config_update_notifier = 'false';
  out.NO_COLOR = '1';
  return out;
}

function nodeBinary(nodeDir) {
  // The portable runtime is the Windows layout (win-x64 zip) on every host OS: node.exe, always.
  return path.join(nodeDir, 'node.exe');
}

function outputHint(lines) {
  const text = (Array.isArray(lines) ? lines : [])
    .slice(-50)
    .join('\n')
    .trim();
  return text.length > MAX_HINT_CHARS ? text.slice(-MAX_HINT_CHARS) : text;
}

function npmFailed(message, lines, cause) {
  const err = new Error(message);
  err.code = 'NPM_FAILED';
  err.hint = [
    'Periksa koneksi internet, lalu jalankan setup lagi.',
    outputHint(lines),
    cause?.message ? `Detail: ${cause.message}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (cause) err.cause = cause;
  return err;
}

function isCancelled(err) {
  return err?.code === 'CANCELLED' || err?.code === 'ABORT_ERR' || err?.name === 'AbortError';
}

/** `@scope/name@1.2.3` → `@scope/name`; `name@tag` → `name`. */
function bareSpec(spec) {
  const value = String(spec).trim();
  if (value.startsWith('@')) {
    const slash = value.indexOf('/');
    const at = slash < 0 ? -1 : value.indexOf('@', slash);
    return at < 0 ? value : value.slice(0, at);
  }
  const at = value.indexOf('@');
  return at <= 0 ? value : value.slice(0, at);
}

/** The shim npm creates in the prefix root: setup target ids match the real executable names. */
function shimName(spec) {
  const target = Object.values(SETUP_TARGETS).find((entry) => entry.npm === bareSpec(spec));
  if (target) return target.id;
  return bareSpec(spec).split('/').pop() || 'package';
}

function hasFileInBin(packageDir) {
  const binDir = path.join(packageDir, 'bin');
  if (!existsSync(binDir)) return false;
  const stack = [binDir];
  let seen = 0;
  while (stack.length && seen < 5000) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
    seen++;
  }
  return false;
}

/** Minimal proof that npm actually placed the package: a file in its bin/ folder or the prefix shim. */
function verifyInstalled(stage, spec) {
  const bare = bareSpec(spec);
  const parts = bare.split('/');
  const safePackage = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(bare);
  const packageDir = safePackage ? path.join(stage, 'node_modules', ...parts) : null;
  if (packageDir && hasFileInBin(packageDir)) return true;
  return [path.join(stage, `${shimName(spec)}.cmd`), path.join(stage, 'node_modules', '.bin', `${shimName(spec)}.cmd`)].some((file) => existsSync(file));
}

async function swapPrefix({ stage, prefix, oldPrefix, renameImpl, lines }) {
  let oldMoved = false;
  let installed = false;
  try {
    if (existsSync(prefix)) {
      await renameImpl(prefix, oldPrefix);
      oldMoved = true;
    }
    await renameImpl(stage, prefix);
    installed = true;
  } catch (err) {
    try {
      if (installed) await rm(prefix, { recursive: true, force: true });
      if (oldMoved) await renameImpl(oldPrefix, prefix);
    } catch {
      // The original error is more useful; the .old-<rand> prefix below still has the previous install.
    }
    throw npmFailed(`Gagal memasang paket ke ${prefix}: ${err.message}`, lines, err);
  }
  if (oldMoved) await rm(oldPrefix, { recursive: true, force: true }).catch(() => {});
}

/**
 * @param {object} options
 * @param {ReturnType<import('./runtime.js').runtimePaths>} options.runtime
 * @param {string} options.spec npm package name (no version tag is added by setup)
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @param {typeof spawn} [options.spawnImpl]
 * @param {(line: string, source: 'stdout'|'stderr') => void} [options.onLine]
 * @param {typeof rename} [options.renameImpl] test seam for a failed swap
 * @returns {Promise<{ prefix: string, lines: string[] }>}
 */
export async function installNpmPackage({ runtime, spec, signal, timeoutMs = 600_000, spawnImpl = spawn, onLine, renameImpl = rename } = {}) {
  if (!runtime || typeof runtime !== 'object') throw new TypeError('runtime wajib diisi.');
  for (const name of ['tmpDir', 'npmPrefix', 'npmCache', 'npmrc', 'globalNpmrc', 'node']) {
    if (typeof runtime[name] !== 'string' || !runtime[name]) throw new TypeError(`runtime.${name} wajib diisi.`);
  }
  if (typeof spec !== 'string' || !spec.trim()) throw new TypeError('spec wajib diisi.');

  const cleanSpec = spec.trim();
  const suffix = randomBytes(8).toString('hex');
  const stage = path.join(runtime.tmpDir, `npm-stage-${suffix}`);
  const oldPrefix = `${runtime.npmPrefix}.old-${suffix}`;
  let result = null;

  try {
    if (signal?.aborted) throw cancelledError();
    await mkdir(runtime.tmpDir, { recursive: true });
    await mkdir(runtime.npmCache, { recursive: true });
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });

    const args = npmInstallArgs({
      npmCli: npmCliPath(runtime.node),
      npmPrefix: stage,
      npmrc: runtime.npmrc,
      globalNpmrc: runtime.globalNpmrc,
      spec: cleanSpec,
    });
    result = await runCapturedProcess({
      command: nodeBinary(runtime.node),
      args,
      env: hardenedNpmEnv(process.env, { cache: runtime.npmCache }),
      cwd: runtime.tmpDir,
      timeoutMs,
      signal,
      spawnImpl,
      onLine,
    });

    if (result.aborted || signal?.aborted) throw cancelledError();
    if (result.timedOut) throw npmFailed(`npm install ${cleanSpec} melebihi batas waktu ${timeoutMs} ms.`, result.lines);
    if (result.code !== 0) throw npmFailed(`npm install ${cleanSpec} gagal (exit ${result.code ?? result.signal ?? 'tidak diketahui'}).`, result.lines);
    if (signal?.aborted) throw cancelledError();
    if (!verifyInstalled(stage, cleanSpec)) throw npmFailed(`npm selesai, tetapi ${cleanSpec} tidak ditemukan di folder pemasangan.`, result.lines);

    await swapPrefix({ stage, prefix: runtime.npmPrefix, oldPrefix, renameImpl, lines: result.lines });
    return { prefix: runtime.npmPrefix, lines: result.lines };
  } catch (err) {
    if (isCancelled(err) || signal?.aborted) throw cancelledError();
    if (err?.code === 'NPM_FAILED') throw err;
    throw npmFailed(`Tidak bisa menjalankan npm untuk ${cleanSpec}: ${err?.message ?? err}`, result?.lines ?? err?.lines, err);
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}
