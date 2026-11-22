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
import { runTurn } from './chat-run.mjs';

const CORS_SAME_ORIGIN = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS_SAME_ORIGIN, ...headers } });

/** Versi kebijakan privasi/syarat yang berlaku. Naikkan saat teksnya berubah bermakna (catat di CHANGELOG). */
export const POLICY_VERSION = '2026-11-23';

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
  // Persetujuan kebijakan privasi & syarat wajib (UU PDP: dasar pemrosesan). Ditolak → tidak ada akun dibuat.
  if (body?.consent !== true) throw new HttpError(400, 'Persetujuan Kebijakan Privasi & Syarat Layanan wajib dicentang');
  if (await env.repo.getUserByEmail(email)) throw new HttpError(409, 'Email sudah terdaftar');
  const user = await env.repo.createUser({
    email, displayName: body?.displayName ?? null, passwordHash: hashPassword(password),
    consentVersion: POLICY_VERSION,
  });
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

/**
 * Hapus akun & seluruh data user (hak hapus UU PDP Pasal 35–36 / GDPR Pasal 17). Cascade di skema
 * membuang sessions/providers/conversations/messages/citations/tool_runs milik user. Cookie sesi ikut dihapus.
 */
async function deleteMe(request, env) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  const user = await requireUser(request, env);
  await env.repo.deleteUser(user.id);
  return json({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
}

// ---------------------------------------------------------------- provider (M4)

/** Katalog statis: kind + label + daftar model (tanpa kredensial). Dipakai UI untuk membangun pemilih model. */
function catalog() {
  return json({
    kinds: PROVIDER_KINDS.map((kind) => ({ kind, label: KIND_LABELS[kind], models: modelsFor(kind) })),
  });
}

/** Bersihkan daftar model dari klien: [{ id, label }] unik, id wajib, dibatasi 500 entri. */
function normalizeProviderModels(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const m of raw.slice(0, 500)) {
    const id = String(m?.id ?? '').trim().slice(0, 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: String(m?.label ?? id).trim().slice(0, 200) || id });
  }
  return out.length ? out : null;
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
  const models = normalizeProviderModels(body?.models);
  const row = await env.repo.createProvider({
    userId: user.id, kind, label, baseUrl: base.value,
    apiKeyEnc: encryptSecret(env.encryptionKey, apiKey), keyHint: keyHint(apiKey), models,
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
  if (body?.models !== undefined) patch.models = normalizeProviderModels(body.models);
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

/**
 * Uji provider: dekripsi key, ambil daftar modelnya sekaligus membuktikan key berlaku, lalu SIMPAN daftar
 * itu di provider. Key tidak pernah direspons; hanya ok/error + daftar model.
 */
async function testProvider(request, env, id, fetchImpl) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  const user = await requireUser(request, env);
  const row = await env.repo.getProvider(user.id, id);
  if (!row) throw new HttpError(404, 'Provider tidak ditemukan');
  const key = decryptSecret(env.encryptionKey, row.api_key_enc);
  const { probeModels } = await import('./client.mjs');
  const probe = await probeModels(row, key, fetchImpl);
  if (!probe.ok) return json({ ok: false, error: probe.error }, 400);
  const models = normalizeProviderModels(probe.models);
  const saved = await env.repo.updateProvider(user.id, id, { models });
  return json({ ok: true, models: models ?? [], provider: publicProvider(saved ?? row) });
}

/**
 * Cek key calon provider (belum disimpan): ambil daftar modelnya. Body: { kind, apiKey, baseUrl? }.
 * Key hanya dipakai untuk panggilan ini dan dibuang — tidak pernah dikembalikan.
 */
async function probeProviderModels(request, env, fetchImpl) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  await requireUser(request, env);
  await enforceLimit(env, request, { name: 'probe', window: hourWindow(), limit: 60 });
  const body = await readJson(request);
  const kind = String(body?.kind ?? '');
  if (!isValidKind(kind)) throw new HttpError(400, 'Jenis provider tidak dikenal');
  const apiKey = String(body?.apiKey ?? '').trim();
  if (apiKey.length < 8 || apiKey.length > 500) throw new HttpError(400, 'API key tidak valid');
  const base = cleanBaseUrl(body?.baseUrl);
  if (!base.ok) throw new HttpError(400, base.error);
  const { probeModels } = await import('./client.mjs');
  const probe = await probeModels({ kind, base_url: base.value }, apiKey, fetchImpl);
  if (!probe.ok) return json({ ok: false, error: probe.error }, 400);
  return json({ ok: true, kind, models: normalizeProviderModels(probe.models) ?? [] });
}

// ---------------------------------------------------------------- percakapan (M5)

