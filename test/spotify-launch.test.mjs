// ♪ Spotify "▶ without opening Spotify first" (docs/design-spotify.md §2.8): the ★ preferred device, auto-select,
// starting the desktop app in the background (injected launcher: NEVER a real Spotify), the bounded wait for its
// device, the 30 s launch throttle, who may launch, and src/spotify-launcher.js with an injected execFile/fs.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { SpotifyError, SpotifyService } from '../src/spotify.js';
import { createSpotifyLauncher } from '../src/spotify-launcher.js';
import { buildRouter } from '../src/routes/index.js';
import { FAKE_DEVICE_ID, FAKE_PLAYLIST_ID, startFakeSpotify } from '../test-support/fake-spotify.mjs';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-spotify-launch-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const CLIENT = '0123456789abcdef0123456789abcdef';
const REDIRECT = 'http://127.0.0.1:4317/spotify/callback';
const PHONE_ID = 'fake-device-phone-02';
let n = 0;

/** A launcher double: counts launches, never starts anything. */
function fakeLauncher({ fail = null, strategy = 'store' } = {}) {
  const l = { launches: 0, minimized: [] };
  l.launch = async () => {
    l.launches++;
    if (fail) throw Object.assign(new Error(fail), { code: fail });
    return { strategy };
  };
  l.minimize = async (s) => {
    l.minimized.push(s);
    return true;
  };
  return l;
}

/** A logged-in service on the fake with fast timing. `clock.skew` moves its clock (the 30 s throttle). */
async function setup(t, { scenario = {}, launcher = fakeLauncher(), timing = {}, file } = {}) {
  const fake = await startFakeSpotify({ scenario });
  t.after(() => fake.close());
  const states = [];
  const logs = [];
  const clock = { skew: 0 };
  const svc = new SpotifyService({
    file: file ?? path.join(TMP, `s${++n}`, 'spotify.json'),
    redirectUri: REDIRECT,
    viewers: () => 0,
    onChange: (s) => states.push(s),
    accountsOrigin: fake.origin,
    apiOrigin: fake.origin,
    artHosts: new Set([fake.host]),
    now: () => Date.now() + clock.skew,
    log: (m) => logs.push(m),
    launcher,
    hostname: 'not-this-host',
    timing: { afterWriteMs: [0, 60_000], requestMs: 500, tokenMs: 500, launchWaitMs: 600, launchPollMs: 20, ...timing },
  });
  t.after(() => svc.stop());
  svc.setConfig({ clientId: CLIENT });
  const { url } = svc.startLogin({ returnOrigin: 'http://localhost:4317' });
  const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  assert.ok((await svc.finishLogin({ code: back.searchParams.get('code'), state: back.searchParams.get('state') })).ok);
  return { fake, svc, states, logs, clock, launcher };
}

/** No active device on the fake (Spotify closed everywhere, or open but idle). */
function noActive(fake, visible) {
  fake.player.device = null;
  for (const d of fake.devices) d.is_active = false;
  fake.set({ visible });
}

