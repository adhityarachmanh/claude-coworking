// OpenCode maintenance the CLI normally does in a terminal: update, restart the background service, and import a
// session JSON. Everything runs through the same `opencode` binary the app already uses, never edits its config.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearSessionCache } from './opencode-bin.js';
import { execFileTree } from './proc.js';

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export class OpenCodeAdminError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const clean = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
const firstLine = (r) => clean(`${r.output ?? ''}`).split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('at ')) ?? 'Gagal.';

/** Runs one `opencode` CLI command without a shell; resolves { ok, timedOut, output } (never rejects). */
export function runOpenCode(bin, args, { cwd, timeout = 120_000 } = {}) {
  if (!bin) return Promise.reject(new OpenCodeAdminError(404, 'OpenCode tidak ditemukan.'));
  return new Promise((resolve) => {
    execFileTree(bin.command, [...bin.args, ...args], { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1', NO_COLOR: '1' } }, (error, out, err) => {
      resolve({ ok: !error, timedOut: Boolean(error?.killed), output: clean(`${out ?? ''}${err ? `\n${err}` : ''}`).slice(0, 20_000) });
    });
  });
}

/** `opencode upgrade` (the CLI's own updater). */
export function updateOpenCode(bin, { timeout = 300_000 } = {}) {
  return runOpenCode(bin, ['upgrade'], { timeout });
}

/** `opencode service restart`: the background service the ACP sessions and terminal share. */
export function restartOpenCodeService(bin, { timeout = 60_000 } = {}) {
  return runOpenCode(bin, ['service', 'restart'], { timeout });
}

/**
 * Imports OpenCode's own session JSON (`opencode session export`) through `opencode session import`. The JSON is
 * written to a throwaway file: the CLI takes a path, never stdin. Returns the new id when the CLI prints one.
 */
export async function importOpenCodeSession({ opencode, projectPath, data, timeout = 120_000 }) {
  if (!opencode) throw new OpenCodeAdminError(404, 'OpenCode belum terpasang.');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new OpenCodeAdminError(400, 'File import harus berisi objek JSON sesi OpenCode.');
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > MAX_IMPORT_BYTES) throw new OpenCodeAdminError(413, 'File sesi terlalu besar (maks 20 MB).');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-opencode-import-'));
  const file = path.join(dir, 'session.json');
  let result;
  try {
    writeFileSync(file, json, 'utf8');
    result = await runOpenCode(opencode, ['session', 'import', file, '--directory', projectPath], { cwd: projectPath, timeout });
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may still hold the file for a moment; a later import uses a fresh temp folder anyway.
    }
  }
  if (!result.ok) throw new OpenCodeAdminError(result.timedOut ? 504 : 502, `Import sesi OpenCode gagal: ${firstLine(result)}`);
  clearSessionCache(projectPath);
  const sessionId = result.output.match(/\bses_[\w-]{1,100}\b/)?.[0] ?? null;
  return { ok: true, sessionId, message: firstLine(result) };
}
