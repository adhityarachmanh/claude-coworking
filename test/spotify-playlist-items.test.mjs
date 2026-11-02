// ♪ Spotify: a playlist's tracks (POST /playlist-items) and playing from a chosen one (control playlist + trackId /
// position), against test-support/fake-spotify.mjs. No server, no real Spotify, no app launch.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { SpotifyError, SpotifyService } from '../src/spotify.js';
import { buildRouter } from '../src/routes/index.js';
import { FAKE_DEVICE_ID, FAKE_EDITORIAL_ID, FAKE_PLAYLIST_ID, FAKE_PLAYLIST_TRACKS, fakeTrackId, startFakeSpotify } from '../test-support/fake-spotify.mjs';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-spotify-items-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const CLIENT = '0123456789abcdef0123456789abcdef';
const REDIRECT = 'http://127.0.0.1:4317/spotify/callback';
let n = 0;

async function setup(t, { scenario = {}, timing = {}, launcher = null } = {}) {
  const fake = await startFakeSpotify({ scenario });
  t.after(() => fake.close());
  const logs = [];
  const clock = { skew: 0 };
  const svc = new SpotifyService({
    file: path.join(TMP, `s${++n}`, 'spotify.json'),
    redirectUri: REDIRECT,
    accountsOrigin: fake.origin,
    apiOrigin: fake.origin,
    artHosts: new Set([fake.host]),
    now: () => Date.now() + clock.skew,
    log: (m) => logs.push(m),
    launcher,
    hostname: 'not-this-host',
    timing: { afterWriteMs: [0, 60_000], requestMs: 300, tokenMs: 300, launchWaitMs: 400, launchPollMs: 20, ...timing },
  });
  t.after(() => svc.stop());
  svc.setConfig({ clientId: CLIENT });
  const { url } = svc.startLogin({ returnOrigin: 'http://localhost:4317' });
  const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  assert.ok((await svc.finishLogin({ code: back.searchParams.get('code'), state: back.searchParams.get('state') })).ok);
  return { fake, svc, logs, clock };
}

const itemRequests = (fake) => fake.log.filter((l) => l.path.endsWith('/items'));

test('playlist-items: GET /playlists/{id}/items (Feb 2026 `item`), 50 per page, next/total, cached; local, episode, unplayable marked', async (t) => {
  const { fake, svc } = await setup(t);
  await assert.rejects(svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID }), { code: 'bad-request' }, 'only playlists from the last list');
  await svc.playlists();
  const page = await svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID });
  assert.equal(page.total, FAKE_PLAYLIST_TRACKS);
  assert.equal(page.items.length, FAKE_PLAYLIST_TRACKS, 'all 42 in one page of 50');
  assert.equal(page.next, null);
  const [first, explicitOne] = page.items;
  assert.deepEqual({ ...first, artId: typeof first.artId }, { id: fakeTrackId(0), title: 'Lagu 1', artist: 'Artis Fake, Tamu', album: 'Album Fake', durationMs: 180_000, artId: 'string', explicit: false, playable: true, isLocal: false, isEpisode: false });
  assert.equal(explicitOne.explicit, true);
  assert.deepEqual([page.items[3].isLocal, page.items[3].playable, page.items[3].id, page.items[3].title], [true, false, null, 'Lagu Lokal'], 'local file: shown, not playable');
  assert.deepEqual([page.items[5].isEpisode, page.items[5].playable, page.items[5].artist], [true, true, 'Podcast Ngoding'], 'episode: shown and marked');
  assert.equal(page.items[7].playable, false, 'restricted (market) → not playable');
  // the request: limit 50, market=from_token (is_playable), episodes included
  const req = fake.log.find((l) => l.path === `/v1/playlists/${FAKE_PLAYLIST_ID}/items`);
  assert.ok(req && req.auth);
  // cached: a second read sends nothing
  const count = itemRequests(fake).length;
  await svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID });
  assert.equal(itemRequests(fake).length, count);
  // offset: a multiple of 50, bounded
  for (const offset of [-50, 25, 10_050, '50', 1.5]) await assert.rejects(svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID, offset }), { code: 'bad-request' }, String(offset));
  const empty = await svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID, offset: 50 });
  assert.deepEqual([empty.items.length, empty.next], [0, null]);
});

