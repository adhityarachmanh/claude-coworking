// 📈 Server integration for the health metrics (src/metrics.js): a prompt queued at the global turn limit, the queue
// starting it after the running turn ends, finished turns, a refused compact, and the aggregate-only data/metrics.json.
// Real server + fake Claude Code (test-support/fake-claude.mjs); no network, no tokens, no real data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-metrics-server-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let BASE;
let server;
let token;
let stream;
let tokoId;
let betaId;

const seen = [];
const waiters = [];

/** The SSE stream, read in the background (same helper as test/server.test.mjs). */
function listen() {
  const controller = new AbortController();
  (async () => {
    const res = await fetch(`${BASE}/stream`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = frame.match(/^event: (.*)$/m)?.[1];
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (!type || !data) continue;
        const obj = JSON.parse(data);
        seen.push({ type, obj });
        for (const w of [...waiters]) if (w.pred(type, obj)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(obj));
      }
    }
  })();
  return controller;
}

let mark = 0;
/** Waits for the next stream event that matches (bounded; the timeout names what did arrive). */
function waitFor(pred, ms = 20_000, label = 'event') {
  return new Promise((resolve, reject) => {
    for (let i = mark; i < seen.length; i++) if (pred(seen[i].type, seen[i].obj)) return ((mark = i + 1), resolve(seen[i].obj));
    const recent = () => seen.slice(Math.max(mark, seen.length - 8)).map((s) => `${s.type}:${JSON.stringify(s.obj).slice(0, 160)}`).join('\n  ');
    const timer = setTimeout(() => reject(new Error(`timeout menunggu ${label}; terakhir:\n  ${recent()}`)), ms);
    waiters.push({ pred, resolve: (o) => (clearTimeout(timer), (mark = seen.length), resolve(o)) });
  });
}

/**
 * Waits for an event that matches `pred`, looking from a remembered stream index (for a signal that may arrive before
 * the other waits started). Does not move the shared `mark`.
 */
function waitSince(from, pred, ms = 10_000, label = 'event') {
  return new Promise((resolve, reject) => {
    for (let i = from; i < seen.length; i++) if (pred(seen[i].type, seen[i].obj)) return resolve(seen[i].obj);
    const timer = setTimeout(() => reject(new Error(`timeout menunggu ${label}`)), ms);
    waiters.push({ pred, resolve: (o) => (clearTimeout(timer), resolve(o)) });
  });
}

/** The fake CLI started the prompt for real (its command lifecycle moved from queued to started). */
const startedSignal = (project) => (type, obj) => type === 'chat_update' && obj.project === project && obj.patch?.queued === false;

