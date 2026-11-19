// The prompt route's pre-turn gate for a model whose provider OpenCode knows but is not connected to: refused with a
// 409 (code `provider-not-connected`) BEFORE a turn starts, because OpenCode can only fail it at the first request
// with "Authentication required" (a 403 there may really be entitlement/network). A provider list that cannot be read
// never refuses (fail open), and a Claude project is untouched. The router is exercised with a hand-made ctx.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { buildRouter } from '../src/routes/index.js';
import { clearModelCache } from '../src/opencode-bin.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-provider-gate-'));
const CONFIG_HOME = path.join(TMP, 'xdg');
const HOME_CONFIG_DIR = path.join(CONFIG_HOME, 'opencode');
const INTEGRATIONS_FILE = path.join(TMP, 'integrations.json');
const STATE_FILE = path.join(TMP, 'provider-state.json');

process.env.OFFICE_OPENCODE_CONFIG_HOME = CONFIG_HOME;
process.env.FAKE_GATE_INTEGRATIONS = INTEGRATIONS_FILE;
process.env.FAKE_GATE_STATE = STATE_FILE;

after(() => {
  delete process.env.OFFICE_OPENCODE_CONFIG_HOME;
  delete process.env.FAKE_GATE_INTEGRATIONS;
  delete process.env.FAKE_GATE_STATE;
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---------- a fake `opencode` bin: ONLY integration.list (the provider gate reads nothing else) ----------

const FAKE_BIN = path.join(TMP, 'fake-opencode-gate.mjs');
writeFileSync(
  FAKE_BIN,
  `#!/usr/bin/env node
// FAKE_GATE_STATE=missing → exit 1 (the provider list cannot be read); otherwise integration.list from the fixtures.
// integration.connect.key records the attempt and answers ok WITHOUT adding a connection unless the fixture file
// already lists one (the real "key accepted but the provider never becomes connected" case).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const op = process.argv[3];
const fail = (msg) => (console.error(msg), process.exit(1));
const file = process.env.FAKE_GATE_INTEGRATIONS;
const list = () => (file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);
if (op === 'integration.connect.key') {
  if (process.env.FAKE_GATE_CONNECT_LOG) appendFileSync(process.env.FAKE_GATE_CONNECT_LOG, 'connect\\n');
  console.log(JSON.stringify({ location: { directory: process.cwd() }, data: null }));
  process.exit(0);
}
if (!op || !op.startsWith('integration.list')) fail('Operation not found: ' + op);
const state = process.env.FAKE_GATE_STATE;
if (state && existsSync(state)) {
  const mode = readFileSync(state, 'utf8').trim();
  if (mode === 'missing') fail('UnknownError: layanan OpenCode belum siap');
}
console.log(JSON.stringify({ location: { directory: process.cwd() }, data: list() }));
`,
);
const BIN = { command: process.execPath, args: [FAKE_BIN] };

const router = buildRouter();

const BASE_PROVIDERS = [
  { id: 'opencode-go', name: 'OpenCode Go', methods: [{ type: 'key' }], connections: [{ type: 'credential', id: 'cred_1', label: 'Default', method: 'key' }] },
  { id: 'wally', name: 'Wally', methods: [{ type: 'key' }], connections: [] },
];

function fixtures(list = BASE_PROVIDERS, state = null) {
  mkdirSync(HOME_CONFIG_DIR, { recursive: true });
  writeFileSync(INTEGRATIONS_FILE, JSON.stringify(list));
  if (state) writeFileSync(STATE_FILE, state);
  else rmSync(STATE_FILE, { force: true });
  clearModelCache(); // the gate caches its provider list for a minute; each test starts clean
}

function fakeRes() {
  const res = { status: 200, body: '' };
  res.writeHead = (s) => {
    res.status = s;
    return res;
  };
  res.end = (b) => (res.body = String(b ?? ''));
  res.json = () => JSON.parse(res.body);
  return res;
}

/** A ctx that reaches the provider gate and nothing past it (a refused prompt must never touch session.prompt). */
function ctxFor({ engine = 'opencode', model = 'wally/deepseek-v4.1-flash' } = {}) {
  const prompted = [];
  const project = { id: 'p1', name: 'refina-smi', path: TMP };
  const hub = {
    dataDir: TMP,
    projects: new Map([['p1', project]]),
    persisted: {},
    runtime: new Map(),
    engineOf: () => engine,
    claudeEnabled: () => true,
    settingsFor: () => ({ engine, model, mode: 'build', team: false }),
    statusFor: () => ({}),
    statuses: {},
    chat: () => {},
    updateSettings: () => {},
  };
  return {
    ctx: {
      hub,
      opencode: BIN,
      claude: null,
      ledger: null,
      metrics: null,
      taskQueue: { pauseAll: () => {}, add: () => ({ id: 'q1' }), attachChat() {}, schedule() {}, view: () => ({ paused: false }), positionFor: () => 1 },
      sessions: { get: () => ({ busy: false, inflight: new Map(), prompt: (text) => prompted.push(text), syncSettings() {} }), openCodeAccountChanged() {} },
      device: null,
    },
    prompted,
  };
}

async function promptCall(ctx, body = { text: 'halo' }) {
  const m = router.match('POST', '/api/projects/p1/prompt');
  assert.ok(m, 'route /prompt harus terdaftar');
  const res = fakeRes();
  await m.route.handler(ctx, { headers: {} }, res, m.params, body);
  return res;
}

test('a known-but-not-connected provider is refused before the turn starts (409, provider-not-connected)', async () => {
  fixtures();
  const { ctx, prompted } = ctxFor();
  const res = await promptCall(ctx);
  assert.equal(res.status, 409, res.body);
  assert.equal(res.json().code, 'provider-not-connected');
  assert.match(res.json().error, /wally/, 'menyebut providernya');
  assert.match(res.json().error, /Login provider/, 'menyebut cara login');
  assert.deepEqual(prompted, [], 'tidak ada giliran yang dikirim');
});

test('a connected provider passes the gate; an unreadable provider list never refuses', async () => {
  fixtures();
  const connected = ctxFor({ model: 'opencode-go/beam-free' });
  assert.notEqual((await promptCall(connected.ctx)).status, 409, 'provider terhubung tidak ditolak');

  fixtures(BASE_PROVIDERS, 'missing');
  const unreadable = ctxFor();
  assert.notEqual((await promptCall(unreadable.ctx)).status, 409, 'daftar provider tak terbaca: lanjut, jangan menolak');
});

test('a Claude project is untouched by the OpenCode provider gate', async () => {
  fixtures();
  const { ctx } = ctxFor({ engine: 'claude', model: 'wally/deepseek-v4.1-flash' });
  assert.notEqual((await promptCall(ctx)).status, 409, 'engine Claude tidak ikut dipagari');
});

// ---------- POST /api/opencode/login/key: success only once OpenCode really lists the provider connected ----------

async function loginCall(ctx, body) {
  const m = router.match('POST', '/api/opencode/login/key');
  assert.ok(m, 'route /api/opencode/login/key harus terdaftar');
  const res = fakeRes();
  await m.route.handler(ctx, { headers: {} }, res, m.params, body);
  return res;
}

test('login key: a key the provider store accepts but never connects answers 502 instead of a false success', async () => {
  fixtures(); // wally has a key method and NO connection: exactly the dishonest "ok" case
  const res = await loginCall(ctxFor().ctx, { provider: 'wally', key: 'sk-benar' });
  assert.equal(res.status, 502, res.body);
  assert.match(res.json().error, /provider belum terhubung/);
  assert.match(res.json().error, /coba lagi/i, 'saran yang bisa ditindaklanjuti');
});

test('login key: a provider that OpenCode lists as connected answers 200 with the same shape as before', async () => {
  fixtures([
    { id: 'opencode-go', name: 'OpenCode Go', methods: [{ type: 'key' }], connections: [{ type: 'credential', id: 'cred_1', label: 'Default', method: 'key' }] },
    { id: 'wally', name: 'Wally', methods: [{ type: 'key' }], connections: [{ type: 'credential', id: 'cred_2', label: 'Default', method: 'key' }] },
  ]);
  const res = await loginCall(ctxFor().ctx, { provider: 'wally', key: 'sk-benar' });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(res.json(), { ok: true }, 'bentuk respons sukses tidak berubah');
});

test('login key: an unreadable provider list never turns a good login into a failure', async () => {
  fixtures(BASE_PROVIDERS, 'missing');
  const res = await loginCall(ctxFor().ctx, { provider: 'wally', key: 'sk-benar' });
  assert.equal(res.status, 200, res.body);
});
