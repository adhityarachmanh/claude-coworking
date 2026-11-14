// bridge/src/bridge.mjs — inti jembatan remote power MULTI-TENANT (pengganti bridge/worker.js Cloudflare).
// Semua state di Netlify Blobs via driver pada env.store (lihat src/store.mjs); kredensial Tuya per-space
// terenkripsi (src/vault.mjs). env = { store, encryptionKey, cycleWaitMs? } — cycleWaitMs hanya untuk test.
//
// Kontrak untuk Adhitron (lihat README):
//   POST /api/heartbeat { ts, version }   header X-Bridge-Token → { ok }
//   POST /api/off?delay=300               header X-Bridge-Token → { ok, offAt, handoffUrl }
//   POST /api/on                          header X-Bridge-Token / X-Status-Token → { ok }
//   GET  /api/status                      header X-Bridge-Token / X-Status-Token → status lengkap
// PENTING: setelah /api/off, client WAJIB berhenti mengirim heartbeat sampai shutdown selesai —
// heartbeat dianggap bukti "PC ternyata hidup" dan MEMBATALKAN jadwal mati (aturan pembatalan spesifikasi).
import { randomBytes } from 'node:crypto';
import { assertEncryptionKey, decryptCreds, decryptSecret, encryptCreds, encryptSecret } from './vault.mjs';
import { drivePlug, isValidRegion, normalizeRegion, readPowerW } from './tuya.mjs';
import * as store from './store.mjs';
import {
  deletedPageHtml, errorPageHtml, managePageHtml,
  registerPageHtml, statusPageHtml, ticketExpiredHtml,
} from './pages.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token, X-Status-Token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
// CORS hanya untuk API JSON; halaman HTML tidak butuh CORS (B7) dan tidak boleh membawanya.
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };

const ALIVE_WINDOW_MS = 30 * 60_000;   // heartbeat lebih tua dari ini = PC dianggap mati/beku
const TICKET_TTL_MS = 10 * 60_000;     // umur tiket serah-terima
const REGISTER_LIMIT = 10;             // anti-abuse: 10 pendaftaran per IP per hari
const POWER_BOOT_W = 20;               // di atas ini dianggap "PC menarik daya"
const POWER_OFF_W = 5;                 // di bawah ini listrik dianggap benar-benar terputus
const BOOT_DETECT_MS = 30_000;         // power tinggi ≥ 30 dtk + heartbeat basi = booting/beku
const POWER_SAMPLE_MS = 30_000;        // jeda sampling Tuya (kuota API — polling 10 dtk tidak memanggil Tuya tiap kali)
const MAX_DELAY_S = 3600;              // batas delay jadwal mati
const DEFAULT_DELAY_S = 300;
const RETRY_DELAY_MS = 60_000;         // cron mencoba ulang pasien gagal-putus tiap menit
const MAX_ATTEMPTS = 3;                // habis ini → needsAttention, bukan loop tanpa batas
const RETENTION_UNUSED_MS = 30 * 86_400_000;    // didaftarkan tapi tak pernah dipakai (heartbeat 0) → 30 hari
const RETENTION_STALE_MS = 183 * 86_400_000;    // tanpa heartbeat lebih dari ±6 bulan → dihapus (C1)

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const hex = (n) => randomBytes(n).toString('hex');
// B1: no-store di SEMUA respons — respons register/manage membawa ownerToken; halaman membawa tiket.
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
const html = (text, status = 200) => new Response(text, { status, headers: HTML_HEADERS });

const isStr = (v, min = 1, max = 200) => typeof v === 'string' && v.length >= min && v.length <= max;

/** Validasi body register/manage → kredensial ternormalisasi; error = HttpError 400. */
function readCreds(body) {
  const out = {};
  for (const field of ['tuyaClientId', 'tuyaClientSecret', 'tuyaDeviceId']) {
    if (!isStr(body[field])) throw new HttpError(400, `${field} wajib string 1–200 karakter`);
    out[field] = body[field];
  }
  if (!isValidRegion(body.tuyaRegion)) throw new HttpError(400, 'tuyaRegion harus salah satu dari: eu, america, asia');
  out.tuyaRegion = normalizeRegion(body.tuyaRegion);
  return out;
}

