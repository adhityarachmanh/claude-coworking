// bridge/providers.test.mjs — katalog provider/model, pemetaan Effort, enkripsi API key, dan rute provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cheapestModelFor, cleanBaseUrl, defaultModelFor, EFFORT_LEVELS, effortParams, isValidKind,
  modelForTier, modelSupportsEffort, modelsFor, TIERS,
} from './src/providers.mjs';
import { decryptSecret, encryptSecret, keyHint, publicProvider } from './src/secrets.mjs';
import { testProviderKey } from './src/client.mjs';
import { handleChatApi } from './src/chat-api.mjs';
import { makeMemoryRepo } from './src/repo-memory.mjs';

const KEY = 'ab'.repeat(32);
const makeStore = () => {
  const map = new Map();
  return { map, get: async (k) => (map.has(k) ? map.get(k) : null), set: async (k, v) => { map.set(k, String(v)); }, delete: async (k) => { map.delete(k); }, list: async ({ prefix }) => ({ blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }) };
};
const makeEnv = () => ({ repo: makeMemoryRepo(), store: makeStore(), encryptionKey: KEY });
const req = (path, init = {}, origin = 'https://web.test') => new Request(`https://web.test${path}`, { ...init, headers: { Origin: origin, ...(init.headers ?? {}) } });
const jsonReq = (path, body, headers = {}) => req(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const send = (env, request, fetchImpl) => handleChatApi(request, env, new URL(request.url).pathname, fetchImpl);
const body = async (r) => JSON.parse(await r.text());

/** Akun masuk + cookie. */
async function signedIn(env) {
  const r = await send(env, jsonReq('/chat/api/auth/signup', { email: 'a@b.co', password: 'rahasia123' }));
  const setCookie = r.headers.get('set-cookie');
  const token = /adhitron_session=([0-9a-f]{64})/.exec(setCookie)?.[1];
  return { cookie: `adhitron_session=${token}` };
}

// ---------------------------------------------------------------- katalog & effort (murni)

test('katalog: tiap kind punya model, default & termurah ada; isValidKind benar', () => {
  for (const kind of ['openai', 'anthropic', 'google']) {
    assert.ok(modelsFor(kind).length >= 3, kind);
    assert.ok(defaultModelFor(kind));
    assert.ok(cheapestModelFor(kind));
    assert.equal(isValidKind(kind), true);
  }
  assert.equal(isValidKind('mars'), false);
});

test('effort: hanya model ber-effort menerima parameter; pemetaan per provider benar', () => {
  assert.deepEqual(effortParams('openai', 'gpt-4.1', 'high'), {}, 'model tanpa effort diabaikan');
  assert.deepEqual(effortParams('openai', 'gpt-5', 'default'), {}, 'default tidak mengirim apa-apa');
  assert.deepEqual(effortParams('openai', 'gpt-5', 'high'), { reasoning_effort: 'high' });
  assert.deepEqual(effortParams('openai', 'gpt-5', 'xhigh'), { reasoning_effort: 'high' });
  assert.deepEqual(effortParams('anthropic', 'claude-sonnet-4-5', 'medium'), { thinking: { type: 'enabled', budget_tokens: 8192 } });
  assert.deepEqual(effortParams('google', 'gemini-2.5-pro', 'low'), { thinkingConfig: { thinkingBudget: 0 } });
  assert.deepEqual(effortParams('google', 'gemini-2.5-pro', 'default'), {});
  assert.deepEqual(effortParams('openai', 'gpt-5', 'ngawur'), {}, 'level tak dikenal → default');
  assert.equal(modelSupportsEffort('anthropic', 'claude-haiku-4-5'), false);
  assert.deepEqual([...EFFORT_LEVELS], ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('tier: modelForTier memakai pilihan user bila valid, jika tidak memakai default tier', () => {
  assert.equal(modelForTier('openai', 'kuat', { kuat: 'gpt-4.1' }), 'gpt-4.1');
  assert.equal(modelForTier('openai', 'kuat', { kuat: 'tidak-ada' }), 'gpt-5', 'fallback ke model tier kuat');
  assert.equal(modelForTier('openai', 'hemat', null), 'gpt-5-nano');
  assert.deepEqual([...TIERS], ['hemat', 'sedang', 'kuat']);
});

test('base_url: https absolut saja, tanpa kredensial/query', () => {
  assert.deepEqual(cleanBaseUrl(''), { ok: true, value: null });
  assert.equal(cleanBaseUrl('http://x.test').ok, false);
  assert.equal(cleanBaseUrl('https://u:p@x.test').ok, false);
  assert.equal(cleanBaseUrl('https://x.test/?a=1').ok, false);
  assert.deepEqual(cleanBaseUrl('https://api.x.test/v1/'), { ok: true, value: 'https://api.x.test/v1' });
});

// ---------------------------------------------------------------- enkripsi

test('secrets: enkripsi-dekripsi simetris; kunci salah gagal; keyHint tidak membocorkan key', () => {
  const enc = encryptSecret(KEY, 'sk-rahasia-1234');
  assert.match(enc.ct, /^[0-9a-f]+$/);
  assert.equal(decryptSecret(KEY, enc), 'sk-rahasia-1234');
  assert.throws(() => decryptSecret('cd'.repeat(32), enc));
  assert.throws(() => decryptSecret(KEY, { ct: 'aa' }));
  assert.equal(keyHint('sk-rahasia-abcd'), 'abcd');
  const p = publicProvider({ id: '1', kind: 'openai', label: 'x', base_url: null, api_key_enc: enc, key_hint: 'abcd', created_at: 't' });
  assert.equal(JSON.stringify(p).includes('ct'), false, 'bentuk publik tidak memuat ciphertext');
});

// ---------------------------------------------------------------- rute provider

test('providers: tambah → daftar → ubah → hapus; key TIDAK pernah plaintext di repo', async () => {
  const env = makeEnv();
  const { cookie } = await signedIn(env);
  const add = await send(env, jsonReq('/chat/api/providers', { kind: 'openai', label: 'OpenAI saya', apiKey: 'sk-test-abcdefgh' }, { Cookie: cookie }));
  assert.equal(add.status, 201, JSON.stringify(await add.clone().json()));
  const { provider } = await body(add);
  assert.equal(provider.kind, 'openai');
  assert.equal(provider.keyHint, 'efgh');
  assert.equal(JSON.stringify(provider).includes('sk-test'), false);
  const stored = await env.repo.getProvider((await env.repo.getUserByEmail('a@b.co')).id, provider.id);
  assert.equal(JSON.stringify(stored).includes('sk-test-abcdefgh'), false, 'key tidak plaintext');
  assert.equal(decryptSecret(KEY, stored.api_key_enc), 'sk-test-abcdefgh');

  const list = await send(env, req('/chat/api/providers', { headers: { Cookie: cookie } }));
  assert.equal((await body(list)).providers.length, 1);

  const upd = await send(env, req(`/chat/api/providers/${provider.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ label: 'OpenAI baru' }) }));
  assert.equal(upd.status, 200);
  assert.equal((await body(upd)).provider.label, 'OpenAI baru');
  assert.equal(decryptSecret(KEY, (await env.repo.getProvider(stored.user_id, provider.id)).api_key_enc), 'sk-test-abcdefgh', 'key lama tetap saat tak diganti');

  const del = await send(env, req(`/chat/api/providers/${provider.id}`, { method: 'DELETE', headers: { Cookie: cookie } }));
  assert.equal(del.status, 200);
  assert.equal((await env.repo.listProviders(stored.user_id)).length, 0);
});

test('providers: validasi kind/key/baseUrl; tidak login 401; provider user lain 404', async () => {
  const env = makeEnv();
  const { cookie } = await signedIn(env);
  assert.equal((await send(env, jsonReq('/chat/api/providers', { kind: 'mars', apiKey: 'sk-abcdefgh' }, { Cookie: cookie }))).status, 400);
  assert.equal((await send(env, jsonReq('/chat/api/providers', { kind: 'openai', apiKey: 'x' }, { Cookie: cookie }))).status, 400);
  assert.equal((await send(env, jsonReq('/chat/api/providers', { kind: 'openai', apiKey: 'sk-abcdefgh', baseUrl: 'http://x' }, { Cookie: cookie }))).status, 400);
  assert.equal((await send(env, jsonReq('/chat/api/providers', { kind: 'openai', apiKey: 'sk-abcdefgh' }))).status, 401, 'tanpa cookie');
  // Provider milik user lain tak terlihat.
  const other = await env.repo.createUser({ email: 'z@z.co', passwordHash: 'scrypt$a$b' });
  const p = await env.repo.createProvider({ userId: other.id, kind: 'openai', label: 'x', apiKeyEnc: { v: 1 } });
  assert.equal((await send(env, req(`/chat/api/providers/${p.id}`, { method: 'DELETE', headers: { Cookie: cookie } }))).status, 404);
});

test('provider-kinds: mengembalikan katalog statis tanpa kredensial', async () => {
  const env = makeEnv();
  const r = await send(env, req('/chat/api/provider-kinds'));
  assert.equal(r.status, 200);
  const { kinds } = await body(r);
  assert.equal(kinds.length, 3);
  assert.ok(kinds[0].models.length >= 3);
  assert.equal(JSON.stringify(kinds).includes('apiKey'), false);
});

test('test provider: key ditolak (401) dijawab gagal, key benar dijawab ok', async () => {
  const env = makeEnv();
  const { cookie } = await signedIn(env);
  const add = await send(env, jsonReq('/chat/api/providers', { kind: 'openai', label: 'x', apiKey: 'sk-test-abcdefgh' }, { Cookie: cookie }));
  const { provider } = await body(add);
  const goodFetch = async (url, init) => ({ ok: init.headers.Authorization === 'Bearer sk-test-abcdefgh', status: 200 });
  const ok = await send(env, req(`/chat/api/providers/${provider.id}/test`, { method: 'POST', headers: { Cookie: cookie } }), goodFetch);
  assert.equal(ok.status, 200);
  assert.equal((await body(ok)).ok, true);
  const badFetch = async () => ({ ok: false, status: 401 });
  const bad = await send(env, req(`/chat/api/providers/${provider.id}/test`, { method: 'POST', headers: { Cookie: cookie } }), badFetch);
  assert.equal(bad.status, 400);
  assert.match((await body(bad)).error, /ditolak/);
});

test('client: testProviderKey mengirim header per provider & menangani timeout/gagal', async () => {
  const ok = async (url, init) => { assert.match(url, /models/); assert.ok(init.headers.Authorization || init.headers['x-api-key']); return { ok: true, status: 200 }; };
  assert.deepEqual(await testProviderKey({ kind: 'openai', base_url: null }, 'k', ok), { ok: true });
  assert.deepEqual(await testProviderKey({ kind: 'anthropic', base_url: null }, 'k', ok), { ok: true });
  const boom = async () => { throw new TypeError('fetch failed'); };
  assert.match((await testProviderKey({ kind: 'openai', base_url: null }, 'k', boom)).error, /hubungi/);
  const refused = async () => ({ ok: false, status: 403 });
  assert.match((await testProviderKey({ kind: 'google', base_url: null }, 'k', refused)).error, /ditolak/);
});