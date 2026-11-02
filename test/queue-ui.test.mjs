/* global document, window -- functions passed to page.eval run in the browser */
// UI of 📋 Antrian and ⏰ Backup otomatis in a headless Chrome/Edge (test-support/cdp.mjs), phone and desktop:
// add from the composer (button, Alt+Enter), reorder/edit/remove in the dialog, resume and "Lihat hasil";
// the backup schedule form in ⚙ (validation, save, "Jalankan sekarang"). No console errors, no sideways scroll.
// QUEUE_UI_SHOTS=<folder> saves screenshots there (for looking at the layout by hand).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const SHOTS = process.env.QUEUE_UI_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [
  { name: 'mobile 390x844', width: 390, height: 844, mobile: true },
  { name: 'desktop 1440x900', width: 1440, height: 900, mobile: false },
];

let TMP;
let BASE;
let server;
let browser;
let projectId;
let token;

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

const api = (p, body = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const queue = async () => (await api(`/api/projects/${projectId}/queue`)).body.queue;

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-queue-ui-'));
  mkdirSync(path.join(TMP, 'projects', 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'), // never the real Tailscale CLI
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  server.stderr.resume();
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  projectId = JSON.parse(text.match(/^data: (.*)$/m)[1]).projects.find((p) => p.name === 'toko').id;
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

// ---------- in-page probes ----------

/** The page scrolls sideways, or an open dialog's card does. */
function horizontalOverflow() {
  const { scrollWidth, clientWidth } = document.documentElement;
  const cards = [...document.querySelectorAll('.modal:not([hidden]) .modal-card')].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => `${c.parentElement.id}: ${c.scrollWidth} > ${c.clientWidth}`);
  return scrollWidth > clientWidth || cards.length ? { scrollWidth, clientWidth, cards } : null;
}

/** Visible buttons inside `sel` without an accessible name. */
function unnamed(sel) {
  return [...document.querySelector(sel).querySelectorAll('button')]
    .filter((b) => b.getClientRects().length && !(b.getAttribute('aria-label') || b.title || /[\p{L}\p{N}]/u.test(b.textContent)))
    .map((b) => b.outerHTML.slice(0, 120));
}

// Phone Chat (docs/design-mobile-chat.md): 📋 and ⚙ are reached through the ＋ / ⋯ sheets, which forward the click.
const PHONE_ROUTE = {
  '#btn-queue-add': ['#btn-plus', '#plus-modal [data-proxy="#btn-queue-add"]'],
  '#btn-settings': ['#btn-head-more', '#head-more-modal [data-proxy="#btn-settings"]'],
  '#sb-queue': ['#statusline [data-open-queue]'], // the 📋 chip of the status strip
};

/** Clicks `sel` when it is on screen, else (phone) through its sheet. */
async function tap(page, sel) {
  const shown = (q) => page.eval((s) => Boolean(document.querySelector(s)?.getClientRects().length), q);
  if ((await shown(sel)) || !PHONE_ROUTE[sel] || !(await shown(PHONE_ROUTE[sel][0]))) return page.click(sel);
  for (const step of PHONE_ROUTE[sel]) {
    await page.waitFor((q) => document.querySelector(q)?.getClientRects().length && !document.querySelector(q).closest('.modal-card')?.getAnimations().some((a) => a.playState === 'running'), { message: `${step} terlihat` }, step);
    await page.click(step);
  }
}

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(path.join(SHOTS, `${name}.png`), await page.screenshot());
}

/**
 * Fake of the queue BUDGET backend, in the page: wraps window.fetch so every queue answer carries `window.__qb.budget`
 * (plus an optional forced pause reason) and POST …/queue-budget is answered here, with the contract's validation.
 * Keeps this test independent of src/queue.js; the real endpoint is covered by test/queue.test.mjs.
 */
function installBudgetFake() {
  if (window.__qb) return;
  const realFetch = window.fetch.bind(window);
  const fake = { budget: { tokensOut: null, costUsd: null, spentTokensOut: 0, spentCostUsd: 0, since: null }, posts: [], pause: null, failNext: null };
  window.__qb = fake;
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const decorate = (q) => q && { ...q, budget: { ...fake.budget }, ...(fake.pause ? { paused: true, reason: fake.pause } : {}) };
  const okTokens = (v) => v === null || (Number.isInteger(v) && v >= 1000 && v <= 100_000_000);
  const okCost = (v) => v === null || (typeof v === 'number' && v >= 0.01 && v <= 10_000);
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const budgetCall = u.match(/^(.*\/api\/projects\/[^/]+\/queue)-budget$/);
    if (budgetCall) {
      const body = JSON.parse(opts.body);
      fake.posts.push(body);
      if (fake.failNext) {
        const error = fake.failNext;
        fake.failNext = null;
        return json({ error }, 400);
      }
      if (!okTokens(body.tokensOut) || !okCost(body.costUsd)) return json({ error: 'Batas antrian tidak valid.' }, 400);
      const on = body.tokensOut !== null || body.costUsd !== null;
      fake.budget = { tokensOut: body.tokensOut, costUsd: body.costUsd, spentTokensOut: 0, spentCostUsd: 0, since: on ? Date.now() : null };
      const real = await (await realFetch(budgetCall[1], { ...opts, body: '{}' })).json();
      return json({ queue: decorate(real.queue) });
    }
    if (!/\/api\/projects\/[^/]+\/queue(-[a-z]+)?$/.test(u)) return realFetch(url, opts);
    const res = await realFetch(url, opts);
    const data = await res.json();
    if (data.queue) data.queue = decorate(data.queue);
    return json(data, res.status);
  };
}

