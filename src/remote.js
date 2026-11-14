// Access from other devices on the same network (e.g. a phone), off by default.
// A device must be paired once — QR link or 6-digit code shown only on the laptop —
// and then carries a long random device token in an HttpOnly cookie. Only token hashes are stored.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import os from 'node:os';

const PAIRING_TTL_MS = 2 * 60 * 1000;
const MAX_TRIES = 5;
// Per remote IP, across pairing codes: this many wrong guesses lock that IP out for a while.
const IP_MAX_FAILURES = 5;
const IP_LOCKOUT_MS = 60 * 1000;
// Across all IPs (changing IP on a LAN is easy): too many wrong guesses pause pairing for everyone.
const GLOBAL_MAX_FAILURES = 20;
const GLOBAL_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_PAUSE_MS = 10 * 60 * 1000;
export const DEVICE_COOKIE = 'office_device';
// The https (Tailscale) origin's cookie: `__Host-` = Secure, no Domain, Path=/ (enforced by browsers).
export const HTTPS_DEVICE_COOKIE = '__Host-office_device';
// A device is bound to the transport it paired over: a token paired over https is refused over http (where it
// could be sniffed) and the other way round. Records from before HTTPS existed are 'http'.
const transportOf = (d) => (d.transport === 'https' ? 'https' : 'http');
const cleanTransport = (t) => (t === 'https' ? 'https' : 'http');
// A paired device unused this long is unpaired automatically (enforced here, whatever the cookie's Max-Age).
export const DEVICE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
// lastSeen only needs to be accurate to this for the idle rule, so a busy phone doesn't cause a disk write per request.
const LAST_SEEN_STEP_MS = 60 * 60 * 1000;
// Auto-pairing (no code, tailnet): every attempt mints a record, so a page on another site that keeps
// navigating to /pair must not grow the list without bound. The cap and the per-IP pace are the backstop;
// revoking a device (or idle pruning) frees a slot again, and the hour window ends on its own.
export const MAX_DEVICES = 20;
const AUTO_PAIR_MAX_PER_MINUTE = 5;
const AUTO_PAIR_MAX_PER_HOUR = 20;
const AUTO_PAIR_MINUTE_MS = 60 * 1000;
const AUTO_PAIR_HOUR_MS = 60 * 60 * 1000;

// ---------- what a phone on plain WiFi may do ----------

/** Shown when a phone on plain-HTTP WiFi tries anything beyond looking. */
export const READ_ONLY_ERROR = 'Lewat WiFi hanya bisa melihat. Pakai laptop atau Tailscale untuk mengirim perintah.';

// Allowlist (everything else is refused): reading the office, git changes, files, history (incl. search & .md export), usage.
// `file` (the file viewer) itself refuses likely secrets (.env, keys, credentials) to every device but the laptop.
// Anything that changes state or can run code (prompts, shell, settings, approvals, commit, rewind,
// MCP, tasks, projects, team names…) needs the laptop or Tailscale. Over plain HTTP the device
// cookie can be sniffed, so a WiFi phone must never be able to act.
// `/api/templates` lists the prompt templates (read); saving/deleting them (`/api/templates/save|delete`) is an action.
// `queue` shows a project's 📋 Antrian (read); every change to it (`queue-add|update|remove|reorder|pause|retry|clear|budget`) is an action.
// `git-branches` (branch list, ahead/behind) and `permissions` (saved permission rules) are reads; switching/pulling/
// pushing (`git-action`) is an action, and changing rules (`permissions-edit`) is laptop-only (LOCAL_ONLY_ACTION).
// Not over WiFi on purpose (security review): `search` / `export-session` expose the whole conversation history and
// `permissions` can hold exact commands (tokens included) — over sniffable HTTP that is too much; Tailscale only.
// `/api/team/roster` reads the active team + role catalog (👥 Kelola tim); saving it (`/api/team/roster/save`) is an action.
// `/api/files/search` is the same project file-name index as `.../files`, across projects (Ctrl+P); names only.
// `/api/queues` is the read-only global queue view (the same prompt texts each project's queue read already exposes).
// ♪ Spotify: only the now-playing state and its album art (already audible in the room). Devices and playlist names
// (personal data) and every control stay off sniffable WiFi (docs/design-spotify.md §2.1).
const WIFI_READ_GLOBAL = new Set(['/api/account', '/api/account/limits', '/api/report/accounts', '/api/report/summary', '/api/report/pdf', '/api/templates', '/api/team/roster', '/api/spotify/state', '/api/spotify/art', '/api/files/search', '/api/queues']);
const WIFI_READ_PROJECT = /^\/api\/projects\/[\w-]+\/(changes|diff|git-branches|file|files|sessions|rewind-points|task-output|task-detail|queue)$/;

