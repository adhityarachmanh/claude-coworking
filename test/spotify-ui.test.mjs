/* global document, window, visible, MessageEvent -- functions passed to page.eval run in the browser */
// ♪ Spotify UI (features/spotify.js, office/radio.js) in a headless Chrome/Edge (test-support/cdp.mjs), phone and
// desktop: the top-bar pill and the office radio for every status, the ♪ dialog's controls (exact POST bodies),
// album art as blob: URLs (old ones revoked), read-only WiFi (info only, no control requests), the ⚙ section,
// the Tailscale phone's duck setting, Ctrl+P entries, reduced motion (no bobbing). No console errors, no sideways
// scroll at 390 px, no unnamed buttons.
//
// The Spotify backend is faked IN THE PAGE (snapshot field, SSE `spotify` events, /api/spotify/* answers), so this
// test needs only the contract (docs/design-spotify.md §2), not src/spotify.js; the server is pointed at a closed
// loopback port so nothing can ever reach the real Spotify.
// SPOTIFY_UI_SHOTS=<folder> saves screenshots there.
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
const SHOTS = process.env.SPOTIFY_UI_SHOTS;
const READ_ONLY_HINT = 'Hanya lihat lewat WiFi — pakai Tailscale untuk mengirim perintah';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [
  { name: 'mobile 390x844', width: 390, height: 844, mobile: true },
  { name: 'desktop 1440x900', width: 1440, height: 900, mobile: false },
];

let TMP;
let BASE;
let server;
let browser;

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