test('★ preferred device: remembered on transfer, marked in devices(), set/cleared by `prefer`, kept in the file, never in publicState', async (t) => {
  const { fake, svc } = await setup(t);
  assert.equal((await svc.devices()).preferred, null);
  await svc.control({ action: 'transfer', deviceId: PHONE_ID, play: true });
  let list = await svc.devices();
  assert.deepEqual(list.preferred, { name: 'HP Adhit', type: 'smartphone', available: true });
  assert.deepEqual(list.devices.map((d) => [d.name, d.preferred]), [['Laptop Adhit', false], ['HP Adhit', true]]);
  const raw = JSON.parse(readFileSync(svc.file, 'utf8'));
  assert.deepEqual(raw.preferredDevice, { id: PHONE_ID, name: 'HP Adhit', type: 'smartphone' });
  assert.doesNotMatch(JSON.stringify(svc.publicState()), new RegExp(`${PHONE_ID}|${FAKE_DEVICE_ID}`), 'no device id for browsers');
  // "Selalu putar di sini": only remembered (no Spotify request), validated against the last list
  const before = fake.log.length;
  await svc.control({ action: 'prefer', deviceId: FAKE_DEVICE_ID });
  assert.equal(fake.log.length, before, 'prefer sends nothing to Spotify');
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).preferredDevice.id, FAKE_DEVICE_ID);
  await assert.rejects(svc.control({ action: 'prefer', deviceId: 'never-listed' }), { code: 'bad-request' });
  await assert.rejects(svc.control({ action: 'prefer', deviceId: '../x' }), { code: 'bad-request' });
  // a plain play on the active device (the phone) never replaces the user's ★
  await svc.control({ action: 'pause' });
  await svc.control({ action: 'play' });
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).preferredDevice.id, FAKE_DEVICE_ID, 'the ★ stays');
  await svc.control({ action: 'prefer', deviceId: null });
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).preferredDevice, null);
  // a reload keeps it; garbage in the file is dropped
  await svc.control({ action: 'prefer', deviceId: FAKE_DEVICE_ID });
  const again = new SpotifyService({ file: svc.file, redirectUri: REDIRECT, accountsOrigin: fake.origin, apiOrigin: fake.origin, log: () => {} });
  list = await again.devices();
  assert.equal(list.devices.find((d) => d.preferred)?.id, FAKE_DEVICE_ID);
});

test('auto-select: one available device → transfer + play there; several → the ★ one; several without ★ → pick-device, no launch', async (t) => {
  const { fake, svc, launcher } = await setup(t);
  noActive(fake, [PHONE_ID]);
  svc.player = null;
  const s = await svc.control({ action: 'play' }, { allowLaunch: true });
  assert.equal(s.status, 'playing');
  assert.equal(s.device.name, 'HP Adhit');
  assert.equal(launcher.launches, 0);
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).preferredDevice.id, PHONE_ID, 'remembered');

  // both available, none active, ★ = laptop → the laptop
  noActive(fake, undefined);
  await svc.devices();
  await svc.control({ action: 'prefer', deviceId: FAKE_DEVICE_ID });
  await svc.refreshState();
  assert.equal((await svc.control({ action: 'play' }, { allowLaunch: true })).device.name, 'Laptop Adhit');

  // both available, none active, no ★ → the user must choose (nothing is started)
  await svc.control({ action: 'prefer', deviceId: null });
  noActive(fake, undefined);
  await svc.refreshState();
  await assert.rejects(svc.control({ action: 'play' }, { allowLaunch: true }), (err) => err.code === 'pick-device' && /Pilih/.test(err.message));
  assert.equal(launcher.launches, 0);
});

test('a stale "active" device (gone since the last poll): play falls back to auto-select', async (t) => {
  const { fake, svc } = await setup(t);
  await svc.refreshState();
  assert.ok(svc.player.device, 'the service thinks a device is active');
  noActive(fake, [PHONE_ID]);
  assert.equal((await svc.control({ action: 'play' })).device.name, 'HP Adhit');
});

test('launch: no device → the app is started once, the laptop device appears after N polls → transfer + play; launching shown meanwhile', async (t) => {
  const { fake, svc, states, launcher, logs } = await setup(t);
  noActive(fake, []);
  fake.set({ appearAfter: { polls: 4, ids: [FAKE_DEVICE_ID] } });
  await svc.refreshState();
  const s = await svc.control({ action: 'play' }, { allowLaunch: true });
  assert.equal(launcher.launches, 1);
  assert.equal(s.status, 'playing');
  assert.equal(s.device.name, 'Laptop Adhit');
  assert.equal(s.launching, false);
  assert.ok(fake.devicePolls >= 4);
  assert.ok(states.some((x) => x.launching === true), 'SSE carried launching: true');
  assert.deepEqual(launcher.minimized, ['store'], 'Store window minimized (best effort) once its device is up');
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).preferredDevice.id, FAKE_DEVICE_ID, 'the laptop is now ★');
  assert.ok(logs.includes('Spotify: aplikasi dibuka di latar belakang (store)'), logs.join('\n'));
});