/** True when a paired device on plain WiFi (read-only) may call this API path. */
export const wifiAllows = (pathname) => WIFI_READ_GLOBAL.has(pathname) || WIFI_READ_PROJECT.test(pathname);

/**
 * The same allowlist for the browser (snapshot `client.readOnlyApi`): the UI checks it before sending, so a
 * read-only phone never fires a request that would be refused. One source of truth; the server still enforces it.
 * `patterns` are RegExp sources (anchored), matched exactly like `wifiAllows` does.
 */
// Only the source travels to the browser, so a flag (e.g. /i) would silently not apply there: refuse to start.
if (WIFI_READ_PROJECT.flags) throw new Error('WIFI_READ_PROJECT must not use RegExp flags (they are not sent to the browser)');
export const WIFI_READ_API = Object.freeze({ paths: [...WIFI_READ_GLOBAL], patterns: [WIFI_READ_PROJECT.source] });

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-v|docker|virtualbox|vmware|vbox|br-|veth|virbr/i;
// An interface is Tailscale by its name only ("Tailscale" on Windows, tailscale0 on Linux). Its addresses come
// from 100.64.0.0/10, but so do the CGNAT addresses some office WiFi / phone hotspots hand out, so the IP alone
// never makes an interface "Tailscale".
const TAILSCALE_NAME = /tailscale/i;
// A tailnet peer's address (the client side of a Tailscale connection).
const TAILSCALE_IP = /^(::ffff:)?100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const plainIp = (ip) => String(ip ?? '').replace(/^::ffff:/, '');

/**
 * True when a connection came in through the laptop's Tailscale interface (encrypted WireGuard tunnel):
 * the laptop-side address (`req.socket.localAddress`, one listener per IP) belongs to an interface named
 * Tailscale, and the peer has a tailnet address. A 100.x address on WiFi stays plain WiFi.
 */
export function isTailscaleConnection(localAddress, remoteAddress) {
  if (!TAILSCALE_IP.test(String(remoteAddress ?? ''))) return false;
  const local = plainIp(localAddress);
  return networkAddresses().some((a) => a.ip === local && a.kind === 'tailscale');
}

/**
 * Addresses other devices can reach, best first:
 * WiFi/LAN (same network), Tailscale (from anywhere via your tailnet), then virtual adapters (WSL, Docker).
 * @returns {{ ip: string, kind: 'lan'|'tailscale'|'virtual', name: string }[]}
 */
export function networkAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const kind = TAILSCALE_NAME.test(name) ? 'tailscale' : VIRTUAL_ADAPTER.test(name) ? 'virtual' : 'lan';
      found.push({ ip: a.address, kind, name });
    }
  }
  const rank = { lan: 0, tailscale: 1, virtual: 2 };
  return found.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** Every IP the phone listener binds to and answers for. */
export const lanAddresses = () => networkAddresses().map((a) => a.ip);

function deviceName(userAgent = '') {
  const os = /iPhone/.test(userAgent) ? 'iPhone' : /iPad/.test(userAgent) ? 'iPad' : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows' : /Mac OS/.test(userAgent) ? 'Mac' : 'Perangkat';
  const browser = /EdgA?\//.test(userAgent) ? 'Edge' : /CriOS|Chrome\//.test(userAgent) ? 'Chrome' : /FxiOS|Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'browser';
  return `${os} · ${browser}`;
}

/** Last use of a device (pairing time if it was never seen after that). */
const lastActive = (d) => d.lastSeen ?? d.created ?? 0;
const isIdle = (d, now) => now - lastActive(d) > DEVICE_IDLE_MS;

