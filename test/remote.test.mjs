import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { DEVICE_IDLE_MS, RemoteAccess, WIFI_READ_API, isTailscaleConnection, lanAddresses, networkAddresses, wifiAllows, wifiConfig } from '../src/remote.js';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Hub } from '../src/hub.js';
import { wifiAccountAlert } from '../src/routes/account.js';

const v4 = (address) => ({ family: 'IPv4', address, internal: false });

test('addresses are classified: WiFi/LAN first, then Tailscale, virtual adapters last', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({
    'vEthernet (WSL (Hyper-V firewall))': [v4('172.18.144.1')],
    Tailscale: [v4('100.101.5.9')],
    'Wi-Fi': [v4('192.168.1.14'), { family: 'IPv6', address: 'fe80::1', internal: false }],
    docker0: [v4('172.17.0.1')],
    Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    Ethernet: [v4('169.254.10.2')], // link-local: unreachable, skipped
    tailscale0: [v4('100.64.0.7')], // Linux name, CGNAT range
  }));
  assert.deepEqual(networkAddresses().map((a) => [a.ip, a.kind]), [
    ['192.168.1.14', 'lan'],
    ['100.101.5.9', 'tailscale'],
    ['100.64.0.7', 'tailscale'],
    ['172.18.144.1', 'virtual'],
    ['172.17.0.1', 'virtual'],
  ]);
  assert.equal(lanAddresses().length, 5); // the listener still answers on all of them
});

test('a 100.x address outside the Tailscale range is ordinary LAN', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({ Ethernet: [v4('100.200.1.1')] }));
  assert.equal(networkAddresses()[0].kind, 'lan');
});

test('only connections through the Tailscale interface may manage the Claude account from a phone', () => {
  // The peer must have a tailnet address…
  for (const ip of ['192.168.1.14', '100.63.0.1', '100.128.0.1', '10.100.0.1', '172.18.144.1', '', undefined]) assert.ok(!isTailscaleConnection('100.100.1.1', ip), String(ip));
  // …and the laptop side must be an interface named Tailscale: a 100.x peer on CGNAT WiFi stays plain WiFi.
  const lan = networkAddresses().find((a) => a.kind !== 'tailscale');
  if (lan) assert.ok(!isTailscaleConnection(lan.ip, '100.80.1.2'), 'CGNAT WiFi is not Tailscale');
  const tailscale = networkAddresses().find((a) => a.kind === 'tailscale');
  if (tailscale) for (const ip of ['100.64.0.1', '100.127.255.254', '::ffff:100.80.1.2']) assert.ok(isTailscaleConnection(tailscale.ip, ip), ip);
});

test('plain WiFi is read-only: only listed read actions pass, everything else is refused by default', () => {
  const read = ['/api/account', '/api/account/limits', '/api/report/accounts', '/api/report/summary', '/api/report/pdf', '/api/templates'];
  for (const a of ['changes', 'diff', 'file', 'files', 'sessions', 'rewind-points', 'task-output', 'task-detail']) read.push(`/api/projects/toko-1a2b/${a}`);
  for (const p of read) assert.ok(wifiAllows(p), p);
  const act = ['/api/approvals/abc', '/api/team', '/api/demo', '/api/projects', '/api/projects/refresh', '/api/config', '/api/remote', '/api/account/login', '/api/account/logout', '/api/something-new', '/api/templates/save', '/api/templates/delete'];
  for (const a of ['prompt', 'shell', 'settings', 'commit', 'rewind', 'rewind-preview', 'mcp', 'mcp-action', 'task-stop', 'background', 'stop', 'reset', 'resume', 'forget', 'favorite', 'rename', 'open']) act.push(`/api/projects/toko/${a}`);
  act.push('/api/projects/toko/changes/../prompt', '/api/projects/toko/diffx', '/api/projects/a/b/changes');
  // The concurrency limit and retention settings are laptop-only settings (LOCAL_ONLY in server.js): never over
  // plain WiFi, where the request could be replayed by anyone on the network.
  act.push('/api/concurrency/save', '/api/data/retention/preview', '/api/data/retention/save', '/api/data/retention/run');
  // whole conversation history / saved permission rules: not over sniffable WiFi (laptop + Tailscale only)
  act.push('/api/projects/toko/search', '/api/projects/toko/export-session', '/api/projects/toko/permissions');
  for (const p of act) assert.ok(!wifiAllows(p), p);
  // The browser gets the same rules as JSON (snapshot client.readOnlyApi) and must decide exactly like the server.
  const sent = JSON.parse(JSON.stringify(WIFI_READ_API));
  const uiAllows = (p) => sent.paths.includes(p) || sent.patterns.some((source) => new RegExp(source).test(p));
  for (const p of [...read, ...act]) assert.equal(uiAllows(p), wifiAllows(p), p);
});

