// Global concurrency limit against the real server and the fake Claude Code (test-support/fake-claude.mjs):
// one long turn in project A, a prompt for project B joins B's queue (never lost), a follow-up to A
// (which is busy) still goes through, and once A is idle B's queued prompt runs by itself.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectId } from '../src/util.js';
import { wifiAllows } from '../src/remote.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-concurrency-'));
const DATA = path.join(TMP, 'data');
const PROJECTS = path.join(TMP, 'projects');
const PORT = 5900 + Math.floor(Math.random() * 150);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A_DIR = path.join(PROJECTS, 'toko');
const B_DIR = path.join(PROJECTS, 'blog');
const A = projectId(A_DIR);
const B = projectId(B_DIR);

let current = null;
let stream = null;
const seen = [];
const waiters = [];

async function start() {
  mkdirSync(A_DIR, { recursive: true });
  mkdirSync(B_DIR, { recursive: true });
  const proc = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_DATA_DIR: DATA,
      PROJECTS_ROOT: PROJECTS,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale'),
      OFFICE_UPDATE_CHECK: '0',
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000', // the fake version check is not part of this test
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  let out = '';
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      out += d;
      if (out.includes('berjalan di')) resolve();
    });
    exited.then((code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
  proc.stderr.resume();
  const token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  current = { proc, token, exited };
  return current;
}

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
function waitFor(pred, what, ms = 20000) {
  return new Promise((resolve, reject) => {
    for (let i = mark; i < seen.length; i++) if (pred(seen[i].type, seen[i].obj)) return ((mark = i + 1), resolve(seen[i].obj));
    const timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
    waiters.push({ pred, resolve: (o) => (clearTimeout(timer), (mark = seen.length), resolve(o)) });
  });
}

function api(p, body = {}) {
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': current.token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

before(async () => {
  await start();
  stream = listen();
  await waitFor((type) => type === 'snapshot', 'stream open', 10000);
  assert.ok(A, 'project id A');
  assert.ok(B, 'project id B');
});

after(async () => {
  stream?.abort();
  try {
    if (current) await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': current.token }, body: '{}' });
    await current?.exited;
  } catch {
    // the assertions already reported the real failure; teardown stays best-effort
  }
  current?.proc.kill();
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('concurrency: a full global limit queues another project, but never a follow-up in the busy project', { timeout: 60000 }, async () => {
  const saved = await api('/api/concurrency/save', { maxConcurrent: 1 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { maxConcurrent: 1 });
  // Laptop-only: the same call over plain WiFi is refused by the read-only gate (LOCAL_ONLY in server.js).
  assert.equal(wifiAllows('/api/concurrency/save'), false, 'batas giliran bersamaan tidak bisa diubah dari WiFi');
  const config = await waitFor((type, obj) => type === 'config' && obj?.concurrency?.maxConcurrent === 1, 'config concurrency');
  assert.deepEqual(config.concurrency, { maxConcurrent: 1 });

  // A long turn in A ("lama" streams for ~10 s in the fake).
  assert.equal((await api(`/api/projects/${A}/prompt`, { text: 'lama' })).status, 200);
  await waitFor((type, obj) => type === 'status' && obj?.project === A && obj.busy === true, 'A busy');

  // B's prompt is never lost: it joins B's queue and waits for the slot A holds.
  const queued = await api(`/api/projects/${B}/prompt`, { text: 'halo' });
  assert.equal(queued.status, 200);
  assert.equal(queued.body.queued, true);
  assert.equal(typeof queued.body.queueItem, 'string');
  const waiting = await api(`/api/projects/${B}/queue`);
  const queuedItem = waiting.body.queue.items.find((i) => i.id === queued.body.queueItem);
  assert.equal(queuedItem.status, 'waiting', 'B menunggu, bukan gagal');

  // A message to the project that is already working joins its turn: never queued/refused.
  const followUp = await api(`/api/projects/${A}/prompt`, { text: 'pesan menyusul' });
  assert.equal(followUp.status, 200);
  assert.equal(followUp.body.queued, undefined);

  // A's turn ends: the slot opens and B's queued prompt runs by itself.
  await waitFor((type, obj) => type === 'status' && obj?.project === A && obj.busy === false, 'A idle', 40000);
  let done = false;
  for (let i = 0; i < 60 && !done; i += 1) {
    await sleep(500);
    const view = await api(`/api/projects/${B}/queue`);
    done = (view.body.queue.items ?? []).some((item) => item.id === queued.body.queueItem && item.status === 'done');
  }
  assert.equal(done, true, 'item antrian B selesai setelah slot bebas');

  // Validation at the boundary: only an integer 0…8.
  const invalid = await api('/api/concurrency/save', { maxConcurrent: 9 });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /0–8/);
  await sleep(100);
});