export class RemoteAccess {
  /**
   * @param {object} hub
   * @param {{ onExpire?: (devices: object[]) => void, onNewCode?: (info: { code: string, expiresAt: number }) => void }} [options]
   *   onExpire: devices just unpaired for being idle (the server ends their event streams, like a manual revoke).
   *   onNewCode: a BRAND-NEW pairing code was made (never on a cached read); the only channel the code may leave
   *   this class through (server.js pushes it to the owner's paired phones). Rate limiting stays here untouched.
   */
  constructor(hub, { onExpire, onNewCode } = {}) {
    this.hub = hub;
    this.onExpire = onExpire ?? (() => {});
    this.onNewCode = onNewCode ?? (() => {});
    this.holdNewCode = false; // rotatePairing({ announce: false }) silences the hook for one code
    hub.persisted.remote ??= { enabled: false, devices: [] };
    this.pairing = null;
    this.failures = new Map(); // remote ip -> { count, until } (wrong pairing guesses)
    this.recentFailures = []; // timestamps of wrong guesses from any IP (last GLOBAL_WINDOW_MS)
    this.autoPairAttempts = new Map(); // remote ip -> timestamps of auto-pairings (last AUTO_PAIR_HOUR_MS)
    this.pausedUntil = 0;
  }

  /** Seconds pairing stays paused after too many wrong guesses overall (0 = open). */
  pausedFor() {
    const left = this.pausedUntil - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  get state() {
    return this.hub.persisted.remote;
  }

  get enabled() {
    return this.state.enabled;
  }

  setEnabled(enabled) {
    this.state.enabled = Boolean(enabled);
    this.pairing = null;
    this.hub.save();
  }

  /**
   * Pasang otomatis dari perangkat tailnet (feature B): a device of the laptop owner's own tailnet user
   * arriving over the https listener pairs without the code. Default true; a state from before the
   * setting existed (no key) counts as true.
   */
  get autoPairTailnet() {
    return this.state.autoPairTailnet !== false;
  }

  setAutoPairTailnet(on) {
    this.state.autoPairTailnet = Boolean(on);
    this.hub.save();
  }

  /** Current one-time pairing secrets (rotated after use, expiry or too many wrong codes). */
  currentPairing() {
    if (!this.pairing || Date.now() > this.pairing.expires) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const expires = Date.now() + PAIRING_TTL_MS;
      this.pairing = {
        code,
        key: randomBytes(18).toString('base64url'),
        expires,
        tries: 0,
      };
      // Only for a fresh code: a repeated get() with the cache still alive fires nothing (no push spam).
      if (!this.holdNewCode) this.onNewCode({ code, expiresAt: expires });
    }
    return this.pairing;
  }

  /**
   * Kills the current code and makes a new one right away (the laptop's "send it to my phone" button).
   * `announce: false`: the caller pushes the fresh code itself (route /api/pairing/code/push, so the laptop
   * learns pushed/skipped for its toast) instead of the onNewCode hook.
   */
  rotatePairing({ announce = true } = {}) {
    this.pairing = null;
    this.holdNewCode = !announce;
    const p = this.currentPairing();
    this.holdNewCode = false;
    return p;
  }

