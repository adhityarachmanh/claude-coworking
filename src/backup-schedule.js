// ⚙ → Cadangkan riwayat → Backup otomatis: the same .zip as "Export riwayat" (src/backup.js writeBackup),
// written by the server on a schedule (daily or weekly at a set time, local time) into a folder on this laptop,
// keeping the newest N. Off by default; laptop only (the server's LOCAL_ONLY gate).
//
// - The folder must be an absolute local path that exists and can be written; UNC/device paths are refused
//   before any file-system call (touching \\server\share makes Windows send the user's NTLM hash).
// - Each backup is written to a hidden ".partial" file in the same folder and renamed when complete, so the
//   folder never holds a half-written .zip under a backup name.
// - Rotation only ever deletes files whose name matches AUTO_NAME (the scheduled backups themselves), never a
//   manual export or anything else the user keeps there.
// - Checked every minute (unref'd timer). A slot missed while the laptop was off runs once at the next check;
//   a slot before the schedule was saved never runs. A failure waits for the next slot ("Jalankan sekarang" retries).
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const BACKUP_SCHEDULE_DEFAULTS = Object.freeze({ enabled: false, frequency: 'daily', weekday: 1, time: '02:00', folder: '', keep: 7 });
export const BACKUP_KEEP_MAX = 100;
const CHECK_EVERY_MS = 60_000;
// adhit-office-backup-auto-20261101-020000.zip (local time), "-2"… when two land in the same second.
export const AUTO_NAME = /^adhit-office-backup-auto-(\d{8}-\d{6})(?:-(\d{1,3}))?\.zip$/;
const PARTIAL_NAME = /^\.adhit-office-backup-auto-\d{8}-\d{6}(?:-\d{1,3})?\.zip\.partial$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i; // Windows device names
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A setting the server refuses; the message is shown to the user as is. */
export class ScheduleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------- validation ----------

/**
 * Checks the target folder: absolute, local, not a device, exists, is a folder, can be written (a probe file is
 * created and removed). Returns the resolved path; throws ScheduleError with the reason.
 */
