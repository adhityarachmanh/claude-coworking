/* global document -- functions passed to page.eval run in the browser */
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
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
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

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(path.join(SHOTS, `${name}.png`), await page.screenshot());
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
      await page.click('#btn-queue-add');
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
      await page.click('#sb-queue');
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
      await page.click('#btn-queue-add');
      await page.waitFor(() => !document.querySelector('#queue-modal').hidden && !document.querySelector('#queue-clear').hidden, { message: 'dialog with clear button' });
      await page.click('#queue-clear');
      await page.waitFor(() => document.querySelectorAll('#queue-list li.queue-item').length === 0, { message: 'cleared' });
      await page.press('Escape');
    });

    test('⚙ → ⏰ Backup otomatis: off by default, invalid folder explained, save, "Jalankan sekarang" writes a backup', async () => {
      page.clearProblems();
      await page.click('#btn-settings').catch(async () => page.eval(() => (document.querySelector('#settings-modal').hidden = false)));
      await page.waitFor(() => !document.querySelector('#settings-modal').hidden && /nonaktif|Berikutnya/.test(document.querySelector('#ba-status').textContent), { message: 'backup schedule loaded' });
      await page.eval(() => document.querySelector('.backup-auto').scrollIntoView({ block: 'center' }));
      const dir = path.join(TMP, `backups-${vp.mobile ? 'm' : 'd'}`);
      mkdirSync(dir, { recursive: true });
      if (vp.mobile) {
        assert.equal(await page.eval(() => document.querySelector('#ba-enabled').checked), false, 'off by default');
        assert.equal(await page.eval(() => document.querySelector('#ba-run').disabled), true, 'no folder yet: nothing to run');
      }
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
