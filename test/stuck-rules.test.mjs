// ⚠ stuck detector, the pure rules (public/js/core/stuck-rules.js): thresholds, output tracking, chip text,
// delegation activity, when to read more, one notification per episode. Clock values are passed in: no waiting.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STUCK,
  clockSkew,
  delegateChipText,
  delegateStuck,
  detailSig,
  latest,
  shouldPollDetail,
  shouldPollOutput,
  stuckEpisodes,
  toLocal,
  toolChipText,
  toolStuck,
  sleepGap,
  trackOutput,
} from '../public/js/core/stuck-rules.js';

const MIN = 60_000;
const T0 = 1_800_000_000_000;

test('thresholds live in one frozen object', () => {
  assert.equal(STUCK.TOOL_QUIET_MS, 3 * MIN);
  assert.equal(STUCK.TOOL_LONG_MS, 10 * MIN);
  assert.equal(STUCK.DELEGATE_QUIET_MS, 5 * MIN);
  assert.ok(STUCK.DETAIL_POLL_MS >= 30_000, 'task-detail never more often than every 30 s');
  assert.ok(Object.isFrozen(STUCK));
});

test('clockSkew / toLocal: smallest sample wins, never in the future, null stays null', () => {
  assert.equal(clockSkew([]), 0);
  assert.equal(clockSkew(undefined), 0);
  assert.equal(clockSkew([120_050, 120_010, 120_400, 'x']), 120_010);
  assert.equal(toLocal(T0, 1000, T0 + 5000), T0 + 1000);
  assert.equal(toLocal(T0 + 9000, 0, T0), T0, 'a server clock ahead is clamped to now');
  assert.equal(toLocal(null, 0, T0), null);
  assert.equal(toLocal(undefined, 0, T0), null);
});

test('trackOutput: first read empty = quiet since start; first read with output = changed now; same text keeps the time', () => {
  const empty = trackOutput(null, '', T0 + MIN, T0);
  assert.equal(empty.changedAt, T0);
  assert.equal(empty.readAt, T0 + MIN);
  const some = trackOutput(null, 'building…\n', T0 + MIN, T0);
  assert.equal(some.changedAt, T0 + MIN);
  const same = trackOutput(some, 'building…\n', T0 + 2 * MIN, T0);
  assert.equal(same.changedAt, T0 + MIN);
  assert.equal(same.readAt, T0 + 2 * MIN);
  const grew = trackOutput(same, 'building…\ndone\n', T0 + 3 * MIN, T0);
  assert.equal(grew.changedAt, T0 + 3 * MIN);
  // Truncated to the last 8 KB: same length, different tail is still a change.
  const a = trackOutput(null, `${'x'.repeat(8000)}aaa`, T0, T0);
  assert.equal(trackOutput(a, `${'x'.repeat(8000)}bbb`, T0 + MIN, T0).changedAt, T0 + MIN);
});

test('toolStuck: quiet output 3 min → chip; adapts to minutes; fresh output needed for "quiet"', () => {
  const start = T0;
  const out = (changedAt, readAt) => ({ sig: 's', changedAt, readAt });
  assert.equal(toolStuck({ startedAt: start, output: out(start, start + 2 * MIN), now: start + 2 * MIN }), null);
  assert.deepEqual(toolStuck({ startedAt: start, output: out(start, start + 3 * MIN), now: start + 3 * MIN }), { reason: 'quiet', minutes: 3 });
  assert.deepEqual(toolStuck({ startedAt: start, output: out(start + MIN, start + 7 * MIN), now: start + 7 * MIN + 30_000 }), { reason: 'quiet', minutes: 6 });
  // A stale read (tab was asleep) says nothing about now: no "quiet" verdict yet.
  assert.equal(toolStuck({ startedAt: start, output: out(start, start + MIN), now: start + 5 * MIN }), null);
  // Output keeps changing: no chip before 10 min.
  assert.equal(toolStuck({ startedAt: start, output: out(start + 9 * MIN, start + 9 * MIN), now: start + 9 * MIN + 59_000 }), null);
});

test('toolStuck: running 10+ min → chip even with changing or unreadable output; elapsed is a floor', () => {
  assert.deepEqual(toolStuck({ startedAt: T0, output: null, now: T0 + 10 * MIN }), { reason: 'long', minutes: 10 });
  assert.deepEqual(toolStuck({ startedAt: T0, output: { changedAt: T0 + 11 * MIN, readAt: T0 + 12 * MIN }, now: T0 + 12 * MIN }), { reason: 'long', minutes: 12 });
  // Start time unknown or skewed late, but Claude Code says it has run 11 minutes.
  assert.deepEqual(toolStuck({ startedAt: null, elapsedMs: 11 * MIN, now: T0 }), { reason: 'long', minutes: 11 });
  assert.deepEqual(toolStuck({ startedAt: T0, elapsedMs: 11 * MIN, now: T0 + MIN }), { reason: 'long', minutes: 11 });
  assert.equal(toolStuck({ startedAt: T0, now: T0 + 9 * MIN }), null);
});