function readAdhitronUrl(raw) {
  if (raw == null || raw === '') return null;
  if (!isStr(raw) || !raw.startsWith('https://')) throw new HttpError(400, 'adhitronUrl (kalau diisi) harus https:// dan ≤ 200 karakter');
  return raw;
}

/** IP client (Netlify header dulu), disanitasi untuk key Blobs. */
function clientIp(request) {
  const nf = request.headers.get('x-nf-client-connection-ip');
  const fwd = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
  return String(nf || fwd || 'unknown').replace(/[^0-9a-fA-F:.]/g, '_').slice(0, 64) || 'unknown';
}

/** ownerToken user dipulihkan dari simpanan terenkripsi (A3) — hanya server yang bisa; snapshot Blobs
 * tidak memuat token siap-pakai (di record cuma cipher, di index cuma hash). */
function ownerTokenOf(env, space) {
  return decryptSecret(env.encryptionKey, space.ownerTokenEnc);
}

/** Config Tuya untuk sebuah space — kredensial didekripsi saat dipakai, tidak pernah di-cache/di-log. */
function cfgFor(env, space) {
  const creds = decryptCreds(ownerTokenOf(env, space), env.encryptionKey, space.enc);
  return { region: creds.tuyaRegion, clientId: creds.tuyaClientId, clientSecret: creds.tuyaClientSecret, deviceId: creds.tuyaDeviceId };
}

/** Auth API: header X-Bridge-Token (ownerToken, dipakai Adhitron) atau X-Status-Token (ownerToken ATAU tiket).
 * Query ?token= TIDAK diterima di endpoint API — hanya di halaman HTML (aturan spesifikasi).
 * B4: token divalidasi sebelum jadi key Blobs — hex murni, 16–64 karakter, selain itu dianggap 401.
 * A1: tiket serah-terima (ticket/h/) SEKALI PAKAI — dihapus di pemakaian pertama di mana pun
 * (jalur header maupun jalur halaman); tiket sesi (ticket/s/) reusable sampai TTL. */
const TOKEN_RE = /^[0-9a-f]{16,64}$/;
async function requireSpace(env, request, headers = ['X-Bridge-Token', 'X-Status-Token']) {
  for (const name of headers) {
    const token = request.headers.get(name);
    if (!token) continue;
    if (!TOKEN_RE.test(token)) continue; // bukan hex valid → bukan token, biar jatuh ke 401
    const space = await store.spaceByToken(env, token);
    if (space) return space;
    for (const kind of ['h', 's']) {
      const ticket = await store.getTicket(env, kind, token);
      if (ticket && ticket.exp > Date.now()) {
        if (kind === 'h') await store.deleteTicket(env, kind, token); // serah-terima: habis di pemakaian pertama
        return store.getSpace(env, ticket.spaceId);
      }
    }
  }
  throw new HttpError(401, 'Unauthorized');
}

const readJson = async (request) => request.json().catch(() => { throw new HttpError(400, 'body harus JSON'); });

// ---------------------------------------------------------------- endpoint: register

