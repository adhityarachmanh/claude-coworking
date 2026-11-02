// ♪ Spotify: now-playing and a few controls for the Spotify Connect devices the user already has, through the
// Spotify Web API, called from this server only (docs/design-spotify.md). No HTTP server here and no access to the
// hub: everything it needs is injected, so tests run it against test-support/fake-spotify.mjs.
//
// Secrets: the access/refresh tokens live only in this object and in data/spotify.json (mode 0600, never in the
// backup, never sent to a browser). publicState() is the filtered view every browser gets (SSE `spotify`).
// Logs use a fixed format, `Spotify: <aksi> gagal (<status>/<code>)`: never a token, code, verifier or body.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SPOTIFY_SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'playlist-read-private'];
export const DEFAULT_ACCOUNTS_ORIGIN = 'https://accounts.spotify.com';
export const DEFAULT_API_ORIGIN = 'https://api.spotify.com';
/** CDN hosts album/playlist art may come from (https only). Anything else gets no art (placeholder). */
export const ART_HOSTS = new Set(['i.scdn.co', 'mosaic.scdn.co', 'image-cdn-ak.spotifycdn.com', 'image-cdn-fa.spotifycdn.com']);
export const DUCK_MODES = ['off', 'duck', 'pause'];

const CLIENT_ID = /^[0-9a-f]{32}$/i;
const DEVICE_ID = /^[\w-]{1,128}$/;
const PLAYLIST_ID = /^[A-Za-z0-9]{22}$/;
const ART_ID = /^[0-9a-f]{16}$/;
const MAX_JSON = 1024 * 1024;
const MAX_TOKEN_JSON = 64 * 1024;
const MAX_IMAGE = 512 * 1024;
const MAX_TEXT = 200;
const MAX_ART_URLS = 200;
const MAX_ART_BYTES = 20;
const PLAYLIST_PAGE = 50;
const MIN_ART_PX = 128;
const MAX_PLAYLIST_OFFSET = 5000;
const MAX_RETRY_AFTER_S = 3600; // a longer Retry-After is capped: the poller retries hourly at worst
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout fires at once (1 ms) for anything larger
/** Text from Spotify (or an error) made safe for one log line: no spaces, newlines or control characters. */
const logSafe = (v) => String(v ?? '').replace(/[^\w.-]/g, '_').slice(0, 40) || '_';
/** Blocks this thread for a few ms (a retried rename only; never on a hot path). */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const DEFAULT_TIMING = Object.freeze({
  playMs: 5000, // playing: poll at most this often (or at the end of the song)
  pausedMs: 20000, // paused / no device
  idleMs: 60000, // paused for idleAfterMs without any change
  idleAfterMs: 10 * 60_000,
  backoffMs: [5000, 10000, 20000, 40000, 120000], // network / 5xx
  requestMs: 8000, // every Web API / image request
  tokenMs: 10000, // token exchange and refresh
  stateFreshMs: 2000, // POST /state polls only when the data is older than this
  afterWriteMs: [400, 1500], // polls after a control (Spotify's state lags behind)
  volumeGapMs: 300, // at most one volume request per this
  duckRestoreMs: 1500, // debounce before restoring after the last approval
  flowTtlMs: 10 * 60_000, // a login link stays valid this long
  cacheMs: 5 * 60_000, // devices / playlists known to control()
  launchWaitMs: 20_000, // after starting the desktop app: wait at most this long for its Connect device
  launchPollMs: 1000, // …polling /me/player/devices this often
  launchGapMs: 30_000, // never start the app more than once per this
  playRetries: 2, // a just-found device may refuse the first play for a moment: this many retries, launchPollMs apart
});

const ERROR_TEXT = {
  unconfigured: 'Spotify belum diatur. Isi Client ID di ⚙ Pengaturan (laptop).',
  disconnected: 'Spotify belum terhubung. Hubungkan dari laptop (⚙ Pengaturan).',
  revoked: 'Akses Spotify dicabut atau kedaluwarsa. Hubungkan lagi dari laptop.',
  'no-device': 'Tidak ada perangkat aktif. Buka Spotify di HP/PC lalu pilih di sini.',
  premium: 'Butuh Spotify Premium untuk kontrol.',
  restricted: 'Perangkat ini tidak bisa dikendalikan dari sini.',
  'rate-limited': 'Dibatasi Spotify sementara. Coba lagi nanti.',
  network: 'Spotify tidak bisa dihubungi. Coba lagi sebentar.',
  'bad-request': 'Permintaan tidak valid.',
  'not-found': 'Tidak ditemukan.',
  'no-app': 'Spotify belum terpasang di laptop ini. Pasang Spotify, atau buka Spotify di HP/PC lain lalu pilih di sini.',
  'launch-timeout': 'Spotify dibuka di laptop tapi belum siap. Tunggu sebentar lalu tekan ▶ lagi.',
  'pick-device': 'Ada beberapa perangkat. Pilih salah satu di ♪ Musik, atau tandai ★ Selalu putar di sini.',
};

export class SpotifyError extends Error {
  /**
   * @param {string} code one of ERROR_TEXT's keys
   * @param {{ message?: string, status?: number, until?: number, retryAfter?: number }} [o] status = Spotify's HTTP status (for logs)
   */
  constructor(code, { message, status = 0, until, retryAfter } = {}) {
    super(message ?? ERROR_TEXT[code] ?? ERROR_TEXT.network);
    this.code = code;
    this.status = status;
    if (until) {
      this.until = until;
      this.retryAfter = Math.max(1, retryAfter ?? 1);
    }
  }
}

// ---------- PKCE (RFC 7636) ----------

/** A fresh code_verifier: 64 random bytes as base64url = 86 chars of [A-Za-z0-9_-] (RFC 7636: 43–128). */
export const newVerifier = () => randomBytes(64).toString('base64url');
/** code_challenge for S256: base64url(sha256(verifier)), no padding. */
export const pkceChallenge = (verifier) => createHash('sha256').update(verifier, 'ascii').digest('base64url');

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const clip = (s) => String(s ?? '').slice(0, MAX_TEXT);
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
/** The remembered "play here" device from data/spotify.json, or null. Its id never reaches publicState(). */
const cleanPreferred = (p) => (p && typeof p === 'object' && typeof p.id === 'string' && DEVICE_ID.test(p.id) ? { id: p.id, name: clip(p.name), type: clip(p.type).toLowerCase() } : null);

/** The image kind from its first bytes (never trust Content-Type alone). */
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Reads a response body, aborting once it passes `max` bytes (a huge or endless body is a network error). */
async function readCapped(res, max) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new SpotifyError('network', { status: res.status });
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new SpotifyError('network', { status: res.status });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const parseJson = (buf) => {
  if (!buf.length) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
};