/** RemoteAccess on a fake hub (no disk, broadcasts recorded). */
function fakeRemote() {
  const events = [];
  const hub = { persisted: { remote: { enabled: true, devices: [] } }, save() {}, scheduleSave() {}, broadcast: (type, data) => events.push({ type, data }) };
  return { remote: new RemoteAccess(hub), events };
}

test('onNewCode: fires exactly once per brand-new code, not on cached reads, again after expiry or rotation', (t) => {
  const codes = [];
  const hub = { persisted: { remote: { enabled: true, devices: [] } }, save() {}, scheduleSave() {}, broadcast() {} };
  const remote = new RemoteAccess(hub, { onNewCode: (info) => codes.push(info) });

  const first = remote.currentPairing();
  assert.deepEqual(codes, [{ code: first.code, expiresAt: first.expires }], 'a created code is announced once');
  assert.equal(remote.currentPairing(), first);
  assert.equal(remote.currentPairing().code, first.code);
  assert.equal(codes.length, 1, 'a still-alive code fires nothing');

  // Expiry (2 minutes) → the next read makes a new code and fires again.
  const t0 = Date.now();
  let clock = t0;
  t.mock.method(Date, 'now', () => clock);
  clock = t0 + 2 * 60 * 1000 + 1;
  const second = remote.currentPairing();
  assert.notEqual(second.code, first.code);
  assert.equal(codes.length, 2);
  assert.deepEqual(codes[1], { code: second.code, expiresAt: second.expires });
  remote.currentPairing();
  assert.equal(codes.length, 2, 'repeat reads stay silent');

  // rotatePairing() (the laptop's "send it to my phone" button): a forced fresh code, announced too.
  clock = t0 + 2 * 60 * 1000 + 2;
  const third = remote.rotatePairing();
  assert.notEqual(third.code, second.code);
  assert.deepEqual(codes[2], { code: third.code, expiresAt: third.expires });
  assert.equal(codes.length, 3);

  // announce: false (route /api/pairing/code/push pushes itself): a fresh code, but no hook call.
  const fourth = remote.rotatePairing({ announce: false });
  assert.notEqual(fourth.code, third.code);
  assert.equal(codes.length, 3, 'the hook stayed silent');
  remote.currentPairing();
  assert.equal(remote.currentPairing().code, fourth.code, 'the code is alive and cached');
  assert.equal(codes.length, 3);
});

/** fakeRemote() that also counts saves and records idle-unpaired devices. */
function countingRemote() {
  const saves = { now: 0, scheduled: 0 };
  const expired = [];
  const hub = { persisted: { remote: { enabled: true, devices: [] } }, save: () => saves.now++, scheduleSave: () => saves.scheduled++, broadcast() {} };
  return { remote: new RemoteAccess(hub, { onExpire: (devices) => expired.push(...devices.map((d) => d.id)) }), hub, saves, expired };
}

const pairDevice = (remote, ua = 'iPhone Safari/1') => remote.pair({ key: remote.currentPairing().key }, ua, '10.0.0.2').token;

test('pair() returns the record of THIS pairing: two pairings in a row, each result names its own device', () => {
  const { remote } = fakeRemote();
  const a = remote.pair({ key: remote.currentPairing().key }, 'iPhone Safari/1', '10.0.0.2');
  const b = remote.pair({ key: remote.currentPairing().key }, 'Android Chrome/1', '10.0.0.3', { transport: 'https' });
  // The server announces exactly result.device to the other phones — it must not guess "the last record".
  assert.equal(a.device.name, 'iPhone · Safari');
  assert.equal(b.device.name, 'Android · Chrome');
  assert.equal(b.device.transport, 'https');
  assert.notEqual(a.device.id, b.device.id);
  assert.deepEqual(remote.state.devices, [a.device, b.device], 'the returned records are the stored ones');
});

