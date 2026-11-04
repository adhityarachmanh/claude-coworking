/* global document, localStorage -- functions passed to page.eval run in the browser */
// 🧩 OpenCode update detector in the browser: the banner rules (pure), and in a headless Chrome/Edge
// (test-support/cdp.mjs), phone and desktop, against the real server on a fake `opencode` that claims a new version
// with a broken part: the ⚠ banner with the failing check names and `npm run test:opencode` (✕ dismisses for good),
// and ⚙ → 🧩 Kompatibilitas OpenCode (status, manual run). Not installed → nothing at all. No console errors.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OPENCODE_HINT_COMMAND, openCodeCheckBanner, openCodeCheckStatus } from '../public/js/core/claude-check-rules.js';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [
  { name: 'mobile 390x844', width: 390, height: 844, mobile: true },
  { name: 'desktop 1440x900', width: 1440, height: 900, mobile: false },
];
const SEEN_KEY = 'office.opencodeCheck.seen';
const MODE = 'configOptions: mode (build, plan)';
const SET_OPTION = 'session/set_config_option (mode)';

// ---------- the rules (no browser needed) ----------

const VIEW = { available: true, version: '2.3.0', lastGoodVersion: '2.3.0', checkedVersion: '2.3.0', previousVersion: '2.2.5', lastCheckedAt: 1000, result: 'ok', failing: [], reason: null, trigger: 'auto', usedModel: false, running: false, waiting: false, settings: { autoCheck: true } };

describe('opencode-check rules', () => {
  test('banner: OpenCode name, its own contract command; same rules as Claude Code', () => {
    assert.equal(openCodeCheckBanner(VIEW).text, 'OpenCode diperbarui ke v2.3.0 — semua cek kontrak lulus ✅');
    const warn = openCodeCheckBanner({ ...VIEW, result: 'warning', failing: [MODE] });
    assert.equal(warn.text, `⚠ OpenCode v2.3.0: 1 cek kontrak gagal (${MODE}) — beberapa fitur mungkin bermasalah.`);
    assert.equal(warn.hintCommand, OPENCODE_HINT_COMMAND);
    assert.equal(OPENCODE_HINT_COMMAND, 'npm run test:opencode');
    assert.equal(openCodeCheckBanner({ ...VIEW, result: 'failed', failing: ['x'] }, { readOnly: true }).hintCommand, null, 'WiFi: passive');
    assert.equal(openCodeCheckBanner({ ...VIEW, trigger: 'manual' }), null);
  });

  test('⚙ status line: always token-free', () => {
    const fmt = () => 'TGL';
    assert.equal(openCodeCheckStatus(VIEW, fmt), 'Terpasang: v2.3.0. Cek terakhir (otomatis, tanpa token) TGL, v2.3.0: ✓ semua cek lulus.');
    assert.equal(openCodeCheckStatus({ ...VIEW, available: false }, fmt), 'OpenCode tidak ditemukan di laptop ini.');
  });
});

// ---------- in the browser ----------

let TMP;
let BASE;
let server;
let browser;
let token;
let versionFile; // what the fake `opencode --version` claims (an update while the server runs)

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
  return JSON.parse(text.match(/^data: (.*)$/m)[1]).config.opencodeCheck;
}