const publicConversation = (c) => ({
  id: c.id,
  title: c.title,
  providerId: c.provider_id ?? null,
  model: c.model ?? null,
  effort: c.effort ?? null,
  modelAuto: Boolean(c.model_auto),
  effortAuto: Boolean(c.effort_auto),
  modelTiers: c.model_tiers ?? null,
  browsing: Boolean(c.browsing),
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

const publicMessage = (m) => ({ id: m.id, role: m.role, content: m.content, meta: m.meta ?? null, createdAt: m.created_at });

async function listConversations(request, env) {
  const user = await requireUser(request, env);
  const rows = await env.repo.listConversations(user.id);
  return json({ conversations: rows.map(publicConversation) });
}

async function createConversation(request, env) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const conv = await env.repo.createConversation(user.id, {
    title: typeof body?.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : 'Percakapan baru',
    providerId: body?.providerId ?? null,
    model: body?.model ?? null,
    effort: body?.effort ?? null,
    modelAuto: Boolean(body?.modelAuto),
    effortAuto: Boolean(body?.effortAuto),
    modelTiers: body?.modelTiers ?? null,
    browsing: Boolean(body?.browsing),
  });
  return json({ conversation: publicConversation(conv) }, 201);
}

/** Muat percakapan milik user; lempar 404 kalau bukan miliknya. */
async function ownedConversation(request, env, id) {
  const user = await requireUser(request, env);
  const conv = await env.repo.getConversation(user.id, id);
  if (!conv) throw new HttpError(404, 'Percakapan tidak ditemukan');
  return { user, conv };
}

async function getConversation(request, env, id) {
  const { user, conv } = await ownedConversation(request, env, id);
  const messages = await env.repo.listMessages(user.id, id);
  const citations = await env.repo.listCitations(user.id, id);
  return json({
    conversation: publicConversation(conv),
    messages: messages.map(publicMessage),
    citations: citations.map((c) => ({ messageId: c.message_id, idx: c.idx, title: c.title, url: c.url, snippet: c.snippet })),
  });
}

async function updateConversation(request, env, id) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const patch = {};
  // Hanya field yang dikirim yang diubah (undefined = biarkan).
  if (body?.title != null) patch.title = String(body.title).trim().slice(0, 120) || 'Percakapan baru';
  if (body?.providerId !== undefined) patch.provider_id = body.providerId;
  if (body?.model !== undefined) patch.model = body.model;
  if (body?.effort !== undefined) patch.effort = body.effort;
  if (body?.modelAuto !== undefined) patch.model_auto = Boolean(body.modelAuto);
  if (body?.effortAuto !== undefined) patch.effort_auto = Boolean(body.effortAuto);
  if (body?.modelTiers !== undefined) patch.model_tiers = body.modelTiers;
  if (body?.browsing !== undefined) patch.browsing = Boolean(body.browsing);
  const row = await env.repo.updateConversation(user.id, id, patch);
  if (!row) throw new HttpError(404, 'Percakapan tidak ditemukan');
  return json({ conversation: publicConversation(row) });
}

async function deleteConversation(request, env, id) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  const user = await requireUser(request, env);
  if (!(await env.repo.getConversation(user.id, id))) throw new HttpError(404, 'Percakapan tidak ditemukan');
  await env.repo.deleteConversation(user.id, id);
  return json({ ok: true });
}

/**
 * Kirim pesan user dan alirkan jawaban asisten (SSE). Membutuhkan `env.callModel` untuk Auto(LLM)
 * dan `env.fetchImpl` (default fetch global) untuk provider. Membalas 400 JSON bila input salah.
 */
async function sendMessage(request, env, id, fetchImpl) {
  if (!isSameOrigin(request)) throw new HttpError(403, 'Permintaan bukan dari situs ini');
  const { user, conv } = await ownedConversation(request, env, id);
  const runEnv = { ...env, fetchImpl: fetchImpl ?? globalThis.fetch };
  return runTurn(runEnv, user, conv, request, { fetchImpl: runEnv.fetchImpl });
}

/** Rute chat API. `path` sudah tanpa prefiks mount ('/chat/api/...'). null = bukan rute chat API. */
export async function handleChatApi(request, env, path, fetchImpl) {
  const seg = path.replace(/^\/chat\/api\/?/, '');
  const method = request.method;
  const providerId = seg.match(/^providers\/([\w-]+)$/)?.[1];
  const testMatch = seg.match(/^providers\/([\w-]+)\/test$/)?.[1];
  const convId = seg.match(/^conversations\/([\w-]+)$/)?.[1];
  const msgMatch = seg.match(/^conversations\/([\w-]+)\/messages$/)?.[1];

  const ROUTES = [
    ['auth/signup', 'POST', (r, e) => signup(r, e)],
    ['auth/login', 'POST', (r, e) => login(r, e)],
    ['auth/logout', 'POST', (r, e) => logout(r, e)],
    ['me', 'GET', (r, e) => me(r, e)],
    ['me', 'DELETE', (r, e) => deleteMe(r, e)],
    ['provider-kinds', 'GET', (r, e) => catalog(r, e)],
    ['providers', 'GET', (r, e) => listProviders(r, e)],
    ['providers', 'POST', (r, e) => addProvider(r, e)],
    ['providers/models', 'POST', (r, e, f) => probeProviderModels(r, e, f)],
    ['conversations', 'GET', (r, e) => listConversations(r, e)],
    ['conversations', 'POST', (r, e) => createConversation(r, e)],
  ];
  for (const [route, verb, fn] of ROUTES) {
    if (seg === route && method === verb) return guard(() => fn(request, env, fetchImpl));
  }
  if (providerId) {
    if (method === 'PATCH' || method === 'PUT') return guard(() => updateProvider(request, env, providerId));
    if (method === 'DELETE') return guard(() => removeProvider(request, env, providerId));
  }
  if (testMatch && method === 'POST') return guard(() => testProvider(request, env, testMatch, fetchImpl));
  if (convId) {
    if (method === 'GET') return guard(() => getConversation(request, env, convId));
    if (method === 'PATCH' || method === 'PUT') return guard(() => updateConversation(request, env, convId));
    if (method === 'DELETE') return guard(() => deleteConversation(request, env, convId));
  }
  if (msgMatch && method === 'POST') return guard(() => sendMessage(request, env, msgMatch, fetchImpl));
  // Rute dikenal tapi metode salah → 405; benar-benar tidak dikenal → 404 (pemanggil bisa coba handler lain).
  const known = [...ROUTES.map(([route]) => route), 'providers/:id', 'providers/:id/test', 'conversations/:id', 'conversations/:id/messages'];
  if (known.some((r) => seg === r)) return json({ error: 'Metode tidak didukung' }, 405);
  return null;
}

export { currentUser, requireUser, publicUser, HttpError };