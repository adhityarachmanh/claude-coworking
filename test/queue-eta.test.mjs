// Waiting estimate for 📋 Antrian v3, on TaskQueue alone (a fake hub, no server): the typical turn is the median of
// the durations seen this run (noteTurnDuration) or of the finished items stored with the queue (meta.durationMs),
// and estimateWaitMs adds the remaining running turn (position 1) plus the items ahead (position 2). No duration data
// means "no idea" (null), and a free slot means 0.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { TaskQueue } from '../src/queue.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-queue-eta-'));
const NOW = 1_000_000;

after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

/** A hub just big enough for the queue's estimate: projects, runtime statuses, and no side effects. */
function fakeHub({ maxConcurrent = 1, busy = [] } = {}) {
  const runtime = new Map(busy.map((id) => [id, { status: { project: id, busy: true } }]));
  const projects = new Map(['a', 'b', 'c', 'd'].map((id) => [id, { id, name: id }]));
  return {
    dataDir: TMP,
    persisted: { maxConcurrent },
    runtime,
    projects,
    observers: { add() {} },
    settingsFor: () => ({}),
    engineOf: () => 'claude',
    queueRetryOnceFor: () => false,
    save() {},
    setStatus() {},
    broadcast() {},
    chat() {},
    rt: () => ({ chat: [] }),
    updateChat() {},
  };
}

/** A TaskQueue with hand-placed queues (restore() would pause a stored waiting item, which this test does not need). */
function queueWith(queues, options = {}) {
  const hub = fakeHub(options);
  const tq = new TaskQueue({ hub, sessions: { get: () => null, stopping: false }, delayMs: 60_000, now: () => NOW });
  tq.queues = queues;
  return { hub, tq };
}

const item = (id, extra = {}) => ({ id, text: id, status: 'waiting', createdAt: NOW - 1000, updatedAt: NOW - 1000, startedAt: null, endedAt: null, chatId: null, meta: null, ...extra });
const queue = (items, paused = false) => ({ paused, reason: paused ? 'user' : null, pausedAt: paused ? NOW : null, items });
const done = (id, durationMs) => item(id, { status: 'done', endedAt: NOW - 500, meta: durationMs == null ? null : { durationMs } });

test('typicalTurnMs: the median of the last ten durations, odd or even', () => {
  const { tq } = queueWith({});
  tq.noteTurnDuration('a', 1000);
  tq.noteTurnDuration('a', 5000);
  tq.noteTurnDuration('a', 3000);
  assert.equal(tq.typicalTurnMs('a'), 3000, 'median of 1s, 3s, 5s');

  tq.noteTurnDuration('b', 1000);
  tq.noteTurnDuration('b', 2000);
  assert.equal(tq.typicalTurnMs('b'), 1500, 'even count: the mean of the two middle values');

  for (let i = 1; i <= 11; i += 1) tq.noteTurnDuration('c', i * 1000);
  assert.equal(tq.typicalTurnMs('c'), 6500, 'only the last ten survive (2s…11s)');
});

test('typicalTurnMs: a stored finished item with meta.durationMs seeds the median; junk is ignored', () => {
  const { tq } = queueWith({
    b: queue([done('q_aaaaaaaaaa01', 90_000), done('q_aaaaaaaaaa02', null), done('q_aaaaaaaaaa03', 0), done('q_aaaaaaaaaa04', 60_000)]),
  });
  assert.equal(tq.typicalTurnMs('b'), 75_000, 'median of 60s + 90s (no meta, 0 and failed items ignored)');

  // A project with no history of its own falls back to every known duration.
  const { tq: other } = queueWith({
    a: queue([done('q_aaaaaaaaaa05', 20_000)]),
    c: queue([done('q_aaaaaaaaaa06', 40_000)]),
  });
  other.noteTurnDuration('d', 60_000);
  assert.equal(other.typicalTurnMs('b'), 40_000, 'fallback median across projects');
  assert.equal(other.typicalTurnMs(), 40_000);
});

