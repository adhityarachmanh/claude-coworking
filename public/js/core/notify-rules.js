// 🔔 Notification settings, the pure part (no DOM, no imports: unit-tested in Node): cleaning what localStorage
// holds, quiet hours (local time, may cross midnight) and what one event should do (sound / popup / nothing).
//
// The defaults reproduce the behaviour from before these settings existed: every event type with popup + sound,
// no quiet hours, every project, full volume.

export const NOTIFY_KINDS = Object.freeze(['ask', 'done', 'error', 'queue']);
export const NOTIFY_LABELS = Object.freeze({ ask: 'Minta izin', done: 'Selesai', error: 'Berhenti / error', queue: 'Antrian mulai' });

export const NOTIFY_DEFAULTS = Object.freeze({
  events: Object.freeze({
    ask: Object.freeze({ popup: true, sound: true }),
    done: Object.freeze({ popup: true, sound: true }),
    error: Object.freeze({ popup: true, sound: true }),
    // A runbook can start many items; announcing every start must be opt-in.
    queue: Object.freeze({ popup: false, sound: false }),
  }),
  quiet: Object.freeze({ enabled: false, from: '22:00', to: '07:00', allowAsk: true }),
  favoritesOnly: false,
  muted: Object.freeze({}), // projectId → true: no sound and no popup from that project
  volume: 100,
});

const MAX_MUTED = 500;

/** Only `{ projectId: true }` entries survive (a hand-edited localStorage must not mute by accident). */
function cleanMuted(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let n = 0;
  for (const [id, on] of Object.entries(raw)) {
    if (on !== true || !id || id.length > 200) continue;
    out[id] = true;
    if (++n >= MAX_MUTED) break;
  }
  return out;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isTime = (v) => typeof v === 'string' && TIME_RE.test(v);

/** "HH:MM" → minutes since midnight (null when malformed). */
export function toMinutes(v) {
  const m = isTime(v) ? v.match(TIME_RE) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

/** A number or a numeric string ("42"); anything else (null, "", true, "abc") → null (= use the default). */
function parseVolume(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Whatever localStorage held (missing, hand-edited, an older shape) → a complete, valid settings object. */
export function cleanNotifySettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const events = {};
  for (const kind of NOTIFY_KINDS) {
    const e = src.events?.[kind] ?? {};
    const d = NOTIFY_DEFAULTS.events[kind];
    events[kind] = { popup: bool(e.popup, d.popup), sound: bool(e.sound, d.sound) };
  }
  const q = src.quiet ?? {};
  const d = NOTIFY_DEFAULTS.quiet;
  const volume = parseVolume(src.volume);
  return {
    events,
    quiet: {
      enabled: bool(q.enabled, d.enabled),
      from: isTime(q.from) ? q.from : d.from,
      to: isTime(q.to) ? q.to : d.to,
      allowAsk: bool(q.allowAsk, d.allowAsk),
    },
    favoritesOnly: bool(src.favoritesOnly, false),
    muted: cleanMuted(src.muted),
    volume: volume === null ? NOTIFY_DEFAULTS.volume : Math.min(100, Math.max(0, Math.round(volume))),
  };
}

/**
 * Is `date` (local time) inside [from, to)? A range whose end is earlier than its start crosses midnight
 * (22:00–07:00 covers 23:30 and 06:59, not 07:00). from === to is an empty range: never quiet.
 */
export function inQuietHours(date, from, to) {
  const f = toMinutes(from);
  const t = toMinutes(to);
  if (f === null || t === null || f === t) return false;
  const m = date.getHours() * 60 + date.getMinutes();
  return f < t ? m >= f && m < t : m >= f || m < t;
}

/** Validation message for the quiet-hours fields (null = fine). */
export function quietError(from, to) {
  if (!isTime(from) || !isTime(to)) return 'Isi jam dengan format JJ:MM.';
  if (from === to) return 'Jam mulai dan selesai tidak boleh sama.';
  return null;
}

const NOTHING = Object.freeze({ sound: false, popup: false });

/**
 * What one event does. `kind`: 'ask' | 'done' | 'error' | 'notice' (an app-wide notice such as a quota warning:
 * no per-type toggle, not tied to a project). `away`: the user is in another tab/app or another project.
 * `favorite`: the event's project is a favourite. `muted`: that project is silenced (nothing at all: not even a
 * permission request). The popup still needs the browser's permission (caller checks).
 */
export function notifyPlan(kind, settings, { away, favorite = false, muted = false, now = new Date() }) {
  const s = cleanNotifySettings(settings); // raw objects welcome (localStorage, a server-side caller)
  const notice = kind === 'notice';
  if (!notice && muted) return NOTHING;
  if (!notice && !away && kind !== 'ask') return NOTHING; // already looking at it (a permission request still chimes)
  if (!notice && s.favoritesOnly && !favorite) return NOTHING;
  if (s.quiet.enabled && inQuietHours(now, s.quiet.from, s.quiet.to) && !(kind === 'ask' && s.quiet.allowAsk)) return NOTHING;
  const ev = notice ? { popup: true, sound: true } : s.events[kind] ?? { popup: true, sound: true };
  return { sound: ev.sound && s.volume > 0, popup: (notice || away) && ev.popup };
}
