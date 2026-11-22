/* global document, window -- fungsi page.eval berjalan di dalam browser */
// ⎇ UI Worktree: the dialog lists a git repo's worktrees, creates one, and the session bar shows the active one
// (public/js/features/worktree.js + features/sessions.js). Headless Chrome/Edge over CDP (test-support/cdp.mjs).
// Standalone on purpose (like test/activity-runs-ui.test.mjs): `npm run test:ui:area` only selects blocks of
// test/ui.test.mjs, so this file is run directly with `node --test test/worktree-ui.test.mjs`.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

/** A git repo with one commit, so `worktree add -b` has a HEAD to branch from. */
function gitRepo(dir) {
  const run = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 't@t');
  run('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  run('add', '-A');
  run('commit', '-qm', 'init');
  return dir;
}

/** What the dialog actually draws: the DOM is the contract (no parsing in the test). */
function listView() {
  const modal = document.querySelector('#worktree-modal');
  const rows = [...document.querySelectorAll('#worktree-list li[data-name]')];
  const chip = document.querySelector('#sb-worktree');
  return {
    visible: Boolean(modal?.getClientRects().length),
    sum: document.querySelector('#worktree-sum')?.textContent.trim() ?? '',
    rows: rows.map((li) => ({
      name: li.dataset.name,
      main: li.dataset.main,
      active: li.dataset.active,
      badge: li.querySelector('.wt-badge')?.textContent.trim() ?? '',
      canEnter: Boolean(li.querySelector('[data-wt="enter"]')),
      canRemove: Boolean(li.querySelector('[data-wt="remove"]')),
    })),
    exitVisible: Boolean(document.querySelector('#worktree-exit')?.getClientRects().length),
    chip: !chip || chip.hidden ? null : (document.querySelector('#sb-worktree-name')?.textContent.trim() ?? ''),
  };
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-wt-ui-'));
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'repo'), { recursive: true });
  gitRepo(path.join(projects, 'repo'));
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
  // The project id the app assigned to the temp repo (a snapshot frame of /stream).
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  projectId = JSON.parse(text.match(/^data: (.*)$/m)[1]).projects.find((p) => p.name === 'repo').id;
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

describe('⎇ UI Worktree', { skip: SKIP ?? false }, () => {
  describeArea('UI Worktree', { skip: SKIP ?? false }, () => {
    let page;

    before(async () => {
      if (SKIP) return;
      page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, mobile: false });
      page.clearProblems();
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 20_000, message: 'app terhubung' });
    });

    after(async () => page?.close().catch(() => {}));

    it('dialog: repo utama tampil; buat → baris muncul; masuk → chip ⎇; keluar → chip hilang', async () => {
      await page.eval(async () => {
        document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
        (await import('/js/features/worktree.js')).openWorktree();
      });
      await page.waitFor(() => document.querySelector('#worktree-list li[data-name]'), { timeoutMs: 10_000, message: 'daftar worktree tampil' });
      let view = await page.eval(listView);
      assert.equal(view.visible, true, 'dialog Worktree terbuka');
      assert.equal(view.rows.filter((r) => r.main === 'true').length, 1, 'repo utama selalu ada di daftar');
      assert.equal(view.chip, null, 'belum ada chip worktree di bar sesi');
      assert.equal(view.exitVisible, false, 'belum ada yang bisa ditinggalkan');

      await page.eval(() => {
        document.querySelector('#worktree-name').value = 'login';
      });
      await page.click('#worktree-create');
      await page.waitFor(() => [...document.querySelectorAll('#worktree-list li[data-name]')].some((li) => li.dataset.name === 'login'), { timeoutMs: 10_000, message: 'baris worktree login muncul' });
      view = await page.eval(listView);
      const login = view.rows.find((r) => r.name === 'login');
      assert.equal(login.main, 'false');
      assert.equal(login.active, 'false', 'baris baru belum aktif');
      assert.ok(login.canEnter && login.canRemove, 'baris punya Masuk dan Hapus');

      await page.click('#worktree-list li[data-name="login"] [data-wt="enter"]');
      await page.waitFor(() => document.querySelector('#sb-worktree') && !document.querySelector('#sb-worktree').hidden, { timeoutMs: 10_000, message: 'chip ⎇ tampil di bar sesi' });
      const chip = await page.eval(() => document.querySelector('#sb-worktree-name').textContent.trim());
      assert.equal(chip, 'login', 'chip menyebut worktree aktif');
      await page.waitFor(() => document.querySelector('#worktree-list li[data-name="login"]')?.dataset.active === 'true', { timeoutMs: 10_000, message: 'baris login ditandai aktif' });
      view = await page.eval(listView);
      assert.equal(view.rows.find((r) => r.name === 'login').active, 'true', 'baris login ditandai aktif');
      assert.equal(view.exitVisible, true, 'tombol Keluar muncul saat ada worktree aktif');

      await page.click('#worktree-exit');
      await page.waitFor(() => document.querySelector('#sb-worktree').hidden, { timeoutMs: 10_000, message: 'chip worktree hilang' });
      await page.waitFor(() => document.querySelector('#worktree-exit').hidden && [...document.querySelectorAll('#worktree-list li[data-name]')].every((li) => li.dataset.active === 'false'), { timeoutMs: 10_000, message: 'dialog menyegarkan diri setelah keluar' });
      view = await page.eval(listView);
      assert.equal(view.exitVisible, false, 'tombol Keluar ikut hilang');
      assert.ok(view.rows.every((r) => r.active === 'false'), 'tidak ada baris aktif');
      assert.deepEqual(page.problems, [], 'tanpa error konsol');
    });

    it('menu ⋯ membawa item Worktree yang membuka dialog; Hapus membersihkan worktree', async () => {
      await page.eval(() => {
        document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
      });
      await page.click('#btn-more');
      await page.click('#more-menu [data-more="worktree"]');
      await page.waitFor(() => document.querySelector('#worktree-list li[data-name]'), { timeoutMs: 10_000, message: 'dialog terbuka dari menu ⋯' });
      assert.equal(await page.eval(() => Boolean(document.querySelector('#worktree-modal')?.getClientRects().length)), true, 'dialog terbuka dari menu');

      // Hapus is a confirmation; the browser dialog is auto-accepted by the page (window.confirm stub).
      await page.eval(() => {
        window.confirm = () => true;
      });
      await page.click('#worktree-list li[data-name="login"] [data-wt="remove"]');
      await page.waitFor(() => ![...document.querySelectorAll('#worktree-list li[data-name]')].some((li) => li.dataset.name === 'login'), { timeoutMs: 10_000, message: 'baris login hilang setelah dihapus' });
      assert.deepEqual(page.problems, [], 'tanpa error konsol');
    });
  });
});