/** Polls the server until its check view matches (bounded). */
async function waitView(pred, message, ms = 30000) {
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
  TMP = mkdtempSync(path.join(tmpdir(), 'office-oc-ui-'));
  mkdirSync(path.join(TMP, 'projects', 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  mkdirSync(path.join(TMP, 'data'));
  // Last run knew OpenCode 2.0.0 (checked, ok); the fake now claims 2.0.1 and has no "mode" option: an update.
  writeFileSync(path.join(TMP, 'data', 'opencode-check.json'), JSON.stringify({ version: '2.0.0', lastGoodVersion: '2.0.0', check: { version: '2.0.0', at: 1, result: 'ok', failing: [] } }));
  versionFile = path.join(TMP, 'opencode-version.txt');
  writeFileSync(versionFile, '2.0.1');
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000', // Claude Code's own check stays out of the way
      OFFICE_OPENCODE_CHECK_DELAY_MS: '0',
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      FAKE_ACP_VERSION_FILE: versionFile,
      FAKE_ACP_BREAK: 'mode',
      FAKE_ACP_AUTH_FILE: path.join(TMP, 'acp-auth.json'),
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
  const view = await waitView((v) => v?.checkedVersion === '2.0.1' && !v.running, 'the automatic check of v2.0.1');
  assert.equal(view.result, 'warning');
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
  const banner = document.querySelector('#oc-banner');
  const wide = banner && banner.scrollWidth > banner.clientWidth + 1 ? [`oc-banner ${banner.scrollWidth} > ${banner.clientWidth}`] : [];
  return scrollWidth > clientWidth || wide.length ? { scrollWidth, clientWidth, wide } : null;
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

async function openApp(page, { clearSeen = true } = {}) {
  page.clearProblems();
  if (clearSeen) {
    await page.goto(`${BASE}/manifest.webmanifest`);
    await page.eval((k) => localStorage.removeItem(k), SEEN_KEY);
  }
  await page.goto(`${BASE}/`);
  await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000, message: 'app ready' });
}

const bannerState = () => {
  const b = document.querySelector('#oc-banner .cc-banner');
  return b ? { cls: b.className, text: b.querySelector('.cc-text')?.textContent, code: b.querySelector('.cc-hint code')?.textContent ?? null, close: b.querySelector('.cc-close')?.getAttribute('aria-label') ?? null, visible: b.getClientRects().length > 0 } : null;
};

describe('🧩 OpenCode banner when contract checks fail', { skip: SKIP ?? false }, () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}: ⚠ names + npm run test:opencode, ✕ dismisses for good`, async () => {
      const page = await browser.newPage();
      try {
        await page.setViewport(vp);
        await openApp(page);
        await page.waitFor(() => document.querySelector('#oc-banner .cc-banner'), { message: 'warning banner' });
        const b = await page.eval(bannerState);
        assert.equal(b.text, `⚠ OpenCode v2.0.1: 2 cek kontrak gagal (${MODE}, ${SET_OPTION}) — beberapa fitur mungkin bermasalah.`);
        assert.match(b.cls, /\bwarn\b/);
        assert.equal(b.code, 'npm run test:opencode');
        assert.equal(b.close, 'Tutup pemberitahuan OpenCode');
        assert.equal(b.visible, true);
        assert.equal(await page.eval(horizontalOverflow), null);
        await page.click('#oc-banner .cc-close');
        await page.waitFor(() => !document.querySelector('#oc-banner .cc-banner'), { message: 'dismissed' });
        await openApp(page, { clearSeen: false });
        await sleep(400);
        assert.equal(await page.eval(bannerState), null, 'dismissed for good');
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });
  }

  test('desktop: ⚙ 🧩 Kompatibilitas OpenCode — status, manual run (laptop); hidden when not installed', async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport(VIEWPORTS[1]);
      await openApp(page);
      await tap(page, '#btn-settings');
      await page.click('[data-settings-tab="sistem"]');
      await page.waitFor(() => !document.querySelector('#settings-modal').hidden && !document.querySelector('#oc-section').hidden && /v2\.0\.1/.test(document.querySelector('#oc-status').textContent), { message: '⚙ OpenCode status' });
      assert.match(await page.eval(() => document.querySelector('#oc-status').textContent), /^Terpasang: v2\.0\.1\. Cek terakhir \(otomatis, tanpa token\) .*, v2\.0\.1: ⚠ 2 cek gagal: /);
      assert.equal(await page.eval(() => document.querySelector('#oc-status').classList.contains('warn')), true);
      assert.equal(await page.eval(() => document.querySelector('#oc-auto').checked), true);
      await page.eval(() => document.querySelector('#oc-run').scrollIntoView({ block: 'center' }));
      await page.click('#oc-run');
      await page.waitFor(() => /\(manual, tanpa token\)/.test(document.querySelector('#oc-status').textContent) && !document.querySelector('#oc-run').disabled, { timeoutMs: 30000, message: 'manual run finished' });
      // A view without OpenCode: the section and its separator disappear.
      await page.eval(async () => {
        const { applyOpenCodeCheck } = await import('/js/features/opencode-check.js');
        applyOpenCodeCheck({ available: false, version: null, failing: [], settings: { autoCheck: true } });
      });
      assert.equal(await page.eval(() => document.querySelector('#oc-section').hidden && document.querySelector('#oc-section-sep').hidden), true);
      assert.equal(await page.eval(bannerState), null);
      assert.deepEqual(page.problems, [], 'no console errors');
    } finally {
      await page.close();
    }
  });

  test('the settings route: booleans for autoCheck only (no model setting for OpenCode)', async () => {
    for (const bad of [{}, { autoCheck: 'yes' }, { allowModel: false }]) assert.equal((await api('/api/opencode-check/settings', bad)).status, 400, JSON.stringify(bad));
    const off = await api('/api/opencode-check/settings', { autoCheck: false });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body.settings, { autoCheck: false });
    assert.equal((await api('/api/opencode-check/settings', { autoCheck: true })).status, 200);
  });

  test('OpenCode updated while the server runs: the checked version stays in engines.opencode after a project refresh', async () => {
    writeFileSync(versionFile, '2.0.2');
    assert.equal((await api('/api/opencode-check/run')).status, 202);
    await waitView((v) => v.checkedVersion === '2.0.2' && !v.running, 'the manual check of v2.0.2');
    const engineVersion = async () => {
      const res = await fetch(`${BASE}/stream`);
      const reader = res.body.getReader();
      let text = '';
      while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
      reader.cancel();
      return JSON.parse(text.match(/^data: (.*)$/m)[1]).config.engines.opencode.version;
    };
    assert.equal(await engineVersion(), '2.0.2');
    assert.equal((await api('/api/projects/refresh')).status, 200); // rebuilds the config (refreshProjects)
    assert.equal(await engineVersion(), '2.0.2', 'not the version read at start');
  });
});
