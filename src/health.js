// 🩺 Kesehatan sistem (POST /api/health): one snapshot of what the office needs to work — the account, OpenCode,
// project folders, the automatic backup, phone access, the server's last 24 h of errors and the size of data/ —
// plus the onboarding checklist. Sync and cheap: no CLI, no model.
//
// Every service is read through `safe()`: a missing service (a test ctx, OpenCode not installed, no log yet) is a
// warn line in the report, never a failed request. Nothing here throws.
//
// Laptop + Tailscale only: this route is NOT on the plain-HTTP WiFi read allowlist (src/remote.js wifiAllows), so
// server.js refuses it for a read-only phone before this module runs. The details stay short on purpose: the last
// error message is one line, at most 200 characters (never a stack).
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { budgetView, cleanLimits, hasBudget, WINDOW_UNITS } from './budget.js';
import { latestAutoBackupSync } from './backup-schedule.js';

const DAY_MS = 86_400_000;
const LOG_TAIL_BYTES = 256 * 1024;
const DATA_WARN_BYTES = 1024 ** 3; // 1 GB
const DATA_MAX_FILES = 50_000;
const DATA_MAX_DEPTH = 6;
const MESSAGE_MAX = 200;
// server.js --background writes `[2026-11-05T09:12:34.567Z] ERROR pesan`; a stack follows as plain (unprefixed) lines.
const ERROR_LINE = /^\[([^\]]{10,40})\] ERROR (.*)$/;
const HTTPS_READY = new Set(['ok', 'expiring']);

/** Runs `fn`, never throws: the fallback is the answer when a service is missing or misbehaving. */
const safe = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
/** A log/error message for the report: one line, at most 200 characters. */
const clip = (value, max = MESSAGE_MAX) => oneLine(value).slice(0, max);
/** 1234 → "1.234" (the report reads Indonesian). */
const countLabel = (n) => String(Math.max(0, Math.trunc(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const sizeLabel = (bytes) => {
  const b = Math.max(0, Number(bytes) || 0);
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${(b / 1024).toFixed(1).replace('.', ',')} KB`;
};
/** "baru saja" / "12 menit lalu" / "3 jam lalu" / "2 hari lalu" — no locale data, no clock surprises. */
const agoLabel = (now, at) => {
  const t = Number(at);
  if (!Number.isFinite(t)) return 'waktu tidak diketahui';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.round(s / 60)} menit lalu`;
  if (s < 86_400) return `${Math.round(s / 3600)} jam lalu`;
  return `${Math.round(s / 86_400)} hari lalu`;
};

/** 12.3 → "$12,30" (the report reads Indonesian: comma decimals, dot thousands). */
const usdLabel = (value) => {
  const [whole, dec] = Math.max(0, Number(value) || 0).toFixed(2).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
};

/** 💰 The windows whose limit is set, as "hari ini $12,30 / $20 (62%)"; the worst one decides the state. */
const BUDGET_WINDOW_LABEL = Object.freeze({ day: 'hari ini', week: 'minggu ini', month: 'bulan ini' });
function budgetCheck(view) {
  const set = WINDOW_UNITS.filter((unit) => view.windows[unit].limit != null);
  const detail = set
    .map((unit) => {
      const w = view.windows[unit];
      return `${BUDGET_WINDOW_LABEL[unit]} ${usdLabel(w.usd)} / ${usdLabel(w.limit)} (${Math.round(w.percent * 100)}%)`;
    })
    .join(' · ');
  if (set.some((unit) => view.windows[unit].state === 'over')) return { ok: false, detail, hint: 'Batas pemakaian terlampaui. Naikkan atau matikan di ⚙ → Pengaturan.' };
  if (set.some((unit) => view.windows[unit].state === 'warn')) return { ok: false, warn: true, detail, hint: 'Sudah di atas 80% batas. Atur di ⚙ → Pengaturan.' };
  return { ok: true, detail };
}

/** The last `maxBytes` of a file as UTF-8 text; '' when it does not exist or cannot be read. */
function readTail(file, maxBytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const length = Math.min(maxBytes, size);
    const buf = Buffer.alloc(length);
    if (length) readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return ''; // started without --background (no log file), or unreadable: nothing to report
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed: nothing to do
      }
    }
  }
}