test('playlist-items: paging when Spotify returns fewer per page; stale cache evicted after cacheMs', async (t) => {
  const { fake, svc, clock } = await setup(t);
  await svc.playlists();
  await svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID });
  clock.skew += 5 * 60_000 + 1;
  await assert.rejects(svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID }), { code: 'bad-request' }, 'the playlist id itself expired with the list');
  await svc.playlists();
  const before = itemRequests(fake).length;
  await svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID });
  assert.equal(itemRequests(fake).length, before + 1, 'refetched after the cache expired');
});

test('playlist-items: a playlist the user does not own (403, Dev-mode rule) → playlist-locked with a clear hint; still playable as a whole', async (t) => {
  const { fake, svc, logs } = await setup(t, { scenario: { editorial: true } });
  const { items } = await svc.playlists();
  assert.ok(items.some((p) => p.id === FAKE_EDITORIAL_ID));
  await assert.rejects(svc.playlistItems({ playlistId: FAKE_EDITORIAL_ID }), (err) => err instanceof SpotifyError && err.code === 'playlist-locked' && /mode pengembangan/.test(err.message) && /putar langsung/.test(err.message));
  assert.ok(logs.some((l) => /^Spotify: isi playlist gagal \(403\//.test(l)), logs.join('\n'));
  await svc.control({ action: 'playlist', playlistId: FAKE_EDITORIAL_ID });
  assert.deepEqual(fake.player.context, { uri: `spotify:playlist:${FAKE_EDITORIAL_ID}` });
});

test('playlist-items: 429 → rate-limited (global block), timeout → network', async (t) => {
  const { fake, svc } = await setup(t);
  await svc.playlists();
  fake.set({ rateLimit: { retryAfter: 30 } });
  await assert.rejects(svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID }), (err) => err.code === 'rate-limited' && err.retryAfter > 0);
  fake.set({ rateLimit: false });
  svc.blockedUntil = 0;
  fake.set({ hang: true });
  const t0 = Date.now();
  await assert.rejects(svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID }), { code: 'network' });
  assert.ok(Date.now() - t0 < 2000, 'bounded by the request timeout');
});

test('control playlist + trackId: offset {uri} built from a cached id; + position; validation', async (t) => {
  const { fake, svc } = await setup(t);
  await svc.playlists();
  await assert.rejects(svc.control({ action: 'playlist', playlistId: FAKE_PLAYLIST_ID, trackId: fakeTrackId(9) }), { code: 'bad-request' }, 'not seen in an items answer yet');
  await svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID });
  await svc.control({ action: 'playlist', playlistId: FAKE_PLAYLIST_ID, trackId: fakeTrackId(9) });
  assert.deepEqual(fake.player.context, { uri: `spotify:playlist:${FAKE_PLAYLIST_ID}` });
  assert.deepEqual(fake.player.offset, { uri: `spotify:track:${fakeTrackId(9)}` }, 'URI built by the server');
  await svc.control({ action: 'playlist', playlistId: FAKE_PLAYLIST_ID, trackId: fakeTrackId(5) });
  assert.deepEqual(fake.player.offset, { uri: `spotify:episode:${fakeTrackId(5)}` }, 'an episode keeps its kind');
  await svc.control({ action: 'playlist', playlistId: FAKE_PLAYLIST_ID, position: 12 });
  assert.deepEqual(fake.player.offset, { position: 12 });
  await svc.control({ action: 'playlist', playlistId: FAKE_PLAYLIST_ID });
  assert.equal(fake.player.offset, null, 'no offset: from the start');
  for (const bad of [
    { trackId: 'spotify:track:x' },
    { trackId: `${fakeTrackId(9)}?x` },
    { trackId: fakeTrackId(9), position: 1 },
    { position: -1 },
    { position: 1.5 },
    { position: 10_001 },
  ]) {
    await assert.rejects(svc.control({ action: 'playlist', playlistId: FAKE_PLAYLIST_ID, ...bad }), { code: 'bad-request' }, JSON.stringify(bad));
  }
  // a track id only counts for the playlist it was listed in
  const other = await setup(t, { scenario: { editorial: true } });
  await other.svc.playlists();
  await other.svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID });
  await assert.rejects(other.svc.control({ action: 'playlist', playlistId: FAKE_EDITORIAL_ID, trackId: fakeTrackId(9) }), { code: 'bad-request' });
});

