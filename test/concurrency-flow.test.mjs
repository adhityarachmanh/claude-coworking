// Concurrency governor under real timing: two prompts racing for the last free slot (one must lose), a queue item
// that waits while every slot is taken (it must never fail), and the wake-up once the slot frees.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectId } from '../src/util.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-concurrency-flow-'));
const DATA = path.join(TMP, 'data');
const PROJECTS = path.join(TMP, 'projects');
const PORT = 6100 + Math.floor(Math.random() * 150);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A_DIR = path.join(PROJECTS, 'toko');
const B_DIR = path.join(PROJECTS, 'blog');
const C_DIR = path.join(PROJECTS, 'catatan');
const A = projectId(A_DIR);
const B = projectId(B_DIR);
const C = projectId(C_DIR);

let server;
let token;

async function start() {
  for (const dir of [A_DIR, B_DIR, C_DIR]) mkdirSync(dir, { recursive: true });
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
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000',
      OFFICE_EFFORT_FAKE: 'high', // Effort Auto without a model call (only the deferred-Auto test turns it on)
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

/** Polls until `pred` holds, with a hard deadline (200 ms steps); returns the last value. */
async function until(pred, what, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    last = await pred();
    if (last) return last;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(200);
  }
}

const queueOf = async (id) => (await api(`/api/projects/${id}/queue`)).body.queue;

/** The first SSE frame is the snapshot: statuses and chats (a fresh connection, closed at once). */
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

const statusOf = async (id) => (await snapshot()).statuses[id];
const chatOf = async (id) => (await snapshot()).chats[id] ?? [];
const bubbleOf = async (projectId, chatId) => (await chatOf(projectId)).find((m) => m.id === chatId);

/** Stops every turn, empties B's and C's queues and restores the default limit (a clean office for the next test). */
async function resetFlow() {
  for (const id of [A, B, C]) await api(`/api/projects/${id}/stop`).catch(() => {});
  await until(async () => {
    const s = await snapshot();
    return [A, B, C].every((id) => !s.statuses[id]?.busy);
  }, 'semua project idle', 15000).catch(() => {});
  for (const id of [B, C]) {
    await api(`/api/projects/${id}/queue-pause`, { paused: true }).catch(() => {});
    for (let i = 0; i < 40; i++) {
      const q = await queueOf(id);
      if (!(q.items ?? []).length) break;
      for (const item of q.items ?? []) await api(`/api/projects/${id}/queue-remove`, { itemId: item.id }).catch(() => {});
      await sleep(150);
    }
    await api(`/api/projects/${id}/queue-pause`, { paused: false }).catch(() => {});
  }
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 3 })).status, 200);
}

before(async () => {
  await start();
});

after(async () => {
  try {
    if (server) await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: '{}' });
    await server?.exited;
  } catch {
    // best effort
  }
  server?.proc.kill();
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('two prompts race for the last slot: one runs, the other joins its queue (never two turns)', { timeout: 60000 }, async () => {
  await resetFlow();
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 1 })).status, 200);
  try {
    // Both projects are idle; both requests are in flight before either answer arrives.
    const [a, b] = await Promise.all([api(`/api/projects/${A}/prompt`, { text: 'lama balapan' }), api(`/api/projects/${B}/prompt`, { text: 'lama balapan' })]);
    assert.deepEqual([a.status, b.status], [200, 200], 'tidak ada prompt yang hilang');
    const queued = a.body.queued ? a : b;
    const direct = a.body.queued ? b : a;
    assert.equal(queued.body.queued, true, 'yang kalah balapan masuk antrian');
    assert.equal(typeof queued.body.queueItem, 'string');
    assert.equal(direct.body.queued, undefined, 'yang menang langsung berjalan');
    const queuedProject = a.body.queued ? A : B;
    const view = await queueOf(queuedProject);
    const item = (view.items ?? []).find((i) => i.id === queued.body.queueItem);
    assert.equal(item?.status, 'waiting', 'item antrian menunggu slot, bukan gagal');
  } finally {
    await resetFlow();
  }
});

test('a queue item waits (never fails) while the only slot is held by another project', { timeout: 60000 }, async () => {
  await resetFlow();
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 1 })).status, 200);
  try {
    // A runs a long turn (the fake streams for ~10 s); B's queue item must wait, not run and not fail.
    assert.equal((await api(`/api/projects/${A}/prompt`, { text: 'lama pemegang slot' })).status, 200);
    const added = await api(`/api/projects/${B}/queue-add`, { text: 'halo dari antrian' });
    assert.equal(added.status, 200);
    assert.equal(added.body.item.status, 'waiting');
    await sleep(1200);
    const view = await queueOf(B);
    assert.equal(view.items[0].status, 'waiting', 'masih waiting setelah 1,2 dtk');
    assert.equal(view.paused, false);
  } finally {
    await resetFlow();
  }
});

