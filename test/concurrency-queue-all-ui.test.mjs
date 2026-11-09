/* global document, window -- functions passed to page.eval run in the browser */
// 🌐 Semua antrian (features/queue-all.js) against the real server, fake Claude and a headless Chrome/Edge:
// opened from the Antrian dialog, it lists the running item first, then the waiting items by their GLOBAL position,
// shows a paused queue as "dijeda", cancels a waiting item (queue-remove), opens that project's Antrian dialog from
// "Buka", and follows the `queue` event while it stays open. Without Chrome/Edge the whole file is skipped.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TMP;
let DATA;
let BASE;
let server;
let browser;
let token;
let A; // holds the only slot with a waiting permission prompt
let B; // first waiting item, cancelled from the global list
let C; // second waiting item, opened from "Buka"
let D; // a paused queue with a waiting item

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function api(p, body = {}) {
  return fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office-Token': token },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

const queueOf = async (id) => (await api(`/api/projects/${id}/queue`)).body.queue;

/** Polls with a hard deadline (100 ms steps); never a blind sleep. */
async function until(pred, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await pred();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}

/** The first SSE frame is the snapshot: the server state the page starts from. */
async function snapshot() {
  const res = await fetch(`${BASE}/stream`, { signal: AbortSignal.timeout(10000) });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

function appReady() {
  const conn = document.querySelector('#conn');
  return conn?.classList.contains('ok') && document.querySelector('#crumb')?.textContent.trim().length > 0;
}

async function openApp(page, projectId) {
  page.clearProblems();
  await page.setViewport({ width: 1440, height: 900, mobile: false }); // the session bar (📋 chip) is desktop layout
  await page.goto(`${BASE}/#${projectId}`);
  await page.waitFor(appReady, { timeoutMs: 30000, message: 'app terhubung (#conn.ok) dan header terisi' });
}

/** Headless Chrome pauses requestAnimationFrame in a hidden tab; bring the tab that is read to the front first. */
async function show(page) {
  await page.send('Page.bringToFront');
  await page.waitFor(() => document.visibilityState === 'visible', { timeoutMs: 5000, message: 'tab terlihat' });
}

/** What the global list shows, row by row. */
function queueAllRows() {
  return [...document.querySelectorAll('#queue-all-list .queue-all-row')].map((row) => ({
    project: row.dataset.project,
    cls: row.className,
    pos: row.querySelector('.queue-all-pos')?.textContent.trim() ?? '',
    status: row.querySelector('.queue-all-status')?.textContent.trim() ?? '',
    text: row.querySelector('.queue-all-text')?.textContent ?? '',
    eta: row.querySelector('.queue-all-eta')?.textContent ?? null,
  }));
}

/** Stops every turn, empties every queue and restores the default limit (a clean office for the next run). */
async function resetOffice() {
  for (const id of [A, B, C, D]) await api(`/api/projects/${id}/stop`).catch(() => {});
  await until(
    async () => {
      const snap = await snapshot();
      return [A, B, C, D].every((id) => !snap.statuses[id]?.busy);
    },
    'semua project idle',
    15000,
  ).catch(() => {});
  for (const id of [A, B, C, D]) {
    for (let i = 0; i < 30; i += 1) {
      const items = (await queueOf(id).catch(() => null))?.items ?? [];
      if (!items.length) break;
      for (const item of items) await api(`/api/projects/${id}/queue-remove`, { itemId: item.id }).catch(() => {});
      await sleep(100);
    }
  }
  await api(`/api/projects/${D}/queue-pause`, { paused: false }).catch(() => {});
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 3 })).status, 200);
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-queue-all-ui-'));
  DATA = path.join(TMP, 'data');
  const projects = path.join(TMP, 'projects');
  for (const name of ['toko', 'blog', 'catatan', 'arsip']) mkdirSync(path.join(projects, name), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'), { recursive: true });
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: DATA,
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      OFFICE_OPEN_DRY_RUN: '1',
      OFFICE_UPDATE_CHECK: '0',
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  server.stderr.resume();
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  const snap = await snapshot();
  A = snap.projects.find((p) => p.name === 'toko')?.id;
  B = snap.projects.find((p) => p.name === 'blog')?.id;
  C = snap.projects.find((p) => p.name === 'catatan')?.id;
  D = snap.projects.find((p) => p.name === 'arsip')?.id;
  assert.ok(A && B && C && D, 'project toko + blog + catatan + arsip');
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    try {
      await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: '{}' });
      await Promise.race([new Promise((r) => server.once('exit', r)), sleep(3000)]);
    } catch {
      // best effort
    }
  }
  server?.kill();
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('🌐 Semua antrian: urutan global, dijeda, Batal, Buka, dan auto-refresh event queue', { skip: SKIP ?? false, timeout: 120000 }, async () => {
  await resetOffice();
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 1 })).status, 200);
  const page = await browser.newPage({ width: 1440, height: 900, mobile: false });
  try {
    await openApp(page, B);
    // A holds the only slot with a permission prompt (it never ends on its own), so B/C/D stay queued.
    assert.equal((await api(`/api/projects/${A}/queue-add`, { text: 'izin pemegang slot' })).status, 200);
    await until(async () => (await queueOf(A)).items[0]?.status === 'running', 'item A berjalan');
    assert.equal((await api(`/api/projects/${B}/queue-add`, { text: 'halo B' })).status, 200);
    assert.equal((await api(`/api/projects/${C}/queue-add`, { text: 'halo C' })).status, 200);
    assert.equal((await api(`/api/projects/${D}/queue-pause`, { paused: true })).status, 200);
    assert.equal((await api(`/api/projects/${D}/queue-add`, { text: 'arsip menunggu' })).status, 200);

    // Open the Antrian dialog from the session chip, then 🌐 Semua there.
    await show(page);
    await page.waitFor(() => !document.querySelector('#sb-queue').hidden, { timeoutMs: 15000, message: 'chip 📋 tampil untuk B' });
    await page.click('#sb-queue');
    await page.waitFor(() => !document.querySelector('#queue-modal').hidden, { timeoutMs: 10000, message: 'dialog Antrian terbuka' });
    await page.click('#queue-all-open');
    await page.waitFor(() => !document.querySelector('#queue-all-modal').hidden && document.querySelectorAll('#queue-all-list .queue-all-row').length === 4, {
      timeoutMs: 15000,
      message: '4 baris semua antrian',
    });

    const rows = await page.eval(queueAllRows);
    assert.deepEqual(rows.map((r) => r.project), [A, B, C, D], 'berjalan dulu, lalu menunggu sesuai posisi global, lalu yang tidak bisa start');
    assert.match(rows[0].cls, /\brunning\b/);
    assert.equal(rows[0].status, 'berjalan');
    assert.equal(rows[0].pos, '▶');
    assert.equal(rows[1].pos, '#1', 'B adalah yang pertama menunggu');
    assert.equal(rows[1].status, 'menunggu');
    assert.equal(rows[2].pos, '#2', 'C menunggu di belakang B (posisi global)');
    assert.equal(rows[3].status, 'dijeda');
    assert.equal(rows[3].pos, '⏸');
    assert.match(rows[3].cls, /\bpaused\b/);
    assert.equal(rows[3].text, 'arsip menunggu');

    const summary = await page.eval(() => document.querySelector('#queue-all-summary').textContent);
    assert.match(summary, /^3 menunggu · 1 berjalan/, 'N menunggu · M berjalan');
    assert.match(summary, /1 antrian dijeda/);

    // Batal on B's waiting row: the server removes the item and the list is read again.
    await page.eval(() => {
      window.confirm = () => true;
    });
    await page.click(`li.queue-all-row[data-project="${B}"] button[data-qa="cancel"]`);
    await page.waitFor((project) => !document.querySelector(`li.queue-all-row[data-project="${project}"]`), { timeoutMs: 15000, message: 'baris B hilang' }, B);
    await page.waitFor(() => document.querySelectorAll('#queue-all-list .queue-all-row').length === 3, { timeoutMs: 15000, message: 'daftar ter-refresh (3 baris)' });
    assert.deepEqual((await queueOf(B)).items, [], 'item B benar-benar dihapus dari antrian');
    const afterCancel = await page.eval(queueAllRows);
    assert.equal(afterCancel.find((r) => r.project === C).pos, '#1', 'C bergeser ke posisi pertama');

    // Buka opens that project's Antrian dialog.
    await page.click(`li.queue-all-row[data-project="${C}"] button[data-qa="open"]`);
    await page.waitFor(
      () => document.querySelector('#queue-all-modal').hidden && !document.querySelector('#queue-modal').hidden && document.querySelector('#queue-project').textContent.includes('catatan'),
      { timeoutMs: 10000, message: 'dialog Antrian project catatan terbuka' },
    );

    // Auto-refresh: the dialog follows the `queue` event while it stays open.
    await page.click('#queue-all-open');
    await page.waitFor(() => !document.querySelector('#queue-all-modal').hidden && document.querySelectorAll('#queue-all-list .queue-all-row').length === 3, {
      timeoutMs: 10000,
      message: 'semua antrian terbuka lagi',
    });
    assert.equal((await api(`/api/projects/${C}/queue-add`, { text: 'tambah otomatis' })).status, 200);
    await page.waitFor(
      () => [...document.querySelectorAll('#queue-all-list .queue-all-text')].some((n) => n.textContent === 'tambah otomatis'),
      { timeoutMs: 15000, message: 'item baru muncul tanpa membuka ulang dialog' },
    );
    const added = (await queueOf(C)).items.find((i) => i.text === 'tambah otomatis');
    assert.ok(added, 'item baru ada di API');
    assert.equal((await api(`/api/projects/${C}/queue-remove`, { itemId: added.id })).status, 200);
    await page.waitFor(() => ![...document.querySelectorAll('#queue-all-list .queue-all-text')].some((n) => n.textContent === 'tambah otomatis'), {
      timeoutMs: 15000,
      message: 'item yang dihapus hilang dari daftar',
    });

    // ⏸ Jeda semua / ▶ Lanjutkan semua from the dialog: the label flips with the state and the list follows.
    await page.eval(() => {
      window.confirm = () => true;
    });
    assert.equal(await page.eval(() => document.querySelector('#queue-all-pause').textContent.trim()), '⏸ Jeda semua');
    await page.click('#queue-all-pause');
    await page.waitFor(() => /antrian dijeda/.test(document.querySelector('#queue-all-summary').textContent), { timeoutMs: 15000, message: 'semua antrian dijeda' });
    await page.waitFor(() => document.querySelector('#queue-all-pause').textContent.includes('Lanjutkan semua'), { timeoutMs: 15000, message: 'tombol berubah jadi lanjutkan' });
    await page.click('#queue-all-pause');
    await page.waitFor(() => !/antrian dijeda/.test(document.querySelector('#queue-all-summary').textContent), { timeoutMs: 15000, message: 'semua antrian dilanjutkan' });

    assert.deepEqual(page.problems, [], 'tanpa error konsol/HTTP');
  } finally {
    await api(`/api/projects/${A}/stop`).catch(() => {});
    await api(`/api/projects/${B}/stop`).catch(() => {});
    await api(`/api/projects/${C}/stop`).catch(() => {});
    await api(`/api/projects/${D}/stop`).catch(() => {});
    await api('/api/concurrency/save', { maxConcurrent: 3 }).catch(() => {});
    await page.close();
  }
});
