// 🗂 Semua project: summary, card order and counts (public/js/core/dashboard-rules.js, pure, no DOM).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GROUP,
  announcement,
  contextPct,
  countGroups,
  countsText,
  currentTask,
  matchesQuery,
  relTime,
  snippetOf,
  sortSummaries,
  summarize,
} from '../public/js/core/dashboard-rules.js';

const NOW = 1_800_000_000_000;
const p = (id, extra = {}) => ({ id, name: id, favorite: false, lastActivity: 0, ...extra });

describe('dashboard-rules: summarize', () => {
  test('izin menunggu → butuh kamu, pill dengan jumlah, label dan chat id izin tertua', () => {
    const s = summarize(p('a'), { pending: 2, busy: true }, {
      approvals: [
        { id: 'x2', status: 'pending', ts: 20, label: 'Bash npm test', chatId: 'm9' },
        { id: 'x1', status: 'pending', ts: 10, label: 'Write hasil.txt', chatId: 'm5' },
        { id: 'x0', status: 'allowed', ts: 5, label: 'lama', chatId: 'm1' },
      ],
    });
    assert.equal(s.group, GROUP.NEEDS);
    assert.deepEqual(s.pill, { kind: 'ask', text: '✋ Butuh izin (2)' });
    assert.equal(s.waitingLabel, 'Write hasil.txt');
    assert.equal(s.approvalChatId, 'm5');
  });

  test('izin dari approvals saja (status belum menyusul) tetap dihitung', () => {
    const s = summarize(p('a'), {}, { approvals: [{ status: 'pending', ts: 1, label: 'x', chatId: 'm1' }] });
    assert.equal(s.pill.text, '✋ Butuh izin (1)');
  });

  test('giliran terputus (tidak sedang jalan) → ⚠ Terputus', () => {
    const s = summarize(p('a'), { interrupted: { text: 'halo' } });
    assert.deepEqual([s.group, s.pill.kind, s.pill.text], [GROUP.NEEDS, 'cut', '⚠ Terputus']);
  });

  test('bekerja + vonis macet → ⚠ mungkin macet (butuh kamu); tanpa vonis → ⏳ Bekerja dengan role & tugas', () => {
    const st = { busy: true, working: { frontend: { tools: 1, agents: 0 }, qa: { tools: 0, agents: 0 } } };
    const chat = [
      { kind: 'user', text: 'perbaiki checkout', ts: 1 },
      { kind: 'delegate', role: 'frontend', text: 'Perbaiki tombol bayar', status: 'running', ts: 2 },
    ];
    const stuckOne = summarize(p('a'), st, { chat, stuck: 1 });
    assert.deepEqual([stuckOne.group, stuckOne.pill.text], [GROUP.NEEDS, '⚠ mungkin macet']);
    const s = summarize(p('a'), st, { chat });
    assert.deepEqual([s.group, s.pill.text], [GROUP.WORKING, '⏳ Bekerja']);
    assert.deepEqual(s.roles, ['claude', 'frontend']);
    assert.equal(s.task, 'Perbaiki tombol bayar');
  });

  test('CLI saja yang bekerja ditandai cli', () => {
    const s = summarize(p('a'), { cliBusy: true });
    assert.equal(s.group, GROUP.WORKING);
    assert.equal(s.cli, true);
  });

  test('antrian (berjalan atau dijeda) → 📋 Antrian n, ⏸ saat dijeda', () => {
    assert.equal(summarize(p('a'), { taskQueue: { waiting: 2, running: 1, paused: false } }).pill.text, '📋 Antrian 3');
    const paused = summarize(p('a'), { taskQueue: { waiting: 2, running: 0, paused: true } });
    assert.deepEqual([paused.group, paused.pill.text], [GROUP.QUEUE, '📋 Antrian 2 ⏸']);
    assert.equal(summarize(p('a'), { taskQueue: { waiting: 0, running: 0, done: 4 } }).group, GROUP.IDLE);
  });

  test('idle: 💤, model aktif lebih dulu dari setelan, konteks %, aktivitas terakhir dari chat/event', () => {
    const s = summarize(p('a', { lastActivity: 100 }), { model: 'opus', activeModel: 'claude-fable-5', context: { used: 50_000, window: 200_000 } }, {
      chat: [{ kind: 'assistant', text: 'Selesai.', ts: 300 }],
      events: [{ ts: 250 }],
    });
    assert.deepEqual([s.group, s.pill.text], [GROUP.IDLE, '💤 Idle']);
    assert.equal(s.model, 'claude-fable-5');
    assert.equal(s.contextPct, 25);
    assert.equal(s.lastActivity, 300);
    assert.deepEqual(s.snippet, { who: 'claude', text: 'Selesai.' });
    assert.deepEqual(s.roles, []);
    assert.equal(s.task, null);
  });

  test('status kosong (project belum pernah dibuka) tidak melempar', () => {
    const s = summarize({ id: 'x' }, undefined, undefined);
    assert.equal(s.name, 'x');
    assert.equal(s.group, GROUP.IDLE);
    assert.equal(s.snippet, null);
  });
});

