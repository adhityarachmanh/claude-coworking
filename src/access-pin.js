// The 6-digit access PIN that gates pairing a new phone, delivered over WhatsApp (src/wa-link.js).
//
// The PIN replaces "read the code off the laptop screen" for the case this app is built for: the PC sits at a
// Windows login screen in another room. A PIN is therefore a short-lived secret with a small, hard limit:
//   • 5 minutes of life, one use only (a second verify with the same PIN always fails);
//   • 3 wrong attempts burn it, so guessing costs the attacker a new PIN request the owner sees on WhatsApp;
//   • requesting is rate limited (1 per minute, 5 per hour overall, 3 per hour from one address), which is what
//     makes 3-attempts-per-PIN meaningful.
//
// Several PINs may be live at once (one per requesting browser): the cooldown is shorter than the 5-minute life, so
// a second request must never silently invalidate the message the owner is still reading. Each PIN is matched by the
// requester token of the browser that asked for it, so the old message stays usable and the new one works too.
//
// Two rules keep the PIN from being a weapon against the owner (both found by the security review):
//   • The PIN is bound to the device that asked for it. `request()` returns a requester token; only a `verify()`
//     carrying that token may consume an attempt or a use. Without it, anyone sharing the WiFi or the tailnet could
//     burn a live PIN with three wrong digits in under a second — for free, without ever reading the message.
//   • Wrong digits are counted across PINs too: too many in an hour pauses issuing, so brute force cannot use the
//     per-PIN allowance as a renewable budget.
//
// Only an HMAC of the PIN is kept — keyed with a per-process random secret, so the state file (or a heap dump of
// a persisted copy) never yields a usable PIN. The PIN itself only ever exists in the WhatsApp message.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const PIN_TTL_MS = 5 * 60_000;
export const PIN_MAX_ATTEMPTS = 3;
export const PIN_COOLDOWN_MS = 60_000;
export const PIN_MAX_PER_HOUR = 5;
export const PIN_MAX_PER_IP_PER_HOUR = 3;
// Wrong digits are remembered across PINs: 8 in an hour is far beyond a mistyping owner and pauses issuing for 15
// minutes, which is what stops "ask a PIN, guess it, ask another" from adding up over a day.
export const PIN_MAX_FAILURES = 8;
export const PIN_FAILURE_WINDOW_MS = 60 * 60_000;
export const PIN_LOCK_MS = 15 * 60_000;
// A failed send (gateway down, misconfigured) must not be retryable in a tight loop, yet must not cost the owner a
// full minute the way a delivered PIN does.
export const PIN_RETRY_AFTER_FAILURE_MS = 10_000;
const HOUR_MS = 60 * 60_000;

export class PinError extends Error {
  /**
   * @param {string} code machine-readable reason (`cooldown`, `rate_limited`, `locked`, `expired`, `burned`,
   *   `other_device`, `wa_failed`)
   * @param {string} message Indonesian text safe to show in the UI
   * @param {{ retryAfterSec?: number, status?: number }} [meta]
   */
  constructor(code, message, { retryAfterSec = 0, status = 429 } = {}) {
    super(message);
    this.name = 'PinError';
    this.code = code;
    this.retryAfterSec = retryAfterSec;
    this.status = status;
  }
}

