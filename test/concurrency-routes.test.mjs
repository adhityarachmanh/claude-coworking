// The global concurrency governor on every OTHER route that starts a turn: /compact, /continue and approving a plan.
// While project A holds the only slot, each of them is refused with 429/code concurrency and nothing starts; once the
// slot frees, the same call goes through. A prompt that arrives at capacity joins the queue instead (already covered
// by test/concurrency-server.test.mjs, not duplicated here).
//
// The plan card is produced by the OpenCode path (fake-acp's plan agent): the card is offered AFTER its turn ends,
// so project B is idle while the card waits — exactly the "would this start a new turn?" case. Claude Code's
// ExitPlanMode card is emitted inside the running turn instead, so its approval is a continuation of the slot that
// project already holds (there is no idle-B variant to refuse).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PLAN_APPROVED_PROMPT } from '../src/acp-session.js';
import { wifiAllows } from '../src/remote.js';
import { projectId } from '../src/util.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-concurrency-routes-'));
const DATA = path.join(TMP, 'data');
const PROJECTS = path.join(TMP, 'projects');
// 6700–6849: clear of the other server tests' ranges (4300–6449).
const PORT = 6700 + Math.floor(Math.random() * 150);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A_DIR = path.join(PROJECTS, 'toko');
const B_DIR = path.join(PROJECTS, 'blog');
const C_DIR = path.join(PROJECTS, 'catatan');
const A = projectId(A_DIR);
const B = projectId(B_DIR);
const C = projectId(C_DIR);

let server = null;
let token = null;

async function start() {
  for (const dir of [A_DIR, B_DIR, C_DIR]) mkdirSync(dir, { recursive: true });
  mkdirSync(DATA, { recursive: true });
  // Project C carries a turn cut short by a server stop, exactly as state.json would after a clean shutdown.
  writeFileSync(
    path.join(DATA, 'state.json'),
    JSON.stringify({
      interrupted: {
        [C]: { reason: 'shutdown', at: Date.now(), startedAt: Date.now() - 5000, sessionId: null, prompt: 'tugas terputus', uuid: null, announced: true },
      },
    }),
  );
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
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  server = { proc, exited };
}

function api(p, body = {}) {
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

/** The first SSE frame is the snapshot: statuses, chats and pending approvals. */
async function snapshot() {
  const res = await fetch(`${BASE}/stream`, { signal: AbortSignal.timeout(10000) });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

/** Polls until `pred` holds, with a hard deadline (200 ms steps). */
async function until(pred, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await pred();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(200);
  }
}

const statusOf = async (id) => (await snapshot()).statuses[id];
const queueOf = async (id) => (await api(`/api/projects/${id}/queue`)).body.queue;
const chatTexts = async (id) => (await snapshot()).chats[id] ?? [];

/** Stops every project, drops B's queue and restores the default limit (a test starts from a clean office). */
async function resetFlow() {
  for (const id of [A, B, C]) await api(`/api/projects/${id}/stop`).catch(() => {});
  const q = await queueOf(B);
  for (const item of q.items ?? []) await api(`/api/projects/${B}/queue-remove`, { itemId: item.id });
  await until(async () => ((await queueOf(B)).items ?? []).length === 0, 'antrian B kosong', 5000).catch(() => {});
  const saved = await api('/api/concurrency/save', { maxConcurrent: 3 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
}

/** Runs a long A turn and waits until the server counts it as busy. */
async function holdOnlySlot() {
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 1 })).status, 200);
  assert.equal((await api(`/api/projects/${A}/prompt`, { text: 'lama pemegang slot' })).status, 200);
  await until(async () => (await statusOf(A))?.busy === true, 'A memegang slot', 15000);
}

async function waitIdle(id, ms = 40000) {
  await until(async () => (await statusOf(id))?.busy === false, `${id} idle`, ms);
}

before(async () => {
  await start();
});

