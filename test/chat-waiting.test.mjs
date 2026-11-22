// How many steps of the current turn are still running (drives the wait row's visibility).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextStepHint, runningSteps } from '../public/js/core/turn-progress.js';

test('langkah berjalan dihitung hanya setelah user prompt terakhir, status running saja', () => {
  const msgs = [
    { kind: 'user', ts: 1 },
    { kind: 'tool', status: 'ok', ts: 2 },
    { kind: 'tool', status: 'running', ts: 3 },
    { kind: 'delegate', status: 'running', ts: 4 },
    { kind: 'tool', status: 'stale', ts: 5 },
  ];
  assert.equal(runningSteps(msgs), 2, 'dua langkah running (stale tidak dihitung)');
  // A new user prompt starts a new turn: the running steps of the previous turn do not count.
  assert.equal(runningSteps([...msgs, { kind: 'user', ts: 6 }]), 0);
});

test('aktivitas: baris tunggu hanya saat busy tanpa run live', () => {
  // Same rule the activity tab applies: busy and no live run -> the hint text.
  assert.equal(nextStepHint({ busy: true, running: 0 }), '⏳ Tim sedang menyusun langkah berikutnya…');
  assert.equal(nextStepHint({ busy: true, running: 1 }), '');
  assert.equal(nextStepHint({ busy: false, running: 0 }), '');
});