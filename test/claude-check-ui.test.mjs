/* global document, localStorage -- functions passed to page.eval run in the browser */
// 🧩 Claude Code update detector in the browser: the banner rules (pure), and in a headless Chrome/Edge
// (test-support/cdp.mjs), phone and desktop, against the real server on a fake Claude Code that claims a new version:
// the "semua cek lulus ✅" banner after the automatic check (once per browser, auto-hides), the ⚠ banner with the
// failing check names and `npm run test:claude` (✕ dismisses for good), the passive notice of a read-only WiFi
// phone, and ⚙ → 🧩 Kompatibilitas Claude Code (status, settings, manual run). No console errors, no sideways scroll.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HINT_COMMAND, OK_HIDE_MS, PASSIVE_HIDE_MS, bannerKey, claudeCheckBanner, claudeCheckStatus, failingList } from '../public/js/core/claude-check-rules.js';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [
  { name: 'mobile 390x844', width: 390, height: 844, mobile: true },
  { name: 'desktop 1440x900', width: 1440, height: 900, mobile: false },
];
const SEEN_KEY = 'office.claudeCheck.seen';

// ---------- the rules (no browser needed) ----------

const VIEW = { available: true, version: '2.0.0', lastGoodVersion: '2.0.0', checkedVersion: '2.0.0', previousVersion: '1.0.0', lastCheckedAt: 1000, result: 'ok', failing: [], reason: null, trigger: 'auto', usedModel: true, running: false, waiting: false, settings: { autoCheck: true, allowModel: true } };

describe('claude-check-rules', () => {
  test('ok: only after an automatic check of a new version; auto-hides; dismissible except on WiFi', () => {
    const b = claudeCheckBanner(VIEW);
    assert.equal(b.text, 'Claude Code diperbarui ke v2.0.0 — semua cek kontrak lulus ✅');
    assert.deepEqual([b.tone, b.autoHideMs, b.dismissible, b.passive, b.hintCommand], ['ok', OK_HIDE_MS, true, false, null]);
    assert.equal(b.key, bannerKey(VIEW));
    assert.equal(claudeCheckBanner(VIEW, { seen: bannerKey(VIEW) }), null, 'seen once is enough');
    assert.equal(claudeCheckBanner({ ...VIEW, trigger: 'manual' }), null);
    assert.equal(claudeCheckBanner({ ...VIEW, previousVersion: null }), null, 'first install: no news');
    assert.equal(claudeCheckBanner({ ...VIEW, running: true }), null);
    assert.equal(claudeCheckBanner({ ...VIEW, result: 'skipped' }), null);
    assert.equal(claudeCheckBanner(null), null);
    assert.equal(claudeCheckBanner({ ...VIEW, result: 'warning', failing: ['x'], version: '1.9.0' }), null, 'stale: that version is no longer installed');
    const wifi = claudeCheckBanner(VIEW, { readOnly: true });
    assert.deepEqual([wifi.dismissible, wifi.passive, wifi.autoHideMs], [false, true, PASSIVE_HIDE_MS]);
  });

  test('warning/failed: names (max 3 + count), the command on laptop/Tailscale; passive notice on WiFi', () => {
    const failing = ['a', 'b', 'c', 'd', 'e'];
    const warn = claudeCheckBanner({ ...VIEW, result: 'warning', failing: ['initialize: --agents dari file', 'kontrol: set_model'], trigger: 'manual' });
    assert.equal(warn.text, '⚠ Claude Code v2.0.0: 2 cek kontrak gagal (initialize: --agents dari file, kontrol: set_model) — beberapa fitur mungkin bermasalah.');
    assert.deepEqual([warn.tone, warn.dismissible, warn.autoHideMs, warn.hintCommand], ['warn', true, null, HINT_COMMAND]);
    assert.equal(claudeCheckBanner({ ...VIEW, result: 'failed', failing }).tone, 'err');
    assert.equal(failingList(failing), 'a, b, c, +2 lagi');
    const wifi = claudeCheckBanner({ ...VIEW, result: 'failed', failing }, { readOnly: true });
    assert.deepEqual([wifi.passive, wifi.dismissible, wifi.hintCommand, wifi.autoHideMs], [true, false, null, PASSIVE_HIDE_MS]);
    assert.match(wifi.text, /5 cek kontrak gagal \(a, b, c, \+2 lagi\)/);
  });

  test('⚙ status line', () => {
    const fmt = () => 'TGL';
    assert.equal(claudeCheckStatus(VIEW, fmt), 'Terpasang: v2.0.0. Cek terakhir (otomatis, 1 request Haiku) TGL, v2.0.0: ✓ semua cek lulus.');
    assert.equal(claudeCheckStatus({ ...VIEW, available: false }, fmt), 'Claude Code tidak ditemukan di laptop ini.');
    assert.match(claudeCheckStatus({ ...VIEW, running: true }, fmt), /sedang berjalan/);
    assert.match(claudeCheckStatus({ ...VIEW, waiting: true }, fmt), /Menunggu giliran/);
    assert.match(claudeCheckStatus({ ...VIEW, result: 'skipped', reason: 'Cek otomatis dimatikan', usedModel: false }, fmt), /dilewati \(Cek otomatis dimatikan\)/);
    assert.match(claudeCheckStatus({ ...VIEW, result: 'warning', failing: ['x'], trigger: 'manual', usedModel: false, version: '2.0.1' }, fmt), /\(manual, tanpa token\).*⚠ 1 cek gagal: x\. Terakhir lulus: v2\.0\.0\./);
    assert.match(claudeCheckStatus({ ...VIEW, lastCheckedAt: null, result: null }, fmt), /Belum pernah dicek/);
  });
});