async function register(request, env, url) {
  assertEncryptionKey(env.encryptionKey); // 500 jelas kalau operator lupa env var — bukan 502 samar
  const body = await readJson(request);
  const creds = readCreds(body);
  const adhitronUrl = readAdhitronUrl(body.adhitronUrl);
  const count = await store.incrRegisterCount(env, clientIp(request), new Date().toISOString().slice(0, 10));
  if (count > REGISTER_LIMIT) throw new HttpError(429, 'Batas 10 pendaftaran per IP per hari. Coba besok atau hubungi operator situs.');
  let id = hex(4);
  while (await store.getSpace(env, id)) id = hex(4); // 8-char hex, tahan bentrokan
  const ownerToken = hex(32);
  const now = Date.now();
  const space = {
    id,
    // A3: token tidak pernah plaintext di store — cipher (key dari ENCRYPTION_KEY saja, cron tetap
    // bisa dekripsi) di record, sha256(token) sebagai key index. Snapshot Blobs tanpa token siap-pakai.
    ownerTokenEnc: encryptSecret(env.encryptionKey, ownerToken),
    tokenHash: store.tokenHashOf(ownerToken),
    enc: encryptCreds(ownerToken, env.encryptionKey, creds),
    adhitronUrl,
    lastHeartbeat: 0,
    offAt: null,
    offAtWrittenAt: 0,
    powerW: null,
    powerAt: 0,
    powerHighSince: null,
    attempts: 0,
    needsAttention: false,
    lastPlug: null,
    version: null,
    createdAt: now,
  };
  await store.putSpace(env, space);
  await store.putTokenIndex(env, ownerToken, id);
  return json({
    ok: true,
    id,
    token: ownerToken,
    bridgeUrl: url.origin, // tempel ini + token di panel ⚙ Remote power Adhitron
    statusUrl: `/s/${id}`,
    manageUrl: `/manage?token=${ownerToken}`,
  });
}

// ---------------------------------------------------------------- endpoint: heartbeat

