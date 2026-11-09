#!/usr/bin/env node
// 🌉 `office claude [...]`: the opt-in wrapper. It asks this laptop's Adhitron for the narrow CLI token (only
// usable for approval decisions), writes a temporary settings file in the app data folder, and runs the user's own
// `claude` with that file. Without this command nothing changes; ~/.claude/settings.json is never touched.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSettings } from './settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const DATA_DIR = path.resolve(process.env.OFFICE_DATA_DIR ?? path.join(APP_ROOT, 'data'));
const PORT = Number(process.env.OFFICE_PORT ?? 4317);
const BASE = `http://127.0.0.1:${PORT}`;
const STALE_SETTINGS_MS = 86_400_000;

const usage = () => {
  process.stderr.write('Pakai: office claude [argumen claude...]\n');
};

/** The narrow CLI token: it can only ask for approval decisions, never drive the office (POST /api/cli-bridge/ask). */
async function readToken() {
  const response = await fetch(`${BASE}/api/cli-bridge/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(4000),
    redirect: 'error',
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  const token = String(body?.token ?? '');
  return /^[0-9a-f]{32,}$/.test(token) ? token : null;
}

function findClaude() {
  if (process.env.OFFICE_CLAUDE_BIN) return process.env.OFFICE_CLAUDE_BIN;
  const finder = process.platform === 'win32' ? ['where.exe', ['claude']] : ['which', ['claude']];
  try {
    const out = execFileSync(finder[0], finder[1], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (process.platform === 'win32') return lines.find((line) => /\.cmd$/i.test(line)) ?? lines[0] ?? null;
    return lines[0] ?? null;
  } catch {
    return null;
  }
}

/** Old settings files from a crashed wrapper: they hold a hook path, never a token, and are safe to remove. */
function removeStaleSettings(dir) {
  try {
    for (const name of readdirSync(dir)) {
      if (!/^settings-\d+\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        if (Date.now() - statSync(file).mtimeMs > STALE_SETTINGS_MS) rmSync(file, { force: true });
      } catch {
        // another wrapper may have removed it first
      }
    }
  } catch {
    // the folder may not exist yet
  }
}

/** One Windows command line that preserves spaces/special characters as much as cmd.exe allows. */
const quoteArg = (value) => `"${String(value).replace(/"/g, '""')}"`;

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'claude') {
    usage();
    process.exitCode = 2;
    return;
  }
  const claudeArgs = args.slice(1);
  if (claudeArgs.some((arg) => arg === '--settings' || arg.startsWith('--settings='))) {
    process.stderr.write('Wrapper ini menambahkan --settings sendiri; jalankan claude langsung bila ingin memakai settings lain.\n');
    process.exitCode = 2;
    return;
  }
  if (claudeArgs.some((arg) => /[\r\n]/.test(arg))) {
    process.stderr.write('Argumen berisi baris baru; jalankan claude langsung untuk kasus itu.\n');
    process.exitCode = 2;
    return;
  }
  const token = await readToken().catch(() => null);
  if (!token) {
    process.stderr.write(`Adhitron tidak bisa dihubungi di ${BASE}. Jalankan server dulu, lalu ulangi.\n`);
    process.exitCode = 1;
    return;
  }
  const claude = findClaude();
  if (!claude) {
    process.stderr.write('Perintah `claude` tidak ditemukan. Set OFFICE_CLAUDE_BIN ke path claude yang valid.\n');
    process.exitCode = 1;
    return;
  }

  const dir = path.join(DATA_DIR, 'cli-bridge');
  mkdirSync(dir, { recursive: true });
  removeStaleSettings(dir);
  const settingsPath = path.join(dir, `settings-${process.pid}.json`);
  // The token lives in the OS temp folder (not data/, so it can never enter a backup) with a random name/mode 0600.
  const secretDir = mkdtempSync(path.join(os.tmpdir(), 'adhit-office-cli-'));
  const tokenFile = path.join(secretDir, 'token');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  writeFileSync(settingsPath, `${JSON.stringify(buildSettings({ nodePath: process.execPath, hookPath: path.join(HERE, 'hook.mjs'), tokenFile }), null, 2)}\n`, { mode: 0o600 });

  const env = { ...process.env, OFFICE_CLI_BASE: BASE };
  const child = process.platform === 'win32'
    ? spawn([claude, '--settings', settingsPath, ...claudeArgs].map(quoteArg).join(' '), { stdio: 'inherit', env, shell: true })
    : spawn(claude, ['--settings', settingsPath, ...claudeArgs], { stdio: 'inherit', env });

  const cleanup = () => {
    try {
      rmSync(settingsPath, { force: true });
    } catch {
      // best effort
    }
    try {
      rmSync(secretDir, { recursive: true, force: true });
    } catch {
      // best effort; the server restart that usually follows makes a leftover token useless
    }
  };
  const stop = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // the child may have exited already
    }
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.on('error', (err) => {
    cleanup();
    process.stderr.write(`Gagal menjalankan claude: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    cleanup();
    process.exit(signal ? 130 : code ?? 0);
  });
}

main().catch(() => {
  process.stderr.write('CLI bridge gagal dimulai.\n');
  process.exitCode = 1;
});
