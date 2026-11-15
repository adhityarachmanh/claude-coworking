// The API router (src/routes/*.js): every registered route against the plain-WiFi read-only allowlist
// (src/remote.js wifiAllows), plus the tiny router itself. No server needed: registering touches no state.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WIFI_READ_API, wifiAllows } from '../src/remote.js';
import { buildRouter } from '../src/routes/index.js';
import { Router, samplePath } from '../src/routes/router.js';

// The only routes a paired phone on plain-HTTP WiFi may call. Adding a route here is a security decision:
// it must also be added to wifiAllows (src/remote.js), and the reason documented there.
const WIFI_READS = new Set([
  '/api/account',
  '/api/account/limits',
  '/api/report/accounts',
  '/api/report/summary',
  '/api/report/pdf',
  '/api/templates',
  '/api/team/roster',
  '/api/spotify/state', // ♪ now-playing (already audible in the room) and its album art; never devices/playlists/control
  '/api/spotify/art',
  '/api/files/search', // project file-name index across projects (Ctrl+P); names only
  '/api/queues', // global queue view: the same prompt texts each project's queue read already exposes
  ...['changes', 'diff', 'git-branches', 'file', 'files', 'sessions', 'rewind-points', 'task-output', 'task-detail', 'queue'].map((a) => `/api/projects/:id/${a}`),
]);

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const router = buildRouter();
const patterns = router.routes.map((r) => r.pattern);
/** Concrete paths for a route: several ids for :id, and a few suffixes for a prefix (*) route. */
const pathsOf = (pattern) => {
  const ids = ['x', 'toko-1_A', 'demo'].map((id) => samplePath(pattern, id));
  return pattern.endsWith('*') ? ids.flatMap((p) => [p, `${p}x`, `${p}/zzz`]) : ids;
};

test('routes: every route is POST and registered once', () => {
  assert.ok(router.routes.length >= 60, `${router.routes.length} routes`);
  for (const r of router.routes) assert.equal(r.method, 'POST', r.pattern);
  assert.equal(new Set(patterns).size, patterns.length, 'no pattern registered twice');
});

test('routes over plain WiFi: every non-read route is refused (default deny), the listed reads pass', () => {
  for (const pattern of patterns) {
    for (const p of pathsOf(pattern)) assert.equal(wifiAllows(p), WIFI_READS.has(pattern), `${pattern} → ${p}`);
  }
  // No stale entry: each listed read is a real route, and so is every path the allowlist names.
  for (const read of WIFI_READS) assert.ok(patterns.includes(read), `listed read ${read} is registered`);
  for (const p of WIFI_READ_API.paths) assert.ok(patterns.includes(p), `allowlisted ${p} is registered`);
  // The non-reads, spelled out: the gate refuses each one over WiFi.
  const actions = patterns.filter((p) => !WIFI_READS.has(p));
  assert.ok(actions.length > 40 && actions.every((p) => pathsOf(p).every((path) => !wifiAllows(path))));
});

test('routes: 🎛️ /api/models/prices is registered but never allowed over plain WiFi', () => {
  assert.ok(patterns.includes('/api/models/prices'), 'registered');
  assert.equal(wifiAllows('/api/models/prices'), false, 'laptop + Tailscale only: it carries prices, not a read model');
});

test('routes: an unregistered path matches nothing (server.js answers 404) and is refused over WiFi', () => {
  for (const p of ['/api/nope', '/api/projects/x', '/api/projects/x/nope', '/api/projects/x/queue-nope', '/api/projects/x/queue-', '/api/remote/nope', '/api/templates/', '/api/projects/a/b/files']) {
    assert.equal(router.match('POST', p), null, p);
    assert.ok(!wifiAllows(p), p);
  }
});

