// Web Push without dependencies (node:crypto only): VAPID (RFC 8292) and the aes128gcm payload
// encryption of RFC 8291 / RFC 8188. Pure: no knowledge of the app; src/push.js (later) decides what
// to send to whom. Verified against the known-answer vector of RFC 8291 Appendix A (test/webpush.test.mjs).
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';

/** VAPID contact sent to push services (visible to Google/Mozilla/Apple/Microsoft): the project page, no email. */
export const VAPID_SUBJECT = 'https://github.com/adhityarachmanh/claude-coworking';
/** Push services accept bodies up to 4096 bytes. */
export const MAX_BODY = 4096;
const RECORD_SIZE = 4096;
const HEADER_BYTES = 16 + 4 + 1 + 65; // salt, rs, idlen, keyid (the server's public key) of a push message
const TAG_BYTES = 16;
/** The largest plaintext that still fits one record in MAX_BODY: 4096 - 86 header - 16 tag - 1 delimiter. */
export const MAX_PLAINTEXT = MAX_BODY - HEADER_BYTES - TAG_BYTES - 1;
const JWT_LIFETIME_S = 12 * 60 * 60; // RFC 8292: at most 24 h
const JWT_REUSE_MARGIN_S = 60 * 60; // a cached JWT is replaced an hour before it expires
const URGENCIES = new Set(['very-low', 'low', 'normal', 'high']);
const MAX_TTL = 28 * 24 * 60 * 60;
// Topic travels unencrypted: opaque, at most 32 base64url characters (RFC 8030).
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Push services a subscription endpoint may point at (anti-SSRF: a paired device must never make the
 * server POST to an arbitrary URL, e.g. something on the LAN). Matched on whole DNS labels.
 */
export const PUSH_SERVICE_HOSTS = Object.freeze([
  'fcm.googleapis.com', // Chrome, Edge on Android, Samsung Internet
  'push.services.mozilla.com', // Firefox (autopush)
  'push.apple.com', // Safari / iOS home-screen apps (web.push.apple.com)
  'notify.windows.com', // Edge on Windows (WNS)
]);

/** A request that is ours to refuse (bad subscription, endpoint not allowed, payload too big…). */
export class WebPushError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
/** base64url (or standard base64, which some browsers' toJSON produced) to bytes. */
const fromB64 = (s, what) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_\-+/]*={0,2}$/.test(s)) throw new WebPushError('bad-subscription', `${what} bukan base64url.`);
  return Buffer.from(s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url');
};

// ---------- endpoint allowlist ----------

/**
 * True when `endpoint` is an https URL on port 443 of an allowed push service.
 * @param {string} endpoint
 * @param {readonly string[]} [hosts]  injectable for tests (never from env)
 */
export function endpointAllowed(endpoint, hosts = PUSH_SERVICE_HOSTS) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

// ---------- VAPID (RFC 8292) ----------

/**
 * A new VAPID key pair.
 * @returns {{ publicKey: string, privateJwk: { kty: string, crv: string, x: string, y: string, d: string }, created: number }}
 *   publicKey: uncompressed P-256 point (65 bytes, 0x04 || x || y) in base64url — what browsers take as applicationServerKey
 */
export function generateVapidKeys(now = Date.now()) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const publicKey = b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  return { publicKey, privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, created: now };
}

/**
 * The install's VAPID keys, created on first use in `remoteState.vapid` (= hub.persisted.remote.vapid,
 * which hub.exportState() drops: never in a backup).
 * @param {object} remoteState  hub.persisted.remote
 * @param {() => void} save  persists the state when a key was just created
 */
export function ensureVapidKeys(remoteState, save) {
  const v = remoteState.vapid;
  if (v?.publicKey && v.privateJwk?.d) return v;
  remoteState.vapid = generateVapidKeys();
  save();
  return remoteState.vapid;
}

const jwtCache = new Map(); // `${publicKey} ${aud} ${sub}` -> { jwt, exp }

/**
 * An ES256 VAPID JWT for the push service of `endpoint`. Signature is raw r || s (ieee-p1363), as JWS wants.
 * @param {{ endpoint: string, vapid: { publicKey: string, privateJwk: object }, subject?: string, now?: number }} options
 */