// ---------- in the browser ----------

let TMP;
let BASE;
let server;
let browser;
let token;
let contractFile;

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

const api = (p, body = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function checkView() {
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]).config.claudeCheck;
}

/** Polls the server until its check view matches (bounded). */
async function waitView(pred, message, ms = 20000) {
  const end = Date.now() + ms;
  let view;
  while (Date.now() < end) {
    view = await checkView();
    if (pred(view)) return view;
    await sleep(150);
  }
  throw new Error(`timeout menunggu ${message}: ${JSON.stringify(view)}`);
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-cc-ui-'));
  mkdirSync(path.join(TMP, 'projects', 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  mkdirSync(path.join(TMP, 'data'));
  // Last run knew Claude Code 1.0.0 (checked, ok); the fake now claims 2.0.0: an update.
  writeFileSync(path.join(TMP, 'data', 'claude-check.json'), JSON.stringify({ version: '1.0.0', lastGoodVersion: '1.0.0', check: { version: '1.0.0', at: 1, result: 'ok', failing: [] } }));
  contractFile = path.join(TMP, 'fake-contract.json');
  writeFileSync(contractFile, JSON.stringify({ version: '2.0.0', break: [] }));
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      OFFICE_CLAUDE_CHECK_DELAY_MS: '0',
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      FAKE_CLAUDE_CONTRACT: contractFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 20000);
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && (clearTimeout(timer), resolve()));
    server.on('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}`))));
  });
  server.stdout.resume();
  server.stderr.resume();
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  await waitView((v) => v?.checkedVersion === '2.0.0' && v.result === 'ok' && !v.running, 'the automatic check of v2.0.0');
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

function horizontalOverflow() {
  const { scrollWidth, clientWidth } = document.documentElement;
  const cards = [...document.querySelectorAll('.modal:not([hidden]) .modal-card')].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => `${c.parentElement.id}: ${c.scrollWidth} > ${c.clientWidth}`);
  const banner = document.querySelector('#cc-banner');
  const wide = banner && banner.scrollWidth > banner.clientWidth + 1 ? [`cc-banner ${banner.scrollWidth} > ${banner.clientWidth}`] : [];
  return scrollWidth > clientWidth || cards.length || wide.length ? { scrollWidth, clientWidth, cards, wide } : null;
}

