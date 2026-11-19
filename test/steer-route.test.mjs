// ↪ Steering routes: `POST /api/projects/:id/steer` (OpenCode 2.3+ `_session/steering`).
// The route is exercised with a hand-made ctx and a fake session — no server, no process, no real OpenCode. The
// shapes come from a probe of the installed build (opencode 2.3.0, 2026-11-19), see test/acp-steering.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRouter } from '../src/routes/index.js';
import { steerDecision, steerOutcome, steerQueueItem } from '../src/routes/session.js';

const router = buildRouter();

/** A minimal ServerResponse: status and parsed JSON body. */
function fakeRes() {
  const res = { status: 0, headers: {}, body: Buffer.alloc(0) };
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.writeHead = (status, headers = {}) => {
    res.status = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  };
  res.end = (b) => (res.body = Buffer.from(b ?? ''));
  res.json = () => JSON.parse(res.body.toString('utf8'));
  return res;
}

/** The route with a project and a session; `steer` is replaced by what the test needs. */
function ctxWith({ steer, queue } = {}) {
  const session = { steer };
  const project = { id: 'toko', name: 'toko', path: process.cwd() };
  const removed = [];
  const taskQueue = {
    queues: queue ?? {},
    remove: (id, itemId, options) => removed.push({ id, itemId, options }),
  };
  return { ctx: { hub: { projects: new Map([['toko', project]]) }, sessions: new Map([[project, session]]), taskQueue }, removed };
}

async function call(ctx, body) {
  const match = router.match('POST', '/api/projects/toko/steer');
  assert.ok(match, 'route terdaftar');
  const res = fakeRes();
  await match.route.handler(ctx, { headers: {} }, res, match.params, body);
  return res;
}

test('route /steer: teks kosong atau tidak ada teks → 400, tanpa memanggil sesi', async () => {
  let called = 0;
  const { ctx } = ctxWith({ steer: async () => (called++, { ok: true }) });
  for (const body of [{}, { text: '   ' }, { text: 42 }, { text: null }]) {
    const res = await call(ctx, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.json().error, /kosong/i);
  }
  assert.equal(called, 0);
});

test('route /steer: lebih dari 2000 karakter → 400 dengan batas yang jelas', async () => {
  const { ctx } = ctxWith({ steer: async () => ({ ok: true }) });
  const res = await call(ctx, { text: 'x'.repeat(2001) });
  assert.equal(res.status, 400);
  assert.match(res.json().error, /2000/);
});

test('route /steer: tanpa giliran berjalan → 409 dan pesan yang menyebut antrian', async () => {
  const { ctx } = ctxWith({ steer: async () => ({ ok: false, reason: 'no-turn' }) });
  const res = await call(ctx, { text: 'fokus ke test checkout' });
  assert.equal(res.status, 409);
  assert.equal(res.json().code, 'no-turn');
  assert.match(res.json().error, /antrian/i);
});

test('route /steer: versi OpenCode lama → 409 unsupported, pesan tetap menenangkan (masuk antrian)', async () => {
  const { ctx } = ctxWith({ steer: async () => ({ ok: false, reason: 'unsupported' }) });
  const res = await call(ctx, { text: 'arahkan' });
  assert.equal(res.status, 409);
  assert.equal(res.json().code, 'unsupported');
  assert.match(res.json().error, /antrian/i);
});

test('route /steer: sukses → 200 { ok: true }, dan item antrian di belakang bubble itu ikut dihapus', async () => {
  const queue = { toko: { items: [{ id: 'q1', chatId: 'm7', status: 'waiting', text: 'lanjut' }] } };
  let got = null;
  const { ctx, removed } = ctxWith({ steer: async (text, context) => ((got = { text, context }), { ok: true }) });
  ctx.taskQueue.queues = queue;
  const res = await call(ctx, { text: '  fokus ke test checkout  ', chatId: 'm7' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, steered: true });
  assert.deepEqual(got, { text: 'fokus ke test checkout', context: { chatId: 'm7' } });
  assert.deepEqual(removed, [{ id: 'toko', itemId: 'q1', options: { steered: true } }]);
});

test('route /steer: gagal (502) tidak menghapus item antrian — pesan tetap menunggu seperti biasa', async () => {
  const queue = { toko: { items: [{ id: 'q1', chatId: 'm7', status: 'waiting', text: 'lanjut' }] } };
  const { ctx, removed } = ctxWith({ steer: async () => ({ ok: false, reason: 'OpenCode tidak menjawab (_session/steering).' }) });
  ctx.taskQueue.queues = queue;
  const res = await call(ctx, { text: 'arahkan', chatId: 'm7' });
  assert.equal(res.status, 502);
  assert.match(res.json().error, /tidak menjawab/);
  assert.deepEqual(removed, [], 'nothing left the queue');
});

test('route /steer: sesi tanpa steer() (Claude) → 409, bukan 500', async () => {
  const { ctx } = ctxWith({ steer: undefined });
  const res = await call(ctx, { text: 'arahkan' });
  assert.equal(res.status, 409);
  assert.equal(res.json().code, 'unsupported');
});

test('steerQueueItem: hanya item waiting milik bubble itu yang dikembalikan', () => {
  const taskQueue = { queues: { toko: { items: [{ id: 'q1', chatId: 'm1', status: 'waiting' }, { id: 'q2', chatId: 'm2', status: 'running' }] } } };
  assert.equal(steerQueueItem(taskQueue, 'toko', 'm1'), 'q1');
  assert.equal(steerQueueItem(taskQueue, 'toko', 'm2'), null, 'a running item is never removed');
  assert.equal(steerQueueItem(taskQueue, 'toko', 'nope'), null);
  assert.equal(steerQueueItem(taskQueue, 'toko', null), null);
  assert.equal(steerQueueItem(undefined, 'toko', 'm1'), null, 'no queue at all');
});

test('steerDecision/steerOutcome: the pure mapping (400/409/200/502)', () => {
  assert.equal(steerDecision({ text: '' }, {}).status, 400);
  assert.equal(steerDecision({ text: 'a' }, {}).status, 409, 'no steer() on this engine');
  assert.deepEqual(steerDecision({ text: ' a ' }, { steer() {} }), { status: 200, text: 'a' });
  assert.equal(steerOutcome({ ok: true }).status, 200);
  assert.equal(steerOutcome({ ok: false, reason: 'no-turn' }).code, 'no-turn');
  assert.equal(steerOutcome({ ok: false, reason: 'unsupported' }).code, 'unsupported');
  assert.equal(steerOutcome({ ok: false, reason: 'empty' }).status, 400);
  assert.equal(steerOutcome({ ok: false, reason: 'boom' }).status, 502);
});