test('launch: a playlist without a device goes to the started laptop device (play?device_id)', async (t) => {
  const { fake, svc, launcher } = await setup(t);
  await svc.playlists();
  noActive(fake, []);
  fake.set({ appearAfter: { polls: 2, ids: [FAKE_DEVICE_ID] } });
  await svc.refreshState();
  await svc.control({ action: 'playlist', playlistId: FAKE_PLAYLIST_ID }, { allowLaunch: true });
  assert.equal(launcher.launches, 1);
  assert.deepEqual(fake.player.context, { uri: `spotify:playlist:${FAKE_PLAYLIST_ID}` });
  assert.equal(fake.player.device.id, FAKE_DEVICE_ID);
});

test('launch: several other devices open but the ★ laptop is not → it is started here', async (t) => {
  const { fake, svc, launcher } = await setup(t);
  await svc.devices();
  await svc.control({ action: 'prefer', deviceId: FAKE_DEVICE_ID });
  // two other devices open (phone + a TV), the laptop not: the ★ laptop wins → start it here
  fake.devices.push({ id: 'fake-device-tv-03', is_active: false, is_restricted: false, name: 'TV', type: 'TV', volume_percent: 10, supports_volume: true });
  noActive(fake, [PHONE_ID, 'fake-device-tv-03']);
  fake.set({ appearAfter: { polls: 2, ids: [FAKE_DEVICE_ID] } });
  await svc.refreshState();
  assert.equal((await svc.control({ action: 'play' }, { allowLaunch: true })).device.name, 'Laptop Adhit');
  assert.equal(launcher.launches, 1);
});

test('launch: the device never appears → launch-timeout within the bounded wait, error shown, launching cleared', async (t) => {
  const { fake, svc, states } = await setup(t, { timing: { launchWaitMs: 300, launchPollMs: 25 } });
  noActive(fake, []);
  await svc.refreshState();
  const t0 = Date.now();
  await assert.rejects(svc.control({ action: 'play' }, { allowLaunch: true }), (err) => err instanceof SpotifyError && err.code === 'launch-timeout');
  const took = Date.now() - t0;
  assert.ok(took < 3000, `bounded (${took} ms)`);
  assert.ok(fake.devicePolls <= 300 / 25 + 3, `poll count bounded (${fake.devicePolls})`);
  const s = svc.publicState();
  assert.equal(s.launching, false);
  assert.equal(s.error.code, 'launch-timeout');
  assert.match(s.error.message, /▶ lagi/);
  assert.equal(states.at(-1).launching, false);
});

test('launch throttle: at most one start per 30 s (a second ▶ only waits); after 30 s it may start again', async (t) => {
  const { fake, svc, launcher, clock } = await setup(t, { timing: { launchWaitMs: 100, launchPollMs: 20 } });
  noActive(fake, []);
  await svc.refreshState();
  await assert.rejects(svc.control({ action: 'play' }, { allowLaunch: true }), { code: 'launch-timeout' });
  await assert.rejects(svc.control({ action: 'play' }, { allowLaunch: true }), { code: 'launch-timeout' });
  assert.equal(launcher.launches, 1, 'not started twice within 30 s');
  clock.skew += 29_000;
  await assert.rejects(svc.control({ action: 'play' }, { allowLaunch: true }), { code: 'launch-timeout' });
  assert.equal(launcher.launches, 1);
  clock.skew += 2_000;
  await assert.rejects(svc.control({ action: 'play' }, { allowLaunch: true }), { code: 'launch-timeout' });
  assert.equal(launcher.launches, 2, 'again after 30 s');
});

