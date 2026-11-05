// ♪ Spotify service (src/spotify.js) against test-support/fake-spotify.mjs: PKCE, login state, token store and
// refresh, 429, polling, mapping, control validation, art proxy, timeouts, duck. No server, no real Spotify.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { SPOTIFY_SCOPES, SpotifyService, newVerifier, pkceChallenge } from '../src/spotify.js';
import { FAKE_DEVICE_ID, FAKE_PLAYLIST_ID, startFakeSpotify } from '../test-support/fake-spotify.mjs';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-spotify-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const CLIENT = '0123456789abcdef0123456789abcdef';
const REDIRECT = 'http://127.0.0.1:4317/spotify/callback';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

/** Waits for a condition with a deadline (never unbounded). */
async function until(pred, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(10);
  }
  assert.fail(`timeout waiting for ${what}`);
}

/** A service on a fresh data file, pointed at the fake, with fast timing. */
function make(fake, o = {}) {
  const logs = [];
  const states = [];
  const clock = { skew: 0 };
  const svc = new SpotifyService({
    file: o.file ?? path.join(TMP, `s${++n}`, 'spotify.json'),
    redirectUri: REDIRECT,
    viewers: o.viewers ?? (() => 1),
    onChange: (s) => states.push(s),
    envClientId: o.envClientId,
    accountsOrigin: fake.origin,
    apiOrigin: fake.origin,
    artHosts: new Set([fake.host]),
    fetch: o.fetch,
    now: () => Date.now() + clock.skew,
    log: (m) => logs.push(m),
    timing: { playMs: 60_000, pausedMs: 60_000, afterWriteMs: [0, 5000], volumeGapMs: 30, duckRestoreMs: 50, requestMs: 300, tokenMs: 300, stateFreshMs: 0, ...o.timing },
  });
  if (o.clientId !== false) svc.setConfig({ clientId: o.clientId ?? CLIENT });
  return { svc, logs, states, clock };
}

/** Runs the whole login against the fake: authorize (auto-approve, 302) then the callback. */
async function login(svc, extra = {}) {
  const { url } = svc.startLogin({ returnOrigin: 'http://localhost:4317' });
  const res = await fetch(url, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get('location'));
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  return svc.finishLogin({ code: back.searchParams.get('code'), state: back.searchParams.get('state'), error: back.searchParams.get('error'), ...extra });
}

/** Recursively: no key or value that could identify a token, id, uri, Client ID or the account. */
function assertClean(obj, fake) {
  const bad = [/fake-(access|refresh|code)-/, /spotify:/, new RegExp(CLIENT), /Adhit Test/, new RegExp(FAKE_DEVICE_ID), new RegExp(FAKE_PLAYLIST_ID), /4uLU6hMCjMI75M1A2tKUQC/, /user-fake-123/];
  const walk = (v, where) => {
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        assert.ok(!['id', 'uri', 'token', 'accessToken', 'refreshToken', 'clientId', 'displayName', 'deviceId'].includes(k), `key ${where}.${k}`);
        walk(x, `${where}.${k}`);
      }
    } else if (typeof v === 'string') for (const re of bad) assert.doesNotMatch(v, re, where);
  };
  walk(obj, 'state');
  if (fake) for (const t of [...fake.issued.access, ...fake.issued.refresh, ...fake.issued.codes]) assert.ok(!JSON.stringify(obj).includes(t));
}

const tokenRequests = (fake) => fake.log.filter((l) => l.path === '/api/token').length;

