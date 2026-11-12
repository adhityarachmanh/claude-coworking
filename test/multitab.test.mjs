/* global document, window, PageTransitionEvent -- functions passed to page.eval run in the browser */
// Many tabs, one event stream: the real server (fake Claude Code, throwaway data) in a headless Chrome/Edge.
// HTTP/1.1 allows 6 connections per host; each tab used to hold one forever (EventSource /stream), so a few tabs
// left every other request pending. Now the tabs elect a leader that alone holds the stream and relays it over a
// BroadcastChannel (public/js/core/stream-share.js). Skipped when no browser is found.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TABS = 8; // more than the 6 connections per host Chrome allows over HTTP/1.1

let TMP;
let BASE;
let server;
let browser;
let projectId;
let token;
const openStreams = new Map(); // `${sessionId}:${requestId}` -> { sessionId, loaderId }, for every EventSource still open

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Polls `fn` (Node side) until truthy; throws after `timeoutMs`. */
async function until(fn, { timeoutMs = 5000, message = 'kondisi' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout menunggu ${message}`);
    await sleep(50);
  }
}

const apiPost = (p, body = {}) =>
  fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then((r) => r.json());

/** Open event streams in the browser, per page session (seen through the DevTools network events). */
const streamsOf = (page) => [...openStreams.values()].filter((s) => s.sessionId === page.sessionId).length;
const streamCount = () => openStreams.size;

function trackStreams(conn) {
  conn.on(({ method, params, sessionId }) => {
    const key = `${sessionId}:${params?.requestId}`;
    if (method === 'Network.requestWillBeSent' && params.type === 'EventSource') openStreams.set(key, { sessionId, loaderId: params.loaderId });
    else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') openStreams.delete(key);
    else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
      // DevTools reports no end for the requests of a document left behind: they belong to the old loader.
      for (const [k, s] of openStreams) if (s.sessionId === sessionId && s.loaderId !== params.frame.loaderId) openStreams.delete(k);
    }
  });
}

function forgetPage(page) {
  for (const [key, s] of openStreams) if (s.sessionId === page.sessionId) openStreams.delete(key);
}

// ---------- in-page probes ----------

function appReady() {
  return document.querySelector('#conn')?.classList.contains('ok') && document.querySelector('#crumb')?.textContent.trim().length > 0;
}

const role = () => document.documentElement.dataset.streamRole ?? '';
const chatHas = (marker) => document.querySelector('#chat')?.textContent.includes(marker) ?? false;

/** How long a plain GET and an API POST take from this page (capped: a queued request never resolves). */
async function requestTimes(apiToken) {
  const timed = async (fn) => {
    const t0 = performance.now();
    const ok = await Promise.race([fn().then((r) => r.ok), new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
    return { ok, ms: Math.round(performance.now() - t0) };
  };
  const [health, api] = await Promise.all([
    timed(() => fetch('/health', { cache: 'no-store' })),
    timed(() => fetch('/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': apiToken }, body: '{}' })),
  ]);
  return { health, api };
}

// ---------- helpers ----------

/**
 * Opens `n` tabs of the app into `pages` (the caller's array, filled as they open: a tab that fails to load mid-way
 * is still closed by the suite's after(), instead of leaking into — and failing — every later test).
 */
async function openTabs(n, { noLocks = false, pages = [] } = {}) {
  for (let i = 0; i < n; i++) {
    const page = await browser.newPage();
    pages.push(page);
    // Fallback election (a phone on plain-HTTP WiFi has no Web Locks): hide navigator.locks before the app runs.
    if (noLocks) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });" });
    await page.goto(`${BASE}/#${projectId}`, 30000); // several tabs load at once on a busy machine / CI runner
  }
  for (const page of pages) await page.waitFor(appReady, { timeoutMs: 20000, message: 'tab terhubung' });
  return pages;
}

async function closeTabs(pages) {
  for (const page of pages.splice(0)) {
    await page.close().catch(() => {});
    forgetPage(page);
  }
}

async function roles(pages) {
  return Promise.all(pages.map((p) => p.eval(role)));
}

async function leaderOf(pages, timeoutMs = 4000) {
  return until(
    async () => {
      const r = await roles(pages);
      return r.filter((x) => x === 'leader').length === 1 && r.every((x) => x === 'leader' || x === 'follower') ? pages[r.indexOf('leader')] : null;
    },
    { timeoutMs, message: 'tepat satu tab leader' },
  );
}

/** Sends a prompt (fake Claude answers) and waits until every tab shows it live. */
async function everyTabSeesChat(pages, marker) {
  await apiPost(`/api/projects/${projectId}/prompt`, { text: marker });
  await Promise.all(pages.map((p) => p.waitFor(chatHas, { timeoutMs: 10000, message: `chat "${marker}" tampil di tiap tab` }, marker)));
}

async function assertResponsive(pages) {
  const times = await Promise.all(pages.map((p) => p.eval(requestTimes, token)));
  for (const t of times) {
    assert.equal(t.health.ok, true, `GET /health selesai (${JSON.stringify(t)})`);
    assert.equal(t.api.ok, true, `POST API selesai (${JSON.stringify(t)})`);
    assert.ok(t.health.ms < 3000 && t.api.ms < 3000, `request cepat (${JSON.stringify(t)})`);
  }
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-multitab-'));
  mkdirSync(path.join(TMP, 'projects', 'toko', 'src'), { recursive: true });
  writeFileSync(path.join(TMP, 'projects', 'toko', 'src', 'checkout.ts'), 'export {};\n');
  mkdirSync(path.join(TMP, 'claude-projects'));
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_APP_DIR: APP, // pin the app dir to the repo: a dev machine's OFFICE_APP_DIR may point at an installed Adhitron
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPEN_DRY_RUN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server tidak siap dalam 20 s')), 20000);
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && (clearTimeout(timer), resolve()));
    server.on('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}`))));
  });
  server.stderr.resume();
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  // The project the chat events go to (the scanned "toko" folder).
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  projectId = JSON.parse(text.match(/^data: (.*)$/m)[1]).projects.find((p) => p.name === 'toko').id;
  browser = await launchBrowser();
  trackStreams(browser.conn);
});