test('launch: concurrent ▶ share one launch and one wait (single-flight)', async (t) => {
  const { fake, svc, launcher } = await setup(t);
  noActive(fake, []);
  fake.set({ appearAfter: { polls: 5, ids: [FAKE_DEVICE_ID] } });
  await svc.refreshState();
  const results = await Promise.all([svc.control({ action: 'play' }, { allowLaunch: true }), svc.control({ action: 'play' }, { allowLaunch: true })]);
  assert.equal(launcher.launches, 1);
  for (const r of results) assert.equal(r.device.name, 'Laptop Adhit');
});

test('who may launch: not without allowLaunch (WiFi), not with the setting off, not without a launcher', async (t) => {
  const { fake, svc, launcher } = await setup(t);
  noActive(fake, []);
  await svc.refreshState();
  await assert.rejects(svc.control({ action: 'play' }), { code: 'no-device' }, 'allowLaunch defaults to false');
  svc.setConfig({ settings: { autoLaunch: false } }, { settingsOnly: true }); // a Tailscale phone may change it
  await assert.rejects(svc.control({ action: 'play' }, { allowLaunch: true }), { code: 'no-device' });
  assert.equal(launcher.launches, 0);
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).settings.autoLaunch, false);
  assert.throws(() => svc.setConfig({ settings: { autoLaunch: 'yes' } }, { settingsOnly: true }), { code: 'bad-request' });

  const bare = await setup(t, { launcher: null });
  noActive(bare.fake, []);
  await bare.svc.refreshState();
  await assert.rejects(bare.svc.control({ action: 'play' }, { allowLaunch: true }), { code: 'no-device' });
});

test('launch: Spotify not installed → no-app (clear message); unsupported OS → no-device; neither retried within 30 s', async (t) => {
  const { fake, svc, launcher } = await setup(t, { launcher: fakeLauncher({ fail: 'no-app' }) });
  noActive(fake, []);
  await svc.refreshState();
  await assert.rejects(svc.control({ action: 'play' }, { allowLaunch: true }), (err) => err.code === 'no-app' && /Pasang Spotify/.test(err.message));
  assert.equal(svc.publicState().error.code, 'no-app');
  assert.equal(svc.publicState().launching, false);
  await assert.rejects(svc.control({ action: 'play' }, { allowLaunch: true }), { code: 'launch-timeout' }, 'throttled: only waits');
  assert.equal(launcher.launches, 1);

  const linux = await setup(t, { launcher: fakeLauncher({ fail: 'unsupported' }) });
  noActive(linux.fake, []);
  await linux.svc.refreshState();
  await assert.rejects(linux.svc.control({ action: 'play' }, { allowLaunch: true }), { code: 'no-device' });
});

test('launch: a 429 while waiting stops the wait at once (the global block), no busy loop', async (t) => {
  const { fake, svc } = await setup(t, { timing: { launchWaitMs: 5000, launchPollMs: 20 } });
  noActive(fake, []);
  await svc.refreshState();
  const run = svc.control({ action: 'play' }, { allowLaunch: true });
  setTimeout(() => fake.set({ rateLimit: { retryAfter: 60 } }), 60);
  const t0 = Date.now();
  await assert.rejects(run, { code: 'rate-limited' });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(svc.publicState().launching, false);
});

