// ♪ Spotify routes (src/routes/spotify.js) with a hand-made ctx: the route list, SpotifyError → HTTP status, and the
// callback page (never throws, never logs the URL). No server.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { SpotifyError, SpotifyService } from '../src/spotify.js';
import { buildRouter } from '../src/routes/index.js';
import { callback } from '../src/routes/spotify.js';
import { startFakeSpotify } from '../test-support/fake-spotify.mjs';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-spotify-routes-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const PORT = 4317;

/** A minimal ServerResponse: status, headers and body. */
function fakeRes() {
  const res = { status: 0, headers: {}, body: Buffer.alloc(0), headersSent: false };
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.writeHead = (status, headers = {}) => {
    res.status = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.headersSent = true;
  };
  res.end = (b) => (res.body = Buffer.from(b ?? ''));
  res.json = () => JSON.parse(res.body.toString('utf8'));
  return res;
}
const router = buildRouter();
async function call(ctx, p, body = {}, headers = {}) {
  const m = router.match('POST', p);
  assert.ok(m, `route ${p}`);
  const res = fakeRes();
  await m.route.handler(ctx, { headers }, res, m.params, body);
  return res;
}

test('routes: the ten /api/spotify/* routes are POST and registered', () => {
  const spotify = router.routes.filter((r) => r.pattern.startsWith('/api/spotify/')).map((r) => r.pattern);
  assert.deepEqual(spotify.sort(), ['art', 'config', 'control', 'devices', 'login', 'logout', 'playlist-items', 'playlists', 'settings', 'state'].map((a) => `/api/spotify/${a}`));
});

test('routes: SpotifyError codes map to statuses; 503 carries Retry-After; other errors go to server.js', async () => {
  const cases = { unconfigured: 409, disconnected: 409, revoked: 409, premium: 403, restricted: 403, 'no-device': 404, 'bad-request': 400, network: 502 };
  for (const [code, status] of Object.entries(cases)) {
    const res = await call({ spotify: { control: async () => Promise.reject(new SpotifyError(code)) } }, '/api/spotify/control', { action: 'next' });
    assert.equal(res.status, status, code);
    assert.equal(res.json().code, code);
    assert.ok(res.json().error.length > 5);
  }
  const limited = await call({ spotify: { control: async () => Promise.reject(new SpotifyError('rate-limited', { until: Date.now() + 90_000, retryAfter: 90 })) } }, '/api/spotify/control');
  assert.equal(limited.status, 503);
  assert.equal(limited.headers['retry-after'], '90');
  assert.equal(limited.json().retryAfter, 90);
  await assert.rejects(call({ spotify: { devices: async () => Promise.reject(new TypeError('bug')) } }, '/api/spotify/devices'), TypeError);
});

