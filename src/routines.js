// ⏰ Tugas terjadwal: one prompt per routine, enqueued at a local time (once / daily / weekly). Routines are stored
// in state.json (`hub.persisted.routines`); the scheduler only enqueues, so the normal queue (idle checks, budget,
// pauses) still decides when the turn actually runs.
import { randomUUID } from 'node:crypto';

export const ROUTINE_FREQUENCIES = Object.freeze(['once', 'daily', 'weekly']);
export const ROUTINE_MAX = 50;
const MAX_LATE_MS = 12 * 60 * 60 * 1000; // a daily/weekly run missed by more than this is skipped, not played late
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class RoutineError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RoutineError';
    this.status = status;
  }
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The next moment a routine should run, strictly after `from` (epoch ms); null for a malformed one-off. */
export function nextRunAt(routine, from = Date.now()) {
  const [hour, minute] = String(routine?.time ?? '').split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (routine.frequency === 'once') {
    if (!DATE.test(String(routine.date ?? ''))) return null;
    const [y, m, d] = routine.date.split('-').map(Number);
    const at = new Date(y, m - 1, d, hour, minute, 0, 0).getTime();
    return Number.isFinite(at) ? at : null;
  }
  const base = new Date(from);
  base.setSeconds(0, 0);
  base.setMilliseconds(0);
  const at = new Date(base);
  at.setHours(hour, minute, 0, 0);
  if (routine.frequency === 'weekly') {
    const target = ((Number(routine.weekday) || 0) % 7 + 7) % 7;
    at.setDate(at.getDate() + ((target - at.getDay() + 7) % 7));
  }
  if (at.getTime() <= from) at.setDate(at.getDate() + (routine.frequency === 'weekly' ? 7 : 1));
  return at.getTime();
}

