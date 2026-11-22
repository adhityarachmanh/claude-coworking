// The wait row between steps: shown while a turn is running but no step is running yet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextStepHint } from '../public/js/core/turn-progress.js';

test('baris tunggu: hanya saat giliran hidup tanpa langkah berjalan', () => {
  assert.equal(nextStepHint({ busy: false, running: 0 }), '', 'chat tenang: tidak ada baris');
  assert.equal(nextStepHint({ busy: true, running: 2 }), '', 'ada langkah berjalan: tidak perlu baris');
  assert.equal(nextStepHint({ busy: true, running: 0 }), '⏳ Tim sedang menyusun langkah berikutnya…');
  assert.equal(nextStepHint({}), '', 'tanpa argumen pun aman');
});