test('PKCE: RFC 7636 appendix B vector; verifier length and charset', () => {
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  for (let i = 0; i < 20; i++) {
    const v = newVerifier();
    assert.match(v, /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(v.length, 86);
  }
});

test('authorize URL: minimal scopes, S256, exact redirect URI; show_dialog only to switch account; needs a Client ID', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc } = make(fake, { clientId: false });
  assert.throws(() => svc.startLogin({ returnOrigin: 'http://localhost:4317' }), { code: 'unconfigured' });
  assert.equal(svc.publicState().status, 'unconfigured');
  svc.setConfig({ clientId: CLIENT.toUpperCase() });
  const u = new URL(svc.startLogin({ returnOrigin: 'http://localhost:4317' }).url);
  assert.equal(`${u.origin}${u.pathname}`, `${fake.origin}/authorize`);
  const q = u.searchParams;
  assert.deepEqual(q.get('scope').split(' '), ['user-read-playback-state', 'user-modify-playback-state', 'playlist-read-private']);
  assert.deepEqual(SPOTIFY_SCOPES, q.get('scope').split(' '));
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('code_challenge'), /^[\w-]{43}$/);
  assert.equal(q.get('redirect_uri'), REDIRECT);
  assert.equal(q.get('client_id'), CLIENT);
  assert.equal(q.get('response_type'), 'code');
  assert.match(q.get('state'), /^[\w-]{43}$/);
  assert.equal(q.get('show_dialog'), null);
  assert.equal(new URL(svc.startLogin({ returnOrigin: 'x', switchAccount: true }).url).searchParams.get('show_dialog'), 'true');
  assert.equal(svc.publicState().status, 'disconnected');
});

test('login state: wrong, reused, expired or denied → no token exchange; a forged state keeps the real flow alive', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc, clock } = make(fake);
  assert.deepEqual(await svc.finishLogin({ code: 'x', state: 'nope' }), { error: 'invalid-state', returnOrigin: null }, 'no flow at all');
  const { url } = svc.startLogin({ returnOrigin: 'http://localhost:4317' });
  const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  const code = back.searchParams.get('code');
  const state = back.searchParams.get('state');
  assert.equal((await svc.finishLogin({ code, state: `${state.slice(0, -1)}A` === state ? `${state.slice(0, -1)}B` : `${state.slice(0, -1)}A` })).error, 'invalid-state');
  assert.equal(tokenRequests(fake), 0, 'a wrong state exchanges nothing');
  const ok = await svc.finishLogin({ code, state });
  assert.equal(ok.ok, true, 'the real login still works after a forged attempt');
  assert.equal(ok.returnOrigin, 'http://localhost:4317');
  assert.equal(tokenRequests(fake), 1);
  assert.equal((await svc.finishLogin({ code, state })).error, 'invalid-state', 'single use');
  assert.equal(tokenRequests(fake), 1);

  // expired after 10 minutes
  const second = new URL(svc.startLogin({ returnOrigin: 'http://localhost:4317' }).url).searchParams.get('state');
  clock.skew = 10 * 60_000 + 1;
  assert.equal((await svc.finishLogin({ code: 'fake-code-x', state: second })).error, 'invalid-state');
  clock.skew = 0;
  assert.equal(tokenRequests(fake), 1);

  // denied at Spotify: "Dibatalkan", flow gone
  fake.set({ deny: true });
  const denied = await login(svc);
  assert.equal(denied.error, 'denied');
  assert.equal(tokenRequests(fake), 1);
});

