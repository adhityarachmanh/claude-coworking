/* global document -- functions passed to page.eval run in the browser */
// Chat bubbles of a prompt that joined 📋 Antrian at the global turn limit, against the real server and fake Claude:
//   "antre #N" + ✕ Batal while it waits, Batal → dibatalkan (the button goes away), the item behind it becomes #1,
//   and the start of the turn patches the SAME bubble (no second user bubble, no old "Batas … masuk antrian" line).
// A browser is needed (CDP); without Chrome/Edge the whole file is skipped.
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
let A; // holds the only slot with a long turn
let B; // queued first, then cancelled from its bubble
let C; // queued second, then starts when A stops

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

/** Polls the server until `pred(snapshot)` holds, with a hard deadline (never a long blind sleep). */
async function untilSnapshot(pred, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const snap = await snapshot();
    const value = pred(snap);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(150);
  }
}

function appReady() {
  const conn = document.querySelector('#conn');
  return conn?.classList.contains('ok') && document.querySelector('#crumb')?.textContent.trim().length > 0;
}

async function openApp(page, projectId) {
  page.clearProblems();
  await page.goto(`${BASE}/#${projectId}`);
  await page.waitFor(appReady, { timeoutMs: 30000, message: 'app terhubung (#conn.ok) dan header terisi' });
}

/** Stops every turn and restores the default limit, so the next test starts from a clean office. */
async function resetOffice() {
  for (const id of [A, B, C]) await api(`/api/projects/${id}/stop`).catch(() => {});
  await untilSnapshot(
    (snap) => [A, B, C].every((id) => !snap.statuses[id]?.busy),
    'semua project idle',
    15000,
  ).catch(() => {});
  for (const id of [B, C]) {
    for (let i = 0; i < 40; i += 1) {
      const items = (await api(`/api/projects/${id}/queue`)).body.queue?.items ?? [];
      if (!items.length) break;
      for (const item of items) await api(`/api/projects/${id}/queue-remove`, { itemId: item.id }).catch(() => {});
      await sleep(150);
    }
  }
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 3 })).status, 200);
}

const rowSel = (chatId) => `#chat > [data-id="${chatId}"]`;

/**
 * Headless Chrome keeps only one tab visible, and a hidden tab pauses requestAnimationFrame — which is how the chat
 * redraws a patched row. Bring the tab that is read to the front first (a real browser does this when you switch).
 */
async function show(page) {
  await page.send('Page.bringToFront');
  await page.waitFor(() => document.visibilityState === 'visible', { timeoutMs: 5000, message: 'tab terlihat' });
}

