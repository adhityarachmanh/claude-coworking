// bridge/chat.test.mjs — inti chat Adhitron Web: penyusunan permintaan provider, parser aliran,
// classifier Auto(LLM), dan giliran chat lewat rute /chat/api/conversations/:id/messages (SSE).
// Semua tanpa jaringan: `fetchImpl` palsu yang mengembalikan aliran SSE.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRequest, blocksToContent, parseStream, messageProblem, allowedModels, MAX_MESSAGE_CHARS } from './src/chat.mjs';
import { classify, parseClassifierOutput, classifierModel, CLASSIFIER_PROMPT } from './src/auto.mjs';
import { encryptSecret } from './src/secrets.mjs';
import { handleChatApi } from './src/chat-api.mjs';
import { makeMemoryRepo } from './src/repo-memory.mjs';

const KEY = 'ab'.repeat(32);
const makeStore = () => {
  const map = new Map();
  return { map, get: async (k) => (map.has(k) ? map.get(k) : null), set: async (k, v) => { map.set(k, String(v)); }, delete: async (k) => { map.delete(k); }, list: async ({ prefix }) => ({ blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }) };
};
const makeEnv = (extra = {}) => ({ repo: makeMemoryRepo(), store: makeStore(), encryptionKey: KEY, ...extra });

/** Aliran SSE palsu: array potongan string → Response dengan body aliran. */
function sseResponse(chunks, status = 200) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) { for (const c of chunks) controller.enqueue(enc.encode(c)); controller.close(); },
  });
  return { ok: status >= 200 && status < 300, status, body, headers: new Headers({ 'content-type': 'text/event-stream' }) };
}

const req = (path, init = {}, origin = 'https://web.test') => new Request(`https://web.test${path}`, { ...init, headers: { Origin: origin, ...(init.headers ?? {}) } });
const jsonReq = (path, body, headers = {}) => req(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const send = (env, request, fetchImpl) => handleChatApi(request, env, new URL(request.url).pathname, fetchImpl);
const body = async (r) => JSON.parse(await r.text());

async function readSse(res) {
  const text = await res.text();
  return text.split('\n\n').filter((b) => b.startsWith('data:')).map((b) => JSON.parse(b.slice(5).trim()));
}

/** Akun masuk + cookie, lalu buat provider tersimpan (key terenkripsi). */
async function setup(env, kind = 'openai') {
  const r = await send(env, jsonReq('/chat/api/auth/signup', { email: 'a@b.co', password: 'rahasia123', consent: true }));
  const token = /adhitron_session=([0-9a-f]{64})/.exec(r.headers.get('set-cookie'))[1];
  const cookie = `adhitron_session=${token}`;
  const user = await env.repo.getUserByEmail('a@b.co');
  const provider = await env.repo.createProvider({ userId: user.id, kind, label: 'P', apiKeyEnc: encryptSecret(KEY, 'sk-secret'), keyHint: 'cret' });
  return { cookie, user, provider };
}

// ---------------------------------------------------------------- buildRequest

test('buildRequest: OpenAI menyusun body chat/completions dengan effort & tools', () => {
  const { url, headers, body } = buildRequest({ kind: 'openai', base_url: null }, 'k', {
    model: 'gpt-5', effort: 'high', system: 'S', messages: [{ role: 'user', content: 'hai' }], tools: [{ function: { name: 't', description: 'd', parameters: {} } }],
  });
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(headers.Authorization, 'Bearer k');
  assert.equal(body.stream, true);
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.tools.length, 1);
});

