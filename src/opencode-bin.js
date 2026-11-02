// Locates the installed OpenCode binary so it can be spawned without a shell (same idea as claude-bin.js).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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
export function openCodeModels(bin, { maxAgeMs = 10 * 60_000 } = {}) {
  if (!bin) return Promise.resolve([]);
  if (modelCache && Date.now() - modelCache.at < maxAgeMs) return modelCache.load;
  const load = new Promise((resolve) => {
    execFile(bin.command, [...bin.args, 'models'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) {
        modelCache = null; // try again next time
        return resolve([]);
      }
      resolve([...new Set(String(out).split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:#@-]+$/.test(l)))]);
    });
  });
  modelCache = { at: Date.now(), load };
  return load;
}