// Regression: observe() used to call onStatus() only for projects that already had a queue, so a project without one
// could hold the only slot and never wake the queue waiting for it. Every status event must reach onStatus().
test(
  'antrian: item menunggu bangun dan selesai setelah giliran pemegang slot selesai',
  { timeout: 60000 },
  async () => {
    await resetFlow();
    assert.equal((await api('/api/concurrency/save', { maxConcurrent: 1 })).status, 200);
    try {
      assert.equal((await api(`/api/projects/${A}/prompt`, { text: 'lama pemegang slot' })).status, 200);
      const added = await api(`/api/projects/${B}/queue-add`, { text: 'halo dari antrian' });
      assert.equal(added.status, 200);
      assert.equal(added.body.item.status, 'waiting');
      await sleep(1000);
      assert.equal((await queueOf(B)).items[0].status, 'waiting', 'menunggu selama slot penuh');

      // A stops: its slot is free, so B must wake and finish. Currently B stays waiting forever.
      assert.equal((await api(`/api/projects/${A}/stop`)).status, 200);
      const view = await until(async () => {
        const q = await queueOf(B);
        return q.items[0]?.status === 'done' ? q : null;
      }, 'item antrian B selesai', 8000);
      assert.equal(view.items[0].status, 'done');
    } finally {
      await resetFlow();
    }
  },
);

/** Holds the only slot with A's long turn, so another project's prompt has to join its queue. */
async function holdOnlySlot() {
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 1 })).status, 200);
  assert.equal((await api(`/api/projects/${A}/prompt`, { text: 'lama pemegang slot' })).status, 200);
  await until(async () => (await statusOf(A))?.busy === true, 'A memegang slot', 15000);
}

test('prompt antri: satu bubble user dengan posisi, lalu bubble yang sama menjalankan giliran', { timeout: 60000 }, async () => {
  await resetFlow();
  try {
    await holdOnlySlot();
    const queued = await api(`/api/projects/${B}/prompt`, { text: 'halo antri' });
    assert.equal(queued.status, 200);
    assert.equal(queued.body.queued, true);
    assert.equal(typeof queued.body.chatId, 'string', 'respons membawa id bubble antre');

    const first = await until(() => bubbleOf(B, queued.body.chatId), 'bubble antre B');
    assert.equal(first.kind, 'user');
    assert.equal(first.text, 'halo antri');
    assert.equal(first.queued, true);
    assert.equal(first.cancelled, undefined);
    assert.equal(first.queueItem, queued.body.queueItem);
    assert.equal(first.queuePosition, 1);
    assert.equal(first.source, 'web');
    const chats = await chatOf(B);
    assert.equal(chats.filter((m) => m.kind === 'user' && m.text === 'halo antri').length, 1, 'tepat satu bubble user');
    assert.equal(chats.some((m) => m.kind === 'info' && /Batas 1 giliran/.test(m.text ?? '')), false, 'tanpa baris info batas giliran');

    // The slot frees: the item starts with THAT bubble (queued off, uuid for ⏪) — never a second one.
    assert.equal((await api(`/api/projects/${A}/stop`)).status, 200);
    const running = await until(async () => {
      const m = await bubbleOf(B, queued.body.chatId);
      return m && m.queued === false ? m : null;
    }, 'bubble B mulai berjalan', 20000);
    assert.equal(running.id, queued.body.chatId);
    assert.equal(running.queuePosition ?? null, null);
    assert.match(running.uuid, /^[0-9a-f-]{36}$/);
    const after = await chatOf(B);
    assert.equal(after.filter((m) => m.kind === 'user' && m.text === 'halo antri').length, 1, 'tidak ada bubble kedua');
  } finally {
    await resetFlow();
  }
});

test('prompt antri: queue-remove menandai bubble dibatalkan dan menghapus itemnya', { timeout: 60000 }, async () => {
  await resetFlow();
  try {
    await holdOnlySlot();
    const queued = await api(`/api/projects/${B}/prompt`, { text: 'batalkan saja' });
    assert.equal(queued.body.queued, true);
    await until(() => bubbleOf(B, queued.body.chatId), 'bubble antre B');

    const removed = await api(`/api/projects/${B}/queue-remove`, { itemId: queued.body.queueItem });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body.queue.items, [], 'item benar-benar hilang dari antrian');

    const cancelled = await until(async () => {
      const m = await bubbleOf(B, queued.body.chatId);
      return m?.cancelled === true ? m : null;
    }, 'bubble ditandai dibatalkan');
    assert.equal(cancelled.queued, false);
    assert.equal(cancelled.queuePosition ?? null, null);
  } finally {
    await resetFlow();
  }
});

