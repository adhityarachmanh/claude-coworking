// 🔐 PIN WhatsApp (server.js /api/auth/*, src/access-pin.js, src/wa-link.js): an unpaired phone asks the server
// to send a 6-digit PIN to the owner's WhatsApp and pairs with it — no walking to the laptop screen. End to end
// against the real server, with a fake baileys socket (OFFICE_WA_FAKE=1, test only) whose "delivered" messages are
// written to OFFICE_WA_FAKE_SENT, so the test can read the PIN the owner would see on the phone.
//
// The cooldown is shortened to 1 s for this file (OFFICE_PIN_COOLDOWN_MS): the real 60 s would make a second PIN
// impossible inside one test. Everything else (5-minute life, 3 attempts, one use) runs at its production value.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-pin-'));
// What the fake WhatsApp socket "sent" (one JSON line per message): jid + text. Test-only, see server.js.
const SENT = path.join(TMP, 'wa-sent.jsonl');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let PORT;
let BASE;
let token;

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

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

/** Every message the fake socket delivered, in order. */
const sentMessages = () =>
  existsSync(SENT)
    ? readFileSync(SENT, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
/** The PIN only ever exists inside that message; the test reads it from there, like the owner's phone would. */
const pinFrom = (text) => String(text).match(/\*(\d{6})\*/)[1];
const lastPin = () => pinFrom(sentMessages().at(-1).text);

/** POST/GET with an optional device cookie; returns the body plus the cookie the server set. */
async function call(pathname, { method = 'POST', body, cookie, officeToken = token } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
      // The laptop's own routes (/api/wa/*) need this start's token; the PIN routes (before pairing) ignore it.
      ...(officeToken ? { 'X-Office-Token': officeToken } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const setCookie = (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')]).filter(Boolean)[0];
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})), cookie: setCookie?.split(';')[0] };
}

const pinStatus = (options) => call('/api/auth/pin-status', { method: 'GET', ...options });
const requestPin = (options) => call('/api/auth/request-pin', options);
const verifyPin = (pin, options = {}) => call('/api/auth/verify-pin', { body: { pin }, ...options });
const waStatus = () => call('/api/wa/status', { method: 'GET' });

/**
 * The requester cookie: /api/auth/request-pin answers with an HttpOnly `office_pin` token, and only the browser
 * carrying it may spend that PIN. It is not the PIN — it is the right to use one, so a stranger on the same WiFi
 * cannot burn the owner's code with three wrong digits.
 */
let pinCookie = '';

/** The laptop's view (config.remote): the device list lives only here, never on a phone. */
async function remoteInfo() {
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]).config.remote;
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
      OFFICE_WA_FAKE: '1', // the WhatsApp socket is replaced (test only): it links itself to a fake number
      OFFICE_WA_FAKE_SENT: SENT,
      OFFICE_PIN_COOLDOWN_MS: '1000',
      // Every request in this file comes from 127.0.0.1: the 3/hour per-address cap would stop the test itself.
      OFFICE_PIN_MAX_PER_IP_PER_HOUR: '20',
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
  await sleep(400);
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('while phone access is off, every PIN route refuses (403)', async () => {
  assert.equal((await pinStatus()).status, 403);
  assert.equal((await requestPin()).status, 403);
  assert.equal((await verifyPin('123456')).status, 403);
});

test('pin-status: no link yet → configured false; after the QR is scanned it follows the link', async () => {
  assert.equal((await call('/api/remote', { body: { enabled: true } })).status, 200);
  const unlinked = await pinStatus();
  assert.equal(unlinked.status, 200, 'the pair page still gets an answer while WhatsApp is not set up');
  assert.deepEqual(
    { configured: unlinked.body.configured, status: unlinked.body.status, active: unlinked.body.active },
    { configured: false, status: 'disconnected', active: false },
    'same mapping the /pair page speaks (src/wa-link.js pairStatus)',
  );

  // Link WhatsApp from the laptop, exactly like the Settings card does.
  assert.equal((await call('/api/wa/link')).status, 200);
  await until(async () => (await waStatus()).body.state === 'linked');

  const linked = await pinStatus();
  assert.equal(linked.status, 200);
  assert.deepEqual({ configured: linked.body.configured, status: linked.body.status }, { configured: true, status: 'connected' });
  assert.equal(JSON.stringify(linked.body).includes('pin'), false, 'no field of the live PIN leaks (active, expiry, budget only)');
});

