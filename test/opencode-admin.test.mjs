// 🔌 `opencode service …` / `opencode reload` / `opencode debug …` from the app (src/opencode-admin.js + routes):
// the rest of what a terminal does with the service. Pure parsers + router calls against a tiny fake `opencode`.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { openCodeInfo, openCodeService, openCodeStats, parseDebugAgents, parseDebugPaths, reloadOpenCode } from '../src/opencode-admin.js';
import { buildRouter } from '../src/routes/index.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-oc-admin-'));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const FAKE = path.join(TMP, 'fake-opencode-admin.mjs');
writeFileSync(
  FAKE,
  `const args = process.argv.slice(2);
const out = (s) => console.log(s);
if (args[0] === 'debug' && args[1] === 'paths') out('home       C:\\\\Users\\\\uji\\ndata       C:\\\\Users\\\\uji\\\\.local\\\\share\\\\opencode\\nconfig     C:\\\\Users\\\\uji\\\\.config\\\\opencode');
else if (args[0] === 'debug' && args[1] === 'agents') out(JSON.stringify([{ id: 'build', name: 'Build', mode: 'primary' }, { id: 'plan', name: 'Plan', mode: 'primary', hidden: true }, { id: 'bad id', name: 'x' }, { id: 'ok', name: 'Ok', mode: 'weird' }]));
else if (args[0] === 'service') out(args[1] === 'status' ? 'running (pid 123)' : 'service ' + args[1] + ' ok');
else if (args[0] === 'stats') out('opencode stats · last ' + (args.includes('--all') ? 'lifetime' : args[args.indexOf('--days') + 1]) + ' days' + (args.includes('--models') ? ' · models' : ''));
else if (args[0] === 'reload') out('config reloaded');
else { console.error('Operation not found'); process.exit(1); }
`,
);
const BIN = { command: process.execPath, args: [FAKE] };

const router = buildRouter();
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
const call = async (p, body, ctx) => {
  const m = router.match('POST', p);
  assert.ok(m, `${p} harus terdaftar`);
  const res = fakeRes();
  await m.route.handler(ctx, { headers: {} }, res, m.params, body);
  return res;
};
const CTX = { opencode: BIN, opencodeCheck: { publicView: () => ({ running: false }) }, sessions: { sessions: new Map() } };

test('parseDebugPaths / parseDebugAgents: the CLI output, nothing else', () => {
  assert.deepEqual(parseDebugPaths('data       C:\\x\\.local\\.share\nconfig  C:\\x\\.config'), [
    { label: 'data', path: 'C:\\x\\.local\\.share' },
    { label: 'config', path: 'C:\\x\\.config' },
  ]);
  assert.deepEqual(parseDebugPaths('bukan tabel'), []);
  const agents = parseDebugAgents(JSON.stringify([{ id: 'build', name: 'Build', mode: 'primary' }, { id: 'bad id' }, { id: 'sub', mode: 'subagent', hidden: true }, { id: 'weird', mode: 'nope' }]));
  assert.deepEqual(agents.map((a) => a.id), ['build', 'sub', 'weird'], 'invalid ids dropped');
  assert.equal(agents[1].hidden, true);
  assert.equal(agents[2].mode, '', 'unknown mode is not trusted');
  assert.deepEqual(parseDebugAgents('not json'), []);
});

test('openCodeService: known actions run, an unknown one is refused before spawning anything', async () => {
  assert.deepEqual(await openCodeService(BIN, 'status'), { ok: true, action: 'status', output: 'running (pid 123)' });
  assert.equal((await openCodeService(BIN, 'stop')).ok, true);
  await assert.rejects(() => openCodeService(BIN, 'kill'), (err) => err.status === 400);
  assert.equal((await reloadOpenCode(BIN)).ok, true);
  const info = await openCodeInfo(BIN);
  assert.equal(info.paths.length, 3);
  assert.deepEqual(info.agents.map((a) => a.id), ['build', 'plan', 'ok']);
  assert.match(info.service, /running \(pid 123\)/);
});

test('openCodeStats + route: the CLI report is read-only and its range is validated', async () => {
  assert.match((await openCodeStats(BIN, { days: 7 })).text, /last 7 days/);
  assert.match((await openCodeStats(BIN, { all: true })).text, /lifetime/);
  assert.match((await openCodeStats(BIN, { days: 7, models: true })).text, /models/);
  const ok = await call('/api/opencode-stats', { days: 7, models: true, cost: true }, CTX);
  assert.equal(ok.status, 200, ok.body);
  assert.match(ok.json().text, /last 7 days · models/);
  assert.equal((await call('/api/opencode-stats', {}, CTX)).status, 400, 'a range is required');
  const all = await call('/api/opencode-stats', { all: true }, CTX);
  assert.match(all.json().text, /lifetime/);
});

test('routes: service status is read-only; start/stop refuse mid-turn; reload and info answer', async () => {
  const status = await call('/api/opencode-service', { action: 'status' }, CTX);
  assert.equal(status.status, 200, status.body);
  assert.match(status.json().output, /running/);
  const unknown = await call('/api/opencode-service', { action: 'kill' }, CTX);
  assert.equal(unknown.status, 400);
  // A running turn owns the service: nothing may be started/stopped under it.
  const busy = { ...CTX, sessions: { sessions: new Map([['p1', { turnActive: () => true }]]) } };
  assert.equal((await call('/api/opencode-service', { action: 'stop' }, busy)).status, 409);
  assert.equal((await call('/api/opencode-reload', {}, busy)).status, 409);
  assert.equal((await call('/api/opencode-service', { action: 'start' }, CTX)).status, 200);
  assert.equal((await call('/api/opencode-reload', {}, CTX)).status, 200);
  const info = await call('/api/opencode-info', {}, CTX);
  assert.equal(info.status, 200, info.body);
  assert.equal(info.json().agents.length, 3);
  assert.equal((await call('/api/opencode-info', {}, { ...CTX, opencode: null })).status, 404);
});