/** One stored routine, sanitized (an invalid one is null); a new one gets an id and its next run. */
export function cleanRoutine(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const frequency = ROUTINE_FREQUENCIES.includes(raw.frequency) ? raw.frequency : null;
  const projectId = text(raw.projectId, 80);
  const prompt = text(raw.prompt, 4000);
  const time = text(raw.time, 5);
  if (!frequency || !projectId || !prompt || !TIME.test(time)) return null;
  const weekday = frequency === 'weekly' && Number.isInteger(raw.weekday) && raw.weekday >= 0 && raw.weekday <= 6 ? raw.weekday : 0;
  const date = frequency === 'once' && DATE.test(String(raw.date ?? '')) ? raw.date : null;
  if (frequency === 'once' && !date) return null;
  const routine = {
    id: /^[A-Za-z0-9_-]{1,40}$/.test(String(raw.id ?? '')) ? raw.id : `rt_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    projectId,
    prompt,
    runbookId: /^rb_[A-Za-z0-9_-]{1,40}$/.test(String(raw.runbookId ?? '')) ? raw.runbookId : null,
    frequency,
    time,
    weekday,
    date,
    enabled: raw.enabled !== false,
    lastRun: Number.isFinite(raw.lastRun) ? raw.lastRun : null,
    nextRun: Number.isFinite(raw.nextRun) ? raw.nextRun : null,
    lastStatus: raw.lastStatus === 'done' || raw.lastStatus === 'failed' ? raw.lastStatus : null,
    lastEndedAt: Number.isFinite(raw.lastEndedAt) ? raw.lastEndedAt : null,
    lastDurationMs: Number.isFinite(raw.lastDurationMs) ? raw.lastDurationMs : null,
    lastCostUsd: Number.isFinite(raw.lastCostUsd) ? raw.lastCostUsd : null,
    lastError: text(raw.lastError, 300) || null,
    history: (Array.isArray(raw.history) ? raw.history : [])
      .filter((h) => h && (h.status === 'done' || h.status === 'failed') && Number.isFinite(h.at))
      .slice(0, 5)
      .map((h) => ({ status: h.status, at: h.at, durationMs: Number.isFinite(h.durationMs) ? h.durationMs : null, costUsd: Number.isFinite(h.costUsd) ? h.costUsd : null, error: text(h.error, 300) || null })),
    error: text(raw.error, 300) || null,
  };
  if (routine.enabled && routine.nextRun == null) routine.nextRun = nextRunAt(routine, now);
  return routine;
}

export function cleanRoutines(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item) => cleanRoutine(item)).filter(Boolean).slice(0, ROUTINE_MAX);
}

/** The label used in the settings list and the chat: "Harian 09:00", "Mingguan Senin 09:00", "Sekali 7 Nov 09:00". */
export const WEEKDAYS = Object.freeze(['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']);
export function routineWhen(routine) {
  if (routine.frequency === 'daily') return `Harian ${routine.time}`;
  if (routine.frequency === 'weekly') return `Mingguan ${WEEKDAYS[routine.weekday] ?? ''} ${routine.time}`.trim();
  const [y, m, d] = String(routine.date ?? '').split('-').map(Number);
  const day = y && m && d ? new Date(y, m - 1, d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) : routine.date;
  return `Sekali ${day ?? ''} ${routine.time}`.trim();
}

/** Enqueues due routines; never runs two ticks at once, never cuts a turn. */
export class RoutineScheduler {
  constructor({ hub, taskQueue, now = () => Date.now(), intervalMs = 30_000 }) {
    this.hub = hub;
    this.taskQueue = taskQueue;
    this.now = now;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      let changed = false;
      for (const r of this.hub.persisted?.routines ?? []) {
        if (!r?.enabled) continue;
        if (!Number.isFinite(r.nextRun)) {
          r.nextRun = nextRunAt(r, now);
          changed = true;
          continue;
        }
        if (now < r.nextRun) continue;
        // A daily/weekly run missed while the server was off is skipped instead of firing hours late.
        if (r.frequency !== 'once' && now - r.nextRun > MAX_LATE_MS) {
          r.nextRun = nextRunAt(r, now);
          changed = true;
          continue;
        }
        this.fire(r, now);
        changed = true;
      }
      if (changed) {
        this.hub.save?.();
        this.hub.broadcast?.('routines', this.hub.persisted?.routines ?? []);
      }
    } finally {
      this.busy = false;
    }
  }

  fire(routine, now) {
    const project = this.hub.projects?.get(routine.projectId);
    if (!project || project.virtual) {
      Object.assign(routine, { enabled: false, nextRun: null, error: 'Project tidak ditemukan atau tidak bisa dijalankan.' });
      return;
    }
    // 📚 A runbook routine enqueues every prompt of the saved sequence (if it still exists).
    const book = routine.runbookId ? this.hub.runbooksFor?.(routine.projectId)?.find((b) => b.id === routine.runbookId) : null;
    if (routine.runbookId && !book) {
      Object.assign(routine, { enabled: false, nextRun: null, error: 'Runbook jadwal ini sudah tidak ada.' });
      return;
    }
    const prompts = book ? book.prompts : [routine.prompt];
    try {
      for (const [index, prompt] of prompts.entries()) this.taskQueue.add(routine.projectId, prompt, null, [], { routineId: routine.id, ...(book ? { runbookId: book.id, runbookIndex: index } : {}) });
      Object.assign(routine, { lastRun: now, error: null });
      const label = book ? `📚 ${book.name} (${prompts.length} prompt)` : routine.prompt.slice(0, 80);
      this.hub.chat?.(routine.projectId, { kind: 'info', text: `⏰ Tugas terjadwal masuk antrian: ${label}` });
    } catch (err) {
      Object.assign(routine, { lastRun: now, error: String(err?.message ?? err).slice(0, 300) });
      this.hub.chat?.(routine.projectId, { kind: 'info', level: 'warning', text: `⏰ Tugas terjadwal gagal masuk antrian: ${routine.error}` });
    }
    routine.enabled = routine.frequency !== 'once'; // a one-off is done after its one run
    routine.nextRun = routine.enabled ? nextRunAt(routine, now) : null;
  }
}