test('router: literal paths, :params of [\\w-]+, a trailing * prefix, first match wins', () => {
  const r = new Router();
  const a = () => 'a';
  const b = () => 'b';
  r.post('/api/x.y', a).post('/api/p/:id/do', a).post('/api/s/exact', a).post('/api/s*', b).add('GET', '/api/g', a);
  assert.equal(r.match('POST', '/api/x.y').route.handler, a);
  assert.equal(r.match('POST', '/api/xzy'), null, 'a dot is literal');
  assert.deepEqual(r.match('POST', '/api/p/ab-c_1/do').params, { id: 'ab-c_1' });
  for (const p of ['/api/p//do', '/api/p/a.b/do', '/api/p/a/b/do', '/api/p/a/do/']) assert.equal(r.match('POST', p), null, p);
  assert.equal(r.match('POST', '/api/s/exact').route.handler, a, 'registered first, wins over the prefix');
  for (const p of ['/api/s', '/api/sx', '/api/s/exact/more']) assert.equal(r.match('POST', p).route.handler, b, p);
  assert.equal(r.match('POST', '/api/g'), null, 'method must match');
  assert.equal(r.match('GET', '/api/g').route.handler, a);
  assert.equal(samplePath('/api/p/:id/do', 'q'), '/api/p/q/do');
  assert.equal(samplePath('/api/s*'), '/api/s');
});

test('routes: backup import/preview/verify/rekey read their own (non-JSON) body', () => {
  assert.deepEqual(router.routes.filter((r) => r.rawBody).map((r) => r.pattern).sort(), ['/api/backup/import', '/api/backup/preview', '/api/backup/rekey', '/api/backup/verify']);
});

test('routes: 🔔 /api/push/* never over plain WiFi; only /api/push/act carries its own proof; push bodies are small', () => {
  const pushRoutes = router.routes.filter((r) => r.pattern.startsWith('/api/push/'));
  assert.ok(pushRoutes.length >= 7, `${pushRoutes.length} push routes`);
  for (const r of pushRoutes) assert.ok(!wifiAllows(r.pattern), `${r.pattern} refused over WiFi`);
  assert.deepEqual(router.routes.filter((r) => r.token === 'none').map((r) => r.pattern), ['/api/cli-bridge/token', '/api/push/act']);
  for (const r of pushRoutes) assert.ok(r.maxBody > 0 && r.maxBody <= 4096, `${r.pattern} maxBody ${r.maxBody}`);
  assert.equal(router.routes.find((r) => r.pattern === '/api/push/act').maxBody, 1024);
});

test('routes: 🧩 /api/claude-check/* (manual run, settings) never over plain WiFi; small bodies', () => {
  const routes = router.routes.filter((r) => r.pattern.startsWith('/api/claude-check/'));
  assert.deepEqual(routes.map((r) => r.pattern).sort(), ['/api/claude-check/doctor', '/api/claude-check/run', '/api/claude-check/settings', '/api/claude-check/update']);
  for (const r of routes) {
    assert.ok(!wifiAllows(r.pattern), `${r.pattern} refused over WiFi`);
    assert.ok(!WIFI_READS.has(r.pattern));
    assert.ok(r.maxBody > 0 && r.maxBody <= 1024, `${r.pattern} maxBody ${r.maxBody}`);
    assert.equal(r.token, 'office');
  }
  // Remote admin: a paired phone may change these over Tailscale (https), never over plain WiFi.
  const server = readFileSync(path.join(APP, 'server.js'), 'utf8');
  const secureAdmin = server.match(/const SECURE_ADMIN = new Set\(\[([^\]]*)\]\)/)[1];
  for (const r of routes) assert.ok(secureAdmin.includes(`'${r.pattern}'`), `${r.pattern} in SECURE_ADMIN`);
});

