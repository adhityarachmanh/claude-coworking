// The https listener for phones on the tailnet (src/tls.js + server.js), end to end against the real server
// with a fake Tailscale CLI (test-support/fake-tailscale.mjs) and certificates made in the test.
// CI has no Tailscale interface, so the listener is bound to 127.0.0.1 (OFFICE_HTTPS_TEST_BIND): that also
// proves a TLS socket from loopback is never treated as the laptop.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { selfSignedCert } from '../test-support/x509.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-https-'));
const NAME = 'office.test'; // the "MagicDNS name" the fake CLI reports
let PORT;
let HTTPS_PORT;
let BASE;
let HOST;
const CONFIG = path.join(TMP, 'fake-tailscale.json');
const CERT = path.join(TMP, 'issued.crt');
const KEY = path.join(TMP, 'issued.key');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let token;

function issue(days = 80) {
  const pair = selfSignedCert({ cn: NAME, dns: [NAME], ips: [], notAfter: new Date(Date.now() + days * 86_400_000) });
  writeFileSync(CERT, pair.cert);
  writeFileSync(KEY, pair.key);
  return new X509Certificate(pair.cert).fingerprint256;
}
const scenario = (s) => writeFileSync(CONFIG, JSON.stringify({ host: NAME, certFile: CERT, keyFile: KEY, ...s }));

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
  scenario({ certDomains: false }); // like this machine's tailnet today: HTTPS Certificates off
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_HTTPS_PORT: String(HTTPS_PORT),
      OFFICE_HTTPS_TEST_BIND: '127.0.0.1',
      OFFICE_TAILSCALE_BIN: path.join(APP, 'test-support', 'fake-tailscale.mjs'),
      FAKE_TAILSCALE_CONFIG: CONFIG,
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
const remoteInfo = async () => (await snapshot(BASE)).config.remote;

async function snapshot(base, headers = {}) {
  const res = await fetch(`${base}/stream`, { headers });
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

/**
 * One request to the https listener on 127.0.0.1 (fetch can't set Host or trust a test certificate).
 * @returns {Promise<{ status: number, headers: object, body: string, fingerprint: string }>}
 */
function tlsRequest(p, { method = 'GET', host = HOST, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: HTTPS_PORT, path: p, method, servername: NAME, rejectUnauthorized: false, agent: false, headers: { Host: host, Connection: 'close', ...headers } }, (res) => {
      const fingerprint = res.socket.getPeerCertificate()?.fingerprint256;
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text, fingerprint }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
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
const listening = () => tlsRequest('/health').then(() => true, () => false);
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(100);
  }
  return false;
}

test('HTTPS Certificates off in the tailnet: certs-disabled, no https listener, HTTP works as before', async () => {
  assert.equal((await remoteInfo()).https.state, 'off', 'phone access off');
  assert.equal(await listening(), false);
  assert.equal((await api('/api/remote/https-check')).status, 400, 'nothing to check while phone access is off');

  const on = await api('/api/remote', { enabled: true });
  assert.equal(on.status, 200);
  assert.ok('https' in on.body, '/api/remote answers with the https status too');
  const checked = await api('/api/remote/https-check');
  assert.equal(checked.status, 200);
  assert.equal(checked.body.state, 'certs-disabled');
  assert.match(checked.body.error, /HTTPS Certificates/);
  assert.equal(checked.body.url, null);
  assert.equal((await remoteInfo()).https.state, 'certs-disabled', 'the 📱 dialog sees it in config.remote.https');
  assert.equal(await listening(), false, 'no https listener without a certificate');
  assert.equal((await api('/api/remote/pairing', { https: true })).status, 400, 'no https QR without a certificate');
  const pairing = await api('/api/remote/pairing');
  if (pairing.status === 200) assert.equal(pairing.body.https, null);
  assert.equal((await fetch(`${BASE}/health`)).status, 200, 'the laptop is unaffected');
});