export function vapidJwt({ endpoint, vapid, subject = VAPID_SUBJECT, now = Date.now() }) {
  if (!/^(https:|mailto:)/.test(subject)) throw new WebPushError('bad-subject', 'VAPID subject harus https: atau mailto:.');
  const aud = new URL(endpoint).origin;
  const nowS = Math.floor(now / 1000);
  const cacheKey = `${vapid.publicKey} ${aud} ${subject}`;
  const cached = jwtCache.get(cacheKey);
  if (cached && cached.exp - JWT_REUSE_MARGIN_S > nowS && cached.iat <= nowS) return cached.jwt;
  const exp = nowS + JWT_LIFETIME_S;
  const data = `${b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64url(JSON.stringify({ aud, exp, sub: subject }))}`;
  const key = createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const jwt = `${data}.${b64url(sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }))}`;
  if (jwtCache.size > 100) jwtCache.clear(); // bounded: a handful of push services in practice
  jwtCache.set(cacheKey, { jwt, exp, iat: nowS });
  return jwt;
}

/** `Authorization` header value: `vapid t=<jwt>, k=<public key>`. */
export function vapidAuthorization(options) {
  return `vapid t=${vapidJwt(options)}, k=${options.vapid.publicKey}`;
}

// ---------- payload encryption (RFC 8291 + RFC 8188 aes128gcm) ----------

/**
 * Parses and checks a browser's subscription keys.
 * @returns {{ uaPublic: Buffer, authSecret: Buffer }}
 */
export function subscriptionKeys(p256dh, auth) {
  const uaPublic = fromB64(p256dh, 'p256dh');
  const authSecret = fromB64(auth, 'auth');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new WebPushError('bad-subscription', 'p256dh harus titik P-256 tak terkompresi (65 byte).');
  if (authSecret.length !== 16) throw new WebPushError('bad-subscription', 'auth harus 16 byte.');
  try {
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(uaPublic); // throws when the point is not on the curve
  } catch {
    throw new WebPushError('bad-subscription', 'p256dh bukan titik yang valid di kurva P-256.');
  }
  return { uaPublic, authSecret };
}

/**
 * RFC 8188 `aes128gcm` content coding, a single record (all a push message ever needs).
 * @param {{ ikm: Buffer, salt: Buffer, keyid?: Buffer, plaintext: Buffer, padTo?: number, maxPadded?: number }} options
 *   padTo: pad plaintext+delimiter up to a multiple of this (0 = none), never beyond `maxPadded` bytes
 * @returns {{ body: Buffer, header: Buffer, ciphertext: Buffer, cek: Buffer, nonce: Buffer }}
 */
export function aes128gcm({ ikm, salt, keyid = Buffer.alloc(0), plaintext, padTo = 0, maxPadded = RECORD_SIZE - TAG_BYTES }) {
  if (salt.length !== 16) throw new WebPushError('bad-salt', 'salt harus 16 byte.');
  if (keyid.length > 255) throw new WebPushError('bad-keyid', 'keyid terlalu panjang.');
  if (plaintext.length + 1 > maxPadded) throw new WebPushError('too-large', 'Payload terlalu besar untuk satu record.');
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // One record: plaintext || 0x02 (last-record delimiter) || zero padding. Being the only record, its
  // sequence number is 0, so the nonce is used as derived.
  const unpadded = plaintext.length + 1;
  const padded = padTo > 1 ? Math.min(Math.ceil(unpadded / padTo) * padTo, maxPadded) : unpadded;
  const record = Buffer.alloc(padded); // zero-filled: the padding
  plaintext.copy(record);
  record[plaintext.length] = 2;
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // Header: salt(16) || rs(uint32 BE) || idlen(1) || keyid.
  const header = Buffer.alloc(16 + 4 + 1 + keyid.length);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = keyid.length;
  keyid.copy(header, 21);
  return { body: Buffer.concat([header, ciphertext]), header, ciphertext, cek, nonce };
}

/**
 * Encrypts one push message for a subscription (RFC 8291): ECDH with the browser's key, then aes128gcm.
 * @param {object} options
 * @param {Buffer|string} options.plaintext
 * @param {string} options.p256dh  subscription.keys.p256dh (base64url)
 * @param {string} options.auth  subscription.keys.auth (base64url)
 * @param {Buffer} [options.salt]  16 random bytes (injectable for the RFC known-answer test only)
 * @param {Buffer} [options.asPrivate]  the server's ephemeral ECDH private key (idem)
 * @param {number} [options.padTo]  pad up to a multiple of this (256: event kinds can't be told apart by size); 0 = none
 * @returns {{ body: Buffer, debug: object }} body: the HTTP request body; debug: intermediate values (tests)
 */
