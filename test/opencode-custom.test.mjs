// Provider kustom OpenAI-compatible (👤 Akun → OpenCode): the three routes (/api/opencode/custom/check, /add and
// /remove) against a hand-made ctx + a minimal fake `opencode` bin, the config writers (addCustomProvider,
// removeCustomProvider) against a throwaway home folder, and openCodeProviders' `custom` flags. A tiny local HTTP
// server plays the provider's /models. No real OpenCode, no real provider, no network beyond 127.0.0.1.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildRouter } from '../src/routes/index.js';
import { wifiAllows } from '../src/remote.js';
import { openCodeProviders } from '../src/opencode-auth.js';
import { addCustomProvider, backupRoot, readOpenCodeConfig, removeCustomProvider } from '../src/opencode-config.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-opencode-custom-'));
const HOME = path.join(TMP, 'xdg');
const DATA = path.join(TMP, 'data');
const CONFIG_DIR = path.join(HOME, 'opencode');
const CONFIG_FILE = path.join(CONFIG_DIR, 'opencode.json');
const CONNECT_LOG = path.join(TMP, 'connect.log');
const INTEGRATIONS_FILE = path.join(TMP, 'integrations.json');

process.env.OFFICE_OPENCODE_CONFIG_HOME = HOME;
process.env.FAKE_CONNECT_LOG = CONNECT_LOG;
process.env.FAKE_INTEGRATIONS = INTEGRATIONS_FILE;