after(async () => {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await Promise.race([exited, sleep(3000)]);
  }
  if (TMP) {
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(TMP, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

describe('Banyak tab, satu stream (Web Locks)', { skip: SKIP ?? false }, () => {
  const pages = [];
  after(async () => closeTabs(pages));

  test(`${TABS} tab: semua terhubung, hanya 1 /stream, request tetap cepat, chat live sampai ke semua tab`, async () => {
    await openTabs(TABS, { pages });
    await leaderOf(pages);
    await until(() => streamCount() === 1, { timeoutMs: 3000, message: 'hanya satu EventSource terbuka' });
    await assertResponsive(pages);
    await everyTabSeesChat(pages, 'halo semua tab 1');
    assert.equal(streamCount(), 1);
  });

  test('leader ditutup → tab lain mengambil alih (≤ 2 s) dan tetap menerima event', async () => {
    const leader = await leaderOf(pages);
    pages.splice(pages.indexOf(leader), 1);
    const t0 = Date.now();
    await closeTabs([leader]);
    const next = await leaderOf(pages, 3000);
    assert.ok(Date.now() - t0 < 3000, `pengambilalihan ${Date.now() - t0} ms`);
    await until(() => streamsOf(next) === 1 && streamCount() === 1, { timeoutMs: 3000, message: 'stream pindah ke leader baru' });
    await Promise.all(pages.map((p) => p.waitFor(appReady, { timeoutMs: 5000, message: 'tetap terhubung' })));
    await everyTabSeesChat(pages, 'halo setelah leader pergi');
    await assertResponsive(pages);
  });

  test('pagehide menutup stream leader; pageshow (bfcache) bergabung lagi sebagai follower', async () => {
    const leader = await leaderOf(pages);
    assert.equal(streamsOf(leader), 1);
    // What the browser fires when the page goes into the back/forward cache.
    await leader.eval(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await until(() => streamsOf(leader) === 0, { timeoutMs: 2000, message: 'stream tab yang disembunyikan tertutup' });
    assert.equal(await leader.eval(role), 'off');
    const others = pages.filter((p) => p !== leader);
    const next = await leaderOf(others, 3000);
    await until(() => streamsOf(next) === 1 && streamCount() === 1, { timeoutMs: 3000, message: 'leader baru memegang satu-satunya stream' });
    // Back from the cache: a follower again, synced, no second stream.
    await leader.eval(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await leader.waitFor(() => document.documentElement.dataset.streamRole === 'follower', { timeoutMs: 3000, message: 'kembali sebagai follower' });
    await leader.waitFor(appReady, { timeoutMs: 5000, message: 'terhubung lagi' });
    await everyTabSeesChat(pages, 'halo setelah bfcache');
    assert.equal(streamCount(), 1);
  });

  test('navigasi pergi lalu kembali (bfcache atau muat ulang): stream ikut tertutup, tetap satu stream', async () => {
    const leader = await leaderOf(pages);
    const others = pages.filter((p) => p !== leader);
    await leader.goto(`${BASE}/health`);
    await leaderOf(others, 3000); // the page left: its pagehide gave up the lead (and closed its stream)
    await until(() => streamsOf(leader) === 0 && streamCount() === 1, { timeoutMs: 3000, message: 'stream pindah saat halaman ditinggalkan' });
    const back = leader.waitForEvent('Page.frameNavigated', 10000);
    await leader.eval('history.back()');
    await back;
    await leader.waitFor(appReady, { timeoutMs: 10000, message: 'aplikasi kembali terhubung' });
    await leaderOf(pages);
    await until(() => streamCount() === 1, { timeoutMs: 3000, message: 'tetap satu stream' });
    await everyTabSeesChat(pages, 'halo setelah kembali');
  });
});

describe('Banyak tab, satu stream (tanpa Web Locks: HTTP biasa lewat WiFi)', { skip: SKIP ?? false }, () => {
  const pages = [];
  after(async () => closeTabs(pages));

  test('4 tab memilih satu leader lewat probe; leader ditutup → diambil alih, event tetap sampai', async () => {
    await openTabs(4, { noLocks: true, pages });
    assert.equal(await pages[0].eval('typeof navigator.locks'), 'undefined');
    await leaderOf(pages);
    await until(() => streamCount() === 1, { timeoutMs: 4000, message: 'hanya satu EventSource terbuka' });
    await assertResponsive(pages);
    await everyTabSeesChat(pages, 'halo tanpa locks');

    const leader = await leaderOf(pages);
    pages.splice(pages.indexOf(leader), 1);
    await closeTabs([leader]);
    await leaderOf(pages, 4000);
    await until(() => streamCount() === 1, { timeoutMs: 4000, message: 'satu stream di leader baru' });
    await Promise.all(pages.map((p) => p.waitFor(appReady, { timeoutMs: 5000, message: 'tetap terhubung' })));
    await everyTabSeesChat(pages, 'halo tanpa locks 2');
  });
});