export function encrypt({ plaintext, p256dh, auth, salt = randomBytes(16), asPrivate, padTo = 256 }) {
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  if (data.length > MAX_PLAINTEXT) throw new WebPushError('too-large', `Payload push maksimal ${MAX_PLAINTEXT} byte.`);
  const { uaPublic, authSecret } = subscriptionKeys(p256dh, auth);

  // Ephemeral key pair, one per message (RFC 8291 §3.1).
  const ecdh = createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // 65 bytes, uncompressed
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.3-3.4: IKM from the ECDH secret and the auth secret (HKDF extract+expand in one call).
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  // The keyid carries the server's public key; the whole body must stay within MAX_BODY.
  const out = aes128gcm({ ikm, salt, keyid: asPublic, plaintext: data, padTo, maxPadded: MAX_PLAINTEXT + 1 });
  const prk = createHmac('sha256', authSecret).update(ecdhSecret).digest(); // HKDF-Extract, exposed for the KAT only
  return { body: out.body, debug: { ecdhSecret, keyInfo, prk, ikm, cek: out.cek, nonce: out.nonce, header: out.header, ciphertext: out.ciphertext, asPublic } };
}

// ---------- sending ----------

/**
 * Sends one push message. Resolves with the push service's answer; it never follows redirects.
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
 * @param {object|string|Buffer} payload  objects are sent as JSON
 * @param {object} options
 * @param {{ publicKey: string, privateJwk: object }} options.vapid
 * @param {number} [options.ttl]  seconds the push service keeps an undelivered message (0-28 days; default 3600)
 * @param {'very-low'|'low'|'normal'|'high'} [options.urgency]
 * @param {string} [options.topic]  replaces an undelivered message with the same topic (opaque, ≤ 32 base64url chars)
 * @param {string} [options.subject]  VAPID contact
 * @param {typeof fetch} [options.fetch]  injectable for tests
 * @param {readonly string[]} [options.allowedHosts]  injectable for tests
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ status: number, ok: boolean, retryAfter: number|null }>}
 * @throws {WebPushError} refused before sending (endpoint, keys, options) or network failure (code 'network')
 */
export async function sendPush(subscription, payload, { vapid, ttl = 3600, urgency = 'normal', topic, subject = VAPID_SUBJECT, fetch: doFetch = globalThis.fetch, allowedHosts = PUSH_SERVICE_HOSTS, timeoutMs = 10_000, now = Date.now() } = {}) {
  const endpoint = subscription?.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 1024 || !endpointAllowed(endpoint, allowedHosts)) throw new WebPushError('endpoint-not-allowed', 'Endpoint push tidak diizinkan.');
  if (!vapid?.publicKey || !vapid.privateJwk) throw new WebPushError('no-vapid', 'Kunci VAPID belum ada.');
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL) throw new WebPushError('bad-ttl', 'TTL tidak valid.');
  if (!URGENCIES.has(urgency)) throw new WebPushError('bad-urgency', 'Urgency tidak valid.');
  if (topic !== undefined && !TOPIC.test(topic)) throw new WebPushError('bad-topic', 'Topic harus 1-32 karakter base64url.');
  const plaintext = Buffer.isBuffer(payload) ? payload : typeof payload === 'string' ? payload : JSON.stringify(payload);
  const { body } = encrypt({ plaintext, p256dh: subscription.keys?.p256dh, auth: subscription.keys?.auth });

  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidAuthorization({ endpoint, vapid, subject, now }),
  };
  if (topic !== undefined) headers.Topic = topic;
  let res;
  try {
    res = await doFetch(endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw Object.assign(new WebPushError('network', 'Push service tidak bisa dihubungi.'), { cause: err });
  }
  try {
    await res.body?.cancel(); // the answer's body is not needed (and never logged)
  } catch {
    // already consumed or closed
  }
  // Retry-After in seconds (429/503); the HTTP-date form is rare for push services and treated as absent.
  const header = res.headers?.get?.('retry-after');
  const retry = header && /^\d+$/.test(header.trim()) ? Number(header) : null;
  return { status: res.status, ok: res.status >= 200 && res.status < 300, retryAfter: retry };
}