/** A bounded poll for things outside the event stream (a debounced file write, a project status). */
async function poll(fn, { timeoutMs = 10_000, label = 'kondisi' } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (err) {
      last = err;
    }
    await sleep(100);
  }
  throw new Error(`timeout menunggu ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

function api(p, body = {}) {
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

async function snapshot() {
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

const healthMetrics = async () => (await api('/api/health', {})).body.health.metrics;

/** Both projects idle (their status event may already have passed before a waitFor started). */
const waitIdle = async (ids, timeoutMs = 10_000) => {
  const end = Date.now() + timeoutMs;
  let snap = {};
  // A project with no runtime yet has never run a turn: idle by definition.
  while (Date.now() < end) {
    snap = await snapshot();
    if (ids.every((id) => !snap.statuses?.[id]?.busy)) return snap.statuses ?? {};
    await sleep(100);
  }
  throw new Error(`timeout menunggu semua project idle: ${JSON.stringify(snap.statuses)}`);
};

const localDayKey = (ts = Date.now()) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const DAY_FIELDS = ['capacityQueued', 'capacityRefused', 'queueStarted', 'turnMs', 'turnTimed', 'turnsFailed', 'turnsOk', 'waits'];

/** data/metrics.json holds the aggregate only: expected keys, numbers, no prompt or project text. */
function assertAggregateOnly(text) {
  const data = JSON.parse(text);
  assert.deepEqual(Object.keys(data).sort(), ['days', 'restarts']);
  assert.deepEqual(Object.keys(data.restarts).sort(), ['count', 'lastAt']);
  assert.ok(Number.isInteger(data.restarts.count) && data.restarts.count >= 1, `restart count: ${data.restarts.count}`);
  assert.ok(Number.isFinite(data.restarts.lastAt));
  assert.ok(data.days && typeof data.days === 'object' && !Array.isArray(data.days));
  for (const [day, bucket] of Object.entries(data.days)) {
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/, `day key: ${day}`);
    assert.deepEqual(Object.keys(bucket).sort(), DAY_FIELDS, `day ${day} keys`);
    assert.ok(Array.isArray(bucket.waits) && bucket.waits.length <= 200, `day ${day} waits`);
    for (const [key, value] of Object.entries(bucket)) {
      if (key === 'waits') {
        assert.ok(
          value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0),
          `day ${day} waits are numbers`,
        );
      } else {
        assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, `day ${day}.${key} is a number`);
      }
    }
  }
  // Prompts and project ids are never part of this diagnostics file.
  assert.doesNotMatch(text, /PROMPT-RAHASIA|toko|beta/i);
}

/** The newest day in metrics.json once the debounced save has caught up with the turn/queue events. */
const savedToday = () =>
  poll(
    () => {
      const text = readFileSync(path.join(TMP, 'data', 'metrics.json'), 'utf8');
      const data = JSON.parse(text);
      const today = data.days?.[localDayKey()];
      return today && today.queueStarted >= 1 && today.turnsOk >= 1 && today.turnsFailed >= 1 && today.capacityQueued >= 1 ? { today, text } : null;
    },
    { timeoutMs: 12_000, label: 'metrics.json tersimpan' },
  );

before(async () => {
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko', 'src'), { recursive: true });
  mkdirSync(path.join(projects, 'beta'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = srv.address();
      srv.close(() => resolve(free));
    });
    srv.on('error', reject);
  });
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      OFFICE_GH_BIN: path.join(TMP, 'no-such-gh.exe'),
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000', // no update detector work during this test
      OFFICE_EFFORT_FAKE: 'high',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 20_000);
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && (clearTimeout(timer), resolve()));
    server.on('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}`))));
  });
  server.stdout.resume();
  server.stderr.resume();
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  const snap = await snapshot();
  tokoId = snap.projects.find((p) => p.name === 'toko').id;
  betaId = snap.projects.find((p) => p.name === 'beta').id;
  stream = listen();
  // One turn at a time: a prompt that arrives while toko works must queue instead of starting.
  const saved = await api('/api/concurrency/save', { maxConcurrent: 1 });
  assert.deepEqual([saved.status, saved.body.maxConcurrent], [200, 1]);
  await waitIdle([tokoId, betaId]);
});