/** ERROR lines of the log tail whose timestamp is inside the last 24 h (`now`). */
function recentErrors(dataDir, now) {
  const text = dataDir ? readTail(path.join(dataDir, 'server.log'), LOG_TAIL_BYTES) : '';
  let count = 0;
  let last = null;
  for (const line of text.split('\n')) {
    const m = ERROR_LINE.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at) || at < now - DAY_MS) continue;
    count += 1;
    last = clip(m[2]); // appended oldest first: the last match is the newest message
  }
  return { count24h: count, last };
}

/**
 * Recursive size and file count of `dir`: symlinks are never followed, at most 50 000 files and 6 levels deep
 * (a runaway depth or a junction loop can only cost a bounded walk). Unreadable entries are skipped.
 */
function dataUsage(dir) {
  const usage = { bytes: 0, files: 0 };
  if (!dir) return usage;
  const walk = (at, depth) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return; // gone, busy or unreadable: skip this folder
    }
    for (const entry of entries) {
      if (usage.files >= DATA_MAX_FILES) return;
      if (entry.isSymbolicLink()) continue; // never follow a link out of data/
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        if (depth < DATA_MAX_DEPTH) walk(full, depth + 1);
      } else if (entry.isFile()) {
        usage.files += 1;
        const size = safe(() => statSync(full).size, 0);
        usage.bytes += Number.isFinite(size) ? size : 0;
      }
    }
  };
  walk(dir, 0);
  return usage;
}

/**
 * The system-health report shown by the app.
 * @param {object} ctx the server's route ctx (server.js): account, opencode, hub, projectRoots, backupScheduler,
 *   remote, httpsInfo, appVersion, port, dataDir
 * @param {{ now?: number }} [options] `now` (epoch ms) for the 24 h window and the "x hours ago" labels
 * @returns {{ at: number, app: { version: string, pid: number, uptimeSec: number, engine: string, port: number|null },
 *   checks: { id: string, label: string, ok: boolean, warn?: boolean, detail: string, hint?: string }[],
 *   checklist: { id: string, label: string, done: boolean, hint: string }[],
 *   errors: { count24h: number, last: string|null }, data: { bytes: number, files: number, dir: string },
 *   metrics: object|null }}
 */
