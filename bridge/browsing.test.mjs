// bridge/browsing.test.mjs — browsing Adhitron Web: anti-SSRF, pencarian web, pembersihan halaman,
// dan giliran browsing (kutipan bernomor + penyimpanan citation + batas pencarian per percakapan).
// Semua tanpa jaringan: `fetchImpl`/`searchImpl`/`fetchPageImpl` disuntik.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSafeUrl, isSafeRedirect, isPrivateIPv6, parseIPv4 } from './src/ssrf.mjs';
import { pickEngine, unwrapDdgUrl, webSearch, searchDuckDuckGo } from './src/search.mjs';
import { fetchPage, extractTitle, htmlToText } from './src/fetch-page.mjs';
import { runBrowsingTurn, sourcesBlock, MAX_SEARCHES_PER_CONVERSATION } from './src/browsing.mjs';
import { handleChatApi } from './src/chat-api.mjs';
import { encryptSecret } from './src/secrets.mjs';
import { makeMemoryRepo } from './src/repo-memory.mjs';

const KEY = 'ab'.repeat(32);
const makeStore = () => {
  const map = new Map();
  return { get: async (k) => (map.has(k) ? map.get(k) : null), set: async (k, v) => { map.set(k, String(v)); }, delete: async (k) => { map.delete(k); }, list: async ({ prefix }) => ({ blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }) };
};
const makeEnv = (extra = {}) => ({ repo: makeMemoryRepo(), store: makeStore(), encryptionKey: KEY, ...extra });

const req = (path, init = {}, origin = 'https://web.test') => new Request(`https://web.test${path}`, { ...init, headers: { Origin: origin, ...(init.headers ?? {}) } });
const jsonReq = (path, body, headers = {}) => req(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const send = (env, request, fetchImpl) => handleChatApi(request, env, new URL(request.url).pathname, fetchImpl);
const body = async (r) => JSON.parse(await r.text());
async function readSse(res) {
  const text = await res.text();
  return text.split('\n\n').filter((b) => b.startsWith('data:')).map((b) => JSON.parse(b.slice(5).trim()));
}
function sseResponse(chunks, status = 200) {
  const enc = new TextEncoder();
  return { ok: status < 300, status, headers: new Headers(), body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }) };
}
async function setup(env, kind = 'openai') {
  const r = await send(env, jsonReq('/chat/api/auth/signup', { email: 'a@b.co', password: 'rahasia123', consent: true }));
  const token = /adhitron_session=([0-9a-f]{64})/.exec(r.headers.get('set-cookie'))[1];
  const cookie = `adhitron_session=${token}`;
  const user = await env.repo.getUserByEmail('a@b.co');
  const provider = await env.repo.createProvider({ userId: user.id, kind, label: 'P', apiKeyEnc: encryptSecret(KEY, 'sk-secret'), keyHint: 'cret' });
  return { cookie, user, provider };
}

// ---------------------------------------------------------------- anti-SSRF

test('ssrf: hanya http(s) dan host publik yang lolos', () => {
  assert.equal(isSafeUrl('https://example.com/a').ok, true);
  assert.equal(isSafeUrl('ftp://example.com').ok, false, 'skema lain ditolak');
  assert.equal(isSafeUrl('https://u:p@example.com').ok, false, 'kredensial ditolak');
  assert.equal(isSafeUrl('bukan-url').ok, false);
});

test('ssrf: loopback/privat/link-local/metadata diblokir (IPv4 & IPv6)', () => {
  for (const u of [
    'http://localhost/x', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://192.168.0.1/',
    'http://172.16.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/',
    'http://100.64.0.1/', 'http://0.0.0.0/', 'http://metadata.google.internal/',
    'http://foo.internal/', 'http://bar.local/',
  ]) assert.equal(isSafeUrl(u).ok, false, u);
  // Bentuk menyamar: desimal/oktal/hex untuk 127.0.0.1.
  for (const u of ['http://2130706433/', 'http://0x7f000001/', 'http://017700000001/']) {
    assert.equal(isSafeUrl(u).ok, false, `menyamar: ${u}`);
  }
  assert.equal(isPrivateIPv6('::1'), true);
  assert.equal(isPrivateIPv6('fe80::1'), true);
  assert.equal(isPrivateIPv6('fd00::1'), true);
  assert.equal(isPrivateIPv6('2001:db8::1'), false);
  assert.deepEqual(parseIPv4('127.0.0.1'), [127, 0, 0, 1]);
  assert.equal(parseIPv4('999.1.1.1'), null);
});