test('chip texts', () => {
  assert.equal(toolChipText({ reason: 'quiet', minutes: 3 }), '⚠ Tidak ada output 3 mnt — mungkin macet');
  assert.equal(toolChipText({ reason: 'long', minutes: 12 }), '⚠ Berjalan 12 mnt — mungkin macet');
  assert.equal(delegateChipText('Adhitron - Backend', { reason: 'idle', minutes: 5 }), '⚠ Adhitron - Backend tidak ada aktivitas 5 mnt');
});

test('delegateStuck: 5 min without activity; latest() ignores unknowns', () => {
  assert.equal(delegateStuck({ lastActivityAt: T0, now: T0 + 4 * MIN + 59_000 }), null);
  assert.deepEqual(delegateStuck({ lastActivityAt: T0, now: T0 + 5 * MIN }), { reason: 'idle', minutes: 5 });
  assert.deepEqual(delegateStuck({ lastActivityAt: T0, now: T0 + 8 * MIN + 10_000 }), { reason: 'idle', minutes: 8 });
  assert.equal(delegateStuck({ lastActivityAt: null, now: T0 }), null);
  assert.equal(latest(T0, null, T0 + 5, undefined, T0 + 2), T0 + 5);
  assert.equal(latest(), -Infinity);
});

test('shouldPollOutput: only off-screen rows, after 2 min, at most every 30 s', () => {
  const base = { runningMs: 2 * MIN, lastPollAt: null, now: T0, onScreen: false };
  assert.equal(shouldPollOutput(base), true);
  assert.equal(shouldPollOutput({ ...base, onScreen: true }), false, 'live-output already reads it');
  assert.equal(shouldPollOutput({ ...base, runningMs: MIN }), false, 'too early to be quiet for 3 min');
  assert.equal(shouldPollOutput({ ...base, lastPollAt: T0 - 29_000 }), false);
  assert.equal(shouldPollOutput({ ...base, lastPollAt: T0 - 30_000 }), true);
});

test('shouldPollDetail: visible page only, after 1 min quiet, at most every 30 s', () => {
  const base = { quietMs: MIN, lastPollAt: null, now: T0, visible: true };
  assert.equal(shouldPollDetail(base), true);
  assert.equal(shouldPollDetail({ ...base, visible: false }), false);
  assert.equal(shouldPollDetail({ ...base, quietMs: 30_000 }), false, 'cheap signals still show activity');
  assert.equal(shouldPollDetail({ ...base, lastPollAt: T0 - 29_999 }), false);
  assert.equal(shouldPollDetail({ ...base, lastPollAt: T0 - 30_000 }), true);
});

test('detailSig: a new step, a finished step or a newer transcript changes it', () => {
  const d = { updatedAt: 5, steps: [{ ts: 1, status: 'running' }] };
  assert.equal(detailSig(d), detailSig({ ...d }));
  assert.notEqual(detailSig(d), detailSig({ ...d, updatedAt: 6 }));
  assert.notEqual(detailSig(d), detailSig({ ...d, steps: [{ ts: 1, status: 'ok' }] }));
  assert.notEqual(detailSig(d), detailSig({ ...d, steps: [...d.steps, { ts: 2 }] }));
  assert.equal(detailSig(null), '');
});

test('stuckEpisodes: one notification per project|role episode; a grace period before an episode ends', () => {
  let r = stuckEpisodes(new Map(), ['p|devops'], T0);
  assert.deepEqual(r.fire, ['p|devops']);
  r = stuckEpisodes(r.next, ['p|devops', 'p|devops', 'p|backend'], T0 + 15_000);
  assert.deepEqual(r.fire, ['p|backend'], 'devops is the same episode; duplicates count once');
  // devops unstuck for 30 s, then stuck again: still the same episode
  r = stuckEpisodes(r.next, ['p|backend'], T0 + 30_000);
  r = stuckEpisodes(r.next, ['p|backend', 'p|devops'], T0 + 45_000);
  assert.deepEqual(r.fire, []);
  // backend unstuck longer than the grace period: a new episode later notifies again
  r = stuckEpisodes(r.next, ['p|devops'], T0 + 45_000 + STUCK.EPISODE_GRACE_MS);
  r = stuckEpisodes(r.next, ['p|devops', 'p|backend'], T0 + 50_000 + STUCK.EPISODE_GRACE_MS);
  assert.deepEqual(r.fire, ['p|backend']);
});

test('sleepGap: a late tick (sleep, frozen tab) is ignored minus one normal tick; normal ticks are 0', () => {
  assert.equal(sleepGap(null, T0), 0);
  assert.equal(sleepGap(T0, T0 + STUCK.TICK_MS), 0);
  assert.equal(sleepGap(T0, T0 + STUCK.SLEEP_GAP_MS), 0);
  assert.equal(sleepGap(T0, T0 + 60 * MIN), 60 * MIN - STUCK.TICK_MS);
});
