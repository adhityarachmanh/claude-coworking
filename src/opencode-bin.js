// Locates the installed OpenCode binary so it can be spawned without a shell (same idea as claude-bin.js).
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
const EXE = WIN ? 'opencode.exe' : 'opencode';

/** @returns {{ command: string, args: string[] } | null} */
export function findOpenCode() {
  const override = process.env.OPENCODE_BIN;
  if (override) return /\.[cm]?js$/.test(override) ? { command: process.execPath, args: [override] } : { command: override, args: [] };
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  // 1. The npm package (`@opencode/cli`): PATH has a shim; the real binary sits in bin/ behind it.
  for (const dir of dirs) {
    const native = path.join(dir, 'node_modules', '@opencode', 'cli', 'bin', EXE);
    if (existsSync(native)) return { command: native, args: [] };
  }
  // 2. A bare binary on PATH (other installers).
  for (const dir of dirs) {
    const direct = path.join(dir, EXE);
    if (existsSync(direct)) return { command: direct, args: [] };
  }
  return null;
}

/**
 * `opencode models` → ["provider/model", …] (cached; the list only changes when providers do).
 * @returns {Promise<string[]>}
 */
let modelCache = null;
/** After a provider login/logout the model list changes. */
export function clearModelCache() {
  modelCache = null;
}
export function openCodeModels(bin, { maxAgeMs = 10 * 60_000 } = {}) {
  if (!bin) return Promise.resolve([]);
  if (modelCache && Date.now() - modelCache.at < maxAgeMs) return modelCache.load;
  const load = new Promise((resolve) => {
    execFile(bin.command, [...bin.args, 'models'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) {
        modelCache = null; // try again next time
        return resolve([]);
      }
      const list = [...new Set(String(out).split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:#@-]+$/.test(l)))];
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
    execFile(bin.command, [...bin.args, 'session', 'list', '--format', 'json', '-n', String(limit)], { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
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
    execFile(bin.command, [...bin.args, '--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true }, (err, out) => {
      resolve(err ? '' : (String(out).match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? ''));
    });
  });
}

/** JSON with comments and trailing commas (opencode.jsonc), parsed without a dependency. */
function parseJsonc(text) {
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

/**
 * The user's own OpenCode `permission` rules (global ~/.config/opencode, then the project's opencode.json and
 * .opencode/), merged per tool like OpenCode does. Read fresh at every spawn (small files); {} when none.
 */
export function readUserPermission(projectPath, home = os.homedir()) {
  const files = [];
  for (const dir of [path.join(home, '.config', 'opencode'), projectPath, projectPath && path.join(projectPath, '.opencode')]) {
    if (!dir) continue;
    for (const name of ['opencode.json', 'opencode.jsonc', 'config.json']) files.push(path.join(dir, name));
  }
  const merged = {};
  for (const file of files) {
    let perm;
    try {
      perm = parseJsonc(readFileSync(file, 'utf8'))?.permission;
    } catch {
      continue; // missing or not JSON: OpenCode itself reports a broken config
    }
    if (!perm || typeof perm !== 'object' || Array.isArray(perm)) continue;
    for (const [tool, rule] of Object.entries(perm)) {
      if (rule && typeof rule === 'object' && !Array.isArray(rule)) merged[tool] = { ...(typeof merged[tool] === 'object' ? merged[tool] : {}), ...rule };
      else if (typeof rule === 'string') merged[tool] = rule;
    }
  }
  return merged;
}
