// Pure logic of the activity grouping (public/js/core/agent-runs.js): one row per agent instead of one row per
// tool call, plus the honest "running / waiting / slow / done" state the panel shows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SLOW_MS, STALL_MS, donePreview, fmtRun, groupRuns, runMarkup } from '../public/js/core/agent-runs.js';

const T = 1_000_000;
const ev = (id, ts, role, kind = 'tool_start', label = `langkah ${id}`) => ({ id, ts, project: 'p', role, kind, label });

/** The real helpers the panel passes in, reduced to what the markup needs (no DOM needed to test it). */
const helpers = {
  roleName: (role) => ({ backend: 'Adhitron - Backend' })[role] ?? role,
  roleColor: () => '#2b9a66',
  time: (ts) => new Date(ts).toISOString().slice(11, 16),
  escapeHtml: (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  iconFor: (kind) => ({ tool_start: '•', agent_stop: '✓' })[kind] ?? '',
};

test('fmtRun: menit:detik, nilai negatif aman', () => {
  assert.equal(fmtRun(0), '0:00');
  assert.equal(fmtRun(7_000), '0:07');
  assert.equal(fmtRun(72_000), '1:12');
  assert.equal(fmtRun(-5), '0:00');
});

test('dua langkah role sama dalam satu giliran → satu run, terbaru lebih dulu', () => {
  const runs = groupRuns([ev(1, T, 'backend'), ev(2, T + 10_000, 'backend')], { now: T + 20_000, busy: true });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].steps, 2);
  assert.equal(runs[0].status, 'running');
  assert.equal(runs[0].stateText, 'berjalan 0:20');
  assert.equal(runs[0].elapsedMs, 20_000);
});

test('dua agent paralel (backend/frontend berselang-seling) tetap dua baris, keduanya berjalan', () => {
  const runs = groupRuns(
    [ev(1, T, 'backend'), ev(2, T + 1_000, 'frontend'), ev(3, T + 2_000, 'backend'), ev(4, T + 3_000, 'frontend')],
    { now: T + 4_000, busy: true },
  );
  assert.deepEqual(runs.map((r) => r.role), ['frontend', 'backend']);
  assert.deepEqual(runs.map((r) => r.status), ['running', 'running'], 'tidak ada yang salah ditandai selesai');
  assert.equal(runs.find((r) => r.role === 'backend').steps, 2, 'langkah role yang sama digabung');
});

test('giliran baru tidak menghidupkan lagi run giliran sebelumnya', () => {
  const runs = groupRuns(
    [
      ev(1, T, 'claude', 'prompt'),
      ev(2, T + 1_000, 'frontend'),
      ev(3, T + 10_000, 'claude', 'prompt'), // giliran baru
      ev(4, T + 11_000, 'backend'),
    ],
    { now: T + 12_000, busy: true },
  );
  const frontend = runs.find((r) => r.role === 'frontend');
  assert.equal(frontend.status, 'done', 'frontend dari giliran lama tidak "masih jalan"');
  assert.equal(runs.find((r) => r.role === 'backend').status, 'running');
  assert.equal(runs.find((r) => r.role === 'claude').status, 'running');
});

test('role yang masih memegang pekerjaan tetap hidup walau gilirannya sudah lewat (background agent)', () => {
  const runs = groupRuns(
    [ev(1, T, 'claude', 'prompt'), ev(2, T + 1_000, 'reviewer'), ev(3, T + 2_000, 'claude', 'prompt')],
    { now: T + 200_000, busy: true, working: new Set(['reviewer']) },
  );
  const reviewer = runs.find((r) => r.role === 'reviewer');
  assert.equal(reviewer.status, 'slow', 'sudah 3 menit tanpa langkah, tapi masih memegang pekerjaan');
});

test('role yang lama diam tanpa pekerjaan → selesai, bukan "lama, masih jalan"', () => {
  const runs = groupRuns([ev(1, T, 'qa')], { now: T + SLOW_MS + 1, busy: true });
  assert.equal(runs[0].status, 'done');
});

test('ambang 45/120 detik: running → waiting → slow', () => {
  const events = [ev(1, T, 'backend')];
  assert.equal(groupRuns(events, { now: T + STALL_MS - 1, busy: true })[0].status, 'running');
  const waiting = groupRuns(events, { now: T + STALL_MS, busy: true })[0];
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.stateText, 'menunggu 45 dtk');
  const slow = groupRuns(events, { now: T + SLOW_MS, busy: true, working: new Set(['backend']) })[0];
  assert.equal(slow.status, 'slow');
  assert.equal(slow.stateText, 'lama, masih jalan · 2 mnt');
});

