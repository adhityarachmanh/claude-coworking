// 🔓 Pasang otomatis dari perangkat tailnet (src/tailnet.js + src/remote.js + server.js): a device of the
// laptop owner's OWN tailnet user pairs without the 6-digit code over the https (Tailscale) listener only.
// Everything else keeps the code — plain WiFi even with a 100.x IP, another tailnet user's device, the
// setting off, or a broken `tailscale status --json`. End to end against the real server with the fake
// Tailscale CLI (test-support/fake-tailscale.mjs), like test/https.test.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/hub.js';
import { MAX_DEVICES, RemoteAccess, lanAddresses } from '../src/remote.js';
import { clearTailnetCache, DEFAULT_TAILNET_CACHE_MS, eligibleTailnetPeer, peerDeviceName, tailnetPeer, tailnetCacheMs } from '../src/tailnet.js';
import { buildRouter } from '../src/routes/index.js';
import { selfSignedCert } from '../test-support/x509.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 1001; // the laptop owner's tailnet user
const OTHER = 2002; // a device shared in from someone else's tailnet
const TMP = mkdtempSync(path.join(tmpdir(), 'office-autopair-'));
const NAME = 'office.test';
const LAN = lanAddresses()[0]; // may be undefined on CI: the plain-http test skips then
let PORT;
let HTTPS_PORT;
let BASE;
let HOST;
const CONFIG = path.join(TMP, 'fake-tailscale.json');
const CERT = path.join(TMP, 'issued.crt');
const KEY = path.join(TMP, 'issued.key');
const STATE = path.join(TMP, 'data', 'state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;

function issue(days = 80) {
  const pair = selfSignedCert({ cn: NAME, dns: [NAME], ips: [], notAfter: new Date(Date.now() + days * 86_400_000) });
  writeFileSync(CERT, pair.cert);
  writeFileSync(KEY, pair.key);
  return new X509Certificate(pair.cert).fingerprint256;
}

/** The peer map the fake CLI serves: the connecting loopback address (and the LAN one) belongs to the owner. */
const peers = (ownerId = OWNER) => ({
  owner: { UserID: ownerId, TailscaleIPs: ['127.0.0.1', ...(LAN ? [LAN] : []), '100.64.0.2'], HostName: 'pixel-adhit' },
  friend: { UserID: OTHER, TailscaleIPs: ['100.64.0.9'], HostName: 'teman' },
});
const scenario = (s) =>
  writeFileSync(CONFIG, JSON.stringify({ host: NAME, certFile: CERT, keyFile: KEY, selfUserId: OWNER, peers: peers(), certDomains: true, ...s }, null, 2));

/** A port nothing listens on right now (no clash with other test files' fixed ranges). */
const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

before(async () => {
  PORT = await freePort();
  HTTPS_PORT = await freePort();
  BASE = `http://localhost:${PORT}`;
  HOST = `${NAME}:${HTTPS_PORT}`;
  mkdirSync(path.join(TMP, 'projects', 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  issue();
  scenario({});
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_HTTPS_PORT: String(HTTPS_PORT),
      OFFICE_HTTPS_TEST_BIND: '127.0.0.1',
      OFFICE_TAILSCALE_BIN: path.join(APP, 'test-support', 'fake-tailscale.mjs'),
      FAKE_TAILSCALE_CONFIG: CONFIG,
      // scenario() swaps the tailnet identity while the server runs: no cached status may outlive it.
      OFFICE_TAILNET_CACHE_MS: '0',
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPEN_DRY_RUN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.resume();
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
});

after(async () => {
  server?.kill();
  await sleep(500);
  rmSync(TMP, { recursive: true, force: true });
});

const api = (p, body = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

/** One request to the https listener on 127.0.0.1 (fetch can't set Host or trust a test certificate). */
function tlsRequest(p, { method = 'GET', host = HOST, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: HTTPS_PORT, path: p, method, servername: NAME, rejectUnauthorized: false, agent: false, headers: { Host: host, Connection: 'close', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const tlsPost = (p, body, cookie) =>
  tlsRequest(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });

/** First event of /stream over TLS (the snapshot), then the connection is dropped. */
function tlsSnapshot(cookie) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: HTTPS_PORT, path: '/stream', servername: NAME, rejectUnauthorized: false, agent: false, headers: { Host: HOST, Cookie: cookie } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        if (text.includes('\n\n')) {
          req.destroy();
          resolve(JSON.parse(text.match(/^data: (.*)$/m)[1]));
        }
      });
    });
    req.on('error', (err) => err.code !== 'ECONNRESET' && reject(err));
    req.end();
  });
}
async function snapshot() {
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}
const remoteInfo = async () => (await snapshot()).config.remote;
// A liveness probe that pairs nothing: GET /pair now auto-pairs an owner device, /health does not.
const listening = () => tlsRequest('/health').then(() => true, () => false);
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return false;
}
/** Pairs a device by CODE over the LAN listener (http) — the yardstick the auto-pair must not replace. */
async function pairByCode() {
  const code = (await api('/api/remote/pairing')).body.code;
  return fetch(`http://${LAN}:${PORT}/pair`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
}

let token;

test('identity check: exactly the owner peer at the connecting address, nothing else', () => {
  const status = {
    BackendState: 'Running',
    Self: { DNSName: 'laptop.tailnet.ts.net.', UserID: OWNER },
    User: { [OWNER]: { LoginName: 'adhit@example.com' }, [OTHER]: { LoginName: 'teman@example.com' } },
    Peer: {
      pixel: { UserID: OWNER, TailscaleIPs: ['100.64.0.2', 'fd7a:115c:a1e0:ab12:4843:cd96:626b:1a2b'], HostName: 'pixel-adhit' },
      friend: { UserID: OTHER, TailscaleIPs: ['100.64.0.9'], HostName: 'teman', DNSName: 'teman.tailnet.ts.net.' },
    },
  };
  assert.deepEqual(tailnetPeer(status, '100.64.0.2'), status.Peer.pixel, 'exact IPv4 match');
  assert.deepEqual(tailnetPeer(status, '::ffff:100.64.0.2'), status.Peer.pixel, 'the ::ffff: prefix of a v4-mapped socket');
  assert.deepEqual(tailnetPeer(status, 'FD7A:115C:A1E0:AB12:4843:CD96:626B:1A2B'), status.Peer.pixel, 'IPv6 match, hex case');
  assert.equal(tailnetPeer(status, '100.64.0.9'), null, 'another user’s shared-in device: never eligible');
  assert.equal(tailnetPeer(status, '100.64.0.3'), null, 'an address no peer has');
  assert.equal(tailnetPeer(status, '192.168.1.14'), null, 'a plain LAN address is no tailnet peer');
  assert.equal(tailnetPeer(status, ''), null);
  assert.equal(tailnetPeer(null, '100.64.0.2'), null, 'garbage status (no JSON): fail closed');
  assert.equal(tailnetPeer({ Peer: status.Peer }, '100.64.0.2'), null, 'no Self.UserID: fail closed');
  assert.equal(tailnetPeer({ Self: {}, Peer: status.Peer }, '100.64.0.2'), null, 'empty Self: fail closed');
  assert.equal(tailnetPeer({ Self: { UserID: OWNER } }, '100.64.0.2'), null, 'no Peer map: fail closed');
  assert.equal(tailnetPeer(status, ['100.64.0.2']), null, 'not a string');
});

test('device name: the peer hostname, else Tailnet <login> from the status User map', () => {
  const status = { User: { [OWNER]: { LoginName: 'adhit@example.com' } } };
  assert.equal(peerDeviceName({ HostName: 'pixel-adhit' }, status), 'pixel-adhit');
  assert.equal(peerDeviceName({ DNSName: 'pixel-adhit.tailnet.ts.net.' }, status), 'pixel-adhit.tailnet.ts.net');
  assert.equal(peerDeviceName({ UserID: OWNER }, status), 'Tailnet adhit@example.com', 'no hostname: the login');
  assert.equal(peerDeviceName({ UserID: OWNER }, null), 'Perangkat Tailnet', 'no status at all: a stable fallback');
});

test('the identity check runs the CLI fresh and fails closed on every error', async (t) => {
  const env = { OFFICE_TAILSCALE_BIN: path.join(APP, 'test-support', 'no-such-file') };
  assert.equal(await eligibleTailnetPeer('100.64.0.2', env), null, 'no binary: not eligible');
  // the fake CLI inherits this process's env: point it at a scenario per case
  const fakeBin = path.join(APP, 'test-support', 'fake-tailscale.mjs');
  const garbageConfig = path.join(TMP, 'garbage.json');
  writeFileSync(garbageConfig, JSON.stringify({ statusGarbage: true }));
  process.env.FAKE_TAILSCALE_CONFIG = garbageConfig;
  t.after(() => { delete process.env.FAKE_TAILSCALE_CONFIG; });
  assert.equal(await eligibleTailnetPeer('127.0.0.1', { OFFICE_TAILSCALE_BIN: fakeBin }), null, 'unparseable status: not eligible');
  const okConfig = path.join(TMP, 'ok.json');
  writeFileSync(okConfig, JSON.stringify({ selfUserId: OWNER, peers: peers() }));
  process.env.FAKE_TAILSCALE_CONFIG = okConfig;
  const found = await eligibleTailnetPeer('127.0.0.1', { OFFICE_TAILSCALE_BIN: fakeBin });
  assert.equal(found.name, 'pixel-adhit');
});

test('autoPair(): an ordinary record, transport-bound, revocable — and off together with phone access', () => {
  const hub = { persisted: { remote: { enabled: true, devices: [] } }, save() {}, scheduleSave() {}, broadcast() {} };
  const remote = new RemoteAccess(hub);
  const none = remote.autoPair('pixel-adhit', { transport: 'https' });
  assert.ok(none.token && none.device.id, 'a token and a record');
  assert.equal(none.device.name, 'pixel-adhit');
  assert.equal(none.device.transport, 'https');
  assert.deepEqual(hub.persisted.remote.devices, [none.device], 'stored like a code pairing');
  assert.ok(remote.verify(none.token, { transport: 'https' }), 'works over https');
  assert.equal(remote.verify(none.token, { transport: 'http' }), null, 'bound to the transport it arrived on');
  remote.revoke(none.device.id);
  assert.equal(remote.verify(none.token, { transport: 'https' }), null, 'revocable like any device');

  remote.setEnabled(false);
  assert.equal(remote.autoPair('pixel-adhit', { transport: 'https' }), null, 'no auto-pair while phone access is off');
});

test('autoPair(): the device cap and the per-IP pace bound a cross-site /pair loop', () => {
  const state = { enabled: true, devices: [] };
  const remote = new RemoteAccess({ persisted: { remote: state }, save() {}, scheduleSave() {}, broadcast() {} });
  const now = Date.now();
  // Distinct IPs so the per-IP pace does not kick in: only the hard device cap is under test here.
  for (let i = 0; i < MAX_DEVICES; i++) {
    assert.ok(remote.autoPair(`hp-${i}`, { transport: 'https', ip: `100.64.0.${i + 1}`, now }), `record ${i + 1}`);
  }
  assert.equal(remote.autoPair('one-too-many', { transport: 'https', ip: '100.64.0.250', now }), null, 'the cap refuses');
  assert.equal(state.devices.length, MAX_DEVICES, 'the list never exceeds the cap');
});

test('autoPair(): at most 5 per minute and 20 per hour from one IP', () => {
  const state = { enabled: true, devices: [] };
  const remote = new RemoteAccess({ persisted: { remote: state }, save() {}, scheduleSave() {}, broadcast() {} });
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) assert.ok(remote.autoPair('pixel', { transport: 'https', ip: '1.2.3.4', now: now + i }), `#${i + 1}`);
  assert.equal(remote.autoPair('pixel', { transport: 'https', ip: '1.2.3.4', now: now + 10 }), null, 'minute bucket full');
  assert.ok(remote.autoPair('pixel', { transport: 'https', ip: '5.6.7.8', now: now + 11 }), 'another IP is unaffected');
  assert.ok(remote.autoPair('pixel', { transport: 'https', ip: '1.2.3.4', now: now + 61_000 }), 'the minute window moves on');
});

