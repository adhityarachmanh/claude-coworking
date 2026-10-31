import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { RemoteAccess, WIFI_READ_API, isTailscaleConnection, lanAddresses, networkAddresses, wifiAllows } from '../src/remote.js';

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
  const read = ['/api/account', '/api/account/limits', '/api/report/accounts', '/api/report/summary', '/api/report/pdf'];
  for (const a of ['changes', 'diff', 'files', 'sessions', 'rewind-points', 'task-output']) read.push(`/api/projects/toko-1a2b/${a}`);
  for (const p of read) assert.ok(wifiAllows(p), p);
  const act = ['/api/approvals/abc', '/api/team', '/api/demo', '/api/projects', '/api/projects/refresh', '/api/config', '/api/remote', '/api/account/login', '/api/account/logout', '/api/something-new'];
  for (const a of ['prompt', 'shell', 'settings', 'commit', 'rewind', 'rewind-preview', 'mcp', 'mcp-action', 'task-stop', 'background', 'stop', 'reset', 'resume', 'forget', 'favorite', 'rename', 'open']) act.push(`/api/projects/toko/${a}`);
  act.push('/api/projects/toko/changes/../prompt', '/api/projects/toko/diffx', '/api/projects/a/b/changes');
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
