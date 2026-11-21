// bridge/src/chat-api.mjs — API Adhitron Web di bawah '/chat/api/*' (auth dulu; provider/percakapan menyusul).
// Hanya logika HTTP: memakai `env.repo` (repo SQL/atau memory di test), `env.store` (Blobs untuk rate-limit),
// dan helper murni dari auth.mjs. Tidak ada rahasia yang keluar: password & api key tidak pernah direspons.
import {
  clearedSessionCookie, emailProblem, hashPassword, isSameOrigin, newSessionToken, normalizeEmail,
  passwordProblem, sessionCookie, sessionExpiry, sessionTokenHash, sessionTokenOf, verifyPassword,
} from './auth.mjs';
import { hit, hourWindow } from './rate-limit.mjs';
import { cleanBaseUrl, isValidKind, KIND_LABELS, modelsFor, PROVIDER_KINDS } from './providers.mjs';
import { decryptSecret, encryptSecret, keyHint, publicProvider } from './secrets.mjs';

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

// ---------------------------------------------------------------- provider (M4)

/** Katalog statis: kind + label + daftar model (tanpa kredensial). Dipakai UI untuk membangun pemilih model. */
function catalog() {
  return json({
    kinds: PROVIDER_KINDS.map((kind) => ({ kind, label: KIND_LABELS[kind], models: modelsFor(kind) })),
  });
}

async function listProviders(request, env) {
  const user = await requireUser(request, env);
  const rows = await env.repo.listProviders(user.id);
  return json({ providers: rows.map(publicProvider) });
}

/** Tambah provider. Body: { kind, label, apiKey, baseUrl? }. API key dienkripsi sebelum disimpan. */
async function addProvider(request, env) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const kind = String(body?.kind ?? '');
  if (!isValidKind(kind)) throw new HttpError(400, 'Jenis provider tidak dikenal');
  const label = String(body?.label ?? '').trim().slice(0, 60) || KIND_LABELS[kind];
  const apiKey = String(body?.apiKey ?? '').trim();
  if (apiKey.length < 8 || apiKey.length > 500) throw new HttpError(400, 'API key tidak valid');
  const base = cleanBaseUrl(body?.baseUrl);
  if (!base.ok) throw new HttpError(400, base.error);
  if (env.encryptionKey == null) throw new HttpError(500, 'Server belum dikonfigurasi untuk menyimpan key');
  const row = await env.repo.createProvider({
    userId: user.id, kind, label, baseUrl: base.value,
    apiKeyEnc: encryptSecret(env.encryptionKey, apiKey), keyHint: keyHint(apiKey),
  });
  return json({ provider: publicProvider(row) }, 201);
}

async function updateProvider(request, env, id) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const patch = {};
  if (body?.label != null) patch.label = String(body.label).trim().slice(0, 60) || 'Provider';
  if (body?.baseUrl !== undefined) {
    const base = cleanBaseUrl(body.baseUrl);
    if (!base.ok) throw new HttpError(400, base.error);
    patch.base_url = base.value;
  }
  if (body?.apiKey != null && String(body.apiKey).trim()) {
    const apiKey = String(body.apiKey).trim();
    if (apiKey.length < 8 || apiKey.length > 500) throw new HttpError(400, 'API key tidak valid');
    if (env.encryptionKey == null) throw new HttpError(500, 'Server belum dikonfigurasi untuk menyimpan key');
    patch.api_key_enc = encryptSecret(env.encryptionKey, apiKey);
    patch.key_hint = keyHint(apiKey);
  }
  const row = await env.repo.updateProvider(user.id, id, patch);
  if (!row) throw new HttpError(404, 'Provider tidak ditemukan');
  return json({ provider: publicProvider(row) });
}

async function removeProvider(request, env, id) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  const user = await requireUser(request, env);
  if (!(await env.repo.getProvider(user.id, id))) throw new HttpError(404, 'Provider tidak ditemukan');
  await env.repo.deleteProvider(user.id, id);
  return json({ ok: true });
}

/** Uji provider: dekripsi key dan panggil endpoint daftar model provider. Key tidak pernah direspons. */
async function testProvider(request, env, id, fetchImpl) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  const user = await requireUser(request, env);
  const row = await env.repo.getProvider(user.id, id);
  if (!row) throw new HttpError(404, 'Provider tidak ditemukan');
  const key = decryptSecret(env.encryptionKey, row.api_key_enc);
  const { testProviderKey } = await import('./client.mjs');
  const result = await testProviderKey(row, key, fetchImpl);
  return json(result, result.ok ? 200 : 400);
}

/** Rute chat API. `path` sudah tanpa prefiks mount ('/chat/api/...'). null = bukan rute chat API. */
export async function handleChatApi(request, env, path, fetchImpl) {
  const seg = path.replace(/^\/chat\/api\/?/, '');
  const method = request.method;
  const providerId = seg.match(/^providers\/([\w-]+)$/)?.[1];
  const testMatch = seg.match(/^providers\/([\w-]+)\/test$/)?.[1];

  const ROUTES = [
    ['auth/signup', 'POST', (r, e) => signup(r, e)],
    ['auth/login', 'POST', (r, e) => login(r, e)],
    ['auth/logout', 'POST', (r, e) => logout(r, e)],
    ['me', 'GET', (r, e) => me(r, e)],
    ['provider-kinds', 'GET', (r, e) => catalog(r, e)],
    ['providers', 'GET', (r, e) => listProviders(r, e)],
    ['providers', 'POST', (r, e) => addProvider(r, e)],
  ];
  for (const [route, verb, fn] of ROUTES) {
    if (seg === route && method === verb) return guard(() => fn(request, env));
  }
  if (providerId) {
    if (method === 'PATCH' || method === 'PUT') return guard(() => updateProvider(request, env, providerId));
    if (method === 'DELETE') return guard(() => removeProvider(request, env, providerId));
  }
  if (testMatch && method === 'POST') return guard(() => testProvider(request, env, testMatch, fetchImpl));
  // Rute dikenal tapi metode salah → 405; benar-benar tidak dikenal → 404 (pemanggil bisa coba handler lain).
  const known = [...ROUTES.map(([route]) => route), 'providers/:id', 'providers/:id/test'];
  if (known.some((r) => seg === r)) return json({ error: 'Metode tidak didukung' }, 405);
  return null;
}

export { currentUser, requireUser, publicUser, HttpError };