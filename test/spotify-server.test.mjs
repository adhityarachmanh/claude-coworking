// ♪ Spotify end to end: the real server.js process against test-support/fake-spotify.mjs (OFFICE_SPOTIFY_TEST_ORIGIN,
// loopback only). OAuth through the real callback, SSE, refresh, errors, the WiFi/laptop gates, the backup, and the
// server's own output never carrying a token or code. No real Spotify, no real data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ZipReader } from '../src/zip.js';
import { startFakeSpotify } from '../test-support/fake-spotify.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-spotify-server-'));
const PORT = 4900 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const CLIENT = '0123456789abcdef0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fake;
let server;
let token;
let output = ''; // everything the server printed (stdout + stderr)
const events = [];
let streamAbort;

/** Starts server.js; resolves once it listens (or rejects on exit / after 20 s). */
function startServer(env, onOutput) {
  const child = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(env.port ?? PORT),
      OFFICE_DATA_DIR: path.join(TMP, env.dataDir ?? 'data'),
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale'),
      SPOTIFY_CLIENT_ID: '',
      OFFICE_SPOTIFY_TEST_ORIGIN: env.origin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
    const onData = (d) => {
      onOutput(String(d));
      if (String(d).includes('berjalan di')) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => onOutput(String(d)));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}`));
    });
  });
}

before(async () => {
  mkdirSync(path.join(TMP, 'projects', 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  fake = await startFakeSpotify();
  server = await startServer({ origin: fake.origin }, (s) => (output += s));
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  streamAbort = listen();
});

after(async () => {
  streamAbort?.abort();
  server?.kill();
  await fake?.close();
  await sleep(300);
  rmSync(TMP, { recursive: true, force: true });
});

/** The laptop's event stream, parsed into `events`. */
function listen(base = BASE, headers = {}, sink = events) {
  const controller = new AbortController();
  (async () => {
    const res = await fetch(`${base}/stream`, { signal: controller.signal, headers });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = frame.match(/^event: (.*)$/m)?.[1];
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (type && data) sink.push({ type, obj: JSON.parse(data), raw: data });
      }
    }
  })().catch(() => {});
  return controller;
}

async function waitEvent(pred, ms = 8000, sink = events) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = sink.find((e) => pred(e.type, e.obj));
    if (hit) return hit;
    await sleep(25);
  }
  assert.fail(`timeout; last events: ${sink.slice(-5).map((e) => e.type).join(', ')}`);
}

const api = (p, body = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers }));
const tokenRequests = () => fake.log.filter((l) => l.path === '/api/token').length;

test('test hook: logged as a warning; the snapshot carries `spotify` (unconfigured), config carries the redirect URI', async () => {
  assert.match(output, new RegExp(`PERINGATAN: OFFICE_SPOTIFY_TEST_ORIGIN aktif — Spotify: MODE TEST \\(${fake.origin.replace(/\./g, '\\.')}\\)`));
  const snap = await waitEvent((t) => t === 'snapshot');
  assert.deepEqual(snap.obj.spotify, { status: 'unconfigured', error: null, track: null, progressMs: 0, at: 0, device: null, office: true, launching: false, updatedAt: 0 });
  assert.equal(snap.obj.config.spotify.redirectUri, `http://127.0.0.1:${PORT}/spotify/callback`);
});

test('OAuth end to end: config → login → Spotify authorize → callback on 127.0.0.1 → SSE `spotify` playing', async () => {
  assert.equal((await api('/api/spotify/login')).status, 409, 'no Client ID yet');
  const cfg = await api('/api/spotify/config', { clientId: CLIENT });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.clientIdHint, '…cdef');
  const { url } = (await api('/api/spotify/login')).body;
  assert.ok(url.startsWith(`${fake.origin}/authorize?`));
  const redirect = await fetch(url, { redirect: 'manual' });
  const location = redirect.headers.get('location');
  assert.ok(location.startsWith(`http://127.0.0.1:${PORT}/spotify/callback?`), location);

  // the callback on another host name of the laptop is not ours
  const wrongHost = await fetch(location.replace('127.0.0.1', 'localhost'));
  assert.equal(wrongHost.status, 404);
  const hop = await fetch(location, { redirect: 'manual' });
  assert.equal(hop.status, 303, 'success redirects away from the URL holding code + state');
  assert.equal(hop.headers.get('location'), '/spotify/callback?done=ok');
  const page = await fetch(new URL(hop.headers.get('location'), location));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await page.text();
  assert.match(html, /Spotify terhubung/);
  assert.doesNotMatch(html, /<script/i);
  const playing = await waitEvent((t, o) => t === 'spotify' && o.status === 'playing');
  assert.equal(playing.obj.track.title, 'Lagu Satu');
  assert.doesNotMatch(playing.raw, /fake-|spotify:|"id"|Adhit Test/);
  const again = await fetch(location);
  assert.equal(again.status, 400, 'single use');
  assert.equal(tokenRequests(), 1);
  assert.equal((await api('/api/spotify/config')).body.displayName, 'Adhit Test', 'account name only in ⚙ (laptop)');
  const stored = JSON.parse(readFileSync(path.join(TMP, 'data', 'spotify.json'), 'utf8'));
  assert.equal(stored.auth.origin, fake.origin);
});