test('route: control gets allowLaunch from ctx.canManageAccount; new codes map to statuses', async () => {
  const router = buildRouter();
  const m = router.match('POST', '/api/spotify/control');
  const seen = [];
  const res = () => {
    const r = { status: 0, headers: {}, body: '' };
    r.setHeader = (k, v) => (r.headers[k.toLowerCase()] = v);
    r.writeHead = (s, h = {}) => ((r.status = s), Object.assign(r.headers, h));
    r.end = (b) => (r.body = String(b ?? ''));
    return r;
  };
  const spotify = { control: async (body, o) => (seen.push(o), { status: 'playing' }) };
  await m.route.handler({ spotify, canManageAccount: () => true }, { headers: {} }, res(), m.params, { action: 'play' });
  await m.route.handler({ spotify, canManageAccount: () => false }, { headers: {} }, res(), m.params, { action: 'play' });
  await m.route.handler({ spotify }, { headers: {} }, res(), m.params, { action: 'play' });
  assert.deepEqual(seen, [{ allowLaunch: true }, { allowLaunch: false }, { allowLaunch: false }]);
  for (const [code, status] of Object.entries({ 'no-app': 404, 'pick-device': 409, 'launch-timeout': 504 })) {
    const r = res();
    await m.route.handler({ spotify: { control: async () => Promise.reject(new SpotifyError(code)) } }, { headers: {} }, r, m.params, {});
    assert.equal(r.status, status, code);
    assert.equal(JSON.parse(r.body).code, code);
  }
});

// ---------- after real-world feedback: 💻 Laptop ini, ★ offline, offline transfer target ----------

test('💻 Laptop ini: offered in devices() only when this server may start Spotify here and its device is not listed', async (t) => {
  const { fake, svc } = await setup(t);
  // the laptop's app is closed: only the phone is a Connect device
  fake.set({ visible: [PHONE_ID] });
  assert.deepEqual((await svc.devices({ allowLaunch: true })).thisLaptop, { preferred: false });
  assert.equal((await svc.devices()).thisLaptop, null, 'not over WiFi / without allowLaunch');
  svc.setConfig({ settings: { autoLaunch: false } });
  assert.equal((await svc.devices({ allowLaunch: true })).thisLaptop, null, 'not with the setting off');
  svc.setConfig({ settings: { autoLaunch: true } });
  const bare = await setup(t, { launcher: null });
  bare.fake.set({ visible: [PHONE_ID] });
  assert.equal((await bare.svc.devices({ allowLaunch: true })).thisLaptop, null, 'not without a launcher');
  // a computer named after this host is this laptop: no virtual entry
  const named = await setup(t);
  named.svc.hostname = 'laptop adhit';
  assert.equal((await named.svc.devices({ allowLaunch: true })).thisLaptop, null);
});

test('💻 Laptop ini → "Buka & putar di sini" (launch): starts Spotify (throttled, bounded), plays there, keeps the ★; "Selalu putar di sini" makes it ★', async (t) => {
  const { fake, svc, launcher } = await setup(t);
  fake.set({ visible: [PHONE_ID] });
  await svc.devices();
  await svc.control({ action: 'prefer', deviceId: PHONE_ID });
  noActive(fake, [PHONE_ID]);
  await assert.rejects(svc.control({ action: 'launch' }), { code: 'bad-request' }, 'not without allowLaunch');
  assert.equal(launcher.launches, 0);
  fake.set({ appearAfter: { polls: 2, ids: [FAKE_DEVICE_ID] } });
  const s = await svc.control({ action: 'launch' }, { allowLaunch: true });
  assert.equal(launcher.launches, 1);
  assert.equal(s.device.name, 'Laptop Adhit');
  assert.equal(s.status, 'playing');
  const file = JSON.parse(readFileSync(svc.file, 'utf8'));
  assert.equal(file.preferredDevice.id, PHONE_ID, 'the ★ stays until the user changes it');
  assert.equal(file.laptopDeviceId, FAKE_DEVICE_ID, 'this laptop is known from now on');
  const list = await svc.devices({ allowLaunch: true });
  assert.equal(list.thisLaptop, null, 'its real device is listed now');

  // ★ = "Laptop ini" (works before its app ever ran: no Connect id needed)
  await svc.control({ action: 'prefer', laptop: true }, { allowLaunch: true });
  assert.deepEqual(JSON.parse(readFileSync(svc.file, 'utf8')).preferredDevice, { id: null, name: 'Laptop ini', type: 'computer', laptop: true });
  assert.equal((await svc.devices()).devices.find((d) => d.preferred)?.id, FAKE_DEVICE_ID, 'marked on its real device');
  // closed again → ▶ goes to the laptop (the ★ laptop is offline; within the 30 s gap it only waits for it)
  noActive(fake, [PHONE_ID]);
  fake.set({ appearAfter: { polls: 2, ids: [FAKE_DEVICE_ID] } });
  await svc.refreshState();
  assert.equal((await svc.control({ action: 'play' }, { allowLaunch: true })).device.name, 'Laptop Adhit');
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).preferredDevice.laptop, true, '★ unchanged');
});