function unnamed(sel) {
  return [...document.querySelector(sel).querySelectorAll('button')]
    .filter((b) => b.getClientRects().length && !(b.getAttribute('aria-label') || b.title || /[\p{L}\p{N}]/u.test(b.textContent)))
    .map((b) => b.outerHTML.slice(0, 120));
}

const PHONE_ROUTE = { '#btn-settings': ['#btn-head-more', '#head-more-modal [data-proxy="#btn-settings"]'] };

async function tap(page, sel) {
  const shown = (q) => page.eval((s) => Boolean(document.querySelector(s)?.getClientRects().length), q);
  if ((await shown(sel)) || !PHONE_ROUTE[sel] || !(await shown(PHONE_ROUTE[sel][0]))) return page.click(sel);
  for (const step of PHONE_ROUTE[sel]) {
    await page.waitFor((q) => document.querySelector(q)?.getClientRects().length && !document.querySelector(q).closest('.modal-card')?.getAnimations().some((a) => a.playState === 'running'), { message: `${step} terlihat` }, step);
    await page.click(step);
  }
}

/** A full load with this browser's "seen" marker cleared (or kept), connected. */
async function openApp(page, { clearSeen = true } = {}) {
  page.clearProblems();
  if (clearSeen) {
    // Cleared on a plain file of the same origin: the app itself would mark a banner seen as soon as it shows it.
    await page.goto(`${BASE}/manifest.webmanifest`);
    await page.eval((k) => localStorage.removeItem(k), SEEN_KEY);
  }
  await page.goto(`${BASE}/`);
  await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000, message: 'app ready' });
}

const bannerState = () => {
  const b = document.querySelector('#cc-banner .cc-banner');
  return b ? { cls: b.className, text: b.querySelector('.cc-text')?.textContent, hint: b.querySelector('.cc-hint')?.textContent ?? null, code: b.querySelector('.cc-hint code')?.textContent ?? null, close: Boolean(b.querySelector('.cc-close')), visible: b.getClientRects().length > 0 } : null;
};