after(() => {
  delete process.env.OFFICE_OPENCODE_CONFIG_HOME;
  delete process.env.FAKE_CONNECT_LOG;
  delete process.env.FAKE_INTEGRATIONS;
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---------- fake `opencode` bin (only the `api` operations the routes use) ----------

const FAKE_BIN = path.join(TMP, 'fake-opencode-custom.mjs');
writeFileSync(
  FAKE_BIN,
  `#!/usr/bin/env node
// A minimal fake opencode: integration.list (FAKE_INTEGRATIONS file when present, else a fixed catalog),
// integration.connect.key and credential.remove (both record to FAKE_CONNECT_LOG).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const [, , , op, ...rest] = process.argv;
const params = {};
let body = {};
for (let i = 0; i < rest.length; i += 2) {
  if (rest[i] === '--param') { const [k, ...v] = rest[i + 1].split('='); params[k] = v.join('='); }
  else if (rest[i] === '--data') body = JSON.parse(rest[i + 1]);
}
const out = (data) => (console.log(JSON.stringify({ location: { directory: process.cwd() }, data })), process.exit(0));
const fail = (msg) => (console.error(msg), process.exit(1));
if (op === 'integration.list') {
  if (process.env.FAKE_INTEGRATIONS && existsSync(process.env.FAKE_INTEGRATIONS)) {
    out(JSON.parse(readFileSync(process.env.FAKE_INTEGRATIONS, 'utf8')));
  } else {
    out([
      { id: 'opencode-go', name: 'OpenCode Go', methods: [{ type: 'key' }], connections: [] },
      { id: 'riverfake', name: 'River Fake', methods: [{ type: 'key' }], connections: [] },
    ]);
  }
}
if (op === 'integration.connect.key') {
  if (body.key === 'fail-key') fail('UnknownError: An error occurred\\n    at x (y:1:1) {\\n  [cause]: Error: Authentication failed\\n}');
  if (process.env.FAKE_CONNECT_LOG) appendFileSync(process.env.FAKE_CONNECT_LOG, \`\${params.integrationID}\\t\${body.key}\\n\`);
  out(null);
}
if (op === 'credential.remove') {
  if (params.credentialID === 'cred-fail') fail('UnknownError: An error occurred\\n    at x (y:1:1) {\\n  [cause]: Error: Boom\\n}');
  if (process.env.FAKE_CONNECT_LOG) appendFileSync(process.env.FAKE_CONNECT_LOG, 'remove\\t' + params.credentialID + '\\n');
  out(null);
}
fail(\`Operation not found: \${op}\`);
`,
);
const BIN = { command: process.execPath, args: [FAKE_BIN] };

// ---------- the local /models endpoint ----------

const STATE = { mode: 'openai', auth: 'unset', url: '' };
let httpPort = 0;
let closedPort = 0;
let httpServer;

before(async () => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  httpServer = createServer((req, res) => {
    STATE.auth = req.headers.authorization ?? null;
    STATE.url = req.url;
    if (req.url !== '/models') return (res.writeHead(404), res.end());
    const body = {
      openai: { data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm1' }, { id: 'bad id!' }, { id: '' }, {}, 5] },
      strings: ['a', 'a', 'b'],
      models: { models: [{ id: 'x' }, 'y'] },
      many: { data: Array.from({ length: 250 }, (_, i) => ({ id: `m${String(i + 1).padStart(4, '0')}` })) },
      unauth: null,
      garbage: null,
      broken: null,
    }[STATE.mode];
    if (STATE.mode === 'unauth') return (res.writeHead(401, { 'Content-Type': 'application/json' }), res.end('{"error":"bad key"}'));
    if (STATE.mode === 'garbage') return (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end('<html>hi</html>'));
    if (STATE.mode === 'huge') return (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(`[${'x'.repeat(6 * 1024 * 1024)}]`));
    if (STATE.mode === 'broken') return res.destroy();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  httpPort = httpServer.address().port;
  // A closed port for the fetch-failure case: grab a free port and give it back.
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  closedPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
});

after(() => httpServer?.close());

// ---------- routes (the account-privacy.test.mjs pattern) ----------

function fakeRes() {
  const res = { status: 0, headers: {}, body: '' };
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.writeHead = (status, headers = {}) => {
    res.status = status;
    Object.assign(res.headers, headers);
  };
  res.end = (b) => (res.body = String(b ?? ''));
  res.json = () => JSON.parse(res.body);
  return res;
}

const router = buildRouter();
async function call(p, body = {}, ctx = CTX) {
  const m = router.match('POST', p);
  assert.ok(m, `${p} harus terdaftar`);
  const res = fakeRes();
  await m.route.handler(ctx, { headers: {} }, res, m.params, body);
  return res;
}

const CTX = {
  opencode: BIN,
  dataDir: DATA,
  device: null,
  hub: { dataDir: DATA, broadcast: () => {}, projects: new Map() },
  sessions: {},
  taskQueue: { pauseAll: () => {} },
};

const writeConfig = (config) => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
};
const writeIntegrations = (list) => writeFileSync(INTEGRATIONS_FILE, JSON.stringify(list));
const resetConfig = () => {
  try {
    rmSync(CONFIG_FILE, { force: true });
  } catch {
    // first run: nothing to remove
  }
  rmSync(DATA, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  rmSync(CONNECT_LOG, { force: true });
  rmSync(INTEGRATIONS_FILE, { force: true });
};

/** A hub fake for markModelStale: one non-virtual project on the OpenCode engine with one active model. */
const makeHub = (activeModel = '') => {
  const hub = {
    dataDir: DATA,
    broadcast: () => {},
    projects: new Map([['p1', { id: 'p1' }]]),
    settingsFor: () => ({ engine: 'opencode' }),
    runtime: { get: () => (activeModel ? { status: { activeModel } } : undefined) },
    status: [],
    notes: [],
    setStatus: (id, patch) => hub.status.push([id, patch]),
    chat: (id, note) => hub.notes.push(note),
  };
  return hub;
};

// ---------- /api/opencode/custom/check ----------

test('routes: ketiga route custom terdaftar dan bukan rute WiFi read-only', () => {
  for (const p of ['/api/opencode/custom/check', '/api/opencode/custom/add', '/api/opencode/custom/remove']) {
    assert.ok(router.match('POST', p), p);
    assert.equal(wifiAllows(p), false, `${p} tidak pernah lewat WiFi`);
  }
});

test('check: baseURL wajib URL https (atau http loopback), panjang & key dibatasi (400)', async () => {
  for (const baseURL of ['http://example.com', 'ftp://example.com', 'bukan-url', 'https://', '', 'https://a'.padEnd(301, 'x')]) {
    const res = await call('/api/opencode/custom/check', { baseURL, key: '' });
    assert.equal(res.status, 400, `baseURL ${JSON.stringify(baseURL)} → ${res.status} ${res.body}`);
  }
  const res = await call('/api/opencode/custom/check', { baseURL: `http://127.0.0.1:${httpPort}`, key: 'k'.repeat(4097) });
  assert.equal(res.status, 400, 'key maks 4096');
});

test('check: http://127.0.0.1 dijalankan — Bearer dikirim saat ada key, tanpa header saat kosong', async () => {
  writeConfig({}); // route does not need the config, the env home must simply exist
  STATE.mode = 'openai';
  const withKey = await call('/api/opencode/custom/check', { baseURL: `http://127.0.0.1:${httpPort}`, key: 'sk-test-1' });
  assert.equal(withKey.status, 200, withKey.body);
  assert.deepEqual(withKey.json(), { models: [{ id: 'm1' }, { id: 'm2' }] }, 'dedup + id invalid dibuang');
  assert.equal(STATE.auth, 'Bearer sk-test-1');
  assert.equal(STATE.url, '/models', '/models di-append ke baseURL');
  const noKey = await call('/api/opencode/custom/check', { baseURL: `http://127.0.0.1:${httpPort}`, key: '' });
  assert.equal(noKey.status, 200, noKey.body);
  assert.equal(STATE.auth, null, 'tanpa Authorization saat key kosong');
  // trailing slash: still exactly one /models
  const slashed = await call('/api/opencode/custom/check', { baseURL: `http://127.0.0.1:${httpPort}/`, key: '' });
  assert.equal(slashed.status, 200);
  assert.equal(STATE.url, '/models');
});

test('check: fallback array string dan { models: [...] }, terpotong di 200', async () => {
  STATE.mode = 'strings';
  assert.deepEqual((await call('/api/opencode/custom/check', { baseURL: `http://127.0.0.1:${httpPort}` })).json(), { models: [{ id: 'a' }, { id: 'b' }] });
  STATE.mode = 'models';
  assert.deepEqual((await call('/api/opencode/custom/check', { baseURL: `http://127.0.0.1:${httpPort}` })).json(), { models: [{ id: 'x' }, { id: 'y' }] });
  STATE.mode = 'many';
  const many = (await call('/api/opencode/custom/check', { baseURL: `http://127.0.0.1:${httpPort}` })).json();
  assert.equal(many.models.length, 200, 'maksimal 200 model');
  assert.equal(many.models[0].id, 'm0001');
  assert.equal(many.models.at(-1).id, 'm0200');
});

test('check: fetch gagal / HTTP error / JSON rusak → 502 tanpa key di pesan', async () => {
  const key = 'sk-rahasia-jangan- bocor';
  const closed = await call('/api/opencode/custom/check', { baseURL: `http://127.0.0.1:${closedPort}`, key });
  assert.equal(closed.status, 502, closed.body);
  assert.ok(!closed.body.includes(key));
  STATE.mode = 'unauth';
  const refused = await call('/api/opencode/custom/check', { baseURL: `http://127.0.0.1:${httpPort}`, key });
  assert.equal(refused.status, 502, refused.body);
  assert.match(refused.json().error, /HTTP 401/);
  assert.ok(!refused.body.includes(key), 'body respons tidak dijadikan pesan');
  STATE.mode = 'garbage';
  assert.equal((await call('/api/opencode/custom/check', { baseURL: `http://127.0.0.1:${httpPort}` })).status, 502);
  STATE.mode = 'huge';
  const huge = await call('/api/opencode/custom/check', { baseURL: `http://127.0.0.1:${httpPort}`, key: '' });
  assert.equal(huge.status, 502, 'jawaban di atas batas ditolak, bukan ditelan ke memori');
  assert.match(huge.json().error, /besar/i);
  STATE.mode = 'openai';
});

// ---------- /api/opencode/custom/add ----------

const GOOD = { id: 'river', name: 'River', baseURL: 'https://api.river.ai/v1', key: 'sk-river-1', models: ['river-1', 'river-1', 'river-2'] };

test('add: id bawaan/deny list (400), id yang dipakai provider katalog (409), id rusak (400)', async () => {
  resetConfig();
  for (const id of ['openai', 'anthropic', 'google-vertex', 'amazon-bedrock', 'github-copilot', 'opencode-go', 'opencode-zen', 'riverfake']) {
    const res = await call('/api/opencode/custom/add', { ...GOOD, id });
    assert.ok([400, 409].includes(res.status), `${id} → ${res.status} ${res.body}`);
  }
  assert.equal((await call('/api/opencode/custom/add', { ...GOOD, id: 'riverfake' })).status, 409, 'id dari integration.list → 409');
  assert.equal((await call('/api/opencode/custom/add', { ...GOOD, id: '_bad' })).status, 400);
  assert.equal((await call('/api/opencode/custom/add', { ...GOOD, id: 'a'.repeat(65) })).status, 400);
});

test('add: name, models, baseURL, key invalid → 400', async () => {
  const cases = [
    { name: '' },
    { name: 'x'.repeat(101) },
    { models: [] },
    { models: 'bukan-array' },
    { models: ['ok', 'bad id!'] },
    { models: Array.from({ length: 101 }, (_, i) => `m${i}`) },
    { baseURL: 'http://example.com' },
    { key: '' },
    { key: 'k'.repeat(4097) },
  ];
  for (const patch of cases) {
    const res = await call('/api/opencode/custom/add', { ...GOOD, ...patch });
    assert.equal(res.status, 400, `${JSON.stringify(patch)} → ${res.status} ${res.body}`);
  }
  assert.ok(!existsSync(backupRoot(DATA)), 'tidak ada yang ditulis saat input invalid');
});

test('add: blok config benar, key lain tetap, key tidak masuk file/log audit, connect key terpanggil', async () => {
  resetConfig();
  writeConfig({ $schema: 'https://opencode.ai/config.json', model: 'lama', providers: { lain: { name: 'Lain', package: 'pkg/lain', settings: {} } } });
  const res = await call('/api/opencode/custom/add', GOOD);
  assert.equal(res.status, 200, res.body);
  const view = readOpenCodeConfig({ scope: 'global', home: HOME });
  assert.equal(view.config.model, 'lama', 'key config lain tetap');
  assert.deepEqual(view.config.providers.lain, { name: 'Lain', package: 'pkg/lain', settings: {} });
  assert.deepEqual(view.config.providers.river, {
    name: 'River',
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: 'https://api.river.ai/v1' },
    models: { 'river-1': {}, 'river-2': {} },
    env: ['RIVER_API_KEY'],
  });
  const file = readFileSync(CONFIG_FILE, 'utf8');
  assert.ok(!file.includes('sk-river-1'), 'API key tidak pernah ditulis ke config');
  assert.ok(existsSync(path.join(backupRoot(DATA), 'global')), 'backup dibuat di folder data');
  assert.deepEqual(readFileSync(CONNECT_LOG, 'utf8'), 'river\tsk-river-1\n', 'connect key dipanggil dengan id + key');
  const audit = readFileSync(path.join(DATA, 'auth-audit.jsonl'), 'utf8');
  assert.match(audit, /"action":"custom-add"/);
  assert.match(audit, /"ok":true/);
  assert.match(audit, /"provider":"river"/);
  assert.ok(!audit.includes('sk-river-1'), 'API key tidak pernah masuk audit');
});

test('add: overwrite blok buatan fitur ini boleh (ganti penuh), blok package lain → 409, blok tanpa package boleh', async () => {
  resetConfig();
  writeConfig({ model: 'tetap', providers: { river: { name: 'River lama', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://lama/v1' }, models: { lama: {} }, env: ['LAMA_API_KEY'] } } });
  const again = await call('/api/opencode/custom/add', GOOD);
  assert.equal(again.status, 200, again.body);
  const view = readOpenCodeConfig({ scope: 'global', home: HOME });
  assert.equal(view.config.model, 'tetap');
  assert.deepEqual(view.config.providers.river.models, { 'river-1': {}, 'river-2': {} }, 'blok lama diganti penuh');
  writeConfig({ providers: { punya: { name: 'Punya', package: 'user/pkg' } } });
  const blocked = await call('/api/opencode/custom/add', { ...GOOD, id: 'punya' });
  assert.equal(blocked.status, 409, blocked.body);
  assert.match(blocked.json().error, /id lain/i);
  writeConfig({ providers: { punya: { name: 'Punya' } } });
  assert.equal((await call('/api/opencode/custom/add', { ...GOOD, id: 'punya' })).status, 200, 'blok tanpa package boleh diganti');
});

test('add: baseURL sama dengan blok kustom lain (id beda) → 409 dengan nama id lama', async () => {
  resetConfig();
  writeConfig({ providers: { river_ai: { name: 'River AI', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://api.river.ai/v1' } } } });
  const res = await call('/api/opencode/custom/add', GOOD);
  assert.equal(res.status, 409, res.body);
  assert.match(res.json().error, /river_ai/, 'pesan menyebut id blok lama');
  assert.match(res.json().error, /sudah dipakai/);
  assert.equal(readOpenCodeConfig({ scope: 'global', home: HOME }).config.providers.river, undefined, 'tidak ada yang ditulis');
});

test('add: baseURL sama tapi blok lama package lain → tetap boleh; baseURL sama id sama → overwrite seperti semula', async () => {
  resetConfig();
  writeConfig({ providers: { lain: { name: 'Lain', package: 'pkg/lain', settings: { baseURL: 'https://api.river.ai/v1' } } } });
  assert.equal((await call('/api/opencode/custom/add', GOOD)).status, 200, 'guard duplikat hanya untuk blok kustom');
  writeConfig({ providers: { river: { name: 'River lama', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://api.river.ai/v1' } } } });
  const again = await call('/api/opencode/custom/add', GOOD);
  assert.equal(again.status, 200, again.body);
  const view = readOpenCodeConfig({ scope: 'global', home: HOME });
  assert.deepEqual(view.config.providers.river.models, { 'river-1': {}, 'river-2': {} }, 'blok diganti penuh seperti semula');
});

test('add: config global tidak valid → 400 dengan pesan perbaiki dulu', async () => {
  resetConfig();
  writeFileSync(CONFIG_FILE, '{ broken\n');
  const res = await call('/api/opencode/custom/add', GOOD);
  assert.equal(res.status, 400, res.body);
  assert.match(res.json().error, /Config OpenCode global/);
});

test('add: connect key gagal → 502 yang menjelaskan blok sudah tertulis', async () => {
  resetConfig();
  writeConfig({});
  const res = await call('/api/opencode/custom/add', { ...GOOD, key: 'fail-key' });
  assert.equal(res.status, 502, res.body);
  assert.match(res.json().error, /config/i);
  assert.match(res.json().error, /key/i);
  const view = readOpenCodeConfig({ scope: 'global', home: HOME });
  assert.equal(view.config.providers.river.settings.baseURL, 'https://api.river.ai/v1', 'blok tetap tertulis');
  const audit = readFileSync(path.join(DATA, 'auth-audit.jsonl'), 'utf8');
  assert.match(audit, /"action":"custom-add"/);
  assert.match(audit, /"ok":false/);
  assert.ok(!audit.includes('fail-key'), 'key tidak pernah masuk audit');
});

// ---------- /api/opencode/custom/remove ----------

test('remove: konfirmasi salah / id rusak (400), id tidak ada dan id bawaan (404)', async () => {
  resetConfig();
  writeConfig({});
  let res = await call('/api/opencode/custom/remove', { id: 'river', confirm: 'hapus' });
  assert.equal(res.status, 400, res.body);
  assert.match(res.json().error, /HAPUS/);
  res = await call('/api/opencode/custom/remove', { id: 'river' });
  assert.equal(res.status, 400, 'konfirmasi wajib dari laptop juga');
  res = await call('/api/opencode/custom/remove', { id: 'bad id', confirm: 'HAPUS' });
  assert.equal(res.status, 400);
  res = await call('/api/opencode/custom/remove', { id: 'river', confirm: 'HAPUS' });
  assert.equal(res.status, 404, res.body);
  assert.match(res.json().error, /river/);
  // deny list tidak berlaku untuk remove: provider bawaan tidak punya blok → 404, bukan 400
  res = await call('/api/opencode/custom/remove', { id: 'openai', confirm: 'HAPUS' });
  assert.equal(res.status, 404, res.body);
});

test('remove: blok package lain → 409, config tidak berubah', async () => {
  resetConfig();
  writeConfig({ providers: { river: { name: 'River', package: 'user/pkg', settings: { baseURL: 'https://x/v1' } } } });
  const res = await call('/api/opencode/custom/remove', { id: 'river', confirm: 'HAPUS' });
  assert.equal(res.status, 409, res.body);
  assert.match(res.json().error, /user\/pkg/);
  assert.equal(readOpenCodeConfig({ scope: 'global', home: HOME }).config.providers.river.package, 'user/pkg', 'blok tetap ada');
});

test('remove: sukses — kredensial dihapus dulu, blok hilang, key lain tetap, backup, audit, markModelStale', async () => {
  resetConfig();
  writeConfig({
    model: 'tetap',
    providers: {
      river: { name: 'River', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://api.river.ai/v1' }, models: { 'river-1': {} }, env: ['RIVER_API_KEY'] },
      keep: { name: 'Keep' },
    },
  });
  writeIntegrations([
    { id: 'river', name: 'River', methods: [], connections: [{ type: 'credential', id: 'cred-ok' }, { type: 'credential', id: 'cred-fail' }] },
    { id: 'opencode-go', name: 'OpenCode Go', methods: [{ type: 'key' }], connections: [] },
  ]);
  const hub = makeHub('river/river-1');
  const res = await call('/api/opencode/custom/remove', { id: 'river', confirm: 'HAPUS' }, { ...CTX, hub });
  assert.equal(res.status, 200, res.body);
  const out = res.json();
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'river');
  assert.equal(out.credentialsRemoved, 1, 'satu kredensial dihapus, satu gagal tapi tidak fatal');
  assert.equal(out.credentialErrors.length, 1);
  const view = readOpenCodeConfig({ scope: 'global', home: HOME });
  assert.equal(view.config.model, 'tetap', 'key config lain tetap');
  assert.deepEqual(view.config.providers.keep, { name: 'Keep' }, 'blok provider lain tetap');
  assert.equal(view.config.providers.river, undefined, 'blok river hilang');
  assert.ok(existsSync(out.backup), 'backup dibuat');
  assert.match(readFileSync(out.backup, 'utf8'), /"river"/, 'backup berisi config sebelumnya');
  const log = readFileSync(CONNECT_LOG, 'utf8');
  assert.match(log, /remove\tcred-ok/, 'kredensial yang bisa dihapus memang dihapus');
  assert.ok(!log.includes('cred-fail'), 'kredensial yang gagal tidak dihitung');
  const audit = readFileSync(path.join(DATA, 'auth-audit.jsonl'), 'utf8');
  assert.match(audit, /"action":"custom-remove"/);
  assert.match(audit, /"ok":true/);
  assert.match(audit, /"provider":"river"/);
  assert.ok(!audit.includes('sk-'), 'tidak ada key di audit');
  assert.deepEqual(hub.status, [['p1', { modelStale: true }]], 'model aktif dari provider itu jadi stale');
  assert.equal(hub.notes.length, 1, 'project diberi tahu di chat');
  assert.equal(hub.notes[0].modelStale, true);
});

test('openCodeProviders: blok kustom → custom: true, katalog tidak, config rusak tetap membaca daftar', async () => {
  resetConfig();
  writeConfig({ providers: { riverfake: { name: 'River Fake', settings: { baseURL: 'https://x/v1' } } } });
  writeIntegrations([
    { id: 'riverfake', name: 'River Fake', methods: [{ type: 'key' }], connections: [{ type: 'credential', id: 'cred-x' }] },
    { id: 'opencode-go', name: 'OpenCode Go', methods: [{ type: 'key' }], connections: [] },
  ]);
  const list = await openCodeProviders(BIN);
  assert.equal(list.connected.find((p) => p.id === 'riverfake')?.custom, true, 'connected: blok kustom ditandai');
  assert.equal(list.available.find((p) => p.id === 'riverfake')?.custom, true, 'available juga');
  assert.equal(list.available.find((p) => p.id === 'opencode-go')?.custom, false, 'provider katalog tidak ditandai');
  // blok dengan package lain (bukan buatan aplikasi) tidak dianggap kustom
  writeConfig({ providers: { riverfake: { name: 'River Fake', package: 'user/pkg', settings: { baseURL: 'https://x/v1' } } } });
  const other = await openCodeProviders(BIN);
  assert.equal(other.connected.find((p) => p.id === 'riverfake')?.custom, false);
  // config rusak: daftar tetap jalan, tanpa flag kustom
  writeFileSync(CONFIG_FILE, '{ broken\n');
  const broken = await openCodeProviders(BIN);
  assert.equal(broken.connected.length, 1, 'daftar tetap terbaca');
  assert.equal(broken.connected.find((p) => p.id === 'riverfake')?.custom, false);
});

test('add: id yang blok kustomnya sendiri di config tidak dianggap provider bawaan (overwrite boleh)', async () => {
  resetConfig();
  // The custom block makes OpenCode itself list `riverfake` as an integration (the fake bin does exactly that):
  // re-adding it must be an overwrite, not a "sudah dipakai provider bawaan" 409.
  writeConfig({ providers: { riverfake: { name: 'River Fake', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://lama/v1' }, models: { lama: {} }, env: ['RIVERFAKE_API_KEY'] } } });
  const res = await call('/api/opencode/custom/add', { ...GOOD, id: 'riverfake', models: ['river-1'] });
  assert.equal(res.status, 200, res.body);
  const view = readOpenCodeConfig({ scope: 'global', home: HOME });
  assert.equal(view.config.providers.riverfake.settings.baseURL, 'https://api.river.ai/v1', 'blok diganti penuh');
  assert.deepEqual(view.config.providers.riverfake.models, { 'river-1': {} }, 'blok diganti penuh');
  assert.equal(readFileSync(CONFIG_FILE, 'utf8').includes('sk-river-1'), false, 'key tetap tidak pernah di file config');
});

test('add: edit tanpa key diizinkan saat provider masih punya kredensial (key lama dipertahankan)', async () => {
  resetConfig();
  // An own custom block that is CONNECTED (its key lives in OpenCode's credential store): editing it must
  // overwrite the block WITHOUT touching the key.
  writeConfig({ providers: { riverfake: { name: 'River Fake', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://lama/v1' }, models: { lama: {} }, env: ['RIVERFAKE_API_KEY'] } } });
  writeIntegrations([{ id: 'riverfake', name: 'River Fake', methods: [{ type: 'key' }], connections: [{ id: 'cred-rf', type: 'credential', label: 'API key', method: 'key' }] }]);
  const before = existsSync(CONNECT_LOG) ? readFileSync(CONNECT_LOG, 'utf8') : '';
  const res = await call('/api/opencode/custom/add', { id: 'riverfake', name: 'River AI', baseURL: 'https://baru/v1', key: '', models: ['baru-1'] });
  assert.equal(res.status, 200, res.body);
  const view = readOpenCodeConfig({ scope: 'global', home: HOME });
  assert.equal(view.config.providers.riverfake.settings.baseURL, 'https://baru/v1', 'blok diperbarui');
  assert.deepEqual(view.config.providers.riverfake.models, { 'baru-1': {} }, 'model diperbarui');
  assert.equal(existsSync(CONNECT_LOG) ? readFileSync(CONNECT_LOG, 'utf8') : '', before, 'connect.key tidak dipanggil: key lama dipertahankan');
});

test('add: tanpa key tetap ditolak saat provider belum punya kredensial', async () => {
  resetConfig();
  // The block exists but is logged out (no connections): an empty key cannot produce a usable provider.
  writeConfig({ providers: { riverfake: { name: 'River Fake', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://lama/v1' }, models: { lama: {} }, env: ['RIVERFAKE_API_KEY'] } } });
  const res = await call('/api/opencode/custom/add', { id: 'riverfake', name: 'River AI', baseURL: 'https://baru/v1', key: '', models: ['baru-1'] });
  assert.equal(res.status, 400);
  const view = readOpenCodeConfig({ scope: 'global', home: HOME });
  assert.equal(view.config.providers.riverfake.settings.baseURL, 'https://lama/v1', 'blok tidak berubah oleh tolakan');
});

test('custom/test: ping /models milik blok tersimpan; id tidak dikenal 404; validasi 400', async () => {
  resetConfig();
  writeConfig({ providers: { riverfake: { name: 'River Fake', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${httpPort}` }, models: { m1: {}, m2: {} }, env: ['RIVERFAKE_API_KEY'] } } });
  const res = await call('/api/opencode/custom/test', { id: 'riverfake' });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(res.json(), { ok: true, status: 200, models: 2 }, 'm1/m2 valid (duplikat & id kotor dihitung satu)');

  // A wrong path answers HTTP 404: still reachable (the base URL is right up to the port).
  resetConfig();
  writeConfig({ providers: { riverfake: { name: 'River Fake', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${httpPort}/v1` }, models: { m1: {} }, env: ['RIVERFAKE_API_KEY'] } } });
  const miss = await call('/api/opencode/custom/test', { id: 'riverfake' });
  assert.equal(miss.status, 200);
  assert.deepEqual(miss.json(), { ok: true, reachable: true, status: 404 }, 'HTTP apa pun berarti terjangkau');

  // A closed port: not reachable, a safe inline error (no stack, no URL echo).
  resetConfig();
  writeConfig({ providers: { riverfake: { name: 'River Fake', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${closedPort}` }, models: { m1: {} }, env: ['RIVERFAKE_API_KEY'] } } });
  const down = await call('/api/opencode/custom/test', { id: 'riverfake' });
  assert.equal(down.status, 200);
  assert.equal(down.json().ok, false);
  assert.match(down.json().error, /tidak bisa dihubungi/);
  assert.doesNotMatch(down.json().error, /127\.0\.0\.1/);

  const unknown = await call('/api/opencode/custom/test', { id: 'tidak-ada' });
  assert.equal(unknown.status, 404, 'id tanpa blok kustom 404');
  const bad = await call('/api/opencode/custom/test', { id: 'id dengan spasi' });
  assert.equal(bad.status, 400, 'id tak valid 400');
});

test('providers: blok kustom milik aplikasi membawa data Edit (baseURL + models) untuk form prefill', async () => {
  resetConfig();
  writeConfig({ providers: { riverfake: { name: 'River Fake', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://lama/v1' }, models: { lama: {}, 'baru-2': {} }, env: ['RIVERFAKE_API_KEY'] } } });
  writeIntegrations([{ id: 'riverfake', name: 'River Fake', methods: [{ type: 'key' }], connections: [{ id: 'cred-rf', type: 'credential', label: 'API key', method: 'key' }] }]);
  const res = await call('/api/opencode/providers');
  assert.equal(res.status, 200, res.body);
  const body = res.json();
  const rf = body.connected.find((p) => p.id === 'riverfake');
  assert.ok(rf, 'riverfake terhubung');
  assert.equal(rf.custom, true, 'ditandai custom');
  assert.deepEqual(rf.edit, { baseURL: 'https://lama/v1', models: ['lama', 'baru-2'] }, 'prefill Edit dari blok tersimpan');
  const notCustom = body.connected.find((p) => p.id === 'opencode-go');
  if (notCustom) assert.equal(notCustom.edit, undefined, 'provider bukan blok aplikasi tidak membawa edit');
});

// ---------- addCustomProvider (unit) ----------

test('addCustomProvider: derived env name, blok lain tetap, backup berisi isi lama, return { ok, path, backup }', () => {
  resetConfig();
  writeConfig({ model: 'x', providers: { keep: { name: 'Keep' } } });
  const saved = addCustomProvider({ id: 'my-cool.1', name: 'My Cool', baseURL: 'https://api.example.test/v1', models: ['m-1'], home: HOME, dataDir: DATA });
  assert.equal(saved.ok, true);
  assert.equal(saved.path, CONFIG_FILE);
  assert.ok(existsSync(saved.backup), 'backup ada');
  assert.match(readFileSync(saved.backup, 'utf8'), /"Keep"/, 'backup = isi file sebelumnya');
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  assert.equal(config.model, 'x');
  assert.deepEqual(config.providers.keep, { name: 'Keep' });
  assert.deepEqual(config.providers['my-cool.1'], {
    name: 'My Cool',
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: 'https://api.example.test/v1' },
    models: { 'm-1': {} },
    env: ['MY_COOL_1_API_KEY'],
  });
});

test('addCustomProvider: menolak id rusak dan config yang tidak parse (400)', () => {
  writeFileSync(CONFIG_FILE, '{ broken\n');
  assert.throws(() => addCustomProvider({ id: 'x', name: 'X', baseURL: 'https://a/v1', models: ['m'], home: HOME, dataDir: DATA }), /Config OpenCode global/);
  writeConfig({});
  assert.throws(() => addCustomProvider({ id: '__proto__', name: 'X', baseURL: 'https://a/v1', models: ['m'], home: HOME, dataDir: DATA }), /ID provider/);
});

// ---------- removeCustomProvider (unit) ----------

test('removeCustomProvider: blok hilang, providers kosong ikut dihapus, backup berisi lama, blok tanpa package boleh', () => {
  resetConfig();
  writeConfig({ model: 'x', providers: { only: { name: 'Only', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://x/v1' } } } });
  const removed = removeCustomProvider({ id: 'only', home: HOME, dataDir: DATA });
  assert.equal(removed.ok, true);
  assert.equal(removed.path, CONFIG_FILE);
  assert.ok(existsSync(removed.backup), 'backup ada');
  assert.match(readFileSync(removed.backup, 'utf8'), /"Only"/, 'backup = isi file sebelumnya');
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  assert.equal(config.model, 'x', 'key lain tetap');
  assert.equal(config.providers, undefined, 'providers yang jadi kosong ikut dihapus');
  writeConfig({ providers: { bare: { name: 'Bare', settings: { baseURL: 'https://y/v1' } } } });
  assert.equal(removeCustomProvider({ id: 'bare', home: HOME, dataDir: DATA }).ok, true, 'blok tanpa package boleh dihapus');
});

test('removeCustomProvider: id rusak (400), id tidak ada (404), config tidak parse (400), package lain (409)', () => {
  writeConfig({});
  assert.throws(() => removeCustomProvider({ id: 'bad id', home: HOME, dataDir: DATA }), (err) => err.status === 400);
  assert.throws(() => removeCustomProvider({ id: 'nope', home: HOME, dataDir: DATA }), (err) => err.status === 404);
  writeFileSync(CONFIG_FILE, '{ broken\n');
  assert.throws(() => removeCustomProvider({ id: 'x', home: HOME, dataDir: DATA }), /Config OpenCode global/);
  writeConfig({ providers: { river: { name: 'River', package: 'user/pkg' } } });
  assert.throws(() => removeCustomProvider({ id: 'river', home: HOME, dataDir: DATA }), (err) => err.status === 409);
});
