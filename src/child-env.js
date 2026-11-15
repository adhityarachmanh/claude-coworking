// The environment handed to the CLIs Adhitron spawns (Claude Code, OpenCode, the `claude` admin commands).
//
// Why this exists: a child inherits PATH from the server, and on Windows that PATH routinely carries
// nvm-windows' `.nodejs` — a directory JUNCTION (reparse point). libuv cannot reliably `lstat` a path that
// lives *inside* a reparse point: when the junction is stale, or its target is being swapped (right after an
// nvm/node install, which is exactly what an in-app update does), every probe fails with
// `EUNKNOWN: unknown error, lstat '...\nvm\.nodejs\pwsh.exe'` (errno -4094) and Claude Code answers the first
// prompt with "■ Berhenti: Internal error".
//
// So children get a cleaned PATH: a junction is replaced by the real folder it points at, an entry that cannot
// be resolved is dropped, duplicates are removed, and the folder of the running node.exe comes first. On other
// platforms the environment is passed through untouched — a symlinked /usr/local/bin is normal there.
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * PATH entries as an array: empty ones and the quotes `cmd` sometimes leaves around an entry are removed.
 * @param {string} value
 * @param {string} [delimiter]
 * @returns {string[]}
 */
export function splitPath(value, delimiter = path.delimiter) {
  return String(value ?? '')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

/**
 * The entries of a PATH that are safe to hand to a child.
 *
 * On Windows each entry is checked for real: a missing folder is dropped, a reparse point (junction/symlink)
 * is replaced by the folder it resolves to — and dropped when it cannot be resolved, which is the exact state
 * that produced `EUNKNOWN` — and a file (not a directory) is dropped too. On other platforms entries are kept
 * as they are (the filesystem is not probed: that would add a syscall per entry on every spawn for no benefit),
 * but duplicates are still removed.
 * @param {string} value raw PATH value
 * @param {{ platform?: NodeJS.Platform, delimiter?: string, lstat?: (p: string) => import('node:fs').Stats,
 *   realpath?: (p: string) => string }} [options] the probes are injectable so the rules can be tested
 * @returns {string[]}
 */
export function sanitizePathEntries(value, { platform = process.platform, delimiter, lstat = lstatSync, realpath = realpathSync } = {}) {
  const sep = delimiter ?? (platform === 'win32' ? ';' : ':');
  const entries = [];
  const seen = new Set();
  for (const raw of splitPath(value, sep)) {
    let dir = raw;
    if (platform === 'win32') {
      let stat;
      try {
        stat = lstat(dir);
      } catch {
        continue; // gone, or a reparse point libuv cannot open: never let a child walk into it
      }
      if (stat.isSymbolicLink()) {
        let real;
        try {
          real = realpath(dir);
        } catch {
          continue; // broken junction — the EUNKNOWN case
        }
        let realStat;
        try {
          realStat = lstat(real);
        } catch {
          continue;
        }
        if (!realStat.isDirectory() || realStat.isSymbolicLink()) continue;
        dir = real;
      } else if (!stat.isDirectory()) {
        continue; // a plain file on PATH (cmd shims land here as .exe): not a folder, nothing to search
      }
    }
    const key = platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(dir);
  }
  return entries;
}

/** `sanitizePathEntries` as a ready-to-use PATH string. */
export function sanitizePathValue(value, options = {}) {
  const platform = options.platform ?? process.platform;
  return sanitizePathEntries(value, { ...options, platform }).join(options.delimiter ?? (platform === 'win32' ? ';' : ':'));
}

/** The case-insensitive PATH key of an environment (Windows inherits e.g. `Path`). */
function pathKey(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

/** The folder node.exe itself lives in, with a junction resolved: `node`/`npx` must stay findable. */
function ownBinDir(execPath, probes) {
  const dir = path.dirname(execPath);
  try {
    return probes.lstat(dir).isSymbolicLink() ? probes.realpath(dir) : dir;
  } catch {
    return dir; // the running executable's folder always exists in practice; keep it regardless
  }
}

/**
 * `process.env`, cleaned for a child process.
 * @param {NodeJS.ProcessEnv} [extra] variables to set/override (`OFFICE_MANAGED`, `CI`, …)
 * @param {NodeJS.ProcessEnv} [base]
 * @param {{ platform?: NodeJS.Platform, execPath?: string, delimiter?: string,
 *   lstat?: (p: string) => import('node:fs').Stats, realpath?: (p: string) => string }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnv(extra = {}, base = process.env, { platform = process.platform, execPath = process.execPath, ...options } = {}) {
  const env = { ...base, ...extra };
  if (platform !== 'win32') return env;
  const key = pathKey(env);
  const inherited = env[key];
  // Always hand the child `PATH`, whatever case it arrived in (`Path` on most Windows machines), and never two
  // keys for it: uv_spawn passes every pair along, so a duplicate would reach the child twice.
  for (const other of Object.keys(env)) if (other.toUpperCase() === 'PATH') delete env[other];
  const probes = { lstat: options.lstat ?? lstatSync, realpath: options.realpath ?? realpathSync };
  const merged = [];
  const seen = new Set();
  for (const dir of [ownBinDir(execPath, probes), ...sanitizePathEntries(inherited, { ...options, platform, ...probes })]) {
    const dedupeKey = dir.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    merged.push(dir);
  }
  env.PATH = merged.join(';');
  return env;
}
