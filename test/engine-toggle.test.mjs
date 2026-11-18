// 🧭 Claude Code on/off (src/hub.js, src/routes/misc.js): one persisted flag, refusable while a Claude turn runs,
// and new projects start on OpenCode while it is off. Pure router/hub with fakes: no server, no CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/hub.js';
import { buildRouter } from '../src/routes/index.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = readFileSync(path.join(APP, 'server.js'), 'utf8');
const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-engine-toggle-'));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

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
async function call(p, body, ctx) {
  const m = router.match('POST', p);
  assert.ok(m, `${p} harus terdaftar`);
  const res = fakeRes();
  await m.route.handler(ctx, { headers: {} }, res, m.params, body);
  return res;
}

test('hub: Claude is on by default, the switch persists, and new projects start on OpenCode while it is off', () => {
  const dir = tmp();
  const hub = new Hub({ dataDir: dir });
  assert.equal(hub.claudeEnabled(), true, 'default: Claude available (the switch is one tap away)');
  assert.equal(hub.defaultEngine(), 'claude');
  hub.setClaudeEnabled(false);
  assert.equal(hub.claudeEnabled(), false);
  assert.equal(hub.defaultEngine(), 'opencode', 'a new project must not start on a disabled engine');
  // A project that already runs on Claude keeps it: nothing is moved behind the user's back.
  hub.updateSettings('p1', { engine: 'claude', model: 'opus' });
  assert.equal(hub.engineOf('p1'), 'claude');
  assert.equal(hub.settingsFor('p1').model, 'opus', 'its model is untouched while Claude is off');
  // Persisted with the rest of the state (and restored with a backup later).
  hub.save();
  const again = new Hub({ dataDir: dir });
  assert.equal(again.claudeEnabled(), false);
  again.setClaudeEnabled(true);
  assert.equal(again.claudeEnabled(), true);
  assert.equal(again.defaultEngine(), 'claude');
});

test('route /api/engines/claude: a boolean is required; a busy Claude project refuses turning it off', async () => {
  const calls = [];
  const hub = {
    runtime: new Map([['p1', { status: { busy: true } }]]),
    projects: new Map([['p1', { id: 'p1', name: 'Toko' }]]),
    engineOf: () => 'claude',
    claudeEnabled: () => true,
    setClaudeEnabled: (on) => (calls.push(on), on),
  };
  const base = { hub, refreshProjects: () => calls.push('refresh') };
  assert.equal((await call('/api/engines/claude', {}, base)).status, 400);
  assert.equal((await call('/api/engines/claude', { enabled: 'nope' }, base)).status, 400);
  const busy = await call('/api/engines/claude', { enabled: false }, base);
  assert.equal(busy.status, 409, busy.body);
  assert.match(busy.json().error, /Toko/, 'names the busy project');
  assert.deepEqual(calls, [], 'nothing changed while a Claude turn runs');
  // Idle: the switch is stored and the config goes out to every page.
  hub.runtime.clear();
  const ok = await call('/api/engines/claude', { enabled: false }, base);
  assert.equal(ok.status, 200, ok.body);
  assert.deepEqual(ok.json(), { enabled: false });
  assert.deepEqual(calls, [false, 'refresh']);
});

test('server gate: the switch is admin over Tailscale only (never plain WiFi)', () => {
  const secureAdmin = SERVER.match(/const SECURE_ADMIN = new Set\(\[([^\]]*)\]\)/)?.[1] ?? '';
  assert.ok(secureAdmin.includes("'/api/engines/claude'"), 'the switch must be in SECURE_ADMIN');
  assert.equal((/LOCAL_ONLY[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(SERVER)?.[1] ?? '').includes("'/api/engines/claude'"), false, 'a phone over Tailscale may flip it');
  assert.match(SERVER, /enabled: hub\.claudeEnabled\(\)/, 'the config tells the UI about the flag');
});

test('prompt route: a Claude project refuses to start while Claude is switched off', () => {
  const source = readFileSync(path.join(APP, 'src/routes/session.js'), 'utf8');
  assert.match(source, /hub\.engineOf\(project\.id\) === 'claude' && hub\.claudeEnabled\?\.\(\) === false/);
  assert.match(source, /Claude Code sedang dinonaktifkan/);
});
