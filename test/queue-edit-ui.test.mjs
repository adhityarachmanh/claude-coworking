/* global document, window -- functions passed to page.eval run in the browser */
// Queue v3 in a real browser (Chrome/Edge + fake Claude):
//   1. a waiting bubble shows the server's ETA ("antre #N · ±X mnt") from the recorded turn durations, and loses the
//      tag when its turn starts; the item behind it moves up and gets its own estimate.
//   2. "Edit" on a queued bubble opens #queue-edit-modal with the text, Simpan → queue-update rewrites the item and
//      the SAME bubble (one bubble, no extra item); empty text is refused without a request; the read-only (WiFi)
//      policy disables Simpan while Batal stays usable.
// The state.json is seeded with finished items carrying meta.durationMs (A 30s, B 60s, C 30s): the estimate is
// deterministic instead of waiting for a real long turn — and it covers both wordings (a < 60 s wait is "sebentar",
// a >= 60 s wait is "±N mnt"). Without Chrome/Edge the whole file is skipped.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';
import { projectId } from '../src/util.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TMP;
let DATA;
let BASE;
let server;
let browser;
let token;
let A;
let B;
let C;

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
  await page.setViewport({ width: 1440, height: 900, mobile: false });
  await page.goto(`${BASE}/#${projectId}`);
  await page.waitFor(appReady, { timeoutMs: 30000, message: 'app terhubung (#conn.ok) dan header terisi' });
}

/** Headless Chrome pauses requestAnimationFrame in a hidden tab; bring the tab that is read to the front first. */
async function show(page) {
  await page.send('Page.bringToFront');
  await page.waitFor(() => document.visibilityState === 'visible', { timeoutMs: 5000, message: 'tab terlihat' });
}

const rowSel = (chatId) => `#chat > [data-id="${chatId}"]`;

/** What one user bubble shows on screen (tags, edit action, the queued class, its text). */
function bubbleView(sel) {
  const row = document.querySelector(sel);
  if (!row) return null;
  return {
    text: row.querySelector('.body')?.textContent ?? '',
    tags: [...row.querySelectorAll('.meta .tag')].map((t) => t.textContent.trim()),
    queued: row.classList.contains('queued'),
    edit: Boolean(row.querySelector('[data-msg-act="edit"]')),
    sameTextBubbles: [...document.querySelectorAll('#chat .msg.user .body')].filter((n) => n.textContent === (row.querySelector('.body')?.textContent ?? '')).length,
  };
}

