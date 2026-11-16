// Does the phone keep its screen on while a turn runs? Pure rules (public/js/core/wake-lock-rules.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldHoldWake } from '../public/js/core/wake-lock-rules.js';

test('shouldHoldWake: bekerja saat ada giliran yang berjalan', () => {
  assert.equal(shouldHoldWake({ busy: true }), true);
  assert.equal(shouldHoldWake({ cliBusy: true }), true);
  assert.equal(shouldHoldWake({ planPreparing: 'build' }), true);
  assert.equal(shouldHoldWake({ compacting: true }), true);
});

test('shouldHoldWake: tidak menahan layar saat idle atau halaman tersembunyi', () => {
  assert.equal(shouldHoldWake({}), false);
  assert.equal(shouldHoldWake({ busy: false, cliBusy: false }), false);
  assert.equal(shouldHoldWake({ busy: true }, { hidden: true }), false, 'di saku: baterai dulu');
});