test('▶ with the ★ phone offline (not listed) and nothing active: Spotify is started on the laptop, not pick-device; the ★ stays', async (t) => {
  const { fake, svc, launcher } = await setup(t);
  await svc.devices();
  await svc.control({ action: 'prefer', deviceId: PHONE_ID });
  // another device is listed (a TV) but the ★ phone is gone: the laptop wins over "some other device"
  fake.devices.push({ id: 'fake-device-tv-03', is_active: false, is_restricted: false, name: 'TV', type: 'TV', volume_percent: 10, supports_volume: true });
  noActive(fake, ['fake-device-tv-03']);
  fake.set({ appearAfter: { polls: 2, ids: [FAKE_DEVICE_ID] } });
  await svc.refreshState();
  const s = await svc.control({ action: 'play' }, { allowLaunch: true });
  assert.equal(s.device.name, 'Laptop Adhit');
  assert.equal(launcher.launches, 1);
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).preferredDevice.id, PHONE_ID);
  // without launch rights: the old rule (the only listed device)
  const wifi = await setup(t);
  await wifi.svc.devices();
  await wifi.svc.control({ action: 'prefer', deviceId: PHONE_ID });
  noActive(wifi.fake, [FAKE_DEVICE_ID]);
  await wifi.svc.refreshState();
  assert.equal((await wifi.svc.control({ action: 'play' })).device.name, 'Laptop Adhit', 'the only listed device');
  assert.equal(wifi.launcher.launches, 0);
});

test('▶ with the ★ phone listed but offline (transfer fails 5xx): falls back to starting Spotify on the laptop', async (t) => {
  const { fake, svc, launcher } = await setup(t);
  await svc.devices();
  await svc.control({ action: 'prefer', deviceId: PHONE_ID });
  noActive(fake, [PHONE_ID]);
  fake.set({ offline: [PHONE_ID], appearAfter: { polls: 2, ids: [FAKE_DEVICE_ID] } });
  await svc.refreshState();
  const s = await svc.control({ action: 'play' }, { allowLaunch: true });
  assert.equal(s.device.name, 'Laptop Adhit');
  assert.equal(launcher.launches, 1);
  assert.equal(JSON.parse(readFileSync(svc.file, 'utf8')).preferredDevice.id, PHONE_ID, '★ kept');
  // no launch rights: a clear device-offline error, not a generic network one
  const other = await setup(t);
  await other.svc.devices();
  await other.svc.control({ action: 'prefer', deviceId: PHONE_ID });
  noActive(other.fake, [PHONE_ID, FAKE_DEVICE_ID]);
  other.fake.set({ offline: [PHONE_ID] });
  await other.svc.refreshState();
  await assert.rejects(other.svc.control({ action: 'play' }), (err) => err.code === 'device-offline' && /offline/.test(err.message) && /Laptop ini/.test(err.message));
});