test('API: state, art, devices, playlists, control; refresh after an expired token', async () => {
  const state = await api('/api/spotify/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.status, 'playing');
  const art = await api('/api/spotify/art', { id: state.body.track.artId });
  assert.equal(art.status, 200);
  assert.equal(art.headers.get('content-type'), 'image/jpeg');
  assert.equal(art.headers.get('x-content-type-options'), 'nosniff');
  const { devices } = (await api('/api/spotify/devices')).body;
  assert.equal(devices.length, 2);
  assert.equal((await api('/api/spotify/playlists')).body.items[0].name, 'Fokus Ngoding');
  const paused = await api('/api/spotify/control', { action: 'pause' });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, 'paused');
  await waitEvent((t, o) => t === 'spotify' && o.status === 'paused');
  assert.equal((await api('/api/spotify/control', { action: 'transfer', deviceId: 'not-listed' })).status, 400);

  const before = tokenRequests();
  fake.expireAccess();
  assert.equal((await api('/api/spotify/control', { action: 'play' })).body.status, 'playing', '401 → refresh → retried once');
  assert.equal(tokenRequests(), before + 1);
});

test('errors: no device → 404 no-device, Premium → 403 premium, 429 → 503 with Retry-After and no requests while blocked', async () => {
  fake.set({ noDevice: true });
  const none = await api('/api/spotify/control', { action: 'play' });
  assert.equal(none.status, 404);
  assert.equal(none.body.code, 'no-device');
  assert.match(none.body.error, /perangkat aktif/);
  await sleep(2100); // POST /state polls only when its data is older than 2 s
  assert.equal((await api('/api/spotify/state')).body.error.code, 'no-device');
  fake.set({ noDevice: false, premiumRequired: true });
  const premium = await api('/api/spotify/control', { action: 'next' });
  assert.equal(premium.status, 403);
  assert.equal(premium.body.code, 'premium');
  fake.set({ premiumRequired: false, rateLimit: { retryAfter: 3600 } });
  await sleep(2100); // POST /state polls only when its data is older than 2 s
  const limited = await api('/api/spotify/state');
  assert.equal(limited.status, 200, 'reads keep the cache');
  assert.equal(limited.body.error.code, 'rate-limited');
  const count = fake.log.length;
  const write = await api('/api/spotify/control', { action: 'pause' });
  assert.equal(write.status, 503);
  assert.ok(write.body.retryAfter > 3500);
  assert.equal(write.headers.get('retry-after'), String(write.body.retryAfter));
  await api('/api/spotify/state');
  assert.equal(fake.log.length, count, 'nothing sent to Spotify during the block');
});

