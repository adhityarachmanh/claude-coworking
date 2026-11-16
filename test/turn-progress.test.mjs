// Turn progress rules (public/js/core/turn-progress.js): the line that answers "is it finished?" without asking.
import assert from 'node:assert/strict';
import test from 'node:test';
import { progressLabel, turnProgress } from '../public/js/core/turn-progress.js';

const T = 1_000_000;
const user = (ts = T) => ({ kind: 'user', ts, text: 'kerjakan' });
const tool = (ts, status) => ({ kind: 'tool', ts, status, text: 'x' });
const result = (ts, ok = true) => ({ kind: 'result', ts, ok, meta: {} });
const fmt = (ms) => `${Math.floor(ms / 60000)} mnt ${Math.floor((ms % 60000) / 1000)} dtk`;

test('turnProgress: giliran berjalan menghitung langkah dan yang masih berjalan', () => {
  const p = turnProgress([user(), tool(T + 1000, 'ok'), tool(T + 5000, 'running'), tool(T + 6000, 'stale')], { now: T + 60_000, busy: true });
  assert.deepEqual([p.finished, p.total, p.running, p.stale], [false, 3, 1, 1]);
  assert.equal(p.durationMs, 60_000);
  assert.equal(progressLabel(p, fmt), '⏳ 1 mnt 0 dtk · 3 langkah · 1 berjalan');
});

test('turnProgress: selesai memakai durasi hasil dan menyebut sisa di latar', () => {
  const p = turnProgress([user(), tool(T + 1000, 'ok'), result(T + 90_000)], { now: T + 200_000, busy: false, background: 2 });
  assert.deepEqual([p.finished, p.ok, p.total, p.durationMs, p.background], [true, true, 1, 90_000, 2]);
  assert.equal(progressLabel(p, fmt), '✓ Selesai · 1 mnt 30 dtk · 1 langkah · 2 di latar');
});

test('turnProgress: tanpa hasil dan tidak sibuk = terputus, bukan "selesai"', () => {
  const p = turnProgress([user(), tool(T + 1000, 'stale')], { now: T + 30_000, busy: false });
  assert.equal(p.finished, true);
  assert.equal(p.cut, true);
  assert.equal(progressLabel(p, fmt), '■ Tidak selesai · 0 mnt 30 dtk · 1 langkah');
});

test('turnProgress: selesai tapi langkahnya masih berjalan → tetap disebut (bukan disembunyikan)', () => {
  const p = turnProgress([user(), tool(T + 1000, 'running'), result(T + 90_000)], { now: T + 100_000, busy: false });
  assert.equal(p.finished, true);
  assert.equal(p.running, 1);
  assert.equal(progressLabel(p, fmt), '✓ Selesai · 1 mnt 30 dtk · 1 langkah · ⏳ 1 berjalan');
});

test('turnProgress: hanya giliran terakhir yang dihitung', () => {
  const p = turnProgress([user(T), tool(T + 1000, 'ok'), result(T + 2000), user(T + 10_000), tool(T + 11_000, 'running')], { now: T + 20_000, busy: true });
  assert.equal(p.total, 1);
  assert.equal(p.running, 1);
  assert.equal(p.startedAt, T + 10_000);
});

test('turnProgress: tanpa pesan user → tidak ada baris', () => {
  assert.equal(turnProgress([tool(T, 'ok')], { now: T, busy: false }), null);
  assert.equal(progressLabel(null), '');
});
