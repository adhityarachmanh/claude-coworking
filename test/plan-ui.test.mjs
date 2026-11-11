/* global document, location, window -- functions passed to page.eval run in the browser */
// Plan card UI on phone and desktop: Lanjut build / Minta revisi / Selesai, including "finish without build".
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const VIEWPORTS = [
  { name: 'mobile 390x844', width: 390, height: 844, mobile: true },
  { name: 'desktop 1440x900', width: 1440, height: 900, mobile: false },
].filter((vp) => !process.env.OFFICE_PLAN_UI_VIEWPORT || vp.name.includes(process.env.OFFICE_PLAN_UI_VIEWPORT));

let TMP;
let BASE;
let server;
let browser;
let projectId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const horizontalOverflow = () => document.documentElement.scrollWidth > document.documentElement.clientWidth;

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-plan-ui-'));
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPEN_DRY_RUN: '1',
      OFFICE_EFFORT_FAKE: 'high', // Auto is tested without spawning a real classifier
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  server.stderr.resume();
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  projectId = JSON.parse(text.match(/^data: (.*)$/m)[1]).projects.find((p) => p.name === 'toko').id;
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  server?.kill();
  await sleep(400);
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const send = (page, text) =>
  page.eval((t) => {
    const input = document.querySelector('#prompt');
    input.value = t;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#btn-send').click();
  }, text);

/** Remembers which approval cards were already on screen, so a later wait only matches the new one. */
const markPending = (page) => page.eval(() => document.querySelectorAll('.approval.pending').forEach((n) => (n.dataset.old = '1')));

/** Marks the next newly arrived pending card as `[data-target]`, so later queries cannot touch an older one. */
const newCard = (page) =>
  page.waitFor(
    () => {
      const card = [...document.querySelectorAll('.approval.pending')].find((n) => !n.dataset.old);
      if (!card) return false;
      document.querySelectorAll('.approval [data-target]').forEach((n) => delete n.dataset.target);
      card.dataset.target = '1';
      return true;
    },
    { timeoutMs: 10000, message: 'kartu rencana baru' },
  );

/** Clicks an action on the card this test just received (never an older card from another viewport). */
const clickCard = (page, act, feedback = '') =>
  page.eval(
    (action, note) => {
      const card = document.querySelector('.approval.pending[data-target="1"]');
      if (!card) throw new Error('kartu target tidak ada');
      if (note) card.querySelector('.feedback').value = note;
      card.querySelector(`[data-act="${action}"]`).click();
      return { loading: card.querySelector('.plan-preparing')?.textContent ?? '', disabled: [...card.querySelectorAll('button, input, select')].every((b) => b.disabled) };
    },
    act,
    feedback,
  );

/** Settings through the page itself, so it carries the same token the app uses. */
const setSettings = (page, patch) =>
  page.eval(
    async (body) => {
      const token = document.querySelector('meta[name="office-token"]')?.content ?? '';
      const res = await fetch(`/api/projects/${location.hash.slice(1)}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Office-Token': token },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`settings ${res.status}`);
    },
    patch,
  );

/** Waits until the project has no running turn, so the next prompt gets its own Auto classification. */
const idle = (page) =>
  page.waitFor(
    async () => {
      const { state } = await import('/js/core/state.js');
      return !state.statuses[state.active]?.busy;
    },
    { timeoutMs: 10000, message: 'giliran selesai' },
  );

/** Holds an approval response long enough for the loading row to be observable. */
const slowApprovals = (page) =>
  page.eval(() => {
    const orig = window.fetch;
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/api/approvals/')) await new Promise((r) => setTimeout(r, 700));
      return orig(...args);
    };
  });

for (const vp of VIEWPORTS) {
  describe(`Rencana — ${vp.name}`, () => {
    test('3 aksi: Selesai tidak build, Minta revisi mengirim catatan, Lanjut build masuk build', async () => {
      const page = await browser.newPage({ width: vp.width, height: vp.height, mobile: vp.mobile });
      try {
        page.clearProblems();
        await page.goto(`${BASE}/#${projectId}`);
        await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok') && document.querySelector('#prompt'), { timeoutMs: 10000, message: 'app ready' });
        // Each viewport starts from the same manual model/effort: the previous one leaves Auto on.
        await setSettings(page, { modelAuto: false, effortAuto: false, model: 'sonnet', effort: '' });
        await markPending(page);
        await send(page, 'buat rencana');
        await newCard(page);
        assert.deepEqual(await page.eval(() => [...document.querySelectorAll('.approval.pending[data-target="1"] .ap-actions [data-act]')].map((b) => b.textContent.trim())), ['▶ Lanjut build', 'Minta revisi', 'Selesai']);
        assert.equal(await page.eval(() => Boolean(document.querySelector('.approval.pending[data-target="1"] .plan-mode select'))), false, 'no second work-mode dialog: one Build button');
        assert.match(await page.eval(() => document.querySelector('.approval.pending[data-target="1"] .plan-preview')?.textContent ?? ''), /Ubah validasi/, 'the card leads with a short summary');

        const users = await page.eval(() => document.querySelectorAll('.msg.user').length);
        await clickCard(page, 'finish');
        await page.waitFor(() => document.querySelector('.approval.cancelled[data-target="1"]'), { timeoutMs: 8000, message: 'kartu dibatalkan' });
        await sleep(400);
        assert.equal(await page.eval(() => document.querySelectorAll('.msg.user').length), users, 'Selesai sends no prompt');

        await markPending(page);
        await send(page, 'buat rencana revisi');
        await newCard(page);
        await slowApprovals(page);
        assert.match((await clickCard(page, 'deny', 'tambahkan lisensi')).loading, /Mengirim revisi/, 'the revision card shows an animated loading row');
        await page.waitFor(() => document.querySelector('.approval.denied[data-target="1"]'), { timeoutMs: 8000, message: 'revisi dikirim (plan ditolak)' });
        await idle(page); // the revision turn finished: the next prompt is classified, not marked "turn berjalan"

        // Auto on: the build card uses the same loading row, and the bubble says which model/effort was picked.
        await setSettings(page, { modelAuto: true, effortAuto: true });
        await markPending(page);
        await send(page, 'buat rencana build');
        await newCard(page);
        const buildClick = await clickCard(page, 'build');
        assert.match(buildClick.loading, /Menentukan model & effort/, 'the build card shows the Auto classifier is running');
        assert.equal(buildClick.disabled, true, 'no double submit while preparing');
        await page.waitFor(() => document.querySelector('.approval.allowed[data-target="1"]'), { timeoutMs: 8000, message: 'rencana disetujui' });
        const tags = await page.waitFor(
          () => {
            const meta = [...document.querySelectorAll('.msg.user .meta')].at(-1);
            return meta && /Model: Kuat/.test(meta.textContent) && /Auto: High/.test(meta.textContent) ? meta.textContent : null;
          },
          { timeoutMs: 8000, message: 'tag Auto di bubble build' },
        );
        assert.match(tags, /Model: Kuat → opus/, 'Claude’s Kuat tier is opus');
        assert.ok(
          await page.waitFor(() => [...document.querySelectorAll('.info')].some((n) => /Auto build: Effort High · Model Kuat → opus/.test(n.textContent)), { timeoutMs: 8000, message: 'info Auto build' }),
          'the chat also has a line with the chosen effort and model',
        );
        assert.equal(await page.eval(horizontalOverflow), false);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });
  });
}