after(async () => {
  try {
    if (server) await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: '{}' });
    await server?.exited;
  } catch {
    // best effort: the assertions already reported the real failure
  }
  server?.proc.kill();
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('/compact is refused at capacity and works again once a slot frees', { timeout: 60000 }, async () => {
  await resetFlow();
  // A fresh project has no conversation yet: /compact would answer 409 before the concurrency check.
  assert.equal((await api(`/api/projects/${B}/prompt`, { text: 'halo dulu' })).status, 200);
  await until(async () => (await statusOf(B))?.sessionId, 'sesi B tercatat', 15000);
  await waitIdle(B);
  const chatsBefore = (await chatTexts(B)).length;

  await holdOnlySlot();
  try {
    const refused = await api(`/api/projects/${B}/compact`);
    assert.equal(refused.status, 429, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'concurrency');
    assert.equal(refused.body.limit, 1);
    assert.equal((await statusOf(B)).busy, false, 'B tidak memulai giliran compact');
    assert.equal((await chatTexts(B)).length, chatsBefore, 'tidak ada bubble /compact yang dikirim');

    assert.equal((await api(`/api/projects/${A}/stop`)).status, 200);
    await waitIdle(A);

    const allowed = await api(`/api/projects/${B}/compact`);
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.engine, 'claude');
    assert.equal(allowed.body.command, '/compact');
    await waitIdle(B);

    // The same gate that refuses the laptop-only route over plain WiFi.
    assert.equal(wifiAllows('/api/concurrency/save'), false, 'batas giliran bersamaan tidak bisa diubah dari WiFi');
  } finally {
    await resetFlow();
  }
});

test('/continue is refused at capacity; the cut-short notice stays until it can run', { timeout: 60000 }, async () => {
  await resetFlow();
  assert.equal((await statusOf(C))?.interrupted?.reason, 'shutdown', 'C membawa giliran terputus dari state.json');
  await holdOnlySlot();
  try {
    const chatsBefore = (await chatTexts(C)).length;
    const refused = await api(`/api/projects/${C}/continue`);
    assert.equal(refused.status, 429, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'concurrency');
    assert.equal((await statusOf(C)).busy, false, 'C tidak memulai giliran Lanjutkan');
    assert.equal((await statusOf(C)).interrupted?.reason, 'shutdown', 'tombol Lanjutkan masih ada');
    assert.equal((await chatTexts(C)).length, chatsBefore, 'tidak ada prompt yang dikirim');

    assert.equal((await api(`/api/projects/${A}/stop`)).status, 200);
    await waitIdle(A);

    const allowed = await api(`/api/projects/${C}/continue`);
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.deepEqual(allowed.body, { ok: true, sessionId: null, resent: true, lostAttachments: 0 });
    await until(async () => (await statusOf(C))?.interrupted === null, 'pemberitahuan terputus dibersihkan', 10000);
    await waitIdle(C);
  } finally {
    await resetFlow();
  }
});

test('approving an OpenCode plan card is refused at capacity; the card stays pending and can be retried', { timeout: 90000 }, async () => {
  await resetFlow();
  // OpenCode's plan card is offered after its turn ends: B is idle with the card pending.
  assert.equal((await api(`/api/projects/${B}/settings`, { engine: 'opencode' })).status, 200);
  await until(async () => (await statusOf(B))?.engine === 'opencode', 'B pindah ke OpenCode', 15000);
  assert.equal((await api(`/api/projects/${B}/settings`, { mode: 'plan', modelAuto: false, effortAuto: false })).status, 200);
  assert.equal((await api(`/api/projects/${B}/prompt`, { text: 'buat rencana' })).status, 200);
  const card = await until(async () => (await snapshot()).approvals.find((a) => a.project === B && a.kind === 'plan' && a.status === 'pending'), 'kartu rencana B', 20000);
  await until(async () => (await statusOf(B))?.busy === false, 'B idle setelah menawarkan rencana', 15000);

  await holdOnlySlot();
  try {
    const refused = await api(`/api/approvals/${card.id}`, { allow: true });
    assert.equal(refused.status, 429, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'concurrency');
    const pending = (await snapshot()).approvals.find((a) => a.id === card.id);
    assert.equal(pending?.status, 'pending', 'kartu rencana tetap menunggu jawaban');
    assert.equal((await statusOf(B)).busy, false, 'B belum memulai build');
    assert.equal((await chatTexts(B)).some((m) => m.kind === 'user' && m.text === PLAN_APPROVED_PROMPT), false, 'prompt build tidak terkirim');

    assert.equal((await api(`/api/projects/${A}/stop`)).status, 200);
    await waitIdle(A);

    const allowed = await api(`/api/approvals/${card.id}`, { allow: true });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.ok, true);
    await until(async () => (await snapshot()).approvals.every((a) => a.id !== card.id), 'kartu rencana dijawab', 15000);
    await waitIdle(B);
    assert.equal((await chatTexts(B)).some((m) => m.kind === 'assistant' && /Mengerjakan rencana/.test(m.text ?? '')), true, 'build berjalan setelah slot bebas');
  } finally {
    await resetFlow();
  }
});