/** What one user bubble shows on screen (tags, the cancel button, the queued/cancelled classes). */
function bubbleView(sel) {
  const row = document.querySelector(sel);
  if (!row) return null;
  const button = row.querySelector('button.queue-cancel');
  return {
    text: row.querySelector('.body')?.textContent ?? '',
    tags: [...row.querySelectorAll('.meta .tag')].map((t) => t.textContent.trim()),
    cancel: Boolean(button),
    cancelLabel: button?.getAttribute('aria-label') ?? null,
    queued: row.classList.contains('queued'),
    cancelled: row.classList.contains('cancelled'),
    sameUserBubbles: [...document.querySelectorAll('#chat .msg.user')].filter((n) => n.querySelector('.body')?.textContent === row.querySelector('.body')?.textContent).length,
    limitInfoLines: [...document.querySelectorAll('#chat .info')].filter((n) => /Batas .*masuk antrian/.test(n.textContent ?? '')).length,
  };
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-queue-bubble-ui-'));
  DATA = path.join(TMP, 'data');
  const projects = path.join(TMP, 'projects');
  for (const name of ['toko', 'blog', 'catatan']) mkdirSync(path.join(projects, name), { recursive: true });
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
      OFFICE_EFFORT_FAKE: 'high',
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
  assert.ok(A && B && C, 'project toko + blog + catatan');
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

test('bubble antrian: antre #N + ✕ Batal, Batal → dibatalkan, giliran memakai bubble yang sama', { skip: SKIP ?? false, timeout: 120000 }, async () => {
  await resetOffice();
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 1 })).status, 200);
  const pageB = await browser.newPage({ width: 1440, height: 900, mobile: false });
  const pageC = await browser.newPage({ width: 1440, height: 900, mobile: false });
  try {
    // Both chats are opened first (the bubbles arrive live): the pages are warm, so the whole cancel round-trip
    // stays well inside A's long turn (~10 s of streamed text).
    await Promise.all([openApp(pageB, B), openApp(pageC, C)]);

    // A holds the only slot with a long turn, so B and C have to wait.
    const held = await api(`/api/projects/${A}/prompt`, { text: 'lama pemegang slot' });
    assert.equal(held.status, 200);
    assert.equal(held.body.queued, undefined, 'giliran A langsung berjalan');
    await untilSnapshot((snap) => snap.statuses[A]?.busy === true, 'A memegang slot', 15000);

    const b = await api(`/api/projects/${B}/prompt`, { text: 'halo antri B' });
    const c = await api(`/api/projects/${C}/prompt`, { text: 'halo antri C' });
    assert.deepEqual([b.status, c.status], [200, 200], 'tidak ada prompt yang hilang');
    assert.equal(b.body.queued, true, 'prompt B masuk antrian');
    assert.equal(c.body.queued, true, 'prompt C masuk antrian');
    assert.equal(typeof b.body.chatId, 'string');
    assert.equal(typeof c.body.chatId, 'string');
    const chatB = b.body.chatId;
    const chatC = c.body.chatId;

    // B: ONE user bubble with a visible place in the line and the ✕ Batal button.
    await show(pageB);
    await pageB.waitFor(
      (sel) => {
        const row = document.querySelector(sel);
        return row && [...row.querySelectorAll('.meta .tag')].some((t) => /^antre #\d+$/.test(t.textContent.trim())) && row.querySelector('button.queue-cancel');
      },
      { timeoutMs: 20000, message: 'bubble B bertag antre + tombol Batal' },
      rowSel(chatB),
    );
    const bWaiting = await pageB.eval(bubbleView, rowSel(chatB));
    assert.deepEqual(bWaiting.tags, ['antre #1'], 'B adalah yang pertama menunggu di projectnya');
    assert.equal(bWaiting.cancel, true, 'tombol Batal tampil selama menunggu');
    assert.match(bWaiting.cancelLabel, /Batalkan item antrian/);
    assert.equal(bWaiting.queued, true, 'bubble ditandai queued (gaya "belum berjalan")');
    assert.equal(bWaiting.cancelled, false);
    assert.equal(bWaiting.text, 'halo antri B');
    assert.equal(bWaiting.sameUserBubbles, 1, 'tepat satu bubble user untuk prompt B');

    // C: its own bubble waits too. Its global number (#2 while B is ahead) is asserted by concurrency-flow.test.mjs.
    await show(pageC);
    await pageC.waitFor(
      (sel) => {
        const row = document.querySelector(sel);
        return row && [...row.querySelectorAll('.meta .tag')].some((t) => /^antre #\d+$/.test(t.textContent.trim())) && row.querySelector('button.queue-cancel');
      },
      { timeoutMs: 20000, message: 'bubble C bertag antre + tombol Batal' },
      rowSel(chatC),
    );
    const cWaiting = await pageC.eval(bubbleView, rowSel(chatC));
    assert.match(cWaiting.tags[0], /^antre #\d+$/, 'C menampilkan posisi antre');
    assert.equal(cWaiting.cancel, true);
    assert.equal(cWaiting.text, 'halo antri C');
    assert.equal(cWaiting.sameUserBubbles, 1);

    // ✕ Batal on B's bubble: the server patches that row (no local removal), the button disappears.
    await show(pageB);
    await pageB.click(`${rowSel(chatB)} button.queue-cancel`);
    await pageB.waitFor(
      (sel) => {
        const row = document.querySelector(sel);
        if (!row) return false;
        return (
          [...row.querySelectorAll('.meta .tag')].some((t) => t.textContent.trim() === 'dibatalkan') &&
          !row.querySelector('button.queue-cancel') &&
          !row.classList.contains('queued')
        );
      },
      { timeoutMs: 15000, message: 'bubble B jadi dibatalkan, tombol Batal hilang' },
      rowSel(chatB),
    );
    const bAfter = await pageB.eval(bubbleView, rowSel(chatB));
    assert.deepEqual(bAfter.tags, ['dibatalkan'], 'tag antre diganti "dibatalkan"');
    assert.equal(bAfter.cancel, false);
    assert.equal(bAfter.queued, false);
    assert.equal(bAfter.cancelled, true);
    assert.equal(bAfter.text, 'halo antri B', 'isi bubble tetap');
    assert.equal(bAfter.sameUserBubbles, 1, 'tidak ada bubble kedua saat dibatalkan');

    // The item behind it is now first in line: C's bubble reads antre #1.
    await show(pageC);
    await pageC.waitFor(
      (sel) => {
        const row = document.querySelector(sel);
        return row && [...row.querySelectorAll('.meta .tag')].some((t) => t.textContent.trim() === 'antre #1');
      },
      { timeoutMs: 15000, message: 'bubble C bergeser jadi antre #1' },
      rowSel(chatC),
    );

    // A stops: the slot frees and C's turn starts on the SAME bubble (no second user bubble, no "masuk antrian" info).
    assert.equal((await api(`/api/projects/${A}/stop`)).status, 200);
    await pageC.waitFor(
      (sel) => {
        const row = document.querySelector(sel);
        return row && !row.classList.contains('queued') && ![...row.querySelectorAll('.meta .tag')].some((t) => /^antre\b/.test(t.textContent.trim()));
      },
      { timeoutMs: 30000, message: 'bubble C kehilangan tag antre saat gilirannya mulai' },
      rowSel(chatC),
    );
    const cRunning = await pageC.eval(bubbleView, rowSel(chatC));
    assert.deepEqual(cRunning.tags, [], 'tidak ada tag antre lagi');
    assert.equal(cRunning.cancel, false, 'tombol Batal hanya untuk yang menunggu');
    assert.equal(cRunning.queued, false);
    assert.equal(cRunning.cancelled, false);
    assert.equal(cRunning.text, 'halo antri C');
    assert.equal(cRunning.sameUserBubbles, 1, 'giliran memakai bubble yang sama, bukan bubble kedua');
    assert.equal(cRunning.limitInfoLines, 0, 'baris info "Batas … masuk antrian" lama tidak muncul');

    // The cancelled bubble on the other page is untouched by B's turn never having started.
    await show(pageB);
    const bStillThere = await pageB.eval(bubbleView, rowSel(chatB));
    assert.deepEqual(bStillThere.tags, ['dibatalkan']);

    assert.deepEqual(pageB.problems, [], 'tanpa error konsol/HTTP di chat B');
    assert.deepEqual(pageC.problems, [], 'tanpa error konsol/HTTP di chat C');
  } finally {
    await api(`/api/projects/${A}/stop`).catch(() => {});
    await api(`/api/projects/${B}/stop`).catch(() => {});
    await api(`/api/projects/${C}/stop`).catch(() => {});
    await api('/api/concurrency/save', { maxConcurrent: 3 }).catch(() => {});
    await pageB.close();
    await pageC.close();
  }
});
