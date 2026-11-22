/* global document, window -- fungsi page.eval berjalan di dalam browser */
// 📂 UI Folder tambahan: the dialog lists the extra folders Claude may access, adds one, refuses a relative path
// and removes one (public/js/features/add-dirs.js + menu ⋯). Headless Chrome/Edge over CDP (test-support/cdp.mjs).
// Standalone on purpose (like test/worktree-ui.test.mjs): `npm run test:ui:area` only selects blocks of
// test/ui.test.mjs, so this file is run directly with `node --test test/add-dirs-ui.test.mjs`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';
import { describeArea } from '../test-support/ui-area-select.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TMP;
let BASE;
let server;
let browser;
let projectId;
let extra;

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

/** What the dialog actually draws: the DOM is the contract (no parsing in the test). */
function listView() {
  const modal = document.querySelector('#dirs-modal');
  const rows = [...document.querySelectorAll('#dirs-list li[data-dir]')];
  return {
    visible: Boolean(modal?.getClientRects().length),
    sum: document.querySelector('#dirs-sum')?.textContent.trim() ?? '',
    error: document.querySelector('#dirs-error')?.textContent.trim() ?? '',
    rows: rows.map((li) => ({
      dir: li.dataset.dir,
      badge: li.querySelector('.wt-badge')?.textContent.trim() ?? '',
      canRemove: Boolean(li.querySelector('[data-dir-remove]')),
    })),
  };
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-dirs-ui-'));
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'kerja'), { recursive: true });
  extra = path.join(TMP, 'pustaka');
  mkdirSync(extra);
  mkdirSync(path.join(TMP, 'claude-projects'));
  mkdirSync(path.join(TMP, 'acp-store'));
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENCODE_')));
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...cleanEnv,
      OFFICE_APP_DIR: APP,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      OFFICE_GH_BIN: path.join(TMP, 'no-such-gh.exe'),
      OFFICE_UPDATE_CHECK: '0',
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000',
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      FAKE_ACP_STORE: path.join(TMP, 'acp-store'),
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
  // The project id the app assigned to the temp project (a snapshot frame of /stream).
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  projectId = JSON.parse(text.match(/^data: (.*)$/m)[1]).projects.find((p) => p.name === 'kerja').id;
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill();
    await sleep(500);
  }
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('📂 UI Folder tambahan', { skip: SKIP ?? false }, () => {
  describeArea('UI Folder tambahan', { skip: SKIP ?? false }, () => {
    let page;

    const openDialog = async () => {
      await page.eval(() => {
        document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
      });
      await page.click('#btn-more');
      await page.click('#more-menu [data-more="dirs"]');
      await page.waitFor(() => document.querySelector('#dirs-sum')?.textContent.includes('folder tambahan'), { timeoutMs: 10_000, message: 'dialog Folder tambahan terbuka dari menu ⋯' });
    };

    before(async () => {
      if (SKIP) return;
      page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, mobile: false });
      page.clearProblems();
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 20_000, message: 'app terhubung' });
    });

    after(async () => page?.close().catch(() => {}));

    it('buka dari menu, tambah folder, tolak path relatif, lalu hapus', async () => {
      await openDialog();
      let view = await page.eval(listView);
      assert.equal(view.visible, true, 'dialog Folder tambahan terbuka');
      assert.equal(view.rows.length, 0, 'daftar awalnya kosong');
      assert.match(view.sum, /Belum ada folder tambahan/, 'ringkasan menyebut daftar kosong');

      await page.eval((dir) => {
        document.querySelector('#dirs-path').value = dir;
      }, extra);
      await page.click('#dirs-add');
      await page.waitFor(() => document.querySelector('#dirs-list li[data-dir]'), { timeoutMs: 10_000, message: 'baris folder muncul' });
      view = await page.eval(listView);
      assert.deepEqual(view.rows, [{ dir: extra, badge: '', canRemove: true }], 'baris menyebut path yang disimpan');
      assert.equal(view.error, '', 'tidak ada error setelah berhasil');
      assert.equal(await page.eval(() => document.querySelector('#dirs-path').value), '', 'input dikosongkan setelah berhasil');

      page.clearProblems();
      await page.eval(() => {
        document.querySelector('#dirs-path').value = 'relatif';
      });
      await page.click('#dirs-add');
      await page.waitFor(() => document.querySelector('#dirs-error')?.textContent.includes('absolut'), { timeoutMs: 10_000, message: 'path relatif ditolak dengan alasan' });
      view = await page.eval(listView);
      assert.equal(view.rows.length, 1, 'penolakan tidak menambah baris');
      assert.equal(await page.eval(() => document.querySelector('#dirs-path').value), 'relatif', 'input bermasalah tetap untuk diperbaiki');
      page.clearProblems(); // the intentional 400 just logged a network error; nothing after it is expected

      await page.eval(() => {
        window.confirm = () => true;
      });
      await page.click('#dirs-list li[data-dir] [data-dir-remove]');
      await page.waitFor(() => !document.querySelector('#dirs-list li[data-dir]'), { timeoutMs: 10_000, message: 'baris hilang setelah dihapus' });
      view = await page.eval(listView);
      assert.match(view.sum, /Belum ada folder tambahan/, 'ringkasan kembali kosong');

      // The list lives on the server: a fresh page shows the same (empty) list.
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 20_000, message: 'app terhubung lagi' });
      await openDialog();
      view = await page.eval(listView);
      assert.equal(view.rows.length, 0, 'daftar kosong bertahan setelah halaman dimuat ulang');
      assert.deepEqual(page.problems, [], 'tanpa error konsol');
    });
  });
});