export function buildHealth(ctx = {}, { now = Date.now() } = {}) {
  const c = ctx ?? {};
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const dataDir = typeof c.dataDir === 'string' ? c.dataDir : '';
  const account = c.account ?? null;
  const current = safe(() => account?.current ?? null);
  const profile = safe(() => account?.profile ?? null);

  // ---------- what the checks below share (each read once, safely) ----------
  const roots = safe(() => c.projectRoots?.() ?? [], []) ?? [];
  const existingRoots = roots.filter((root) => safe(() => existsSync(root), false));
  const registry = safe(() => (c.hub?.projects ? [...c.hub.projects.values()] : null), null);
  // A real project: not the built-in demo and not a virtual entry (both live in hub.projects with `virtual: true`).
  // A ctx without the hub (a test, a future caller) falls back to the existing roots: still something to work in.
  const realProjects = (registry ?? []).filter((p) => p && p.id !== 'demo' && !p.virtual);
  const realCount = registry ? realProjects.length : existingRoots.length;
  const hasProject = realCount > 0;

  const backupView = safe(() => c.backupScheduler?.view() ?? null);
  const schedule = backupView?.schedule ?? null;

  const remoteInfo = safe(() => c.remote?.publicInfo?.(Number(c.port) || 0) ?? null);
  const remoteEnabled = Boolean(remoteInfo?.enabled ?? safe(() => c.remote?.enabled, false));
  const https = safe(() => c.httpsInfo?.() ?? null);
  const httpsReady = HTTPS_READY.has(https?.state);
  const deviceCount = Array.isArray(remoteInfo?.devices) ? remoteInfo.devices.length : 0;

  const errors = safe(() => recentErrors(dataDir, at), { count24h: 0, last: null });
  const data = safe(() => dataUsage(dataDir), { bytes: 0, files: 0 });

  /** One check; `make()` may throw and still leaves a valid (warn) line. */
  const run = (id, label, make) => {
    try {
      const result = make() ?? {};
      return {
        id,
        label,
        ok: result.ok === true,
        ...(result.warn ? { warn: true } : {}),
        detail: oneLine(result.detail),
        ...(result.hint ? { hint: String(result.hint) } : {}),
      };
    } catch {
      return { id, label, ok: false, warn: true, detail: 'Tidak bisa diperiksa sekarang.', hint: 'Coba lagi sebentar lagi.' };
    }
  };

  const checks = [
    run('claude', 'Akun Claude', () => {
      if (!current) return { ok: false, detail: 'Belum login', hint: 'Login Claude di ⚙ → Akun supaya bisa memulai giliran.' };
      const plan = oneLine(profile?.subscriptionType);
      return { ok: true, detail: [oneLine(current.email) || 'Sudah login', plan ? `paket ${plan}` : ''].filter(Boolean).join(' · ') };
    }),

    run('opencode', 'OpenCode', () => {
      if (!c.opencode) return { ok: false, warn: true, detail: 'Belum terpasang', hint: 'Opsional: pasang OpenCode untuk memakai mesin kedua (⚙ → Kompatibilitas OpenCode).' };
      const version = oneLine(safe(() => c.hub?.config?.engines?.opencode?.version, '')).replace(/^v/i, '');
      return { ok: true, detail: version ? `Terpasang · v${version}` : 'Terpasang' };
    }),

    run('projects', 'Folder project', () => {
      if (!roots.length && !hasProject) return { ok: false, warn: true, detail: 'Belum ada folder project', hint: 'Tambahkan folder project di ⚙ → Folder project.' };
      if (existingRoots.length < roots.length) {
        const counted = registry ? `${countLabel(realCount)} project` : 'sebagian tidak ditemukan';
        return { ok: false, warn: true, detail: `${existingRoots.length} dari ${roots.length} folder root ditemukan · ${counted}`, hint: 'Ada folder root yang tidak ditemukan. Periksa di ⚙ → Folder project.' };
      }
      if (!hasProject) return { ok: false, warn: true, detail: `${countLabel(roots.length)} folder root · 0 project`, hint: 'Folder root belum berisi project. Tambahkan satu di ⚙ → Folder project.' };
      const counted = registry ? `${countLabel(realCount)} project` : 'siap dipakai';
      return { ok: true, detail: `${countLabel(roots.length)} folder root · ${counted}` };
    }),

    run('backup', 'Backup otomatis', () => {
      if (!schedule) return { ok: false, warn: true, detail: 'Belum tersedia', hint: 'Muat ulang halaman, lalu buka ⚙ → Cadangkan riwayat.' };
      if (!schedule.enabled) return { ok: false, warn: true, detail: 'Mati', hint: 'Nyalakan di ⚙ → Cadangkan riwayat supaya riwayat tidak hilang.' };
      if (!schedule.folder) return { ok: false, warn: true, detail: 'Menyala, tapi folder tujuan belum diatur', hint: 'Pilih folder tujuan di ⚙ → Cadangkan riwayat.' };
      const last = backupView.last;
      if (!last) return { ok: false, warn: true, detail: 'Menyala · belum pernah jalan', hint: 'Backup pertama jalan sesuai jadwal; "Jalankan sekarang" untuk mencoba.' };
      if (last.ok === false) {
        const reason = clip(last.error, 120);
        return { ok: false, warn: true, detail: `Gagal ${agoLabel(at, last.at)}${reason ? `: ${reason}` : ''}`, hint: 'Periksa folder tujuan, lalu jalankan lagi dari ⚙ → Cadangkan riwayat.' };
      }
      // A successful last run is not enough: the file itself must still be there and not older than the schedule.
      const fresh = safe(() => latestAutoBackupSync(schedule.folder), null);
      if (!fresh) {
        return {
          ok: false,
          warn: true,
          detail: 'File backup tidak ditemukan di folder tujuan',
          hint: 'Folder mungkin dipindah atau file dihapus. Jalankan "Jalankan sekarang" dari ⚙ → Cadangkan riwayat.',
        };
      }
      const maxAge = schedule.frequency === 'weekly' ? 8 * DAY_MS : 36 * 3_600_000;
      if (at - fresh.at > maxAge) {
        return {
          ok: false,
          warn: true,
          detail: `Terakhir ${agoLabel(at, fresh.at)} · ${oneLine(fresh.name)}`,
          hint: `Lebih lama dari jadwal ${schedule.frequency === 'weekly' ? 'mingguan' : 'harian'}. Periksa folder tujuan, lalu jalankan lagi dari ⚙ → Cadangkan riwayat.`,
        };
      }
      return { ok: true, detail: [`Terakhir ${agoLabel(at, fresh.at)}`, oneLine(fresh.name), sizeLabel(fresh.bytes)].filter(Boolean).join(' · ') };
    }),

    run('remote', 'Akses HP', () => {
      if (!remoteEnabled) return { ok: true, detail: 'Mati · hanya dari laptop', hint: 'Nyalakan di ⚙ → Akses HP kalau mau memantau dari HP.' };
      if (!httpsReady) return { ok: false, warn: true, detail: `Menyala · ${countLabel(deviceCount)} perangkat`, hint: 'HP hanya bisa lihat lewat WiFi. Pasang Tailscale supaya HP bisa mengirim perintah.' };
      return { ok: true, detail: `Menyala · ${countLabel(deviceCount)} perangkat · HTTPS ${oneLine(https?.host) || 'aktif'}` };
    }),

    run('errors', 'Error server (24 jam)', () => {
      if (!errors.count24h) return { ok: true, detail: 'Tidak ada error dalam 24 jam terakhir' };
      return { ok: false, warn: true, detail: `${countLabel(errors.count24h)} error dalam 24 jam terakhir`, hint: errors.last ? `Terakhir: ${errors.last}` : undefined };
    }),

    run('data', 'Ukuran data', () => {
      const usage = `${sizeLabel(data.bytes)} · ${countLabel(data.files)} file`;
      if (data.bytes < DATA_WARN_BYTES) return { ok: true, detail: usage };
      return { ok: false, warn: true, detail: usage, hint: 'Folder data sudah 1 GB atau lebih. Hapus riwayat lama atau pindahkan folder data.' };
    }),
  ];

  // 💰 Batas pemakaian: only when a limit is set, so an office without one pays no ledger read here. `run()` still
  // turns a missing/broken ledger (ctx.ledger is optional) into the usual warn line instead of a failed request.
  const budgetLimits = safe(() => cleanLimits(c.hub?.persisted?.budget), {}) ?? {};
  if (hasBudget(budgetLimits)) checks.push(run('budget', 'Batas pemakaian', () => budgetCheck(budgetView(c.hub, c.ledger, at))));

  // Onboarding: what a fresh office still needs. "https" is done when the phone access that needs it is off.
  // `login` reads the Claude account only: listing OpenCode's providers (`opencode auth list`) would spawn a CLI,
  // which this report must never do, so an OpenCode-only setup shows this item as not done (OpenCode stays optional).
  const checklist = [
    { id: 'login', label: 'Login Claude (atau provider OpenCode)', done: Boolean(current), hint: 'Login lewat ⚙ → Akun.' },
    { id: 'project', label: 'Folder project', done: hasProject, hint: 'Tambahkan folder project di ⚙ → Folder project.' },
    { id: 'backup', label: 'Backup otomatis', done: Boolean(schedule?.enabled && schedule?.folder), hint: 'Nyalakan di ⚙ → Cadangkan riwayat dan pilih folder tujuan.' },
    { id: 'https', label: 'HTTPS untuk HP', done: httpsReady || !remoteEnabled, hint: 'Pasang Tailscale di laptop dan HP supaya HP bisa memantau dari mana saja (⚙ → Akses HP).' },
    // Optional: the office works on Claude Code alone.
    { id: 'opencode', label: 'OpenCode (opsional)', done: Boolean(c.opencode), hint: 'Opsional: pasang OpenCode untuk mesin kedua (⚙ → Kompatibilitas OpenCode).' },
  ];

  return {
    at,
    app: {
      version: oneLine(c.appVersion),
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      engine: oneLine(safe(() => c.hub?.engine ?? c.hub?.config?.engine, 'claude')) || 'claude',
      port: Number.isFinite(Number(c.port)) ? Number(c.port) : null,
    },
    checks,
    checklist,
    errors,
    data: { bytes: data.bytes, files: data.files, dir: dataDir },
    metrics: safe(() => c.metrics?.view?.(at) ?? null),
  };
}
