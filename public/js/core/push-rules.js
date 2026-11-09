// 🔔 Notifikasi HP (Web Push), the pure part (no DOM, no imports: unit-tested in Node).
// Which state the "Notifikasi HP (push)" section shows, what the server gets as settings, the deep link.
// See docs/design-web-push.md §C/§D; the client side is public/js/core/push-client.js + features/push.js.

/** iPhone / iPad (iPadOS reports itself as a Mac with touch). */
export function isIos({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  return /iPhone|iPad|iPod/.test(userAgent) || ((/Macintosh/.test(userAgent) || platform === 'MacIntel') && maxTouchPoints > 1);
}

/**
 * Where this page stands for push. `env` is read from the browser by the caller:
 * { protocol, secure, local, readOnly, hasServiceWorker, hasPushManager, hasNotification, permission, ios, standalone }
 * @returns {'laptop'|'http'|'ios-install'|'unsupported'|'denied'|'ready'}
 *   laptop: the laptop itself (in-page notifications only) · http: a phone on http (WiFi / Tailscale-http) ·
 *   ios-install: iOS Safari tab, push needs the home-screen app · denied: blocked in the browser ·
 *   ready: can subscribe (or already did)
 */
export function pushAvailability(env) {
  if (env.local) return 'laptop';
  if (env.protocol !== 'https:' || !env.secure) return 'http';
  if (env.ios && !env.standalone) return 'ios-install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  return 'ready';
}

/** Status line of the section (Indonesian, shown as is). `subscribed` only matters when ready. */
export function pushStatusText(availability, subscribed) {
  switch (availability) {
    case 'ios-install':
      return 'iPhone/iPad: Tambahkan ke Layar Utama dulu (Bagikan → Tambahkan ke Layar Utama), lalu buka Adhit Office dari ikon itu dan aktifkan di sana.';
    case 'unsupported':
      return 'Tidak didukung browser ini. Pakai Chrome/Edge di Android, atau aplikasi Layar Utama di iPhone (iOS 16.4+).';
    case 'denied':
      return 'Ditolak browser — izinkan notifikasi untuk situs ini di pengaturan browser, lalu coba lagi.';
    case 'ready':
      return subscribed ? 'Aktif di HP ini.' : 'Belum aktif di HP ini.';
    default:
      return '';
  }
}

/** The hint on an http page: where push works (the https Tailscale origin), with its address when known. */
export function httpsHint(httpsUrl) {
  const url = typeof httpsUrl === 'string' && /^https:\/\/[^\s/]+(:\d+)?\/?$/.test(httpsUrl) ? httpsUrl.replace(/\/$/, '') : '';
  return url
    ? { text: 'Buka lewat', url, after: '(Tailscale) untuk notifikasi push.' }
    : { text: 'Notifikasi push hanya lewat HTTPS Tailscale (https://<nama-laptop>:4318), yang belum aktif di laptop.', url: '', after: '' };
}

/**
 * The per-device settings the server applies before pushing (same rules as notifyPlan in notify-rules.js).
 * `notify` = cleanNotifySettings(...) of this device. 🔔 off on this device = no push (events all off, enabled false).
 * tzOffsetMin: minutes EAST of UTC (Jakarta = 420), i.e. -Date#getTimezoneOffset(); `tz` (IANA) when known.
 */
export function pushSettings(notify, { on = true, favorites = [], tzOffsetMin = 0, tz = '', lockscreenAllow = true } = {}) {
  const events = {};
  for (const kind of ['ask', 'done', 'error', 'queue']) {
    const e = notify?.events?.[kind] ?? { popup: true, sound: true };
    events[kind] = { popup: Boolean(on && e.popup), sound: Boolean(on && e.sound) };
  }
  const q = notify?.quiet ?? {};
  return {
    enabled: Boolean(on),
    events,
    quiet: { enabled: Boolean(q.enabled), from: q.from ?? '22:00', to: q.to ?? '07:00', allowAsk: q.allowAsk !== false },
    favoritesOnly: Boolean(notify?.favoritesOnly),
    muted: Object.fromEntries(Object.entries(notify?.muted ?? {}).filter(([id, on]) => on === true && typeof id === 'string' && id).slice(0, 500)),
    favorites: [...new Set((favorites ?? []).filter((id) => typeof id === 'string' && id))].sort(),
    volume: Number.isFinite(notify?.volume) ? notify.volume : 100,
    tzOffsetMin: Number.isFinite(tzOffsetMin) ? Math.round(tzOffsetMin) : 0,
    ...(tz ? { tz } : {}),
    lockscreenAllow: lockscreenAllow !== false,
  };
}

/** `?p=<project>&ap=<approvalId>` from a notification tap → { project, approvalId } (null when absent). */
export function parseDeepLink(search) {
  let params;
  try {
    params = new URLSearchParams(search ?? '');
  } catch {
    return null;
  }
  const project = (params.get('p') ?? '').slice(0, 200);
  if (!project) return null;
  return { project, approvalId: (params.get('ap') ?? '').slice(0, 200) };
}

/** The URL without the deep-link parameters (kept: everything else, the hash). */
export function stripDeepLink(href) {
  const url = new URL(href);
  url.searchParams.delete('p');
  url.searchParams.delete('ap');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The chat message (id) holding the card of `approvalId` in a project's chat, or null. */
export function approvalMessageId(chat, approvalId) {
  if (!approvalId || !Array.isArray(chat)) return null;
  for (let i = chat.length - 1; i >= 0; i--) if (chat[i]?.approvalId === approvalId) return chat[i].id ?? null;
  return null;
}

/**
 * The laptop's toast when an approval was answered from a phone notification (null otherwise).
 * answeredBy: { via: 'push', device? } (a WiFi viewer gets no device name).
 */
export function answeredByText(approval) {
  const by = approval?.answeredBy;
  if (!by || by.via !== 'push' || approval.status === 'pending') return null;
  const verb = approval.status === 'allowed' ? 'Diizinkan' : approval.status === 'denied' ? 'Ditolak' : 'Dijawab';
  const device = typeof by.device === 'string' ? by.device.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return `${verb} dari HP${device ? ` (${device})` : ''} lewat notifikasi.`;
}

/** base64url (VAPID public key) → Uint8Array for pushManager.subscribe({ applicationServerKey }). */
export function b64urlToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Same bytes? (an existing subscription made with another VAPID key must be renewed) */
export function sameKey(a, b) {
  if (!a || !b) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
