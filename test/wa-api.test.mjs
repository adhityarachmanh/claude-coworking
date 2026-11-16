// 📱 WhatsApp di dalam aplikasi (server.js + src/routes/wa.js + src/wa-link.js): laptop menautkan WhatsApp dengan
// memindai QR, menguji tautan, lalu melepasnya. End to end terhadap server sungguhan, dengan soket baileys palsu
// (OFFICE_WA_FAKE=1, hanya untuk test) — tidak ada akun WhatsApp sungguhan yang dihubungi.
//
// Dua hal yang dijaga file ini: bentuk kontrak /api/wa/* (termasuk event `wa` di stream), dan bahwa QR tidak pernah
// sampai ke HP — baik lewat rute (403 dari laptop-only) maupun lewat stream HP WiFi biasa (redactor `wa`).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lanAddresses } from '../src/remote.js';
import { selfSignedCert } from '../test-support/x509.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-wa-'));
const SENT = path.join(TMP, 'wa-sent.jsonl'); // what the fake socket "delivered" (test-only, see server.js)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let PORT;
let BASE;
let token;
/** A paired device on the plain-WiFi (LAN) origin: `{ base, cookie, officeToken }`, or null with no LAN address. */
let phone = null;

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

/** A request with this start's token; `base`/`cookie` let a paired phone on the LAN use its own origin. */
async function call(pathname, { method = 'GET', body, base = BASE, cookie, officeToken = token } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(officeToken ? { 'X-Office-Token': officeToken } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
}

const status = (options) => call('/api/wa/status', options);
const link = (options) => call('/api/wa/link', { method: 'POST', ...options });
const unlink = (options) => call('/api/wa/unlink', { method: 'POST', ...options });
const testMessage = (options) => call('/api/wa/test', { method: 'POST', ...options });

/** Bounded polling: a broken server fails the test instead of hanging the suite. */
async function until(fn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) assert.fail('timed out waiting for the expected state');
    await sleep(stepMs);
  }
}

/** The frames of one SSE event in a buffer that is still growing; a half-received frame is simply not counted. */
const framesOf = (buffer, name) =>
  buffer.split('\n\n').flatMap((frame) => {
    if (!frame.startsWith(`event: ${name}\n`)) return [];
    try {
      return [JSON.parse(frame.slice(frame.indexOf('\ndata: ') + 7))];
    } catch {
      return [];
    }
  });

/** Reads a stream into `sink` until it is cancelled; never throws into the test. */
function pump(res, sink) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) return;
      sink.text += decoder.decode(value, { stream: true });
    }
  })().catch(() => {});
  return { reader, done };
}

