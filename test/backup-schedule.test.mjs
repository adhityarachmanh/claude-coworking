// Backup otomatis (src/backup-schedule.js): folder checks, when a slot is due (with an injected clock), atomic
// writes, rotation that only touches our own file names, errors recorded; plus the laptop-only API on a real server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AUTO_NAME, BackupScheduler, autoName, checkFolder, cleanSchedule, latestSlot, nextSlot, rotate } from '../src/backup-schedule.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-bsched-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
let dirSeq = 0;
const freshDir = () => {
  const dir = path.join(TMP, `out-${++dirSeq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

describe('folder validation', () => {
  test('UNC, device, relative, reserved names are refused before the file system is touched', async () => {
    for (const bad of ['\\\\server\\share\\backup', '//server/share', '\\\\?\\C:\\backup', '\\\\.\\COM1', '\\??\\C:\\x']) {
      await assert.rejects(checkFolder(bad, 'win32'), /jaringan atau path perangkat/, bad);
    }
    for (const bad of ['backup', 'C:backup', '\\backup', '.\\x']) await assert.rejects(checkFolder(bad, 'win32'), /path lengkap/, bad);
    await assert.rejects(checkFolder('relative/dir', 'linux'), /path absolut/);
    await assert.rejects(checkFolder('C:\\Users\\CON', 'win32'), /Nama perangkat/);
    await assert.rejects(checkFolder('C:\\Data\\nul.txt', 'win32'), /Nama perangkat/);
    await assert.rejects(checkFolder(''), /Isi folder/);
    await assert.rejects(checkFolder('C:\\a\u0000b', 'win32'), /tidak valid/);
  });

  test('must exist, be a folder and be writable; the probe file is cleaned up', async () => {
    await assert.rejects(checkFolder(path.join(TMP, 'tidak-ada')), /tidak ditemukan/);
    const file = path.join(TMP, 'sebuah-file.txt');
    writeFileSync(file, 'x');
    await assert.rejects(checkFolder(file), /Bukan folder/);
    const dir = freshDir();
    assert.equal(await checkFolder(`  ${dir}  `), path.resolve(dir));
    assert.deepEqual(readdirSync(dir), [], 'no probe file left behind');
  });

  test('settings: validated, enabling needs a folder', async () => {
    const dir = freshDir();
    const base = await cleanSchedule({}, {});
    assert.equal(base.enabled, false, 'off by default');
    await assert.rejects(cleanSchedule(base, { enabled: true }), /folder tujuan/);
    await assert.rejects(cleanSchedule(base, { time: '24:00' }), /HH:MM/);
    await assert.rejects(cleanSchedule(base, { time: '7:00' }), /HH:MM/);
    await assert.rejects(cleanSchedule(base, { frequency: 'hourly' }), /harian atau mingguan/);
    await assert.rejects(cleanSchedule(base, { weekday: 7 }), /Hari/);
    await assert.rejects(cleanSchedule(base, { keep: 0 }), /1–100/);
    await assert.rejects(cleanSchedule(base, { keep: 2.5 }), /1–100/);
    const ok = await cleanSchedule(base, { enabled: true, frequency: 'weekly', weekday: 0, time: '23:30', folder: dir, keep: 3, extra: 'ignored' });
    assert.deepEqual(ok, { enabled: true, frequency: 'weekly', weekday: 0, time: '23:30', folder: path.resolve(dir), keep: 3 });
  });
});

describe('when a backup is due', () => {
  test('daily and weekly slots in local time', () => {
    const daily = { frequency: 'daily', time: '02:00' };
    assert.equal(latestSlot(local(2026, 11, 5, 1, 59), daily), local(2026, 11, 4, 2, 0));
    assert.equal(latestSlot(local(2026, 11, 5, 2, 0), daily), local(2026, 11, 5, 2, 0));
    assert.equal(nextSlot(local(2026, 11, 5, 2, 0), daily), local(2026, 11, 6, 2, 0));
    // 2026-11-05 is a Thursday (4); weekly on Monday (1) at 21:15
    const weekly = { frequency: 'weekly', weekday: 1, time: '21:15' };
    assert.equal(latestSlot(local(2026, 11, 5, 12), weekly), local(2026, 11, 2, 21, 15));
    assert.equal(nextSlot(local(2026, 11, 5, 12), weekly), local(2026, 11, 9, 21, 15));
    assert.equal(latestSlot(local(2026, 11, 2, 21, 0), weekly), local(2026, 10, 26, 21, 15), 'same weekday, before the time: last week');
  });

  test('file names: ours match the rotation pattern, a manual export never does', () => {
    assert.equal(autoName(local(2026, 11, 5, 2, 0)), 'adhit-office-backup-auto-20261105-020000.zip');
    assert.match(autoName(local(2026, 11, 5, 2, 0), 2), AUTO_NAME);
    for (const other of ['adhit-office-backup-2026-11-05.zip', 'adhit-office-backup-auto-20261105-020000.zip.bak', 'x-adhit-office-backup-auto-20261105-020000.zip', 'adhit-office-backup-auto-2026.zip']) assert.doesNotMatch(other, AUTO_NAME, other);
  });
});

/** A scheduler on an in-memory store with a settable clock; `backup` writes a few bytes (or throws). */
function makeScheduler({ now, backup, busy = () => false } = {}) {
  const store = { schedule: undefined, runs: undefined, saved: 0, save() {
    this.saved++;
  } };
  const clock = { t: now };
  let locked = false;
  const scheduler = new BackupScheduler({
    store,
    now: () => clock.t,
    backup: backup ?? (async (out) => {
      out.write(Buffer.from('PK fake zip'));
      return { files: 1 };
    }),
    lock: () => (busy() || locked ? false : (locked = true)),
    unlock: () => (locked = false),
  });
  return { scheduler, store, clock };
}

describe('scheduler', () => {
  test('history: the newest scheduled backups in the folder, with sizes; other files are ignored', async () => {
    const dir = freshDir();
    const { scheduler, store } = makeScheduler({ now: local(2026, 11, 5, 10, 0) });
    await scheduler.save({ enabled: false, folder: dir });
    const older = autoName(local(2026, 11, 4, 2, 0));
    const newer = autoName(local(2026, 11, 5, 2, 0));
    writeFileSync(path.join(dir, older), Buffer.alloc(10));
    writeFileSync(path.join(dir, newer), Buffer.alloc(20));
    writeFileSync(path.join(dir, 'manual.zip'), Buffer.alloc(5));
    const { backups } = await scheduler.history();
    assert.deepEqual(backups.map((b) => b.name), [newer, older]);
    assert.equal(backups[0].bytes, 20);
    assert.ok(backups[0].at > 0);
    store.schedule = { ...store.schedule, folder: '' };
    assert.deepEqual(await scheduler.history(), { backups: [] }, 'no folder: empty, never a throw');
  });

  test('runs once per slot, only after the slot passed and never for a slot before the schedule was saved', async () => {
    const dir = freshDir();
    const { scheduler, store, clock } = makeScheduler({ now: local(2026, 11, 5, 10, 0) });
    await scheduler.save({ enabled: true, frequency: 'daily', time: '02:00', folder: dir, keep: 5 });
    assert.equal(await scheduler.tick(), null, 'today 02:00 passed before it was switched on: not run now');
    assert.equal(scheduler.view().nextAt, local(2026, 11, 6, 2, 0));
    clock.t = local(2026, 11, 6, 1, 59);
    assert.equal(await scheduler.tick(), null);
    clock.t = local(2026, 11, 6, 2, 0);
    const result = await scheduler.tick();
    assert.equal(result.ok, true, result.error);
    assert.equal(result.name, 'adhit-office-backup-auto-20261106-020000.zip');
    assert.equal(result.bytes, 11);
    assert.equal(readFileSync(path.join(dir, result.name), 'utf8'), 'PK fake zip');
    assert.equal(store.runs.lastSlot, local(2026, 11, 6, 2, 0));
    assert.deepEqual(scheduler.view().last, result);
    clock.t = local(2026, 11, 6, 2, 1);
    assert.equal(await scheduler.tick(), null, 'same slot: not again');
    // The laptop was off at the next 02:00: the missed slot runs once at the next check.
    clock.t = local(2026, 11, 7, 9, 30);
    assert.equal((await scheduler.tick()).name, 'adhit-office-backup-auto-20261107-093000.zip');
    assert.equal(await scheduler.tick(), null);
    // Off: nothing runs.
    await scheduler.save({ enabled: false });
    clock.t = local(2026, 11, 9, 3, 0);
    assert.equal(await scheduler.tick(), null);
  });

  test('written atomically: only the .partial exists while writing; nothing left behind on failure; error recorded', async () => {
    const dir = freshDir();
    let during = null;
    const { scheduler } = makeScheduler({
      now: local(2026, 11, 5, 10, 0),
      backup: async (out) => {
        out.write('PK');
        during = readdirSync(dir);
        return {};
      },
    });
    await scheduler.save({ folder: dir });
    const ok = await scheduler.run();
    assert.equal(ok.ok, true);
    assert.deepEqual(during, ['.adhit-office-backup-auto-20261105-100000.zip.partial']);
    assert.deepEqual(readdirSync(dir), ['adhit-office-backup-auto-20261105-100000.zip']);

    const failing = makeScheduler({
      now: local(2026, 11, 5, 11, 0),
      backup: async (out) => {
        out.write('PK half');
        throw Object.assign(new Error('disk penuh'), { code: 'ENOSPC' });
      },
    });
    await failing.scheduler.save({ folder: dir });
    const bad = await failing.scheduler.run();
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'ENOSPC: disk penuh');
    assert.equal(failing.scheduler.view().last.error, 'ENOSPC: disk penuh');
    assert.deepEqual(readdirSync(dir), ['adhit-office-backup-auto-20261105-100000.zip'], 'no partial or half file left');

    // A folder that disappeared is a recorded error too (e.g. an unplugged USB drive).
    rmSync(dir, { recursive: true });
    const gone = await scheduler.run();
    assert.equal(gone.ok, false);
    assert.match(gone.error, /tidak ditemukan/);
  });

  test('rotation keeps the newest N of our backups and never touches other files', async () => {
    const dir = freshDir();
    const ours = ['adhit-office-backup-auto-20261101-020000.zip', 'adhit-office-backup-auto-20261102-020000.zip', 'adhit-office-backup-auto-20261103-020000.zip', 'adhit-office-backup-auto-20261103-020000-2.zip'];
    const others = ['adhit-office-backup-2026-10-01.zip', 'catatan.txt', 'adhit-office-backup-auto-20261101-020000.zip.bak', 'my-adhit-office-backup-auto-20261101-020000.zip'];
    for (const f of [...ours, ...others]) writeFileSync(path.join(dir, f), 'x');
    mkdirSync(path.join(dir, 'adhit-office-backup-auto-20261001-020000.zip')); // a folder with our name: not a file, kept
    const { scheduler } = makeScheduler({ now: local(2026, 11, 5, 2, 0) });
    await scheduler.save({ folder: dir, keep: 3 });
    const result = await scheduler.run();
    assert.equal(result.ok, true);
    assert.equal(result.removed, 2);
    const left = readdirSync(dir).sort();
    assert.deepEqual(left, [...others, 'adhit-office-backup-auto-20261001-020000.zip', 'adhit-office-backup-auto-20261103-020000-2.zip', 'adhit-office-backup-auto-20261103-020000.zip', 'adhit-office-backup-auto-20261105-020000.zip'].sort());
    assert.deepEqual(await rotate(dir, 1), { removed: ['adhit-office-backup-auto-20261103-020000-2.zip', 'adhit-office-backup-auto-20261103-020000.zip'], errors: [] });
  });

  test('two runs in the same second get distinct names; a run while an export/import holds the lock is skipped', async () => {
    const dir = freshDir();
    let busy = false;
    const { scheduler, store } = makeScheduler({ now: local(2026, 11, 5, 2, 0), busy: () => busy });
    await scheduler.save({ enabled: true, folder: dir, time: '02:00' });
    store.schedule.updatedAt = 0;
    assert.equal((await scheduler.run()).name, 'adhit-office-backup-auto-20261105-020000.zip');
    assert.equal((await scheduler.run()).name, 'adhit-office-backup-auto-20261105-020000-2.zip');
    busy = true;
    assert.equal(scheduler.run(), null, 'refused while busy');
    assert.equal(await scheduler.tick(), null, 'scheduled run waits for the next minute');
    assert.equal(store.runs.lastSlot, undefined, 'the slot is still open');
    busy = false;
    assert.equal((await scheduler.tick()).ok, true);
    assert.equal(store.runs.lastSlot, local(2026, 11, 5, 2, 0));
  });
});

describe('server API (laptop only)', () => {
  const PORT = 5700 + Math.floor(Math.random() * 300);
  const BASE = `http://localhost:${PORT}`;
  let server;
  let token;
  const api = (p, body = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

  before(async () => {
    mkdirSync(path.join(TMP, 'srv', 'projects', 'toko'), { recursive: true });
    mkdirSync(path.join(TMP, 'srv', 'claude-projects', 'C--x-toko'), { recursive: true });
    writeFileSync(path.join(TMP, 'srv', 'claude-projects', 'C--x-toko', '11111111-2222-3333-4444-555555555555.jsonl'), '{"cwd":"C:\\\\x\\\\toko"}\n');
    server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
      env: {
        ...process.env,
        OFFICE_PORT: String(PORT),
        OFFICE_DATA_DIR: path.join(TMP, 'srv', 'data'),
        PROJECTS_ROOT: path.join(TMP, 'srv', 'projects'),
        CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
        CLAUDE_PROJECTS_DIR: path.join(TMP, 'srv', 'claude-projects'),
        CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
      server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
    });
    server.stderr.resume();
    token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  });

  after(async () => {
    server?.kill();
    await sleep(300);
  });

  test('off by default; bad folders refused with a reason; "Jalankan sekarang" writes a real backup .zip', async () => {
    const initial = (await api('/api/backup/schedule')).body;
    assert.equal(initial.schedule.enabled, false);
    assert.equal(initial.last, null);
    assert.equal(initial.nextAt, null);
    assert.equal((await api('/api/backup/schedule/run')).status, 400, 'no folder yet');
    const unc = await api('/api/backup/schedule/save', { folder: '\\\\server\\share' });
    assert.equal(unc.status, 400);
    assert.match(unc.body.error, /jaringan/);
    assert.equal((await api('/api/backup/schedule/save', { folder: path.join(TMP, 'nope') })).status, 400);
    assert.equal((await api('/api/backup/schedule/save', { enabled: true })).status, 400);

    const dir = freshDir();
    const saved = await api('/api/backup/schedule/save', { enabled: true, frequency: 'weekly', weekday: 3, time: '03:30', folder: dir, keep: 2 });
    assert.equal(saved.status, 200, saved.body.error);
    assert.equal(saved.body.schedule.folder, path.resolve(dir));
    assert.ok(saved.body.nextAt > Date.now());
    assert.equal(new Date(saved.body.nextAt).getDay(), 3);

    let prev = null;
    for (let i = 0; i < 3; i++) {
      const started = await api('/api/backup/schedule/run');
      assert.equal(started.status, 202);
      let view;
      for (let t = 0; t < 100; t++) {
        view = (await api('/api/backup/schedule')).body;
        if (!view.running && view.last?.at >= Date.now() - 60_000 && view.last.trigger === 'manual' && view.last.name !== prev) break;
        await sleep(100);
      }
      assert.equal(view.last.ok, true, view.last.error);
      prev = view.last.name;
      assert.match(view.last.name, AUTO_NAME);
      assert.ok(view.last.bytes > 100);
      assert.equal(readFileSync(path.join(dir, view.last.name)).subarray(0, 2).toString(), 'PK', 'a real zip');
      if (i < 2) await sleep(1100); // distinct second in the name
    }
    const files = readdirSync(dir);
    assert.equal(files.length, 2, `rotation keeps 2: ${files}`);
    assert.ok(files.every((f) => AUTO_NAME.test(f)));
    // Stored in state.json (survives a restart).
    const state = JSON.parse(readFileSync(path.join(TMP, 'srv', 'data', 'state.json'), 'utf8'));
    assert.equal(state.backupSchedule.enabled, true);
    assert.equal(state.backupRuns.last.ok, true);
  });
});
