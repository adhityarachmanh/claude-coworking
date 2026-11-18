// "Terakhir di project ini" (public/js/core/recent-models.js): three newest picks per project, device-local.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAllRecent, readRecentModels, rememberRecentModel } from '../public/js/core/recent-models.js';

const fakeStorage = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) };
};

test('a pick moves to the front, twice is not repeated, three at most', () => {
  const s = fakeStorage();
  rememberRecentModel('p1', 'a', s);
  rememberRecentModel('p1', 'b', s);
  rememberRecentModel('p1', 'c', s);
  assert.deepEqual(readRecentModels('p1', s), ['c', 'b', 'a']);
  rememberRecentModel('p1', 'a', s);
  assert.deepEqual(readRecentModels('p1', s), ['a', 'c', 'b']);
  rememberRecentModel('p1', 'd', s);
  assert.deepEqual(readRecentModels('p1', s), ['d', 'a', 'c']);
  assert.deepEqual(readRecentModels('p2', s), [], 'per project');
});

test('Auto and empty values are not models; broken storage never throws', () => {
  const s = fakeStorage();
  rememberRecentModel('p1', 'auto', s);
  rememberRecentModel('p1', '', s);
  rememberRecentModel('p1', null, s);
  assert.deepEqual(readRecentModels('p1', s), []);
  s.setItem('office.recentModels', '{not json');
  assert.deepEqual(readAllRecent(s), {});
  const throwing = { getItem: () => JSON.parse('x'), setItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(readAllRecent(throwing), {});
  assert.deepEqual(rememberRecentModel('p1', 'm', throwing), ['m'], 'still reported to the caller');
});

test('only sane project ids and model values are kept, and the project map is bounded', () => {
  const s = fakeStorage();
  s.setItem('office.recentModels', JSON.stringify({ 'p 1': ['x'], p1: ['ok', 42, 'x'.repeat(300), 'ok'], '../x': ['y'] }));
  assert.deepEqual(readAllRecent(s), { p1: ['ok'] });
  for (let i = 0; i < 130; i++) rememberRecentModel(`p${i}`, 'm', s);
  assert.ok(Object.keys(readAllRecent(s)).length <= 100, 'the oldest projects are dropped');
});