export class SpotifyService {
  /**
   * @param {object} o
   * @param {string} o.file                 data/spotify.json
   * @param {string} o.redirectUri          http://127.0.0.1:<PORT>/spotify/callback
   * @param {() => number} [o.viewers]      open event streams (hub.clients.size); 0 = no polling
   * @param {(state: object) => void} [o.onChange] → hub.broadcast('spotify', state)
   * @param {string} [o.envClientId]        SPOTIFY_CLIENT_ID (fallback when the file has none)
   * @param {string} [o.accountsOrigin]
   * @param {string} [o.apiOrigin]
   * @param {Set<string>} [o.artHosts]      host[:port] art may be fetched from
   * @param {typeof fetch} [o.fetch]
   * @param {() => number} [o.now]
   * @param {Partial<typeof DEFAULT_TIMING>} [o.timing]
   * @param {(msg: string) => void} [o.log]
   * @param {{ launch: () => Promise<{ strategy: string }>, minimize?: (strategy: string) => Promise<boolean> } | null} [o.launcher]
   *        starts the Spotify desktop app in the background (src/spotify-launcher.js); null = never (default, tests)
   * @param {string} [o.hostname]           this laptop's name (Spotify names its desktop device after it)
   */
  constructor(o) {
    this.file = o.file;
    this.redirectUri = o.redirectUri;
    this.viewers = o.viewers ?? (() => 0);
    this.onChange = o.onChange ?? (() => {});
    this.envClientId = CLIENT_ID.test(String(o.envClientId ?? '')) ? String(o.envClientId).toLowerCase() : '';
    this.accountsOrigin = new URL(o.accountsOrigin ?? DEFAULT_ACCOUNTS_ORIGIN).origin;
    this.apiOrigin = new URL(o.apiOrigin ?? DEFAULT_API_ORIGIN).origin;
    this.artHosts = new Set(o.artHosts ?? ART_HOSTS);
    this.fetchImpl = o.fetch ?? globalThis.fetch;
    this.now = o.now ?? Date.now;
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
    this.log = o.log ?? ((msg) => console.log(msg));
    this.launcher = o.launcher ?? null;
    this.hostname = String(o.hostname ?? os.hostname()).toLowerCase();

    this.data = this.#load();
    this.flow = null; // { state, verifier, returnOrigin, expiresAt } (memory only)
    this.flowTimer = null;
    this.player = null; // last /me/player, mapped (device keeps its id here, never in publicState)
    this.error = null; // { code, message, until? }
    this.premium = false; // a control answered PREMIUM_REQUIRED (sticky until the next login)
    this.blockedUntil = 0; // 429: no request to Spotify before this
    this.lastPollAt = 0;
    this.lastChangeAt = this.now();
    this.updatedAt = 0;
    this.failures = 0;
    this.timer = null;
    this.burstTimers = new Set();
    this.polling = null;
    this.refreshing = null;
    this.lastSent = null;
    this.lastLog = '';
    this.stopped = false;
    this.artUrls = new Map(); // artId -> url (only from Spotify's answers)
    this.artBytes = new Map(); // artId -> { type, bytes } (LRU)
    this.artInflight = new Map(); // artId -> Promise (one download per id at a time)
    this.lastLogin = null; // { returnOrigin, at } of the last successful callback (its ?done=ok page)
    this.deviceCache = { at: 0, ids: new Set(), info: new Map() }; // info: id -> { name, type }
    this.launching = false; // the desktop app is being started (publicState().launching)
    this.launchRun = null; // the one launch-and-wait in flight
    this.lastLaunchAt = -Infinity;
    this.playlistCache = new Map(); // offset -> { at, page }
    this.playlistIds = new Map(); // id -> at
    this.volumePending = null;
    this.volumeRun = null;
    this.lastVolumeAt = 0;
    this.pending = 0; // approvals pending (duck)
    this.duck = null; // { mode, deviceName, prevVolume?, title? }
    this.duckTimer = null;
    this.duckChain = Promise.resolve();
  }

  // ---------- store: data/spotify.json ----------