after(async () => {
  stream?.abort();
  if (server && server.exitCode === null) {
    server.kill();
    await sleep(500);
  }
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('metrics: a prompt queued at the turn limit is counted, then starts and finishes', async () => {
  // A long turn holds the only slot ("lama" makes fake-claude stream slowly).
  const aMark = seen.length;
  const a = await api(`/api/projects/${tokoId}/prompt`, { text: 'PROMPT-RAHASIA-A kerjakan tugas lama ini' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  await waitFor((type, obj) => type === 'status' && obj.project === tokoId && obj.busy === true, 10_000, 'status sibuk');
  await waitSince(aMark, startedSignal(tokoId), 10_000, 'turn A mulai');

  // B arrives while the limit is full: it joins 📋 Antrian instead of being refused.
  const b = await api(`/api/projects/${betaId}/prompt`, { text: 'PROMPT-RAHASIA-B tugas singkat' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.queued, true, 'prompt B masuk antrian');
  assert.ok(b.body.queue?.items?.some((item) => item.status === 'waiting'), 'item B menunggu');

  const queued = await healthMetrics();
  assert.ok(queued.today.capacityQueued >= 1, `capacityQueued: ${queued.today.capacityQueued}`);
  assert.equal(queued.today.queueStarted, 0, 'B belum mulai selama A berjalan');

  // End A: the freed slot lets the queue start B, and B finishes on its own.
  assert.equal((await api(`/api/projects/${tokoId}/stop`)).status, 200);
  const bResult = await waitFor((type, obj) => type === 'chat' && obj.project === betaId && obj.kind === 'result', 20_000, 'hasil B');
  assert.equal(bResult.ok, true, bResult.text ?? '');

  const after = await healthMetrics();
  assert.ok(after.today.queueStarted >= 1, `queueStarted: ${after.today.queueStarted}`);
  assert.ok(after.today.turns >= 1, `turns: ${after.today.turns}`);
  assert.ok(after.today.ok >= 1, `giliran B yang selesai dihitung ok: ${after.today.ok}`);
  assert.ok(after.today.failed >= 1, `giliran A yang dihentikan dihitung gagal: ${after.today.failed}`);
  assert.ok(after.today.avgTurnMs === null || (Number.isFinite(after.today.avgTurnMs) && after.today.avgTurnMs >= 1), `avgTurnMs: ${after.today.avgTurnMs}`);
  assert.ok(after.today.capacityQueued >= 1, `capacityQueued tetap: ${after.today.capacityQueued}`);
  assert.deepEqual(after.days.length, 7, '7 hari termasuk hari kosong');
  assert.equal(after.days[6].day, localDayKey(), 'hari ini baris terakhir');
  assert.ok(after.restarts.count >= 1, 'start server dihitung sebagai restart');

  // The file on disk is the aggregate only (the save is debounced: wait for it, bounded).
  const { today, text } = await savedToday();
  assert.ok(today.capacityQueued >= 1);
  assert.ok(today.queueStarted >= 1);
  assert.ok(today.turnsOk >= 1 && today.turnsFailed >= 1, `hari ini ok/gagal: ${today.turnsOk}/${today.turnsFailed}`);
  assertAggregateOnly(text);
  await waitIdle([tokoId, betaId]);
});

test('metrics: /compact refused by the global turn limit counts as capacityRefused', async () => {
  // beta needs a session first (compact refuses a project with no conversation before it reaches the turn gate).
  const warm = await api(`/api/projects/${betaId}/prompt`, { text: 'Halo singkat untuk membuka sesi' });
  assert.equal(warm.status, 200, JSON.stringify(warm.body));
  assert.notEqual(warm.body.queued, true, 'limit masih kosong: turn langsung jalan');
  await waitFor((type, obj) => type === 'chat' && obj.project === betaId && obj.kind === 'result', 20_000, 'hasil B');
  await waitIdle([tokoId, betaId]);

  // Hold the only slot with a long toko turn, then ask beta to compact: the gate refuses it.
  const aMark = seen.length;
  const a = await api(`/api/projects/${tokoId}/prompt`, { text: 'Tugas lama lain untuk mengisi kapasitas' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  await waitFor((type, obj) => type === 'status' && obj.project === tokoId && obj.busy === true, 10_000, 'status sibuk');
  await waitSince(aMark, startedSignal(tokoId), 10_000, 'turn A mulai');

  const before = (await healthMetrics()).today.capacityRefused;
  const compact = await api(`/api/projects/${betaId}/compact`, {});
  assert.equal(compact.status, 429, JSON.stringify(compact.body));
  assert.equal(compact.body.code, 'concurrency');
  const after = await healthMetrics();
  assert.ok(after.today.capacityRefused >= before + 1, `capacityRefused: ${before} → ${after.today.capacityRefused}`);

  // Leave the server idle for a clean teardown.
  assert.equal((await api(`/api/projects/${tokoId}/stop`)).status, 200);
  await waitFor((type, obj) => type === 'chat' && obj.project === tokoId && obj.kind === 'result', 20_000, 'hasil A');
  await waitIdle([tokoId, betaId]);
});