test('busy=false membuat semua run done, tanpa spinner', () => {
  const runs = groupRuns([ev(1, T, 'backend'), ev(2, T + 3_000, 'backend')], { now: T + 4_000, busy: false });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'done');
  assert.equal(runs[0].stateText, 'selesai · 0:03', 'durasi berhenti di langkah terakhir, bukan di now');
});

test('agent_stop menutup run walau turn masih berjalan', () => {
  const runs = groupRuns([ev(1, T, 'reviewer'), ev(2, T + 2_000, 'reviewer', 'agent_stop')], { now: T + 3_000, busy: true });
  assert.equal(runs[0].status, 'done');
});

test('durasi tidak pernah negatif saat jam klien mundur', () => {
  const runs = groupRuns([ev(1, T + 10_000, 'backend'), ev(2, T, 'backend')], { now: T + 20_000, busy: false });
  assert.equal(runs[0].elapsedMs, 0);
});

test('donePreview: maksimal 3 baris selesai, sisanya dihitung', () => {
  const done = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, status: 'completed' }));
  assert.deepEqual(donePreview(done, {}).rows.map((t) => t.id), ['t0', 't1', 't2']);
  assert.equal(donePreview(done, {}).hiddenCount, 4);
  assert.equal(donePreview(done, { showAll: true }).rows.length, 7);
  assert.equal(donePreview(done, { showAll: true }).hiddenCount, 0);
  assert.deepEqual(donePreview([{ id: 'solo' }], {}), { rows: [{ id: 'solo' }], hiddenCount: 0 });
});

// ---------- runMarkup: the HTML the panel inserts ----------

test('runMarkup: satu <li class="run"> per run, langkah di dalam <ol>', () => {
  const runs = groupRuns([ev(1, T, 'backend'), ev(2, T + 1_000, 'backend')], { now: T + 2_000, busy: true });
  const html = runMarkup(runs, { now: T + 2_000, expanded: new Map(), recentMs: 5_000, ...helpers });
  assert.equal(html.match(/<li class="run"/g).length, 1);
  assert.match(html, /class="run-head"[^>]*aria-expanded="true"/);
  assert.match(html, /2 langkah/);
  assert.match(html, /data-clock="0:backend"/);
  assert.match(html, /<ol id="run-0:backend" class="run-steps">/);
});

test('runMarkup: run yang selesai terlipat setelah 5 dtk, pilihan pengguna menang', () => {
  const runs = groupRuns([ev(1, T, 'qa')], { now: T + 6_000, busy: false }); // done 6 dtk lalu
  const folded = runMarkup(runs, { now: T + 6_000, expanded: new Map(), recentMs: 5_000, ...helpers });
  assert.match(folded, /aria-expanded="false"/);
  assert.match(folded, /<ol id="run-0:qa" class="run-steps" hidden>/);
  const opened = runMarkup(runs, { now: T + 6_000, expanded: new Map([['0:qa', true]]), recentMs: 5_000, ...helpers });
  assert.match(opened, /aria-expanded="true"/);
  assert.doesNotMatch(opened, /class="run-steps" hidden/);
  const fresh = runMarkup(runs, { now: T + 1_000, expanded: new Map(), recentMs: 5_000, ...helpers });
  assert.match(fresh, /aria-expanded="true"/, 'baru selesai: tetap terbuka sebentar');
});

test('runMarkup: role tak dikenal tetap tampil sebagai namanya, bukan undefined', () => {
  const runs = groupRuns([ev(1, T, 'kurir')], { now: T + 1_000, busy: true });
  const html = runMarkup(runs, { now: T + 1_000, expanded: new Map(), recentMs: 5_000, ...helpers });
  assert.match(html, /<b>kurir<\/b>/);
  assert.doesNotMatch(html, /undefined/);
});

test('runMarkup meng-escape nama role dan label (tidak ada HTML yang disuntikkan)', () => {
  const runs = groupRuns([{ ...ev(1, T, 'data'), label: '<img src=x onerror="alert(1)">' }], { now: T + 1_000, busy: true });
  const html = runMarkup(runs, { now: T + 1_000, expanded: new Map([['0:data', true]]), recentMs: 5_000, ...helpers, roleName: () => '<img src=x onerror="alert(1)">' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});