before(async () => {
  PORT = await freePort();
  BASE = `http://localhost:${PORT}`;
  mkdirSync(path.join(TMP, 'projects', 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    cwd: APP,
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPEN_DRY_RUN: '1',
      OFFICE_WA_FAKE: '1', // baileys' socket is replaced: a QR, then "linked" (test only)
      OFFICE_WA_FAKE_SENT: SENT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.resume();
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];

  // A paired phone on the plain-WiFi origin, so the "not from the laptop" side of every gate can be exercised.
  const ip = lanAddresses()[0];
  if (!ip) return;
  const LAN = `http://${ip}:${PORT}`;
  assert.equal((await call('/api/remote', { method: 'POST', body: { enabled: true } })).status, 200);
  await sleep(300); // the LAN listener opens in the background
  const { code } = (await call('/api/remote/pairing', { method: 'POST' })).body;
  const paired = await fetch(`${LAN}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(paired.status, 200, 'paring lewat LAN');
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const officeToken = (await (await fetch(`${LAN}/`, { headers: { Cookie: cookie } })).text()).match(/office-token" content="([^"]+)"/)[1];
  phone = { base: LAN, cookie, officeToken };
});

after(async () => {
  await stopTailnet();
  await call('/api/remote', { method: 'POST', body: { enabled: false } }).catch(() => {});
  server?.kill();
  await sleep(400);
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('/pair: tombol kirim PIN sudah mati sejak markup, sebelum pin-status menjawab', async () => {
  // The script enables it only after pin-status says reason 'ready': a button that looks active while the first
  // answer is still in flight invites a click that cannot work.
  const html = await (await fetch(`${BASE}/pair`)).text();
  assert.match(html, /<button id="send" type="button" disabled>/);
  assert.match(html, /id="paired" hidden/, 'the already-paired block exists, hidden until pin-status says so');
});

test('status starts off', async () => {
  const off = await status();
  assert.equal(off.status, 200);
  assert.deepEqual(off.body, { state: 'off', qr: null, me: null, since: null });

  // The app's API helper only speaks POST (src/routes/router.js): both spellings answer the same.
  const posted = await status({ method: 'POST' });
  assert.equal(posted.status, 200);
  assert.deepEqual(posted.body, { state: 'off', qr: null, me: null, since: null });

  assert.equal((await status({ officeToken: '' })).status, 403, "the laptop's per-start token is required");
});

test('link returns a QR and status polling sees it', async () => {
  // The laptop's own stream first: the `wa` event must carry the same shape as the GET.
  const streamed = { text: '' };
  const laptop = pump(await fetch(`${BASE}/stream`), streamed);
  await sleep(100);
  try {
    const res = await link();
    assert.equal(res.status, 200);
    assert.ok(['connecting', 'qr'].includes(res.body.state), `state right after link: ${res.body.state}`);
    assert.equal(res.body.me, null, 'nothing is paired yet');
    assert.notEqual(res.body.state, 'linked', 'link() never claims success before the QR is scanned');

    const withQr = await until(async () => {
      const current = await status();
      return current.body.qr ? current.body : null;
    });
    assert.equal(withQr.state, 'qr', 'the socket is showing a code');
    assert.match(withQr.qr, /^data:image\/png;base64,/, 'the QR reaches the page as an image it can draw');
    assert.equal(withQr.me, null);

    const seen = await until(() => framesOf(streamed.text, 'wa').find((event) => event.state === 'qr'));
    assert.deepEqual(seen, { state: 'qr' }, 'the event carries the state only: a QR never travels over a broadcast');
  } finally {
    await laptop.reader.cancel().catch(() => {});
    await laptop.done;
  }
});

test('test 409 when not linked, 200 after link', async () => {
  // The fake socket reports itself linked a moment after link(): wait for that before asking for a send.
  const linked = await until(async () => {
    const current = await status();
    return current.body.state === 'linked' ? current.body : null;
  });
  assert.deepEqual(linked.me, { number: '628123456789', name: 'WhatsApp Uji' });

  const ok = await testMessage();
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  // The message goes to the linked account itself, never to a number from an environment variable.
  const sent = readFileSync(SENT, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const probe = sent.find((message) => /pesan uji/.test(message.text));
  assert.ok(probe, 'the test message was delivered');
  assert.match(probe.jid, /^628123456789/, probe.jid);

  const off = await unlink();
  assert.equal(off.status, 200);
  assert.deepEqual(off.body, { ok: true });
  assert.deepEqual((await status()).body, { state: 'off', qr: null, me: null, since: null }, 'unlink drops the link at once');

  const refused = await testMessage();
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'WhatsApp belum ditautkan.');

  // Linked again for the rest of this file, like the settings page would: unlink is not a one-way trip.
  assert.equal((await link()).status, 200);
  await until(async () => (await status()).body.state === 'linked');
});

test('sejak tertaut: waktu tautan itu sendiri, bukan waktu berkas sesi terakhir ditulis', async () => {
  const linked = (await status()).body;
  assert.equal(linked.state, 'linked');
  assert.ok(linked.since > 0, 'a link date is published');
  // Every credentials update (the ratchet moves with each message) rewrites session.bin. A touch may not move the
  // date the user reads: "tertaut sejak …" must still be the moment of linking.
  const session = path.join(TMP, 'data', 'wa', 'session.bin');
  const future = new Date(Date.now() + 3600_000);
  utimesSync(session, future, future);
  assert.equal((await status()).body.since, linked.since, 'the session file mtime is not the link date');
  assert.ok(existsSync(path.join(TMP, 'data', 'wa', 'linked-at')), 'the moment of linking is recorded once, on its own');
});

test('over plain WiFi every WhatsApp route is refused (403), GET status included', async (t) => {
  if (!phone) return t.skip('no LAN address on this machine');
  // link stays laptop-only (the QR is a session credential); status/unlink/test are remote admin, so a plain-WiFi
  // phone is refused with the Tailscale reason instead.
  for (const [name, request, reason] of [
    ['status', status, /Tailscale/],
    ['link', link, /hanya bisa diubah dari laptop/],
    ['unlink', unlink, /Tailscale/],
    ['test', testMessage, /Tailscale/],
  ]) {
    const res = await request(phone);
    assert.equal(res.status, 403, `${name} refused over plain WiFi`);
    assert.match(res.body.error, reason, name);
  }
  const read = await status(phone);
  assert.equal(read.status, 403, 'GET /api/wa/status from a phone: the QR is never handed out here');
  assert.equal(JSON.stringify(read.body).includes('qr'), false, 'not even a null qr field: the route does not exist for a phone');
});

test('a non-local client never receives the QR: the wa event is { state } only', async (t) => {
  if (!phone) return t.skip('no LAN address on this machine');
  // Back to off first, so the next link() publishes a fresh sequence of events to the stream below.
  await unlink();
  assert.deepEqual((await status()).body, { state: 'off', qr: null, me: null, since: null });

  const streamed = { text: '' };
  const mobile = pump(await fetch(`${phone.base}/stream`, { headers: { Cookie: phone.cookie } }), streamed);
  try {
    await sleep(150);
    assert.equal((await link()).status, 200);
    const events = await until(() => {
      const seen = framesOf(streamed.text, 'wa');
      return seen.some((event) => event.state === 'qr') ? seen : null;
    });
    for (const event of events) {
      assert.deepEqual(event, { state: event.state }, 'no qr, no me: the state is the whole payload');
      assert.equal(typeof event.state, 'string');
    }
    assert.ok(events.some((event) => event.state === 'qr'), 'the client is still told a code is being shown');
    assert.equal(streamed.text.includes('data:image/png'), false, 'the QR image never reaches this client');
  } finally {
    await mobile.reader.cancel().catch(() => {});
    await mobile.done;
  }
});

// ---------- /api/auth/pin-status: what the /pair page has to know ----------
//
// A second server, because the tailnet peer check only runs on the https listener (like test/https.test.mjs and
// test/tailnet-autopair.test.mjs): the fake Tailscale CLI says who is calling, and a certificate made here brings
// the listener up on loopback (OFFICE_HTTPS_TEST_BIND). The WhatsApp socket stays fake throughout.
const TNET = path.join(TMP, 'tailnet');
const TCONF = path.join(TNET, 'fake-tailscale.json');
const TCERT = path.join(TNET, 'issued.crt');
const TKEY = path.join(TNET, 'issued.key');
const TSENT = path.join(TNET, 'wa-sent.jsonl'); // what the fake socket of the second server "delivered"
const TNAME = 'office.test'; // the MagicDNS name: the https listener answers only to this host
const OWNER = 1001; // the laptop owner's tailnet user
const OTHER = 2002; // a device shared in from another tailnet
const tnet = { port: 0, httpsPort: 0, base: '', host: '', token: '' };
let tnetChild = null;
let deviceCookie = '';

/** The peers the fake CLI reports: by default the loopback peer is the owner's own phone. */
function tailnetScenario({ peers = { owner: { UserID: OWNER, TailscaleIPs: ['127.0.0.1'], HostName: 'pixel-adhit' } }, selfUserId = OWNER } = {}) {
  writeFileSync(TCONF, JSON.stringify({ host: TNAME, certFile: TCERT, keyFile: TKEY, certDomains: true, selfUserId, peers }, null, 2));
}

/** A request to the second server's HTTP (laptop) listener. */
async function tnetCall(pathname, { method = 'POST', body } = {}) {
  const res = await fetch(tnet.base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tnet.token ? { 'X-Office-Token': tnet.token } : {}) },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
}

/** One request to the https listener on 127.0.0.1 (fetch can't set Host or trust a test certificate). */
function tlsRequest(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port: tnet.httpsPort, path: pathname, method, servername: TNAME, rejectUnauthorized: false, agent: false, headers: { Host: tnet.host, Connection: 'close', ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const pinStatusTls = (cookie) => tlsRequest('/api/auth/pin-status', { headers: cookie ? { Cookie: cookie } : {} });
const listening = () => tlsRequest('/health').then(() => true, () => false);

async function startTailnet() {
  tnet.port = await freePort();
  tnet.httpsPort = await freePort();
  tnet.base = `http://localhost:${tnet.port}`;
  tnet.host = `${TNAME}:${tnet.httpsPort}`;
  const pair = selfSignedCert({ cn: TNAME, dns: [TNAME], ips: [], notAfter: new Date(Date.now() + 80 * 86_400_000) });
  writeFileSync(TCERT, pair.cert);
  writeFileSync(TKEY, pair.key);
  tailnetScenario();
  tnetChild = spawn(process.execPath, [path.join(APP, 'server.js')], {
    cwd: APP,
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(tnet.port),
      OFFICE_HTTPS_PORT: String(tnet.httpsPort),
      OFFICE_HTTPS_TEST_BIND: '127.0.0.1',
      OFFICE_TAILSCALE_BIN: path.join(APP, 'test-support', 'fake-tailscale.mjs'),
      FAKE_TAILSCALE_CONFIG: TCONF,
      OFFICE_TAILNET_CACHE_MS: '0', // tailnetScenario() swaps the identity while the server runs
      OFFICE_DATA_DIR: path.join(TNET, 'data'),
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPEN_DRY_RUN: '1',
      OFFICE_WA_FAKE: '1',
      OFFICE_WA_FAKE_SENT: TSENT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tnetChild.stderr.resume();
  await new Promise((resolve, reject) => {
    tnetChild.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    tnetChild.on('exit', (code) => reject(new Error(`server WhatsApp/PIN exited ${code}`)));
  });
  tnet.token = (await (await fetch(tnet.base)).text()).match(/office-token" content="([^"]+)"/)[1];
}

/** Stops the second server WITHOUT unlinking: its data folder (and the encrypted session in it) stays on disk. */
async function stopTailnet() {
  if (!tnetChild) return;
  const child = tnetChild;
  tnetChild = null;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 5_000).unref?.();
  });
  await sleep(300);
}

before(async () => {
  mkdirSync(TNET, { recursive: true });
  await startTailnet();
  assert.equal((await tnetCall('/api/remote', { body: { enabled: true } })).status, 200);
  // The https listener only exists while phone access is on: its certificate is already on disk.
  await until(async () => (await tnetCall('/api/remote/https-check', { body: {} })).body.state === 'ok');
  assert.ok(await until(listening), 'https listener up');
});

after(async () => {
  await stopTailnet();
});

test('pin-status: a paired device is told so; reason wa-off, then ready once WhatsApp is linked', async () => {
  // Pair this browser over https, like a phone that followed the QR link would.
  const pairing = await tnetCall('/api/remote/pairing', { body: { https: true } });
  assert.equal(pairing.status, 200, JSON.stringify(pairing.body));
  const query = new URL(pairing.body.qrUrl);
  const paired = await tlsRequest(query.pathname + query.search);
  assert.equal(paired.status, 302);
  deviceCookie = paired.headers['set-cookie'][0].split(';')[0];

  const off = await pinStatusTls(deviceCookie);
  assert.equal(off.status, 200);
  assert.equal(off.body.paired, true, 'this browser already holds a valid device cookie');
  assert.equal(off.body.reason, 'wa-off');
  assert.deepEqual({ configured: off.body.configured, status: off.body.status, active: off.body.active }, { configured: false, status: 'disconnected', active: false });
  assert.equal(typeof off.body.expiresInSec, 'number', 'the old fields stay, so the page keeps working');
  assert.equal(typeof off.body.canRequestInSec, 'number');

  // A browser with no cookie is not paired, but the answer is the same: the button only needs WhatsApp.
  const stranger = await pinStatusTls('');
  assert.equal(stranger.status, 200);
  assert.equal(stranger.body.paired, false);
  assert.equal(stranger.body.reason, 'wa-off');

  // Link WhatsApp from the laptop (fake socket): pin-status follows it without a reload.
  assert.equal((await tnetCall('/api/wa/link')).status, 200);
  await until(async () => (await tnetCall('/api/wa/status', { method: 'GET' })).body.state === 'linked');
  const ready = await pinStatusTls(deviceCookie);
  assert.equal(ready.body.reason, 'ready');
  assert.deepEqual({ configured: ready.body.configured, status: ready.body.status }, { configured: true, status: 'connected' });
});

test('pin-status 403: another tailnet user’s device gets its own reason, not "phone access is off"', async () => {
  tailnetScenario({ peers: { friend: { UserID: OTHER, TailscaleIPs: ['127.0.0.1'], HostName: 'teman' } } });
  const res = await pinStatusTls(deviceCookie);
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'not-owner-tailnet');
  assert.doesNotMatch(res.body.error, /Akses dari HP sedang dimatikan/);
  assert.match(res.body.error, /bukan milik pemilik laptop|Tailscale/i);
  assert.match(res.body.error, /kode 6 digit/i, 'the fallback is named');
  // No PIN is minted for that device either.
  assert.equal((await tlsRequest('/api/auth/request-pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  tailnetScenario(); // the owner's own device again
});

test('pin-status 403: phone access off carries its own reason', async () => {
  // Turning phone access off also closes the https listener, so this is asked on the laptop's own listener: the
  // master gate answers first on both, with the reason the page needs.
  assert.equal((await tnetCall('/api/remote', { body: { enabled: false } })).status, 200);
  const res = await tnetCall('/api/auth/pin-status', { method: 'GET' });
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'phone-access-off');
  assert.match(res.body.error, /dimatikan/);
  assert.equal((await tnetCall('/api/remote', { body: { enabled: true } })).status, 200);
  assert.ok(await until(async () => (await tnetCall('/api/remote/https-check', { body: {} })).body.state === 'ok'));
  assert.ok(await until(listening), 'https listener back up');
});

test('setelah restart: sesi WhatsApp tersambung lagi sendiri dan PIN langsung bisa dikirim', async () => {
  assert.equal((await tnetCall('/api/wa/status', { method: 'GET' })).body.state, 'linked', 'the session is live before the restart');

  // Restart on the same data folder and never call /api/wa/link: only the restore on boot can bring WhatsApp back.
  await stopTailnet();
  await startTailnet();

  // A PIN asked right after the restart must wait for that reconnect instead of answering 503 and telling the
  // owner to reload a page that would not have helped.
  const pin = await tnetCall('/api/auth/request-pin', { body: {} });
  assert.equal(pin.status, 200, JSON.stringify(pin.body));
  const delivered = existsSync(TSENT) ? readFileSync(TSENT, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  assert.match(delivered.at(-1).text, /Kode PIN Akses Adhitron/, 'the PIN was delivered over the reconnected session');

  assert.equal((await tnetCall('/api/wa/status', { method: 'GET' })).body.state, 'linked');
  assert.equal((await tnetCall('/api/auth/pin-status', { method: 'GET' })).body.reason, 'ready');
});

