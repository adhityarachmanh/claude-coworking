// bridge/auth.test.mjs — autentikasi Adhitron Web: hashing password, sesi/cookie, dan rute
// signup/login/logout/me (termasuk anti-CSRF + rate-limit). Memakai repo in-memory & driver Blobs palsu.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearedSessionCookie, hashPassword, isSameOrigin, parseCookies, sessionCookie, sessionTokenHash, verifyPassword,
} from './src/auth.mjs';
import { handleChatApi } from './src/chat-api.mjs';
import { makeMemoryRepo } from './src/repo-memory.mjs';

/** Driver Blobs palsu (bentuk sama seperti test jembatan) untuk rate-limit. */
const makeStore = () => {
  const map = new Map();
  return {
    map,
    get: async (k) => (map.has(k) ? map.get(k) : null),
    set: async (k, v) => { map.set(k, String(v)); },
    delete: async (k) => { map.delete(k); },
    list: async ({ prefix }) => ({ blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
  };
};

const makeEnv = () => ({ repo: makeMemoryRepo(), store: makeStore() });

const req = (path, init = {}, origin = 'https://web.test') => {
  const headers = { Origin: origin, ...(init.headers ?? {}) };
  return new Request(`https://web.test${path}`, { ...init, headers });
};
const jsonReq = (path, body, headers = {}) =>
  req(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const send = (env, request) => handleChatApi(request, env, new URL(request.url).pathname);
const body = async (r) => JSON.parse(await r.text());
const cookieOf = (r) => parseCookies(r.headers.get('set-cookie')).get('adhitron_session');

// ---------------------------------------------------------------- murni

test('password: hash scrypt + salt acak, verifikasi benar/salah, tahan input aneh', () => {
  const h = hashPassword('rahasia123');
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.notEqual(h, hashPassword('rahasia123'), 'salt berbeda tiap hash');
  assert.equal(verifyPassword('rahasia123', h), true);
  assert.equal(verifyPassword('rahasia124', h), false);
  assert.equal(verifyPassword('', h), false);
  assert.equal(verifyPassword('rahasia123', 'bukan-hash'), false);
  assert.equal(verifyPassword('rahasia123', 'scrypt$$'), false);
  assert.throws(() => hashPassword('pendek'), /minimal 8/);
});

test('cookie: httpOnly + Secure + SameSite=Lax + Path=/; hapus saat logout', () => {
  const c = sessionCookie('abc');
  assert.match(c, /^adhitron_session=abc; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+/);
  assert.match(clearedSessionCookie(), /Max-Age=0/);
  const parsed = parseCookies('a=1; adhitron_session="tok"; b=2');
  assert.equal(parsed.get('adhitron_session'), 'tok', 'kutip ganda dilepas');
});

test('anti-CSRF: Origin beda host / tidak ada → ditolak', () => {
  assert.equal(isSameOrigin(req('/chat/api/me')), true);
  assert.equal(isSameOrigin(req('/chat/api/me', {}, 'https://evil.test')), false);
  assert.equal(isSameOrigin(new Request('https://web.test/x', { method: 'POST' })), false, 'tanpa Origin → false');
});

// ---------------------------------------------------------------- rute

test('signup: membuat akun + cookie sesi, password TIDAK plaintext di repo', async () => {
  const env = makeEnv();
  const r = await send(env, jsonReq('/chat/api/auth/signup', { email: 'Adhit@Example.com', password: 'rahasia123' }));
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  const { user } = await body(r);
  assert.equal(user.email, 'adhit@example.com', 'email dinormalisasi');
  assert.equal(user.password_hash, undefined, 'hash tidak pernah dikirim');
  assert.ok(cookieOf(r), 'cookie sesi dikirim');
  const stored = await env.repo.getUserByEmail('adhit@example.com');
  assert.notEqual(stored.password_hash, 'rahasia123', 'password tidak plaintext');
  assert.match(stored.password_hash, /^scrypt\$/);
});

test('signup: validasi email & password; email duplikat 409', async () => {
  const env = makeEnv();
  assert.equal((await send(env, jsonReq('/chat/api/auth/signup', { email: 'x', password: 'rahasia123' }))).status, 400);
  assert.equal((await send(env, jsonReq('/chat/api/auth/signup', { email: 'a@b.co', password: 'pendek' }))).status, 400);
  assert.equal((await send(env, jsonReq('/chat/api/auth/signup', { email: 'a@b.co', password: 'rahasia123' }))).status, 201);
  assert.equal((await send(env, jsonReq('/chat/api/auth/signup', { email: 'A@B.co', password: 'rahasia123' }))).status, 409);
});

test('login: benar → cookie; salah → 401 dengan pesan seragam', async () => {
  const env = makeEnv();
  await send(env, jsonReq('/chat/api/auth/signup', { email: 'a@b.co', password: 'rahasia123' }));
  const ok = await send(env, jsonReq('/chat/api/auth/login', { email: 'a@b.co', password: 'rahasia123' }));
  assert.equal(ok.status, 200);
  const token = cookieOf(ok);
  assert.match(token, /^[0-9a-f]{64}$/);
  // DB hanya menyimpan hash token, bukan token siap-pakai.
  assert.ok(await env.repo.getSession(sessionTokenHash(token)));
  assert.equal(await env.repo.getSession(token), null, 'token mentah tidak tersimpan sebagai key');
  const bad = await send(env, jsonReq('/chat/api/auth/login', { email: 'a@b.co', password: 'salah-sekali' }));
  assert.equal(bad.status, 401);
  assert.equal((await body(bad)).error, 'Email atau password salah');
  // Email tak terdaftar → pesan yang sama (tidak membocorkan).
  const missing = await send(env, jsonReq('/chat/api/auth/login', { email: 'x@y.co', password: 'rahasia123' }));
  assert.equal(missing.status, 401);
});

test('me: tanpa cookie 401; dengan cookie mengembalikan user; sesi kedaluwarsa ditolak', async () => {
  const env = makeEnv();
  assert.equal((await send(env, req('/chat/api/me'))).status, 401);
  const signup = await send(env, jsonReq('/chat/api/auth/signup', { email: 'a@b.co', password: 'rahasia123' }));
  const cookie = `adhitron_session=${cookieOf(signup)}`;
  const me = await send(env, req('/chat/api/me', { headers: { Cookie: cookie } }));
  assert.equal(me.status, 200);
  assert.equal((await body(me)).user.email, 'a@b.co');
  // Paksa kedaluwarsa: sesi tidak berlaku lagi dan dibersihkan.
  const user = await env.repo.getUserByEmail('a@b.co');
  const hash = sessionTokenHash(cookieOf(signup));
  await env.repo.deleteSession(hash);
  assert.equal((await send(env, req('/chat/api/me', { headers: { Cookie: cookie } }))).status, 401);
  assert.ok(await env.repo.getUserById(user.id), 'user tetap ada');
});

test('logout: menghapus sesi + cookie kosong', async () => {
  const env = makeEnv();
  const signup = await send(env, jsonReq('/chat/api/auth/signup', { email: 'a@b.co', password: 'rahasia123' }));
  const cookie = `adhitron_session=${cookieOf(signup)}`;
  const out = await send(env, req('/chat/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } }));
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(await env.repo.getSession(sessionTokenHash(cookieOf(signup))), null);
  assert.equal((await send(env, req('/chat/api/me', { headers: { Cookie: cookie } }))).status, 401);
});

test('CSRF: signup/login/logout lintas-origin 403 dan tidak membuat sesi', async () => {
  const env = makeEnv();
  const r = await send(env, req('/chat/api/auth/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', password: 'rahasia123' }),
  }, 'https://evil.test'));
  assert.equal(r.status, 403);
  assert.equal(await env.repo.getUserByEmail('a@b.co'), null, 'tidak ada akun dibuat');
});

test('rate-limit: percobaan login per jam melebihi batas → 429', async () => {
  const env = makeEnv();
  await send(env, jsonReq('/chat/api/auth/signup', { email: 'a@b.co', password: 'rahasia123' }));
  let last = 0;
  for (let i = 0; i < 51; i++) {
    last = (await send(env, jsonReq('/chat/api/auth/login', { email: 'a@b.co', password: 'salah-sekali' }))).status;
  }
  assert.equal(last, 429, 'ke-51 ditolak');
});

test('rute tak dikenal → null (bukan 404 diam-diam); metode salah → 405', async () => {
  const env = makeEnv();
  assert.equal(await send(env, req('/chat/api/percakapan')), null);
  const wrongMethod = await send(env, req('/chat/api/auth/login'));
  assert.equal(wrongMethod.status, 405);
});

test('hapus akun: DELETE /me menyapu seluruh data user + cookie kosong', async () => {
  const env = makeEnv();
  const signup = await send(env, jsonReq('/chat/api/auth/signup', { email: 'a@b.co', password: 'rahasia123' }));
  const cookie = `adhitron_session=${cookieOf(signup)}`;
  const user = await env.repo.getUserByEmail('a@b.co');
  const conv = await env.repo.createConversation(user.id, { title: 'x' });
  await env.repo.addMessage(user.id, conv.id, { role: 'user', content: 'hai' });
  await env.repo.createProvider({ userId: user.id, kind: 'openai', label: 'p', apiKeyEnc: { v: 1 } });

  const del = await send(env, req('/chat/api/me', { method: 'DELETE', headers: { Cookie: cookie } }));
  assert.equal(del.status, 200);
  assert.match(del.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(await env.repo.getUserByEmail('a@b.co'), null, 'user hilang');
  assert.equal((await env.repo.listConversations(user.id)).length, 0, 'percakapan hilang');
  assert.equal((await env.repo.listProviders(user.id)).length, 0, 'provider hilang');
  assert.equal((await send(env, req('/chat/api/me', { headers: { Cookie: cookie } }))).status, 401, 'sesi mati');
});

test('hapus akun: tanpa login 401, lintas-origin 403', async () => {
  const env = makeEnv();
  assert.equal((await send(env, req('/chat/api/me', { method: 'DELETE' }))).status, 401);
  const signup = await send(env, jsonReq('/chat/api/auth/signup', { email: 'a@b.co', password: 'rahasia123' }));
  const cookie = `adhitron_session=${cookieOf(signup)}`;
  const r = await send(env, req('/chat/api/me', { method: 'DELETE', headers: { Cookie: cookie } }, 'https://evil.test'));
  assert.equal(r.status, 403);
  assert.ok(await env.repo.getUserByEmail('a@b.co'), 'akun tetap ada');
});