export async function checkFolder(input, platform = process.platform) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new ScheduleError('Isi folder tujuan backup.');
  if (raw.length > 400 || /[\u0000-\u001f]/.test(raw)) throw new ScheduleError('Path folder tidak valid.');
  // \\server\share, //server/share, \\?\…, \\.\… (devices), \??\… — refused before the file system is touched.
  if (/^([\\/]{2}|\\\?\?\\)/.test(raw)) throw new ScheduleError('Folder jaringan atau path perangkat (\\\\…) tidak didukung. Pakai folder di laptop ini, misalnya D:\\Backup.');
  const absolute = platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(raw) : path.isAbsolute(raw);
  if (!absolute) throw new ScheduleError(platform === 'win32' ? 'Pakai path lengkap dengan huruf drive, misalnya D:\\Backup\\adhit-office.' : 'Pakai path absolut, misalnya /home/nama/backup.');
  const dir = path.resolve(raw);
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  if (platform === 'win32' && parts.slice(1).some((p) => RESERVED.test(p.replace(/[ .]+$/, '')))) throw new ScheduleError('Nama perangkat Windows (CON, NUL, COM1, …) tidak bisa dipakai sebagai folder.');
  let st;
  try {
    st = await fs.stat(dir);
  } catch {
    throw new ScheduleError(`Folder tidak ditemukan: ${dir}`);
  }
  if (!st.isDirectory()) throw new ScheduleError(`Bukan folder: ${dir}`);
  const probe = path.join(dir, `.adhit-office-write-test-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(probe, 'ok', { flag: 'wx' });
  } catch {
    throw new ScheduleError(`Folder tidak bisa ditulis: ${dir}`);
  } finally {
    await fs.rm(probe, { force: true }).catch(() => {});
  }
  return dir;
}

/** `current` with the valid fields of `patch`; throws ScheduleError for a bad value. The folder is checked on disk. */
export async function cleanSchedule(current, patch, platform = process.platform) {
  const next = { ...BACKUP_SCHEDULE_DEFAULTS, ...current };
  const p = isObject(patch) ? patch : {};
  if ('enabled' in p) next.enabled = p.enabled === true;
  if ('frequency' in p) {
    if (!['daily', 'weekly'].includes(p.frequency)) throw new ScheduleError('Frekuensi harus harian atau mingguan.');
    next.frequency = p.frequency;
  }
  if ('weekday' in p) {
    if (!Number.isInteger(p.weekday) || p.weekday < 0 || p.weekday > 6) throw new ScheduleError('Hari tidak valid.');
    next.weekday = p.weekday;
  }
  if ('time' in p) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(p.time));
    if (!m) throw new ScheduleError('Jam harus HH:MM (00:00–23:59).');
    next.time = m[0];
  }
  if ('keep' in p) {
    if (!Number.isInteger(p.keep) || p.keep < 1 || p.keep > BACKUP_KEEP_MAX) throw new ScheduleError(`Jumlah backup yang disimpan: 1–${BACKUP_KEEP_MAX}.`);
    next.keep = p.keep;
  }
  if ('folder' in p) next.folder = String(p.folder ?? '').trim() ? await checkFolder(p.folder, platform) : '';
  if (next.enabled && !next.folder) throw new ScheduleError('Pilih folder tujuan sebelum menyalakan backup otomatis.');
  return next;
}

// ---------- when ----------

function atTime(ms, time) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(ms);
  d.setHours(h, m, 0, 0);
  return d;
}

/** The most recent scheduled moment at or before `now` (local time). */
export function latestSlot(now, schedule) {
  const d = atTime(now, schedule.time);
  if (schedule.frequency === 'weekly') d.setDate(d.getDate() - ((d.getDay() - schedule.weekday + 7) % 7));
  if (d.getTime() > now) d.setDate(d.getDate() - (schedule.frequency === 'weekly' ? 7 : 1));
  return atTime(d.getTime(), schedule.time).getTime(); // re-pinned: a DST change keeps the wall-clock time
}

/** The next scheduled moment after `now`. */
export function nextSlot(now, schedule) {
  const d = new Date(latestSlot(now, schedule));
  d.setDate(d.getDate() + (schedule.frequency === 'weekly' ? 7 : 1));
  return atTime(d.getTime(), schedule.time).getTime();
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** adhit-office-backup-auto-YYYYMMDD-HHmmss.zip in local time. */
export const autoName = (ms, n = 1) => {
  const d = new Date(ms);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `adhit-office-backup-auto-${stamp}${n > 1 ? `-${n}` : ''}.zip`;
};

// ---------- writing ----------

/** Our scheduled backups in `dir`, newest first (by the time in the name). Regular files only, never links. */
export async function listAutoBackups(dir) {
  const found = [];
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const m = AUTO_NAME.exec(d.name);
    if (m && d.isFile()) found.push({ name: d.name, key: `${m[1]}-${pad(Number(m[2] ?? 1), 3)}` });
  }
  return found.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

/** Deletes the scheduled backups beyond the newest `keep` (only names matching AUTO_NAME). */
export async function rotate(dir, keep) {
  const removed = [];
  const errors = [];
  for (const f of (await listAutoBackups(dir)).slice(keep)) {
    try {
      await fs.unlink(path.join(dir, f.name));
      removed.push(f.name);
    } catch (err) {
      errors.push(`${f.name}: ${err.code ?? err.message}`);
    }
  }
  return { removed, errors };
}

/**
 * Writes one backup into `dir` atomically: `.name.partial` first, renamed to `name` once complete and flushed.
 * On any error the partial file is removed. `write(out)` streams the .zip into `out` (not ended by it).
 */
export async function writeAtomic(dir, now, write) {
  // Leftovers of a backup cut off by a crash or power loss (only our own partial names).
  for (const d of await fs.readdir(dir, { withFileTypes: true })) if (d.isFile() && PARTIAL_NAME.test(d.name)) await fs.rm(path.join(dir, d.name), { force: true }).catch(() => {});
  let name;
  for (let n = 1; ; n++) {
    name = autoName(now, n);
    const taken = await fs.stat(path.join(dir, name)).then(() => true, () => false);
    if (!taken) break;
    if (n >= 999) throw new Error('Terlalu banyak backup dengan waktu yang sama.');
  }
  const final = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.partial`);
  // wx: never write over an existing file; flush: fsync before close, so it is on disk before it gets the real name.
  const out = createWriteStream(tmp, { flags: 'wx', flush: true });
  const closed = new Promise((resolve) => (out.closed ? resolve() : out.once('close', resolve)));
  try {
    await new Promise((resolve, reject) => {
      out.once('open', resolve);
      out.once('error', reject);
    });
    const result = await write(out);
    await new Promise((resolve, reject) => {
      out.once('error', reject);
      closed.then(resolve);
      out.end();
    });
    await fs.rename(tmp, final);
    const { size } = await fs.stat(final);
    return { name, file: final, size, ...result };
  } catch (err) {
    out.destroy();
    await closed; // the file is released before it is removed (Windows)
    await fs.rm(tmp, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    throw err;
  }
}

