#!/usr/bin/env node
// Restarts the Adhit Office server the clean way:
//   1. asks the running server to shut down (POST /api/shutdown, laptop only): a turn Claude is still working on
//      is recorded as cut short and interrupted, so after the restart its chat offers "Lanjutkan";
//   2. waits until the port is free (if the server hangs: kills it, which the next start still detects);
//   3. starts `node server.js --background` detached (log in data/server.log) and waits for /health.
//
// Usage: node scripts/restart.mjs [--port 4317] [-- <extra server.js args>]
//   OFFICE_PORT is honoured too. Prefer this over `Stop-Process -Force` (which cuts a running turn off mid-way).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dashDash = argv.indexOf('--');
const own = dashDash >= 0 ? argv.slice(0, dashDash) : argv;
const serverArgs = dashDash >= 0 ? argv.slice(dashDash + 1) : ['--background'];
const portFlag = own.indexOf('--port');
const PORT = Number(portFlag >= 0 ? own[portFlag + 1] : (process.env.OFFICE_PORT ?? 4317));
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`Port tidak valid: ${own[portFlag + 1] ?? process.env.OFFICE_PORT}`);
  process.exit(2);
}
// The server only answers to its own host names (DNS-rebinding guard), so talk to localhost:<port>.
const BASE = `http://localhost:${PORT}`;
const STOP_TIMEOUT_MS = 20_000; // the server itself gives up after ~10 s
const START_TIMEOUT_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The server's /health answer, or null when nothing answers on the port. */
async function health() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitFor(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(250);
  }
  return false;
}

async function stopRunning(running) {
  // The per-start API token is in the page the server serves (same as the browser gets it).
  const page = await (await fetch(BASE, { signal: AbortSignal.timeout(5000) })).text();
  const token = page.match(/office-token" content="([^"]+)"/)?.[1];
  if (!token) throw new Error('Token API tidak ditemukan di halaman server.');
  const res = await fetch(`${BASE}/api/shutdown`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office-Token': token },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Shutdown ditolak (HTTP ${res.status}).`);
  console.log('Server diminta berhenti dengan rapi (giliran yang berjalan dicatat & di-interrupt)…');
  if (await waitFor(async () => !(await health()), STOP_TIMEOUT_MS)) return;
  // Hung: kill it. The turn records are already on disk, so the next start still offers "Lanjutkan".
  if (!running.pid) throw new Error('Server tidak berhenti dan pid-nya tidak diketahui.');
  console.warn(`Server tidak berhenti dalam ${STOP_TIMEOUT_MS / 1000} dtk — dihentikan paksa (pid ${running.pid}).`);
  process.kill(running.pid);
  if (!(await waitFor(async () => !(await health()), 5000))) throw new Error('Port masih dipakai setelah server dihentikan paksa.');
}

async function main() {
  const running = await health();
  if (running) {
    try {
      await stopRunning(running);
    } catch (err) {
      console.error(`Gagal menghentikan server: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.log(`Tidak ada server di port ${PORT}; langsung dijalankan.`);
  }

  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js'), ...serverArgs], {
    cwd: APP_DIR,
    env: { ...process.env, OFFICE_PORT: String(PORT) },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  // The auto-start watchdog may have started one in the meantime: any healthy server on the port counts.
  if (await waitFor(health, START_TIMEOUT_MS)) {
    const now = await health();
    console.log(`Adhit Office berjalan lagi di ${BASE} (pid ${now?.pid ?? child.pid}).`);
    return;
  }
  console.error(`Server tidak menjawab /health dalam ${START_TIMEOUT_MS / 1000} dtk. Cek data/server.log.`);
  process.exit(1);
}

main();
