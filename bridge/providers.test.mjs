// bridge/providers.test.mjs — katalog provider/model, pemetaan Effort, enkripsi API key, dan rute provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cheapestModelFor, cleanBaseUrl, defaultModelFor, EFFORT_LEVELS, effortParams, isValidKind,
  modelForTier, modelSupportsEffort, modelsFor, TIERS,
} from './src/providers.mjs';
import { decryptSecret, encryptSecret, keyHint, publicProvider } from './src/secrets.mjs';
import { testProviderKey, probeModels, normalizeModels } from './src/client.mjs';
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

test('base_url: menolak host lokal/privat (anti-SSRF)', () => {
  for (const bad of [
    'https://localhost/v1', 'https://localhost:8080', 'https://foo.localhost',
    'https://127.0.0.1', 'https://127.1', 'https://0x7f.0.0.1', 'https://[::1]',
    'https://10.0.0.5', 'https://192.168.1.10', 'https://172.16.0.1',
    'https://169.254.169.254/latest/meta-data', 'https://metadata.google.internal',
    'https://api.internal', 'https://db.local', 'https://100.64.0.1',
  ]) {
    assert.equal(cleanBaseUrl(bad).ok, false, `${bad} seharusnya ditolak`);
  }
  // Host publik tetap lolos.
  assert.deepEqual(cleanBaseUrl('https://api.openai.com/v1/'), { ok: true, value: 'https://api.openai.com/v1' });
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

test('normalizeModels: menormalkan bentuk OpenAI, Anthropic, & Gemini', () => {
  assert.deepEqual(
    normalizeModels('openai', { data: [{ id: 'gpt-5' }, { id: 'o4-mini', display_name: 'o4 mini' }, { id: 'gpt-5' }] }),
    [{ id: 'gpt-5', label: 'gpt-5' }, { id: 'o4-mini', label: 'o4 mini' }],
    'OpenAI: id saja, urut, tanpa duplikat',
  );
  assert.deepEqual(
    normalizeModels('anthropic', { data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] }),
    [{ id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }],
  );
  assert.deepEqual(
    normalizeModels('google', { models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }] }),
    [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' }],
    'Gemini: awalan models/ dibuang',
  );
  assert.deepEqual(normalizeModels('openai', null), [], 'payload rusak → daftar kosong, tidak melempar');
});

test('normalizeModels: model non-chat (embedding/gambar/tts) dibuang', () => {
  const got = normalizeModels('openai', { data: [
    { id: 'gpt-5' }, { id: 'text-embedding-3-small' }, { id: 'tts-1' }, { id: 'whisper-1' },
    { id: 'dall-e-3' }, { id: 'gpt-image-1' }, { id: 'gpt-4o-mini-tts' }, { id: 'gpt-4.1-mini' },
  ] });
  assert.deepEqual(got.map((m) => m.id), ['gpt-5', 'gpt-4.1-mini']);
});

test('probeModels: ambil daftar model sekaligus membuktikan key; error diteruskan', async () => {
  const fake = (j) => async () => ({ ok: true, status: 200, json: async () => j });
  const openai = await probeModels({ kind: 'openai', base_url: null }, 'k', fake({ data: [{ id: 'gpt-5' }] }));
  assert.deepEqual(openai, { ok: true, models: [{ id: 'gpt-5', label: 'gpt-5' }] });
  const denied = async () => ({ ok: false, status: 401 });
  assert.match((await probeModels({ kind: 'openai', base_url: null }, 'k', denied)).error, /ditolak/);
});

test('rute /providers/models: cek key calon provider (belum disimpan), tanpa login 401 & tanpa same-origin 403', async () => {
  const env = makeEnv();
  const { cookie } = await signedIn(env);
  assert.equal((await send(env, jsonReq('/chat/api/providers/models', { kind: 'openai', apiKey: 'sk-abcdefgh' }))).status, 401, 'tanpa login');
  assert.equal((await send(env, jsonReq('/chat/api/providers/models', { kind: 'openai', apiKey: 'sk-abcdefgh' }, { Cookie: cookie, Origin: 'https://jahat.test' }))).status, 403, 'bukan same-origin');
  assert.equal((await send(env, jsonReq('/chat/api/providers/models', { kind: 'mars', apiKey: 'sk-abcdefgh' }, { Cookie: cookie }))).status, 400, 'kind tak dikenal');
  const fake = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] }) });
  const r = await send(env, jsonReq('/chat/api/providers/models', { kind: 'openai', apiKey: 'sk-abcdefgh' }, { Cookie: cookie }), fake);
  assert.equal(r.status, 200);
  const data = await body(r);
  assert.deepEqual(data.models.map((m) => m.id), ['gpt-5', 'gpt-5-mini']);
  assert.equal(JSON.stringify(data).includes('abcdefgh'), false, 'key tidak dikembalikan');
});

test('provider menyimpan daftar model terpilih dan terbaca kembali', async () => {
  const env = makeEnv();
  const { cookie } = await signedIn(env);
  const add = await send(env, jsonReq('/chat/api/providers', {
    kind: 'openai', label: 'x', apiKey: 'sk-test-abcdefgh',
    models: [{ id: 'gpt-5', label: 'GPT-5' }, { id: 'o4-mini', label: 'o4-mini' }, { id: 'gpt-5', label: 'dupe' }, { id: '' }],
  }, { Cookie: cookie }));
  assert.equal(add.status, 201);
  const { provider } = await body(add);
  assert.deepEqual(provider.models, [{ id: 'gpt-5', label: 'GPT-5' }, { id: 'o4-mini', label: 'o4-mini' }], 'bersih: unik, id wajib');
  const list = await body(await send(env, req('/chat/api/providers', { headers: { Cookie: cookie } })));
  assert.deepEqual(list.providers[0].models.map((m) => m.id), ['gpt-5', 'o4-mini']);
});

test('uji provider menyimpan daftar model hasil probe', async () => {
  const env = makeEnv();
  const { cookie } = await signedIn(env);
  const add = await body(await send(env, jsonReq('/chat/api/providers', { kind: 'openai', label: 'x', apiKey: 'sk-test-abcdefgh' }, { Cookie: cookie })));
  const fake = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-5' }, { id: 'text-embedding-3-small' }] }) });
  const r = await send(env, req(`/chat/api/providers/${add.provider.id}/test`, { method: 'POST', headers: { Cookie: cookie } }), fake);
  assert.equal(r.status, 200);
  const data = await body(r);
  assert.deepEqual(data.models, [{ id: 'gpt-5', label: 'gpt-5' }], 'model non-chat dibuang sebelum disimpan/dikembalikan');
  assert.deepEqual(data.provider.models.map((m) => m.id), ['gpt-5']);
  const stored = await env.repo.getProvider((await env.repo.getUserByEmail('a@b.co')).id, add.provider.id);
  assert.deepEqual(stored.models.map((m) => m.id), ['gpt-5']);
});