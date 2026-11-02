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

test('routes: only the backup import reads its own (non-JSON) body', () => {
  assert.deepEqual(router.routes.filter((r) => r.rawBody).map((r) => r.pattern), ['/api/backup/import']);
});

test('routes: 🔔 /api/push/* never over plain WiFi; only /api/push/act skips x-office-token; push bodies are small', () => {
  const pushRoutes = router.routes.filter((r) => r.pattern.startsWith('/api/push/'));
  assert.ok(pushRoutes.length >= 7, `${pushRoutes.length} push routes`);
  for (const r of pushRoutes) assert.ok(!wifiAllows(r.pattern), `${r.pattern} refused over WiFi`);
  assert.deepEqual(router.routes.filter((r) => r.noToken).map((r) => r.pattern), ['/api/push/act']);
  for (const r of pushRoutes) assert.ok(r.maxBody > 0 && r.maxBody <= 4096, `${r.pattern} maxBody ${r.maxBody}`);
  assert.equal(router.routes.find((r) => r.pattern === '/api/push/act').maxBody, 1024);
});

test('routes: 🧩 /api/claude-check/* (manual run, settings) never over plain WiFi; small bodies', () => {
  const routes = router.routes.filter((r) => r.pattern.startsWith('/api/claude-check/'));
  assert.deepEqual(routes.map((r) => r.pattern).sort(), ['/api/claude-check/run', '/api/claude-check/settings']);
  for (const r of routes) {
    assert.ok(!wifiAllows(r.pattern), `${r.pattern} refused over WiFi`);
    assert.ok(!WIFI_READS.has(r.pattern));
    assert.ok(r.maxBody > 0 && r.maxBody <= 1024, `${r.pattern} maxBody ${r.maxBody}`);
    assert.equal(r.noToken, false);
  }
  // Laptop only: server.js refuses them for every paired phone (Tailscale too) before the WiFi gate.
  const server = readFileSync(path.join(APP, 'server.js'), 'utf8');
  const localOnly = server.match(/const LOCAL_ONLY = new Set\(\[([^\]]*)\]\)/)[1];
  for (const r of routes) assert.ok(localOnly.includes(`'${r.pattern}'`), `${r.pattern} in LOCAL_ONLY`);
});