test('buildRequest: Anthropic memakai system terpisah + thinking; Google memakai streamGenerateContent', () => {
  const a = buildRequest({ kind: 'anthropic', base_url: null }, 'k', { model: 'claude-sonnet-4-5', effort: 'medium', system: 'S', messages: [{ role: 'user', content: 'hai' }] });
  assert.equal(a.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(a.headers['x-api-key'], 'k');
  assert.equal(a.body.system, 'S');
  assert.equal(a.body.thinking.budget_tokens, 8192);
  assert.equal(a.body.messages[0].role, 'user');

  const g = buildRequest({ kind: 'google', base_url: null }, 'k', { model: 'gemini-2.5-pro', effort: 'high', messages: [{ role: 'assistant', content: 'x' }] });
  assert.match(g.url, /models\/gemini-2\.5-pro:streamGenerateContent/);
  assert.equal(g.body.contents[0].role, 'model');
  assert.equal(g.body.generationConfig.thinkingConfig.thinkingBudget, 16384);
});

test('buildRequest: base_url kustom menang; kind tak dikenal melempar', () => {
  const { url } = buildRequest({ kind: 'openai', base_url: 'https://gw.test/v1' }, 'k', { model: 'm', messages: [] });
  assert.equal(url, 'https://gw.test/v1/chat/completions');
  assert.throws(() => buildRequest({ kind: 'mars' }, 'k', { model: 'm', messages: [] }));
});

test('messageProblem & allowedModels', () => {
  assert.equal(messageProblem('hai'), null);
  assert.match(messageProblem('   '), /kosong/);
  assert.match(messageProblem('x'.repeat(MAX_MESSAGE_CHARS + 1)), /panjang/);
  assert.deepEqual(allowedModels('openai'), ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini']);
});

test('messageProblem: pesan kosong boleh bila ada lampiran; tetap tolak bila panjang', () => {
  assert.equal(messageProblem('', true), null);
  assert.equal(messageProblem('   ', true), null);
  assert.match(messageProblem('x'.repeat(MAX_MESSAGE_CHARS + 1), true), /panjang/);
});

// ---------------------------------------------------------------- blok konten (lampiran)

test('blocksToContent: teks & gambar diterjemahkan per provider', () => {
  const blocks = [
    { type: 'text', text: 'hai' },
    { type: 'image', mediaType: 'image/png', data: 'ABC' },
  ];
  assert.deepEqual(blocksToContent('openai', blocks), [
    { type: 'text', text: 'hai' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,ABC' } },
  ]);
  assert.deepEqual(blocksToContent('anthropic', blocks), [
    { type: 'text', text: 'hai' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ABC' } },
  ]);
  assert.deepEqual(blocksToContent('google', blocks), [
    { text: 'hai' },
    { inlineData: { mimeType: 'image/png', data: 'ABC' } },
  ]);
  assert.throws(() => blocksToContent('mars', blocks));
});

test('buildRequest: messages dengan array blok per provider; string tetap string', () => {
  const blocks = [
    { type: 'text', text: 'lihat ini' },
    { type: 'image', mediaType: 'image/jpeg', data: 'ZZZ' },
  ];
  const o = buildRequest({ kind: 'openai', base_url: null }, 'k', { model: 'gpt-5', messages: [{ role: 'user', content: blocks }] });
  assert.deepEqual(o.body.messages[0].content, blocksToContent('openai', blocks));
  const a = buildRequest({ kind: 'anthropic', base_url: null }, 'k', { model: 'm', messages: [{ role: 'user', content: blocks }] });
  assert.deepEqual(a.body.messages[0].content, blocksToContent('anthropic', blocks));
  const g = buildRequest({ kind: 'google', base_url: null }, 'k', { model: 'm', messages: [{ role: 'user', content: blocks }] });
  assert.deepEqual(g.body.contents[0].parts, blocksToContent('google', blocks));
  // Regresi: content string tetap berupa string (bukan array), sama seperti sebelumnya.
  const s = buildRequest({ kind: 'openai', base_url: null }, 'k', { model: 'm', messages: [{ role: 'user', content: 'halo' }] });
  assert.equal(s.body.messages[0].content, 'halo');
  const sg = buildRequest({ kind: 'google', base_url: null }, 'k', { model: 'm', messages: [{ role: 'user', content: 'halo' }] });
  assert.deepEqual(sg.body.contents[0].parts, [{ text: 'halo' }]);
});

// ---------------------------------------------------------------- parseStream

test('parseStream openai: teks bertahap + tool_calls dari delta', () => {
  const push = parseStream('openai');
  const ev1 = push('data: {"choices":[{"delta":{"content":"Ha"}}]}\n\ndata: {"choices":[{"delta":{"content":"i"}}]}\n\n');
  assert.deepEqual(ev1, [{ type: 'text', text: 'Ha' }, { type: 'text', text: 'i' }]);
  const ev2 = push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"web","arguments":"{\\"q\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  assert.deepEqual(ev2, [{ type: 'tool', name: 'web', input: { q: 'x' } }]);
});

test('parseStream menangani potongan yang terbelah antar-chunk', () => {
  const push = parseStream('openai');
  assert.deepEqual(push('data: {"choices":[{"delta":{"cont'), []);
  assert.deepEqual(push('ent":"Halo"}}]}\n\n'), [{ type: 'text', text: 'Halo' }]);
});

test('parseStream anthropic: text_delta & tool_use dari input_json_delta', () => {
  const push = parseStream('anthropic');
  const ev = push(
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"fetch_url"}}\n\n' +
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"url\\":\\"u\\"}"}}\n\n' +
    'data: {"type":"content_block_stop","index":0}\n\n',
  );
  assert.deepEqual(ev, [{ type: 'text', text: 'hi' }, { type: 'tool', name: 'fetch_url', input: { url: 'u' } }]);
});

test('parseStream google: parts[].text & functionCall', () => {
  const push = parseStream('google');
  const ev = push('data: {"candidates":[{"content":{"parts":[{"text":"Ha"},{"functionCall":{"name":"f","args":{"a":1}}}]}}]}\n\n');
  assert.deepEqual(ev, [{ type: 'text', text: 'Ha' }, { type: 'tool', name: 'f', input: { a: 1 } }]);
});

// ---------------------------------------------------------------- classifier Auto

test('parseClassifierOutput: tahan pagar ```json dan teks pembungkus; menolak nilai ngawur', () => {
  assert.deepEqual(parseClassifierOutput('```json\n{"effort":"high","tier":"kuat"}\n```'), { effort: 'high', tier: 'kuat' });
  assert.deepEqual(parseClassifierOutput('Berikut: {"effort":"low","tier":"hemat"} selesai'), { effort: 'low', tier: 'hemat' });
  assert.deepEqual(parseClassifierOutput('{"effort":"ngawur","tier":"kuat"}'), { effort: null, tier: 'kuat' });
  assert.equal(parseClassifierOutput('bukan json'), null);
});

test('classify: memakai model termurah, mengembalikan effort+tier; gagal → null (tidak memblokir)', async () => {
  assert.equal(classifierModel('openai'), 'gpt-5-nano');
  const seen = {};
  const verdict = await classify({
    kind: 'openai', prompt: 'halo',
    callModel: async ({ model, system }) => { seen.model = model; seen.system = system; return '{"effort":"xhigh","tier":"kuat"}'; },
  });
  assert.equal(seen.model, 'gpt-5-nano');
  assert.equal(seen.system, CLASSIFIER_PROMPT);
  assert.deepEqual({ effort: verdict.effort, tier: verdict.tier, model: verdict.model }, { effort: 'xhigh', tier: 'kuat', model: 'gpt-5-nano' });
  assert.equal(await classify({ kind: 'openai', prompt: 'x', callModel: async () => { throw new Error('gagal'); } }), null);
  assert.equal(await classify({ kind: 'openai', prompt: 'x', callModel: async () => 'bukan json' }), null);
});

// ---------------------------------------------------------------- giliran chat (SSE)

test('giliran: menyimpan pesan user, mengalirkan teks, dan menyimpan jawaban asisten', async () => {
  const env = makeEnv();
  const { cookie, user, provider } = await setup(env);
  const create = await send(env, jsonReq('/chat/api/conversations', { providerId: provider.id, model: 'gpt-5', effort: 'medium' }, { Cookie: cookie }));
  const { conversation } = await body(create);

  const fetchImpl = async (url, init) => {
    assert.match(url, /chat\/completions/);
    assert.equal(init.headers.Authorization, 'Bearer sk-secret');
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"Halo"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" dunia"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ]);
  };
  const res = await send(env, jsonReq(`/chat/api/conversations/${conversation.id}/messages`, { text: 'Hai' }, { Cookie: cookie }), fetchImpl);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = await readSse(res);
  assert.deepEqual(events[0], { type: 'meta', model: 'gpt-5', effort: 'medium' });
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Halo dunia');
  assert.equal(events.at(-1).type, 'done');

  const msgs = await env.repo.listMessages(user.id, conversation.id);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
  assert.equal(msgs[1].content, 'Halo dunia');
  assert.equal(msgs[1].meta.model, 'gpt-5');
  // Judul percakapan ikut berubah dari pesan pertama.
  assert.equal((await env.repo.getConversation(user.id, conversation.id)).title, 'Hai');
});

