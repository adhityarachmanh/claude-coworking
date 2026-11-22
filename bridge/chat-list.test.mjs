// bridge/chat-list.test.mjs — test modul murni pengelompokan riwayat percakapan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupConversations } from './src/chat-list.mjs';

const NOW = new Date(2026, 10, 22, 12, 0, 0).getTime(); // 22 Nov 2026 12:00 (waktu lokal)
const at = (y, m, d, h = 9) => new Date(y, m, d, h, 0, 0).toISOString();
const keys = (list) => groupConversations(list, NOW).map((g) => g.key);
const labels = (list) => groupConversations(list, NOW).map((g) => g.label);

test('chat-list: kelompok memakai hari kalender lokal', () => {
  const list = [
    { id: 'a', updatedAt: at(2026, 10, 22) },  // hari ini
    { id: 'b', updatedAt: at(2026, 10, 21) },  // kemarin
    { id: 'c', updatedAt: at(2026, 10, 19) },  // 3 hari lalu → 7 hari
    { id: 'd', updatedAt: at(2026, 10, 1) },   // 3 minggu → lebih lama
  ];
  assert.deepEqual(keys(list), ['today', 'yesterday', 'week', 'older']);
  assert.deepEqual(labels(list), ['Hari ini', 'Kemarin', '7 hari terakhir', 'Lebih lama']);
});

test('chat-list: batas 7 hari (6 hari → week, 7 hari → older)', () => {
  const six = [{ id: 'x', updatedAt: at(2026, 10, 16) }];   // 6 hari lalu
  const seven = [{ id: 'y', updatedAt: at(2026, 10, 15) }]; // 7 hari lalu
  assert.deepEqual(keys(six), ['week']);
  assert.deepEqual(keys(seven), ['older']);
});

test('chat-list: batas hari mengikuti kalender, bukan 24 jam', () => {
  // 22 Nov 00:30 (hari ini) vs NOW 12:00; dan 21 Nov 23:30 (kemarin) hanya 12,5 jam lalu.
  const list = [
    { id: 'early-today', updatedAt: new Date(2026, 10, 22, 0, 30).toISOString() },
    { id: 'late-yesterday', updatedAt: new Date(2026, 10, 21, 23, 30).toISOString() },
  ];
  const g = groupConversations(list, NOW);
  assert.deepEqual(g[0].items.map((c) => c.id), ['early-today']);
  assert.deepEqual(g[1].items.map((c) => c.id), ['late-yesterday']);
});

test('chat-list: urut menurun (terbaru dulu) di dalam kelompok', () => {
  const list = [
    { id: 'lama', updatedAt: new Date(2026, 10, 22, 8, 0).toISOString() },
    { id: 'baru', updatedAt: new Date(2026, 10, 22, 11, 0).toISOString() },
    { id: 'tengah', updatedAt: new Date(2026, 10, 22, 9, 0).toISOString() },
  ];
  assert.deepEqual(groupConversations(list, NOW)[0].items.map((c) => c.id), ['baru', 'tengah', 'lama']);
});

test('chat-list: hanya kelompok berisi yang dikembalikan', () => {
  const onlyYesterday = [{ id: 'a', updatedAt: at(2026, 10, 21) }];
  assert.deepEqual(keys(onlyYesterday), ['yesterday']);
});

test('chat-list: daftar kosong / bukan array → []', () => {
  assert.deepEqual(groupConversations([], NOW), []);
  assert.deepEqual(groupConversations(null, NOW), []);
});

test('chat-list: tanggal tak valid / hilang → "Lebih lama", tidak melempar', () => {
  const list = [{ id: 'a', updatedAt: null }, { id: 'b' }, { id: 'c', updatedAt: 'bukan-tanggal' }];
  const g = groupConversations(list, NOW);
  assert.deepEqual(keys(list), ['older']);
  assert.equal(g[0].items.length, 3);
});

test('chat-list: tanggal di masa depan (jam perangkat) → Hari ini', () => {
  const list = [{ id: 'a', updatedAt: new Date(2026, 10, 23, 3, 0).toISOString() }];
  assert.deepEqual(keys(list), ['today']);
});

test('chat-list: sumber fungsi bisa dievaluasi ulang (cara klien menyematkannya)', () => {
  // Klien /chat menyematkan fungsi ini lewat `.toString()`; hasilnya harus berperilaku identik.
  const rebuilt = new Function('return (' + groupConversations.toString() + ')')();
  const list = [
    { id: 'a', updatedAt: at(2026, 10, 22) },
    { id: 'b', updatedAt: at(2026, 10, 21) },
    { id: 'c', updatedAt: at(2026, 10, 1) },
  ];
  assert.deepEqual(rebuilt(list, NOW).map((g) => g.key), groupConversations(list, NOW).map((g) => g.key));
  assert.deepEqual(rebuilt(list, NOW)[0].items.map((c) => c.id), groupConversations(list, NOW)[0].items.map((c) => c.id));
});