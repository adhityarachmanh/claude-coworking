// Setelan harus bertahan saat server dimatikan dan dihidupkan lagi (bukan hanya di DOM/localStorage). Test ini
// menjalankan server sungguhan dua kali dengan folder data yang sama: ubah setelan → matikan → hidupkan → nilainya
// harus sama. Tidak ada HTTP palsu dan tidak ada state di memori yang ikut terbawa.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

/** Boots the real server on `port` with `dataDir`; resolves once it prints its ready line. */
async function boot({ port, dataDir, projects }) {
  const child = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OFFICE_APP_DIR: APP,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: dataDir,
      OFFICE_TAILSCALE_BIN: path.join(dataDir, 'no-tailscale.exe'),
      OFFICE_OPEN_DRY_RUN: '1',
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(dataDir, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(dataDir, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(dataDir, 'claude-config'),
    },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('server tidak siap dalam 60 dtk'));
    }, 60_000);
    child.stdout.on('data', (d) => {
      if (!String(d).includes('berjalan di')) return;
      clearTimeout(timer);
      resolve();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server berhenti (exit ${code})`));
    });
  });
  return child;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
}

/** The per-start token the page carries; a new one every boot (that is why it is read again). */
async function tokenOf(port) {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const match = html.match(/office-token" content="([^"]+)"/);
  assert.ok(match, 'token ada di halaman');
  return match[1];
}

const call = async (port, token, route, body = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office-Token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

test('setelan bertahan setelah server dimatikan dan dihidupkan lagi', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'adhitron-persist-'));
  const projects = path.join(dataDir, 'projects');
  mkdirSync(projects, { recursive: true });
  const port = await freePort();
  let child = await boot({ port, dataDir, projects });
  try {
    // 1. laptop mengubah dua setelan (jembatan daya + folder project)
    let token = await tokenOf(port);
    const saved = await call(port, token, '/api/remote-power/settings', {
      bridgeUrl: 'https://jembatan.workers.dev',
      token: 'rahasia',
      offDelaySec: 90,
      shutdownPc: true,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const configured = await call(port, token, '/api/config', { roots: [projects] });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));

    // 2. server dimatikan, lalu dihidupkan lagi dengan folder data yang sama
    child = await stop(child);
    child = await boot({ port, dataDir, projects });
    token = await tokenOf(port);

    // 3. nilainya masih sama (bukan default)
    const power = await call(port, token, '/api/remote-power/get');
    assert.equal(power.status, 200);
    assert.deepEqual(power.body.remotePower, {
      bridgeUrl: 'https://jembatan.workers.dev',
      token: 'rahasia',
      offDelaySec: 90,
      shutdownPc: true,
      autoCut: false,
    });
    const state = JSON.parse(readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.deepEqual(state.roots, [projects], 'folder project juga bertahan');
  } finally {
    await stop(child);
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
});
