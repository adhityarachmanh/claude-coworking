// The "no news from the laptop" chip text, as pure rules (public/js/core/freshness.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { STALE_MS, freshnessText } from '../public/js/core/freshness.js';

test('freshnessText: diam sampai tiga ping terlewat', () => {
  assert.equal(freshnessText(null), '');
  assert.equal(freshnessText(undefined), '');
  assert.equal(freshnessText(Number.NaN), '');
  assert.equal(freshnessText(-1), '');
  assert.equal(freshnessText(0), '');
  assert.equal(freshnessText(STALE_MS / 1000 - 1), '');
});

test('freshnessText: detik lalu menit, dengan angka yang jelas', () => {
  assert.equal(freshnessText(45), '45 dtk tanpa kabar');
  assert.equal(freshnessText(89), '89 dtk tanpa kabar');
  assert.equal(freshnessText(90), '1 mnt tanpa kabar');
  assert.equal(freshnessText(130), '2 mnt tanpa kabar');
});