test('transfer to an offline device: 5xx or 404 → device-offline (clear message), log carries the sanitised Spotify status and message', async (t) => {
  const { fake, svc, logs } = await setup(t);
  await svc.devices();
  fake.set({ offline: [PHONE_ID] });
  await assert.rejects(svc.control({ action: 'transfer', deviceId: PHONE_ID, play: true }), (err) => err.code === 'device-offline' && err.status === 500 && err.message.startsWith('Perangkat ini sedang offline'));
  assert.ok(logs.includes('Spotify: pindah perangkat gagal (500/device-offline.Server_error)'), logs.join('\n'));
  fake.set({ offlineStatus: 502 });
  await assert.rejects(svc.control({ action: 'transfer', deviceId: PHONE_ID }), { code: 'device-offline' });
  // a device that left the list since: Spotify answers 404 Device not found
  fake.set({ offline: false, visible: [FAKE_DEVICE_ID] });
  await assert.rejects(svc.control({ action: 'transfer', deviceId: PHONE_ID }), { code: 'device-offline' });
  assert.ok(logs.some((l) => l === 'Spotify: pindah perangkat gagal (404/device-offline.Device_not_found)'), logs.join('\n'));
  // a playlist aimed at an offline device: the same
  await svc.playlists();
  fake.set({ visible: false, offline: [PHONE_ID] });
  await svc.devices();
  await assert.rejects(svc.control({ action: 'playlist', playlistId: FAKE_PLAYLIST_ID, deviceId: PHONE_ID }), { code: 'device-offline' });
  // logs never carry a device id
  assert.ok(!logs.some((l) => l.includes(PHONE_ID)));
});

test('route: devices gets allowLaunch from ctx.canManageAccount; device-offline → 404', async () => {
  const router = buildRouter();
  const m = router.match('POST', '/api/spotify/devices');
  const seen = [];
  const res = () => {
    const r = { status: 0, headers: {}, body: '' };
    r.setHeader = (k, v) => (r.headers[k.toLowerCase()] = v);
    r.writeHead = (s, h = {}) => ((r.status = s), Object.assign(r.headers, h));
    r.end = (b) => (r.body = String(b ?? ''));
    return r;
  };
  const spotify = { devices: async (o) => (seen.push(o), { devices: [], preferred: null, thisLaptop: null }) };
  await m.route.handler({ spotify, canManageAccount: () => true }, { headers: {} }, res(), m.params, {});
  await m.route.handler({ spotify }, { headers: {} }, res(), m.params, {});
  assert.deepEqual(seen, [{ allowLaunch: true }, { allowLaunch: false }]);
  const c = router.match('POST', '/api/spotify/control');
  const r = res();
  await c.route.handler({ spotify: { control: async () => Promise.reject(new SpotifyError('device-offline')) } }, { headers: {} }, r, c.params, {});
  assert.equal(r.status, 404);
  assert.equal(JSON.parse(r.body).code, 'device-offline');
});

// ---------- src/spotify-launcher.js (injected execFile and fs: nothing is started) ----------

/** execFile double: records calls; the child emits 'spawn' (or 'error' for missing files). */
function fakeExec(missing = new Set()) {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter();
    child.unref = () => (child.unrefed = true);
    calls.at(-1).child = child;
    setImmediate(() => {
      if (missing.has(file)) child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      else child.emit('spawn');
      cb?.(null, '', '');
    });
    return child;
  };
  return { calls, execFile };
}

const WIN_ENV = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', SystemRoot: 'C:\\Windows' };

test('launcher (Windows): classic exe first → Spotify.exe --minimized, detached, hidden, no shell, unref', async () => {
  const { calls, execFile } = fakeExec();
  const exe = 'C:\\Users\\u\\AppData\\Roaming\\Spotify\\Spotify.exe';
  const l = createSpotifyLauncher({ platform: 'win32', env: WIN_ENV, execFile, existsSync: (p) => p === exe, readdirSync: () => ['SpotifyAB.SpotifyMusic_zpdnekdrzrea0'] });
  assert.deepEqual(l.detect(), { strategy: 'exe', target: exe });
  assert.deepEqual(await l.launch(), { strategy: 'exe' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, exe);
  assert.deepEqual(calls[0].args, ['--minimized']);
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].child.unrefed, true);
  assert.equal(await l.minimize('exe'), false, 'the exe starts minimized itself: no PowerShell');
  assert.equal(calls.length, 1);
});

