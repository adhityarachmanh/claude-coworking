// ♪ Spotify, the client's rules (pure, no DOM): cleaning the server's `publicState()` (docs/design-spotify.md §2.6),
// the progress between events, and the texts every view shares (pill, dialog, radio, dashboard, palette).
// The server already filters the state, but titles and artists are untrusted text: everything here is clipped and
// type-checked, and the views put it in the page with textContent / attributes only.

export const STATUSES = ['unconfigured', 'disconnected', 'idle', 'playing', 'paused'];
export const ERROR_CODES = ['no-device', 'premium', 'restricted', 'rate-limited', 'network', 'revoked'];
const KINDS = ['track', 'episode', 'ad'];
const MAX_TEXT = 200;
const ART_ID = /^[0-9a-f]{16}$/;

const str = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The server's state with every field checked; `null` when it is not a state at all (no backend, garbage).
 * Unknown status → 'disconnected' (the safe "nothing to control" view).
 */
export function cleanState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const status = STATUSES.includes(raw.status) ? raw.status : 'disconnected';
  const e = raw.error;
  const error = e && typeof e === 'object' && ERROR_CODES.includes(e.code) ? { code: e.code, message: str(e.message), until: num(e.until, 0) || null } : null;
  const t = raw.track;
  const track =
    t && typeof t === 'object'
      ? {
          kind: KINDS.includes(t.kind) ? t.kind : 'track',
          title: str(t.title),
          artists: str(t.artists),
          album: str(t.album),
          artId: typeof t.artId === 'string' && ART_ID.test(t.artId) ? t.artId : null,
          durationMs: Math.max(0, num(t.durationMs)),
        }
      : null;
  const d = raw.device;
  const device =
    d && typeof d === 'object'
      ? {
          name: str(d.name),
          type: str(d.type),
          volume: typeof d.volume === 'number' && Number.isFinite(d.volume) ? clamp(Math.round(d.volume), 0, 100) : null,
          supportsVolume: d.supportsVolume === true,
        }
      : null;
  return {
    status,
    error,
    track,
    progressMs: Math.max(0, num(raw.progressMs)),
    at: num(raw.at, 0),
    device,
    office: raw.office !== false,
    updatedAt: num(raw.updatedAt, 0),
  };
}

export const isConnected = (s) => Boolean(s) && !['unconfigured', 'disconnected'].includes(s.status);
export const hasTrack = (s) => Boolean(s?.track) && ['playing', 'paused'].includes(s.status);

/** Where the song is at `now`: the server's reading plus the time since, while playing (never past the end). */
export function progressAt(s, now = Date.now()) {
  if (!s?.track) return 0;
  const dur = s.track.durationMs;
  const base = s.progressMs + (s.status === 'playing' && s.at ? Math.max(0, now - s.at) : 0);
  return dur ? Math.min(base, dur) : base;
}

/** 83000 → "1:23"; an hour or more → "1:02:03". */
export function fmtTime(ms) {
  const total = Math.max(0, Math.floor(num(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** A wall-clock time "14:32"; another day gets its date in front ("3/11 14:32"). */
export function clockTime(ts, now = Date.now()) {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.getDate()}/${d.getMonth() + 1} ${hm}`;
}

/** "Judul – Artis" (an ad / a private session has no title). */
export function trackLine(s) {
  const t = s?.track;
  if (!t) return '';
  if (t.kind === 'ad') return 'Iklan';
  if (!t.title) return 'Sesi pribadi';
  return t.artists ? `${t.title} – ${t.artists}` : t.title;
}

export const SETTINGS_HINT = 'Hubungkan Spotify di ⚙ (laptop)';

/**
 * The one-line status for the dialog and the pill's ⚠: an error first, then the empty states. '' = all fine.
 * `local`: this page is the laptop (it can open ⚙ itself).
 */
export function statusText(s, { now = Date.now() } = {}) {
  if (!s) return '';
  if (s.status === 'unconfigured') return 'Spotify belum diatur. Isi Client ID di ⚙ Pengaturan (laptop).';
  if (s.status === 'disconnected') return s.error?.code === 'revoked' ? `Akses Spotify dicabut. ${SETTINGS_HINT}.` : `${SETTINGS_HINT}.`;
  switch (s.error?.code) {
    case 'no-device':
      return 'Tidak ada perangkat aktif. Buka Spotify di HP/PC lalu pilih di sini.';
    case 'premium':
      return 'Butuh Spotify Premium untuk mengendalikan musik.';
    case 'restricted':
      // Also what Spotify answers when the account isn't on the dev-mode app's user list.
      return 'Spotify menolak perintah ini. Perangkat ini mungkin dibatasi, atau akun belum terdaftar: tambahkan akun Spotify-mu di Users/User Management app di Spotify Developer Dashboard.';
    case 'rate-limited':
      return s.error.until ? `Dibatasi Spotify, coba lagi ${clockTime(s.error.until, now)}.` : 'Dibatasi Spotify, coba lagi sebentar lagi.';
    case 'network':
      return s.updatedAt ? `Spotify tidak terjangkau. Terakhir diperbarui ${clockTime(s.updatedAt, now)}.` : 'Spotify tidak terjangkau.';
    case 'revoked':
      return `Akses Spotify dicabut. ${SETTINGS_HINT}.`;
    default:
      return s.status === 'idle' ? 'Tidak ada yang diputar. Pilih perangkat di bawah atau putar playlist.' : '';
  }
}

/**
 * Why the player can't be controlled right now (null = it can). Read-only WiFi is decided by the caller
 * (the server's allowlist, api.js canCall), not here.
 */
export function controlBlock(s, { now = Date.now() } = {}) {
  if (!isConnected(s)) return 'Spotify belum terhubung';
  const code = s.error?.code;
  if (code === 'premium') return 'Butuh Spotify Premium';
  if (code === 'restricted') return 'Perangkat ini tidak bisa dikendalikan';
  if (code === 'rate-limited' && (!s.error.until || s.error.until > now)) return statusText(s, { now });
  return null;
}

/** The office radio's accessible name. */
export function radioLabel(s) {
  if (!s || s.status === 'unconfigured') return 'Radio: Spotify belum diatur. Buka pengaturan musik';
  if (s.status === 'disconnected') return 'Radio: Spotify belum terhubung. Buka kontrol musik';
  if (hasTrack(s)) {
    const t = s.track;
    const what = t.kind === 'ad' ? 'iklan' : t.title ? `«${t.title}»${t.artists ? ` – ${t.artists}` : ''}` : 'sesi pribadi';
    return `Musik: ${what}, ${s.status === 'playing' ? 'sedang diputar' : 'dijeda'}. Buka kontrol musik`;
  }
  return 'Musik: tidak ada yang diputar. Buka kontrol musik';
}

/** Small icon for a Spotify Connect device type. */
export function deviceIcon(type) {
  const t = String(type ?? '').toLowerCase();
  if (t === 'smartphone') return '📱';
  if (t === 'computer') return '💻';
  if (t === 'speaker' || t === 'avr' || t === 'stb') return '🔊';
  if (t === 'tv' || t === 'castvideo') return '📺';
  if (t === 'tablet') return '📲';
  return '🎵';
}

/** Client ID as Spotify issues it (the server checks again). */
export const CLIENT_ID_RE = /^[0-9a-f]{32}$/i;
export const DUCK_MODES = ['off', 'duck', 'pause'];