/** Opens the app on the toko project (a full load) and waits until it is connected. */
async function openApp(page) {
  page.clearProblems();
  await page.goto(`${BASE}/#${projectId}`);
  await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok') && document.querySelector('#crumb')?.textContent.trim(), { timeoutMs: 10000, message: 'app ready' });
}

async function altEnter(page) {
  const params = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 1 };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...params });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

for (const vp of VIEWPORTS) {
  describe(`📋 Antrian & ⏰ Backup otomatis — ${vp.name}`, { skip: SKIP ?? false }, () => {
    let page;
    before(async () => {
      page = await browser.newPage();
      await page.setViewport(vp);
    });
    after(async () => page?.close());

    test('composer → queue (button and Alt+Enter), dialog: reorder, edit, remove, resume, "Lihat hasil"', async () => {
      // Start from an empty, paused queue so nothing runs while the UI edits it.
      for (const item of (await queue()).items) await api(`/api/projects/${projectId}/queue-remove`, { itemId: item.id });
      await api(`/api/projects/${projectId}/queue-pause`, { paused: true });
      page.clearProblems();
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok') && !document.querySelector('#sb-queue').hidden, { timeoutMs: 10000, message: 'app ready with the 📋 chip (paused queue)' });

      // ＋📋 with text: added (not sent); the box empties
      await page.eval(() => {
        const input = document.querySelector('#prompt');
        input.value = 'pertama dari tombol';
        input.focus();
      });
      await tap(page, '#btn-queue-add');
      await page.waitFor(() => document.querySelector('#prompt').value === '', { message: 'composer emptied' });
      // Alt+Enter: added too, and NOT sent as a prompt
      const bubbles = () => document.querySelectorAll('#chat [data-id]').length;
      const before = await page.eval(bubbles);
      await page.eval(() => document.querySelector('#prompt').focus());
      await page.send('Input.insertText', { text: 'kedua dari Alt+Enter' });
      await altEnter(page);
      await page.waitFor(() => document.querySelector('#prompt').value === '', { message: 'Alt+Enter emptied the box' });
      let q = await queue();
      assert.deepEqual(q.items.map((i) => i.text), ['pertama dari tombol', 'kedua dari Alt+Enter']);
      await sleep(300);
      assert.equal(await page.eval(bubbles), before, 'Alt+Enter did not also send the prompt (no new chat bubble)');
      await page.waitFor(() => /⏸ 2/.test(document.querySelector('#sb-queue').textContent), { message: 'chip shows ⏸ 2' });

      // the dialog from the chip
      await tap(page, '#sb-queue');
      await page.waitFor(() => document.querySelectorAll('#queue-list li.queue-item').length === 2, { message: 'two items listed' });
      assert.match(await page.eval(() => document.querySelector('#queue-state').textContent), /dijeda olehmu/);
      assert.deepEqual(await page.eval(unnamed, '#queue-modal'), []);
      assert.equal(await page.eval(horizontalOverflow), null);
      await shot(page, `queue-${vp.mobile ? 'mobile' : 'desktop'}-1`);

      // ↓ on the first item: order changes on the server
      await page.click('#queue-list li:first-child [data-act="down"]');
      await page.waitFor(() => document.querySelector('#queue-list li:first-child .queue-text')?.textContent === 'kedua dari Alt+Enter', { message: 'reordered' });
      q = await queue();
      assert.deepEqual(q.items.map((i) => i.text), ['kedua dari Alt+Enter', 'pertama dari tombol']);

      // ✎ edit the second
      await page.click('#queue-list li:nth-child(2) [data-act="edit"]');
      await page.eval(() => {
        const ta = document.querySelector('#queue-list .queue-edit');
        ta.value = 'pertama (diubah)';
      });
      await page.click('#queue-list [data-act="save"]');
      await page.waitFor(() => document.querySelector('#queue-list li:nth-child(2) .queue-text')?.textContent === 'pertama (diubah)', { message: 'edited' });

      // add one from the dialog, then remove it
      await page.eval(() => (document.querySelector('#queue-new').value = 'ketiga dari dialog'));
      await page.click('#queue-add');
      await page.waitFor(() => document.querySelectorAll('#queue-list li.queue-item').length === 3, { message: 'three items' });
      await page.click('#queue-list li:nth-child(3) [data-act="remove"]');
      await page.waitFor(() => document.querySelectorAll('#queue-list li.queue-item').length === 2, { message: 'removed' });
      assert.equal(await page.eval(horizontalOverflow), null);

      // ▶ Lanjutkan: both run, in order, and get "Lihat hasil"
      await page.click('#queue-toggle');
      await page.waitFor(() => document.querySelectorAll('#queue-list li.queue-item.done').length === 2, { timeoutMs: 20000, message: 'both items done' });
      assert.equal(await page.eval(() => document.querySelectorAll('#queue-list [data-act="open"]').length), 2);
      await shot(page, `queue-${vp.mobile ? 'mobile' : 'desktop'}-2`);
      await page.click('#queue-list li:nth-child(2) [data-act="open"]');
      await page.waitFor(() => document.querySelector('#queue-modal').hidden && document.querySelector('#chat .queue-flash'), { message: 'chat shows the item' });
      assert.match(await page.eval(() => document.querySelector('#chat .queue-flash').textContent), /pertama \(diubah\)/);
      assert.deepEqual(page.problems, [], 'no console errors');
      // only finished items left: the chip goes away; 📋 with an empty box opens the list, finished items are cleared
      await page.waitFor(() => document.querySelector('#sb-queue').hidden, { message: 'chip hidden when nothing is left to run' });
      await page.eval(() => (document.querySelector('#prompt').value = ''));
      await page.eval(() => document.querySelectorAll('.toast').forEach((t) => t.remove())); // a toast sits over the phone composer
      await tap(page, '#btn-queue-add');
      await page.waitFor(() => !document.querySelector('#queue-modal').hidden && !document.querySelector('#queue-clear').hidden, { message: 'dialog with clear button' });
      await page.click('#queue-clear');
      await page.waitFor(() => document.querySelectorAll('#queue-list li.queue-item').length === 0, { message: 'cleared' });
      await page.press('Escape');
    });

    /* global DataTransfer, DragEvent -- used inside page.eval (runs in the browser) */
    test('📎 lampiran tidak masuk antrian:＋📋 / Alt+Enter menolak dengan pesan jelas, teks & chip tetap di kotak', async () => {
      for (const item of (await queue()).items) await api(`/api/projects/${projectId}/queue-remove`, { itemId: item.id });
      await api(`/api/projects/${projectId}/queue-pause`, { paused: true });
      page.clearProblems();
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000, message: 'app ready' });
      await page.eval(() => {
        document.querySelectorAll('.toast').forEach((t) => t.remove());
        const dt = new DataTransfer();
        dt.items.add(new File(['TypeError: boom\n'], 'error.log', { type: 'text/plain' }));
        document.querySelector('.input').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        const input = document.querySelector('#prompt');
        input.value = 'cek log ini nanti';
        input.focus();
      });
      await page.waitFor(() => document.querySelectorAll('#attachments .att-chip').length === 1, { message: 'chip lampiran' });
      const refused = () => [...document.querySelectorAll('.toast')].some((t) => /Lampiran belum bisa masuk antrian; kirim langsung/.test(t.textContent));
      await tap(page, '#btn-queue-add');
      await page.waitFor(refused, { message: 'toast penolakan (tombol)' });
      await page.eval(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      await page.eval(() => document.querySelector('#prompt').focus());
      await altEnter(page);
      await page.waitFor(refused, { message: 'toast penolakan (Alt+Enter)' });
      assert.deepEqual(await page.eval(() => ({ text: document.querySelector('#prompt').value, chips: document.querySelectorAll('#attachments .att-chip').length })), { text: 'cek log ini nanti', chips: 1 }, 'nothing lost');
      assert.equal(await page.eval(() => document.querySelector('#queue-modal').hidden), true, 'dialog not opened');
      assert.deepEqual((await queue()).items, [], 'nothing queued');
      // clean up for the next test: chip and text out of the box
      await page.eval(() => {
        document.querySelector('#attachments .att-chip button').click();
        document.querySelector('#prompt').value = '';
        document.querySelectorAll('.toast').forEach((t) => t.remove());
      });
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(page.problems, [], 'no console errors');
    });

    test('💰 Batas antrian: validation, save → POST body, progress (warn/over), server error, budget pause label + toast, remove, read-only', async () => {
      for (const item of (await queue()).items) await api(`/api/projects/${projectId}/queue-remove`, { itemId: item.id });
      await api(`/api/projects/${projectId}/queue-add`, { text: 'item untuk batas' });
      await api(`/api/projects/${projectId}/queue-pause`, { paused: true });
      page.clearProblems();
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok') && !document.querySelector('#sb-queue').hidden, { timeoutMs: 10000, message: 'app ready with the 📋 chip' });
      await page.eval(installBudgetFake);
      const fake = () => page.eval(() => window.__qb);
      const setFake = (patch) => page.eval((p) => Object.assign(window.__qb, p), patch);
      const reopen = () => page.eval(async () => (await import('/js/features/queue.js')).openQueue());
      const ui = () =>
        page.eval(() => {
          const bar = document.querySelector('#qb-bar');
          return {
            usage: document.querySelector('#qb-usage').textContent.replace(/\s/g, ' '),
            level: ['warn', 'over'].find((c) => bar.classList.contains(c)) ?? '',
            bar: bar.hidden ? null : { now: bar.getAttribute('aria-valuenow'), max: bar.getAttribute('aria-valuemax'), role: bar.getAttribute('role') },
          };
        });
      const clearToasts = () => page.eval(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

      await reopen();
      await page.waitFor(() => document.querySelectorAll('#queue-list li.queue-item').length === 1, { message: 'dialog loaded' });
      assert.deepEqual(await ui(), { usage: 'tanpa batas', level: '', bar: null });
      assert.equal(await page.eval(() => document.querySelector('#qb-clear').disabled), true, 'nothing to remove yet');
      await page.click('#qb-toggle');
      await page.waitFor(() => !document.querySelector('#qb-body').hidden && document.querySelector('#qb-toggle').getAttribute('aria-expanded') === 'true', { message: 'section opened' });
      assert.match(await page.eval(() => document.querySelector('.qb-note').textContent), /Dicek setelah tiap item selesai; giliran yang berjalan tidak dipotong\. Biaya hanya estimasi \(harga list\)\./);

      // out of range: explained inline, nothing sent
      await page.eval(() => {
        document.querySelector('#qb-tokens').value = '500';
        document.querySelector('#qb-cost').value = '';
      });
      await page.click('#qb-save');
      await page.waitFor(() => !document.querySelector('#qb-error').hidden, { message: 'inline validation error' });
      assert.match(await page.eval(() => document.querySelector('#qb-error').textContent), /bilangan bulat 1\.000–100\.000\.000/);
      assert.equal(await page.eval(() => document.querySelector('#qb-tokens').getAttribute('aria-invalid')), 'true');
      assert.equal((await fake()).posts.length, 0);

      // valid: the POST body, then progress from the answer
      await page.eval(() => {
        document.querySelector('#qb-tokens').value = '50000';
        document.querySelector('#qb-cost').value = '5';
      });
      await page.click('#qb-save');
      await page.waitFor(() => window.__qb.posts.length === 1 && document.querySelector('#qb-error').hidden, { message: 'budget posted' });
      assert.deepEqual((await fake()).posts[0], { tokensOut: 50000, costUsd: 5 });
      await page.waitFor(() => !document.querySelector('#qb-bar').hidden, { message: 'progress shown' });
      assert.deepEqual(await ui(), { usage: '0 / 50 rb token output · $0,00 / $5,00', level: '', bar: { now: '0', max: '100', role: 'progressbar' } });
      assert.deepEqual(await page.eval(() => [document.querySelector('#qb-tokens').value, document.querySelector('#qb-cost').value]), ['50000', '5'], 'prefilled from the budget');

      // spent grows: highest ratio drives the bar; ≥80% warns, ≥100% is exceeded (valuenow stays within max)
      await setFake({ budget: { tokensOut: 50000, costUsd: 5, spentTokensOut: 12345, spentCostUsd: 0.42, since: 1 } });
      await reopen();
      await page.waitFor(() => /12,3/.test(document.querySelector('#qb-usage').textContent), { message: 'progress updated' });
      assert.deepEqual(await ui(), { usage: '12,3 rb / 50 rb token output · $0,42 / $5,00', level: '', bar: { now: '25', max: '100', role: 'progressbar' } });
      await setFake({ budget: { tokensOut: 50000, costUsd: 5, spentTokensOut: 1000, spentCostUsd: 4.1, since: 1 } });
      await reopen();
      await page.waitFor(() => document.querySelector('#qb-bar').classList.contains('warn'), { message: 'warn at ≥80%' });
      assert.equal((await ui()).bar.now, '82');
      await setFake({ budget: { tokensOut: 50000, costUsd: null, spentTokensOut: 61000, spentCostUsd: 0.9, since: 1 } });
      await reopen();
      await page.waitFor(() => document.querySelector('#qb-bar').classList.contains('over'), { message: 'exceeded at ≥100%' });
      assert.deepEqual(await ui(), { usage: '61 rb / 50 rb token output', level: 'over', bar: { now: '100', max: '100', role: 'progressbar' } });

      // a 400 from the server is shown like the other queue errors (toast)
      await clearToasts();
      await setFake({ failNext: 'Maks biaya terlalu besar.' });
      await page.eval(() => document.querySelector('#qb-body').hidden && document.querySelector('#qb-toggle').click());
      await page.eval(() => document.querySelector('#qb-save').click());
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Maks biaya terlalu besar.')), { message: 'server error toast' });

      // paused by the budget: one-time warning toast, chip label, warn state line, section opened
      await clearToasts();
      await setFake({ pause: 'budget' });
      const chip = await page.eval(async (id) => {
        const { state } = await import('/js/core/state.js');
        const { renderQueueChip } = await import('/js/features/queue.js');
        const st = state.statuses[id];
        const s = { ...st.taskQueue, waiting: 1, running: 0, failed: 0, paused: true, reason: 'budget' };
        renderQueueChip({ ...st, taskQueue: s });
        const label = document.querySelector('#sb-queue').getAttribute('aria-label');
        renderQueueChip({ ...st, taskQueue: s }); // same reason again: no second toast
        return label;
      }, projectId);
      assert.match(chip, /dijeda karena batas token\/biaya tercapai/);
      const warnToasts = await page.eval(() => [...document.querySelectorAll('.toast.warn')].map((t) => t.textContent));
      assert.equal(warnToasts.filter((t) => t.includes('dijeda karena batas token/biaya antrian tercapai')).length, 1, `one budget toast: ${warnToasts}`);
      await reopen();
      await page.waitFor(() => /batas token\/biaya antrian tercapai/.test(document.querySelector('#queue-state').textContent), { message: 'budget pause label' });
      assert.deepEqual(await page.eval(() => ({ warn: document.querySelector('#queue-state').classList.contains('warn'), open: !document.querySelector('#qb-body').hidden })), { warn: true, open: true });
      await clearToasts();
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(await page.eval(unnamed, '#queue-modal'), []);
      await shot(page, `budget-${vp.mobile ? 'mobile' : 'desktop'}`);

      // Hapus batas: both null
      await setFake({ pause: null });
      await page.eval(() => document.querySelector('#qb-clear').click());
      await page.waitFor(() => window.__qb.posts.length === 3 && document.querySelector('#qb-usage').textContent === 'tanpa batas', { message: 'budget removed' });
      assert.deepEqual((await fake()).posts[2], { tokensOut: null, costUsd: null });
      assert.deepEqual(await page.eval(() => [document.querySelector('#qb-tokens').value, document.querySelector('#qb-cost').value, document.querySelector('#qb-clear').disabled]), ['', '', true]);

      // read-only phone on WiFi: everything shown, nothing editable
      await setFake({ budget: { tokensOut: 50000, costUsd: 5, spentTokensOut: 100, spentCostUsd: 0.01, since: 1 } });
      await page.eval(async () => {
        (await import('/js/core/state.js')).state.readOnly = true;
      });
      await reopen();
      await page.waitFor(() => !document.querySelector('#qb-bar').hidden, { message: 'read-only dialog loaded' });
      const ro = await page.eval(() => ['#qb-tokens', '#qb-cost', '#qb-save', '#qb-clear', '#queue-add'].map((s) => document.querySelector(s).disabled));
      await page.eval(async () => {
        (await import('/js/core/state.js')).state.readOnly = false;
      });
      assert.deepEqual(ro, [true, true, true, true, true]);
      assert.equal((await fake()).posts.length, 3, 'nothing sent while read-only');
      assert.deepEqual(page.problems, [], 'no console errors');
      await page.press('Escape');
      for (const item of (await queue()).items) await api(`/api/projects/${projectId}/queue-remove`, { itemId: item.id });
    });

    test('⚙ → ⏰ Backup otomatis: off by default, invalid folder explained, save, "Jalankan sekarang" writes a backup', async () => {
      // Self-contained (runs alone / in any order): the schedule back to its defaults, the app freshly opened.
      await api('/api/backup/schedule/save', { enabled: false, frequency: 'daily', weekday: 1, time: '02:00', folder: '', keep: 7 });
      await openApp(page);
      page.clearProblems();
      await tap(page, '#btn-settings');
      await page.waitFor(() => !document.querySelector('#settings-modal').hidden && /nonaktif|Berikutnya/.test(document.querySelector('#ba-status').textContent), { message: 'backup schedule loaded' });
      await page.eval(() => document.querySelector('.backup-auto').scrollIntoView({ block: 'center' }));
      const dir = path.join(TMP, `backups-${vp.mobile ? 'm' : 'd'}`);
      mkdirSync(dir, { recursive: true });
      assert.equal(await page.eval(() => document.querySelector('#ba-enabled').checked), false, 'off by default');
      assert.equal(await page.eval(() => document.querySelector('#ba-run').disabled), true, 'no folder yet: nothing to run');
      await page.eval(() => {
        document.querySelector('#ba-folder').value = '\\\\server\\share';
        document.querySelector('#ba-enabled').checked = true;
      });
      await page.click('#ba-save');
      await page.waitFor(() => /jaringan/.test(document.querySelector('#ba-error').textContent), { message: 'UNC refused with a reason' });
      assert.deepEqual(page.problems.map((p) => p.kind).sort(), ['http', 'log:network'], 'only the expected 400');
      page.clearProblems();
      await page.eval((d) => {
        document.querySelector('#ba-folder').value = d;
        document.querySelector('#ba-frequency').value = 'weekly';
        document.querySelector('#ba-frequency').dispatchEvent(new Event('change'));
        document.querySelector('#ba-weekday').value = '5';
        document.querySelector('#ba-time').value = '03:15';
        document.querySelector('#ba-keep').value = '3';
      }, dir);
      assert.equal(await page.eval(() => document.querySelector('#ba-weekday-row').hidden), false, 'weekday shown for weekly');
      await page.click('#ba-save');
      await page.waitFor(() => /Berikutnya/.test(document.querySelector('#ba-status').textContent) && !document.querySelector('#ba-error').textContent, { message: 'saved' });
      const view = (await api('/api/backup/schedule')).body;
      assert.deepEqual({ ...view.schedule }, { enabled: true, frequency: 'weekly', weekday: 5, time: '03:15', folder: path.resolve(dir), keep: 3 });
      const prevAt = view.last?.at ?? 0; // the other viewport's run (same server) may already be shown
      await page.click('#ba-run');
      for (let i = 0; i < 200 && !((await api('/api/backup/schedule')).body.last?.at > prevAt); i++) await sleep(100);
      const name = (await api('/api/backup/schedule')).body.last.name;
      await page.waitFor((n) => /Terakhir \(manual\): ✓/.test(document.querySelector('#ba-status').textContent) && document.querySelector('#ba-status').textContent.includes(n), { timeoutMs: 20000, message: 'manual backup shown' }, name);
      assert.equal(readdirSync(dir).filter((f) => /^adhit-office-backup-auto-\d{8}-\d{6}(-\d+)?\.zip$/.test(f)).length, 1);
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(await page.eval(unnamed, '#settings-modal'), []);
      await shot(page, `backup-${vp.mobile ? 'mobile' : 'desktop'}`);
      // Enter in the folder field saves the schedule, never submits the roots form behind it
      await page.eval(() => document.querySelector('#ba-folder').focus());
      await page.press('Enter');
      await sleep(300);
      assert.equal(await page.eval(() => document.querySelector('#settings-modal').hidden), false);
      assert.deepEqual(page.problems, []);
      await api('/api/backup/schedule/save', { enabled: false });
      await page.press('Escape');
    });
  });
}