async function heartbeat(request, env) {
  const space = await requireSpace(env, request, ['X-Bridge-Token']);
  const body = await request.json().catch(() => ({}));
  const now = Date.now();
  // ATURAN PEMBATALAN (spesifikasi): offAt masih di masa depan + heartbeat datang setelah jadwal ditulis
  // → PC ternyata hidup lagi → jadwal mati dibatalkan.
  const cancelled = space.offAt != null && space.offAt > now && space.offAtWrittenAt < now;
  if (cancelled) space.offAt = null;
  // Throttle tulis: ≥ 1 menit antar-heartbeat cukup; tapi saat jadwal baru ditulis (batal/batal-baru) selalu tulis.
  const throttled = !cancelled && space.lastHeartbeat > 0 && now - space.lastHeartbeat < 60_000;
  if (!throttled) {
    space.lastHeartbeat = now;
    space.version = String(body.version ?? '').slice(0, 40);
    await store.putSpace(env, space);
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------- endpoint: off / on / status

async function off(url, request, env) {
  const space = await requireSpace(env, request);
  const raw = url.searchParams.get('delay');
  let delay = DEFAULT_DELAY_S;
  if (raw !== null) {
    delay = Number(raw);
    if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_S) {
      throw new HttpError(400, `delay harus bilangan bulat 0–${MAX_DELAY_S} detik`);
    }
  }
  const now = Date.now();
  space.offAt = now + delay * 1000;
  space.offAtWrittenAt = now;
  space.attempts = 0;
  space.needsAttention = false;
  let fired = false;
  if (delay === 0) { // tanpa jeda: langsung memutus (jadwal tersisa = no-op untuk cron, plug sudah off)
    await drivePlug(await cfgFor(env, space), false, env.cycleWaitMs);
    space.lastPlug = 'off';
    fired = true;
  }
  // Tiket serah-terima sekali pakai (A1, jenis 'h'): user PC membuka halaman status TANPA token
  // jangka panjang; pemakaian pertama — lewat halaman ATAU header — menghapusnya.
  const ticket = hex(32);
  await store.putTicket(env, 'h', ticket, { spaceId: space.id, exp: now + TICKET_TTL_MS });
  await store.putSpace(env, space);
  return json({ ok: true, offAt: space.offAt, fired, handoffUrl: `/s/${space.id}?t=${ticket}` });
}

async function on(request, env) {
  const space = await requireSpace(env, request);
  space.offAt = null; // spec: /api/on menghapus jadwal mati yang menunggu
  space.attempts = 0;
  space.needsAttention = false;
  await store.putSpace(env, space); // simpan dulu: gagal Tuya pun jadwal sudah batal, user bisa coba lagi
  await drivePlug(await cfgFor(env, space), true, env.cycleWaitMs); // ON yang sudah-ON disiklus OFF → ON (BIOS)
  space.lastPlug = 'on';
  space.powerHighSince = null; // monitor boot mulai segar
  await store.putSpace(env, space);
  return json({ ok: true });
}

/** Sampling daya (dibatasi POWER_SAMPLE_MS) + pemeliharaan powerHighSince; mutasi space dan menyimpannya. */
async function samplePower(env, space, now) {
  if (now - space.powerAt < POWER_SAMPLE_MS) return;
  space.powerAt = now; // tandai dulu: kegagalan Tuya tidak boleh membuat tiap poll memanggil Tuya
  try {
    const w = await readPowerW(await cfgFor(env, space));
    if (w != null) {
      space.powerW = w;
      space.powerHighSince = w > POWER_BOOT_W ? (space.powerHighSince ?? now) : null;
    }
  } catch { /* Tuya gagal: pertahankan sampel lama */ }
  await store.putSpace(env, space);
}

/** Status murni dari record (tanpa sampling) — dipakai API dan halaman. */
function statusOf(space, now) {
  const alive = space.lastHeartbeat > 0 && now - space.lastHeartbeat < ALIVE_WINDOW_MS;
  const booting = !alive
    && space.powerW != null && space.powerW > POWER_BOOT_W
    && space.powerHighSince != null && now - space.powerHighSince >= BOOT_DETECT_MS;
  return {
    id: space.id,
    alive,
    offAt: space.offAt ?? null,
    secondsUntilOff: space.offAt != null && space.offAt > now ? Math.ceil((space.offAt - now) / 1000) : null,
    plug: space.lastPlug ?? null,
    powerW: space.powerW ?? null,
    powerAt: space.powerAt || null,
    booting,
    needsAttention: !!space.needsAttention,
    lastHeartbeat: space.lastHeartbeat || null,
    adhitronUrl: space.adhitronUrl ?? null,
  };
}

async function apiStatus(request, env) {
  const space = await requireSpace(env, request);
  const now = Date.now();
  await samplePower(env, space, now);
  return json(statusOf(space, now));
}

// ---------------------------------------------------------------- halaman HTML

async function statusPage(env, id, url) {
  const space = await store.getSpace(env, id);
  if (!space) throw new HttpError(404, 'Space tidak ditemukan');
  const now = Date.now();
  const ticketValue = url.searchParams.get('t');
  const ownerToken = url.searchParams.get('token');
  let pollToken = null;
  let fromTicket = false;
  if (ticketValue !== null) {
    // Tiket serah-terima (jenis 'h') SEKALI PAKAI: dipakai → dihapus, lalu dicetak tiket sesi (jenis
    // 's', reusable) untuk polling halaman.
    const ticket = await store.getTicket(env, 'h', ticketValue);
    if (!ticket || ticket.spaceId !== id || ticket.exp <= now) return html(ticketExpiredHtml(), 401);
    await store.deleteTicket(env, 'h', ticketValue);
    pollToken = hex(32);
    await store.putTicket(env, 's', pollToken, { spaceId: id, exp: now + TICKET_TTL_MS });
    fromTicket = true;
  } else if (ownerToken !== null) {
    const byToken = await store.spaceByToken(env, ownerToken);
    if (!byToken || byToken.id !== id) throw new HttpError(401, 'Token tidak dikenal');
    pollToken = ownerToken;
  } else {
    throw new HttpError(401, 'Butuh ?t=<tiket> atau ?token=<ownerToken>');
  }
  await samplePower(env, space, now);
  const st = statusOf(space, now);
  return html(statusPageHtml(id, pollToken, fromTicket, st, space.adhitronUrl));
}

async function managePage(env, url) {
  const space = await requireOwnerQuery(env, url);
  const creds = decryptCreds(ownerTokenOf(env, space), env.encryptionKey, space.enc);
  return html(managePageHtml(space, url.searchParams.get('token'), creds));
}

/** Halaman manage hanya menerima ownerToken lewat query (aturan spesifikasi: ?token= untuk halaman HTML). */
async function requireOwnerQuery(env, url) {
  const token = url.searchParams.get('token');
  if (!token) throw new HttpError(401, 'Token tidak dikenal');
  const space = await store.spaceByToken(env, token);
  if (!space) throw new HttpError(401, 'Token tidak dikenal');
  return space;
}

async function manageAction(env, url, request) {
  const space = await requireOwnerQuery(env, url);
  const form = new URLSearchParams(await request.text());
  const action = form.get('action');
  if (action === 'update') {
    const old = decryptCreds(ownerTokenOf(env, space), env.encryptionKey, space.enc);
    const body = {
      tuyaClientId: form.get('tuyaClientId'),
      tuyaClientSecret: form.get('tuyaClientSecret') || old.tuyaClientSecret, // kosong = tetap pakai lama
      tuyaDeviceId: form.get('tuyaDeviceId'),
      tuyaRegion: form.get('tuyaRegion'),
    };
    const creds = readCreds(body);
    space.adhitronUrl = readAdhitronUrl(form.get('adhitronUrl'));
    space.enc = encryptCreds(ownerTokenOf(env, space), env.encryptionKey, creds);
    await store.putSpace(env, space);
    return html(managePageHtml(space, url.searchParams.get('token'), creds, { notice: '<div class="note">✅ Tersimpan.</div>' }));
  }
  if (action === 'rotate') {
    const creds = decryptCreds(ownerTokenOf(env, space), env.encryptionKey, space.enc);
    const newToken = hex(32);
    space.enc = encryptCreds(newToken, env.encryptionKey, creds); // key turunan dari token → wajib re-encrypt
    // A3: rotasi ikut memutar hash index dan simpanan token terenkripsi.
    await store.deleteTokenIndexByHash(env, space.tokenHash);
    space.ownerTokenEnc = encryptSecret(env.encryptionKey, newToken);
    space.tokenHash = store.tokenHashOf(newToken);
    await store.putSpace(env, space);
    await store.putTokenIndex(env, newToken, space.id);
    return html(managePageHtml(space, newToken, creds, { newToken, notice: '<div class="note">🔁 Token dirotasi — token lama mati.</div>' }));
  }
  if (action === 'delete') {
    if (form.get('confirm') !== 'HAPUS') throw new HttpError(400, 'Hapus wajib konfirmasi: centang kotak "Saya yakin".');
    await store.deleteTokenIndexByHash(env, space.tokenHash);
    await store.deleteTicketsOfSpace(env, space.id); // tiket milik space ikut mati
    await store.deleteSpace(env, space.id);
    return html(deletedPageHtml(space.id));
  }
  throw new HttpError(400, 'action tidak dikenal');
}

// ---------------------------------------------------------------- dispatcher + cron

/** Semua rute jembatan. Error HttpError → statusnya; error lain → 502 (mis. Tuya menolak). */
export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    if (path === '/' && request.method === 'GET') return html(registerPageHtml());
    if (path === '/api/space' && request.method === 'POST') return await register(request, env, url);
    if (path === '/manage' && request.method === 'GET') return await managePage(env, url);
    if (path === '/api/manage' && request.method === 'POST') return await manageAction(env, url, request);
    if (path === '/s' || path === '/s/') return html(errorPageHtml('Link tidak lengkap', 'URL halaman status: /s/<id>?t=<tiket>'));
    if (path.startsWith('/s/') && request.method === 'GET') return await statusPage(env, path.slice(3), url);
    if (path === '/api/heartbeat' && request.method === 'POST') return await heartbeat(request, env);
    if (path === '/api/off' && request.method === 'POST') return await off(url, request, env);
    if (path === '/api/on' && request.method === 'POST') return await on(request, env);
    if (path === '/api/status' && request.method === 'GET') return await apiStatus(request, env);
    return json({ error: 'Tidak ditemukan' }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    return json({ error: String(err?.message ?? err) }, 502);
  }
}