test('pairing: 5 wrong codes kill the code, tell the laptop, and lock that IP out for a while', (t) => {
  const { remote, events } = fakeRemote();
  const { code } = remote.currentPairing();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.equal(remote.pair({ code: wrong }, '', '192.168.1.50').triesLeft, 4 - i);
  assert.match(remote.pair({ code: wrong }, '', '192.168.1.50').error, /Kode diganti/);
  assert.deepEqual(events.map((e) => e.type), ['pairing-reset'], 'the laptop dialog is told to show a new code');

  const fresh = remote.currentPairing();
  const locked = remote.pair({ code: fresh.code }, '', '192.168.1.50');
  assert.ok(locked.retryAfter > 0 && locked.retryAfter <= 60, 'locked out, even with the right code');
  assert.equal(locked.token, undefined);
  assert.ok(remote.pair({ code: fresh.code }, 'iPhone Safari/1', '192.168.1.51').token, 'another device is not punished');

  // after the lockout the IP may try again
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 61_000);
  const later = remote.currentPairing();
  assert.ok(remote.pair({ code: later.code }, '', '192.168.1.50').token);
});

test('pairing: a right code clears the failures of that IP', () => {
  const { remote } = fakeRemote();
  let p = remote.currentPairing();
  const wrong = p.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 3; i++) remote.pair({ code: wrong }, '', '10.0.0.9');
  assert.ok(remote.pair({ code: p.code }, '', '10.0.0.9').token);
  p = remote.currentPairing();
  for (let i = 0; i < 3; i++) remote.pair({ code: p.code === '000000' ? '111111' : '000000' }, '', '10.0.0.9');
  assert.equal(remote.lockedFor('10.0.0.9'), 0, 'counting starts over after a success');
});

test('idle devices: unused for more than 30 days they are refused, removed and stored without them', (t) => {
  t.mock.method(console, 'log', () => {});
  const { remote, hub, saves, expired } = countingRemote();
  const t0 = Date.now();
  const idle = pairDevice(remote);
  const busy = pairDevice(remote, 'Android Chrome/1');
  const [idleId, busyId] = hub.persisted.remote.devices.map((d) => d.id);

  let now = t0 + DEVICE_IDLE_MS - 1000;
  t.mock.method(Date, 'now', () => now);
  assert.ok(remote.verify(busy), 'used just before the limit');
  now = t0 + DEVICE_IDLE_MS + 1000;
  const savedBefore = saves.now;
  assert.equal(remote.verify(idle), null, 'idle for 30 days + 1 s: refused');
  assert.deepEqual(hub.persisted.remote.devices.map((d) => d.id), [busyId], 'removed from the stored list');
  assert.ok(saves.now > savedBefore, 'persisted right away');
  assert.deepEqual(expired, [idleId], 'the server is told (it ends that device’s streams)');
  assert.ok(remote.verify(busy), 'the active device stays paired');
  assert.equal(remote.verify(idle), null, 'stays gone');
  assert.ok(!JSON.stringify(console.log.mock.calls.map((c) => c.arguments)).includes(idle), 'the log never carries the token');
  assert.match(String(console.log.mock.calls.at(-1).arguments[0]), /dicabut otomatis/);
});

test('idle devices: pruneIdle() (start + hourly) also drops never-seen devices by their pairing time', (t) => {
  t.mock.method(console, 'log', () => {});
  const { remote, hub, expired } = countingRemote();
  const now = Date.now();
  hub.persisted.remote.devices.push(
    { id: 'old', hash: 'x', name: 'Lama', created: now - DEVICE_IDLE_MS - 60_000 }, // older data: no lastSeen
    { id: 'fresh', hash: 'y', name: 'Baru', created: now - 1000 },
    { id: 'seen', hash: 'z', name: 'Aktif', created: now - 2 * DEVICE_IDLE_MS, lastSeen: now - 5000 },
  );
  assert.deepEqual(remote.pruneIdle(now).map((d) => d.id), ['old']);
  assert.deepEqual(hub.persisted.remote.devices.map((d) => d.id), ['fresh', 'seen']);
  assert.deepEqual(expired, ['old']);
  assert.deepEqual(remote.pruneIdle(now), [], 'nothing left to drop');
  assert.equal(remote.publicInfo(1).devices.find((d) => d.id === 'fresh').lastSeen, now - 1000, 'UI gets a "last active" time');
});

