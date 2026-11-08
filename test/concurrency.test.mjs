// Global concurrency governor (src/concurrency.js): validation of the stored limit, which projects count as
// active, and the refusal a new turn gets when every slot is taken.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeCount, activeProjects, checkTurn, cleanMaxConcurrent, DEFAULT_MAX_CONCURRENT, MAX_CONCURRENT_CAP, maxConcurrentOf, overCapacity } from '../src/concurrency.js';

/** A hub shape just big enough for the governor. */
function fakeHub(maxConcurrent, busy = {}, names = {}) {
  const runtime = new Map();
  for (const [id, status] of Object.entries(busy)) runtime.set(id, { status });
  const projects = new Map();
  for (const [id, name] of Object.entries(names)) projects.set(id, { id, name });
  return { persisted: { maxConcurrent }, runtime, projects };
}

test('concurrency: a stored limit is an integer 0…8, anything else is the default', () => {
  assert.equal(DEFAULT_MAX_CONCURRENT, 3);
  assert.equal(MAX_CONCURRENT_CAP, 8);
  assert.equal(cleanMaxConcurrent(undefined), 3, 'missing field (older state.json)');
  assert.equal(cleanMaxConcurrent(null), 3);
  assert.equal(cleanMaxConcurrent(-1), 3);
  assert.equal(cleanMaxConcurrent(9), 3);
  assert.equal(cleanMaxConcurrent(2.5), 3);
  assert.equal(cleanMaxConcurrent('2'), 3, 'never a string');
  assert.equal(cleanMaxConcurrent(0), 0, '0 = unlimited');
  assert.equal(cleanMaxConcurrent(8), 8);
  assert.equal(maxConcurrentOf({ persisted: {} }), 3);
  assert.equal(maxConcurrentOf({ persisted: { maxConcurrent: 0 } }), 0);
  assert.equal(maxConcurrentOf(null), 3);
});

test('concurrency: only server-run turns count; a CLI-only turn does not', () => {
  const hub = fakeHub(2, {
    a: { busy: true, cliBusy: false },
    b: { busy: false, cliBusy: true },
    c: { busy: false, cliBusy: false },
  });
  assert.deepEqual(activeProjects(hub), ['a']);
  assert.equal(activeCount(hub), 1);
  assert.equal(overCapacity(hub), false, 'one of two slots used');
  hub.runtime.get('b').status.busy = true;
  assert.equal(activeCount(hub), 2);
  assert.equal(overCapacity(hub), true);
  hub.persisted.maxConcurrent = 0;
  assert.equal(overCapacity(hub), false, '0 = unlimited');
});

test('concurrency: a full limit refuses a new project, but a follow-up in a busy project always passes', () => {
  const hub = fakeHub(2, { a: { busy: true }, b: { busy: true } }, { a: 'toko', b: 'blog' });
  const denied = checkTurn(hub, 'c', { busy: false });
  assert.equal(denied.status, 429);
  assert.equal(denied.body.code, 'concurrency');
  assert.equal(denied.body.limit, 2);
  assert.deepEqual(denied.body.active, [
    { id: 'a', name: 'toko' },
    { id: 'b', name: 'blog' },
  ]);
  assert.match(denied.body.error, /Batas 2 giliran bersamaan/);
  assert.match(denied.body.error, /toko, blog/);
  assert.equal(checkTurn(hub, 'a', { busy: true }), null, 'a message sent mid-turn joins the running turn');
  assert.equal(checkTurn(fakeHub(3, { a: { busy: true } }), 'b', { busy: false }), null, 'a free slot');
  assert.equal(checkTurn(fakeHub(0, { a: { busy: true }, b: { busy: true } }), 'c', { busy: false }), null, 'unlimited');
});

test('concurrency: the refusal lists at most three project names, then an ellipsis', () => {
  const busy = { a: { busy: true }, b: { busy: true }, c: { busy: true }, d: { busy: true } };
  const names = { a: 'toko', b: 'blog', c: 'kantor', d: 'api' };
  const denied = checkTurn(fakeHub(4, busy, names), 'e', { busy: false });
  assert.equal(denied.body.error.includes('toko, blog, kantor'), true);
  assert.equal(denied.body.error.includes('api'), false, 'the fourth name is only in body.active');
  assert.equal(denied.body.error.includes('…'), true);
  assert.equal(denied.body.active.length, 4);
  // A project without a known entry still gets its id as the name (never "undefined").
  const unknown = checkTurn(fakeHub(1, { x: { busy: true } }), 'y', { busy: false });
  assert.deepEqual(unknown.body.active, [{ id: 'x', name: 'x' }]);
});