test('ssrf: allowPrivate melewati blokir (untuk test lokal) & redirect diperiksa', () => {
  assert.equal(isSafeUrl('http://127.0.0.1:4317/x', { allowPrivate: true }).ok, true);
  assert.equal(isSafeRedirect('/admin', 'https://example.com/x').ok, true);
  assert.equal(isSafeRedirect('http://169.254.169.254/', 'https://example.com/x').ok, false);
});

// ---------------------------------------------------------------- pencarian

test('search: pickEngine memilih tavily/brave/ddg sesuai env', () => {
  assert.equal(pickEngine({}), 'duckduckgo');
  assert.equal(pickEngine({ TAVILY_API_KEY: 'x' }), 'tavily');
  assert.equal(pickEngine({ BRAVE_API_KEY: 'x' }), 'brave');
  assert.equal(pickEngine({ TAVILY_API_KEY: 'x', BRAVE_API_KEY: 'y' }), 'tavily');
});

test('search: unwrapDdgUrl melepas redirect dan menolak non-http', () => {
  assert.equal(unwrapDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa'), 'https://example.com/a');
  assert.equal(unwrapDdgUrl('https://example.com/b'), 'https://example.com/b');
  assert.equal(unwrapDdgUrl(''), null);
});

test('search DuckDuckGo: parse hasil HTML dan buang URL non-http', async () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2F1">Judul <b>A</b></a>
    <a class="result__snippet">Cuplikan <b>satu</b></a>
    <a class="result__a" href="javascript:alert(1)">Jahat</a>
    <a class="result__a" href="https://b.test/2">Judul B</a>`;
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => html });
  const out = await webSearch('apa itu', { fetchImpl });
  assert.equal(out.length, 2, 'hanya http(s) yang lolos');
  assert.deepEqual(out[0], { title: 'Judul A', url: 'https://a.test/1', snippet: 'Cuplikan satu' });
  assert.equal(out[1].url, 'https://b.test/2');
});

test('search: mesin nonaktif / gagal mengembalikan [] (tidak melempar)', async () => {
  assert.deepEqual(await searchDuckDuckGo('x', 3, async () => { throw new Error('down'); }), []);
  assert.deepEqual(await webSearch('', { fetchImpl: async () => ({ ok: true }) }), [], 'query kosong');
  const tavily = async () => ({ ok: true, json: async () => ({ results: [{ title: 'T', url: 'https://t.test', content: 'c' }] }) });
  assert.deepEqual(await webSearch('x', { fetchImpl: tavily, env: { TAVILY_API_KEY: 'k' } }), [{ title: 'T', url: 'https://t.test', snippet: 'c' }]);
});

// ---------------------------------------------------------------- fetch halaman

test('fetch-page: membuang script/style, mengekstrak judul & teks', () => {
  const html = '<html><head><title>Halo &amp; Dunia</title></head><body><script>x()</script><style>.a{}</style><p>Paragraf<br>dua</p><div>Lagi</div></body></html>';
  assert.equal(extractTitle(html), 'Halo & Dunia');
  const text = htmlToText(html);
  assert.equal(text.includes('x()'), false);
  assert.equal(text.includes('.a{}'), false);
  assert.match(text, /Paragraf/);
  assert.match(text, /Lagi/);
});

test('fetch-page: menolak host privat & konten non-html; menyuntik fetchPageImpl', async () => {
  assert.equal(await fetchPage('http://127.0.0.1/'), null);
  const pdf = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/pdf' }), text: async () => 'x' });
  assert.equal(await fetchPage('https://example.com/a.pdf', { fetchImpl: pdf }), null);
  const ok = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<title>T</title><p>isi</p>' });
  const page = await fetchPage('https://example.com/', { fetchImpl: ok });
  assert.equal(page.title, 'T');
  assert.match(page.text, /isi/);
  assert.deepEqual(await fetchPage('https://example.com/', { fetchPageImpl: async () => ({ title: 'S', text: 'T' }) }), { title: 'S', text: 'T' });
});

// ---------------------------------------------------------------- sourcesBlock

test('sourcesBlock: memberi nomor [1..n] dan memakai snippet', () => {
  const block = sourcesBlock([{ title: 'A', url: 'https://a.test', snippet: 'aa' }, { title: 'B', url: 'https://b.test' }]);
  assert.match(block, /\[1\] A/);
  assert.match(block, /\[2\] B/);
  assert.equal(sourcesBlock([]), 'Tidak ada hasil pencarian.');
});

// ---------------------------------------------------------------- giliran browsing

test('runBrowsingTurn: cari → baca → jawab, mengirim sources, menyimpan tool_runs', async () => {
  const env = makeEnv({
    searchImpl: async () => [
      { title: 'Hasil A', url: 'https://a.test/1', snippet: 'cuplikan a' },
      { title: 'Hasil B', url: 'https://b.test/2', snippet: 'cuplikan b' },
    ],
    fetchPageImpl: async () => ({ title: 'A', text: 'teks halaman A '.repeat(20) }),
  });
  const user = await env.repo.createUser({ email: 'u@u.co', passwordHash: 'scrypt$a$b' });
  const conv = await env.repo.createConversation(user.id, { browsing: true });
  const events = [];
  const out = await runBrowsingTurn({
    env, user, conv, provider: { kind: 'openai' }, apiKey: 'k',
    model: 'gpt-5', effort: 'default', history: [],
    text: 'apa itu', send: (e) => events.push(e), fetchImpl: async () => sseResponse(['data: [DONE]\n\n']),
  });
  assert.ok(out.text.length >= 0);
  assert.deepEqual(events.find((e) => e.type === 'sources').sources, [{ title: 'Hasil A', url: 'https://a.test/1' }, { title: 'Hasil B', url: 'https://b.test/2' }]);
  assert.equal(await env.repo.countToolRuns(user.id, conv.id, 'web_search'), 1);
  assert.equal(await env.repo.countToolRuns(user.id, conv.id, 'fetch_url'), 2);
});

test('runBrowsingTurn: berhenti mencari setelah batas percakapan tercapai (tetap menjawab)', async () => {
  const env = makeEnv({ searchImpl: async () => [{ title: 'A', url: 'https://a.test', snippet: 'x' }] });
  const user = await env.repo.createUser({ email: 'u@u.co', passwordHash: 'scrypt$a$b' });
  const conv = await env.repo.createConversation(user.id, { browsing: true });
  for (let i = 0; i < MAX_SEARCHES_PER_CONVERSATION; i++) await env.repo.addToolRun(user.id, conv.id, { tool: 'web_search' });
  const events = [];
  await runBrowsingTurn({
    env, user, conv, provider: { kind: 'openai' }, apiKey: 'k',
    model: 'gpt-5', effort: 'default', history: [], text: 'x', send: (e) => events.push(e),
    fetchImpl: async () => sseResponse(['data: [DONE]\n\n']),
  });
  assert.ok(events.some((e) => e.type === 'notice'), 'ada pemberitahuan batas');
  assert.equal(await env.repo.countToolRuns(user.id, conv.id, 'web_search'), MAX_SEARCHES_PER_CONVERSATION, 'tidak menambah pencarian');
});

test('giliran browsing lewat rute: kutipan tersimpan + bisa dimuat dari percakapan', async () => {
  const env = makeEnv({
    searchImpl: async () => [{ title: 'Sumber Satu', url: 'https://s.test/1', snippet: 'cuplikan' }],
    fetchPageImpl: async () => null, // biarkan snippet hasil pencarian
  });
  const { cookie, user, provider } = await setup(env);
  const create = await send(env, jsonReq('/chat/api/conversations', { providerId: provider.id, model: 'gpt-5', browsing: true }, { Cookie: cookie }));
  const { conversation } = await body(create);
  const fetchImpl = async () => sseResponse(['data: {"choices":[{"delta":{"content":"Lihat [1]"}}]}\n\n', 'data: [DONE]\n\n']);
  const res = await send(env, jsonReq(`/chat/api/conversations/${conversation.id}/messages`, { text: 'cari' }, { Cookie: cookie }), fetchImpl);
  const events = await readSse(res);
  assert.ok(events.some((e) => e.type === 'sources'));
  assert.equal(events.at(-1).type, 'done');
  const loaded = await body(await send(env, req(`/chat/api/conversations/${conversation.id}`, { headers: { Cookie: cookie } })));
  assert.equal(loaded.citations.length, 1);
  assert.equal(loaded.citations[0].url, 'https://s.test/1');
  assert.equal(loaded.citations[0].idx, 1);
  assert.equal((await env.repo.countToolRuns(user.id, conversation.id, 'web_search')), 1);
});