/** Resolves once the server prints its ready line; rejects on exit or after `ms` (never waits forever). */
function serverReady(proc, ms = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server tidak siap dalam batas waktu')), ms);
    proc.stdout.on('data', (d) => String(d).includes('berjalan di') && (clearTimeout(timer), resolve()));
    proc.on('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}`))));
  });
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-spotify-ui-'));
  mkdirSync(path.join(TMP, 'projects', 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  const port = await freePort();
  const dead = await freePort(); // nothing listens there: the server's Spotify side can never reach out
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
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      SPOTIFY_CLIENT_ID: '',
      OFFICE_SPOTIFY_TEST_ORIGIN: `http://127.0.0.1:${dead}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.resume();
  await serverReady(server);
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await Promise.race([exited, sleep(3000)]);
  }
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------- fake Spotify, installed in the page before its own scripts ----------

/**
 * Runs before the app's modules (Page.addScriptToEvaluateOnNewDocument). `cfg`: { snap, client } — the snapshot's
 * `spotify` field (undefined = leave the server's) and a patch for `snapshot.client` (read-only WiFi, phone, …).
 * window.__sp: posts (every /api/spotify/* call), push(state) (an SSE `spotify` event), the fake player.
 */
function installSpotifyFake(cfg) {
  const fake = {
    posts: [],
    opened: [],
    created: [],
    revoked: [],
    failNext: {},
    state: cfg.snap ?? null,
    devices: [
      { id: 'dev-1', name: 'Laptop Adhit', type: 'computer', active: true, volume: 40, supportsVolume: true, restricted: false },
      { id: 'dev-2', name: 'HP Adhit', type: 'smartphone', active: false, volume: null, supportsVolume: true, restricted: false },
      { id: 'dev-3', name: 'TV Ruang Tamu', type: 'tv', active: false, volume: null, supportsVolume: false, restricted: true },
    ],
    playlists: [
      { id: 'A'.repeat(22), name: 'Fokus Ngoding', tracks: 42, artId: 'aaaaaaaaaaaaaaa1' },
      { id: 'B'.repeat(22), name: 'Lagu <b>Santai</b>', tracks: 12, artId: null },
      { id: 'C'.repeat(22), name: 'Jazz Pagi', tracks: 30, artId: 'aaaaaaaaaaaaaaa2' },
    ],
    config: { clientIdSet: false, clientIdHint: null, clientIdSource: null, redirectUri: 'http://127.0.0.1:4317/spotify/callback', connected: false, displayName: null, settings: { office: true, duck: 'off', duckVolume: 20 } },
  };
  window.__sp = fake;
  // Probes used inside page.eval callbacks (they run in the page, so they must live there).
  window.visible = (sel) => Boolean(document.querySelector(sel)?.getClientRects().length);

  // The event stream: keep a handle (for push) and patch the snapshot as the contract's server would send it.
  const RealES = window.EventSource;
  window.EventSource = class extends RealES {
    constructor(...args) {
      super(...args);
      fake.es = this;
    }
    addEventListener(type, fn, opts) {
      if (type !== 'snapshot') return super.addEventListener(type, fn, opts);
      return super.addEventListener(
        type,
        (msg) => {
          const data = JSON.parse(msg.data);
          if ('snap' in cfg) data.spotify = cfg.snap;
          if (cfg.client) data.client = { ...data.client, ...cfg.client };
          fn(new MessageEvent('snapshot', { data: JSON.stringify(data) }));
        },
        opts,
      );
    }
  };
  fake.push = (s) => {
    fake.state = s;
    fake.es.dispatchEvent(new MessageEvent('spotify', { data: JSON.stringify(s) }));
  };

  const realCreate = URL.createObjectURL.bind(URL);
  const realRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (b) => {
    const url = realCreate(b);
    fake.created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    fake.revoked.push(url);
    realRevoke(url);
  };
  window.open = (...args) => {
    fake.opened.push(args);
    return null;
  };
  window.confirm = () => true;

  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const png = () =>
    new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const g = c.getContext('2d');
      g.fillStyle = '#1db954';
      g.fillRect(0, 0, 8, 8);
      c.toBlob(resolve, 'image/png');
    });
  const control = (body) => {
    const s = { ...fake.state, at: Date.now(), updatedAt: Date.now() };
    if (body.action === 'pause') s.status = 'paused';
    if (body.action === 'play' || body.action === 'playlist') s.status = 'playing';
    if (body.action === 'next' || body.action === 'previous') s.track = { ...s.track, title: `${body.action} lagu`, artId: body.action === 'next' ? 'bbbbbbbbbbbbbbb2' : s.track.artId };
    if (body.action === 'volume') s.device = { ...s.device, volume: body.volume };
    fake.state = s;
    return s;
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const m = String(url).match(/\/api\/spotify\/([a-z]+)$/);
    if (!m) return realFetch(url, opts);
    const name = m[1];
    const body = opts.body ? JSON.parse(opts.body) : {};
    fake.posts.push({ name, body });
    const fail = fake.failNext[name];
    if (fail) {
      delete fake.failNext[name];
      return json(fail.body, fail.status);
    }
    switch (name) {
      case 'state':
        return json(fake.state);
      case 'art':
        return new Response(await png(), { headers: { 'Content-Type': 'image/png' } });
      case 'control':
        return json(control(body));
      case 'devices':
        return json({ devices: fake.devices });
      case 'playlists':
        return json(body.offset ? { items: [{ id: 'D'.repeat(22), name: 'Halaman Dua', tracks: 5, artId: null }], next: null } : { items: fake.playlists, next: 3 });
      case 'config': {
        if (body.clientId) fake.config = { ...fake.config, clientIdSet: true, clientIdHint: `…${body.clientId.slice(-4)}`, clientIdSource: 'file' };
        if (body.settings) fake.config = { ...fake.config, settings: { ...fake.config.settings, ...body.settings } };
        return json(fake.config);
      }
      case 'settings':
        fake.config = { ...fake.config, settings: { ...fake.config.settings, ...(body.settings ?? {}) } };
        return json({ settings: fake.config.settings });
      case 'login':
        return json({ url: 'https://accounts.spotify.com/authorize?response_type=code&client_id=x' });
      case 'logout':
        fake.config = { ...fake.config, connected: false, displayName: null };
        return json({ ok: true });
      default:
        return json({ error: 'not found' }, 404);
    }
  };
}

const TRACK = (over = {}) => ({ kind: 'track', title: 'Bengawan Solo', artists: 'Gesang', album: 'Keroncong Abadi', artId: 'aaaaaaaaaaaaaaa1', durationMs: 200000, ...over });
const DEVICE = { name: 'Laptop Adhit', type: 'computer', volume: 40, supportsVolume: true };
/** A publicState() (contract §2.6). `at` is filled in the page (Date.now() there) when `ago` is given. */
const STATE = (over = {}) => ({ status: 'playing', error: null, track: TRACK(), progressMs: 60000, at: Date.now() - 5000, device: DEVICE, office: true, updatedAt: Date.now(), ...over });

/** Replaces the page's init script (one per page: the fake of the previous navigation goes). */
async function setFake(page, source) {
  if (page.spotifyScript) await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: page.spotifyScript });
  ({ identifier: page.spotifyScript } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source }));
}

/** Navigates with a fresh fake (`cfg` as in installSpotifyFake) and waits for the app to be connected. */
async function open(page, cfg, hash = '') {
  await setFake(page, `(${installSpotifyFake})(${JSON.stringify(cfg)});`);
  page.clearProblems();
  await page.goto(`${BASE}/${hash}`);
  await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok') && window.__sp?.es, { timeoutMs: 15000, message: 'app connected' });
  await page.send('Page.bringToFront');
}

const push = (page, s) => page.eval((st) => window.__sp.push(st), s);
const posts = (page, name) => page.eval((n) => window.__sp.posts.filter((p) => !n || p.name === n).map((p) => p.body), name ?? null);
const clearPosts = (page) => page.eval(() => (window.__sp.posts = []));

// ---------- in-page probes ----------

function horizontalOverflow() {
  const { scrollWidth, clientWidth } = document.documentElement;
  const cards = [...document.querySelectorAll('.modal:not([hidden]) .modal-card')].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => `${c.parentElement.id}: ${c.scrollWidth} > ${c.clientWidth}`);
  const bar = document.querySelector('.topbar');
  const topbar = bar.scrollWidth > bar.clientWidth + 1 ? `topbar ${bar.scrollWidth} > ${bar.clientWidth}` : null;
  return scrollWidth > clientWidth || cards.length || topbar ? { scrollWidth, clientWidth, cards, topbar } : null;
}

function unnamed(sel) {
  return [...document.querySelectorAll(`${sel} button`)]
    .filter((b) => b.getClientRects().length && !(b.getAttribute('aria-label') || b.title || /[\p{L}\p{N}]/u.test(b.textContent)))
    .map((b) => b.outerHTML.slice(0, 120));
}

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(path.join(SHOTS, `${name}.png`), await page.screenshot());
}

function assertClean(page) {
  assert.deepEqual(page.problems, [], 'no console errors, exceptions or failed requests');
}

/** Phone: the office lives in its own view (bottom nav "Kantor"). */
async function showOffice(page, vp) {
  if (vp.mobile) await page.click('#mobile-nav [data-view="office"]');
  await page.waitFor(() => visible('#stage canvas'), { message: 'office visible' });
}

for (const vp of VIEWPORTS) {
  const tag = vp.mobile ? 'mobile' : 'desktop';
  describe(`♪ Spotify UI — ${vp.name}`, { skip: SKIP ?? false }, () => {
    let page;
    before(async () => {
      page = await browser.newPage();
      await page.setViewport(vp);
    });
    after(async () => page?.close());

    test('pill, office radio and 🗂 row follow the status; titles are text; art is a blob: URL (old one revoked)', async () => {
      await open(page, { snap: { status: 'unconfigured', error: null, track: null, progressMs: 0, at: 0, device: null, office: true, updatedAt: 0 } });
      await showOffice(page, vp);
      // unconfigured: no pill; the radio is plain decor but still a (named) button that leads to ⚙ on the laptop
      assert.equal(await page.eval(() => document.querySelector('#spotify-box').hidden), true);
      await page.waitFor(() => document.querySelector('#stage').dataset.music === 'none' && !document.querySelector('.office-radio').hidden, { message: 'radio decor + button' });
      assert.match(await page.eval(() => document.querySelector('.office-radio').getAttribute('aria-label')), /belum diatur/);
      const box = await page.eval(() => {
        const r = document.querySelector('.office-radio').getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
      assert.ok(box.w >= 32 && box.h >= 32, `radio hit area ≥ 32 px (${box.w}×${box.h})`);

      // disconnected (laptop): grey radio + "♪ Hubungkan" pill
      await push(page, { status: 'disconnected', error: null, track: null, progressMs: 0, at: 0, device: null, office: true, updatedAt: 0 });
      await page.waitFor(() => document.querySelector('#stage').dataset.music === 'off' && !document.querySelector('#spotify-box').hidden, { message: 'grey radio, Hubungkan pill' });
      assert.equal(await page.eval(() => document.querySelector('#spotify-pill').getAttribute('aria-label')), 'Spotify belum terhubung. Buka pengaturan Spotify');
      assert.equal(await page.eval(() => document.querySelector('#spotify-toggle').hidden), true, 'no ⏯ while disconnected');

      // playing, with a hostile title: shown as text, never as markup
      const evil = '<img src=x onerror="window.__xss=1">';
      await push(page, STATE({ track: TRACK({ title: evil }) }));
      await page.waitFor(() => document.querySelector('#stage').dataset.music === 'playing', { message: 'radio playing' });
      assert.equal(await page.eval(() => document.querySelector('#spotify-pill-text').textContent), `${evil} – Gesang`);
      assert.equal(await page.eval(() => document.querySelectorAll('#spotify-pill img').length), 1, 'only the art <img>, no injected one');
      assert.equal(await page.eval(() => window.__xss), undefined);
      assert.match(await page.eval(() => document.querySelector('.office-radio').getAttribute('aria-label')), /^Musik: «<img src=x onerror="window.__xss=1">» – Gesang, sedang diputar/);
      assert.equal(await page.eval(() => document.querySelector('#stage').dataset.groove), 'on', 'idle people groove while playing');
      assert.deepEqual(await page.eval(() => [document.querySelector('#spotify-toggle').hidden, document.querySelector('#spotify-toggle').getAttribute('aria-label')]), [false, 'Jeda musik']);
      // art: fetched once by id, shown as blob:
      await page.waitFor(() => document.querySelector('#spotify-pill img').src.startsWith('blob:') && !document.querySelector('#spotify-pill img').hidden, { message: 'pill art is a blob: URL' });
      assert.deepEqual(await posts(page, 'art'), [{ id: 'aaaaaaaaaaaaaaa1' }]);
      const firstArt = await page.eval(() => document.querySelector('#spotify-pill img').src);
      // progress bar interpolated client-side (no event needed): ~65 s of 200 s
      const width = await page.eval(() => parseFloat(document.querySelector('#spotify-pill .sp-pill-bar > span').style.width));
      assert.ok(width > 30 && width < 40, `progress ≈ 32% (${width})`);

      // the pill: full label on the laptop, art/♪ + ⏯ only (32 px) on a phone
      const pill = await page.eval(() => ({ pill: document.querySelector('#spotify-pill').getBoundingClientRect().width, toggle: { width: document.querySelector('#spotify-toggle').getBoundingClientRect().width, height: document.querySelector('#spotify-toggle').getBoundingClientRect().height }, text: document.querySelector('#spotify-pill-text').getBoundingClientRect().width }));
      if (vp.mobile) {
        assert.ok(pill.pill <= 33 && pill.text <= 1, `phone: icon only (${JSON.stringify(pill)})`);
      } else assert.ok(pill.text > 60, `desktop: the title is shown (${JSON.stringify(pill)})`);
      assert.ok(pill.toggle.width >= 32 && pill.toggle.height >= 32, `⏯ ≥ 32 px (${JSON.stringify(pill)})`);
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(await page.eval(unnamed, '.topbar'), []);
      assert.deepEqual(await page.eval(unnamed, '#stage'), []);
      await shot(page, `${tag}-1-playing`);

      // a new song: new art fetched, the old blob: URL revoked
      await push(page, STATE({ track: TRACK({ title: 'Di Bawah Sinar Bulan Purnama', artId: 'bbbbbbbbbbbbbbb2' }) }));
      await page.waitFor((old) => document.querySelector('#spotify-pill img').src.startsWith('blob:') && document.querySelector('#spotify-pill img').src !== old, { message: 'new art' }, firstArt);
      assert.ok((await page.eval(() => window.__sp.revoked)).includes(firstArt), 'previous art URL revoked');

      // paused: dim LED, no groove, ▶
      await push(page, STATE({ status: 'paused', track: TRACK({ artId: 'bbbbbbbbbbbbbbb2' }) }));
      await page.waitFor(() => document.querySelector('#stage').dataset.music === 'paused' && document.querySelector('#stage').dataset.groove === 'off', { message: 'paused radio' });
      assert.equal(await page.eval(() => document.querySelector('#spotify-toggle').getAttribute('aria-label')), 'Putar musik');

      // 🗂: one music row, with ⏯
      await page.eval(() => document.querySelector('#btn-dashboard').click());
      await page.waitFor(() => visible('#dash-music'), { message: 'dashboard music row' });
      assert.equal(await page.eval(() => document.querySelector('#dash-music-title').textContent), '♪ Bengawan Solo – Gesang');
      assert.match(await page.eval(() => document.querySelector('#dash-music-sub').textContent), /dijeda · Laptop Adhit/);
      assert.equal(await page.eval(() => visible('#dash-music-toggle')), true);
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(await page.eval(unnamed, '#dash-modal'), []);
      await shot(page, `${tag}-2-dashboard`);
      await clearPosts(page);
      await page.click('#dash-music-toggle');
      await page.waitFor(() => window.__sp.posts.some((p) => p.name === 'control'), { message: 'dashboard ⏯ sent' });
      assert.deepEqual(await posts(page, 'control'), [{ action: 'play' }]);
      await page.waitFor(() => document.querySelector('#dash-music-toggle').getAttribute('aria-label') === 'Jeda musik', { message: 'dashboard ⏯ applied' });
      await page.eval(() => (document.querySelector('#dash-modal').hidden = true));

      // the office off (⚙ "Tampilkan di kantor"): plain decor, no button
      await push(page, STATE({ office: false }));
      await page.waitFor(() => document.querySelector('.office-radio').hidden && document.querySelector('#stage').dataset.music === 'none', { message: 'radio off in the office' });
      assertClean(page);
    });

    test('♪ dialog: controls, volume, devices, playlists and palette send the contract bodies; error states', async () => {
      await open(page, { snap: STATE() });
      await page.click('#spotify-pill');
      await page.waitFor(() => visible('#spotify-modal') && document.activeElement?.id === 'sp-play', { message: 'dialog open, focus on ⏯' });
      await page.waitFor(() => document.querySelectorAll('#sp-devices input').length === 3, { message: 'devices listed' });
      assert.deepEqual(await page.eval(() => window.__sp.posts.map((p) => p.name).filter((n) => n !== 'art')), ['state', 'devices']);
      assert.equal(await page.eval(() => document.querySelector('#sp-title').textContent), 'Bengawan Solo');
      assert.match(await page.eval(() => document.querySelector('#sp-time').textContent), /^1:0[4-7] \/ 3:20$/);
      assert.equal(await page.eval(() => document.querySelector('#sp-progress').getAttribute('aria-valuemax')), '200');
      await page.waitFor(() => document.querySelector('#spotify-modal .sp-now img').src.startsWith('blob:'), { message: 'dialog art blob:' });
      assert.equal(await page.eval(() => document.querySelector('#sp-volume').value), '40');
      // restricted device: listed but not selectable
      assert.equal(await page.eval(() => document.querySelector('#sp-devices input[value="dev-3"]').disabled), true);

      await clearPosts(page);
      await page.click('#sp-play');
      await page.waitFor(() => document.querySelector('#sp-play').getAttribute('aria-label') === 'Putar musik', { message: 'paused after ⏯' });
      await page.click('#sp-play');
      await page.waitFor(() => document.querySelector('#sp-play').getAttribute('aria-label') === 'Jeda musik', { message: 'playing after ⏯' });
      await page.click('#sp-next');
      await page.waitFor(() => document.querySelector('#sp-title').textContent === 'next lagu', { message: 'next' });
      await page.click('#sp-prev');
      await page.waitFor(() => document.querySelector('#sp-title').textContent === 'previous lagu', { message: 'previous' });
      // volume: a drag (many input events) = one request after 250 ms; the closing `change` doesn't repeat it
      await page.eval(() => {
        const v = document.querySelector('#sp-volume');
        for (const n of [45, 52, 61, 70]) {
          v.value = String(n);
          v.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await page.waitFor(() => window.__sp.posts.some((p) => p.body.action === 'volume'), { message: 'volume sent' });
      await page.eval(() => document.querySelector('#sp-volume').dispatchEvent(new Event('change', { bubbles: true })));
      await sleep(400);
      // a device: transfer (keeps playing)
      await page.click('#sp-devices input[value="dev-2"]');
      await page.waitFor(() => window.__sp.posts.some((p) => p.body.action === 'transfer'), { message: 'transfer sent' });
      assert.deepEqual(await posts(page, 'control'), [{ action: 'pause' }, { action: 'play' }, { action: 'next' }, { action: 'previous' }, { action: 'volume', volume: 70 }, { action: 'transfer', deviceId: 'dev-2', play: true }]);

      // playlists: load on first open, filter, play one, "Muat lagi" with the server's next offset
      await clearPosts(page);
      await page.click('#sp-pl-toggle');
      await page.waitFor(() => document.querySelectorAll('#sp-pl-list li').length === 3, { message: 'playlists listed' });
      assert.equal(await page.eval(() => document.querySelector('#sp-pl-list li:nth-child(2) b').textContent), 'Lagu <b>Santai</b>', 'names are text');
      await page.waitFor(() => document.querySelector('#sp-pl-list li:first-child img')?.src.startsWith('blob:'), { message: 'playlist art blob:' });
      await page.eval(() => {
        const f = document.querySelector('#sp-pl-filter');
        f.value = 'jazz';
        f.dispatchEvent(new Event('input', { bubbles: true }));
      });
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll('#sp-pl-list li')].filter((li) => !li.hidden).map((li) => li.querySelector('b').textContent)), ['Jazz Pagi']);
      await page.click('#sp-pl-list li:nth-child(3) [data-playlist]');
      await page.waitFor(() => window.__sp.posts.some((p) => p.body.action === 'playlist'), { message: 'playlist played' });
      await page.eval(() => {
        const f = document.querySelector('#sp-pl-filter');
        f.value = '';
        f.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.click('#sp-pl-more');
      await page.waitFor(() => document.querySelectorAll('#sp-pl-list li').length === 4, { message: 'page two' });
      assert.deepEqual(await posts(page, 'playlists'), [{}, { offset: 3 }]);
      assert.deepEqual(await posts(page, 'control'), [{ action: 'playlist', playlistId: 'C'.repeat(22) }]);
      assert.equal(await page.eval(() => document.querySelector('#sp-pl-more').hidden), true, 'no more pages');
      assert.deepEqual(await page.eval(unnamed, '#spotify-modal'), []);
      assert.equal(await page.eval(horizontalOverflow), null);
      await shot(page, `${tag}-3-dialog`);

      // error states, in the dialog's status line
      await push(page, STATE({ status: 'idle', track: null, device: null, error: { code: 'no-device', message: 'x' } }));
      await page.waitFor(() => /Tidak ada perangkat aktif/.test(document.querySelector('#sp-status').textContent), { message: 'no-device text' });
      assert.equal(await page.eval(() => document.querySelector('#sp-devices-box').classList.contains('attention')), true, 'device picker highlighted');
      await shot(page, `${tag}-4-no-device`);
      await push(page, STATE({ error: { code: 'premium', message: 'x' } }));
      await page.waitFor(() => /Premium/.test(document.querySelector('#sp-status').textContent), { message: 'premium text' });
      assert.deepEqual(await page.eval(() => ['#sp-prev', '#sp-play', '#sp-next', '#sp-volume'].map((s) => document.querySelector(s).disabled)), [true, true, true, true]);
      const until = Date.now() + 3600_000;
      await push(page, STATE({ error: { code: 'rate-limited', message: 'x', until } }));
      const hhmm = await page.eval((u) => {
        const d = new Date(u);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }, until);
      await page.waitFor((t) => document.querySelector('#sp-status').textContent.includes(`coba lagi ${t}`), { message: 'rate-limited with time' }, hhmm);
      assert.equal(await page.eval(() => !document.querySelector('#spotify-pill-warn').hidden), true, '⚠ on the pill');
      await shot(page, `${tag}-5-rate-limited`);
      // a refused control (503): a toast with the retry time
      await push(page, STATE());
      await page.eval(() => (window.__sp.failNext.control = { status: 503, body: { error: 'Dibatasi Spotify.', code: 'rate-limited', retryAfter: 120 } }));
      await page.click('#sp-next');
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Dibatasi Spotify, coba lagi \d\d:\d\d/.test(t.textContent)), { message: '503 toast' });
      // disconnected: the way to connect
      await push(page, { status: 'disconnected', error: null, track: null, progressMs: 0, at: 0, device: null, office: true, updatedAt: 0 });
      await page.waitFor(() => document.querySelector('#sp-status').textContent === 'Hubungkan Spotify di ⚙ (laptop).' && document.querySelector('#sp-controls').hidden, { message: 'disconnected text' });
      assert.equal(await page.eval(() => visible('#sp-settings')), true, 'laptop: ⚙ Pengaturan Spotify');
      await page.press('Escape');
      await page.waitFor(() => document.querySelector('#spotify-modal').hidden, { message: 'Esc closes' });

      // Ctrl+P: the three music entries; "Musik: berikutnya" runs next
      await push(page, STATE());
      await clearPosts(page);
      await page.eval(() => {
        document.querySelector('#btn-palette').click();
        const input = document.querySelector('#palette-input');
        input.value = '>musik';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitFor(() => document.querySelectorAll('#palette-list .pal-opt').length >= 3, { message: 'palette music entries' });
      const labels = await page.eval(() => [...document.querySelectorAll('#palette-list .pal-label')].map((l) => l.textContent));
      for (const l of ['Musik: putar/jeda', 'Musik: berikutnya', 'Buka pemutar musik']) assert.ok(labels.includes(l), `palette has "${l}" (${labels})`);
      await page.eval(() => [...document.querySelectorAll('#palette-list .pal-opt')].find((o) => o.textContent.includes('Musik: berikutnya')).click());
      await page.waitFor(() => window.__sp.posts.some((p) => p.name === 'control'), { message: 'palette next' });
      assert.deepEqual(await posts(page, 'control'), [{ action: 'next' }]);
      await page.eval(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      assertClean(page);
    });

    test('read-only over WiFi: info shown, controls disabled with the hint, only state/art requested', async () => {
      const client = { local: false, accountAuth: false, readOnly: true, readOnlyApi: { paths: ['/api/spotify/state', '/api/spotify/art'], patterns: [] } };
      await open(page, { snap: STATE(), client });
      await showOffice(page, vp);
      await page.waitFor(() => document.body.classList.contains('read-only') && !document.querySelector('#spotify-box').hidden, { message: 'read-only page with pill' });
      assert.equal(await page.eval(() => document.querySelector('#spotify-toggle').hidden), true, 'no ⏯ in the top bar');
      // the radio opens the dialog
      await page.click('.office-radio');
      await page.waitFor(() => visible('#spotify-modal'), { message: 'dialog from the radio' });
      await page.waitFor(() => document.querySelector('#spotify-modal .sp-now img').src.startsWith('blob:'), { message: 'art allowed over WiFi' });
      assert.equal(await page.eval(() => document.querySelector('#sp-title').textContent), 'Bengawan Solo');
      const ctl = await page.eval(() => ['#sp-prev', '#sp-play', '#sp-next', '#sp-volume'].map((s) => [document.querySelector(s).disabled, document.querySelector(s).title]));
      for (const [disabled, title] of ctl) {
        assert.equal(disabled, true);
        assert.equal(title, READ_ONLY_HINT);
      }
      assert.equal(await page.eval(() => document.querySelector('#sp-ro').textContent), `👁 ${READ_ONLY_HINT}.`);
      assert.deepEqual(await page.eval(() => ['#sp-devices-box', '#sp-playlists-box', '#sp-settings', '#sp-duck-row'].map((s) => document.querySelector(s).hidden)), [true, true, true, true]);
      await page.eval(() => document.querySelector('#sp-play').click()); // disabled: nothing happens
      await sleep(200);
      assert.deepEqual([...new Set(await page.eval(() => window.__sp.posts.map((p) => p.name)))].sort(), ['art', 'state']);
      assert.deepEqual(await page.eval(unnamed, '#spotify-modal'), []);
      assert.equal(await page.eval(horizontalOverflow), null);
      await shot(page, `${tag}-6-read-only`);
      await page.eval(() => (document.querySelector('#spotify-modal').hidden = true));
      // 🗂 row: info, no ⏯
      await page.eval(() => document.querySelector('#btn-dashboard').click());
      await page.waitFor(() => visible('#dash-music'), { message: 'dashboard row' });
      assert.equal(await page.eval(() => document.querySelector('#dash-music-toggle').hidden), true);
      await page.eval(() => (document.querySelector('#dash-modal').hidden = true));
      // a phone never sees "♪ Hubungkan" (only the laptop can connect)
      await push(page, { status: 'disconnected', error: null, track: null, progressMs: 0, at: 0, device: null, office: true, updatedAt: 0 });
      await page.waitFor(() => document.querySelector('#spotify-box').hidden, { message: 'no pill on a disconnected phone' });
      assertClean(page);
    });

    test('Tailscale phone: controls work, the duck setting is changed through /settings', async () => {
      await open(page, { snap: STATE(), client: { local: false, accountAuth: true, readOnly: false } });
      await page.click('#spotify-pill');
      await page.waitFor(() => visible('#sp-duck-row'), { message: 'duck row on a Tailscale phone' });
      assert.equal(await page.eval(() => visible('#sp-settings')), false, 'no ⚙ link on a phone');
      assert.equal(await page.eval(() => document.querySelector('#sp-duck option[value="duck"]').textContent), 'Kecilkan (ke 20%)');
      await page.eval(() => {
        const s = document.querySelector('#sp-duck');
        s.value = 'pause';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitFor(() => window.__sp.posts.filter((p) => p.name === 'settings').length === 2, { message: 'duck saved' });
      assert.deepEqual(await posts(page, 'settings'), [{ settings: {} }, { settings: { duck: 'pause' } }]);
      assert.deepEqual(await posts(page, 'config'), [], 'never the laptop-only config');
      await page.eval(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      assert.equal(await page.eval(horizontalOverflow), null);
      await shot(page, `${tag}-7-tailscale`);
      assertClean(page);
    });

    test('⚙ Spotify (laptop): Client ID validation, Hubungkan opens the login URL, Putuskan, settings', async () => {
      await open(page, { snap: { status: 'unconfigured', error: null, track: null, progressMs: 0, at: 0, device: null, office: true, updatedAt: 0 } });
      await page.click('#btn-settings');
      await page.waitFor(() => visible('#sps') && document.querySelector('#sps-redirect').textContent.startsWith('http://127.0.0.1'), { message: 'Spotify section' });
      assert.equal(await page.eval(() => document.querySelector('#sps-connect').disabled), true, 'no Client ID yet: Hubungkan off');
      await page.eval(() => {
        const i = document.querySelector('#sps-client');
        i.value = 'bukan-client-id';
      });
      await page.click('#sps-save');
      await page.waitFor(() => /32 karakter/.test(document.querySelector('#sps-error').textContent), { message: 'invalid Client ID' });
      assert.equal(await page.eval(() => document.querySelector('#sps-client').getAttribute('aria-invalid')), 'true');
      assert.deepEqual(await posts(page, 'config'), [{}], 'nothing saved');
      await page.eval(() => (document.querySelector('#sps-client').value = '0123456789abcdef0123456789abcdef'));
      await page.click('#sps-save');
      await page.waitFor(() => !document.querySelector('#sps-connect').disabled, { message: 'Client ID saved' });
      assert.match(await page.eval(() => document.querySelector('#sps-client-hint').textContent), /••••cdef/);
      assert.equal(await page.eval(() => document.querySelector('#sps-client').value), '', 'the field is emptied: the id is never shown again');
      await page.click('#sps-connect');
      await page.waitFor(() => window.__sp.opened.length === 1, { message: 'login tab opened' });
      assert.deepEqual(await page.eval(() => window.__sp.opened[0]), ['https://accounts.spotify.com/authorize?response_type=code&client_id=x', '_blank', 'noopener']);
      assert.match(await page.eval(() => document.querySelector('#sps-status').textContent), /tab baru/);
      // the login finished in the other tab: the stream says connected, ⚙ reloads its status
      await page.eval(() => (window.__sp.config = { ...window.__sp.config, connected: true, displayName: 'Adhit' }));
      await push(page, STATE());
      await page.waitFor(() => /Terhubung sebagai Adhit/.test(document.querySelector('#sps-status').textContent) && !document.querySelector('#sps-logout').hidden, { message: 'connected status' });
      await page.eval(() => {
        const o = document.querySelector('#sps-office');
        o.checked = false;
        o.dispatchEvent(new Event('change', { bubbles: true }));
        const d = document.querySelector('#sps-duck');
        d.value = 'duck';
        d.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitFor(() => window.__sp.posts.filter((p) => p.name === 'config' && p.body.settings).length === 2, { message: 'settings saved' });
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(await page.eval(unnamed, '#settings-modal'), []);
      await page.eval(() => document.querySelector('#sps').scrollIntoView());
      await shot(page, `${tag}-8-settings`);
      await page.click('#sps-logout');
      await page.waitFor(() => !document.querySelector('#sps-revoke').hidden && /diputuskan/.test(document.querySelector('#sps-status').textContent), { message: 'disconnected' });
      assert.deepEqual(
        (await page.eval(() => window.__sp.posts.filter((p) => ['config', 'login', 'logout'].includes(p.name)).map((p) => [p.name, p.body]))).filter(([n, b]) => n !== 'config' || Object.keys(b).length),
        [
          ['config', { clientId: '0123456789abcdef0123456789abcdef' }],
          ['login', {}],
          ['config', { settings: { office: false } }],
          ['config', { settings: { duck: 'duck' } }],
          ['logout', {}],
        ],
      );
      await page.eval(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      assertClean(page);
    });

    test('prefers-reduced-motion: no bobbing and no notes (the LED stays)', async () => {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      try {
        await open(page, { snap: STATE() });
        await page.waitFor(() => document.querySelector('#stage').dataset.music === 'playing', { message: 'playing' });
        await sleep(300);
        assert.equal(await page.eval(() => document.querySelector('#stage').dataset.groove), 'off');
      } finally {
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      }
      await page.waitFor(() => document.querySelector('#stage').dataset.groove === 'on', { message: 'groove back without reduced motion' });
      assertClean(page);
    });

    test('a server without Spotify support: nothing shown, nothing requested', async () => {
      // An older server: a snapshot without the `spotify` field.
      await page.goto('about:blank');
      const src = `(${installSpotifyFake})({ client: {} }); (() => { const RealES = window.EventSource; window.EventSource = class extends RealES { addEventListener(type, fn, o) { return super.addEventListener(type, type === 'snapshot' ? (m) => { const d = JSON.parse(m.data); delete d.spotify; fn(new MessageEvent('snapshot', { data: JSON.stringify(d) })); } : fn, o); } }; })();`;
      await setFake(page, src);
      page.clearProblems();
      await page.goto(`${BASE}/`);
      await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 15000, message: 'app connected' });
      await sleep(300);
      assert.deepEqual(await page.eval(() => [document.querySelector('#spotify-box').hidden, document.querySelector('.office-radio').hidden, document.querySelector('#dash-music').hidden]), [true, true, true]);
      assert.deepEqual(await page.eval(() => window.__sp.posts), []);
      assertClean(page);
    });
  });
}