  #defaults() {
    return { v: 1, clientId: '', settings: { office: true, duck: 'off', duckVolume: 20, autoLaunch: true }, preferredDevice: null, auth: null };
  }

  #load() {
    const data = this.#defaults();
    if (!this.file || !existsSync(this.file)) return data;
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object') throw new Error('not an object');
    } catch {
      // Unreadable: kept aside for the user, never parsed again; the content is not logged.
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* the next save overwrites it */
      }
      this.log?.('Spotify: data/spotify.json rusak, disimpan sebagai .corrupt-* (status: belum terhubung)');
      return data;
    }
    if (CLIENT_ID.test(String(raw.clientId ?? ''))) data.clientId = String(raw.clientId).toLowerCase();
    data.settings = this.#cleanSettings(raw.settings, data.settings);
    data.preferredDevice = cleanPreferred(raw.preferredDevice);
    const a = raw.auth;
    // Tokens are bound to the accounts origin that issued them: a token from another origin (a test fake, or the
    // real service while testing) is dropped, never sent anywhere.
    if (a && typeof a.accessToken === 'string' && typeof a.refreshToken === 'string' && Number.isFinite(a.expiresAt) && a.origin === this.accountsOrigin) {
      data.auth = { origin: a.origin, accessToken: a.accessToken, expiresAt: a.expiresAt, refreshToken: a.refreshToken, scope: String(a.scope ?? ''), displayName: a.displayName ? clip(a.displayName) : null };
    } else if (a) {
      queueMicrotask(() => this.#save());
    }
    return data;
  }

  #cleanSettings(input, base) {
    const s = { ...base };
    if (input && typeof input === 'object') {
      if (typeof input.office === 'boolean') s.office = input.office;
      if (DUCK_MODES.includes(input.duck)) s.duck = input.duck;
      if (intIn(input.duckVolume, 0, 50)) s.duckVolume = input.duckVolume;
      if (typeof input.autoLaunch === 'boolean') s.autoLaunch = input.autoLaunch;
    }
    return s;
  }

  /** Atomic write (temp file + rename), owner-only. */
  #save() {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    try {
      renameSync(tmp, this.file);
    } catch (err) {
      // Windows: a virus scanner or indexer may hold the file for a moment. One retry, then give up loudly.
      if (err.code !== 'EPERM' && err.code !== 'EBUSY') throw err;
      pause(50);
      renameSync(tmp, this.file);
    }
  }

  get clientId() {
    return this.data.clientId || this.envClientId;
  }

  get connected() {
    return Boolean(this.clientId && this.data.auth);
  }

  // ---------- lifecycle ----------

  start() {
    this.stopped = false;
    this.wake();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.flowTimer);
    clearTimeout(this.duckTimer);
    for (const t of this.burstTimers) clearTimeout(t);
    this.burstTimers.clear();
    this.timer = null;
  }

  /** A new event stream opened: poll now if nothing is scheduled (the poller sleeps without viewers). */
  wake() {
    if (this.stopped || !this.connected || this.timer || this.polling) return;
    this.#schedule(0);
  }

  // ---------- public views ----------

  /** What every browser may see (SSE `spotify`, snapshot, POST /state): no token, id, uri or account name. */
  publicState() {
    const p = this.player;
    let status;
    if (!this.clientId) status = 'unconfigured';
    else if (!this.data.auth) status = 'disconnected';
    else if (!p || !p.device) status = 'idle';
    else status = p.isPlaying ? 'playing' : 'paused';
    let error = this.error;
    if (!error && status !== 'unconfigured' && status !== 'disconnected') {
      if (p && !p.device) error = { code: 'no-device', message: ERROR_TEXT['no-device'] };
      else if (p?.device?.restricted) error = { code: 'restricted', message: ERROR_TEXT.restricted };
      else if (this.premium) error = { code: 'premium', message: ERROR_TEXT.premium };
    }
    if (status === 'unconfigured' || (status === 'disconnected' && error?.code !== 'revoked')) error = null;
    const live = status !== 'unconfigured' && status !== 'disconnected';
    const d = live ? p?.device : null;
    return {
      status,
      error: error ? { ...error } : null,
      track: live && p?.track ? { ...p.track } : null,
      progressMs: live ? (p?.progressMs ?? 0) : 0,
      at: live ? (p?.at ?? 0) : 0,
      device: d ? { name: d.name, type: d.type, volume: d.volume, supportsVolume: d.supportsVolume } : null,
      office: this.data.settings.office,
      launching: live && this.launching,
      updatedAt: this.updatedAt,
    };
  }

  /** ⚙ Pengaturan (laptop only): never the Client ID itself, only its last 4 characters. */
  config() {
    const id = this.clientId;
    return {
      clientIdSet: Boolean(id),
      clientIdHint: id ? `…${id.slice(-4)}` : null,
      clientIdSource: this.data.clientId ? 'file' : this.envClientId ? 'env' : null,
      redirectUri: this.redirectUri,
      connected: this.connected,
      displayName: this.connected ? (this.data.auth.displayName ?? null) : null,
      settings: { ...this.data.settings },
    };
  }

  /**
   * Saves the Client ID and/or settings. A changed Client ID drops the login (its tokens belong to the old app).
   * @param {{ clientId?: string, settings?: object }} body
   * @param {{ settingsOnly?: boolean }} [o] settingsOnly: duck + autoLaunch only (POST /settings, phones on Tailscale)
   */
  setConfig(body, { settingsOnly = false } = {}) {
    const { clientId, settings } = body ?? {};
    if (settings !== undefined && (settings === null || typeof settings !== 'object' || Array.isArray(settings))) throw new SpotifyError('bad-request', { message: 'Pengaturan tidak valid.' });
    if (settings) {
      const allowed = settingsOnly ? ['duck', 'duckVolume', 'autoLaunch'] : ['office', 'duck', 'duckVolume', 'autoLaunch'];
      for (const [k, v] of Object.entries(settings)) {
        if (!allowed.includes(k)) throw new SpotifyError('bad-request', { message: `Pengaturan "${clip(k).slice(0, 40)}" tidak dikenal.` });
        const ok = k === 'office' || k === 'autoLaunch' ? typeof v === 'boolean' : k === 'duck' ? DUCK_MODES.includes(v) : intIn(v, 0, 50);
        if (!ok) throw new SpotifyError('bad-request', { message: k === 'duckVolume' ? 'Volume saat izin harus 0–50.' : `Nilai "${k}" tidak valid.` });
      }
    }
    let dropAuth = false;
    if (!settingsOnly && clientId !== undefined) {
      const next = String(clientId ?? '').trim().toLowerCase();
      if (next && !CLIENT_ID.test(next)) throw new SpotifyError('bad-request', { message: 'Client ID harus 32 karakter heksadesimal.' });
      if (!this.data.clientId && this.envClientId && next && next !== this.envClientId) throw new SpotifyError('bad-request', { message: 'Client ID diatur lewat SPOTIFY_CLIENT_ID (env); ubah di sana.' });
      if (next !== this.data.clientId) {
        dropAuth = this.clientId !== (next || this.envClientId);
        this.data.clientId = next;
      }
    }
    const before = JSON.stringify(this.data.settings);
    if (settings) this.data.settings = this.#cleanSettings(settings, this.data.settings);
    if (dropAuth) this.#dropAuth();
    if (dropAuth || JSON.stringify(this.data.settings) !== before || clientId !== undefined) this.#save();
    if (this.data.settings.duck === 'off') this.duck = null;
    this.#emit(true);
    return this.config();
  }

  // ---------- OAuth: Authorization Code + PKCE ----------

  /**
   * Starts a login: one flow at a time (a new one replaces the old), valid for timing.flowTtlMs.
   * @param {{ returnOrigin: string, switchAccount?: boolean }} o
   * @returns {{ url: string }}
   */
  startLogin({ returnOrigin, switchAccount = false }) {
    if (!this.clientId) throw new SpotifyError('unconfigured');
    const state = randomBytes(32).toString('base64url');
    const verifier = newVerifier();
    this.flow = { state, verifier, returnOrigin, expiresAt: this.now() + this.timing.flowTtlMs };
    clearTimeout(this.flowTimer);
    this.flowTimer = setTimeout(() => (this.flow = null), this.timing.flowTtlMs);
    this.flowTimer.unref?.();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: SPOTIFY_SCOPES.join(' '),
      redirect_uri: this.redirectUri,
      state,
      code_challenge_method: 'S256',
      code_challenge: pkceChallenge(verifier),
    });
    if (switchAccount) params.set('show_dialog', 'true');
    return { url: `${this.accountsOrigin}/authorize?${params}` };
  }

  /**
   * The callback. Never throws. A wrong, used or expired state exchanges nothing (and keeps a pending flow, so a
   * forged link can't cancel the user's real login).
   * @returns {Promise<{ ok: true, returnOrigin: string } | { error: 'invalid-state'|'denied'|'exchange', returnOrigin: string|null }>}
   */
  async finishLogin({ code, state, error }) {
    const flow = this.flow;
    if (!flow || !state || flow.expiresAt <= this.now() || !sameSecret(state, flow.state)) return { error: 'invalid-state', returnOrigin: null };
    this.flow = null; // single use, whatever happens next
    clearTimeout(this.flowTimer);
    const { returnOrigin } = flow;
    if (error) return { error: 'denied', returnOrigin };
    if (!code || String(code).length > 2048) return { error: 'exchange', returnOrigin };
    try {
      const tok = await this.#tokenRequest({ grant_type: 'authorization_code', code: String(code), redirect_uri: this.redirectUri, client_id: this.clientId, code_verifier: flow.verifier }, 'login');
      if (!tok.refresh_token) throw new SpotifyError('network');
      this.data.auth = { origin: this.accountsOrigin, accessToken: tok.access_token, expiresAt: this.now() + tok.expires_in * 1000, refreshToken: tok.refresh_token, scope: clip(tok.scope ?? ''), displayName: null };
      this.#save();
    } catch {
      return { error: 'exchange', returnOrigin };
    }
    this.error = null;
    this.premium = false;
    this.player = null;
    this.failures = 0;
    try {
      const me = await this.#api('GET', '/me', { action: 'profil' });
      if (me?.display_name) {
        this.data.auth.displayName = clip(me.display_name);
        this.#save();
      }
    } catch {
      /* only shown in ⚙; the login itself worked */
    }
    this.#emit(true);
    clearTimeout(this.timer);
    this.timer = null;
    this.wake();
    this.lastLogin = { returnOrigin, at: this.now() };
    return { ok: true, returnOrigin };
  }

  /** Drops the tokens (Spotify has no revoke endpoint: the UI links to spotify.com/account/apps). Keeps the Client ID. */
  logout() {
    this.flow = null;
    this.#dropAuth();
    this.#save();
    this.#emit(true);
    return { ok: true };
  }

  #dropAuth() {
    this.data.auth = null;
    this.player = null;
    this.error = null;
    this.premium = false;
    this.duck = null;
    this.failures = 0;
    clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.burstTimers) clearTimeout(t);
    this.burstTimers.clear();
  }

  /** POST /api/token (form). 400 invalid_grant/invalid_client → 'revoked'; anything else unusable → 'network'. */
  async #tokenRequest(form, action) {
    const res = await this.#fetch(`${this.accountsOrigin}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      timeoutMs: this.timing.tokenMs,
      action,
    });
    const body = parseJson(await readCapped(res, MAX_TOKEN_JSON).catch(() => Buffer.alloc(0)));
    if (res.status === 400 || res.status === 401) {
      const code = ['invalid_grant', 'invalid_client'].includes(body?.error) ? 'revoked' : 'network';
      this.#logFail(action, res.status, code === 'revoked' ? body.error : 'error');
      throw new SpotifyError(code, { status: res.status });
    }
    if (res.status !== 200 || typeof body?.access_token !== 'string' || !Number.isFinite(body?.expires_in)) {
      this.#logFail(action, res.status, 'token');
      throw new SpotifyError('network', { status: res.status });
    }
    return body;
  }

  /** A valid access token, refreshed when it expires within 60 s. */
  async #accessToken({ force = false } = {}) {
    if (!this.clientId) throw new SpotifyError('unconfigured');
    if (!this.data.auth) throw new SpotifyError(this.error?.code === 'revoked' ? 'revoked' : 'disconnected');
    if (force || this.data.auth.expiresAt - this.now() < 60_000) await this.#refresh();
    return this.data.auth.accessToken;
  }

  /** Single-flight refresh: concurrent callers share one token request (itself bounded by timing.tokenMs). */
  #refresh() {
    if (this.refreshing) return this.refreshing;
    const auth = this.data.auth;
    this.refreshing = (async () => {
      try {
        const tok = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: this.clientId }, 'refresh');
        if (this.data.auth !== auth) throw new SpotifyError('disconnected'); // logged out meanwhile
        auth.accessToken = tok.access_token;
        auth.expiresAt = this.now() + tok.expires_in * 1000;
        if (typeof tok.refresh_token === 'string' && tok.refresh_token) auth.refreshToken = tok.refresh_token; // rotation
        if (tok.scope) auth.scope = clip(tok.scope);
        this.#save();
      } catch (err) {
        if (err.code === 'revoked' && this.data.auth === auth) {
          this.#dropAuth();
          this.error = { code: 'revoked', message: ERROR_TEXT.revoked };
          this.#save();
          this.#emit(true);
        }
        throw err;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  // ---------- outgoing requests ----------

  /** The one place that calls fetch: fixed origins only, no redirects, a timeout, and the global 429 block. */
  async #fetch(url, { method = 'GET', headers = {}, body, timeoutMs = this.timing.requestMs, action = 'request', image = false }) {
    const u = new URL(url);
    if (image) {
      const loopback = u.protocol === 'http:' && u.hostname === '127.0.0.1';
      if (!this.artHosts.has(u.host) || !(u.protocol === 'https:' || loopback)) throw new SpotifyError('not-found');
    } else {
      if (u.origin !== this.accountsOrigin && u.origin !== this.apiOrigin) throw new Error('Spotify: origin tidak diizinkan');
      if (this.blockedUntil > this.now()) throw this.#blocked();
    }
    let res;
    try {
      res = await this.fetchImpl(u.href, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      this.#logFail(action, 0, 'network');
      throw new SpotifyError('network');
    }
    if (res.status === 429 && !image) {
      const seconds = Number(res.headers.get('retry-after'));
      this.blockedUntil = this.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_S) : 30) * 1000;
      await res.body?.cancel().catch(() => {});
      this.error = { code: 'rate-limited', message: ERROR_TEXT['rate-limited'], until: this.blockedUntil };
      this.#logFail(action, 429, 'rate-limited');
      this.#emit();
      throw this.#blocked(429);
    }
    return res;
  }

  #blocked(status = 0) {
    return new SpotifyError('rate-limited', { status, until: this.blockedUntil, retryAfter: Math.ceil((this.blockedUntil - this.now()) / 1000) });
  }

  /**
   * A Web API call with the bearer token. 401 → one forced refresh and one retry. Returns parsed JSON, or null (204).
   * @param {string} method
   * @param {string} p path under /v1 (constant; ids are validated and encoded by the caller)
   */
  async #api(method, p, { query, json, action = 'api', retried = false } = {}) {
    const token = await this.#accessToken({ force: retried });
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const headers = { Authorization: `Bearer ${token}` };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.#fetch(`${this.apiOrigin}/v1${p}${qs}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), action });
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      if (retried) {
        this.#logFail(action, 401, 'revoked');
        throw new SpotifyError('revoked', { status: 401 });
      }
      return this.#api(method, p, { query, json, action, retried: true });
    }
    let buf;
    try {
      buf = await readCapped(res, MAX_JSON);
    } catch (err) {
      this.#logFail(action, res.status, 'network');
      throw err instanceof SpotifyError ? err : new SpotifyError('network');
    }
    if (res.status === 204 || (res.status >= 200 && res.status < 300 && !buf.length)) return null;
    const body = parseJson(buf);
    if (res.status >= 200 && res.status < 300) return body;
    const reason = body?.error?.reason;
    let code = 'network';
    if (res.status === 403) code = reason === 'PREMIUM_REQUIRED' ? 'premium' : 'restricted';
    else if (res.status === 404) code = reason === 'NO_ACTIVE_DEVICE' || p.startsWith('/me/player') ? 'no-device' : 'not-found';
    else if (res.status === 400) code = 'bad-request';
    this.#logFail(action, res.status, reason ?? code);
    throw new SpotifyError(code, { status: res.status });
  }

  /** One log line per distinct failure in a row (a dead network polled every few seconds is one line, not hundreds). */
  #logFail(action, status, code) {
    // `code` may come from a Spotify body (error reason): sanitised so it can never forge or break a log line.
    const line = `Spotify: ${action} gagal (${Number(status) || 0}/${logSafe(code)})`;
    if (line === this.lastLog) return;
    this.lastLog = line;
    this.log(line);
  }

  // ---------- polling ----------

  #schedule(ms) {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || !this.connected || this.viewers() <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#pollNow().catch(() => {});
    }, Number.isFinite(ms) ? Math.min(Math.max(0, ms), MAX_TIMER_MS) : this.timing.pausedMs);
    this.timer.unref?.();
  }

  /** Polls once (single-flight), then schedules the next poll from what it saw. Never throws. */
  #pollNow() {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      let next = null;
      try {
        if (this.blockedUntil > this.now()) return;
        await this.#pollPlayer();
        this.failures = 0;
        this.lastLog = '';
      } catch (err) {
        if (err.code === 'network') {
          const steps = this.timing.backoffMs;
          next = steps[Math.min(this.failures, steps.length - 1)];
          this.failures++;
          this.error = { code: 'network', message: ERROR_TEXT.network };
          this.#emit();
        } else if (err.code === 'no-device') {
          this.#setPlayer({ isPlaying: false, track: null, progressMs: 0, device: null });
        }
      } finally {
        this.polling = null;
        if (this.blockedUntil > this.now()) next = this.blockedUntil - this.now() + Math.floor(Math.random() * 2000);
        this.#schedule(next ?? this.#cadence());
      }
    })();
    return this.polling;
  }

  /** How long until the next poll, from the last state (docs/design-spotify.md §2.3). */
  #cadence() {
    const p = this.player;
    const t = this.timing;
    if (p?.isPlaying && p.track?.durationMs) {
      const left = p.track.durationMs - p.progressMs - (this.now() - p.at);
      return Math.max(250, Math.min(t.playMs, left + 750));
    }
    if (p?.isPlaying) return t.playMs;
    return this.now() - this.lastChangeAt > t.idleAfterMs ? t.idleMs : t.pausedMs;
  }

  async #pollPlayer() {
    const data = await this.#api('GET', '/me/player', { query: { additional_types: 'episode' }, action: 'status' });
    this.lastPollAt = this.now();
    this.updatedAt = this.lastPollAt;
    if (this.error && ['network', 'rate-limited', 'no-device', 'restricted', 'no-app', 'launch-timeout', 'pick-device'].includes(this.error.code)) this.error = null;
    if (!data || !data.device) return this.#setPlayer({ isPlaying: false, track: null, progressMs: 0, device: null });
    const d = data.device;
    const device = {
      id: typeof d.id === 'string' && DEVICE_ID.test(d.id) ? d.id : null,
      name: clip(d.name),
      type: clip(d.type).toLowerCase(),
      volume: intIn(d.volume_percent, 0, 100) ? d.volume_percent : null,
      supportsVolume: Boolean(d.supports_volume ?? true),
      restricted: Boolean(d.is_restricted),
    };
    if (device.id) this.#rememberDevice(device.id, device);
    this.#setPlayer({ isPlaying: Boolean(data.is_playing), track: this.#mapItem(data), progressMs: Number.isFinite(data.progress_ms) ? data.progress_ms : 0, device });
  }

  #mapItem(data) {
    const item = data.item;
    if (data.currently_playing_type === 'ad') return { kind: 'ad', title: 'Iklan', artists: '', album: '', artId: null, durationMs: Number(item?.duration_ms) || 0 };
    if (!item || typeof item !== 'object') return null;
    const durationMs = Number.isFinite(item.duration_ms) ? item.duration_ms : 0;
    if (item.type === 'episode') {
      return { kind: 'episode', title: clip(item.name), artists: clip(item.show?.name), album: '', artId: this.#artIdOf(item.images?.length ? item.images : item.show?.images), durationMs };
    }
    const artists = Array.isArray(item.artists) ? item.artists.map((a) => a?.name).filter(Boolean).join(', ') : '';
    return { kind: 'track', title: clip(item.name), artists: clip(artists), album: clip(item.album?.name), artId: this.#artIdOf(item.album?.images), durationMs };
  }

  /** Stores the new state and broadcasts if something a viewer would notice changed. */
  #setPlayer(next) {
    const prev = this.player;
    next.at = this.now();
    const sig = (p) => JSON.stringify(p ? [p.isPlaying, p.track, p.device && { ...p.device, id: undefined }] : null);
    if (sig(prev) !== sig(next)) this.lastChangeAt = next.at;
    this.player = next;
    this.lastPollAt = next.at;
    this.updatedAt = next.at;
    this.#emit();
  }

  /** Broadcasts publicState() when it differs from the last one sent (progress only on a jump of > 3 s). */
  #emit(force = false) {
    const s = this.publicState();
    const prev = this.lastSent;
    const key = (x) => JSON.stringify({ ...x, progressMs: 0, at: 0, updatedAt: 0 });
    let changed = force || !prev || key(prev) !== key(s);
    if (!changed && s.status === 'playing') {
      const expected = prev.progressMs + (s.at - prev.at);
      changed = Math.abs(s.progressMs - expected) > 3000;
    } else if (!changed) changed = Math.abs(s.progressMs - prev.progressMs) > 3000;
    if (!changed) return;
    this.lastSent = s;
    try {
      this.onChange(s);
    } catch (err) {
      this.log(`Spotify: broadcast gagal (0/${logSafe(err?.name)})`);
    }
  }

  /** POST /api/spotify/state: the cached state, refreshed first when older than timing.stateFreshMs (coalesced). */
  async refreshState() {
    if (this.connected && this.now() - this.lastPollAt >= this.timing.stateFreshMs && this.blockedUntil <= this.now()) await this.#pollNow();
    return this.publicState();
  }

  /** Polls after a write: once at once-ish (awaited, the answer carries it) and once more later. */
  async #afterWrite() {
    const [first, ...later] = this.timing.afterWriteMs;
    // Debounced: a burst of controls (next, next, next) leaves one pending follow-up poll, not one per control.
    for (const t of this.burstTimers) clearTimeout(t);
    this.burstTimers.clear();
    for (const ms of later) {
      const t = setTimeout(() => {
        this.burstTimers.delete(t);
        this.#pollNow().catch(() => {});
      }, ms);
      t.unref?.();
      this.burstTimers.add(t);
    }
    await sleep(first ?? 0);
    await this.#pollNow();
  }

  // ---------- devices, playlists, control ----------

  #rememberDevice(id, info) {
    if (this.now() - this.deviceCache.at > this.timing.cacheMs) this.deviceCache = { at: this.now(), ids: new Set(), info: new Map() };
    this.deviceCache.ids.add(id);
    if (info) this.deviceCache.info.set(id, { name: clip(info.name), type: clip(info.type).toLowerCase() });
  }

  /** POST /devices: the user's Connect devices (★ = the remembered one). Device ids go to controllers only (never over WiFi). */
  async devices() {
    const data = await this.#api('GET', '/me/player/devices', { action: 'perangkat' });
    const list = (Array.isArray(data?.devices) ? data.devices : []).filter((d) => typeof d?.id === 'string' && DEVICE_ID.test(d.id));
    const pref = this.data.preferredDevice;
    const devices = list.map((d) => ({
      id: d.id,
      name: clip(d.name),
      type: clip(d.type).toLowerCase(),
      active: Boolean(d.is_active),
      volume: intIn(d.volume_percent, 0, 100) ? d.volume_percent : null,
      supportsVolume: Boolean(d.supports_volume ?? true),
      restricted: Boolean(d.is_restricted),
      preferred: d.id === pref?.id,
    }));
    this.deviceCache = { at: this.now(), ids: new Set(devices.map((d) => d.id)), info: new Map(devices.map((d) => [d.id, { name: d.name, type: d.type }])) };
    return { devices, preferred: pref ? { name: pref.name, type: pref.type, available: devices.some((d) => d.preferred) } : null };
  }

  /** Remembers the device the user last played on (★); null forgets it. Written only when it changed. */
  #setPreferred(id, info) {
    if (id === null) {
      if (!this.data.preferredDevice) return;
      this.data.preferredDevice = null;
      this.#save();
      return;
    }
    const known = this.deviceCache.info.get(id);
    const next = cleanPreferred({ id, name: info?.name ?? known?.name, type: info?.type ?? known?.type });
    const prev = this.data.preferredDevice;
    if (!next || (prev && prev.id === next.id && prev.name === next.name && prev.type === next.type)) return;
    this.data.preferredDevice = next;
    this.#save();
  }

  /** POST /playlists: the user's playlists, 50 per page, cached 5 minutes. */
  async playlists({ offset = 0 } = {}) {
    if (!intIn(offset, 0, MAX_PLAYLIST_OFFSET) || offset % PLAYLIST_PAGE !== 0) throw new SpotifyError('bad-request', { message: 'offset tidak valid.' });
    // Stale pages and ids are dropped (both maps stay bounded: ≤ 101 pages of ≤ 50 ids, each kept ≤ cacheMs).
    const fresh = (at) => this.now() - at < this.timing.cacheMs;
    for (const [k, v] of this.playlistCache) if (!fresh(v.at)) this.playlistCache.delete(k);
    for (const [k, at] of this.playlistIds) if (!fresh(at)) this.playlistIds.delete(k);
    const hit = this.playlistCache.get(offset);
    if (hit && this.now() - hit.at < this.timing.cacheMs) return hit.page;
    const data = await this.#api('GET', '/me/playlists', { query: { limit: String(PLAYLIST_PAGE), offset: String(offset) }, action: 'playlist' });
    const items = [];
    for (const p of Array.isArray(data?.items) ? data.items : []) {
      if (typeof p?.id !== 'string' || !PLAYLIST_ID.test(p.id)) continue;
      this.playlistIds.set(p.id, this.now());
      // Feb 2026 API change: the playlist's `tracks` object is now `items` (both read).
      const total = Number(p.items?.total ?? p.tracks?.total);
      items.push({ id: p.id, name: clip(p.name), tracks: Number.isFinite(total) ? total : 0, artId: this.#artIdOf(p.images) });
    }
    const page = { items, next: data?.next ? offset + PLAYLIST_PAGE : null };
    this.playlistCache.set(offset, { at: this.now(), page });
    return page;
  }

  #knownDevice(id) {
    return typeof id === 'string' && DEVICE_ID.test(id) && this.now() - this.deviceCache.at <= this.timing.cacheMs && this.deviceCache.ids.has(id);
  }

  #knownPlaylist(id) {
    if (typeof id !== 'string' || !PLAYLIST_ID.test(id)) return false;
    const at = this.playlistIds.get(id);
    return at !== undefined && this.now() - at <= this.timing.cacheMs;
  }

  /**
   * POST /control. Validated here; ids must come from the last devices/playlists answer, URIs are built here.
   * Never retried (a doubled "next" is worse than a failed one), except the 401 → refresh path and a device that
   * was only just found (play/playlist without an active device, docs/design-spotify.md §2.8).
   * @param {object} body
   * @param {{ allowLaunch?: boolean }} [o] allowLaunch: the request comes from the laptop or a Tailscale phone
   *        (server.js decides); only then may ▶ start the desktop app.
   */
  async control(body, { allowLaunch = false } = {}) {
    const action = body?.action;
    let played = null; // { id, info? }: the device a play/transfer went to (remembered as ★)
    const run = async () => {
      switch (action) {
        case 'play':
          played = await this.#playSomewhere({ allowLaunch });
          return;
        case 'pause':
          return this.#api('PUT', '/me/player/pause', { action: 'pause' });
        case 'next':
        case 'previous':
          return this.#api('POST', `/me/player/${action}`, { action });
        case 'volume': {
          if (!intIn(body.volume, 0, 100)) throw new SpotifyError('bad-request', { message: 'Volume harus 0–100.' });
          return this.#setVolume(body.volume);
        }
        case 'transfer': {
          if (!this.#knownDevice(body.deviceId)) throw new SpotifyError('bad-request', { message: 'Perangkat tidak dikenal. Muat ulang daftar perangkat.' });
          if (body.play !== undefined && typeof body.play !== 'boolean') throw new SpotifyError('bad-request');
          const json = { device_ids: [body.deviceId] };
          if (body.play !== undefined) json.play = body.play;
          await this.#api('PUT', '/me/player', { json, action: 'pindah perangkat' });
          played = { id: body.deviceId };
          return;
        }
        case 'playlist': {
          if (!this.#knownPlaylist(body.playlistId)) throw new SpotifyError('bad-request', { message: 'Playlist tidak dikenal. Muat ulang daftar playlist.' });
          if (body.deviceId !== undefined && !this.#knownDevice(body.deviceId)) throw new SpotifyError('bad-request', { message: 'Perangkat tidak dikenal. Muat ulang daftar perangkat.' });
          if (body.deviceId) {
            await this.#playOn(body.deviceId, body.playlistId, 0);
            played = { id: body.deviceId };
          } else played = await this.#playSomewhere({ playlistId: body.playlistId, allowLaunch });
          return;
        }
        default:
          throw new SpotifyError('bad-request', { message: 'Aksi tidak dikenal.' });
      }
    };
    if (!this.clientId) throw new SpotifyError('unconfigured');
    if (!this.data.auth) throw new SpotifyError('disconnected');
    if (action === 'prefer') {
      // "Selalu putar di sini" (★): only remembered, nothing is sent to Spotify. deviceId null forgets it.
      if (body.deviceId !== null && !this.#knownDevice(body.deviceId)) throw new SpotifyError('bad-request', { message: 'Perangkat tidak dikenal. Muat ulang daftar perangkat.' });
      this.#setPreferred(body.deviceId);
      return this.publicState();
    }
    try {
      await run();
    } catch (err) {
      if (err.code === 'premium' && !this.premium) {
        this.premium = true;
        this.#emit();
      }
      throw err;
    }
    await this.#afterWrite();
    // ★ follows the last device played on: the one we sent it to, else what Spotify now reports as active.
    if (action === 'play' || action === 'playlist' || action === 'transfer') {
      const active = this.player?.device;
      if (played?.id) this.#setPreferred(played.id, played.info);
      else if (active?.id) this.#setPreferred(active.id, active);
    }
    return this.publicState();
  }

  /**
   * ▶ (or a playlist) without a device chosen by the user. With an active device: plain play. Without one: the only
   * available device, else the ★ device, else (laptop/Tailscale, setting on) the desktop app started in the
   * background. Returns the device it went to ({ id, info }), or null (the active one).
   */
  async #playSomewhere({ playlistId = null, allowLaunch }) {
    if (this.player?.device) {
      try {
        await this.#playOn(null, playlistId, 0);
        return null;
      } catch (err) {
        if (err.code !== 'no-device') throw err; // the device went away since the last poll: pick one below
      }
    }
    const target = await this.#pickDevice({ allowLaunch });
    await this.#playOn(target?.id ?? null, playlistId, target ? this.timing.playRetries : 0);
    return target ? { id: target.id, info: target } : null;
  }

  /**
   * One play request: on `deviceId` (transfer + play, or the playlist there) or on the active device (null).
   * `retries`: a device that just appeared may answer 404 for a moment; bounded retries, launchPollMs apart.
   */
  async #playOn(deviceId, playlistId, retries) {
    for (let attempt = 0; ; attempt++) {
      try {
        if (playlistId) {
          return await this.#api('PUT', '/me/player/play', { query: deviceId ? { device_id: deviceId } : undefined, json: { context_uri: `spotify:playlist:${playlistId}` }, action: 'putar playlist' });
        }
        if (deviceId) return await this.#api('PUT', '/me/player', { json: { device_ids: [deviceId], play: true }, action: 'pindah perangkat' });
        return await this.#api('PUT', '/me/player/play', { action: 'play' });
      } catch (err) {
        if (attempt >= retries || !['no-device', 'not-found'].includes(err.code)) throw err;
        await sleep(this.timing.launchPollMs);
      }
    }
  }

  /** The device to play on when none is active (null: one is active after all). Throws when there is none. */
  async #pickDevice({ allowLaunch }) {
    const { devices } = await this.devices();
    if (devices.some((d) => d.active)) return null;
    const usable = devices.filter((d) => !d.restricted);
    if (usable.length === 1) return usable[0];
    const pref = this.data.preferredDevice;
    const preferred = pref && usable.find((d) => d.id === pref.id);
    if (preferred) return preferred;
    const refuse = () => new SpotifyError(usable.length ? 'pick-device' : 'no-device');
    // Launch only when there is nothing to play on, or the ★ device is a computer (this laptop) not running Spotify.
    if (usable.length && pref?.type !== 'computer') throw refuse();
    if (!allowLaunch || !this.launcher || !this.data.settings.autoLaunch || this.stopped) throw refuse();
    return this.#launchAndWait(devices);
  }

  /**
   * Starts the desktop app (at most once per launchGapMs) and waits, bounded, for this laptop's Connect device.
   * Single-flight: a second ▶ meanwhile shares the same wait. publicState().launching is true throughout.
   */
  #launchAndWait(before) {
    if (this.launchRun) return this.launchRun;
    this.launchRun = (async () => {
      this.launching = true;
      if (['no-app', 'launch-timeout', 'pick-device', 'no-device'].includes(this.error?.code)) this.error = null;
      this.#emit(true);
      try {
        let strategy = null;
        if (this.now() - this.lastLaunchAt >= this.timing.launchGapMs) {
          this.lastLaunchAt = this.now();
          try {
            ({ strategy } = await this.launcher.launch());
          } catch (err) {
            const code = err?.code === 'unsupported' ? 'no-device' : 'no-app';
            this.#logFail('buka aplikasi', 0, code);
            throw new SpotifyError(code);
          }
          this.log(`Spotify: aplikasi dibuka di latar belakang (${logSafe(strategy)})`);
        }
        // Within launchGapMs of the last launch: no second start, only the (bounded) wait for its device.
        const known = new Set(before.map((d) => d.id));
        const deadline = this.now() + this.timing.launchWaitMs;
        // Bounded twice: by the deadline and by a poll count (a frozen clock can't make it spin forever).
        const maxPolls = Math.ceil(this.timing.launchWaitMs / Math.max(1, this.timing.launchPollMs)) + 1;
        for (let i = 0; i < maxPolls && this.now() < deadline && !this.stopped && this.data.auth; i++) {
          await sleep(this.timing.launchPollMs);
          let list;
          try {
            ({ devices: list } = await this.devices());
          } catch (err) {
            if (err.code === 'network') continue; // one lost poll; the deadline still holds
            throw err; // 429 (the global block), revoked, …: stop waiting
          }
          const found = this.#laptopDevice(list, known);
          if (found) {
            if (strategy) Promise.resolve(this.launcher.minimize?.(strategy)).catch(() => {});
            return found;
          }
        }
        throw new SpotifyError('launch-timeout');
      } catch (err) {
        if (err instanceof SpotifyError && ['no-app', 'launch-timeout'].includes(err.code)) this.error = { code: err.code, message: err.message };
        throw err;
      } finally {
        this.launching = false;
        this.launchRun = null;
        this.#emit(true);
      }
    })();
    return this.launchRun;
  }

  /** This laptop's Spotify device in a fresh list: the ★ computer, one named after this host, or a new computer. */
  #laptopDevice(list, known) {
    const usable = list.filter((d) => !d.restricted);
    const pref = this.data.preferredDevice;
    return (
      (pref?.type === 'computer' && usable.find((d) => d.id === pref.id)) ||
      usable.find((d) => d.type === 'computer' && d.name.toLowerCase() === this.hostname) ||
      usable.find((d) => d.type === 'computer' && !known.has(d.id)) ||
      (known.size === 0 && usable.length === 1 ? usable[0] : null)
    );
  }

  /** Volume: the last request wins, at most one call per timing.volumeGapMs (a dragged slider is a few calls, not 50). */
  #setVolume(volume) {
    this.volumePending = volume;
    if (this.volumeRun) return this.volumeRun;
    this.volumeRun = (async () => {
      try {
        // Bounded: each round takes the pending value; callers arriving meanwhile only overwrite it.
        while (this.volumePending !== null) {
          const wait = this.lastVolumeAt + this.timing.volumeGapMs - this.now();
          if (wait > 0) await sleep(wait);
          const value = this.volumePending;
          this.volumePending = null;
          this.lastVolumeAt = this.now();
          await this.#api('PUT', '/me/player/volume', { query: { volume_percent: String(value) }, action: 'volume' });
          if (this.player?.device) this.player.device.volume = value;
        }
      } finally {
        this.volumePending = null;
        this.volumeRun = null;
      }
    })();
    return this.volumeRun;
  }

  // ---------- album art proxy ----------

  /**
   * artId for the smallest image ≥ MIN_ART_PX from an allowlisted CDN host; null otherwise (placeholder).
   * Spotify sends 640/300/64 px: this picks 300 (sharp in the 96 px dialog on a 2x screen, 64 px would blur).
   */
  #artIdOf(images) {
    if (!Array.isArray(images) || !images.length) return null;
    const ok = images.filter((i) => typeof i?.url === 'string' && this.#artUrlAllowed(i.url));
    if (!ok.length) return null;
    const size = (i) => (Number.isFinite(i.width) ? i.width : 300);
    const big = ok.filter((i) => size(i) >= MIN_ART_PX).sort((a, b) => size(a) - size(b));
    const url = (big[0] ?? ok.sort((a, b) => size(b) - size(a))[0]).url;
    const id = createHash('sha256').update(url).digest('hex').slice(0, 16);
    this.artUrls.delete(id);
    this.artUrls.set(id, url);
    while (this.artUrls.size > MAX_ART_URLS) this.artUrls.delete(this.artUrls.keys().next().value);
    return id;
  }

  #artUrlAllowed(url) {
    try {
      const u = new URL(url);
      return this.artHosts.has(u.host) && (u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1'));
    } catch {
      return false;
    }
  }

  /** POST /art {id}: image bytes for an artId seen in a Spotify answer. Validated by type and magic bytes. */
  async art(id) {
    if (typeof id !== 'string' || !ART_ID.test(id)) throw new SpotifyError('bad-request', { message: 'id gambar tidak valid.' });
    const cached = this.artBytes.get(id);
    if (cached) {
      this.artBytes.delete(id);
      this.artBytes.set(id, cached);
      return cached;
    }
    const url = this.artUrls.get(id);
    if (!url) throw new SpotifyError('not-found', { message: 'Gambar tidak dikenal.' });
    // Single-flight per id: ten tabs opening at once share one download.
    let inflight = this.artInflight.get(id);
    if (!inflight) {
      inflight = this.#downloadArt(id, url).finally(() => this.artInflight.delete(id));
      this.artInflight.set(id, inflight);
    }
    return inflight;
  }

  async #downloadArt(id, url) {
    const res = await this.#fetch(url, { image: true, action: 'gambar' });
    const declared = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (res.status !== 200 || !['image/jpeg', 'image/png', 'image/webp'].includes(declared)) {
      await res.body?.cancel().catch(() => {});
      this.#logFail('gambar', res.status, 'type');
      throw new SpotifyError('not-found', { message: 'Gambar tidak tersedia.' });
    }
    const bytes = await readCapped(res, MAX_IMAGE);
    if (sniffImage(bytes) !== declared) {
      this.#logFail('gambar', res.status, 'magic');
      throw new SpotifyError('not-found', { message: 'Gambar tidak tersedia.' });
    }
    const entry = { type: declared, bytes };
    this.artBytes.set(id, entry);
    while (this.artBytes.size > MAX_ART_BYTES) this.artBytes.delete(this.artBytes.keys().next().value);
    return entry;
  }

  // ---------- "kecilkan saat izin" (duck on approval) ----------

  /**
   * hub observer for `approval` events. 0 → ≥1 pending: duck or pause (if playing); ≥1 → 0: restore after a
   * debounce, but only if the user changed nothing meanwhile.
   * @param {string} type broadcast type (only 'approval' counts)
   * @param {object} data the approval (unused)
   * @param {number} pending approvals pending now (hub.approvals.size)
   */
  observeApproval(type, data, pending) {
    if (type !== 'approval' || !Number.isInteger(pending)) return;
    const was = this.pending;
    this.pending = pending;
    if (pending > 0) {
      clearTimeout(this.duckTimer);
      this.duckTimer = null;
      if (was === 0) this.#chain(() => this.#duckStart());
    } else if (was > 0) {
      clearTimeout(this.duckTimer);
      this.duckTimer = setTimeout(() => {
        this.duckTimer = null;
        this.#chain(() => this.#duckRestore());
      }, this.timing.duckRestoreMs);
      this.duckTimer.unref?.();
    }
  }

  /** Duck steps run one after another (a restore never overtakes its duck). Errors are logged, never thrown. */
  #chain(fn) {
    this.duckChain = this.duckChain.then(fn).catch((err) => this.#logFail('kecilkan musik', err?.status ?? 0, err?.code ?? 'error'));
    return this.duckChain;
  }

  async #duckStart() {
    const mode = this.data.settings.duck;
    if (mode === 'off' || !this.connected || this.duck || this.stopped) return;
    const p = this.player;
    if (!p?.isPlaying || !p.device) return;
    if (mode === 'duck') {
      const target = this.data.settings.duckVolume;
      // No volume control on this device: do nothing (not a surprise pause).
      if (!p.device.supportsVolume || p.device.volume === null || p.device.volume <= target) return;
      this.duck = { mode, deviceName: p.device.name, prevVolume: p.device.volume };
      await this.#setVolume(target);
    } else {
      this.duck = { mode, deviceName: p.device.name, title: p.track?.title ?? null };
      await this.#api('PUT', '/me/player/pause', { action: 'jeda musik' });
      p.isPlaying = false;
    }
    this.#emit();
  }

  async #duckRestore() {
    const saved = this.duck;
    this.duck = null;
    if (!saved || !this.connected || this.pending > 0 || this.stopped) {
      if (saved && this.pending > 0) this.duck = saved; // a new approval arrived meanwhile: stay ducked
      return;
    }
    await this.#pollPlayer().catch(() => {}); // fresh state: did the user touch anything?
    const p = this.player;
    if (!p?.device || p.device.name !== saved.deviceName) return;
    if (saved.mode === 'duck') {
      if (p.device.volume === this.data.settings.duckVolume) await this.#setVolume(saved.prevVolume);
    } else if (!p.isPlaying && (p.track?.title ?? null) === saved.title) {
      await this.#api('PUT', '/me/player/play', { action: 'lanjut musik' });
      p.isPlaying = true;
    }
    this.#emit();
  }
}
