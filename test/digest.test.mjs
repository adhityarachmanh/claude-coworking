// 📅 Rekap mingguan: totals for 7 days, per project and model, plus the busiest hour. The schedule part also
// proves that enabling it never fires at once and that a stored slot is not played twice.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDigestSettings, cleanDigestSettings, DigestScheduler, digestUnread, weeklyDigest } from '../src/digest.js';

const at = (day, hour) => new Date(2026, 10, day, hour).getTime();
const now = at(24, 12);
const row = (over = {}) => ({ ts: at(23, 10), projectId: 'p1', project: 'toko', model: 'opus', input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 1, requests: 2, turns: 1, sessionId: 's1', ...over });

test('weeklyDigest: markdown berisi total, project, model, jam tersibuk', () => {
  const { markdown, summary } = weeklyDigest([row(), row({ projectId: 'p2', project: 'blog', model: 'sonnet', costUsd: 2, requests: 3, ts: at(22, 14) })], { now });
  assert.match(markdown, /Rekap 7 hari/);
  assert.match(markdown, /Biaya \$3,00/);
  assert.match(markdown, /## Project/);
  assert.match(markdown, /blog/);
  assert.match(markdown, /`sonnet`/);
  assert.equal(summary.busiestHour, 14);
});

test('weeklyDigest: tanpa data tetap jujur', () => {
  const { markdown } = weeklyDigest([], { now });
  assert.match(markdown, /Belum ada aktivitas/);
  assert.doesNotMatch(markdown, /## Project/);
});

test('cleanDigestSettings + applyDigestSettings: jadwal mingguan yang aman', () => {
  assert.deepEqual(cleanDigestSettings({ enabled: 'ya', weekday: 9, time: '25:00', lastMarkdown: 5 }), {
    enabled: false,
    weekday: 1,
    time: '08:00',
    dueAt: null,
    lastAt: null,
    lastMarkdown: '',
    seenAt: null,
  });
  const monday7 = at(23, 7);
  const on = applyDigestSettings(null, { enabled: true, weekday: 1, time: '08:00' }, monday7);
  assert.equal(on.dueAt, at(23, 8), 'jam 08.00 Senin berikutnya, bukan langsung');
  assert.equal(applyDigestSettings(null, { enabled: false }, monday7).dueAt, null);
  const moved = applyDigestSettings(on, { time: '09:00' }, monday7);
  assert.equal(moved.dueAt, at(23, 9), 'jam diubah memilih slot baru');
  assert.equal(applyDigestSettings(on, {}, monday7).dueAt, on.dueAt, 'jadwal sama mempertahankan slot');
  assert.equal(applyDigestSettings(on, { enabled: true, weekday: 1, time: '08:00' }, at(23, 9)).dueAt, at(30, 8), 'slot lewat pindah ke minggu depan');
  assert.equal(applyDigestSettings({ ...on, lastAt: monday7 }, {}, monday7).lastAt, monday7, 'rekap terakhir tidak hilang');
});

test('digestUnread: rekap baru belum dibaca sampai seenAt menyusul', () => {
  assert.equal(digestUnread({ lastAt: null }), false);
  assert.equal(digestUnread({ lastAt: 10 }), true);
  assert.equal(digestUnread({ lastAt: 10, seenAt: 9 }), true);
  assert.equal(digestUnread({ lastAt: 10, seenAt: 10 }), false);
});

test('DigestScheduler: slot lewat membangun rekap, menyimpan, dan menyiarkan sekali', () => {
  const current = at(23, 8);
  const calls = [];
  const hub = {
    persisted: { digest: { enabled: true, weekday: 1, time: '08:00', dueAt: current - 1000, lastAt: null, lastMarkdown: '', seenAt: null } },
    save: () => calls.push('save'),
    broadcast: (type) => calls.push(type),
  };
  const ledger = { query: () => [row({ ts: current - 3600_000 })] };
  const scheduler = new DigestScheduler({ hub, ledger, now: () => current });
  scheduler.tick();
  assert.match(hub.persisted.digest.lastMarkdown, /Rekap 7 hari/);
  assert.equal(hub.persisted.digest.lastAt, current);
  assert.equal(hub.persisted.digest.seenAt, null);
  assert.ok(hub.persisted.digest.dueAt > current, 'slot berikutnya dihitung');
  assert.deepEqual(calls, ['save', 'digest']);
  scheduler.tick();
  assert.deepEqual(calls, ['save', 'digest'], 'tidak dobel dalam satu slot');
});
