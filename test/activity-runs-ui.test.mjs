/* global document -- fungsi page.eval berjalan di dalam browser */
// Aktivitas per agent: the activity tab groups tool calls into one row per agent (public/js/features/activity.js
// + public/js/core/agent-runs.js). Driven by the built-in demo, which is the only way to produce office events
// without a model call. Headless Chrome/Edge over CDP (test-support/cdp.mjs).
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

/** What the list actually draws: the DOM is the contract (no parsing in the test). */
function runsView() {
  const list = document.querySelector('#activity');
  const runs = [...(list?.querySelectorAll('li.run[data-run]') ?? [])];
  return {
    visible: Boolean(list?.getClientRects().length),
    count: runs.length,
    first: runs[0]
      ? {
          role: runs[0].querySelector('b')?.textContent.trim() ?? '',
          state: runs[0].querySelector('[data-state]')?.textContent.trim() ?? '',
          expanded: runs[0].querySelector('[data-run-toggle]')?.getAttribute('aria-expanded'),
          steps: runs[0].querySelectorAll('.run-steps li').length,
        }
      : null,
    clocks: [...(list?.querySelectorAll('[data-clock]') ?? [])].map((el) => el.textContent.trim()),
    statuses: [...(list?.querySelectorAll('li.run[data-run]') ?? [])].map((li) => li.dataset.status),
  };
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-activity-ui-'));
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

describe('📋 Aktivitas per agent', { skip: SKIP ?? false }, () => {
  describeArea('UI Aktivitas tim', { skip: SKIP ?? false }, () => {
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

    it('demo: satu baris per agent, langkah bisa dibuka-tutup, tanpa error konsol', async () => {
      await page.click('#btn-demo');
      await page.click('.tabs button[data-tab="activity"]');
      await page.waitFor(() => document.querySelector('#activity li.run[data-run]'), { timeoutMs: 20_000, message: 'run pertama tampil' });
      const view = await page.eval(runsView);
      assert.equal(view.visible, true, 'panel Aktivitas terlihat');
      assert.ok(view.count >= 1, `minimal satu run (dapat ${view.count})`);
      assert.ok(view.first.role && view.first.role !== 'undefined', `nama role masuk akal (${view.first.role})`);
      assert.match(view.first.state, /berjalan|menunggu|lama|selesai/);
      assert.ok(['true', 'false'].includes(view.first.expanded));
      assert.ok(view.first.steps >= 1, 'langkah ada di dalam run');
      assert.ok(view.clocks.every((c) => /^\d+:\d{2}$/.test(c)), `jam m:ss (${view.clocks.join(', ')})`);
      assert.ok(view.statuses.every((s) => ['running', 'waiting', 'slow', 'done'].includes(s)), 'status eksplisit');

      // The header is a real disclosure control: one click flips the steps.
      const before = view.first.expanded;
      await page.click('#activity li.run[data-run] [data-run-toggle]');
      const afterClick = await page.eval(() => document.querySelector('#activity li.run[data-run] [data-run-toggle]')?.getAttribute('aria-expanded'));
      assert.notEqual(afterClick, before, 'klik membalik aria-expanded');
      const hidden = await page.eval(() => document.querySelector('#activity li.run[data-run] .run-steps')?.hidden ?? false);
      assert.equal(hidden, afterClick === 'false', 'langkah mengikuti aria-expanded');

      assert.deepEqual(page.problems, [], 'tanpa error konsol');
    });

    it('baris tunggu antar-langkah: tampil saat giliran hidup tanpa langkah berjalan, hilang saat selesai', async () => {
      // Force the one window that matters: busy, but no step running (the gap between steps).
      await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), busy: true, working: {}, tasks: [] };
        state.events[state.active] = [];
        (await import('/js/features/activity.js')).renderActivity();
        (await import('/js/features/chat.js')).paintChatWaiting();
      });
      const on = await page.eval(() => ({
        activity: document.querySelector('#activity li.activity-waiting')?.textContent.trim() ?? '',
        chat: document.querySelector('#chat .chat-waiting')?.textContent.trim() ?? '',
      }));
      assert.match(on.activity, /menyusun langkah berikutnya/, 'baris tunggu di Aktivitas');
      assert.match(on.chat, /menyusun langkah berikutnya/, 'baris tunggu di chat');

      // A running step means the wait row must go away (the step itself shows progress).
      await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        state.events[state.active] = [{ kind: 'tool_start', role: 'backend', ts: Date.now() }];
        (await import('/js/features/activity.js')).renderActivity();
      });
      const gone = await page.eval(() => Boolean(document.querySelector('#activity li.activity-waiting')));
      assert.equal(gone, false, 'baris tunggu hilang saat ada langkah berjalan');

      // Turn ended: neither row remains, and the plain placeholder is back.
      await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), busy: false };
        state.events[state.active] = [];
        (await import('/js/features/activity.js')).renderActivity();
        (await import('/js/features/chat.js')).paintChatWaiting();
      });
      const off = await page.eval(() => ({
        wait: Boolean(document.querySelector('#activity li.activity-waiting')),
        chat: Boolean(document.querySelector('#chat .chat-waiting')),
        empty: document.querySelector('#activity li.activity-empty')?.textContent ?? '',
      }));
      assert.deepEqual({ wait: off.wait, chat: off.chat }, { wait: false, chat: false }, 'tidak ada baris tunggu saat giliran selesai');
      assert.match(off.empty, /Belum ada aktivitas/, 'placeholder biasa kembali');
      assert.deepEqual(page.problems, [], 'tanpa error konsol');
    });
  });
});