// ---------- the scheduler ----------

export class BackupScheduler {
  /**
   * @param {{ store: { schedule: object, runs: object, save(): void }, backup: (out) => Promise<object>,
   *           lock: () => boolean, unlock: () => void, now?: () => number, onChange?: (view) => void,
   *           log?: (msg: string) => void }} options
   *   store: where the settings and the last result live (the server: hub.persisted + hub.save)
   *   backup: streams one backup .zip into `out` (writeBackup with the office state)
   *   lock/unlock: the server's one-backup-at-a-time flag, shared with export/import
   */
  constructor({ store, backup, lock, unlock, now = () => Date.now(), onChange = () => {}, log = () => {} }) {
    Object.assign(this, { store, backup, lock, unlock, now, onChange, log });
    this.running = null; // Promise of the backup being written
  }

  get schedule() {
    return { ...BACKUP_SCHEDULE_DEFAULTS, ...this.store.schedule };
  }

  get runs() {
    return this.store.runs ?? {};
  }

  /** What ⚙ shows. */
  view() {
    const s = this.schedule;
    return {
      schedule: { enabled: s.enabled, frequency: s.frequency, weekday: s.weekday, time: s.time, folder: s.folder, keep: s.keep },
      last: this.runs.last ?? null,
      running: Boolean(this.running),
      nextAt: s.enabled && s.folder ? nextSlot(this.now(), s) : null,
      keepMax: BACKUP_KEEP_MAX,
    };
  }

  async save(patch, platform) {
    const next = await cleanSchedule(this.schedule, patch, platform);
    next.updatedAt = this.now(); // slots before this moment never run (no backup right after switching on)
    this.store.schedule = next;
    this.store.save();
    this.onChange(this.view());
    return this.view();
  }

  start() {
    const timer = setInterval(() => this.tick(), CHECK_EVERY_MS);
    timer.unref?.();
    const first = setTimeout(() => this.tick(), 5000); // a slot missed while the laptop was off
    first.unref?.();
    this.timers = [timer, first];
  }

  stop() {
    for (const t of this.timers ?? []) clearInterval(t);
  }

  /** Due when a slot passed since the schedule was saved and since the last attempt. */
  due(now = this.now()) {
    const s = this.schedule;
    if (!s.enabled || !s.folder) return null;
    const slot = latestSlot(now, s);
    if (slot < (s.updatedAt ?? 0) || slot <= (this.runs.lastSlot ?? 0)) return null;
    return slot;
  }

  /** Once a minute: runs the backup when due. Skipped (and tried again next minute) while an export/import runs. */
  async tick() {
    const slot = this.due();
    if (slot == null || this.running) return null;
    return this.run({ trigger: 'schedule', slot });
  }

  /**
   * Writes one backup now. Resolves with the result record (also stored as `last`); never rejects.
   * Returns null when another backup/export/import is running (nothing recorded; the schedule retries).
   */
  run({ trigger = 'manual', slot = null } = {}) {
    if (this.running) return null;
    const s = this.schedule;
    if (!s.folder) return Promise.resolve(this.record({ ok: false, trigger, error: 'Folder tujuan belum diatur.' }, slot));
    if (!this.lock()) return null;
    const started = this.now();
    this.running = (async () => {
      this.onChange(this.view());
      try {
        await checkFolder(s.folder); // still there and writable (a USB drive may be gone)
        const written = await writeAtomic(s.folder, started, (out) => this.backup(out));
        const { removed, errors } = await rotate(s.folder, s.keep);
        this.log(`Backup otomatis: ${written.name} (${(written.size / 1024 ** 2).toFixed(1)} MB)${removed.length ? `, ${removed.length} backup lama dihapus` : ''}`);
        return this.record({ ok: true, trigger, file: written.file, name: written.name, bytes: written.size, files: written.files ?? null, removed: removed.length, warnings: errors, durationMs: this.now() - started }, slot);
      } catch (err) {
        this.log(`Backup otomatis gagal: ${err?.stack ?? err}`);
        const error = err instanceof ScheduleError ? err.message : `${err?.code ? `${err.code}: ` : ''}${err?.message ?? err}`.slice(0, 300);
        return this.record({ ok: false, trigger, error, durationMs: this.now() - started }, slot);
      } finally {
        this.unlock();
      }
    })().finally(() => {
      this.running = null;
      this.onChange(this.view());
    });
    return this.running;
  }

  record(result, slot) {
    const last = { at: this.now(), ...result };
    this.store.runs = { ...this.runs, last, ...(slot != null ? { lastSlot: slot } : {}) };
    this.store.save();
    return last;
  }
}
