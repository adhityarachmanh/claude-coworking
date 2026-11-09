#!/usr/bin/env node
// 🌉 Preflight for the manual CLI bridge test (docs/uji-manual-cli-bridge.md). It only checks that the office is
// reachable, the narrow token route answers, and `office.cmd` + `claude` are findable. It never asks for approval
// and never prints the token. The manual test itself is Windows-only (the repo ships office.cmd).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.OFFICE_PORT ?? 4317);
const BASE = `http://127.0.0.1:${PORT}`;
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

/** Same precedence as tools/cli-bridge/launch.mjs: OFFICE_CLAUDE_BIN wins (it may be a name or a path). */
function findClaude() {
  if (process.env.OFFICE_CLAUDE_BIN) return process.env.OFFICE_CLAUDE_BIN;
  const finder = process.platform === 'win32' ? ['where.exe', ['claude']] : ['which', ['claude']];
  const out = spawnSync(finder[0], finder[1], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (out.status !== 0) return null;
  const lines = String(out.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  return process.platform === 'win32' ? lines.find((line) => /\.cmd$/i.test(line)) ?? lines[0] : lines[0];
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('Uji manual CLI bridge di repo ini hanya untuk Windows (launcher: office.cmd).');
    process.exitCode = 2;
    return;
  }

  console.log(`CLI bridge preflight · ${BASE}\n`);

  let health = null;
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
    const body = response.ok ? await response.json().catch(() => null) : null;
    health = body?.ok === true ? body : null;
  } catch {
    health = null;
  }
  check('Server Adhitron menyala', Boolean(health), health ? undefined : `tidak menjawab dengan ok di ${BASE}`);

  let tokenOk = false;
  if (health) {
    try {
      const response = await fetch(`${BASE}/api/cli-bridge/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(4000),
      });
      const body = await response.json().catch(() => ({}));
      tokenOk = response.ok && /^[0-9a-f]{32,}$/.test(String(body?.token ?? ''));
    } catch {
      tokenOk = false;
    }
  }
  check('Token CLI diterbitkan', tokenOk, tokenOk ? 'dipakai hanya oleh /api/cli-bridge/ask' : 'cek versi server');

  const launcher = path.join(APP, 'office.cmd');
  check('Launcher `office.cmd` tersedia', existsSync(launcher), existsSync(launcher) ? launcher : 'tidak ditemukan di repo');

  const claude = findClaude();
  check('Perintah `claude` ditemukan', Boolean(claude), claude ?? 'set OFFICE_CLAUDE_BIN ke path claude yang valid');

  const failed = checks.filter((item) => !item.ok);
  console.log('\nLangkah berikutnya:');
  console.log('  1. cd <folder project yang terdaftar di kantor>');
  console.log(`  2. "${launcher}" claude`);
  console.log('  3. Ikuti docs/uji-manual-cli-bridge.md dan catat hasilnya.\n');

  if (failed.length) {
    console.log(`Preflight gagal (${failed.length}): ${failed.map((item) => item.name).join(', ')}.`);
    process.exitCode = 1;
  } else {
    console.log('Preflight lulus. Uji manual siap dijalankan.');
  }
}

main().catch((error) => {
  console.error(`Preflight gagal: ${error.message}`);
  process.exitCode = 1;
});
