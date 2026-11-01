// Quota warnings, the pure part (no DOM, no imports: unit-tested in Node): which plan windows are near their
// limit, and which thresholds have not been announced yet in the current reset period.
//
// Sources, both already on the page (nothing here asks the server):
// - account.rateLimit.windows: from the rate_limit_event every running session sends for free
//   ({ five_hour: { status, utilization 0..1, resetsAt epoch seconds, at } }).
// - account.limits.windows: the last `/usage` the account dialog fetched ({ label, percent, resets text }).

export const QUOTA_DEFAULTS = Object.freeze({ enabled: true, warn: 70, crit: 90 });

const WINDOW_LABEL = {
  five_hour: 'Sesi 5 jam',
  seven_day: 'Mingguan',
  seven_day_opus: 'Mingguan (Opus)',
  seven_day_sonnet: 'Mingguan (Sonnet)',
  overage: 'Kredit tambahan',
};
const RESET_JITTER_MS = 30 * 60_000; // two reports of the same reset never differ by this much
const DROP_MEANS_RESET = 10; // usage only grows within a period: a fall this big means it was reset

export const windowLabel = (key) => WINDOW_LABEL[key] ?? (key.startsWith('seven_day_') ? `Mingguan (${key.slice(10)})` : key);

/** `/usage` label → window key: "Current session" → five_hour, "Current week (all models)" → seven_day. */
export function usageKey(label) {
  const text = String(label ?? '').trim();
  if (/^current session$/i.test(text)) return 'five_hour';
  const week = text.match(/^current week(?:\s*\((.+)\))?$/i);
  if (!week) return null;
  return !week[1] || /^all models$/i.test(week[1]) ? 'seven_day' : `seven_day_${week[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Every window with a known usage, newest source first: [{ key, label, percent, resetsAt (ms|null), resetsText,
 * limited }]. A window whose reset time has passed is dropped: its numbers belong to the period that just ended.
 */
export function quotaWindows(account, now = Date.now()) {
  const byKey = new Map();
  const rl = account?.rateLimit;
  const fromEvents = rl?.windows ?? rl?.unifiedWindows ?? {};
  for (const [key, w] of Object.entries(fromEvents)) {
    if (!w || typeof w !== 'object') continue;
    const resetsAt = finite(w.resetsAt) == null ? null : w.resetsAt * 1000;
    if (resetsAt != null && resetsAt <= now) continue;
    const limited = typeof w.status === 'string' && w.status === 'rejected';
    const utilization = finite(w.utilization);
    if (utilization == null && !limited) continue;
    byKey.set(key, { key, label: windowLabel(key), percent: limited && utilization == null ? 100 : Math.round(utilization * 100), resetsAt, resetsText: null, limited, at: finite(w.at) ?? finite(rl.at) ?? 0 });
  }
  const limits = account?.limits;
  for (const w of limits?.windows ?? []) {
    const key = usageKey(w?.label);
    const percent = finite(w?.percent);
    if (!key || percent == null) continue;
    const at = finite(limits.at) ?? 0;
    const known = byKey.get(key);
    if (known && known.at >= at) continue; // a session reported it more recently
    // `/usage` only gives the reset as text; keep the exact time a session reported for the same period.
    byKey.set(key, { key, label: windowLabel(key), percent: Math.round(percent), resetsAt: known?.resetsAt ?? null, resetsText: w.resets ?? null, limited: percent >= 100, at });
  }
  return [...byKey.values()];
}

/** Thresholds from settings, made safe: whole numbers, 1 ≤ warn < crit ≤ 100. */
export function cleanThresholds(raw) {
  const int = (v, d) => (Number.isInteger(Number(v)) && v !== '' && v != null ? Number(v) : d);
  const warn = int(raw?.warn, QUOTA_DEFAULTS.warn);
  const crit = int(raw?.crit, QUOTA_DEFAULTS.crit);
  const ok = warn >= 1 && crit <= 100 && warn < crit;
  return { enabled: raw?.enabled !== false, warn: ok ? warn : QUOTA_DEFAULTS.warn, crit: ok ? crit : QUOTA_DEFAULTS.crit };
}

/** Why a threshold pair is refused (for the settings form), or null when it is fine. */
export function thresholdError(warn, crit) {
  const isInt = (v) => v !== '' && Number.isInteger(Number(v));
  if (!isInt(warn) || !isInt(crit)) return 'Ambang harus bilangan bulat.';
  if (Number(warn) < 1 || Number(crit) > 100) return 'Ambang harus antara 1 dan 100.';
  if (Number(warn) >= Number(crit)) return 'Ambang kuning harus lebih kecil dari ambang merah.';
  return null;
}

/** The levels a window has reached: some of [warn, crit, 100]. 100 = used up / rate limited. */
export function reachedLevels(w, th) {
  if (!th.enabled) return [];
  const levels = [...new Set([th.warn, th.crit, 100])].sort((a, b) => a - b);
  return levels.filter((l) => w.percent >= l || (l === 100 && w.limited));
}

/** 'crit' | 'warn' | null: the colour of the indicator for one window. */
export function tone(w, th) {
  if (!th.enabled) return null;
  if (w.limited || w.percent >= th.crit) return 'crit';
  return w.percent >= th.warn ? 'warn' : null;
}

const periodId = (w) => (w.resetsAt ? `t:${Math.round(w.resetsAt / RESET_JITTER_MS)}` : w.resetsText ? `s:${w.resetsText}` : null);

/** Is `w` in a later reset period than the one remembered in `m`? */
function newPeriod(m, w, now) {
  if (m.resetsAt && now >= m.resetsAt) return true;
  if (w.resetsAt && m.resetsAt && Math.abs(w.resetsAt - m.resetsAt) > RESET_JITTER_MS) return true;
  // Text-only on both sides (`/usage`): a different reset text is a different period.
  if (!w.resetsAt && !m.resetsAt && w.resetsText && m.period?.startsWith('s:') && m.period !== `s:${w.resetsText}`) return true;
  return Boolean(m.levels?.length) && w.percent < Math.min(...m.levels) - DROP_MEANS_RESET;
}

/**
 * Which warnings to show now. `memory` ({ [windowKey]: { period, resetsAt, levels } }) is what was already
 * announced; returns the alerts (one per window: its highest new level) and the memory to store.
 */
export function evaluateQuota(windows, memory, th, now = Date.now()) {
  const next = {};
  for (const [key, m] of Object.entries(memory && typeof memory === 'object' ? memory : {})) {
    if (m && typeof m === 'object' && Array.isArray(m.levels) && !(m.resetsAt && now >= m.resetsAt)) next[key] = m;
  }
  const alerts = [];
  for (const w of windows) {
    let m = next[w.key];
    // Numbers older than the ones already judged (an old `/usage` still on the page) can neither warn nor reset.
    if (m && (w.at ?? 0) < (m.at ?? 0)) continue;
    if (m && newPeriod(m, w, now)) {
      delete next[w.key];
      m = undefined;
    }
    const reached = reachedLevels(w, th);
    if (!reached.length) continue;
    const fresh = reached.filter((l) => !m?.levels.includes(l));
    if (fresh.length) alerts.push({ window: w, level: Math.max(...fresh) });
    next[w.key] = {
      period: periodId(w) ?? m?.period ?? null,
      resetsAt: w.resetsAt ?? m?.resetsAt ?? null,
      at: Math.max(w.at ?? 0, m?.at ?? 0),
      levels: [...new Set([...(m?.levels ?? []), ...reached])].sort((a, b) => a - b),
    };
  }
  return { alerts, memory: next };
}

/** "Sen 09.00" (with the date when the reset is a week or more away); the `/usage` text when that is all there is. */
export function fmtReset(w, now = Date.now()) {
  if (!w.resetsAt) return w.resetsText ?? null;
  const d = new Date(w.resetsAt);
  const day = d.toLocaleDateString('id-ID', { weekday: 'short' });
  const time = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const far = w.resetsAt - now >= 6 * 86_400_000;
  return far ? `${day} ${d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })} ${time}` : `${day} ${time}`;
}

/** "Kuota mingguan 92% · reset Sen 09.00" */
export function quotaTooltip(w, now = Date.now()) {
  const reset = fmtReset(w, now);
  return `Kuota ${w.label.toLowerCase()} ${w.limited ? 'habis' : `${w.percent}%`}${reset ? ` · reset ${reset}` : ''}`;
}

/** The toast / notification text for an alert. */
export function alertText({ window: w, level }, now = Date.now()) {
  const reset = fmtReset(w, now);
  const when = reset ? `reset ${reset}` : 'waktu reset belum diketahui (lihat 👤 Akun)';
  if (level >= 100) return `⛔ Kuota ${w.label.toLowerCase()} habis — Claude tidak bisa dipakai sampai ${when}.`;
  return `⚠ Kuota ${w.label.toLowerCase()} sudah ${w.percent}% — ${when}.`;
}