/** Stops every turn, drops the waiting/running items (the finished seeds with their durations stay), resets the limit. */
async function resetOffice() {
  for (const id of [A, B, C]) await api(`/api/projects/${id}/stop`).catch(() => {});
  await until(
    async () => {
      const snap = await snapshot();
      return [A, B, C].every((id) => !snap.statuses[id]?.busy);
    },
    'semua project idle',
    15000,
  ).catch(() => {});
  for (const id of [A, B, C]) {
    await api(`/api/projects/${id}/queue-pause`, { paused: false }).catch(() => {});
    for (let i = 0; i < 30; i += 1) {
      const items = (await queueOf(id).catch(() => null))?.items ?? [];
      const live = items.filter((item) => item.status === 'waiting' || item.status === 'running');
      if (!live.length) break;
      for (const item of live) await api(`/api/projects/${id}/queue-remove`, { itemId: item.id }).catch(() => {});
      await sleep(100);
    }
  }
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 3 })).status, 200);
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-queue-edit-ui-'));
  DATA = path.join(TMP, 'data');
  const projects = path.join(TMP, 'projects');
  for (const name of ['toko', 'blog', 'catatan']) mkdirSync(path.join(projects, name), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'), { recursive: true });
  mkdirSync(DATA, { recursive: true });
  const toko = projectId(path.join(projects, 'toko'));
  const blog = projectId(path.join(projects, 'blog'));
  const catatan = projectId(path.join(projects, 'catatan'));
  const now = Date.now();
  const finished = (id, text, durationMs) => ({ id, text, status: 'done', createdAt: now - 120_000, endedAt: now - 60_000, meta: { durationMs } });
  // A turn already finished with its duration: typicalTurnMs() reads these after a restart, so the ETA is known.
  writeFileSync(
    path.join(DATA, 'state.json'),
    JSON.stringify({
      queues: {
        [toko]: { paused: false, items: [finished('q_aaaaaaaaaa01', 'kerja lama toko', 30_000)] },
        [blog]: { paused: false, items: [finished('q_bbbbbbbbbb01', 'kerja lama blog', 60_000)] },
        [catatan]: { paused: false, items: [finished('q_cccccccccc01', 'kerja lama catatan', 30_000)] },
      },
    }),
  );
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
  assert.ok(A && B && C, 'project toko + blog + catatan');
  assert.equal(A, toko);
  assert.equal(B, blog);
  assert.equal(C, catatan);
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

test('bubble antre menampilkan ETA dari durasi giliran (± mnt) dan kehilangan tag saat mulai berjalan', { skip: SKIP ?? false, timeout: 120000 }, async () => {
  await resetOffice();
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 1 })).status, 200);
  const pageB = await browser.newPage();
  const pageC = await browser.newPage();
  try {
    await Promise.all([openApp(pageB, B), openApp(pageC, C)]);
    // A holds the only slot with a permission prompt (never ends alone): B and C must wait.
    assert.equal((await api(`/api/projects/${A}/prompt`, { text: 'izin pemegang slot' })).status, 200);
    await until(async () => (await snapshot()).statuses[A]?.busy === true, 'A memegang slot', 15000);

    const b = await api(`/api/projects/${B}/prompt`, { text: 'halo lama eta B' }); // "lama" = ~10 s once it starts
    const c = await api(`/api/projects/${C}/prompt`, { text: 'halo eta C' });
    assert.deepEqual([b.status, c.status], [200, 200]);
    assert.equal(b.body.queued, true);
    assert.equal(c.body.queued, true);
    const chatB = b.body.chatId;
    const chatC = c.body.chatId;

    // Position 1: the rest of A's 30 s typical turn → "sebentar" (0…59 s). Position 2: that plus B's 60 s → ±2 mnt.
    await show(pageB);
    await pageB.waitFor(
      (sel) => [...document.querySelectorAll(`${sel} .meta .tag`)].some((t) => /^antre #1 · sebentar$/.test(t.textContent.trim())),
      { timeoutMs: 20000, message: 'bubble B: antre #1 · sebentar' },
      rowSel(chatB),
    );
    await show(pageC);
    await pageC.waitFor(
      (sel) => [...document.querySelectorAll(`${sel} .meta .tag`)].some((t) => /^antre #2 · ±2 mnt$/.test(t.textContent.trim())),
      { timeoutMs: 20000, message: 'bubble C: antre #2 · ±2 mnt' },
      rowSel(chatC),
    );
    assert.equal((await pageB.eval(bubbleView, rowSel(chatB))).queued, true);
    assert.equal((await pageC.eval(bubbleView, rowSel(chatC))).queued, true);

    // A stops: B starts on the SAME bubble and its queue tag disappears (a running turn is not "antre").
    assert.equal((await api(`/api/projects/${A}/stop`)).status, 200);
    await show(pageB);
    await pageB.waitFor(
      (sel) => {
        const row = document.querySelector(sel);
        return row && !row.classList.contains('queued') && ![...row.querySelectorAll('.meta .tag')].some((t) => /^antre\b/.test(t.textContent.trim()));
      },
      { timeoutMs: 30000, message: 'tag antre B hilang saat gilirannya mulai' },
      rowSel(chatB),
    );
    const bRunning = await pageB.eval(bubbleView, rowSel(chatB));
    assert.deepEqual(bRunning.tags, []);
    assert.equal(bRunning.text, 'halo lama eta B', 'bubble yang sama');

    // The item behind it is now #1 and gets its own estimate (B's 60 s typical turn).
    await show(pageC);
    let cTags = [];
    await until(
      async () => {
        cTags = (await pageC.eval(bubbleView, rowSel(chatC))).tags;
        return cTags.some((t) => /^antre #1 · (±1 mnt|sebentar)$/.test(t));
      },
      `bubble C bergeser jadi antre #1 dengan ETA (tags: ${JSON.stringify(cTags)})`,
      20000,
    );

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

test('Edit pada bubble queued: modal terisi, Simpan → queue-update mengubah item + bubble yang sama; kosong/read-only ditolak', { skip: SKIP ?? false, timeout: 120000 }, async () => {
  await resetOffice();
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 1 })).status, 200);
  const page = await browser.newPage();
  try {
    await openApp(page, B);
    assert.equal((await api(`/api/projects/${A}/prompt`, { text: 'izin pemegang slot' })).status, 200);
    await until(async () => (await snapshot()).statuses[A]?.busy === true, 'A memegang slot', 15000);

    const queued = await api(`/api/projects/${B}/prompt`, { text: 'halo antri B' });
    assert.equal(queued.body.queued, true);
    const chatB = queued.body.chatId;
    const itemId = queued.body.queueItem;
    // Paused after it joined the queue: it stays editable for as long as the test needs, and never starts mid-check.
    assert.equal((await api(`/api/projects/${B}/queue-pause`, { paused: true })).status, 200);

    await show(page);
    await page.waitFor(
      (sel) => {
        const row = document.querySelector(sel);
        return row?.classList.contains('queued') && Boolean(row.querySelector('[data-msg-act="edit"]'));
      },
      { timeoutMs: 20000, message: 'bubble B queued dengan tombol Edit' },
      rowSel(chatB),
    );
    const before = await page.eval(bubbleView, rowSel(chatB));
    assert.equal(before.text, 'halo antri B');
    assert.equal(before.sameTextBubbles, 1);

    // Edit opens the dialog with the prompt filled in.
    await page.click(`${rowSel(chatB)} [data-msg-act="edit"]`);
    await page.waitFor(() => !document.querySelector('#queue-edit-modal').hidden, { timeoutMs: 10000, message: 'modal edit antrian terbuka' });
    assert.equal(await page.eval(() => document.querySelector('#queue-edit-text').value), 'halo antri B');

    // Simpan → queue-update; the item and the SAME bubble change, no extra item/bubble.
    await page.eval(() => {
      const input = document.querySelector('#queue-edit-text');
      input.value = 'halo antri B sudah diubah';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#queue-edit-save');
    await page.waitFor(() => document.querySelector('#queue-edit-modal').hidden, { timeoutMs: 10000, message: 'modal tertutup setelah simpan' });
    await until(async () => (await queueOf(B)).items.find((i) => i.id === itemId)?.text === 'halo antri B sudah diubah', 'item antrian berubah teks');
    const view = await queueOf(B);
    assert.equal(view.items.filter((i) => i.status === 'waiting' || i.status === 'running').length, 1, 'jumlah item tidak bertambah');

    await show(page);
    await page.waitFor(
      (sel) => document.querySelector(sel)?.querySelector('.body')?.textContent === 'halo antri B sudah diubah',
      { timeoutMs: 15000, message: 'bubble yang sama ikut berubah' },
      rowSel(chatB),
    );
    const after = await page.eval(bubbleView, rowSel(chatB));
    assert.equal(after.queued, true, 'masih menunggu, bukan bubble baru');
    assert.equal(after.text, 'halo antri B sudah diubah');
    assert.equal(after.sameTextBubbles, 1, 'tepat satu bubble user dengan teks baru');
    assert.equal(
      await page.eval(() => [...document.querySelectorAll('#chat .msg.user .body')].filter((n) => n.textContent === 'halo antri B').length),
      0,
      'teks lama tidak tersisa di bubble lain',
    );

    // Empty text: refused in the UI, no queue-update request at all.
    await page.click(`${rowSel(chatB)} [data-msg-act="edit"]`);
    await page.waitFor(() => !document.querySelector('#queue-edit-modal').hidden, { timeoutMs: 10000, message: 'modal edit terbuka lagi' });
    await page.eval(() => {
      window.__queueUpdateCalls = 0;
      const real = window.fetch;
      window.fetch = (...args) => {
        if (String(args[0]).includes('queue-update')) window.__queueUpdateCalls += 1;
        return real(...args);
      };
      const input = document.querySelector('#queue-edit-text');
      input.value = '   ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#queue-edit-save');
    await page.waitFor(() => !document.querySelector('#queue-edit-error').hidden, { timeoutMs: 5000, message: 'error prompt kosong tampil' });
    assert.equal(await page.eval(() => document.querySelector('#queue-edit-error').textContent), 'Prompt belum diisi.');
    assert.equal(await page.eval(() => document.querySelector('#queue-edit-modal').hidden), false, 'modal tetap terbuka');
    assert.equal(await page.eval(() => window.__queueUpdateCalls), 0, 'tidak ada request queue-update');
    assert.equal((await queueOf(B)).items.find((i) => i.id === itemId)?.text, 'halo antri B sudah diubah', 'teks tidak berubah');

    // Read-only (a WiFi phone): Simpan disabled with the hint, Batal still there, and no request goes out.
    await page.eval(async () => {
      const mod = await import('/js/core/state.js');
      mod.state.readOnly = true;
    });
    await page.click('#queue-edit-cancel');
    await page.click(`${rowSel(chatB)} [data-msg-act="edit"]`);
    await page.waitFor(() => !document.querySelector('#queue-edit-modal').hidden, { timeoutMs: 10000, message: 'modal edit terbuka (read-only)' });
    const policy = await page.eval(() => ({
      saveDisabled: document.querySelector('#queue-edit-save').disabled,
      saveTitle: document.querySelector('#queue-edit-save').title,
      cancelDisabled: document.querySelector('#queue-edit-cancel').disabled,
    }));
    assert.equal(policy.saveDisabled, true, 'Simpan nonaktif saat hanya-lihat');
    assert.match(policy.saveTitle, /Hanya lihat lewat WiFi/);
    assert.equal(policy.cancelDisabled, false, 'Batal tetap bisa menutup dialog');
    await page.eval(() => document.querySelector('#queue-edit-save').click()); // a disabled button fires no click
    await page.waitFor(() => document.querySelector('#queue-edit-modal').hidden === false, { timeoutMs: 2000, message: 'modal tetap terbuka' });
    assert.equal(await page.eval(() => window.__queueUpdateCalls), 0, 'tidak ada request dari mode hanya-lihat');

    assert.deepEqual(page.problems, [], 'tanpa error konsol/HTTP');
  } finally {
    await page.eval(async () => {
      const mod = await import('/js/core/state.js');
      mod.state.readOnly = false;
    }).catch(() => {});
    await api(`/api/projects/${A}/stop`).catch(() => {});
    await api(`/api/projects/${B}/stop`).catch(() => {});
    await api(`/api/projects/${B}/queue-pause`, { paused: false }).catch(() => {});
    await api('/api/concurrency/save', { maxConcurrent: 3 }).catch(() => {});
    await page.close();
  }
});
