// bridge/src/chat-api.mjs — API Adhitron Web di bawah '/chat/api/*' (auth dulu; provider/percakapan menyusul).
// Hanya logika HTTP: memakai `env.repo` (repo SQL/atau memory di test), `env.store` (Blobs untuk rate-limit),
// dan helper murni dari auth.mjs. Tidak ada rahasia yang keluar: password & api key tidak pernah direspons.
import {
  clearedSessionCookie, emailProblem, hashPassword, isSameOrigin, newSessionToken, normalizeEmail,
  passwordProblem, sessionCookie, sessionExpiry, sessionTokenHash, sessionTokenOf, verifyPassword,
} from './auth.mjs';
import { hit, hourWindow } from './rate-limit.mjs';

const CORS_SAME_ORIGIN = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS_SAME_ORIGIN, ...headers } });

/** IP client (Netlify) — tak dipercaya kalau kosong; sama seperti jembatan. */
function clientIp(request) {
  const raw = request.headers.get('x-nf-client-connection-ip');
  const clean = String(raw ?? '').replace(/[^0-9a-fA-F:.]/g, '_').slice(0, 64);
  return /^[0-9a-fA-F:.]/.test(clean) ? clean : 'unknown';
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

/** User publik (tanpa hash password). */
const publicUser = (u) => ({ id: u.id, email: u.email, displayName: u.display_name ?? null, createdAt: u.created_at });

/** Batas per IP+jendela. Melebihi → lempar 429 dengan Retry-After. */
async function enforceLimit(env, request, { name, window, limit }) {
  const id = clientIp(request);
  const { allowed } = await hit(env, { name, id, window, limit });
  if (!allowed) throw new HttpError(429, 'Terlalu banyak percobaan. Coba lagi nanti.', { retryAfterSec: 3600 });
}

class HttpError extends Error {
  constructor(status, message, { retryAfterSec = 0 } = {}) { super(message); this.status = status; this.retryAfterSec = retryAfterSec; }
}

/** Bungkus: error HttpError → status+pesan; error lain → 500 tanpa membocorkan detail internal. */
const guard = async (fn) => {
  try { return await fn(); } catch (err) {
    if (err instanceof HttpError) {
      const headers = err.retryAfterSec > 0 ? { 'Retry-After': String(err.retryAfterSec) } : {};
      return json({ error: err.message }, err.status, headers);
    }
    return json({ error: 'Terjadi kesalahan di server' }, 500);
  }
};

/** Sesi dari cookie; null kalau tidak ada / kedaluwarsa. Kedaluwarsa dibersihkan sambil jalan. */
async function currentUser(request, env, now = Date.now()) {
  const token = sessionTokenOf(request);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const session = await env.repo.getSession(sessionTokenHash(token));
  if (!session) return null;
  if (Date.parse(session.expires_at) <= now) { await env.repo.deleteSession(session.token_hash); return null; }
  return env.repo.getUserById(session.user_id);
}

/** Wajib login; lempar 401 kalau bukan. */
async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, 'Perlu masuk dulu');
  return user;
}

// ---------------------------------------------------------------- endpoint

async function signup(request, env) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  await enforceLimit(env, request, { name: 'signup', window: hourWindow(), limit: 20 });
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password ?? '');
  const bad = emailProblem(email) || passwordProblem(password);
  if (bad) throw new HttpError(400, bad);
  if (await env.repo.getUserByEmail(email)) throw new HttpError(409, 'Email sudah terdaftar');
  const user = await env.repo.createUser({ email, displayName: body?.displayName ?? null, passwordHash: hashPassword(password) });
  return issueSession(env, user, 201);
}

async function login(request, env) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  await enforceLimit(env, request, { name: 'login', window: hourWindow(), limit: 50 });
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password ?? '');
  const user = await env.repo.getUserByEmail(email);
  // Pesan gagal selalu sama: jangan bocorkan email mana yang terdaftar.
  if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Email atau password salah');
  return issueSession(env, user, 200);
}

async function issueSession(env, user, status) {
  const token = newSessionToken();
  await env.repo.createSession({ tokenHash: sessionTokenHash(token), userId: user.id, expiresAt: sessionExpiry() });
  return json({ user: publicUser(user) }, status, { 'Set-Cookie': sessionCookie(token) });
}

async function logout(request, env) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  const token = sessionTokenOf(request);
  if (token && /^[0-9a-f]{64}$/.test(token)) await env.repo.deleteSession(sessionTokenHash(token));
  return json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
}

async function me(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, 'Belum masuk');
  return json({ user: publicUser(user) });
}

/** Rute chat API. `path` sudah tanpa prefiks mount ('/chat/api/...'). null = bukan rute chat API. */
export async function handleChatApi(request, env, path) {
  const seg = path.replace(/^\/chat\/api\/?/, '');
  const method = request.method;
  const ROUTES = [
    ['auth/signup', 'POST', signup],
    ['auth/login', 'POST', login],
    ['auth/logout', 'POST', logout],
    ['me', 'GET', me],
  ];
  for (const [route, verb, fn] of ROUTES) {
    if (seg === route && method === verb) return guard(() => fn(request, env));
  }
  // Rute dikenal tapi metode salah → 405; benar-benar tidak dikenal → 404 (pemanggil bisa coba handler lain).
  for (const [route] of ROUTES) if (seg === route) return json({ error: 'Metode tidak didukung' }, 405);
  return null;
}

export { currentUser, requireUser, publicUser, HttpError };