test('giliran: error provider mengalirkan event error dan menyimpan pesan parsial', async () => {
  const env = makeEnv();
  const { cookie, user, provider } = await setup(env);
  const create = await send(env, jsonReq('/chat/api/conversations', { providerId: provider.id, model: 'gpt-5' }, { Cookie: cookie }));
  const { conversation } = await body(create);
  // Provider mulai mengalir lalu putus di tengah (bukan HTTP error): teks parsial tetap disimpan.
  const fetchImpl = async () => {
    const enc = new TextEncoder();
    let step = 0;
    return {
      ok: true, status: 200, headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            step += 1;
            if (step === 1) return { value: enc.encode('data: {"choices":[{"delta":{"content":"setengah"}}]}\n\n'), done: false };
            throw new Error('koneksi putus');
          },
        }),
      },
    };
  };
  const res = await send(env, jsonReq(`/chat/api/conversations/${conversation.id}/messages`, { text: 'x' }, { Cookie: cookie }), fetchImpl);
  const events = await readSse(res);
  assert.equal(events.at(-1).type, 'error');
  const msgs = await env.repo.listMessages(user.id, conversation.id);
  assert.equal(msgs.at(-1).role, 'assistant');
  assert.equal(msgs.at(-1).content, 'setengah');
  assert.equal(msgs.at(-1).meta.incomplete, true);
});