/**
 * The cooldown, overridable per process (`OFFICE_PIN_COOLDOWN_MS`). It is a security limit, not a preference, so
 * the default stays 60 s; the knob exists for the end-to-end test, which spawns the real server and cannot wait a
 * minute twice. Anything that is not a non-negative number is ignored (the safe default wins).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function pinCooldownMs(env = process.env) {
  const raw = env.OFFICE_PIN_COOLDOWN_MS;
  if (raw === undefined || String(raw).trim() === '') return PIN_COOLDOWN_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : PIN_COOLDOWN_MS;
}

/**
 * The per-address hourly cap, overridable the same way (`OFFICE_PIN_MAX_PER_IP_PER_HOUR`) and for the same
 * reason: the end-to-end test asks from `127.0.0.1` over and over. A value that is not a positive integer is
 * ignored, so production keeps the real limit unless someone deliberately changes it.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function pinMaxPerIpPerHour(env = process.env) {
  const raw = env.OFFICE_PIN_MAX_PER_IP_PER_HOUR;
  if (raw === undefined || String(raw).trim() === '') return PIN_MAX_PER_IP_PER_HOUR;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : PIN_MAX_PER_IP_PER_HOUR;
}

export class AccessPin {
  /**
   * @param {{ send?: (text: string) => Promise<unknown>, ttlMs?: number, maxAttempts?: number,
   *   cooldownMs?: number, maxPerHour?: number, maxPerIpPerHour?: number, maxFailures?: number,
   *   now?: () => number, key?: Buffer }} [options]
   *   `send` receives the PIN itself (the transport decides the wording); tests pass a recorder.
   */
  constructor({
    send,
    ttlMs = PIN_TTL_MS,
    maxAttempts = PIN_MAX_ATTEMPTS,
    cooldownMs = PIN_COOLDOWN_MS,
    maxPerHour = PIN_MAX_PER_HOUR,
    maxPerIpPerHour = PIN_MAX_PER_IP_PER_HOUR,
    maxFailures = PIN_MAX_FAILURES,
    now = Date.now,
    key = randomBytes(32),
  } = {}) {
    this.send = send ?? (async () => { throw new PinError('wa_failed', 'WhatsApp belum siap.', { status: 503 }); });
    this.ttlMs = ttlMs;
    this.maxAttempts = maxAttempts;
    this.cooldownMs = cooldownMs;
    this.maxPerHour = maxPerHour;
    this.maxPerIpPerHour = maxPerIpPerHour;
    this.maxFailures = maxFailures;
    this.now = now;
    this.key = key;
    this.currents = []; // live PINs, one per requesting browser: { hash, requester, expiresAt, attempts, ip, userAgent, createdAt }
    this.issuedAt = []; // sliding hour window of issued PINs, for the per-hour cap
    this.issuedByIp = new Map(); // address → its own sliding hour window
    this.failures = []; // wrong digits across PINs, sliding hour window
    this.lastIssuedAt = 0;
    this.lastFailedAt = 0;
  }

  /**
   * Exposed to the UI: whether a PIN is live — only for the device that asked for it (`token`), so the endpoint is
   * not an oracle that tells a stranger when to start guessing. Never the PIN or its hash.
   * @param {{ token?: string }} [options]
   */
  status({ token = '' } = {}) {
    const now = this.now();
    const mine = this.#liveRecords(now).find((record) => this.#same(this.#hash(String(token)), record.requester)) ?? null;
    // Everything that has to pass before another PIN may be asked for: the cooldown, a failed send, or a lock.
    const waitMs = Math.max(this.lastIssuedAt + this.cooldownMs, this.lastFailedAt + PIN_RETRY_AFTER_FAILURE_MS, now + this.lockedFor()) - now;
    return {
      active: Boolean(mine),
      expiresInSec: mine ? Math.ceil((mine.expiresAt - now) / 1000) : 0,
      canRequestInSec: Math.max(0, Math.ceil(waitMs / 1000)),
    };
  }

  /** How long wrong digits pause everything (0 = not locked). */
  lockedFor() {
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < PIN_FAILURE_WINDOW_MS);
    if (this.failures.length < this.maxFailures) return 0;
    return Math.max(0, this.failures.at(-1) + PIN_LOCK_MS - now);
  }

  /**
   * Issues a PIN and sends it over WhatsApp. On a send failure nothing is kept: a PIN the owner never received
   * must not count as live (and must not spend the hourly budget).
   * @param {{ ip?: string, userAgent?: string }} [context] recorded for the audit trail, never logged with the PIN
   * @returns {Promise<{ token: string, expiresInSec: number, attemptsLeft: number }>} `token` goes into a cookie on
   *   the requesting browser; it is the only thing that may spend this PIN (see verify())
   */
  async request({ ip = '', userAgent = '' } = {}) {
    const now = this.now();
    const lock = this.lockedFor();
    if (lock) throw new PinError('locked', `Terlalu banyak kode salah. Coba lagi dalam ${Math.ceil(lock / 60_000)} menit.`, { retryAfterSec: Math.ceil(lock / 1000) });
    // Expired PINs (the common case: the owner asked again long after the last message) are dropped here, so the
    // list stays tiny — at most one live PIN per minute of the 5-minute life.
    this.#liveRecords(now);
    const waitMs = Math.max(this.lastIssuedAt + this.cooldownMs, this.lastFailedAt + PIN_RETRY_AFTER_FAILURE_MS) - now;
    if (waitMs > 0) throw new PinError('cooldown', `Tunggu ${Math.ceil(waitMs / 1000)} detik sebelum meminta kode lagi.`, { retryAfterSec: Math.ceil(waitMs / 1000) });
    this.issuedAt = this.issuedAt.filter((at) => now - at < HOUR_MS);
    if (this.issuedAt.length >= this.maxPerHour) {
      throw new PinError('rate_limited', 'Terlalu banyak permintaan kode dalam satu jam. Coba lagi nanti.', { retryAfterSec: Math.ceil((this.issuedAt[0] + HOUR_MS - now) / 1000) });
    }
    const fromIp = this.#ipWindow(ip, now);
    if (fromIp.length >= this.maxPerIpPerHour) {
      throw new PinError('rate_limited', 'Terlalu banyak permintaan kode dari perangkat ini. Coba lagi nanti.', { retryAfterSec: Math.ceil((fromIp[0] + HOUR_MS - now) / 1000) });
    }
    // randomInt is uniform and excluded from the low half on purpose: 100000–999999 is always six digits.
    const pin = String(randomInt(100_000, 1_000_000));
    const token = randomBytes(32).toString('base64url');
    const record = {
      hash: this.#hash(pin),
      requester: this.#hash(token),
      expiresAt: now + this.ttlMs,
      attempts: 0,
      ip: String(ip ?? ''),
      userAgent: String(userAgent ?? '').slice(0, 300),
      createdAt: now,
    };
    // Register BEFORE sending: two requests in the same tick must not both pass the checks above.
    this.currents.push(record);
    this.issuedAt.push(now);
    fromIp.push(now);
    this.lastIssuedAt = now;
    try {
      await this.send(pin);
    } catch (err) {
      this.currents = this.currents.filter((live) => live !== record);
      this.issuedAt.pop();
      fromIp.pop();
      this.lastIssuedAt = 0; // the hourly budget was not spent: the owner never saw a code
      this.lastFailedAt = now;
      throw err instanceof PinError ? err : new PinError('wa_failed', 'Kode tidak terkirim ke WhatsApp. Coba lagi.', { status: 503 });
    }
    this.lastFailedAt = 0;
    return { token, expiresInSec: Math.ceil(this.ttlMs / 1000), attemptsLeft: this.maxAttempts };
  }

  /**
   * @param {string} pin
   * @param {{ token?: string }} [options] the requester token handed out by request() (cookie on that browser)
   * @returns {{ ok: true } | { ok: false, triesLeft: number }}
   * @throws {PinError} expired/burned/other_device → 401 with the reason
   */
  verify(pin, { token = '' } = {}) {
    const now = this.now();
    const live = this.#liveRecords(now);
    // The record that belongs to THIS browser. Another device's PIN is never touched — not one attempt of it —
    // because anyone on the same WiFi could otherwise burn the owner's live PIN with three wrong digits.
    const record = live.find((candidate) => this.#same(this.#hash(String(token)), candidate.requester));
    if (!record) {
      if (live.length) throw new PinError('other_device', 'Kode ini diminta dari perangkat lain. Minta PIN baru dari HP ini.', { status: 401 });
      throw new PinError('expired', 'Kode kedaluwarsa. Minta kode baru.', { status: 401 });
    }
    if (!this.#same(this.#hash(String(pin ?? '')), record.hash)) {
      record.attempts += 1;
      this.failures.push(now);
      if (record.attempts >= this.maxAttempts) {
        this.currents = this.currents.filter((live) => live !== record); // burned: the owner must approve a new PIN
        throw new PinError('burned', `Kode salah ${this.maxAttempts} kali dan sudah dibatalkan. Minta kode baru.`, { status: 401 });
      }
      return { ok: false, triesLeft: this.maxAttempts - record.attempts };
    }
    this.currents = this.currents.filter((live) => live !== record); // one-time use
    return { ok: true };
  }

  /** Drops the live PINs (unpair, disabling remote access, shutdown). */
  clear() {
    this.currents = [];
  }

  /** Drops expired PINs and returns the live ones (bounded: one per minute of the 5-minute life at most). */
  #liveRecords(now) {
    this.currents = this.currents.filter((record) => record.expiresAt > now);
    return this.currents;
  }

  /** The hour window of one address, pruned in place (bounded memory like the wrong-guess map in src/remote.js). */
  #ipWindow(ip, now) {
    const key = String(ip ?? '');
    const stamps = (this.issuedByIp.get(key) ?? []).filter((at) => now - at < HOUR_MS);
    if (this.issuedByIp.size > 500) {
      for (const [other, times] of this.issuedByIp) if (!times.length || now - times.at(-1) >= HOUR_MS) this.issuedByIp.delete(other);
    }
    this.issuedByIp.set(key, stamps);
    return stamps;
  }

  /** Constant-time comparison over the fixed-width HMACs (both sides are always 32 bytes). */
  #same(a, b) {
    return Buffer.isBuffer(b) && Buffer.isBuffer(a) && timingSafeEqual(a, b);
  }

  #hash(value) {
    return createHmac('sha256', this.key).update(value).digest();
  }
}

/**
 * The PIN message, sent to the owner's own WhatsApp account through src/wa-link.js. One place, so the wording cannot
 * drift between the sender and its tests — and the app has exactly one sentence that contains a PIN.
 * @param {string} pin
 * @param {number} [minutes] how long the PIN stays usable (the message must not promise more than PIN_TTL_MS)
 */
export function pinMessage(pin, minutes = 5) {
  return `🔐 Kode PIN Akses Adhitron: *${pin}*\nBerlaku selama ${minutes} menit. Jangan bagikan kode ini ke siapa pun.`;
}