test('token store: atomic file without secret, origin-bound; state carries no token, id or name', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc, logs } = make(fake);
  assert.equal((await login(svc)).ok, true);
  const raw = JSON.parse(readFileSync(svc.file, 'utf8'));
  assert.equal(raw.v, 1);
  assert.equal(raw.clientId, CLIENT);
  assert.equal(raw.auth.origin, fake.origin);
  assert.match(raw.auth.accessToken, /^fake-access-/);
  assert.match(raw.auth.refreshToken, /^fake-refresh-/);
  assert.equal(raw.auth.displayName, 'Adhit Test');
  assert.ok(!/secret/i.test(JSON.stringify(raw)), 'no client secret anywhere');
  assert.ok(!existsSync(`${svc.file}.tmp`), 'temp file renamed away');
  if (process.platform !== 'win32') assert.equal(statSync(svc.file).mode & 0o777, 0o600);
  assert.equal(svc.config().displayName, 'Adhit Test');
  assert.equal(svc.config().clientIdHint, '…cdef');
  assert.ok(!JSON.stringify(svc.config()).includes(CLIENT), 'config shows only a hint');

  const s = await svc.refreshState();
  assert.equal(s.status, 'playing');
  assert.deepEqual(Object.keys(s).sort(), ['at', 'device', 'error', 'launching', 'office', 'progressMs', 'status', 'track', 'updatedAt']);
  assert.deepEqual(s.track, { kind: 'track', title: 'Lagu Satu', artists: 'Artis Fake', album: 'Album Fake', artId: s.track.artId, durationMs: 200_000 });
  assert.match(s.track.artId, /^[0-9a-f]{16}$/);
  assert.deepEqual(s.device, { name: 'Laptop Adhit', type: 'computer', volume: 60, supportsVolume: true });
  assert.equal(s.progressMs, 30_000);
  assert.equal(s.office, true);
  assertClean(s, fake);
  const page = await svc.playlists();
  assertClean({ ...s, logs }, fake);
  assert.equal(page.items.length, 1, 'malformed playlist ids are dropped');
  assert.deepEqual({ ...page.items[0], artId: null }, { id: FAKE_PLAYLIST_ID, name: 'Fokus Ngoding', tracks: 42, artId: null }, 'Feb 2026 `items.total` read');
  assert.equal(page.next, 50);

  // reload: same origin keeps the login; another origin drops it (a fake token never reaches the real service)
  const again = new SpotifyService({ file: svc.file, redirectUri: REDIRECT, accountsOrigin: fake.origin, apiOrigin: fake.origin, log: () => {} });
  assert.equal(again.connected, true);
  const real = new SpotifyService({ file: svc.file, redirectUri: REDIRECT, log: () => {} });
  assert.equal(real.connected, false);
  assert.equal(real.publicState().status, 'disconnected');
  await sleep(20);
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).auth, null, 'the foreign token is removed from disk');
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).clientId, CLIENT, 'the Client ID stays');
});

test('store: a corrupt file is set aside; Client ID validated; env is a read-only fallback; a new Client ID logs out', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const dir = path.join(TMP, 'corrupt');
  const file = path.join(dir, 'spotify.json');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, '{"auth": {"accessToken": "fake-access-LEAK"');
  const { svc, logs } = make(fake, { file, clientId: false });
  assert.ok(readdirSync(dir).some((f) => f.startsWith('spotify.json.corrupt-')));
  assert.equal(svc.publicState().status, 'unconfigured');
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /LEAK/);

  assert.throws(() => svc.setConfig({ clientId: 'abc' }), { code: 'bad-request' });
  assert.throws(() => svc.setConfig({ settings: { duckVolume: 80 } }), { code: 'bad-request' });
  assert.throws(() => svc.setConfig({ settings: { nope: 1 } }), { code: 'bad-request' });
  assert.throws(() => svc.setConfig({ settings: { office: false } }, { settingsOnly: true }), { code: 'bad-request' }, 'phones change only the duck settings');
  assert.deepEqual(svc.setConfig({ settings: { duck: 'pause', duckVolume: 10 } }, { settingsOnly: true }).settings, { office: true, duck: 'pause', duckVolume: 10, autoLaunch: true });

  const env = make(fake, { clientId: false, envClientId: 'ffffffffffffffffffffffffffffffff' });
  assert.equal(env.svc.config().clientIdSource, 'env');
  assert.throws(() => env.svc.setConfig({ clientId: CLIENT }), /SPOTIFY_CLIENT_ID/);

  const { svc: s2 } = make(fake);
  await login(s2);
  assert.equal(s2.connected, true);
  s2.setConfig({ clientId: 'abcdefabcdefabcdefabcdefabcdefab' });
  assert.equal(s2.connected, false, 'tokens belong to the old app');
  assert.equal(JSON.parse(readFileSync(s2.file, 'utf8')).auth, null);
});