test('with a certificate: https listener up, answers only to its MagicDNS name, never as the laptop', async () => {
  scenario({ certDomains: true });
  const checked = await api('/api/remote/https-check');
  assert.equal(checked.body.state, 'ok');
  assert.equal(checked.body.url, `https://${HOST}`);
  assert.ok(!JSON.stringify(checked.body).includes('PRIVATE'), 'no key in the status');
  assert.ok(await until(listening), 'https listener started');

  // Host check per scheme (DNS rebinding): only <name>:<https port> on https…
  for (const host of ['127.0.0.1:' + HTTPS_PORT, `localhost:${HTTPS_PORT}`, `${NAME}:${PORT}`, NAME, 'evil.example']) assert.equal((await tlsRequest('/', { host })).status, 421, host);
  // …and the http listeners never answer to the https name
  const viaHttp = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/health', headers: { Host: HOST, Connection: 'close' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(viaHttp, 421, 'the http listener refuses the https host name');

  // TLS from 127.0.0.1 is not the laptop: pairing is required, laptop-only settings are out of reach
  const home = await tlsRequest('/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.location, '/pair');
  assert.equal(home.headers['cross-origin-opener-policy'], 'same-origin', 'COOP on the https origin');
  assert.equal(home.headers['strict-transport-security'], undefined, 'no HSTS (design D4)');
  assert.match(home.headers['content-security-policy'], /script-src 'self'/);
  assert.equal((await tlsRequest('/health')).status, 302, 'no laptop-only /health (pid) over TLS');
  // malformed cookies (bad %-escapes) are skipped, never a 500
  const garbage = '__Host-office_device=%E0%A4%A; office_device=%zz; =x; plain';
  assert.equal((await tlsRequest('/', { headers: { Cookie: garbage } })).status, 302);
  assert.equal((await fetch(`${BASE}/health`, { headers: { Cookie: garbage } })).status, 200, 'the laptop too');
  for (const p of ['/api/config', '/api/shutdown', '/api/remote', '/api/backup/export']) {
    assert.equal((await tlsRequest(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: '{}' })).status, 401, p);
  }
  // Origin must be the https origin itself
  assert.equal((await tlsRequest('/pair', { headers: { Origin: `http://${HOST}` } })).status, 403, 'http origin on the https listener');
  assert.equal((await tlsRequest('/pair', { headers: { Origin: `https://${NAME}:${PORT}` } })).status, 403);
  assert.equal((await tlsRequest('/pair', { headers: { Origin: `https://${HOST}` } })).status, 200);
});