test('request-pin: sends a 6-digit PIN to the linked number, then holds the cooldown', async () => {
  const first = await requestPin();
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, expiresInSec: 300, attemptsLeft: 3 });
  const messages = sentMessages();
  assert.equal(messages.length, 1, 'exactly one message was delivered');
  assert.match(messages[0].jid, /^628123456789/, 'the PIN goes to the linked account itself, never to a number from the env');
  assert.match(messages[0].text, /Kode PIN Akses Adhitron/);
  const pin = pinFrom(messages[0].text);
  assert.match(pin, /^\d{6}$/);
  assert.equal(JSON.stringify(first.body).includes(pin), false, 'the PIN never comes back in a response');
  assert.match(first.cookie ?? '', /^office_pin=[\w-]{40,}$/, 'the browser leaves with the requester token (HttpOnly)');

  const again = await requestPin({ cookie: first.cookie });
  assert.equal(again.status, 429, 'a second request right away is refused');
  assert.equal(again.headers.get('retry-after'), '1', 'Retry-After tells the page how long to wait');
  assert.equal(again.body.retryAfter, 1);
  assert.equal(sentMessages().length, 1, 'and nothing was sent');

  const live = await pinStatus({ cookie: first.cookie });
  assert.equal(live.body.active, true);
  assert.ok(live.body.expiresInSec > 0 && live.body.expiresInSec <= 300);
  assert.equal((await pinStatus()).body.active, false, 'another browser is not told that a PIN is live');
  pinCookie = first.cookie;
});

test('verify-pin: wrong digits count down, the right PIN pairs the browser once', async () => {
  const pin = lastPin();
  const wrong = pin === '000000' ? '111111' : '000000';
  // A different browser (no requester cookie) may not spend a single attempt of the owner's PIN.
  const stranger = await verifyPin(pin);
  assert.equal(stranger.status, 401);
  assert.match(stranger.body.error, /perangkat lain/);
  assert.deepEqual((await verifyPin(wrong, { cookie: pinCookie })).body, { ok: false, error: 'PIN salah.', triesLeft: 2 });
  assert.deepEqual((await verifyPin(wrong, { cookie: pinCookie })).body, { ok: false, error: 'PIN salah.', triesLeft: 1 });

  const ok = await verifyPin(pin, { cookie: pinCookie });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  assert.ok(ok.cookie, 'the browser leaves with the device cookie');
  const devices = (await remoteInfo()).devices;
  assert.equal(devices.length, 1, 'one record, like a code pairing');
  assert.equal(devices[0].name, 'iPhone · Safari');
  assert.equal(devices[0].transport, 'http', 'bound to the transport it arrived on');

  const repeat = await verifyPin(pin, { cookie: ok.cookie });
  assert.deepEqual(repeat.body, { ok: true, already: true }, 'an already-paired browser is not given a second record');
  assert.equal((await remoteInfo()).devices.length, 1);
  assert.equal((await verifyPin(pin)).status, 401, 'the PIN was used up');
});

test('verify-pin: three wrong attempts burn the PIN, even if the right one follows', async () => {
  await sleep(1100); // the shortened cooldown between two PIN requests
  const fresh = await requestPin();
  assert.equal(fresh.status, 200);
  const pin = lastPin();
  pinCookie = fresh.cookie;

  assert.equal((await verifyPin('999999', { cookie: pinCookie })).body.triesLeft, 2);
  assert.equal((await verifyPin('999999', { cookie: pinCookie })).body.triesLeft, 1);
  const burned = await verifyPin('999999', { cookie: pinCookie });
  assert.equal(burned.status, 401);
  assert.match(burned.body.error, /3 kali/);

  const late = await verifyPin(pin, { cookie: pinCookie });
  assert.equal(late.status, 401, 'a burned PIN is gone: the owner would see a new request on WhatsApp');
  assert.equal((await remoteInfo()).devices.length, 1, 'nothing was paired');
});

test('request-pin: an unlinked WhatsApp is a 503 and leaves no live PIN', async () => {
  await sleep(1100); // the shortened cooldown from the previous test's request
  // No WA gateway to take down any more: unlinking really does leave nothing to send through.
  assert.deepEqual((await call('/api/wa/unlink')).body, { ok: true });
  assert.equal((await waStatus()).body.state, 'off');

  const failed = await requestPin();
  assert.equal(failed.status, 503);
  assert.match(failed.body.error, /WhatsApp belum ditautkan\./);
  assert.equal(sentMessages().length, 2, 'nothing was sent');
  assert.equal((await pinStatus()).body.active, false, 'a PIN the owner never received must not be live');
  assert.equal((await pinStatus()).body.configured, false);
  assert.equal((await verifyPin('123456')).status, 401);

  // Linked again: the PIN path is exactly as usable as before.
  assert.equal((await call('/api/wa/link')).status, 200);
  await until(async () => (await waStatus()).body.state === 'linked');
});

test('turning phone access off drops a live PIN at once', async () => {
  // A failed send holds a 10 s retry (PIN_RETRY_AFTER_FAILURE_MS); the previous test just spent it.
  await sleep(10_500);
  const fresh = await requestPin();
  assert.equal(fresh.status, 200);
  assert.equal((await pinStatus({ cookie: fresh.cookie })).body.active, true);

  assert.equal((await call('/api/remote', { body: { enabled: false } })).status, 200);
  assert.equal((await pinStatus()).status, 403);
  assert.equal((await call('/api/remote', { body: { enabled: true } })).status, 200);
  assert.equal((await pinStatus({ cookie: fresh.cookie })).body.active, false, 'the PIN died with the switch-off, not 5 minutes later');
});