test('antrian: posisi bubble berkurang saat item di depannya dihapus', { timeout: 60000 }, async () => {
  await resetFlow();
  try {
    await holdOnlySlot();
    const ids = [];
    for (const text of ['satu antri', 'dua antri', 'tiga antri']) {
      const res = await api(`/api/projects/${B}/prompt`, { text });
      assert.equal(res.body.queued, true, `${text} masuk antrian`);
      ids.push({ item: res.body.queueItem, chat: res.body.chatId });
    }
    const positions = async () => Promise.all(ids.map(async (x) => (await bubbleOf(B, x.chat))?.queuePosition ?? null));
    assert.deepEqual(await positions(), [1, 2, 3]);

    assert.equal((await api(`/api/projects/${B}/queue-remove`, { itemId: ids[0].item })).status, 200);
    await until(async () => {
      const [a, b] = (await positions()).slice(1);
      return a === 1 && b === 2;
    }, 'posisi dua item sisa bergeser ke 1 dan 2');
    assert.equal((await bubbleOf(B, ids[0].chat))?.cancelled, true, 'bubble yang dihapus tetap ada, ditandai dibatalkan');
  } finally {
    await resetFlow();
  }
});

test('prompt antri: Effort Auto baru diklasifikasi saat item berjalan (bukan saat menunggu)', { timeout: 60000 }, async () => {
  await resetFlow();
  assert.equal((await api(`/api/projects/${B}/settings`, { effortAuto: true })).status, 200);
  try {
    await holdOnlySlot();
    const queued = await api(`/api/projects/${B}/prompt`, { text: 'halo auto' });
    assert.equal(queued.body.queued, true);
    const waiting = (await queueOf(B)).items.find((i) => i.id === queued.body.queueItem);
    assert.equal(waiting.effort, null, 'belum diklasifikasi saat menunggu giliran');
    assert.equal(waiting.autoDeferred, true);

    assert.equal((await api(`/api/projects/${A}/stop`)).status, 200);
    const bubble = await until(async () => {
      const m = await bubbleOf(B, queued.body.chatId);
      return m?.queued === false ? m : null;
    }, 'item B berjalan', 20000);
    assert.equal(bubble.autoEffort?.level, 'high', 'hasil klasifikasi menempel di bubble yang sama');
    assert.equal((await statusOf(B))?.effort, 'high', 'Effort Auto diterapkan sebelum giliran dikirim');
    const item = (await queueOf(B)).items.find((i) => i.id === queued.body.queueItem);
    assert.equal(item.effort, 'high');
    assert.equal(item.autoDeferred, false);
  } finally {
    await api(`/api/projects/${B}/settings`, { effortAuto: false, effort: '' }).catch(() => {});
    await resetFlow();
  }
});

test('antrian adil: item tertua lintas project didahulukan saat satu slot bebas', { timeout: 90000 }, async () => {
  await resetFlow();
  try {
    await holdOnlySlot();
    // B's item is older than C's, though C's timer could fire first (each project has its own retry timer).
    const b = await api(`/api/projects/${B}/queue-add`, { text: 'lama dari B' });
    assert.equal(b.status, 200);
    await sleep(150);
    const c = await api(`/api/projects/${C}/queue-add`, { text: 'dari C' });
    assert.equal(c.status, 200);
    assert.ok((await queueOf(B)).items[0].createdAt <= (await queueOf(C)).items[0].createdAt, 'B lebih tua dari C');
    await sleep(1200); // both per-project timers have fired (and found the slot taken)

    assert.equal((await api(`/api/projects/${A}/stop`)).status, 200);
    // B runs first (its long turn holds the slot); C must still be waiting the whole time.
    await until(async () => (await queueOf(B)).items[0]?.status === 'running', 'item B berjalan', 20000);
    assert.equal((await queueOf(C)).items[0]?.status, 'waiting', 'C belum jalan saat B berjalan');
    assert.equal((await api(`/api/projects/${B}/stop`)).status, 200);
  } finally {
    await resetFlow();
  }
});

// Regression: the number on a waiting bubble ("antre #N") is GLOBAL, matching the fair scheduler (interactive before
// routines, then oldest first). Repro: limit 1 → A holds the slot with a long turn → prompt B (older) then C; B is #1,
// C is #2. Cancelling B moves C to #1.
test('posisi "antre #N" lintas project: C adalah #2 saat B menunggu di depannya', { timeout: 60000 }, async () => {
  await resetFlow();
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 1 })).status, 200);
  try {
    await holdOnlySlot();
    const b = await api(`/api/projects/${B}/prompt`, { text: 'posisi B' });
    const c = await api(`/api/projects/${C}/prompt`, { text: 'posisi C' });
    assert.equal(b.body.queued, true);
    assert.equal(c.body.queued, true);
    assert.equal((await until(() => bubbleOf(B, b.body.chatId), 'bubble B')).queuePosition, 1, 'B adalah yang pertama');
    const bubbleC = await until(() => bubbleOf(C, c.body.chatId), 'bubble C');
    assert.equal(bubbleC.queued, true);
    assert.equal(bubbleC.queuePosition, 2, 'posisi antre global: B (item lebih tua) menunggu di depan C');
  } finally {
    await resetFlow();
  }
});