test('giliran: Auto(LLM) memilih effort & model dari classifier', async () => {
  const env = makeEnv({ callModel: async () => '{"effort":"high","tier":"kuat"}' });
  const { cookie, provider } = await setup(env);
  const create = await send(env, jsonReq('/chat/api/conversations', { providerId: provider.id, effortAuto: true, modelAuto: true }, { Cookie: cookie }));
  const { conversation } = await body(create);
  const fetchImpl = async () => sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
  const res = await send(env, jsonReq(`/chat/api/conversations/${conversation.id}/messages`, { text: 'jelaskan kuantum' }, { Cookie: cookie }), fetchImpl);
  const events = await readSse(res);
  assert.deepEqual(events[0], { type: 'meta', model: 'gpt-5', effort: 'high' });
});

test('giliran: tanpa provider → 400; pesan kosong → 400; bukan milik user → 404', async () => {
  const env = makeEnv();
  const { cookie, provider } = await setup(env);
  const noProv = await send(env, jsonReq('/chat/api/conversations', {}, { Cookie: cookie }));
  const c1 = (await body(noProv)).conversation;
  assert.equal((await send(env, jsonReq(`/chat/api/conversations/${c1.id}/messages`, { text: 'hai' }, { Cookie: cookie }))).status, 400);
  const create = await send(env, jsonReq('/chat/api/conversations', { providerId: provider.id }, { Cookie: cookie }));
  const c2 = (await body(create)).conversation;
  assert.equal((await send(env, jsonReq(`/chat/api/conversations/${c2.id}/messages`, { text: '   ' }, { Cookie: cookie }))).status, 400);
  assert.equal((await send(env, jsonReq('/chat/api/conversations/tak-ada/messages', { text: 'hai' }, { Cookie: cookie }))).status, 404);
});

// ---------------------------------------------------------------- rute percakapan

test('percakapan: buat → daftar → muat (dengan pesan) → ubah → hapus; ter-scope user', async () => {
  const env = makeEnv();
  const { cookie, user, provider } = await setup(env);
  const create = await send(env, jsonReq('/chat/api/conversations', { providerId: provider.id, model: 'gpt-5', browsing: true }, { Cookie: cookie }));
  const { conversation } = await body(create);
  assert.equal(conversation.browsing, true);

  await env.repo.addMessage(user.id, conversation.id, { role: 'user', content: 'halo' });
  const get = await send(env, req(`/chat/api/conversations/${conversation.id}`, { headers: { Cookie: cookie } }));
  const loaded = await body(get);
  assert.equal(loaded.messages.length, 1);
  assert.deepEqual(loaded.citations, []);

  const upd = await send(env, req(`/chat/api/conversations/${conversation.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ title: 'Baru', effort: 'max' }) }));
  assert.equal((await body(upd)).conversation.title, 'Baru');

  const list = await send(env, req('/chat/api/conversations', { headers: { Cookie: cookie } }));
  assert.equal((await body(list)).conversations.length, 1);

  // User lain tidak melihat/menyentuh percakapan itu.
  const other = await env.repo.createUser({ email: 'z@z.co', passwordHash: 'scrypt$a$b' });
  const otherLogin = await send(env, jsonReq('/chat/api/auth/login', { email: 'z@z.co', password: 'rahasia123' }));
  assert.equal(otherLogin.status, 401, 'akun lain tanpa password valid');
  assert.equal(await env.repo.getConversation(other.id, conversation.id), null);

  const del = await send(env, req(`/chat/api/conversations/${conversation.id}`, { method: 'DELETE', headers: { Cookie: cookie } }));
  assert.equal(del.status, 200);
  assert.equal((await env.repo.listConversations(user.id)).length, 0);
});

test('percakapan: CSRF (lintas-origin) 403 pada pembuatan', async () => {
  const env = makeEnv();
  const { cookie } = await setup(env);
  const r = await send(env, req('/chat/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({}) }, 'https://evil.test'));
  assert.equal(r.status, 403);
});