/* global document -- functions passed to page.eval run in the browser */
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
];

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

const card = (page) => page.waitFor(() => document.querySelector('.approval.pending'), { timeoutMs: 10000, message: 'kartu rencana' });

for (const vp of VIEWPORTS) {
  describe(`Rencana — ${vp.name}`, () => {
    test('3 aksi: Selesai tidak build, Minta revisi mengirim catatan, Lanjut build masuk build', async () => {
      const page = await browser.newPage({ width: vp.width, height: vp.height, mobile: vp.mobile });
      try {
        page.clearProblems();
        await page.goto(`${BASE}/#${projectId}`);
        await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok') && document.querySelector('#prompt'), { timeoutMs: 10000, message: 'app ready' });
        await send(page, 'buat rencana');
        await card(page);
        assert.deepEqual(await page.eval(() => [...document.querySelectorAll('.approval.pending .ap-actions [data-act]')].map((b) => b.textContent.trim())), ['▶ Lanjut build', 'Minta revisi', 'Selesai']);
        assert.equal(await page.eval(() => Boolean(document.querySelector('.approval.pending .plan-mode select'))), true, 'Claude picks the work mode');

        const users = await page.eval(() => document.querySelectorAll('.msg.user').length);
        await page.eval(() => document.querySelector('.approval.pending [data-act="finish"]').click());
        await page.waitFor(() => document.querySelector('.approval.cancelled'), { timeoutMs: 8000, message: 'kartu dibatalkan' });
        await sleep(400);
        assert.equal(await page.eval(() => document.querySelectorAll('.msg.user').length), users, 'Selesai sends no prompt');

        await send(page, 'buat rencana revisi');
        await card(page);
        await page.eval(() => {
          document.querySelector('.approval.pending .feedback').value = 'tambahkan lisensi';
          document.querySelector('.approval.pending [data-act="deny"]').click();
        });
        await page.waitFor(() => document.querySelector('.approval.denied'), { timeoutMs: 8000, message: 'revisi dikirim (plan ditolak)' });

        await send(page, 'buat rencana build');
        await card(page);
        await page.eval(() => document.querySelector('.approval.pending [data-act="build"]').click());
        await page.waitFor(() => document.querySelector('.approval.allowed'), { timeoutMs: 8000, message: 'rencana disetujui' });
        assert.equal(await page.eval(horizontalOverflow), false);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });
  });
}