test('control playlist + trackId with no active device: the same device selection (and launch) as ▶', async (t) => {
  const launcher = { launches: 0, launch: async () => (launcher.launches++, { strategy: 'store' }), minimize: async () => true };
  const { fake, svc } = await setup(t, { launcher });
  await svc.playlists();
  await svc.playlistItems({ playlistId: FAKE_PLAYLIST_ID });
  fake.player.device = null;
  for (const d of fake.devices) d.is_active = false;
  fake.set({ visible: [], appearAfter: { polls: 2, ids: [FAKE_DEVICE_ID] } });
  await svc.refreshState();
  const s = await svc.control({ action: 'playlist', playlistId: FAKE_PLAYLIST_ID, trackId: fakeTrackId(2) }, { allowLaunch: true });
  assert.equal(launcher.launches, 1);
  assert.equal(s.device.name, 'Laptop Adhit');
  assert.deepEqual(fake.player.offset, { uri: `spotify:track:${fakeTrackId(2)}` });
  assert.equal(fake.player.device.id, FAKE_DEVICE_ID);
});

test('route: /api/spotify/playlist-items passes playlistId/offset; playlist-locked → 403', async (t) => {
  const router = buildRouter();
  const m = router.match('POST', '/api/spotify/playlist-items');
  assert.ok(m);
  const res = () => {
    const r = { status: 0, headers: {}, body: '' };
    r.setHeader = (k, v) => (r.headers[k.toLowerCase()] = v);
    r.writeHead = (s, h = {}) => ((r.status = s), Object.assign(r.headers, h));
    r.end = (b) => (r.body = String(b ?? ''));
    return r;
  };
  const seen = [];
  const r1 = res();
  await m.route.handler({ spotify: { playlistItems: async (o) => (seen.push(o), { items: [], next: null, total: 0 }) } }, { headers: {} }, r1, m.params, { playlistId: FAKE_PLAYLIST_ID, offset: 50 });
  await m.route.handler({ spotify: { playlistItems: async (o) => (seen.push(o), { items: [], next: null, total: 0 }) } }, { headers: {} }, res(), m.params, { playlistId: FAKE_PLAYLIST_ID });
  assert.equal(r1.status, 200);
  assert.deepEqual(seen, [{ playlistId: FAKE_PLAYLIST_ID, offset: 50 }, { playlistId: FAKE_PLAYLIST_ID, offset: 0 }]);
  const r2 = res();
  await m.route.handler({ spotify: { playlistItems: async () => Promise.reject(new SpotifyError('playlist-locked')) } }, { headers: {} }, r2, m.params, {});
  assert.equal(r2.status, 403);
  assert.equal(JSON.parse(r2.body).code, 'playlist-locked');
  // against the service: a real answer through the route
  const { svc } = await setup(t);
  await svc.playlists();
  const r3 = res();
  await m.route.handler({ spotify: svc }, { headers: {} }, r3, m.params, { playlistId: FAKE_PLAYLIST_ID });
  assert.equal(JSON.parse(r3.body).items.length, FAKE_PLAYLIST_TRACKS);
});