describe('dashboard-rules: potongan teks', () => {
  test('snippet: pesan user/assistant terbaru yang berisi, spasi dirapatkan, dipotong', () => {
    const long = 'a '.repeat(200);
    assert.deepEqual(snippetOf([{ kind: 'user', text: 'halo\n\n  dunia' }, { kind: 'tool', text: 'Bash' }, { kind: 'assistant', text: '   ' }]), { who: 'user', text: 'halo dunia' });
    const clipped = snippetOf([{ kind: 'assistant', text: long }]);
    assert.ok(clipped.text.length <= 160 && clipped.text.endsWith('…'));
    assert.equal(snippetOf([{ kind: 'user', text: 'lama', rewound: true }]), null);
    assert.equal(snippetOf([]), null);
  });

  test('tugas saat ini: baris running terbaru, bukan sisa giliran lama', () => {
    assert.equal(currentTask([{ kind: 'tool', text: 'npm test', status: 'running' }, { kind: 'result' }]), null);
    assert.equal(currentTask([{ kind: 'tool', text: 'a', status: 'done' }, { kind: 'tool', text: 'b', status: 'running' }]), 'b');
  });

  test('konteks %: null tanpa window, maks 100', () => {
    assert.equal(contextPct({ context: { used: 10 } }), null);
    assert.equal(contextPct({ context: { used: 300, window: 200 } }), 100);
    assert.equal(contextPct({}), null);
  });

  test('relTime: baru saja / mnt / jam / hari / tanggal', () => {
    assert.equal(relTime(0, NOW), '');
    assert.equal(relTime(NOW - 30_000, NOW), 'baru saja');
    assert.equal(relTime(NOW - 2 * 60_000, NOW), '2 mnt lalu');
    assert.equal(relTime(NOW - 3 * 3_600_000, NOW), '3 jam lalu');
    assert.equal(relTime(NOW - 2 * 86_400_000, NOW), '2 hari lalu');
    assert.match(relTime(NOW - 30 * 86_400_000, NOW), /\d/);
  });
});

describe('dashboard-rules: urutan & hitungan', () => {
  const make = (id, st, extra = {}, ctx = {}) => summarize(p(id, extra), st, ctx);

  test('butuh kamu → bekerja → antrian → idle (favorit dulu, lalu terbaru); demo paling bawah', () => {
    const list = [
      make('idle-lama', {}, { lastActivity: 10 }),
      make('demo', {}, { lastActivity: 999 }, { demo: true }),
      make('idle-baru', {}, { lastActivity: 50 }),
      make('idle-fav', {}, { favorite: true, lastActivity: 1 }),
      make('antrian', { taskQueue: { waiting: 1 } }),
      make('kerja', { busy: true }),
      make('putus', { interrupted: {} }),
      make('izin', { pending: 1 }),
    ];
    assert.deepEqual(sortSummaries(list).map((s) => s.id), ['izin', 'putus', 'kerja', 'antrian', 'idle-fav', 'idle-baru', 'idle-lama', 'demo']);
  });

  test('dalam satu grup: aktivitas terbaru dulu, lalu nama', () => {
    const list = [make('b', { busy: true }, { lastActivity: 5 }), make('a', { busy: true }, { lastActivity: 5 }), make('c', { busy: true }, { lastActivity: 9 })];
    assert.deepEqual(sortSummaries(list).map((s) => s.id), ['c', 'a', 'b']);
  });

  test('hitungan dan teks ringkas', () => {
    const list = [make('a', { pending: 1 }), make('b', { busy: true }), make('c', { busy: true }), make('d', {})];
    const c = countGroups(list);
    assert.deepEqual(c, { needs: 1, working: 2, queue: 0, idle: 1 });
    assert.equal(countsText(c), '1 butuh kamu · 2 bekerja');
    assert.equal(countsText({ needs: 0, working: 0, queue: 0, idle: 3 }), 'semua idle');
    assert.equal(countsText({ needs: 0, working: 0, queue: 0, idle: 0 }), 'belum ada project');
  });

  test('saring nama (tanpa beda huruf besar)', () => {
    const s = make('Toko-Online', {});
    assert.equal(matchesQuery(s, 'toko'), true);
    assert.equal(matchesQuery(s, '  '), true);
    assert.equal(matchesQuery(s, 'gudang'), false);
  });

  test('pengumuman aria-live hanya untuk perubahan penting', () => {
    const idle = make('a', {});
    const busy = make('a', { busy: true });
    const ask = make('a', { pending: 1 });
    assert.equal(announcement(null, ask), null, 'render pertama tidak diumumkan');
    assert.equal(announcement(idle, busy), null);
    assert.equal(announcement(busy, ask), 'a: ✋ Butuh izin (1)');
    assert.equal(announcement(busy, idle), 'a: selesai');
    assert.equal(announcement(ask, ask), null);
  });
});