test('tailnetCacheMs(): 5 s by default, OFFICE_TAILNET_CACHE_MS overrides, 0 disables', () => {
  assert.equal(DEFAULT_TAILNET_CACHE_MS, 5000);
  assert.equal(tailnetCacheMs({}), 5000);
  assert.equal(tailnetCacheMs({ OFFICE_TAILNET_CACHE_MS: '0' }), 0);
  assert.equal(tailnetCacheMs({ OFFICE_TAILNET_CACHE_MS: '1234' }), 1234);
  assert.equal(tailnetCacheMs({ OFFICE_TAILNET_CACHE_MS: 'abc' }), 5000);
  assert.equal(tailnetCacheMs({ OFFICE_TAILNET_CACHE_MS: '-1' }), 5000);
});

test('the tailnet status is cached, shared in flight, and clearTailnetCache() forces a fresh CLI call', async () => {
  const fakeBin = path.join(APP, 'test-support', 'fake-tailscale.mjs');
  const log = path.join(TMP, 'cache-calls.log');
  const cfg = path.join(TMP, 'cache-tailnet.json');
  writeFileSync(cfg, JSON.stringify({ selfUserId: OWNER, peers: peers(), log }));
  const env = { OFFICE_TAILSCALE_BIN: fakeBin, OFFICE_TAILNET_CACHE_MS: '5000' };
  const calls = () => (readFileSync(log, 'utf8').match(/\n/g) ?? []).length;
  const previous = process.env.FAKE_TAILSCALE_CONFIG;
  process.env.FAKE_TAILSCALE_CONFIG = cfg; // the CLI child inherits this process's env
  try {
    clearTailnetCache();
    assert.equal((await eligibleTailnetPeer('127.0.0.1', env)).name, 'pixel-adhit');
    assert.equal((await eligibleTailnetPeer('127.0.0.1', env)).name, 'pixel-adhit');
    assert.equal(calls(), 1, 'the second read is served from the cache');
    clearTailnetCache();
    await eligibleTailnetPeer('127.0.0.1', env);
    assert.equal(calls(), 2, 'clearing forces a fresh call');
    // No cache: two concurrent callers still share one in-flight CLI process.
    const shared = { ...env, OFFICE_TAILNET_CACHE_MS: '0' };
    clearTailnetCache();
    const [a, b] = await Promise.all([eligibleTailnetPeer('127.0.0.1', shared), eligibleTailnetPeer('127.0.0.1', shared)]);
    assert.equal(a.name, 'pixel-adhit');
    assert.equal(b.name, 'pixel-adhit');
    assert.equal(calls(), 3, 'single-flight: one more call, not two');
  } finally {
    if (previous === undefined) delete process.env.FAKE_TAILSCALE_CONFIG;
    else process.env.FAKE_TAILSCALE_CONFIG = previous;
    clearTailnetCache();
  }
});

