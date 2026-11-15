// WhatsApp Web inside the server process, through baileys (the only WhatsApp transport: the PIN message goes through
// this link too).
//
// One socket, the QR that pairs it, sending the access PIN to the owner's own number, and unlinking. Three rules
// shape this file:
//   • The QR is a session credential. It goes to the caller (the laptop-only /api/wa/* route) and nowhere else —
//     never into a log line, never into an error message.
//   • One socket per process. link() is idempotent and shares an in-flight attempt; a socket that closes is retried
//     with a rising delay (5 times at most) unless the phone unlinked this device, in which case the session on disk
//     is useless and gets wiped.
//   • status() never throws: the settings page polls it exactly when the network is down.
import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { WaAuthStoreError } from './wa-auth-store.js';

/** A QR older than a minute is not worth scanning any more; the socket keeps rotating new ones. */
export const QR_TTL_MS = 60_000;
/**
 * A phone that is offline never answers `logout()`. "Lepas" must still delete the session on disk (the privacy doc
 * promises exactly that) and the route gives up at 5 s, so the goodbye gets 3 s and the wipe runs regardless.
 */
export const LOGOUT_TIMEOUT_MS = 3_000;
const MAX_RETRIES = 5;
const RETRY_CAP_MS = 30_000;

// baileys logs a line per stanza at info level, JIDs and message metadata included. Silence it instead of piping that
// into the app log; the link's own state is what the UI needs.
const SILENT_LOGGER = {
  level: 'silent',
  child: () => SILENT_LOGGER,
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};

export class WaLinkError extends Error {
  /**
   * @param {'not_linked'|'send_failed'} code
   * @param {string} message Indonesian text safe to show in the UI (never carries credentials)
   */
  constructor(code, message) {
    super(message);
    this.name = 'WaLinkError';
    this.code = code;
  }
}

/**
 * Our own id carries the device WhatsApp registered us on (`628…:12@s.whatsapp.net`). baileys relays the JID exactly
 * as given, so a message addressed to that string is accepted by the server and never shows up on the phone.
 * The user JID (`628…@s.whatsapp.net`) is what a chat with ourselves needs. Never leaks a credential: it is our own
 * number, already shown by the settings card.
 * @param {string} jid
 * @returns {string} `user@server`, or '' when the id is not a JID
 */
const userJidOf = (jid) => {
  const [userPart = '', server = ''] = String(jid ?? '').split('@');
  const user = userPart.split(':')[0];
  return user && server ? `${user}@${server}` : '';
};

/**
 * The shape the existing /pair page and its status endpoint already speak (public/js/pair.js), so the route can stay
 * dumb: linked → connected, qr/connecting → qr_ready/connecting, off → disconnected.
 * @param {{ state: 'off'|'qr'|'connecting'|'linked' }} status
 * @returns {{ configured: boolean, status: 'connected'|'qr_ready'|'connecting'|'disconnected' }}
 */
export function pairStatus(status) {
  switch (status?.state) {
    case 'linked':
      return { configured: true, status: 'connected' };
    case 'qr':
      return { configured: true, status: 'qr_ready' };
    case 'connecting':
      return { configured: true, status: 'connecting' };
    default:
      return { configured: false, status: 'disconnected' };
  }
}

export class WaLink {
  #store;
  #socketFactory;
  #qrToDataUrl;
  #now;
  #onChange;
  #retryBaseMs;
  #logoutTimeoutMs;
  #state = 'off';
  #qr = null;
  #qrAt = 0;
  #qrSeq = 0;
  #qrWork = Promise.resolve();
  #qrTimer = null;
  #creds = null;
  #socket = null;
  #starting = null;
  #unlinking = null;
  #attempt = 0;
  #timer = null;
  #stopping = false;
  #generation = 0;
  #lastError = null;
  #published;

