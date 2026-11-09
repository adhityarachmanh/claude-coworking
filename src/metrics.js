// 📈 Operational metrics for 🩺 Kesehatan: turns finished/failed, queue starts and waits, and how often the global
// turn limit was hit. Aggregate only — no project ids, no prompt text, no conversation: the file is safe to read and
// is never part of a backup. Rolling 7 local days, kept in data/metrics.json (atomic writes, debounced).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DAY_MS = 86_400_000;
export const METRICS_DAYS = 7;
const MAX_WAIT_SAMPLES = 200; // per day, enough for p50/p95 without growing the file

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const num = (v, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
};
const int = (v) => Math.trunc(num(v));

/** Nearest-rank percentile; null when there are no samples (the UI then shows "—"). */
export function percentile(samples, p) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const sorted = [...samples].filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const emptyDay = () => ({
  turnsOk: 0,
  turnsFailed: 0,
  turnMs: 0,
  turnTimed: 0,
  queueStarted: 0,
  waits: [],
  capacityQueued: 0,
  capacityRefused: 0,
});

function cleanDay(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const waits = (Array.isArray(d.waits) ? d.waits : []).map((n) => num(n)).slice(-MAX_WAIT_SAMPLES);
  return {
    turnsOk: int(d.turnsOk),
    turnsFailed: int(d.turnsFailed),
    turnMs: num(d.turnMs),
    turnTimed: int(d.turnTimed),
    queueStarted: int(d.queueStarted),
    waits,
    capacityQueued: int(d.capacityQueued),
    capacityRefused: int(d.capacityRefused),
  };
}

function dayView(bucket) {
  const turns = bucket.turnsOk + bucket.turnsFailed;
  return {
    turns,
    ok: bucket.turnsOk,
    failed: bucket.turnsFailed,
    avgTurnMs: bucket.turnTimed ? Math.round(bucket.turnMs / bucket.turnTimed) : null,
    queueStarted: bucket.queueStarted,
    waitP50Ms: percentile(bucket.waits, 50),
    waitP95Ms: percentile(bucket.waits, 95),
    waitSamples: bucket.waits.length,
    capacityQueued: bucket.capacityQueued,
    capacityRefused: bucket.capacityRefused,
  };
}

export class Metrics {
  constructor({ file, now = () => Date.now(), saveDelayMs = 1500 } = {}) {
    this.file = file;
    this.now = now;
    this.saveDelayMs = Math.max(0, Number(saveDelayMs) || 0);
    this.days = {};
    this.restarts = { count: 0, lastAt: null };
    this.saveTimer = null;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return; // first run, or unreadable/corrupt: start clean (this file is diagnostics, never user data)
    }
    const days = raw?.days && typeof raw.days === 'object' && !Array.isArray(raw.days) ? raw.days : {};
    for (const [key, value] of Object.entries(days)) if (/^\d{4}-\d{2}-\d{2}$/.test(key)) this.days[key] = cleanDay(value);
    const restarts = raw?.restarts && typeof raw.restarts === 'object' ? raw.restarts : {};
    this.restarts = { count: int(restarts.count), lastAt: Number.isFinite(Number(restarts.lastAt)) ? Number(restarts.lastAt) : null };
    this.trim(this.now());
  }

  bucket(ts = this.now()) {
    const key = dayKey(ts);
    return (this.days[key] ??= emptyDay());
  }

  /** A finished turn from the app (CLI mirrors are not counted: the server did not run them). */
  turn({ ok = true, durationMs = null } = {}) {
    const b = this.bucket();
    if (ok) b.turnsOk += 1;
    else b.turnsFailed += 1;
    if (Number.isFinite(Number(durationMs)) && Number(durationMs) > 0) {
      b.turnMs += num(durationMs);
      b.turnTimed += 1;
    }
    this.trim();
    this.saveSoon();
  }

  /** A queue item started; `waitMs` is how long it sat in 📋 Antrian (including a wait for a free turn). */
  queueStart({ waitMs = 0 } = {}) {
    const b = this.bucket();
    b.queueStarted += 1;
    b.waits.push(num(waitMs, 30 * DAY_MS));
    if (b.waits.length > MAX_WAIT_SAMPLES) b.waits.shift();
    this.trim();
    this.saveSoon();
  }

  capacityQueued() {
    this.bucket().capacityQueued += 1;
    this.saveSoon();
  }

  capacityRefused() {
    this.bucket().capacityRefused += 1;
    this.saveSoon();
  }

  restart() {
    this.restarts = { count: this.restarts.count + 1, lastAt: this.now() };
    this.save(); // a restart is rare and must survive a crash right after it
  }

  trim(now = this.now()) {
    const keep = new Set();
    for (let i = 0; i < METRICS_DAYS; i += 1) keep.add(dayKey(now - i * DAY_MS));
    for (const key of Object.keys(this.days)) if (!keep.has(key)) delete this.days[key];
  }

  /** Everything 🩺 shows: today, the last 7 local days (oldest first, empty days included) and restarts. */
  view(now = this.now()) {
    this.trim(now);
    const days = [];
    for (let i = METRICS_DAYS - 1; i >= 0; i -= 1) {
      const ts = now - i * DAY_MS;
      const key = dayKey(ts);
      days.push({ day: key, ...dayView(this.days[key] ?? emptyDay()) });
    }
    return {
      today: days[days.length - 1],
      days,
      restarts: { count: this.restarts.count, lastAt: this.restarts.lastAt },
    };
  }

  /** 🧹 Data saya → Hapus riwayat kesehatan: clears the rolling days and the restart count, then writes the empty file. */
  reset() {
    this.days = {};
    this.restarts = { count: 0, lastAt: null };
    this.save();
  }

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  /** Atomic tmp + rename; a failure is only logged (metrics must never break a turn). */
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ days: this.days, restarts: this.restarts }));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`Metrik tidak bisa disimpan: ${err?.message ?? err}`);
    }
  }

  /** On a clean shutdown: write what is pending now. */
  flush() {
    if (this.saveTimer) this.save();
  }
}