test('pairing over https: __Host- cookie (Secure, HttpOnly, SameSite=Strict), token bound to https', async () => {
  const pairing = await api('/api/remote/pairing', { https: true });
  assert.equal(pairing.status, 200, JSON.stringify(pairing.body));
  assert.ok(pairing.body.qrUrl.startsWith(`https://${HOST}/pair?k=`), pairing.body.qrUrl);
  const q = new URL(pairing.body.qrUrl);
  const paired = await tlsRequest(q.pathname + q.search);
  assert.equal(paired.status, 302);
  const setCookie = paired.headers['set-cookie'][0];
  assert.match(setCookie, /^__Host-office_device=[\w-]+; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+$/);
  assert.doesNotMatch(setCookie, /Domain=/i);
  const value = setCookie.split(';')[0].split('=')[1];
  const cookie = `__Host-office_device=${value}`;

  // the paired phone (over a non-Tailscale link here: loopback) is an ordinary read-only phone
  assert.equal((await tlsRequest('/', { headers: { Cookie: cookie } })).status, 200);
  const snap = await tlsSnapshot(cookie);
  assert.equal(snap.client.local, false, 'TLS socket is never the laptop');
  assert.equal(snap.client.readOnly, true, 'not the Tailscale interface: read-only like WiFi');
  assert.deepEqual(snap.config.remote.devices, [], 'read-only: no paired device names (privacy)');
  assert.equal((await remoteInfo()).devices.find((d) => d.transport === 'https')?.transport, 'https', 'the laptop sees it as https');
  const phoneToken = (await tlsRequest('/', { headers: { Cookie: cookie } })).body.match(/office-token" content="([^"]+)"/)[1];
  const post = (p) => tlsRequest(p, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Office-Token': phoneToken }, body: JSON.stringify({ enabled: false, roots: [] }) });
  for (const p of ['/api/config', '/api/shutdown', '/api/remote', '/api/remote/pairing', '/api/remote/https-check', '/api/backup/export', '/api/projects']) assert.equal((await post(p)).status, 403, p);
  assert.equal((await post('/api/demo')).status, 403, 'actions refused (read-only gate)');
  assert.equal((await post('/api/templates')).status, 200, 'reads work');

  // transport binding: the cookie of one transport means nothing on the other
  assert.equal((await tlsRequest('/', { headers: { Cookie: `office_device=${value}` } })).status, 302, 'the http cookie name is not read over https');
  const { lanAddresses } = await import('../src/remote.js');
  const ip = lanAddresses()[0];
  if (ip) {
    const lan = (p, opts = {}) => fetch(`http://${ip}:${PORT}${p}`, { redirect: 'manual', ...opts });
    assert.ok(await until(() => lan('/pair').then(() => true, () => false)), 'LAN listener up');
    assert.equal((await lan('/', { headers: { Cookie: `office_device=${value}` } })).headers.get('location'), '/pair', 'an https token is refused over plain http');
    // and an http-paired token is refused over https
    const code = (await api('/api/remote/pairing')).body.code;
    const right = await lan('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(right.status, 200);
    assert.doesNotMatch(right.headers.get('set-cookie'), /Secure|__Host-/, 'http pairing keeps the plain cookie');
    const httpValue = right.headers.get('set-cookie').split(';')[0].split('=')[1];
    assert.equal((await lan('/', { headers: { Cookie: `office_device=${httpValue}` } })).status, 200);
    assert.equal((await tlsRequest('/', { headers: { Cookie: `__Host-office_device=${httpValue}` } })).status, 302, 'an http token is refused over https');
  }
});

test('🔔 push: /sw.js only on https (Service-Worker-Allowed, no-cache), CSP worker-src/manifest-src, /api/push/* refused off Tailscale', async () => {
  const sw = await tlsRequest('/sw.js'); // no cookie needed: the worker's update check must not depend on it
  assert.equal(sw.status, 200);
  assert.equal(sw.headers['service-worker-allowed'], '/');
  assert.equal(sw.headers['cache-control'], 'no-cache');
  assert.match(sw.headers['content-type'], /^text\/javascript/);
  assert.match(sw.headers['content-security-policy'], /worker-src 'self'; manifest-src 'self'/);
  assert.equal((await tlsRequest('/sw.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  // http: 404 everywhere (the kill switch), laptop included; the http CSP stays as it was
  const laptop = await fetch(`${BASE}/sw.js`);
  assert.equal(laptop.status, 404);
  assert.doesNotMatch(laptop.headers.get('content-security-policy'), /worker-src/);
  assert.match((await tlsRequest('/pair')).headers['content-security-policy'], /worker-src 'self'/, 'every https response');

  // The laptop (plain http) can't use the push API, nor the action endpoint without a token
  assert.equal((await api('/api/push/vapid')).status, 403);
  const act = await fetch(`${BASE}/api/push/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: 'x'.repeat(43), a: 'allow' }) });
  assert.equal(act.status, 403);
  assert.match((await act.json()).error, /HTTPS Tailscale/);
  assert.equal((await fetch(`${BASE}/api/push/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'other push routes still need the office token');

  // A phone paired over https, but not on the Tailscale interface (loopback here): read-only, every push route refused
  const pairing = await api('/api/remote/pairing', { https: true });
  const q = new URL(pairing.body.qrUrl);
  const cookie = (await tlsRequest(q.pathname + q.search)).headers['set-cookie'][0].split(';')[0];
  const phoneToken = (await tlsRequest('/', { headers: { Cookie: cookie } })).body.match(/office-token" content="([^"]+)"/)[1];
  const snap = await tlsSnapshot(cookie);
  assert.equal(snap.client.secure, true);
  assert.deepEqual(snap.client.push, { subscribed: false, settings: null });
  for (const p of ['/api/push/vapid', '/api/push/subscribe', '/api/push/settings', '/api/push/unsubscribe', '/api/push/visible', '/api/push/test']) {
    const res = await tlsRequest(p, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Office-Token': phoneToken }, body: '{}' });
    assert.equal(res.status, 403, p);
    assert.equal(JSON.parse(res.body).readOnly, true, p);
  }
  const tlsAct = await tlsRequest('/api/push/act', { method: 'POST', headers: { Cookie: cookie, Origin: `https://${HOST}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ t: 'x'.repeat(43), a: 'deny' }) });
  assert.equal(tlsAct.status, 403, 'TLS but not Tailscale');
  assert.equal(JSON.parse(tlsAct.body).readOnly, true);
});

test('a renewed certificate is swapped in without a restart; phone access off closes the listener', async () => {
  const before = (await tlsRequest('/pair')).fingerprint;
  const renewed = issue(85);
  assert.notEqual(renewed, before);
  assert.equal((await api('/api/remote/https-check')).body.state, 'ok');
  assert.ok(await until(async () => (await tlsRequest('/pair')).fingerprint === renewed), 'new certificate served (setSecureContext)');

  await api('/api/remote', { enabled: false });
  assert.ok(await until(async () => !(await listening())), 'https listener closed');
  assert.equal((await remoteInfo()).https.state, 'off');
});