test('routes: 🧩 /api/opencode-check/* (manual run, settings) boleh dari HP lewat Tailscale, tidak pernah lewat WiFi; small bodies', () => {
  const routes = router.routes.filter((r) => r.pattern.startsWith('/api/opencode-check/'));
  assert.deepEqual(routes.map((r) => r.pattern).sort(), ['/api/opencode-check/restart-service', '/api/opencode-check/run', '/api/opencode-check/settings', '/api/opencode-check/update']);
  const server = readFileSync(path.join(APP, 'server.js'), 'utf8');
  const secureAdmin = server.match(/const SECURE_ADMIN = new Set\(\[([^\]]*)\]\)/)[1];
  for (const r of routes) {
    assert.equal(r.method, 'POST');
    assert.ok(!wifiAllows(r.pattern), `${r.pattern} refused over WiFi`);
    assert.ok(!WIFI_READS.has(r.pattern));
    assert.ok(r.maxBody > 0 && r.maxBody <= 1024, `${r.pattern} maxBody ${r.maxBody}`);
    assert.equal(r.token, 'office');
    assert.ok(secureAdmin.includes(`'${r.pattern}'`), `${r.pattern} in SECURE_ADMIN`);
  }
});

test('routes: 🧰 /api/setup/* — status/refresh are laptop+Tailscale, the three mutations are laptop only', () => {
  const routes = router.routes.filter((r) => r.pattern.startsWith('/api/setup/'));
  assert.deepEqual(routes.map((r) => r.pattern).sort(), [
    '/api/setup/cancel',
    '/api/setup/install',
    '/api/setup/login-terminal',
    '/api/setup/refresh',
    '/api/setup/status',
  ]);
  const server = readFileSync(path.join(APP, 'server.js'), 'utf8');
  const localOnly = server.match(/const LOCAL_ONLY = new Set\(\[([^\]]*)\]\)/)[1];
  for (const r of routes) {
    assert.equal(r.method, 'POST');
    assert.ok(!wifiAllows(r.pattern), `${r.pattern} refused over WiFi`);
    assert.ok(!WIFI_READS.has(r.pattern));
    assert.ok(r.maxBody > 0 && r.maxBody <= 1024, `${r.pattern} maxBody ${r.maxBody}`);
    // Everything but the three mutations is reachable from a Tailscale phone; all need this start's token.
    assert.equal(r.token, 'office', `${r.pattern} needs the office token`);
  }
  for (const mutation of ['/api/setup/install', '/api/setup/cancel', '/api/setup/login-terminal']) {
    assert.ok(localOnly.includes(`'${mutation}'`), `${mutation} in LOCAL_ONLY`);
  }
  // The status route (like every office route) is behind the x-office-token check in server.js: no token → 403.
  assert.equal(routes.find((r) => r.pattern === '/api/setup/status').token, 'office');
  assert.match(server, /req\.headers\['x-office-token'\] !== TOKEN/);
  assert.ok(!localOnly.includes("'/api/setup/status'"), 'status stays available over Tailscale');
  assert.ok(!localOnly.includes("'/api/setup/refresh'"), 'refresh stays available over Tailscale');
});

test('routes: 📱 /api/wa/* — status/lepas/uji lewat Tailscale; link (QR) tetap laptop saja', () => {
  const routes = router.routes.filter((r) => r.pattern.startsWith('/api/wa/'));
  assert.deepEqual(routes.map((r) => r.pattern).sort(), ['/api/wa/link', '/api/wa/status', '/api/wa/test', '/api/wa/unlink']);
  const server = readFileSync(path.join(APP, 'server.js'), 'utf8');
  const localOnly = server.match(/const LOCAL_ONLY = new Set\(\[([^\]]*)\]\)/)[1];
  const secureAdmin = server.match(/const SECURE_ADMIN = new Set\(\[([^\]]*)\]\)/)[1];
  for (const r of routes) {
    assert.equal(r.method, 'POST');
    assert.ok(!wifiAllows(r.pattern), `${r.pattern} refused over WiFi`);
    assert.ok(!WIFI_READS.has(r.pattern));
    assert.ok(r.maxBody > 0 && r.maxBody <= 1024, `${r.pattern} maxBody ${r.maxBody}`);
    assert.equal(r.token, 'office');
    // The QR is a session credential: linking stays on the laptop (the status handler hides the QR from phones).
    if (r.pattern === '/api/wa/link') assert.ok(localOnly.includes(`'${r.pattern}'`), `${r.pattern} in LOCAL_ONLY`);
    else assert.ok(secureAdmin.includes(`'${r.pattern}'`), `${r.pattern} in SECURE_ADMIN`);
  }
  // GET /api/wa/status is served by server.js itself (the router only dispatches POST), behind the same gate.
  assert.match(server, /pathname === '\/api\/wa\/status' && req\.method === 'GET'/);
});