describe('🧩 banner after an automatic check of a new version: semua cek lulus', { skip: SKIP ?? false }, () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}: shown once, dismissible, not again after a reload`, async () => {
      const page = await browser.newPage();
      try {
        await page.setViewport(vp);
        await openApp(page);
        await page.waitFor(() => document.querySelector('#cc-banner .cc-banner'), { message: 'ok banner' });
        const b = await page.eval(bannerState);
        assert.equal(b.text, 'Claude Code diperbarui ke v2.0.0 — semua cek kontrak lulus ✅');
        assert.match(b.cls, /\bok\b/);
        assert.equal(b.visible, true);
        assert.equal(b.close, true, 'laptop: ✕');
        assert.equal(b.code, null, 'nothing to run when everything passed');
        assert.equal(await page.eval(horizontalOverflow), null);
        assert.deepEqual(await page.eval(unnamed, '#cc-banner'), []);
        await openApp(page, { clearSeen: false });
        await sleep(400);
        assert.equal(await page.eval(bannerState), null, 'seen once: not again after a reload');
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });
  }

  test('desktop: the ok banner hides by itself', async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport(VIEWPORTS[1]);
      await openApp(page);
      await page.waitFor(() => document.querySelector('#cc-banner .cc-banner'), { message: 'ok banner' });
      await page.waitFor(() => !document.querySelector('#cc-banner .cc-banner'), { timeoutMs: OK_HIDE_MS + 3000, message: 'auto-hide' });
    } finally {
      await page.close();
    }
  });
});

describe('🧩 banner when contract checks fail', { skip: SKIP ?? false }, () => {
  let view;
  before(async () => {
    if (SKIP) return;
    writeFileSync(contractFile, JSON.stringify({ version: '2.0.1', break: ['agents', 'set_model'] }));
    assert.equal((await api('/api/claude-check/run')).status, 202);
    view = await waitView((v) => v.checkedVersion === '2.0.1' && !v.running, 'the manual check of v2.0.1');
    assert.equal(view.result, 'warning');
  });

  for (const vp of VIEWPORTS) {
    test(`${vp.name}: ⚠ names + npm run test:claude, ✕ dismisses for good; WiFi gets a passive notice`, async () => {
      const page = await browser.newPage();
      try {
        await page.setViewport(vp);
        await openApp(page);
        await page.waitFor(() => document.querySelector('#cc-banner .cc-banner'), { message: 'warning banner' });
        const b = await page.eval(bannerState);
        assert.equal(b.text, '⚠ Claude Code v2.0.1: 2 cek kontrak gagal (initialize: --agents dari file, kontrol: set_model) — beberapa fitur mungkin bermasalah.');
        assert.match(b.cls, /\bwarn\b/);
        assert.equal(b.hint, 'Jalankan npm run test:claude untuk detail.');
        assert.equal(b.code, 'npm run test:claude');
        assert.equal(await page.eval(horizontalOverflow), null);
        assert.deepEqual(await page.eval(unnamed, '#cc-banner'), []);
        // stays (no auto-hide) until ✕
        await sleep(300);
        assert.ok(await page.eval(bannerState));
        await page.click('#cc-banner .cc-close');
        await page.waitFor(() => !document.querySelector('#cc-banner .cc-banner'), { message: 'dismissed' });
        await openApp(page, { clearSeen: false });
        await sleep(400);
        assert.equal(await page.eval(bannerState), null, 'dismissed for good');

        // A read-only phone on plain WiFi: the same news as a passive notice (no button, no command to run).
        await page.eval(async (v, k) => {
          const { state } = await import('/js/core/state.js');
          const { applyClaudeCheck } = await import('/js/features/claude-check.js');
          localStorage.removeItem(k);
          state.readOnly = true;
          applyClaudeCheck({ ...v, lastCheckedAt: v.lastCheckedAt + 1 });
        }, view, SEEN_KEY);
        const passive = await page.eval(bannerState);
        assert.match(passive.cls, /\bpassive\b/);
        assert.equal(passive.close, false);
        assert.equal(passive.hint, null);
        assert.match(passive.text, /2 cek kontrak gagal/);
        assert.equal(await page.eval(horizontalOverflow), null);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });
  }
});

describe('🧩 ⚙ Kompatibilitas Claude Code (laptop)', { skip: SKIP ?? false }, () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}: status, "Boleh pakai 1 request kecil" saved, manual run → ✓`, async () => {
      writeFileSync(contractFile, JSON.stringify({ version: '2.0.1', break: [] })); // fixed: the next run passes
      const page = await browser.newPage();
      try {
        await page.setViewport(vp);
        await openApp(page);
        await tap(page, '#btn-settings');
        if (!vp.mobile) await page.click('[data-settings-tab="sistem"]');
        await page.waitFor(() => !document.querySelector('#settings-modal').hidden && /v2\.0\.\d/.test(document.querySelector('#cc-status').textContent), { message: '⚙ status' });
        assert.match(await page.eval(() => document.querySelector('#cc-status').textContent), /^Terpasang: v2\.0\.1\. Cek terakhir \(manual, (1 request Haiku|tanpa token)\) .*, v2\.0\.1: (⚠ 2 cek gagal|✓ semua cek lulus)/);
        assert.equal(await page.eval(() => document.querySelector('#cc-auto').checked), true);

        // the Haiku switch off: saved on the server
        await page.eval(() => document.querySelector('#cc-model').scrollIntoView({ block: 'center' }));
        await page.click('#cc-model');
        await waitView((v) => v.settings.allowModel === false, 'allowModel off');
        // manual run: no token this time, and it passes
        await page.click('#cc-run');
        await page.waitFor(() => /\(manual, tanpa token\).*✓ semua cek lulus/.test(document.querySelector('#cc-status').textContent) && !document.querySelector('#cc-run').disabled, { timeoutMs: 20000, message: 'manual run finished ok' });
        assert.equal(await page.eval(bannerState), null, 'a manual ok run is no banner news');
        assert.deepEqual(await page.eval(unnamed, '#settings-modal'), []);
        assert.equal(await page.eval(horizontalOverflow), null);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
        await api('/api/claude-check/settings', { allowModel: true });
      }
    });
  }
});