test('refresh: 60 s before expiry, single-flight, rotation stored (or the old one kept)', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc, clock } = make(fake, { viewers: () => 0 });
  await login(svc);
  const first = JSON.parse(readFileSync(svc.file, 'utf8')).auth;
  clock.skew = 3600_000 - 59_000; // 59 s left
  await Promise.all([1, 2, 3, 4, 5].map(() => svc.refreshState()));
  assert.equal(tokenRequests(fake), 2, '1 exchange + exactly 1 refresh for 5 concurrent calls');
  const second = JSON.parse(readFileSync(svc.file, 'utf8')).auth;
  assert.notEqual(second.accessToken, first.accessToken);
  assert.notEqual(second.refreshToken, first.refreshToken, 'rotated refresh token stored');
  assert.ok(second.expiresAt > first.expiresAt);
  fake.set({ noRotation: true });
  clock.skew += 3600_000;
  await svc.refreshState();
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).auth.refreshToken, second.refreshToken, 'no new one → keep the old');
});

test('refresh invalid_grant → disconnected (revoked), tokens erased; 401 → one refresh and one retry', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc, clock, states } = make(fake, { viewers: () => 0 });
  await login(svc);
  fake.set({ unauthorizedOnce: true });
  const before = fake.log.length;
  const s = await svc.refreshState();
  assert.equal(s.status, 'playing');
  const calls = fake.log.slice(before).map((l) => l.path);
  assert.deepEqual(calls, ['/v1/me/player', '/api/token', '/v1/me/player'], '401 → refresh → retry, once');

  fake.set({ invalidGrant: true });
  clock.skew = 3600_000;
  const after = await svc.refreshState();
  assert.equal(after.status, 'disconnected');
  assert.equal(after.error.code, 'revoked');
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).auth, null);
  assert.equal(states.at(-1).status, 'disconnected', 'broadcast');
  await assert.rejects(svc.control({ action: 'pause' }), { code: 'disconnected' });
});

test('429: global block honours Retry-After; no request while blocked; write → rate-limited with retryAfter', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc, clock } = make(fake, { viewers: () => 0 });
  await login(svc);
  fake.set({ rateLimit: { retryAfter: 120 } });
  const s = await svc.refreshState();
  assert.equal(s.error.code, 'rate-limited');
  assert.ok(s.error.until > Date.now() + 100_000);
  assert.equal(s.status, 'idle', 'nothing cached yet');
  const count = fake.log.length;
  await svc.refreshState();
  await assert.rejects(svc.control({ action: 'next' }), (err) => err.code === 'rate-limited' && err.retryAfter >= 119 && err.retryAfter <= 120);
  await assert.rejects(svc.devices(), { code: 'rate-limited' });
  assert.equal(fake.log.length, count, 'no request at all during the block');
  fake.set({ rateLimit: false });
  clock.skew = 121_000;
  assert.equal((await svc.refreshState()).status, 'playing', 'resumes after the block');

  // no Retry-After header: 30 s
  fake.set({ rateLimit: {} });
  await svc.refreshState().catch(() => {});
  assert.ok(Math.abs(svc.blockedUntil - (Date.now() + clock.skew + 30_000)) < 2000);
});

test('polling: none without viewers; playing polls at playMs; paused at pausedMs; broadcasts only on change', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  let viewers = 0;
  const { svc, states } = make(fake, { viewers: () => viewers, timing: { playMs: 40, pausedMs: 400 } });
  svc.start();
  t.after(() => svc.stop());
  await login(svc);
  await sleep(200);
  const polls = () => fake.log.filter((l) => l.path === '/v1/me/player').length;
  assert.equal(polls(), 0, 'no viewer: no polling');
  viewers = 1;
  svc.wake();
  await until(() => polls() >= 5, 3000, '5 polls while playing');
  const sent = states.filter((s) => s.status === 'playing').length;
  assert.ok(sent <= 2, `same song, no rebroadcast each poll (${sent})`);
  fake.player.isPlaying = false;
  await until(() => states.at(-1).status === 'paused', 2000, 'paused broadcast');
  const atPause = polls();
  await sleep(250);
  assert.ok(polls() - atPause <= 1, 'paused: slow cadence');
  viewers = 0;
  await sleep(500);
  const stopped = polls();
  await sleep(500);
  assert.equal(polls(), stopped, 'stops once the last viewer leaves');
});

