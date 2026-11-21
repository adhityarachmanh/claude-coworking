// bridge/functions.test.mjs — lapis perekat fungsi Netlify (netlify/functions/bridge.mjs).
// Fokus: pemanggilan handleSite yang kini async harus di-await, sehingga path tak dikenal tetap 404
// (bukan mengembalikan Promise/null ke runtime), dan halaman situs tetap tersaji. Tanpa jaringan:
// DATABASE_URL dikosongkan sehingga sesi fail-open dan tidak ada koneksi Neon.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const saved = { url: process.env.DATABASE_URL, enc: process.env.ENCRYPTION_KEY };
delete process.env.DATABASE_URL;
delete process.env.ENCRYPTION_KEY;

const mod = await import('./netlify/functions/bridge.mjs');
const handler = mod.default;

process.on('exit', () => {
  if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url;
  if (saved.enc === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = saved.enc;
});

const get = (path, init = {}) => new Request(`https://web.test${path}`, { method: 'GET', ...init });

test('fungsi Netlify: path tak dikenal → 404, bukan Promise/null', async () => {
  const r = await handler(get('/tidak-ada'));
  assert.ok(r instanceof Response, 'selalu mengembalikan Response');
  assert.equal(r.status, 404);
  assert.match(await r.text(), /Tidak ditemukan/);
});

test('fungsi Netlify: portal / tersaji, /chat tanpa sesi dialihkan ke /auth/login', async () => {
  const home = await handler(get('/'));
  assert.equal(home.status, 200);
  assert.match(await home.text(), /href="\/chat"/);

  const chat = await handler(get('/chat'));
  assert.equal(chat.status, 302, '/chat tanpa sesi dialihkan (fail-open tanpa DATABASE_URL)');
  assert.equal(chat.headers.get('location'), '/auth/login');

  const login = await handler(get('/auth/login'));
  assert.equal(login.status, 200);
  assert.match(await login.text(), /data-action="login"/);
});

test('fungsi Netlify: POST ke path situs tak dikenal tetap 404', async () => {
  const r = await handler(new Request('https://web.test/tidak-ada', { method: 'POST' }));
  assert.equal(r.status, 404);
});