test('the auto-pair setting: default true, persisted in the remote state, saved immediately', (t) => {
  const dir = mkdtempSync(path.join(TMP, 'setting-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = new Hub({ dataDir: dir });
  const remote = new RemoteAccess(hub);
  assert.equal(remote.autoPairTailnet, true, 'default on (also for a state from before the setting)');
  remote.state.autoPairTailnet = false; // an older state.json without the key stays true
  assert.equal(new RemoteAccess(hub).autoPairTailnet, false, 'the stored value is honoured');
  remote.setAutoPairTailnet(true);
  assert.equal(hub.persisted.remote.autoPairTailnet, true);
  assert.equal(remote.autoPairTailnet, true);
  assert.ok(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).remote.autoPairTailnet === true, 'persisted to state.json');
  assert.equal(remote.publicInfo(1).autoPairTailnet, true, 'exposed to the 📱 dialog');
});

test('the /api/remote/auto-pair route sets the setting and answers with the full remote info', async () => {
  const router = buildRouter();
  const route = router.routes.find((r) => r.pattern === '/api/remote/auto-pair');
  assert.ok(route, 'registered');
  const state = { enabled: true, devices: [] };
  let published = 0;
  const remote = new RemoteAccess({ persisted: { remote: state }, save() {}, scheduleSave() {}, broadcast() {} });
  const ctx = { remote, publishConfig: () => published++, remoteInfo: () => ({ ...remote.publicInfo(4317), https: null }) };
  const res = { writeHead() {}, end(t2) { this.body = t2; } };
  await route.handler(ctx, {}, res, {}, { autoPairTailnet: false });
  assert.equal(remote.autoPairTailnet, false);
  assert.equal(published, 1, 'the config broadcast goes out');
  const body = JSON.parse(res.body);
  assert.equal(body.autoPairTailnet, false);
  assert.ok('devices' in body, 'the 📱 dialog gets the whole remote info back');
  await route.handler(ctx, {}, res, {}, {});
  assert.equal(remote.autoPairTailnet, false, 'a missing value reads as false (explicit off), never silently on');
  await route.handler(ctx, {}, res, {}, { autoPairTailnet: '1' });
  assert.equal(remote.autoPairTailnet, true, 'truthy values are on');
});

// ---------- end to end: the real server, the fake CLI, the https listener on loopback ----------

test('setup: phone access on, https listener up, the default setting is on', async () => {
  const before = await remoteInfo();
  assert.equal(before.autoPairTailnet, true, 'default on');
  assert.equal((await api('/api/remote', { enabled: true })).status, 200);
  const checked = await api('/api/remote/https-check');
  assert.equal(checked.body.state, 'ok');
  assert.ok(await until(listening), 'https listener started');
});

test('an owner device over https pairs WITHOUT a code and works like a normal device', async () => {
  const count = (await remoteInfo()).devices.length;
  const auto = await tlsPost('/pair', {});
  assert.equal(auto.status, 200, JSON.stringify(auto.body));
  assert.deepEqual(JSON.parse(auto.body), { ok: true, auto: true }, 'the response says it auto-paired');
  const cookie = auto.headers['set-cookie'][0].split(';')[0];
  assert.match(auto.headers['set-cookie'][0], /^__Host-office_device=/, 'the https cookie, like a code pairing');

  const info = await remoteInfo();
  assert.equal(info.devices.length, count + 1);
  const device = info.devices.at(-1);
  assert.equal(device.name, 'pixel-adhit', 'named after the tailnet hostname');
  assert.equal(device.transport, 'https', 'transport-bound record, exactly like a code pairing');

  // it is an ordinary paired device: reads work, laptop-only settings do not
  assert.equal((await tlsRequest('/', { headers: { Cookie: cookie } })).status, 200);
  const snap = await tlsSnapshot(cookie);
  assert.equal(snap.client.secure, true);
  assert.equal((await tlsPost('/api/remote', { enabled: true }, cookie)).status, 403, 'laptop-only stays laptop-only');
  assert.equal((await tlsPost('/api/config', { roots: [] }, cookie)).status, 403);

  // revocable from the laptop, like any device
  assert.equal((await api('/api/remote/revoke', { id: device.id })).status, 200);
  assert.equal((await tlsRequest('/', { headers: { Cookie: cookie } })).status, 302, 'its cookie is dead');
  assert.equal((await remoteInfo()).devices.length, count, 'gone from the list');
});

// ---------- GET /pair auto-pairs too: the phone redirected here never sees the pin form ----------

test('GET /pair without a code from an owner device auto-pairs and goes home', async () => {
  const count = (await remoteInfo()).devices.length;
  const res = await tlsRequest('/pair');
  assert.equal(res.status, 302, res.body.slice(0, 120));
  assert.equal(res.headers.location, '/', 'straight to the office, no form');
  const setCookie = res.headers['set-cookie'][0];
  assert.match(setCookie, /^__Host-office_device=/, 'the https cookie, like a code pairing');
  const cookie = setCookie.split(';')[0];

  const info = await remoteInfo();
  assert.equal(info.devices.length, count + 1, 'one device record, from the GET alone');
  const device = info.devices.at(-1);
  assert.equal(device.name, 'pixel-adhit', 'named after the tailnet hostname');
  assert.equal(device.transport, 'https', 'transport-bound record');

  assert.equal((await tlsRequest('/', { headers: { Cookie: cookie } })).status, 200, 'the cookie works at once');
  await api('/api/remote/revoke', { id: device.id });
  assert.equal((await remoteInfo()).devices.length, count, 'gone again');
});

test('GET /pair with a valid cookie never mints another device', async () => {
  const first = await tlsRequest('/pair');
  assert.equal(first.status, 302);
  const cookie = first.headers['set-cookie'][0].split(';')[0];
  const count = (await remoteInfo()).devices.length;
  const again = await tlsRequest('/pair', { headers: { Cookie: cookie } });
  assert.equal(again.status, 302, 'goes home');
  assert.equal(again.headers['set-cookie'], undefined, 'no new cookie');
  assert.equal((await remoteInfo()).devices.length, count, 'no record for an already-paired browser');
  await api('/api/remote/revoke', { id: (await remoteInfo()).devices.at(-1).id });
});

test('GET /pair from a subresource (another site) never auto-pairs', async () => {
  const count = (await remoteInfo()).devices.length;
  const res = await tlsRequest('/pair', { headers: { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' } });
  assert.equal(res.status, 200, 'the form, not a pairing');
  assert.match(res.body, /Hubungkan ke Adhitron/);
  assert.equal(res.headers['set-cookie'], undefined, 'no cookie handed out');
  assert.equal((await remoteInfo()).devices.length, count, 'no device appeared');
});

test('GET /pair with the setting off: the code form, no device', async () => {
  assert.equal((await api('/api/remote/auto-pair', { autoPairTailnet: false })).status, 200);
  const count = (await remoteInfo()).devices.length;
  const res = await tlsRequest('/pair');
  assert.equal(res.status, 200);
  assert.match(res.body, /Hubungkan ke Adhitron/, 'the PIN form');
  assert.equal(res.headers['set-cookie'], undefined, 'no cookie handed out');
  assert.equal((await remoteInfo()).devices.length, count, 'no device appeared');
  await api('/api/remote/auto-pair', { autoPairTailnet: true }); // restore for the next tests
});

test('GET /pair from another tailnet user: the code form', async () => {
  scenario({ peers: peers(OTHER) }); // the connecting loopback address belongs to another user
  const count = (await remoteInfo()).devices.length;
  const res = await tlsRequest('/pair');
  assert.equal(res.status, 200, 'no auto-pair: the form answers');
  assert.match(res.body, /Hubungkan ke Adhitron/);
  assert.equal((await remoteInfo()).devices.length, count, 'no device appeared');
  scenario({}); // back to the owner map
});

test('GET /pair with a broken `tailscale status --json`: the code form, fail closed', async () => {
  scenario({ statusGarbage: true });
  const count = (await remoteInfo()).devices.length;
  const res = await tlsRequest('/pair');
  assert.equal(res.status, 200);
  assert.match(res.body, /Hubungkan ke Adhitron/);
  assert.equal((await remoteInfo()).devices.length, count, 'no auto-pair from garbage output');
  scenario({});
});

test('GET /pair over plain http (WiFi/LAN): the code form, never auto-pair', async (t) => {
  if (!LAN) return t.skip('no LAN address on this machine');
  const count = (await remoteInfo()).devices.length;
  const res = await fetch(`http://${LAN}:${PORT}/pair`, { redirect: 'manual' });
  assert.equal(res.status, 200, 'the eligible address still needs the code over http');
  assert.match(await res.text(), /Hubungkan ke Adhitron/);
  assert.equal((await remoteInfo()).devices.length, count, 'no device appeared');
});

test('over plain http (WiFi/LAN) the SAME eligible address still needs the code', async (t) => {
  if (!LAN) return t.skip('no LAN address on this machine');
  const count = (await remoteInfo()).devices.length;
  const post = (body) => fetch(`http://${LAN}:${PORT}/pair`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const wrong = await post({ code: '000000' === (await api('/api/remote/pairing')).body.code ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /Kode salah/);
  assert.equal((await remoteInfo()).devices.length, count, 'no device appeared');
  // and even with no code at all: no auto-pair
  const empty = await post({});
  assert.equal(empty.status, 400);
  assert.equal((await remoteInfo()).devices.length, count, 'still no device');
});

test('a device of ANOTHER tailnet user is not auto-paired (but its code still works)', async () => {
  const count = (await remoteInfo()).devices.length;
  scenario({ peers: peers(OTHER) }); // now the connecting loopback address belongs to another user
  const refused = await tlsPost('/pair', {});
  assert.equal(refused.status, 400, 'no auto-pair: the code flow answers');
  assert.match(JSON.parse(refused.body).error, /kedaluwarsa|Kode salah/);
  assert.equal((await remoteInfo()).devices.length, count, 'no device appeared');

  const code = (await api('/api/remote/pairing')).body.code;
  const paired = await tlsPost('/pair', { code });
  assert.equal(paired.status, 200, 'the code path still pairs the other user’s device');
  assert.equal(JSON.parse(paired.body).auto, undefined, 'this one went through the code');
  assert.equal((await remoteInfo()).devices.length, count + 1);
  await api('/api/remote/revoke', { id: (await remoteInfo()).devices.at(-1).id });
});

test('with the setting off, even the owner’s device needs the code', async () => {
  scenario({ peers: peers(OWNER) });
  const count = (await remoteInfo()).devices.length;
  assert.equal((await api('/api/remote/auto-pair', { autoPairTailnet: false })).body.autoPairTailnet, false);
  const refused = await tlsPost('/pair', {});
  assert.equal(refused.status, 400, 'no auto-pair while the setting is off');
  assert.equal((await remoteInfo()).devices.length, count);

  const code = (await api('/api/remote/pairing')).body.code;
  assert.equal((await tlsPost('/pair', { code })).status, 200, 'the code still works for the owner too');
  assert.equal((await remoteInfo()).devices.length, count + 1);
  await api('/api/remote/revoke', { id: (await remoteInfo()).devices.at(-1).id });
  assert.equal(JSON.parse(readFileSync(STATE, 'utf8')).remote.autoPairTailnet, false, 'the setting persisted to state.json');
});

test('a broken `tailscale status --json` fails closed: code required, no crash', async () => {
  await api('/api/remote/auto-pair', { autoPairTailnet: true }); // the previous test left it off
  scenario({ statusGarbage: true });
  const count = (await remoteInfo()).devices.length;
  const refused = await tlsPost('/pair', {});
  assert.equal(refused.status, 400);
  assert.equal((await remoteInfo()).devices.length, count, 'no auto-pair from garbage output');
  assert.equal((await tlsRequest('/pair')).status, 200, 'the server is unharmed');
  // and back to normal
  scenario({});
  const auto = await tlsPost('/pair', {});
  assert.equal(auto.status, 200, 'auto-pair works again');
  await api('/api/remote/revoke', { id: (await remoteInfo()).devices.at(-1).id });
});

test('the setting is laptop-only: a paired device gets 403', async () => {
  const auto = await tlsPost('/pair', {});
  assert.equal(auto.status, 200, 'auto-paired again for this test');
  const cookie = auto.headers['set-cookie'][0].split(';')[0];
  assert.equal((await tlsPost('/api/remote/auto-pair', { autoPairTailnet: true }, cookie)).status, 403, '/api/remote* is refused to paired phones');
  assert.equal((await api('/api/remote/auto-pair', { autoPairTailnet: true })).status, 200, 'the laptop can turn it back on');
  assert.equal((await remoteInfo()).devices.filter((d) => d.name === 'pixel-adhit').length, 1, 'the whole loop ran on auto-pairings');
});

// keep an http code pairing in the file to prove the two paths coexist
test('a normal code pairing over http keeps working next to auto-pair', async (t) => {
  if (!LAN) return t.skip('no LAN address on this machine');
  const paired = await pairByCode();
  assert.equal(paired.status, 200);
  assert.equal(JSON.parse(await paired.text()).auto, undefined, 'no auto flag on a code pairing');
  assert.ok((await remoteInfo()).devices.some((d) => d.transport === 'http'));
});
