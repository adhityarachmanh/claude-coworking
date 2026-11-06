// ⏰ Tugas terjadwal: next-run math and the scheduler that only enqueues due routines.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanRoutine, nextRunAt, RoutineScheduler, routineWhen } from '../src/routines.js';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

function fixture(routines = []) {
  const added = [];
  const chats = [];
  const hub = {
    persisted: { routines },
    projects: new Map([['p1', { id: 'p1' }]]),
    save() {},
    broadcast() {},
    chat(_id, msg) {
      chats.push(msg);
    },
  };
  const taskQueue = {
    add(id, text) {
      added.push([id, text]);
    },
  };
  return { hub, taskQueue, added, chats };
}

test('nextRunAt: daily, weekly and once use local time and always look forward', () => {
  const daily = { frequency: 'daily', time: '09:00' };
  assert.equal(nextRunAt(daily, at(2026, 11, 6, 8, 0)), at(2026, 11, 6, 9, 0));
  assert.equal(nextRunAt(daily, at(2026, 11, 6, 9, 0)), at(2026, 11, 7, 9, 0), 'exactly at the time → tomorrow');
  const weekly = { frequency: 'weekly', time: '09:00', weekday: 1 }; // Monday
  assert.equal(nextRunAt(weekly, at(2026, 11, 6, 8, 0)), at(2026, 11, 9, 9, 0), 'Friday → next Monday');
  assert.equal(nextRunAt(weekly, at(2026, 11, 9, 9, 0)), at(2026, 11, 16, 9, 0), 'Monday after 09:00 → next Monday');
  assert.equal(nextRunAt({ frequency: 'once', time: '07:30', date: '2026-11-10' }, at(2026, 11, 6)), at(2026, 11, 10, 7, 30));
  assert.equal(nextRunAt({ frequency: 'once', time: '07:30', date: 'bukan-tanggal' }, at(2026, 11, 6)), null);
});

test('cleanRoutine: project, prompt, time, weekday/date validated; a new routine gets an id and next run', () => {
  const now = at(2026, 11, 6, 8, 0);
  const r = cleanRoutine({ projectId: 'p1', prompt: 'cek CI', frequency: 'weekly', time: '09:00', weekday: 1 }, now);
  assert.match(r.id, /^rt_[0-9a-f]{12}$/);
  assert.equal(r.nextRun, at(2026, 11, 9, 9, 0));
  assert.equal(routineWhen(r), 'Mingguan Senin 09:00');
  assert.equal(cleanRoutine({ projectId: 'p1', prompt: 'x', frequency: 'daily', time: '25:00' }), null);
  assert.equal(cleanRoutine({ projectId: '', prompt: 'x', frequency: 'daily', time: '09:00' }), null);
  assert.equal(cleanRoutine({ projectId: 'p1', prompt: 'x', frequency: 'once', time: '09:00', date: 'x' }), null);
});

test('scheduler: a due daily routine is enqueued once, then nextRun moves to tomorrow', () => {
  const now = at(2026, 11, 6, 9, 0);
  const routine = { id: 'r1', projectId: 'p1', prompt: 'cek CI', frequency: 'daily', time: '09:00', enabled: true, nextRun: now };
  const { hub, taskQueue, added, chats } = fixture([routine]);
  new RoutineScheduler({ hub, taskQueue, now: () => now }).tick();
  assert.deepEqual(added, [['p1', 'cek CI']]);
  assert.equal(routine.nextRun, at(2026, 11, 7, 9, 0));
  assert.match(chats[0].text, /Tugas terjadwal masuk antrian/);
});

test('scheduler: a one-off disables itself; a disabled routine and a stale missed run do nothing', () => {
  const now = at(2026, 11, 6, 9, 0);
  const once = { id: 'r1', projectId: 'p1', prompt: 'sekali', frequency: 'once', time: '09:00', date: '2026-11-06', enabled: true, nextRun: now };
  const off = { id: 'r2', projectId: 'p1', prompt: 'mati', frequency: 'daily', time: '09:00', enabled: false, nextRun: now };
  const stale = { id: 'r3', projectId: 'p1', prompt: 'basi', frequency: 'daily', time: '09:00', enabled: true, nextRun: at(2026, 11, 4, 9, 0) };
  const { hub, taskQueue, added } = fixture([once, off, stale]);
  new RoutineScheduler({ hub, taskQueue, now: () => now }).tick();
  assert.deepEqual(added, [['p1', 'sekali']], 'only the one-off runs');
  assert.equal(once.enabled, false);
  assert.equal(once.nextRun, null);
  assert.equal(stale.nextRun, at(2026, 11, 7, 9, 0), 'a missed daily run is skipped to the next one');
});

test('scheduler: a missing project disables the routine; a full queue records the error', () => {
  const now = at(2026, 11, 6, 9, 0);
  const gone = { id: 'r1', projectId: 'p2', prompt: 'x', frequency: 'daily', time: '09:00', enabled: true, nextRun: now };
  const { hub, taskQueue } = fixture([gone]);
  new RoutineScheduler({ hub, taskQueue, now: () => now }).tick();
  assert.equal(gone.enabled, false);
  assert.match(gone.error, /Project tidak ditemukan/);

  const full = { id: 'r2', projectId: 'p1', prompt: 'y', frequency: 'daily', time: '09:00', enabled: true, nextRun: now };
  hub.persisted.routines = [full];
  taskQueue.add = () => {
    throw new Error('Antrian penuh');
  };
  new RoutineScheduler({ hub, taskQueue, now: () => now }).tick();
  assert.match(full.error, /Antrian penuh/);
  assert.equal(full.nextRun, at(2026, 11, 7, 9, 0), 'it still waits for the next slot');
});