test('routes against the service: state, config (hint only), settings limited to duck, login origin, art bytes', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const spotify = new SpotifyService({ file: path.join(TMP, 'a', 'spotify.json'), redirectUri: `http://127.0.0.1:${PORT}/spotify/callback`, accountsOrigin: fake.origin, apiOrigin: fake.origin, artHosts: new Set([fake.host]), log: () => {}, timing: { afterWriteMs: [0, 5000] } });
  const ctx = { spotify, port: PORT };
  assert.equal((await call(ctx, '/api/spotify/state')).json().status, 'unconfigured');
  assert.equal((await call(ctx, '/api/spotify/login')).status, 409);
  const cfg = (await call(ctx, '/api/spotify/config', { clientId: '0123456789abcdef0123456789abcdef' })).json();
  assert.deepEqual(cfg, { clientIdSet: true, clientIdHint: '…cdef', clientIdSource: 'file', redirectUri: `http://127.0.0.1:${PORT}/spotify/callback`, connected: false, displayName: null, settings: { office: true, duck: 'off', duckVolume: 20, autoLaunch: true } });
  assert.deepEqual((await call(ctx, '/api/spotify/config')).json(), cfg, 'empty body = read');
  assert.equal((await call(ctx, '/api/spotify/config', { clientId: 'nope' })).status, 400);
  assert.deepEqual((await call(ctx, '/api/spotify/settings', { settings: { duck: 'duck' } })).json(), { settings: { office: true, duck: 'duck', duckVolume: 20, autoLaunch: true } });
  assert.equal((await call(ctx, '/api/spotify/settings', { settings: { office: false } })).status, 400, 'office toggle stays laptop-only');
  assert.equal((await call(ctx, '/api/spotify/settings', { clientId: 'ffffffffffffffffffffffffffffffff' })).json().settings.duck, 'duck', 'clientId ignored here');
  assert.equal(spotify.config().clientIdHint, '…cdef');

  // login: the page's own origin (localhost or 127.0.0.1) comes back as the callback page's link; anything else → localhost
  const { url } = (await call(ctx, '/api/spotify/login', { switchAccount: true }, { origin: `http://127.0.0.1:${PORT}` })).json();
  assert.equal(new URL(url).searchParams.get('show_dialog'), 'true');
  assert.equal(spotify.flow.returnOrigin, `http://127.0.0.1:${PORT}`);
  await call(ctx, '/api/spotify/login', {}, { origin: 'http://evil.example' });
  assert.equal(spotify.flow.returnOrigin, `http://localhost:${PORT}`);

  // full callback through the route
  const back = new URL((await fetch(spotify.startLogin({ returnOrigin: `http://localhost:${PORT}` }).url, { redirect: 'manual' })).headers.get('location'));
  const hop = fakeRes();
  await callback(ctx, { headers: { host: `127.0.0.1:${PORT}` } }, hop, back);
  assert.equal(hop.status, 303);
  assert.equal(hop.headers.location, '/spotify/callback?done=ok');
  // ?done=ok: success page while connected (a reload shows it again; no code is replayed)
  const res = fakeRes();
  await callback(ctx, { headers: { host: `127.0.0.1:${PORT}` } }, res, new URL(`http://127.0.0.1:${PORT}/spotify/callback?done=ok`));
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const html = res.body.toString('utf8');
  assert.match(html, /Spotify terhubung/);
  assert.match(html, new RegExp(`href="http://localhost:${PORT}/"`));
  assert.doesNotMatch(html, /<script/i, 'no script (CSP)');
  assert.doesNotMatch(html, /fake-code-|fake-access-/);

  const state = (await call(ctx, '/api/spotify/state')).json();
  assert.equal(state.status, 'playing');
  const art = await call(ctx, '/api/spotify/art', { id: state.track.artId });
  assert.equal(art.status, 200);
  assert.equal(art.headers['content-type'], 'image/jpeg');
  assert.equal(art.headers['cache-control'], 'private, max-age=86400');
  assert.equal(art.body[0], 0xff);
  assert.equal((await call(ctx, '/api/spotify/art', { id: 'zz' })).status, 400);
  assert.equal((await call(ctx, '/api/spotify/art', { id: '0123456789abcdef' })).status, 404);
  assert.equal((await call(ctx, '/api/spotify/playlists', { offset: -1 })).status, 400);
  assert.equal((await call(ctx, '/api/spotify/devices')).json().devices.length, 2);
  assert.equal((await call(ctx, '/api/spotify/control', { action: 'pause' })).json().status, 'paused');
  assert.deepEqual((await call(ctx, '/api/spotify/logout')).json(), { ok: true });
  const notConnected = fakeRes();
  await callback(ctx, { headers: { host: `127.0.0.1:${PORT}` } }, notConnected, new URL(`http://127.0.0.1:${PORT}/spotify/callback?done=ok`));
  assert.equal(notConnected.status, 400, '?done=ok never claims success while disconnected');
  assert.equal((await call(ctx, '/api/spotify/control', { action: 'play' })).status, 409);
});

test('callback: wrong state → 400 without a token request; wrong host → 404; a throwing service → 500 page, fixed log line', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const spotify = new SpotifyService({ file: path.join(TMP, 'b', 'spotify.json'), redirectUri: `http://127.0.0.1:${PORT}/spotify/callback`, accountsOrigin: fake.origin, apiOrigin: fake.origin, log: () => {} });
  spotify.setConfig({ clientId: '0123456789abcdef0123456789abcdef' });
  spotify.startLogin({ returnOrigin: `http://localhost:${PORT}` });
  const ctx = { spotify, port: PORT };
  const url = new URL(`http://127.0.0.1:${PORT}/spotify/callback?code=fake-code-SECRET&state=wrong`);
  const res = fakeRes();
  await callback(ctx, { headers: { host: `127.0.0.1:${PORT}` } }, res, url);
  assert.equal(res.status, 400);
  assert.match(res.body.toString(), /tidak valid/);
  assert.equal(fake.log.filter((l) => l.path === '/api/token').length, 0);

  const other = fakeRes();
  await callback(ctx, { headers: { host: `localhost:${PORT}` } }, other, url);
  assert.equal(other.status, 404);

  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const boom = fakeRes();
    await callback({ port: PORT, spotify: { finishLogin: async () => Promise.reject(new Error('code fake-code-SECRET leaked')) } }, { headers: { host: `127.0.0.1:${PORT}` } }, boom, url);
    assert.equal(boom.status, 500);
    // A response that already started: still no throw
    const half = fakeRes();
    half.headersSent = true;
    await callback({ port: PORT, spotify: { finishLogin: async () => Promise.reject(new Error('x')) } }, { headers: { host: `127.0.0.1:${PORT}` } }, half, url);
  } finally {
    console.error = orig;
  }
  assert.deepEqual(errors, ['Spotify: callback gagal (0/Error)', 'Spotify: callback gagal (0/Error)']);
});