test('mapping: 204 → no-device, ad, episode, item null; premium on control; restricted device', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  let override = null;
  const fetchStub = async (url, init) => {
    if (override && new URL(url).pathname === '/v1/me/player') return new Response(JSON.stringify(override), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return fetch(url, init);
  };
  const { svc } = make(fake, { viewers: () => 0, fetch: fetchStub });
  await login(svc);
  fake.set({ noDevice: true });
  let s = await svc.refreshState();
  assert.equal(s.status, 'idle');
  assert.equal(s.error.code, 'no-device');
  await assert.rejects(svc.control({ action: 'play' }), { code: 'no-device' });
  fake.set({ noDevice: false, ad: true });
  s = await svc.refreshState();
  assert.equal(s.track.kind, 'ad');
  assert.equal(s.error, null);
  fake.set({ ad: false, premiumRequired: true });
  await assert.rejects(svc.control({ action: 'pause' }), { code: 'premium' });
  s = await svc.refreshState();
  assert.equal(s.error.code, 'premium', 'sticky: controls disabled, now-playing still runs');
  assert.equal(s.status, 'playing');
  const device = { id: 'dev1', name: 'Speaker', type: 'Speaker', is_restricted: true, volume_percent: null, supports_volume: false };
  override = { device, is_playing: true, progress_ms: 5, currently_playing_type: 'episode', item: { type: 'episode', id: 'ep1', uri: 'spotify:episode:ep1', name: 'Episode <img src=x onerror=alert(1)>', duration_ms: 1000, images: [{ url: 'https://evil.example/a.jpg', width: 300 }], show: { name: 'Podcast', images: [] } } };
  s = await svc.refreshState();
  assert.deepEqual(s.track, { kind: 'episode', title: 'Episode <img src=x onerror=alert(1)>', artists: 'Podcast', album: '', artId: null, durationMs: 1000 }, 'art host outside the allowlist → no art');
  assert.deepEqual(s.device, { name: 'Speaker', type: 'speaker', volume: null, supportsVolume: false });
  assert.equal(s.error.code, 'restricted');
  override = { device: { ...device, is_restricted: false }, is_playing: false, progress_ms: 0, item: null, currently_playing_type: 'unknown' };
  s = await svc.refreshState();
  assert.equal(s.track, null, 'private session: no item');
  assert.equal(s.status, 'paused');
  override = { device: { ...device, is_restricted: false }, is_playing: true, item: { type: 'track', name: 'x'.repeat(500), artists: [], album: { name: 'y', images: [] }, duration_ms: 1 } };
  assert.equal((await svc.refreshState()).track.title.length, 200, 'strings cut at 200');
});

