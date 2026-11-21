// bridge/src/auth.mjs — autentikasi Adhitron Web (email + password), murni & tanpa I/O global.
// Semua yang di sini bisa dites tanpa server: hashing password (scrypt), token sesi + hash-nya,
// cookie httpOnly, dan pemeriksaan Origin (anti-CSRF).
//
// Prinsip:
//  - password TIDAK pernah disimpan/disiarkan plaintext; hash scrypt + salt acak, dibandingkan timing-safe;
//  - cookie hanya membawa token acak; yang tersimpan di DB cuma sha256(token) (pola sama dengan jembatan);
//  - setiap respons sesi memakai flag httpOnly + Secure + SameSite=Lax + Path=/;
//  - permintaan yang mengubah state wajib same-origin (Origin cocok dengan host) — lapis kedua setelah SameSite.
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'adhitron_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari
export const SESSION_TTL_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

// ---------------------------------------------------------------- password

/** Hash password → "scrypt$<salt hex>$<hash hex>". Salt 16 byte acak per akun. */
export function hashPassword(password, { N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p } = {}) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('password minimal 8 karakter');
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N, r, p });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Verifikasi password terhadap hash tersimpan; selalu timing-safe, tidak pernah melempar untuk input salah. */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length, SCRYPT);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------- token sesi

export const newSessionToken = () => randomBytes(32).toString('hex'); // 64 char hex
export const sessionTokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');
export const sessionExpiry = (now = Date.now()) => new Date(now + SESSION_TTL_MS).toISOString();

// ---------------------------------------------------------------- cookie

/** Parse header Cookie menjadi Map (nama → nilai). Tahan nilai kosong / spasi / kutip ganda. */
export function parseCookies(header) {
  const out = new Map();
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (name) out.set(name, value);
  }
  return out;
}

/** Cookie sesi (httpOnly, Secure, SameSite=Lax). maxAge detik; 0 = hapus saat logout. */
export function sessionCookie(token, { maxAgeSec = Math.floor(SESSION_TTL_MS / 1000) } = {}) {
  const base = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  return maxAgeSec > 0 ? `${base}; Max-Age=${maxAgeSec}` : `${base}; Max-Age=0`;
}

export const clearedSessionCookie = () => sessionCookie('', { maxAgeSec: 0 });

/** Token sesi dari request (cookie saja — tidak ada token di URL/header untuk chat). */
export const sessionTokenOf = (request) => parseCookies(request.headers.get('cookie')).get(SESSION_COOKIE) ?? null;

// ---------------------------------------------------------------- anti-CSRF (Origin)

/**
 * Permintaan pengubah state harus same-origin: Origin (atau Referer sebagai cadangan) harus cocok dengan
 * host request. Permintaan tanpa Origin/Referer (mis. beberapa klien non-browser) DITOLAK untuk POST —
 * fail closed; browser modern selalu mengirim Origin pada fetch/XHR lintas maupun same-origin POST.
 */
export function isSameOrigin(request) {
  const target = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin) return originHost(origin) === target.host;
  const referer = request.headers.get('referer');
  if (referer) return originHost(referer) === target.host;
  return false;
}

const originHost = (value) => {
  try { return new URL(value).host; } catch { return null; }
};

// ---------------------------------------------------------------- validasi input

/** Email sederhana: satu '@', ada bagian sebelum/sesudah, tanpa spasi. Disimpan lowercase. */
export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();
export function isValidEmail(email) {
  const e = normalizeEmail(email);
  return e.length >= 3 && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
export const emailProblem = (email) => (isValidEmail(email) ? null : 'Email tidak valid');

export function passwordProblem(password) {
  const p = String(password ?? '');
  if (p.length < 8) return 'Password minimal 8 karakter';
  if (p.length > 200) return 'Password maksimal 200 karakter';
  return null;
}