test('routes: 🧩 OpenCode config editor boleh dari HP lewat Tailscale, dengan body JSON yang dibatasi', () => {
  const routes = router.routes.filter((r) => r.pattern.startsWith('/api/opencode-config'));
  assert.deepEqual(routes.map((r) => r.pattern).sort(), [
    '/api/opencode-config',
    '/api/opencode-config/backup',
    '/api/opencode-config/backups',
    '/api/opencode-config/consolidate',
    '/api/opencode-config/restore',
    '/api/opencode-config/save',
  ]);
  const server = readFileSync(path.join(APP, 'server.js'), 'utf8');
  const secureAdmin = server.match(/const SECURE_ADMIN = new Set\(\[([^\]]*)\]\)/)[1];
  for (const r of routes) {
    assert.equal(r.method, 'POST');
    assert.ok(!wifiAllows(r.pattern), `${r.pattern} refused over WiFi`);
    assert.ok(!WIFI_READS.has(r.pattern));
    assert.ok(r.maxBody > 0 && r.maxBody <= 1024 * 1024, `${r.pattern} maxBody ${r.maxBody}`);
    assert.equal(r.token, 'office');
    assert.ok(secureAdmin.includes(`'${r.pattern}'`), `${r.pattern} in SECURE_ADMIN`);
  }
});

// The Windows build bundles server.js to CommonJS (scripts/build-windows.mjs, `format: 'cjs'`), where esbuild
// refuses a top-level `await`. The autologon CLI branch therefore runs before the listener through the blocking
// `helperMainSync`; a promise there would either start the server or break the build.
test('routes: 🪟 autologon CLI branch is blocking, before the listener, with no top-level await', () => {
  const server = readFileSync(path.join(APP, 'server.js'), 'utf8');
  assert.match(server, /process\.exit\(helperMainSync\(process\.argv\)\)/, 'the one-shot CLI uses the blocking helper');
  assert.ok(
    server.indexOf('helperMainSync(process.argv)') < server.indexOf('server.listen('),
    'the CLI branch runs before any listener',
  );
  assert.equal(/^await /m.test(server), false, 'top-level await would break the CommonJS Windows build');
});

test('routes: 🪟 /api/autologon* is laptop only, never over plain WiFi, with a small JSON body', () => {
  const routes = router.routes.filter((r) => r.pattern.startsWith('/api/autologon'));
  assert.deepEqual(routes.map((r) => r.pattern).sort(), ['/api/autologon', '/api/autologon/disable']);
  const server = readFileSync(path.join(APP, 'server.js'), 'utf8');
  const localOnly = server.match(/const LOCAL_ONLY = new Set\(\[([^\]]*)\]\)/)[1];
  for (const r of routes) {
    assert.equal(r.method, 'POST');
    assert.ok(!wifiAllows(r.pattern), `${r.pattern} refused over WiFi`);
    assert.ok(!WIFI_READS.has(r.pattern));
    // The body is one Windows password, never anything else.
    assert.ok(r.maxBody > 0 && r.maxBody <= 1024, `${r.pattern} maxBody ${r.maxBody}`);
    assert.equal(r.token, 'office');
    // A paired phone (Tailscale too) must never change how the PC logs in.
    assert.ok(localOnly.includes(`'${r.pattern}'`), `${r.pattern} in LOCAL_ONLY`);
  }
});