test('control: actions, volume coalesced, ids must come from the last devices/playlists answer', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc } = make(fake, { viewers: () => 0 });
  await login(svc);
  assert.equal((await svc.control({ action: 'pause' })).status, 'paused');
  assert.equal((await svc.control({ action: 'play' })).status, 'playing');
  assert.equal((await svc.control({ action: 'next' })).track.title, 'Lagu Dua');
  assert.equal((await svc.control({ action: 'previous' })).track.title, 'Lagu Satu');
  for (const bad of [{ action: 'volume', volume: 101 }, { action: 'volume', volume: '50' }, { action: 'volume', volume: 1.5 }, { action: 'nope' }, {}]) await assert.rejects(svc.control(bad), { code: 'bad-request' }, JSON.stringify(bad));
  // drag a slider: the last value wins, a few calls rather than one per step
  const before = fake.log.filter((l) => l.path === '/v1/me/player/volume').length;
  await Promise.all([10, 20, 30, 40, 50, 33].map((volume) => svc.control({ action: 'volume', volume })));
  assert.equal(fake.player.device.volume_percent, 33);
  assert.ok(fake.log.filter((l) => l.path === '/v1/me/player/volume').length - before <= 2, 'coalesced');

  await assert.rejects(svc.control({ action: 'transfer', deviceId: 'fake-device-phone-02' }), { code: 'bad-request' }, 'not seen in a devices list yet');
  const { devices } = await svc.devices();
  assert.deepEqual(devices.map((d) => d.name), ['Laptop Adhit', 'HP Adhit']);
  await assert.rejects(svc.control({ action: 'transfer', deviceId: '../../x' }), { code: 'bad-request' });
  assert.equal((await svc.control({ action: 'transfer', deviceId: 'fake-device-phone-02', play: true })).device.name, 'HP Adhit');
  await assert.rejects(svc.control({ action: 'playlist', playlistId: FAKE_PLAYLIST_ID }), { code: 'bad-request' }, 'playlist not listed yet');
  await svc.playlists();
  for (const id of [`spotify:track:${FAKE_PLAYLIST_ID}`, 'x'.repeat(22), `${FAKE_PLAYLIST_ID}?a`]) await assert.rejects(svc.control({ action: 'playlist', playlistId: id }), { code: 'bad-request' }, id);
  await svc.control({ action: 'playlist', playlistId: FAKE_PLAYLIST_ID, deviceId: FAKE_DEVICE_ID });
  assert.deepEqual(fake.player.context, { uri: `spotify:playlist:${FAKE_PLAYLIST_ID}` }, 'URI built by the server');
});

test('art proxy: known ids only, type + magic checked, size capped, cached', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc } = make(fake, { viewers: () => 0 });
  await login(svc);
  const { track } = await svc.refreshState();
  await assert.rejects(svc.art('../etc/passwd'), { code: 'bad-request' });
  await assert.rejects(svc.art('0123456789abcdef'), { code: 'not-found' }, 'unknown id');
  const img = await svc.art(track.artId);
  assert.equal(img.type, 'image/jpeg');
  assert.equal(img.bytes[0], 0xff);
  const imgPath = fake.log.filter((l) => l.path.startsWith('/img/')).map((l) => l.path);
  assert.deepEqual(imgPath, ['/img/300.jpg'], '300 px (not 640, not the blurry 64), never the evil host');
  await svc.art(track.artId);
  assert.equal(fake.log.filter((l) => l.path.startsWith('/img/')).length, 1, 'cached');

  const fresh = make(fake, { viewers: () => 0 }).svc;
  await login(fresh);
  const id = (await fresh.refreshState()).track.artId;
  fake.set({ badImageType: true });
  await assert.rejects(fresh.art(id), { code: 'not-found' });
  fake.set({ badImageType: false, bigImage: true });
  await assert.rejects(fresh.art(id), { code: 'network' }, '> 512 KB aborted');
});

test('timeouts: a hanging Spotify ends within the request timeout as a network error', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc } = make(fake, { viewers: () => 0, timing: { requestMs: 200, tokenMs: 200 } });
  await login(svc);
  fake.set({ hang: true });
  const t0 = Date.now();
  const s = await svc.refreshState();
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  assert.equal(s.error.code, 'network');
  const t1 = Date.now();
  await assert.rejects(svc.control({ action: 'pause' }), { code: 'network' });
  assert.ok(Date.now() - t1 < 1000);
});

