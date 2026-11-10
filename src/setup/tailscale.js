// Tailscale detection and the optional winget install used by setup. Lookup returns an absolute path (never a shell
// string); the install runs the frozen winget allowlist from packages.js and only on Windows.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SETUP_TARGETS } from './packages.js';
import { runCapturedProcess } from './process.js';
import { cancelledError } from './runtime.js';

const RUN_OPTIONS = { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };

/**
 * Absolute path of tailscale.exe/Tailscale, or null. The known installer locations are checked first; `where`/
 * `which` is only a fallback, and its output is trusted only when the file really exists.
 */
export function findTailscale({ env = process.env, platform = process.platform, exists = existsSync, run = execFileSync } = {}) {
  const winCandidates = [
    env.ProgramFiles ? path.win32.join(env.ProgramFiles, 'Tailscale', 'tailscale.exe') : null,
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  ];
  const candidates =
    platform === 'win32'
      ? winCandidates
      : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }

  try {
    const found = run(platform === 'win32' ? 'where' : 'which', ['tailscale'], RUN_OPTIONS);
    const first = String(found ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first && exists(first) ? first : null;
  } catch {
    return null;
  }
}

/** The first Tailscale IPv4 address (100.x), or null when Tailscale is not installed/logged in. */
export function tailscaleIp(bin, { run = execFileSync } = {}) {
  if (!bin) return null;
  try {
    const out = run(bin, ['ip', '-4'], RUN_OPTIONS);
    const ip = String(out ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(line) && line.split('.').every((part) => Number(part) <= 255));
    return ip ?? null;
  } catch {
    return null;
  }
}

function outputHint(lines) {
  return (Array.isArray(lines) ? lines : []).slice(-50).join('\n').trim().slice(-4000);
}

function tailscaleFailed(message, lines, cause) {
  const err = new Error(message);
  err.code = 'TAILSCALE_FAILED';
  err.hint = ['Jalankan winget secara manual atau pasang Tailscale dari https://tailscale.com/download.', outputHint(lines)]
    .filter(Boolean)
    .join('\n');
  if (cause) err.cause = cause;
  return err;
}

function isCancelled(err) {
  return err?.code === 'CANCELLED' || err?.code === 'ABORT_ERR' || err?.name === 'AbortError';
}

/**
 * Installs Tailscale through winget with the fixed allowlist arguments. Windows only; elsewhere setup skips it.
 * @returns {Promise<{ ok: true, lines: string[] }>}
 */
export async function installTailscale({ spawnImpl = spawn, signal, onLine, platform = process.platform, timeoutMs = 600_000 } = {}) {
  if (platform !== 'win32') {
    const err = new Error('Tailscale otomatis hanya tersedia di Windows.');
    err.code = 'UNSUPPORTED';
    throw err;
  }
  let result = null;
  try {
    if (signal?.aborted) throw cancelledError();
    result = await runCapturedProcess({
      command: 'winget',
      args: [...SETUP_TARGETS.tailscale.winget.args],
      env: process.env,
      timeoutMs,
      signal,
      spawnImpl,
      onLine,
    });
  } catch (err) {
    if (isCancelled(err) || signal?.aborted) throw cancelledError();
    throw tailscaleFailed(`Tidak bisa menjalankan winget: ${err?.message ?? err}`, err?.lines, err);
  }
  if (result.aborted || signal?.aborted) throw cancelledError();
  if (result.timedOut) throw tailscaleFailed(`Instalasi Tailscale melebihi batas waktu ${timeoutMs} ms.`, result.lines);
  if (result.code !== 0) throw tailscaleFailed(`winget gagal memasang Tailscale (exit ${result.code ?? result.signal ?? 'tidak diketahui'}).`, result.lines);
  return { ok: true, lines: result.lines };
}