test('typicalTurnMs: no data yet is null (the UI must not invent an ETA)', () => {
  const { tq } = queueWith({});
  assert.equal(tq.typicalTurnMs('a'), null);
  assert.equal(tq.typicalTurnMs(), null);
  tq.noteTurnDuration('a', 0);
  tq.noteTurnDuration('a', -5);
  tq.noteTurnDuration('a', Number.NaN);
  tq.noteTurnDuration('a', 25 * 60 * 60 * 1000);
  assert.equal(tq.typicalTurnMs('a'), null, 'zero, negative, NaN and > 24 h are not durations');
});

test('estimateWaitMs: position 1 is the rest of the running turn, position 2 adds the item ahead', () => {
  const b1 = item('q_bbbbbbbbbb01');
  const c1 = item('q_cccccccccc01');
  const { hub, tq } = queueWith(
    {
      a: queue([item('q_aaaaaaaaaa01', { status: 'running', startedAt: NOW - 20_000 })]),
      b: queue([b1]),
      c: queue([c1]),
    },
    { maxConcurrent: 1, busy: ['a'] },
  );
  tq.noteTurnDuration('a', 60_000);
  tq.noteTurnDuration('b', 30_000);
  assert.equal(tq.hasRoom(), false, 'the only slot is held');

  const order = tq.orderedWaiting();
  assert.deepEqual(order.map((e) => e.item.id), [b1.id, c1.id]);
  assert.equal(tq.estimateWaitMs(b1, order), 40_000, '60s typical − 20s already running');
  assert.equal(tq.estimateWaitMs(c1, order), 70_000, '40s left + 30s for the item ahead');

  // A turn that already ran past its typical duration frees its slot "now", never a negative estimate.
  hub.runtime.get('a').status.startedAt = NOW;
  tq.queues.a.items[0].startedAt = NOW - 90_000;
  assert.equal(tq.estimateWaitMs(b1, tq.orderedWaiting()), 0);
});

test('estimateWaitMs: without a duration for the running turn the wait is unknown (null), not zero', () => {
  const b1 = item('q_bbbbbbbbbb02');
  const { tq } = queueWith(
    {
      a: queue([item('q_aaaaaaaaaa02', { status: 'running', startedAt: NOW - 1000 })]),
      b: queue([b1]),
    },
    { maxConcurrent: 1, busy: ['a'] },
  );
  assert.equal(tq.typicalTurnMs('a'), null);
  assert.equal(tq.estimateWaitMs(b1, tq.orderedWaiting()), null);
});

test('estimateWaitMs: a free slot is 0 (hasRoom wins over any history)', () => {
  const b1 = item('q_bbbbbbbbbb03');
  const { tq } = queueWith({ b: queue([b1]) }, { maxConcurrent: 3, busy: [] });
  tq.noteTurnDuration('a', 60_000);
  assert.equal(tq.hasRoom(), true);
  assert.equal(tq.estimateWaitMs(b1, tq.orderedWaiting()), 0);

  const { tq: unlimited } = queueWith({ a: queue([item('q_aaaaaaaaaa03', { status: 'running', startedAt: NOW })]), b: queue([b1]) }, { maxConcurrent: 0, busy: ['a'] });
  assert.equal(unlimited.hasRoom(), true, '0 = no limit');
  assert.equal(unlimited.estimateWaitMs(b1, unlimited.orderedWaiting()), 0);
});

test('estimateWaitMs: a paused queue keeps its item out of the order, so its position is null', () => {
  const d1 = item('q_dddddddddd01');
  const { tq } = queueWith({ d: queue([d1], true) }, { maxConcurrent: 1, busy: [] });
  assert.deepEqual(tq.orderedWaiting(), []);
  assert.equal(tq.positionFor(d1.id), null);
  assert.equal(tq.estimateWaitMs(d1, tq.orderedWaiting()), null, 'not startable now: no position, no estimate');
});