test('duck on approval: lower then restore; user changed volume → no restore; pause mode; debounce', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc } = make(fake, { viewers: () => 0, timing: { duckRestoreMs: 80 } });
  await login(svc);
  await svc.refreshState();
  svc.observeApproval('approval', {}, 1);
  await sleep(100);
  assert.equal(fake.player.device.volume_percent, 60, 'off by default: nothing');
  svc.observeApproval('approval', {}, 0);

  svc.setConfig({ settings: { duck: 'duck', duckVolume: 20 } }, { settingsOnly: true });
  svc.observeApproval('approval', {}, 1);
  await until(() => fake.player.device.volume_percent === 20, 2000, 'ducked');
  svc.observeApproval('approval', {}, 2);
  svc.observeApproval('approval', {}, 0);
  await sleep(30);
  svc.observeApproval('approval', {}, 1); // a new one within the debounce: stay ducked
  await sleep(150);
  assert.equal(fake.player.device.volume_percent, 20, 'debounced');
  svc.observeApproval('approval', {}, 0);
  await until(() => fake.player.device.volume_percent === 60, 2000, 'restored');

  // the user turned it up meanwhile: leave it
  svc.observeApproval('approval', {}, 1);
  await until(() => fake.player.device.volume_percent === 20, 2000, 'ducked again');
  fake.player.device.volume_percent = 45;
  svc.observeApproval('approval', {}, 0);
  await sleep(250);
  assert.equal(fake.player.device.volume_percent, 45, 'user change wins');

  // a volume that drifted slightly below the ducked one is not left near silent
  svc.observeApproval('approval', {}, 1);
  await until(() => fake.player.device.volume_percent === 20, 2000, 'ducked again for the drift case');
  fake.player.device.volume_percent = 19;
  svc.observeApproval('approval', {}, 0);
  await until(() => fake.player.device.volume_percent === 45, 2000, 'drifted volume restored');

  svc.setConfig({ settings: { duck: 'pause' } }, { settingsOnly: true });
  await svc.refreshState();
  svc.observeApproval('approval', {}, 1);
  await until(() => fake.player.isPlaying === false, 2000, 'paused');
  svc.observeApproval('approval', {}, 0);
  await until(() => fake.player.isPlaying === true, 2000, 'resumed');
  // paused + song changed meanwhile: do not resume
  svc.observeApproval('approval', {}, 1);
  await until(() => fake.player.isPlaying === false, 2000, 'paused again');
  fake.player.index = 2;
  svc.observeApproval('approval', {}, 0);
  await sleep(250);
  assert.equal(fake.player.isPlaying, false);
});

test('logout: tokens erased (Client ID kept), poller stopped; logs never carry a token or code', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc, logs, states } = make(fake, { viewers: () => 0 });
  await login(svc);
  fake.set({ apiDown: true });
  await svc.refreshState();
  fake.set({ apiDown: false, invalidGrant: true });
  assert.deepEqual(svc.logout(), { ok: true });
  assert.equal(svc.publicState().status, 'disconnected');
  assert.equal(svc.publicState().error, null);
  const raw = JSON.parse(readFileSync(svc.file, 'utf8'));
  assert.equal(raw.auth, null);
  assert.equal(raw.clientId, CLIENT);
  assert.ok(logs.some((l) => /^Spotify: status gagal \(500\/network\)$/.test(l)), logs.join('\n'));
  assertClean({ logs, states }, fake);
});

test('limits: Retry-After capped at 1 h; a huge poll interval never becomes a 1 ms spin', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc } = make(fake, { viewers: () => 0 });
  await login(svc);
  fake.set({ rateLimit: { retryAfter: 10 ** 9 } });
  await svc.refreshState();
  const left = svc.blockedUntil - Date.now();
  assert.ok(left > 3590_000 && left <= 3600_000, `${left} ms`);
  await assert.rejects(svc.control({ action: 'pause' }), (err) => err.retryAfter <= 3600);

  // setTimeout(fn, > 2^31-1) fires after 1 ms: the poller must clamp, not spin
  const fake2 = await startFakeSpotify();
  t.after(() => fake2.close());
  fake2.player.isPlaying = false;
  const { svc: s2 } = make(fake2, { timing: { pausedMs: 2 ** 40, idleMs: 2 ** 40, playMs: 2 ** 40 } });
  t.after(() => s2.stop());
  await login(s2); // wakes the poller (1 viewer)
  const polls = () => fake2.log.filter((l) => l.path === '/v1/me/player').length;
  await until(() => polls() >= 1, 2000, 'first poll');
  await sleep(300);
  assert.equal(polls(), 1, 'no rapid re-polling');
});

