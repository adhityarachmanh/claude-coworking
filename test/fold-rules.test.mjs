import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldFlags } from '../public/js/core/fold-rules.js';

const icons = (s) => foldFlags(s).map((f) => f.icon);

test('tidak ada apa-apa saat semuanya aman', () => {
  assert.deepEqual(foldFlags(), []);
  assert.deepEqual(foldFlags({ pending: false, busy: false, online: true }), []);
});

test('izin menunggu, sambungan putus dan giliran berjalan punya ikonnya sendiri', () => {
  assert.deepEqual(icons({ pending: true }), ['✋']);
  assert.deepEqual(icons({ online: false }), ['⚡']);
  assert.deepEqual(icons({ busy: true }), ['⏳']);
});

test('urutannya tetap: izin dulu, lalu sambungan, lalu sibuk', () => {
  assert.deepEqual(icons({ pending: true, busy: true, online: false }), ['✋', '⚡', '⏳']);
});

test('setiap ikon membawa label yang bisa dibacakan', () => {
  for (const f of foldFlags({ pending: true, busy: true, online: false })) assert.match(f.label, /\w/);
});
