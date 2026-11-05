// src/health.js: the system-health report (🩺 /api/health) against a fake ctx and a throwaway data dir.
// No server, no CLI: the log tail, the data size, every warn path and the "never throws" promise.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { buildHealth } from '../src/health.js';

const NOW = Date.parse('2026-11-05T03:00:00.000Z');
const HOUR = 3_600_000;
const MAX_BYTES = 1024 ** 3;

const temps = [];
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-health-'));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** A data dir with an optional server.log (the lines as given) and a few files. */
function makeData({ log = [], files = {} } = {}) {
  const dir = tempDir();
  if (log.length) writeFileSync(path.join(dir, 'server.log'), log.join('\n'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

const stamp = (ms) => new Date(ms).toISOString();
const errorLine = (ms, message) => `[${stamp(ms)}] ERROR ${message}`;
const infoLine = (ms, message) => `[${stamp(ms)}] INFO ${message}`;

const PROJECTS = tempDir();

/** A fake route ctx (server.js `ctx`) for a healthy office. `over` replaces any service. */
function fakeCtx(over = {}) {
  const dataDir = over.dataDir ?? makeData();
  const base = {
    appVersion: '9.9.9',
    port: 4317,
    account: { current: { id: 'acc-1', email: 'tester@example.com' }, profile: { loggedIn: true, subscriptionType: 'team' } },
    opencode: { command: 'opencode', args: [] },
    hub: {
      engine: 'claude',
      config: { engines: { opencode: { version: 'v1.2.3' } } },
      projects: new Map([
        ['demo', { id: 'demo', name: 'Demo kantor', path: null, sources: ['demo'], virtual: true }],
        ['toko', { id: 'toko', name: 'toko', path: path.join(PROJECTS, 'toko'), sources: ['root'] }],
      ]),
    },
    projectRoots: () => [PROJECTS],
    backupScheduler: {
      view: () => ({
        schedule: { enabled: true, frequency: 'daily', weekday: 1, time: '02:00', folder: 'D:\\Backup', keep: 7 },
        last: { at: NOW - HOUR, ok: true, name: 'adhit-office-backup-auto-20261105-020000.zip' },
        running: false,
        nextAt: NOW + HOUR,
      }),
    },
    remote: { enabled: true, publicInfo: () => ({ enabled: true, devices: [{ id: 'd1' }, { id: 'd2' }] }) },
    httpsInfo: () => ({ state: 'ok', host: 'laptop.tail.ts.net' }),
  };
  return { ...base, ...over, dataDir };
}

const checkOf = (health, id) => health.checks.find((c) => c.id === id);
const itemOf = (health, id) => health.checklist.find((c) => c.id === id);

test('health: a healthy office is all green', () => {
  const files = { 'state.json': 'a'.repeat(2048), 'chats/toko.jsonl': 'b'.repeat(1024) };
  const log = [infoLine(NOW - 2 * HOUR, 'mulai'), infoLine(NOW - 10 * 60_000, 'siap')];
  const dataDir = makeData({ files, log });
  const health = buildHealth(fakeCtx({ dataDir }), { now: NOW });

  assert.equal(health.at, NOW);
  assert.equal(health.app.version, '9.9.9');
  assert.equal(health.app.pid, process.pid);
  assert.ok(Number.isInteger(health.app.uptimeSec) && health.app.uptimeSec >= 0);
  assert.equal(health.app.engine, 'claude');
  assert.equal(health.app.port, 4317);

  assert.deepEqual(health.checks.map((c) => c.id), ['claude', 'opencode', 'projects', 'backup', 'remote', 'errors', 'data']);
  for (const check of health.checks) {
    assert.equal(check.ok, true, `${check.id}: ${check.detail}`);
    assert.equal(check.warn, undefined, `${check.id} is not a warning`);
    assert.equal(typeof check.label, 'string');
    assert.ok(check.label.length > 0, check.id);
    assert.equal(typeof check.detail, 'string');
  }
  assert.equal(checkOf(health, 'claude').detail, 'tester@example.com · paket team');
  assert.equal(checkOf(health, 'opencode').detail, 'Terpasang · v1.2.3');
  assert.equal(checkOf(health, 'projects').detail, '1 folder root · 1 project');
  assert.equal(checkOf(health, 'backup').detail, 'Terakhir 1 jam lalu · adhit-office-backup-auto-20261105-020000.zip');
  assert.equal(checkOf(health, 'remote').detail, 'Menyala · 2 perangkat · HTTPS laptop.tail.ts.net');
  assert.equal(checkOf(health, 'errors').detail, 'Tidak ada error dalam 24 jam terakhir');

  // Data: every file under dataDir, server.log included (the report counts what is on disk).
  const logBytes = Buffer.byteLength(log.join('\n'));
  assert.equal(health.data.dir, dataDir);
  assert.equal(health.data.files, 3);
  assert.equal(health.data.bytes, 2048 + 1024 + logBytes);
  assert.match(checkOf(health, 'data').detail, /· 3 file$/);

  // Onboarding: nothing left to do.
  assert.deepEqual(health.checklist.map((c) => c.id), ['login', 'project', 'backup', 'https', 'opencode']);
  for (const item of health.checklist) {
    assert.equal(item.done, true, item.id);
    assert.equal(typeof item.hint, 'string');
    assert.ok(item.hint.length > 0, item.id);
  }
});

test('health: only the last 24 h of ERROR lines count, and the last message is one line of 200 chars', () => {
  const long = `X${'y'.repeat(400)}`;
  const log = [
    errorLine(NOW - 30 * HOUR, 'terlalu lama, di luar jendela 24 jam'),
    errorLine(NOW - 3 * HOUR, 'pesan kedua'),
    errorLine(NOW - HOUR, long) + '\n    at rahasia (C:\\Users\\adhit\\projects\\rahasia.js:1:1)\n    at lain',
    infoLine(NOW - 5 * 60_000, 'masih hidup'),
  ];
  const health = buildHealth(fakeCtx({ dataDir: makeData({ log }) }), { now: NOW });

  assert.equal(health.errors.count24h, 2);
  assert.equal(health.errors.last.length, 200);
  assert.doesNotMatch(health.errors.last, /rahasia|at lain|\n/);
  const errors = checkOf(health, 'errors');
  assert.equal(errors.ok, false);
  assert.equal(errors.warn, true);
  assert.equal(errors.detail, '2 error dalam 24 jam terakhir');
  assert.equal(errors.hint, `Terakhir: ${health.errors.last}`);
  assert.doesNotMatch(JSON.stringify(health), /rahasia\.js/);
});

test('health: only the last 256 KB of server.log is read', () => {
  // A recent ERROR before 300 KB of INFO lines is outside the tail: the report does not count it.
  const filler = Array.from({ length: 3000 }, (_, i) => infoLine(NOW - 2 * HOUR + i, `${'x'.repeat(90)} ${i}`));
  const dir = makeData({ log: [errorLine(NOW - HOUR, 'tersembunyi di awal file'), ...filler] });
  const health = buildHealth(fakeCtx({ dataDir: dir }), { now: NOW });
  assert.equal(health.errors.count24h, 0);
  assert.equal(health.errors.last, null);
  assert.equal(checkOf(health, 'errors').ok, true);
});

test('health: an unlogged-in, unconfigured office warns without failing', () => {
  const ctx = fakeCtx({
    account: { current: null, profile: { loggedIn: false } },
    opencode: null,
    hub: {
      engine: 'claude',
      config: {},
      projects: new Map([['demo', { id: 'demo', name: 'Demo kantor', path: null, sources: ['demo'], virtual: true }]]),
    },
    backupScheduler: { view: () => ({ schedule: { enabled: false, folder: '' }, last: null }) },
    remote: { enabled: true, publicInfo: () => ({ enabled: true, devices: [{ id: 'd1' }] }) },
    httpsInfo: () => ({ state: 'no-tailscale' }),
  });
  const health = buildHealth(ctx, { now: NOW });

  const claude = checkOf(health, 'claude');
  assert.deepEqual([claude.ok, claude.detail], [false, 'Belum login']);
  assert.match(claude.hint, /⚙ → Akun/);
  assert.equal(itemOf(health, 'login').done, false);

  const opencode = checkOf(health, 'opencode');
  assert.deepEqual([opencode.ok, opencode.warn, opencode.detail], [false, true, 'Belum terpasang']);
  assert.equal(itemOf(health, 'opencode').done, false, 'optional item');

  const projects = checkOf(health, 'projects');
  assert.deepEqual([projects.ok, projects.warn, projects.detail], [false, true, '1 folder root · 0 project']);
  assert.equal(itemOf(health, 'project').done, false, 'the demo is not a real project');

  const backup = checkOf(health, 'backup');
  assert.deepEqual([backup.ok, backup.warn, backup.detail], [false, true, 'Mati']);
  assert.match(backup.hint, /Cadangkan riwayat/);
  assert.equal(itemOf(health, 'backup').done, false);

  const remote = checkOf(health, 'remote');
  assert.deepEqual([remote.ok, remote.warn], [false, true]);
  assert.equal(remote.detail, 'Menyala · 1 perangkat');
  assert.match(remote.hint, /lewat WiFi/);
  assert.equal(itemOf(health, 'https').done, false, 'HTTPS is needed while phone access is on');

  assert.equal(checkOf(health, 'errors').ok, true);
  assert.equal(checkOf(health, 'data').ok, true);
});

test('health: backup — enabled but never run, and a failed last run', () => {
  const never = buildHealth(fakeCtx({ backupScheduler: { view: () => ({ schedule: { enabled: true, folder: 'D:\\Backup' }, last: null }) } }), { now: NOW });
  const neverCheck = checkOf(never, 'backup');
  assert.deepEqual([neverCheck.ok, neverCheck.warn], [false, true]);
  assert.match(neverCheck.detail, /belum pernah jalan/);
  assert.equal(itemOf(never, 'backup').done, true, 'enabled with a folder is enough for onboarding');

  const failed = buildHealth(
    fakeCtx({ backupScheduler: { view: () => ({ schedule: { enabled: true, folder: 'D:\\Backup' }, last: { at: NOW - 2 * HOUR, ok: false, error: 'Folder tidak ditemukan: D:\\Backup' } }) } }),
    { now: NOW },
  );
  const failedCheck = checkOf(failed, 'backup');
  assert.deepEqual([failedCheck.ok, failedCheck.warn], [false, true]);
  assert.equal(failedCheck.detail, 'Gagal 2 jam lalu: Folder tidak ditemukan: D:\\Backup');
});

test('health: a missing project root is a warning', () => {
  const health = buildHealth(fakeCtx({ projectRoots: () => [PROJECTS, path.join(PROJECTS, 'hilang')] }), { now: NOW });
  const projects = checkOf(health, 'projects');
  assert.deepEqual([projects.ok, projects.warn], [false, true]);
  assert.match(projects.detail, /1 dari 2 folder root ditemukan · 1 project/);
  assert.match(projects.hint, /tidak ditemukan/);
});

test('health: no HTTPS while phone access is off is fine (nothing needs it)', () => {
  const health = buildHealth(fakeCtx({ remote: { enabled: false, publicInfo: () => ({ enabled: false, devices: [] }) }, httpsInfo: () => ({ state: 'off' }) }), { now: NOW });
  const remote = checkOf(health, 'remote');
  assert.deepEqual([remote.ok, remote.warn, remote.detail], [true, undefined, 'Mati · hanya dari laptop']);
  assert.equal(itemOf(health, 'https').done, true);
});

test('health: data/ of 1 GB or more is a warning', () => {
  const dir = makeData({ files: { 'big.bin': '' } });
  truncateSync(path.join(dir, 'big.bin'), MAX_BYTES + 1);
  const health = buildHealth(fakeCtx({ dataDir: dir }), { now: NOW });
  const data = checkOf(health, 'data');
  assert.equal(data.ok, false);
  assert.equal(data.warn, true);
  assert.match(data.detail, /1,0 GB · 1 file/);
  assert.ok(health.data.bytes > MAX_BYTES);
  assert.equal(health.data.files, 1);
});

test('health: services that are missing or throw never make buildHealth throw', () => {
  const bare = buildHealth({});
  assert.deepEqual(bare.checks.map((c) => c.id), ['claude', 'opencode', 'projects', 'backup', 'remote', 'errors', 'data']);
  for (const check of bare.checks) {
    assert.equal(typeof check.ok, 'boolean', check.id);
    assert.equal(typeof check.detail, 'string', check.id);
  }
  assert.equal(bare.app.version, '');
  assert.equal(bare.app.port, null);
  assert.equal(bare.app.engine, 'claude');
  assert.deepEqual(bare.errors, { count24h: 0, last: null });
  assert.deepEqual(bare.data, { bytes: 0, files: 0, dir: '' });
  assert.equal(bare.checklist.length, 5);
  // Nothing is configured: only "https" is done (phone access is off, so no certificate is needed).
  assert.deepEqual(Object.fromEntries(bare.checklist.map((item) => [item.id, item.done])), { login: false, project: false, backup: false, https: true, opencode: false });

  const boom = {
    dataDir: path.join(tempDir(), 'tidak-ada'),
    account: {
      get current() {
        throw new Error('account rusak');
      },
      get profile() {
        throw new Error('profil rusak');
      },
    },
    projectRoots: () => {
      throw new Error('root rusak');
    },
    backupScheduler: {
      view() {
        throw new Error('backup rusak');
      },
    },
    remote: {
      get enabled() {
        throw new Error('remote rusak');
      },
    },
    httpsInfo: () => {
      throw new Error('https rusak');
    },
    hub: {
      get engine() {
        throw new Error('engine rusak');
      },
      config: {
        get engines() {
          throw new Error('engines rusak');
        },
      },
    },
  };
  const health = buildHealth(boom, { now: NOW });
  assert.equal(health.checks.length, 7);
  assert.deepEqual([checkOf(health, 'claude').ok, checkOf(health, 'claude').detail], [false, 'Belum login']);
  assert.deepEqual([checkOf(health, 'opencode').ok, checkOf(health, 'opencode').warn], [false, true]);
  assert.deepEqual([checkOf(health, 'projects').ok, checkOf(health, 'projects').warn], [false, true]);
  assert.deepEqual([checkOf(health, 'backup').ok, checkOf(health, 'backup').detail], [false, 'Belum tersedia']);
  assert.deepEqual([checkOf(health, 'remote').ok, checkOf(health, 'remote').warn], [true, undefined]);
  assert.deepEqual([checkOf(health, 'errors').ok, health.errors.count24h], [true, 0]);
  assert.equal(health.app.engine, 'claude');
  assert.equal(health.data.bytes, 0);
});

test('💰 budget: only a set limit adds the check; ok below 80 %, warn 80–100 %, hard fail over 100 %, no ledger = $0', () => {
  // $12,30 spent in each window (the fake query counts one priced row per window).
  const ledger = { query: () => [{ ts: NOW, costUsd: 12.3 }] };
  const hubWith = (budget) => ({
    engine: 'claude',
    config: { engines: { opencode: { version: 'v1.2.3' } } },
    projects: new Map([['demo', { id: 'demo', name: 'Demo kantor', virtual: true }]]),
    persisted: { budget },
  });
  const ctxWith = (budget, extra = {}) => fakeCtx({ hub: hubWith(budget), ledger, ...extra });

  const off = buildHealth(ctxWith({ dailyUsd: null, weeklyUsd: null, monthlyUsd: null }), { now: NOW });
  assert.equal(checkOf(off, 'budget'), undefined, 'no limit, no line');
  assert.equal(off.checks.length, 7);

  const ok = checkOf(buildHealth(ctxWith({ dailyUsd: 20 }), { now: NOW }), 'budget');
  assert.equal(ok.label, 'Batas pemakaian');
  assert.deepEqual([ok.ok, ok.warn], [true, undefined]);
  assert.equal(ok.detail, 'hari ini $12,30 / $20,00 (62%)');

  const warn = checkOf(buildHealth(ctxWith({ dailyUsd: 15, weeklyUsd: 50 }), { now: NOW }), 'budget');
  assert.deepEqual([warn.ok, warn.warn], [false, true], '80–100 % is a warning');
  assert.match(warn.detail, /^hari ini \$12,30 \/ \$15,00 \(82%\) · minggu ini \$12,30 \/ \$50,00 \(25%\)$/);
  assert.match(warn.hint, /Pengaturan/);

  const over = checkOf(buildHealth(ctxWith({ monthlyUsd: 10 }), { now: NOW }), 'budget');
  assert.deepEqual([over.ok, over.warn], [false, undefined], 'over 100 % is a hard fail, not a warning');
  assert.match(over.detail, /bulan ini \$12,30 \/ \$10,00 \(123%\)/);
  assert.match(over.hint, /terlampaui/);

  // ctx.ledger missing: the report still comes back, the window simply spends $0 (never a throw)
  const missing = checkOf(buildHealth(ctxWith({ dailyUsd: 20 }, { ledger: undefined }), { now: NOW }), 'budget');
  assert.deepEqual([missing.ok, missing.detail], [true, 'hari ini $0,00 / $20,00 (0%)']);
});