test('limits: playlist offset must be a page (multiple of 50, ≤ 5000); stale pages and ids are evicted', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc, clock } = make(fake, { viewers: () => 0 });
  await login(svc);
  for (const offset of [25, 5050, 10_000, -50, 1.5, '0']) await assert.rejects(svc.playlists({ offset }), { code: 'bad-request' }, String(offset));
  assert.deepEqual((await svc.playlists({ offset: 5000 })).items, []);
  await svc.playlists({ offset: 0 });
  assert.equal(svc.playlistIds.size, 1);
  assert.equal(svc.playlistCache.size, 2);
  clock.skew = 5 * 60_000 + 1;
  await svc.playlists({ offset: 50 });
  assert.deepEqual([...svc.playlistCache.keys()], [50], 'stale pages dropped');
  assert.equal(svc.playlistIds.size, 0, 'stale ids dropped');
  await assert.rejects(svc.control({ action: 'playlist', playlistId: FAKE_PLAYLIST_ID }), { code: 'bad-request' }, 'an evicted id is unknown again');
});

test('limits: concurrent art requests for one id share one download', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  const { svc } = make(fake, { viewers: () => 0 });
  await login(svc);
  const { track } = await svc.refreshState();
  const all = await Promise.all(Array.from({ length: 8 }, () => svc.art(track.artId)));
  assert.equal(fake.log.filter((l) => l.path.startsWith('/img/')).length, 1);
  assert.ok(all.every((a) => a === all[0]));
  assert.equal(svc.artInflight.size, 0, 'in-flight map cleaned up');
});

test('logs: a reason from a Spotify body cannot inject a log line; bursts of controls leave one follow-up poll', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  let evil = false;
  const fetchStub = async (url, init) => {
    if (evil && new URL(url).pathname === '/v1/me/player/next') return new Response(JSON.stringify({ error: { status: 403, reason: 'X\nSpotify: login ok (200/forged) fake-access-zzz' } }), { status: 403 });
    return fetch(url, init);
  };
  const { svc, logs } = make(fake, { viewers: () => 0, fetch: fetchStub, timing: { afterWriteMs: [0, 300] } });
  await login(svc);
  evil = true;
  await assert.rejects(svc.control({ action: 'next' }), { code: 'restricted' });
  const line = logs.at(-1);
  assert.match(line, /^Spotify: next gagal \(403\/[\w.-]+\)$/, line);
  assert.ok(logs.every((l) => !l.includes('\n')));
  evil = false;
  await Promise.all([svc.control({ action: 'pause' }), svc.control({ action: 'play' }), svc.control({ action: 'pause' })]);
  assert.equal(svc.burstTimers.size, 1, 'one pending follow-up poll');
});

test('a TLS-inspecting proxy Node does not trust is logged as a certificate problem, not a dead network', async (t) => {
  const fake = await startFakeSpotify();
  t.after(() => fake.close());
  // Zscaler-style: the token endpoint fails the TLS check before any HTTP answer
  const certFail = async (url, init) => {
    if (String(url).includes('/api/token')) throw new TypeError('fetch failed', { cause: Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }) });
    return fetch(url, init);
  };
  const { svc, logs } = make(fake, { fetch: certFail });
  assert.equal((await login(svc)).error, 'exchange');
  assert.ok(logs.some((l) => /^Spotify: login gagal \(0\/cert\)$/.test(l)), logs.join('\n'));
});
