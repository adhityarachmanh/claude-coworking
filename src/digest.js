// 📅 Rekap mingguan: a plain-language summary of the last 7 days from the usage ledger. No model call, so it costs
// nothing and can be copied into a chat or a report. The scheduler only builds and stores it; delivery is the
// attention board (an unread digest is an item there until Pola kerja is opened).
import { insightSummary } from './insights.js';
import { nextRunAt } from './routines.js';

const usd = (n) => `$${new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.round(n * 100) / 100)}`;
const num = (n) => new Intl.NumberFormat('id-ID').format(Math.round(n));
const hour = (h) => `${String(h).padStart(2, '0')}.00–${String(h + 1).padStart(2, '0')}.00`;

export function weeklyDigest(rows, { now = Date.now() } = {}) {
  const s = insightSummary(rows, { now, days: 7 });
  const date = new Date(now).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const lines = [
    `# Rekap 7 hari · ${date}`,
    '',
    `Biaya ${usd(s.costUsd)} · ${num(s.tokens)} token · ${num(s.requests)} permintaan · ${num(s.sessions)} sesi · ${num(s.activeProjects)} project aktif.`,
    s.busiestHour == null ? 'Belum ada aktivitas tercatat.' : `Jam tersibuk: ${hour(s.busiestHour)}.`,
    '',
  ];
  if (s.projects.length) {
    lines.push('## Project', '');
    for (const p of s.projects) lines.push(`- **${p.name}** — ${usd(p.costUsd)} · ${num(p.tokens)} token · ${num(p.requests)} permintaan`);
    lines.push('');
  }
  if (s.models.length) {
    lines.push('## Model', '');
    for (const m of s.models) lines.push(`- \`${m.model}\` — ${usd(m.costUsd)} · ${num(m.tokens)} token`);
    lines.push('');
  }
  lines.push('_Dari biaya yang tercatat di ledger; OpenCode Go berlangganan biasanya tercatat $0._');
  return { markdown: lines.join('\n'), summary: s };
}

// ---------- otomatis: satu rekap per minggu, disimpan di state.json ----------

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIGEST_MAX = 20_000;

/** The stored schedule plus the last digest; a hand-edited file cannot break the settings or the board. */
export function cleanDigestSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: s.enabled === true,
    weekday: Number.isInteger(s.weekday) && s.weekday >= 0 && s.weekday <= 6 ? s.weekday : 1, // Senin
    time: TIME.test(String(s.time ?? '')) ? s.time : '08:00',
    dueAt: Number.isFinite(s.dueAt) ? s.dueAt : null,
    lastAt: Number.isFinite(s.lastAt) ? s.lastAt : null,
    lastMarkdown: typeof s.lastMarkdown === 'string' ? s.lastMarkdown.slice(0, DIGEST_MAX) : '',
    seenAt: Number.isFinite(s.seenAt) ? s.seenAt : null,
  };
}

/** The next weekly slot strictly after `from` (local time, Monday-first weekday like the routines). */
export function nextDigestAt(settings, from = Date.now()) {
  return nextRunAt({ frequency: 'weekly', weekday: settings?.weekday ?? 1, time: settings?.time ?? '08:00' }, from);
}

/** A saved digest nobody has opened yet: the attention board shows it until Pola kerja marks it seen. */
export function digestUnread(settings) {
  const s = cleanDigestSettings(settings);
  return Boolean(s.lastAt && (!s.seenAt || s.seenAt < s.lastAt));
}

/**
 * Applies a schedule change. Turning it on (or moving the weekday/time) picks the next slot strictly after now, so
 * enabling it never fires immediately; an unchanged schedule keeps its pending slot.
 */
export function applyDigestSettings(raw, patch = {}, now = Date.now()) {
  const before = cleanDigestSettings(raw);
  const p = patch && typeof patch === 'object' ? patch : {};
  const merged = cleanDigestSettings({
    ...before,
    enabled: 'enabled' in p ? p.enabled === true : before.enabled,
    weekday: 'weekday' in p ? p.weekday : before.weekday,
    time: 'time' in p ? p.time : before.time,
  });
  const same = before.enabled === merged.enabled && before.weekday === merged.weekday && before.time === merged.time;
  // A preserved slot that already passed is moved forward: saving a schedule never fires a late digest at once.
  merged.dueAt = merged.enabled ? (same && before.dueAt && before.dueAt > now ? before.dueAt : nextDigestAt(merged, now)) : null;
  return merged;
}

/** Builds the last 7 days of the ledger and stores the result as the newest digest (seenAt cleared). */
export function buildDigestNow(hub, ledger, now = Date.now()) {
  const rows = ledger?.query?.({ accountId: 'all', from: now - 7 * 86_400_000 }) ?? [];
  const { markdown } = weeklyDigest(rows, { now });
  const digest = cleanDigestSettings({ ...hub.persisted?.digest, lastAt: now, lastMarkdown: markdown, seenAt: null });
  hub.persisted.digest = digest;
  return digest;
}

/** Once a minute: when the stored slot passes, build the digest, save it and tell open pages. */
export class DigestScheduler {
  constructor({ hub, ledger, now = () => Date.now(), intervalMs = 60_000 }) {
    this.hub = hub;
    this.ledger = ledger;
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
      const current = cleanDigestSettings(this.hub.persisted?.digest);
      if (!current.enabled) return;
      // A schedule saved before this feature ran has no slot yet: give it the next one instead of firing now.
      const due = current.dueAt ?? nextDigestAt(current, now);
      if (now < due) {
        if (current.dueAt !== due) this.hub.persisted.digest = { ...current, dueAt: due };
        return;
      }
      const digest = buildDigestNow(this.hub, this.ledger, now);
      digest.dueAt = nextDigestAt(digest, now);
      this.hub.persisted.digest = digest;
      this.hub.save?.();
      this.hub.broadcast?.('digest', digest);
    } finally {
      this.busy = false;
    }
  }
}
