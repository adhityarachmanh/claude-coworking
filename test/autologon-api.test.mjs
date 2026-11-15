// 🪟 Autologon API (server.js + src/routes/autologon.js): the settings card turns "server hidup sebelum login
// Windows" on with the Windows password, and off again. End to end against a real server, with the Windows side
// replaced by an in-memory switch (OFFICE_AUTOLOGON_FAKE=1, test only): no UAC prompt, no HKLM write, no Startup
// folder, no scheduled task — the routes, validation, status codes and rate limit are the real ones.
//
// The password travels in the request body only: no response, error body or broadcast may contain it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lanAddresses } from '../src/remote.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-autologon-'));
const SECRET = 'R4has1a!SandiWindows';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let PORT;
let BASE;
let token;
/** A paired device on the plain-WiFi (LAN) origin: `{ base, cookie, officeToken }`, or null with no LAN address. */
let phone = null;
/** Every JSON body the server sent, so the last test can prove the password never comes back. */
const responses = [];

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

/** A request with this start's token; `base`/`cookie` let a paired phone on the LAN use its own origin. */
async function call(pathname, { body, base = BASE, cookie, officeToken = token } = {}) {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(officeToken ? { 'X-Office-Token': officeToken } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  responses.push(json);
  return { status: res.status, body: json };
}

const enable = (body, options) => call('/api/autologon', { body, ...options });
const disable = (options) => call('/api/autologon/disable', options);

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
      OFFICE_AUTOLOGON_FAKE: '1', // no UAC, no registry, no Startup folder (test only)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.resume();
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];

  // A paired phone on the plain-WiFi origin, so "not from the laptop" is exercised for real.
  const ip = lanAddresses()[0];
  if (!ip) return;
  const LAN = `http://${ip}:${PORT}`;
  assert.equal((await call('/api/remote', { body: { enabled: true } })).status, 200);
  await sleep(300); // the LAN listener opens in the background
  const { code } = (await call('/api/remote/pairing')).body;
  const paired = await fetch(`${LAN}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(paired.status, 200, 'paring lewat LAN');
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const officeToken = (await (await fetch(`${LAN}/`, { headers: { Cookie: cookie } })).text()).match(/office-token" content="([^"]+)"/)[1];
  phone = { base: LAN, cookie, officeToken };
});

after(async () => {
  await call('/api/remote', { body: { enabled: false } }).catch(() => {});
  server?.kill();
  await sleep(400);
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// The order below is deliberate: every accepted attempt counts towards the 5/minute limit, and the 429 test comes
// right after the fifth one. Each earlier test is one attempt, except the validation test (refused before counting).
test('password wajib string 1…256 karakter', async () => {
  for (const body of [{}, { password: '' }, { password: 42 }, { password: 'x'.repeat(257) }, { password: ['a'] }]) {
    const res = await enable(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, /Sandi Windows wajib diisi/);
  }
});

test('enable sukses: 200, mode boot, autologon on', async () => {
  const res = await enable({ password: SECRET });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.autostart.mode, 'boot', 'launcher + watchdog dipasang untuk boot');
  assert.equal(res.body.autostart.autologon, 'on');
  assert.equal(res.body.autostart.enabled, true);
  assert.equal(JSON.stringify(res.body).includes(SECRET), false, 'sandi tidak boleh muncul di respons');
});

test('sandi Windows salah: 401 dengan pesan Indonesia', async () => {
  const res = await enable({ password: 'salah' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Sandi Windows salah.');
});

test('UAC dibatalkan: 409 Dibatalkan.', async () => {
  const res = await enable({ password: 'batal' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'Dibatalkan.');
});

test('Windows tidak menjawab: 504 dengan pesan Indonesia', async () => {
  const res = await enable({ password: 'lambat' });
  assert.equal(res.status, 504);
  assert.match(res.body.error, /Windows tidak menjawab/);
});

test('percobaan ke-5 masih diterima, ke-6 kena 429', async () => {
  const fifth = await enable({ password: SECRET });
  assert.equal(fifth.status, 200, 'percobaan kelima masih dalam batas');

  const limited = await enable({ password: SECRET });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'Terlalu banyak percobaan. Tunggu sebentar.');
});

test('disable: 200, autologon off, mode turun ke login tanpa mematikan auto-start', async () => {
  const res = await disable();
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.autostart.autologon, 'off');
  assert.equal(res.body.autostart.mode, 'login', 'boot mode tidak masuk akal tanpa autologon');
  assert.equal(res.body.autostart.enabled, true, 'server tetap menyala setelah login');
});

test('dari HP (jalur non-lokal) kedua rute ditolak 403', async (t) => {
  if (!phone) return t.skip('no LAN address on this machine');
  for (const [name, request] of [['enable', () => enable({ password: SECRET }, phone)], ['disable', () => disable(phone)]]) {
    const res = await request();
    assert.equal(res.status, 403, `${name} refused over the LAN`);
    assert.match(res.body.error, /hanya bisa diubah dari laptop/);
    assert.equal(JSON.stringify(res.body).includes(SECRET), false);
  }
});

test('sandi tidak pernah muncul di respons mana pun', () => {
  assert.ok(responses.length > 0);
  for (const body of responses) assert.equal(JSON.stringify(body).includes(SECRET), false, JSON.stringify(body));
  // And no broadcast-like field the UI could echo by accident: responses name the shape, never the secret.
  assert.equal(JSON.stringify(responses).includes('DefaultPassword'), false);
});