test('launcher (Windows): Store version via explorer.exe shell:AppsFolder\\<AUMID>; optional hidden minimize with a fixed script', async () => {
  const { calls, execFile } = fakeExec();
  const l = createSpotifyLauncher({ platform: 'win32', env: WIN_ENV, execFile, existsSync: () => false, readdirSync: (p) => (p.endsWith('Packages') ? ['Microsoft.Foo_8wekyb3d8bbwe', 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0'] : []) });
  assert.deepEqual(l.detect(), { strategy: 'store', target: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' });
  assert.deepEqual(await l.launch(), { strategy: 'store' });
  assert.equal(calls[0].file, 'C:\\Windows\\explorer.exe');
  assert.deepEqual(calls[0].args, ['shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify']);
  assert.equal(calls[0].opts.shell, false);
  assert.equal(await l.minimize('store'), true);
  const ps = calls[1];
  assert.match(ps.file, /powershell\.exe$/i);
  assert.ok(ps.args.includes('-NonInteractive') && ps.args.includes('-NoProfile'));
  assert.match(ps.args.at(-1), /ShowWindowAsync\(\$_\.MainWindowHandle, 6\)/);
  assert.equal(ps.opts.windowsHide, true);
  assert.ok(ps.opts.timeout > 0 && ps.opts.timeout <= 10_000, 'bounded');
  const off = createSpotifyLauncher({ platform: 'win32', env: WIN_ENV, execFile, existsSync: () => false, readdirSync: () => ['SpotifyAB.SpotifyMusic_zpdnekdrzrea0'], minimizeStoreWindow: false });
  assert.equal(await off.minimize('store'), false, 'optional');
  // a package folder that only looks similar is not used
  const odd = createSpotifyLauncher({ platform: 'win32', env: WIN_ENV, execFile, existsSync: () => false, readdirSync: () => ['SpotifyAB.SpotifyMusic_x&calc', 'SpotifyAB.SpotifyMusic_'] });
  assert.deepEqual(odd.detect(), { strategy: null, reason: 'no-app' });
});

test('launcher: not installed → no-app; a failed spawn → no-app; macOS open -g; Linux unsupported', async () => {
  const { calls, execFile } = fakeExec(new Set(['C:\\Users\\u\\AppData\\Roaming\\Spotify\\Spotify.exe']));
  const none = createSpotifyLauncher({ platform: 'win32', env: WIN_ENV, execFile, existsSync: () => false, readdirSync: () => { throw new Error('ENOENT'); } });
  await assert.rejects(none.launch(), { code: 'no-app' });
  assert.equal(calls.length, 0, 'nothing started');
  const broken = createSpotifyLauncher({ platform: 'win32', env: WIN_ENV, execFile, existsSync: () => true, readdirSync: () => [] });
  await assert.rejects(broken.launch(), { code: 'no-app' }, 'ENOENT at spawn');

  const mac = createSpotifyLauncher({ platform: 'darwin', env: {}, home: '/Users/u', execFile, existsSync: (p) => p === '/Applications/Spotify.app' });
  assert.equal(mac.detect().strategy, 'mac');
  await mac.launch();
  assert.equal(calls.at(-1).file, 'open');
  assert.deepEqual(calls.at(-1).args, ['-g', '-a', 'Spotify']);
  await assert.rejects(createSpotifyLauncher({ platform: 'darwin', env: {}, home: '/Users/u', execFile, existsSync: () => false }).launch(), { code: 'no-app' });

  const linux = createSpotifyLauncher({ platform: 'linux', env: {}, execFile, existsSync: () => true });
  assert.deepEqual(linux.detect(), { strategy: null, reason: 'unsupported' });
  const count = calls.length;
  await assert.rejects(linux.launch(), { code: 'unsupported' });
  assert.equal(calls.length, count);
});