/** Cron tiap menit: satu pass, satu tindakan per space — tidak pernah loop tanpa batas.
 * Retensi dulu (C1): space tak pernah dipakai > 30 hari atau tanpa heartbeat > ±6 bulan dihapus.
 * offAt jatuh tempo → PC hidup setelah jadwal ditulis? batal. Else: plug OFF + verifikasi daya:
 * < 5 W sukses; masih tinggi → coba ulang (+60 dtk); 3× gagal → needsAttention (bukan loop). */
export async function scheduledSweep(env, nowMs = Date.now()) {
  const spaces = await store.listSpaces(env);
  const results = [];
  for (const space of spaces) {
    if (!space) continue;
    // C1 — retensi (kepatuhan): space yang tidak pernah dipakai (> 30 hari sejak daftar, heartbeat 0)
    // atau sudah lama mati (tanpa heartbeat > ±6 bulan) dihapus otomatis, termasuk index token dan
    // semua tiketnya (pola sama dengan delete di manage).
    const deadSince = space.lastHeartbeat > 0
      ? nowMs - space.lastHeartbeat > RETENTION_STALE_MS
      : space.createdAt < nowMs - RETENTION_UNUSED_MS;
    if (deadSince) {
      if (space.tokenHash) await store.deleteTokenIndexByHash(env, space.tokenHash);
      await store.deleteTicketsOfSpace(env, space.id);
      await store.deleteSpace(env, space.id);
      results.push({ id: space.id, action: 'retention-delete' });
      continue;
    }
    if (space.offAt == null || space.offAt > nowMs) continue;
    if (space.lastHeartbeat > space.offAtWrittenAt) { // PC ternyata hidup setelah jadwal ditulis → batal
      space.offAt = null;
      await store.putSpace(env, space);
      results.push({ id: space.id, action: 'cancel' });
      continue;
    }
    let cfg;
    try {
      cfg = await cfgFor(env, space);
    } catch {
      applyRetry(space, nowMs); // kredensial korup: coba ulang beberapa kali lalu minta perhatian
      await store.putSpace(env, space);
      results.push({ id: space.id, action: 'decrypt-failed' });
      continue;
    }
    try {
      await drivePlug(cfg, false); // OFF saja, tidak siklus
      space.lastPlug = 'off';
    } catch {
      applyRetry(space, nowMs);
      await store.putSpace(env, space);
      results.push({ id: space.id, action: 'tuya-failed' });
      continue;
    }
    let w = null;
    try { w = await readPowerW(cfg); } catch { w = null; }
    if (w != null) {
      space.powerW = w;
      space.powerAt = nowMs;
      space.powerHighSince = w > POWER_BOOT_W ? (space.powerHighSince ?? nowMs) : null;
    }
    if (w == null || w < POWER_OFF_W) {
      // Terputus (atau plug tanpa sensor daya — komando OFF sudah sukses dikirim).
      space.offAt = null;
      space.attempts = 0;
      space.needsAttention = false;
      results.push({ id: space.id, action: 'off', powerW: w });
    } else {
      applyRetry(space, nowMs);
      results.push({ id: space.id, action: 'retry', powerW: w });
    }
    await store.putSpace(env, space);
  }
  return results;
}

/** Satu percobaan ulang = attempts naik; di batas → jadwal dihentikan + minta perhatian manusia. */
function applyRetry(space, nowMs) {
  space.attempts += 1;
  if (space.attempts >= MAX_ATTEMPTS) {
    space.offAt = null;
    space.needsAttention = true; // halaman status: "⚠ gagal memutus — cek plug manual"
  } else {
    space.offAt = nowMs + RETRY_DELAY_MS;
  }
}