test('lastSeen moves forward on use, but is saved at most once an hour per device', (t) => {
  const { remote, hub, saves } = countingRemote();
  // Freeze the clock before pairing: otherwise lastSeen can land a millisecond after t0 and the test flakes.
  const t0 = Date.now();
  let now = t0;
  t.mock.method(Date, 'now', () => now);
  const token = pairDevice(remote);
  const device = hub.persisted.remote.devices[0];
  for (let i = 1; i <= 50; i++) {
    now = t0 + i * 60_000; // a request every minute for 50 minutes
    assert.ok(remote.verify(token));
  }
  assert.equal(saves.scheduled, 0, 'no disk write within the hour');
  assert.equal(device.lastSeen, t0);
  now = t0 + 61 * 60_000;
  remote.verify(token);
  assert.equal(device.lastSeen, now, 'updated after an hour');
  assert.equal(saves.scheduled, 1);
  // Steady use keeps a phone paired well past 30 days after pairing.
  for (let day = 1; day <= 40; day++) {
    now = t0 + day * 86_400_000;
    assert.ok(remote.verify(token), `day ${day}`);
  }
});

test('a device token only works over the transport it was paired on (http vs https)', () => {
  const { remote } = fakeRemote();
  const viaHttp = remote.pair({ key: remote.currentPairing().key }, 'Android Chrome/1', '100.80.1.2').token;
  const viaHttps = remote.pair({ key: remote.currentPairing().key }, 'Android Chrome/1', '100.80.1.2', { transport: 'https' }).token;
  assert.ok(remote.verify(viaHttp), 'default transport is http');
  assert.ok(remote.verify(viaHttp, { transport: 'http' }));
  assert.equal(remote.verify(viaHttp, { transport: 'https' }), null, 'an http token is refused over https');
  assert.ok(remote.verify(viaHttps, { transport: 'https' }));
  assert.equal(remote.verify(viaHttps), null, 'an https token is refused over plain http (where it could be sniffed)');
  assert.equal(remote.verify(viaHttps, { transport: 'http' }), null);
  // records from before HTTPS existed count as http; an unknown value can't make a device https
  remote.state.devices[0].transport = undefined;
  assert.ok(remote.verify(viaHttp));
  assert.equal(remote.verify(viaHttp, { transport: 'https' }), null);
  const odd = remote.pair({ key: remote.currentPairing().key }, '', '', { transport: 'HTTPS ' }).token;
  assert.ok(remote.verify(odd, { transport: 'http' }));
  // the 📱 list shows the transport, never a hash
  const info = remote.publicInfo(4317);
  assert.deepEqual(info.devices.map((d) => d.transport), ['http', 'https', 'http']);
  assert.ok(!JSON.stringify(info).includes('hash'));
});

test('privacy: plain-WiFi streams get config without paired device names and account-alert without name/email', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-redact-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = new Hub({ dataDir: dir });
  hub.redactors.set('config', wifiConfig);
  hub.redactors.set('account-alert', wifiAccountAlert);
  const laptop = [];
  const wifi = [];
  const wifiRes = { write: (f) => wifi.push(f) };
  hub.clients.add({ write: (f) => laptop.push(f) });
  hub.clients.add(wifiRes);
  hub.redacted.add(wifiRes);
  const config = { roots: ['C:/p'], remote: { enabled: true, urls: ['http://192.168.1.2:4317'], tailscale: false, devices: [{ id: 'd1', name: 'iPhone Adhit', created: 1, lastSeen: 1, transport: 'http' }], idleDays: 30 } };
  hub.broadcast('config', config);
  hub.broadcast('account-alert', { action: 'logout', device: 'iPhone Adhit', email: 'adhit@example.com', ts: 5 });
  assert.match(laptop[0], /iPhone Adhit/);
  assert.match(laptop[1], /iPhone Adhit.*adhit@example\.com/);
  for (const f of wifi) assert.doesNotMatch(f, /iPhone Adhit|adhit@example\.com/);
  const [cfg, alert] = wifi.map((f) => JSON.parse(f.match(/^data: (.*)$/m)[1]));
  assert.deepEqual(cfg.remote.devices, []);
  assert.deepEqual(cfg.remote.urls, config.remote.urls, 'the rest of config stays');
  assert.deepEqual(alert, { action: 'logout', device: 'Perangkat lain', email: null, ts: 5 }, 'the alert itself stays');
  assert.equal(config.remote.devices.length, 1, 'input not mutated');
  assert.equal(wifiConfig({ roots: [] }).roots.length, 0, 'no remote block: unchanged');
});