  /**
   * @param {object} options
   * @param {import('./wa-auth-store.js').EncryptedAuthStore} options.store the encrypted session on disk
   * @param {Function} [options.socketFactory] baileys' makeWASocket; tests inject a fake (never a real socket)
   * @param {(qr: string) => string|Promise<string>} [options.qrToDataUrl] PNG data URL for the QR text
   * @param {() => number} [options.now]
   * @param {(status: { state: string, qr: string|null, me: object|null }) => void} [options.onChange] called on every
   *   status change, for `hub.broadcast('wa', status)`
   * @param {number} [options.retryBaseMs] first reconnect delay; doubles per attempt up to 30 s
   * @param {number} [options.logoutTimeoutMs] how long `unlink()` waits for the phone before wiping anyway
   */
  constructor({
    store,
    socketFactory = makeWASocket,
    qrToDataUrl,
    now = Date.now,
    onChange = () => {},
    retryBaseMs = 1_000,
    logoutTimeoutMs = LOGOUT_TIMEOUT_MS,
  } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.wipe !== 'function') {
      throw new TypeError('WaLink butuh store sesi (EncryptedAuthStore).');
    }
    this.#store = store;
    this.#socketFactory = socketFactory;
    this.#qrToDataUrl = qrToDataUrl ?? ((qr) => QRCode.toDataURL(qr, { margin: 1, width: 240 }));
    this.#now = now;
    this.#onChange = onChange;
    this.#retryBaseMs = retryBaseMs;
    this.#logoutTimeoutMs = logoutTimeoutMs;
    this.#published = this.#signature();
  }

  /** The last failure in safe Indonesian wording (no credentials), or null. */
  get lastError() {
    return this.#lastError;
  }

  /**
   * What the settings page shows. `state: 'qr'` keeps `qr: null` once the image is older than a minute, because the
   * socket is still rotating new codes and the page should keep waiting rather than fall back to "off".
   * Never throws.
   * @returns {Promise<{ state: 'off'|'qr'|'connecting'|'linked', qr: string|null,
   *   me: { number: string, name: string }|null }>}
   */
  async status() {
    try {
      return this.#snapshot();
    } catch {
      return { state: this.#state, qr: null, me: null };
    }
  }

  /**
   * Opens the socket (idempotent: never a second one) and returns the status as it stands, which is `connecting`
   * until baileys emits the first QR. While a reconnect is already scheduled this does nothing: that pending attempt
   * is the socket, and opening another one here would leave two connections on the same credentials.
   * @returns {Promise<{ state: 'off'|'qr'|'connecting'|'linked', qr: string|null, me: object|null }>}
   */
  async link() {
    // Never open a socket on credentials that are being deleted: wait for a running unlink() to finish wiping.
    if (this.#unlinking) await this.#unlinking.catch(() => {});
    if (this.#socket || this.#timer) return this.status();
    if (!this.#starting) {
      this.#starting = (async () => {
        try {
          await this.#connect();
        } finally {
          this.#starting = null;
        }
      })();
    }
    try {
      await this.#starting;
    } catch (err) {
      this.#fail(err);
      throw err;
    }
    return this.status();
  }

  /**
   * Tells the phone this device is gone, closes the socket and deletes the session (key included). The deletion does
   * not depend on the phone answering: `logout()` is bounded, and `wipe()` runs in `finally`.
   * @returns {Promise<void>}
   */
  async unlink() {
    // `off` first, with the socket forgotten: a page that calls link() right after pressing "Lepas" must not start a
    // login on the credentials that are about to disappear (link() waits on #unlinking below).
    this.#stopping = true;
    this.#generation += 1;
    this.#clearTimer();
    const sock = this.#socket;
    this.#socket = null;
    this.#creds = null;
    this.#dropQr();
    this.#state = 'off';
    this.#attempt = 0;
    this.#lastError = null;
    this.#publish();
    const work = (async () => {
      try {
        // An offline phone may never answer: 3 s, then the wipe below is what actually unlinks.
        await this.#bounded(() => sock?.logout?.(), this.#logoutTimeoutMs);
      } catch {
        // Not connected is the common case here: the wipe below is what actually unlinks.
      } finally {
        try {
          await sock?.end?.(undefined);
        } catch {
          // Already closed.
        }
        await this.#store.wipe();
        this.#publish();
      }
    })();
    this.#unlinking = work;
    try {
      await work;
    } finally {
      if (this.#unlinking === work) this.#unlinking = null;
    }
  }

  /** Closes the socket without touching the session (server shutdown). */
  stop() {
    this.#stopping = true;
    this.#generation += 1;
    this.#clearTimer();
    const sock = this.#socket;
    this.#socket = null;
    this.#creds = null;
    this.#dropQr();
    this.#state = 'off';
    if (sock) {
      try {
        void Promise.resolve(sock.end?.(undefined)).catch(() => {});
      } catch {
        // Already closed.
      }
    }
    this.#publish();
  }

  /**
   * Sends one text to the linked account itself (`creds.me.id`, device suffix stripped): the PIN message must arrive
   * on the owner's phone, and the app never messages anyone else.
   * @param {string} text
   * @returns {Promise<{ ok: true }>}
   * @throws {WaLinkError} `not_linked` when there is no session yet, `send_failed` when baileys rejects the send
   */
  async sendText(text) {
    const body = typeof text === 'string' ? text : String(text ?? '');
    if (body.trim() === '') throw new WaLinkError('send_failed', 'Pesan WhatsApp kosong.');
    const jid = userJidOf(this.#creds?.me?.id);
    const sock = this.#socket;
    if (!jid || !sock || this.#state !== 'linked') {
      throw new WaLinkError('not_linked', 'WhatsApp belum tertaut. Tautkan lewat QR dari laptop terlebih dahulu.');
    }
    try {
      await sock.sendMessage(jid, { text: body });
    } catch {
      // baileys errors can carry the message body or JIDs; the UI only needs the fact.
      throw new WaLinkError('send_failed', 'Pesan WhatsApp gagal dikirim. Periksa koneksi lalu coba lagi.');
    }
    return { ok: true };
  }

  async #connect() {
    // One socket, one attempt: a timer that fires late (or a link() racing the retry) must never orphan the current
    // socket and open a second login on the same credentials.
    if (this.#socket) return;
    this.#clearTimer();
    this.#stopping = false;
    const generation = ++this.#generation;
    const { state, saveCreds } = await this.#store.load();
    // unlink()/stop() may have run while the session was loading: that socket must never be opened.
    if (this.#stopping || generation !== this.#generation) return;
    this.#creds = state.creds;
    if (this.#state !== 'linked') this.#state = 'connecting';
    const sock = this.#socketFactory({
      auth: state,
      logger: SILENT_LOGGER,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });
    this.#socket = sock;
    // A socket from a previous attempt must never change the state of the current one.
    sock.ev.on('creds.update', () => {
      if (this.#socket !== sock) return;
      void Promise.resolve()
        .then(() => saveCreds())
        .catch(() => {})
        .finally(() => this.#publish()); // the push name arrives this way: the page should show it without a reload
    });
    sock.ev.on('connection.update', (update) => {
      if (this.#socket !== sock) return;
      this.#onConnection(update);
    });
    this.#publish();
  }

  /** `connection.update` → the four states. */
  #onConnection(update) {
    if (!update || typeof update !== 'object') return;
    const { connection, qr, lastDisconnect } = update;
    if (qr && this.#state !== 'linked') {
      this.#dropQr();
      this.#state = 'qr';
      this.#qrAt = this.#now();
      this.#lastError = null; // a fresh code means the connection is alive again: do not leave the old failure on screen
      this.#publish();
      // Converting to a PNG takes a tick; a burst of QR rotations must not let an older image win.
      const seq = ++this.#qrSeq;
      this.#qrWork = this.#qrWork
        .then(async () => {
          let url = null;
          try {
            const converted = await this.#qrToDataUrl(qr);
            url = typeof converted === 'string' && converted.trim() !== '' ? converted : null;
          } catch {
            // The converter failed; the state stays 'qr' with no image and the page waits for the next code.
          }
          if (seq !== this.#qrSeq || this.#state !== 'qr') return;
          this.#qr = url;
          if (url) {
            this.#qrAt = this.#now();
            this.#scheduleQrExpiry();
          }
          this.#publish();
        })
        .catch(() => {}); // terminal catch: one bad conversion must not poison the queue for every later QR
    }
    if (connection === 'open') {
      this.#attempt = 0;
      this.#dropQr();
      this.#state = 'linked';
      this.#lastError = null;
      this.#publish();
    } else if (connection === 'close') {
      this.#onClose(lastDisconnect);
    }
  }

  #onClose(lastDisconnect) {
    const sock = this.#socket;
    this.#socket = null;
    if (sock) {
      try {
        // A dead socket still holds a websocket and timers: close it for real instead of leaving it orphaned.
        void Promise.resolve(sock.end?.(undefined)).catch(() => {});
      } catch {
        // Already closed.
      }
    }
    this.#dropQr();
    const code = lastDisconnect?.error?.output?.statusCode;
    if (code === DisconnectReason.loggedOut) {
      // The phone revoked this device: the credentials on disk can never connect again, so drop them too.
      this.#attempt = 0;
      this.#state = 'off';
      this.#creds = null;
      this.#lastError = 'Sesi WhatsApp dicabut dari HP. Tautkan ulang dengan memindai QR dari laptop.';
      this.#publish();
      void Promise.resolve()
        .then(() => this.#store.wipe())
        .catch(() => {});
      return;
    }
    this.#scheduleRetry();
  }

  /** Rising delay, at most MAX_RETRIES; a broken store is not retried (only an unlink can fix it). */
  #scheduleRetry(error) {
    if (this.#stopping) return;
    if (error instanceof WaAuthStoreError) {
      this.#attempt = 0;
      this.#state = 'off';
      this.#creds = null;
      this.#lastError = error.message;
      this.#publish();
      return;
    }
    if (this.#attempt >= MAX_RETRIES) {
      this.#state = 'off';
      this.#creds = null;
      this.#lastError = 'Koneksi WhatsApp terputus. Periksa jaringan di laptop lalu tautkan ulang.';
      this.#publish();
      return;
    }
    this.#attempt += 1;
    this.#state = 'connecting';
    this.#lastError = 'Koneksi WhatsApp terputus. Menyambung ulang…';
    this.#publish();
    const wait = Math.min(this.#retryBaseMs * 2 ** (this.#attempt - 1), RETRY_CAP_MS);
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#connect().catch((err) => this.#scheduleRetry(err));
    }, wait);
    // A pending reconnect must not keep the process (or a test runner) alive.
    this.#timer.unref?.();
  }

  /** link() itself failed: no socket was usable, so report it instead of pretending to reconnect. */
  #fail(err) {
    this.#socket = null;
    this.#dropQr();
    this.#state = 'off';
    this.#attempt = 0;
    this.#creds = null;
    this.#lastError = err instanceof WaAuthStoreError ? err.message : 'Tidak bisa memulai WhatsApp. Coba lagi.';
    this.#publish();
  }

  #clearTimer() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * Runs `run` with a deadline. The deadline resolves (never rejects), so the caller's cleanup still runs; whatever
   * `run` was doing is abandoned in the background (its rejection is not left unhandled).
   * @template T
   * @param {() => Promise<T>|T|undefined} run
   * @param {number} ms
   * @returns {Promise<T|void>}
   */
  async #bounded(run, ms) {
    const attempt = Promise.resolve().then(run);
    attempt.catch(() => {}); // abandoned after a timeout: swallow so it never becomes an unhandled rejection
    let timer;
    const deadline = new Promise((resolve) => {
      // The timer must keep the loop alive: the caller is awaiting this race, so an unref'd timer lets node exit
      // first (the runner then reports "Promise resolution is still pending" and the await never settles).
      timer = setTimeout(resolve, ms);
    });
    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Forgets the QR image and cancels any pending conversion/expiry, so a stale code can never come back. */
  #dropQr() {
    this.#qrSeq += 1;
    this.#qr = null;
    this.#qrAt = 0;
    if (this.#qrTimer) clearTimeout(this.#qrTimer);
    this.#qrTimer = null;
  }

  /** Publishes the moment the image turns a minute old, so a page that only listens for events drops it too. */
  #scheduleQrExpiry() {
    if (this.#qrTimer) clearTimeout(this.#qrTimer);
    const wait = Math.max(0, this.#qrAt + QR_TTL_MS - this.#now());
    this.#qrTimer = setTimeout(() => {
      this.#qrTimer = null;
      if (this.#state !== 'qr') return;
      this.#publish();
    }, wait);
    this.#qrTimer.unref?.();
  }

  /** The QR only counts while it is younger than QR_TTL_MS; the state stays 'qr' because new codes keep coming. */
  #freshQr() {
    return this.#qr && this.#now() - this.#qrAt < QR_TTL_MS ? this.#qr : null;
  }

  #snapshot() {
    return { state: this.#state, qr: this.#freshQr(), me: this.#me() };
  }

  #me() {
    const id = this.#creds?.me?.id;
    if (!id) return null;
    const number = String(id).split('@')[0].split(':')[0];
    return { number, name: String(this.#creds.me.name ?? '') };
  }

  /** What the listeners care about; a repeated 'connecting' with the same error is not a new status. */
  #signature() {
    const me = this.#me();
    return [this.#state, this.#freshQr() ?? '', me?.number ?? '', me?.name ?? '', this.#lastError ?? ''].join('|');
  }

  #publish() {
    const signature = this.#signature();
    if (signature === this.#published) return;
    this.#published = signature;
    let status;
    try {
      status = this.#snapshot();
    } catch {
      return;
    }
    try {
      this.#onChange(status);
    } catch {
      // A broken listener (a closed websocket, say) must never break the socket.
    }
  }
}
