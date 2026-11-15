// 📱 WhatsApp di dalam aplikasi (server.js + src/routes/wa.js + src/wa-link.js): laptop menautkan WhatsApp dengan
// memindai QR, menguji tautan, lalu melepasnya. End to end terhadap server sungguhan, dengan soket baileys palsu
// (OFFICE_WA_FAKE=1, hanya untuk test) — tidak ada akun WhatsApp sungguhan yang dihubungi.
//
// Dua hal yang dijaga file ini: bentuk kontrak /api/wa/* (termasuk event `wa` di stream), dan bahwa QR tidak pernah
// sampai ke HP — baik lewat rute (403 dari laptop-only) maupun lewat stream HP WiFi biasa (redactor `wa`).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lanAddresses } from '../src/remote.js';

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
  await call('/api/remote', { method: 'POST', body: { enabled: false } }).catch(() => {});
  server?.kill();
  await sleep(400);
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