test('backup: data/spotify.json is not in the export, state.json has no spotify key', async () => {
  const res = await fetch(`${BASE}/api/backup/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: '{}' });
  assert.equal(res.status, 200);
  const file = path.join(TMP, 'backup.zip');
  const out = createWriteStream(file);
  for await (const chunk of res.body) out.write(chunk);
  await new Promise((r) => out.end(r));
  const zip = await ZipReader.open(file);
  const names = zip.entries.map((e) => e.name);
  const state = (await zip.read(zip.entries.find((e) => e.name === 'office/state.json'))).toString('utf8');
  const all = [];
  for (const e of zip.entries) if (!e.name.endsWith('/')) all.push((await zip.read(e)).toString('latin1'));
  await zip.close();
  assert.ok(!names.some((n) => /spotify/i.test(n)), names.join('\n'));
  assert.ok(!('spotify' in JSON.parse(state)));
  for (const t of [...fake.issued.access, ...fake.issued.refresh]) assert.ok(!all.some((c) => c.includes(t)), 'no token in any entry');
});

test('phones: WiFi may read state/art only; settings is refused as read-only (so Tailscale passes); config/login/logout laptop-only; callback 404', async (t) => {
  const { lanAddresses } = await import('../src/remote.js');
  const ip = lanAddresses()[0];
  if (!ip) return t.skip('no LAN address on this machine');
  fake.set({ rateLimit: false });
  const LAN = `http://${ip}:${PORT}`;
  assert.equal((await api('/api/remote', { enabled: true })).status, 200);
  try {
    await sleep(300);
    const { code } = (await api('/api/remote/pairing')).body;
    const paired = await fetch(`${LAN}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie').split(';')[0];
    const phoneToken = (await (await fetch(`${LAN}/`, { headers: { Cookie: cookie } })).text()).match(/office-token" content="([^"]+)"/)[1];
    const phone = (p, body = {}) => fetch(LAN + p, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Office-Token': phoneToken }, body: JSON.stringify(body) });

    const state = await phone('/api/spotify/state');
    assert.equal(state.status, 200);
    const s = await state.json();
    assert.doesNotMatch(JSON.stringify(s), /fake-|spotify:|Adhit Test/);
    if (s.track?.artId) assert.equal((await phone('/api/spotify/art', { id: s.track.artId })).status, 200);
    for (const p of ['control', 'devices', 'playlists', 'settings']) {
      const r = await phone(`/api/spotify/${p}`, { action: 'next', settings: { duck: 'pause' } });
      assert.equal(r.status, 403, p);
      assert.equal((await r.json()).readOnly, true, `${p}: refused by the WiFi gate only (allowed over Tailscale)`);
    }
    for (const p of ['config', 'login', 'logout']) {
      const r = await phone(`/api/spotify/${p}`, { clientId: 'ffffffffffffffffffffffffffffffff' });
      assert.equal(r.status, 403, p);
      assert.match((await r.json()).error, /laptop/, `${p}: laptop only, Tailscale too`);
    }
    assert.equal((await fetch(`${LAN}/spotify/callback?code=x&state=y`, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 404);
    assert.equal((await fetch(`${LAN}/spotify/callback?code=x&state=y`, { redirect: 'manual' })).status, 404, 'unpaired too (no redirect to /pair)');
    // a phone's snapshot carries the same filtered state
    const phoneEvents = [];
    const ctl = listen(LAN, { Cookie: cookie }, phoneEvents);
    const snap = await waitEvent((type) => type === 'snapshot', 5000, phoneEvents);
    ctl.abort();
    assert.ok(snap.obj.spotify && snap.obj.client.readOnly);
    assert.doesNotMatch(JSON.stringify(snap.obj.spotify), /fake-|spotify:/);
    assert.equal(JSON.parse(readFileSync(path.join(TMP, 'data', 'spotify.json'), 'utf8')).clientId, CLIENT, 'nothing changed');
  } finally {
    await api('/api/remote', { enabled: false });
  }
});

test('logout from the laptop; the server output never held a token, code or verifier', async () => {
  assert.deepEqual((await api('/api/spotify/logout')).body, { ok: true });
  await waitEvent((t, o) => t === 'spotify' && o.status === 'disconnected');
  assert.equal(JSON.parse(readFileSync(path.join(TMP, 'data', 'spotify.json'), 'utf8')).auth, null);
  assert.ok(fake.issued.codes.length && fake.issued.access.length);
  for (const secret of [...fake.issued.access, ...fake.issued.refresh, ...fake.issued.codes]) assert.ok(!output.includes(secret), 'secret in server output');
  assert.doesNotMatch(output, /fake-(access|refresh|code)-|code_verifier|Bearer /);
});

test('test hook: anything but http://127.0.0.1:<port> is ignored with a warning', async () => {
  let out = '';
  const port = PORT + 400;
  const child = await startServer({ origin: 'https://evil.example:443', port, dataDir: 'data2' }, (s) => (out += s));
  try {
    await sleep(200);
    assert.match(out, /OFFICE_SPOTIFY_TEST_ORIGIN diabaikan/);
    assert.doesNotMatch(out, /MODE TEST/);
  } finally {
    child.kill();
  }
});