  /** Seconds this IP must still wait after too many wrong codes (0 = may try). */
  lockedFor(ip) {
    const entry = this.failures.get(ip);
    const left = entry?.until ? entry.until - Date.now() : 0;
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /** Counts a wrong guess from `ip`; the IP is locked out after IP_MAX_FAILURES of them. */
  recordFailure(ip) {
    const now = Date.now();
    if (this.failures.size > 1000) for (const [k, v] of this.failures) if (!v.until || v.until < now) this.failures.delete(k); // bounded memory
    const entry = this.failures.get(ip) ?? { count: 0, until: 0 };
    if (entry.until && entry.until < now) Object.assign(entry, { count: 0, until: 0 }); // lockout served
    entry.count++;
    if (entry.count >= IP_MAX_FAILURES) Object.assign(entry, { count: 0, until: now + IP_LOCKOUT_MS });
    this.failures.set(ip, entry);
    // Global budget: someone cycling IPs still runs out of guesses.
    this.recentFailures = this.recentFailures.filter((t) => now - t < GLOBAL_WINDOW_MS);
    this.recentFailures.push(now);
    if (this.recentFailures.length > GLOBAL_MAX_FAILURES) {
      this.recentFailures = [];
      this.pausedUntil = now + GLOBAL_PAUSE_MS;
      this.pairing = null;
      this.hub.broadcast('pairing-paused', { until: this.pausedUntil });
    }
  }

  /**
   * @param {{ transport?: 'http'|'https' }} [options] the transport this pairing came in over (the token only works there)
   * @returns {{ token?: string, device?: object, error?: string, triesLeft?: number, retryAfter?: number }}
   *   device: the record just appended to state.devices (the server announces exactly this one to the other phones —
   *   no guess about "the last record": two pairings in the same moment must name their own device).
   */
  pair({ code, key }, userAgent, ip = '', { transport = 'http' } = {}) {
    if (!this.enabled) return { error: 'Akses dari perangkat lain sedang dimatikan.' };
    const paused = this.pausedFor();
    if (paused) return { error: `Pairing dijeda karena terlalu banyak percobaan salah. Coba lagi dalam ${Math.ceil(paused / 60)} menit.`, retryAfter: paused };
    const wait = this.lockedFor(ip);
    if (wait) return { error: `Terlalu banyak percobaan salah dari perangkat ini. Coba lagi dalam ${wait} detik.`, retryAfter: wait };
    const p = this.pairing;
    if (!p || Date.now() > p.expires) return { error: 'Kode sudah kedaluwarsa. Minta kode baru di laptop (⚙ → Akses dari HP).' };
    const ok = key ? sameSecret(key, p.key) : sameSecret(String(code ?? '').replace(/\D/g, ''), p.code);
    if (!ok) {
      p.tries++;
      this.recordFailure(ip);
      if (this.pausedFor()) return { error: 'Terlalu banyak percobaan salah. Pairing dijeda 10 menit.', retryAfter: this.pausedFor() };
      if (p.tries >= MAX_TRIES) {
        this.pairing = null;
        // The laptop still shows the dead code: tell it to fetch a new one right away.
        this.hub.broadcast('pairing-reset', { ts: Date.now() });
        return { error: 'Terlalu banyak percobaan salah. Kode diganti — lihat kode baru di laptop.' };
      }
      return { error: 'Kode salah.', triesLeft: MAX_TRIES - p.tries };
    }
    this.failures.delete(ip);
    this.pairing = null; // single use
    const token = randomBytes(32).toString('base64url');
    const device = { id: randomUUID(), hash: sha256(token), name: deviceName(userAgent), created: Date.now(), lastSeen: Date.now(), transport: cleanTransport(transport) };
    this.state.devices.push(device);
    this.hub.save();
    return { token, device };
  }

  /**
   * Pasang otomatis (no code) for a device of the laptop owner's own tailnet user arriving over the
   * https listener (server.js calls this only after the tailnet identity check in src/tailnet.js):
   * the tailnet login proves who it is, so there is nothing to guess — the code and its rate limiting
   * (per-IP lockout, global pause) do not apply, and no failure is recorded. The current pairing code
   * stays alive: it was not used, and the screen may still be waiting for another device.
   * Same record shape, transport binding and persistence as a successful pair().
   *
   * Bounded on purpose (security review): a page on another site can navigate a phone to /pair, so a
   * record is only minted while the list is below MAX_DEVICES and this IP has not auto-paired
   * AUTO_PAIR_MAX_PER_MINUTE times in the last minute / AUTO_PAIR_MAX_PER_HOUR times in the last hour.
   * A refused attempt changes nothing (existing records stay valid; revoke still frees a slot).
   * @param {string} name device display name (the tailnet hostname, see src/tailnet.js)
   * @param {{ transport?: 'http'|'https', ip?: string, now?: number }} [options] transport the token is
   *   bound to, the connecting address for the per-IP pace, and the clock (tests inject it)
   * @returns {{ token: string, device: object }|null} null when phone access is off, the list is full,
   *   or this IP is paced out
   */
  autoPair(name, { transport = 'http', ip = '', now = Date.now() } = {}) {
    if (!this.enabled) return null;
    if (this.state.devices.length >= MAX_DEVICES) return null;
    const key = String(ip ?? '');
    const attempts = (this.autoPairAttempts.get(key) ?? []).filter((t) => now - t < AUTO_PAIR_HOUR_MS);
    const lastMinute = attempts.filter((t) => now - t < AUTO_PAIR_MINUTE_MS).length;
    if (lastMinute >= AUTO_PAIR_MAX_PER_MINUTE || attempts.length >= AUTO_PAIR_MAX_PER_HOUR) {
      this.autoPairAttempts.set(key, attempts); // pruned, so a stale entry cannot live forever
      return null;
    }
    // Bounded memory, like the wrong-guess map: only entries with nothing recent are dropped.
    if (this.autoPairAttempts.size > 1000) {
      for (const [k, times] of this.autoPairAttempts) if (!times.length || now - times.at(-1) >= AUTO_PAIR_HOUR_MS) this.autoPairAttempts.delete(k);
    }
    attempts.push(now);
    this.autoPairAttempts.set(key, attempts);
    const token = randomBytes(32).toString('base64url');
    const device = { id: randomUUID(), hash: sha256(token), name, created: now, lastSeen: now, transport: cleanTransport(transport) };
    this.state.devices.push(device);
    this.hub.save();
    return { token, device };
  }

  /**
   * The paired device for a cookie token, or null (also null once it sat unused for DEVICE_IDLE_MS, and null
   * when the request came over another transport than the pairing did).
   * @param {{ transport?: 'http'|'https' }} [options]
   */
  verify(token, { transport = 'http' } = {}) {
    if (!token || !this.enabled) return null;
    const hash = sha256(token);
    const device = this.state.devices.find((d) => sameSecret(d.hash, hash));
    if (!device || transportOf(device) !== cleanTransport(transport)) return null;
    const now = Date.now();
    if (isIdle(device, now)) {
      this.pruneIdle(now); // drops this one (and any other idle device) for good
      return null;
    }
    // Throttled: at most one (debounced) save per device per LAST_SEEN_STEP_MS.
    if (!(now - device.lastSeen < LAST_SEEN_STEP_MS)) {
      device.lastSeen = now;
      this.hub.scheduleSave();
    }
    return device;
  }

  /**
   * Unpairs every device unused for DEVICE_IDLE_MS (run at start, hourly, and from verify()).
   * @returns {object[]} the removed devices
   */
  pruneIdle(now = Date.now()) {
    const expired = this.state.devices.filter((d) => isIdle(d, now));
    if (!expired.length) return [];
    this.state.devices = this.state.devices.filter((d) => !isIdle(d, now));
    this.hub.save();
    const days = Math.round(DEVICE_IDLE_MS / 86_400_000);
    for (const d of expired) console.log(`Perangkat "${d.name}" dicabut otomatis: tidak aktif lebih dari ${days} hari`);
    this.onExpire(expired);
    return expired;
  }

  revoke(id) {
    this.state.devices = this.state.devices.filter((d) => d.id !== id);
    this.hub.save();
  }

  /** Safe to send to browsers: no token hashes. */
  publicInfo(port) {
    return {
      enabled: this.enabled,
      autoPairTailnet: this.autoPairTailnet,
      urls: this.enabled ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [],
      tailscale: networkAddresses().some((a) => a.kind === 'tailscale'),
      // push: 🔔 badge + "last push" (never the endpoint or keys); null = not subscribed
      devices: this.state.devices.map((d) => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen ?? d.created, transport: transportOf(d), push: d.push ? { since: d.push.created ?? null, lastOk: d.push.lastOk ?? null, failing: (d.push.failures ?? 0) > 0 } : null })),
      idleDays: Math.round(DEVICE_IDLE_MS / 86_400_000),
    };
  }
}

/**
 * The `config` event (and snapshot `.config`) for a read-only client on plain-HTTP WiFi (sniffable): without the
 * paired devices list (names are often a person's). Only the laptop's 📱 dialog shows that list.
 */
export function wifiConfig(config) {
  if (!config?.remote) return config;
  return { ...config, remote: { ...config.remote, devices: [] } };
}
