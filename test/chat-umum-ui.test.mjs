/* global document -- fungsi page.eval berjalan di dalam browser */
// 💬 Chat umum in the picker: the built-in entry sorts to the top with the 💬 icon and offers no destructive button
// (archive/purge/forget), because it is a system project (public/js/features/picker.js). Headless Chrome/Edge over
// CDP (test-support/cdp.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TMP;
let BASE;
let server;
let browser;

/** The first picker row: id, icon, and which destructive controls it carries. */
function firstRowView() {
  const row = document.querySelector('#project-list li[data-id]');
  if (!row) return null;
  return {
    id: row.dataset.id,
    icon: row.querySelector('.p-icon')?.textContent.trim() ?? '',
    hasArchive: Boolean(row.querySelector('.arch')),
    hasPurge: Boolean(row.querySelector('.purge')),
    hasForget: Boolean(row.querySelector('.forget')),
  };
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-chatumum-ui-'));
  const projects = path.join(TMP, 'projects');
  mkdirSync(projects, { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = srv.address();
      srv.close(() => resolve(free));
    });
    srv.on('error', reject);
  });
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_APP_DIR: APP,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      OFFICE_GH_BIN: path.join(TMP, 'no-such-gh.exe'),
      OFFICE_UPDATE_CHECK: '0',
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000',
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 20_000);
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && (clearTimeout(timer), resolve()));
    server.on('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}`))));
  });
  server.stdout.resume();
  server.stderr.resume();
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill();
    await sleep(500);
  }
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('💬 Chat umum di pemilih project', { skip: SKIP ?? false }, () => {
  let page;

  before(async () => {
    if (SKIP) return;
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, mobile: false });
    page.clearProblems();
    await page.goto(`${BASE}/`);
    await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 15_000, message: 'app terhubung' });
  });

  after(async () => page?.close().catch(() => {}));

  it('entri bawaan tampil paling atas, ikon 💬, tanpa tombol destruktif', async () => {
    await page.eval(async () => {
      document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
      (await import('/js/features/picker.js')).openProjects();
    });
    await page.waitFor(() => document.querySelector('#project-list li[data-id]'), { timeoutMs: 5000, message: 'daftar project terisi' });
    const view = await page.eval(firstRowView);
    assert.equal(view.id, 'chat-umum', 'baris pertama adalah Chat umum');
    assert.equal(view.icon, '💬');
    assert.equal(view.hasArchive, false, 'tanpa tombol arsip');
    assert.equal(view.hasPurge, false, 'tanpa tombol purge');
    assert.equal(view.hasForget, false, 'tanpa tombol hapus dari daftar');
    assert.deepEqual(page.problems, [], 'tanpa error konsol');
  });
});