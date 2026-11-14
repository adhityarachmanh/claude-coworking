// bridge/src/store.mjs — lapisan penyimpanan di atas Netlify Blobs (@netlify/blobs, getStore).
// Di test dipakai driver Map palsu dengan interface yang sama persis:
//   get(key) -> Promise<string|null>, set(key, value), delete(key), list({ prefix }) -> Promise<{ blobs: [{ key }] }>
// Semua nilai string JSON. Kontrak di test: kredensial TUYA dan ownerToken tidak pernah plaintext
// di key/value mana pun (index token memakai hash SHA-256).
//
// Layout key:
//   space/<id>          → record space lengkap (kredensial + ownerToken terenkripsi di dalamnya)
//   token/<sha256hex>   → id space (index O(1) untuk auth; KEY-nya hash, bukan token plaintext)
//   ticket/h/<tiket>    → { spaceId, exp } — tiket serah-terima, SEKALI PAKAI (hapus di pemakaian pertama)
//   ticket/s/<tiket>    → { spaceId, exp } — tiket sesi polling halaman status, reusable sampai TTL
//   reg/<ip>/<yyyy-mm-dd> → hitungan pendaftaran per IP per hari (anti-abuse; key kemarin ikut dihapus)
//   pair/<sha256(kode)> → { spaceId, exp } — kode pasangan, SEKALI PAKAI; kode plaintext tidak pernah disimpan
//   pairSpace/<spaceId> → sha256(kode) — kode AKTIF milik space itu (satu saja; dihapus saat kode baru dibuat)
//   pairtry/<bucket>/<yyyy-mm-ddThh> → hitungan klaim kode GAGAL per jam (bucket = IP, atau '_global' untuk backstop)
//   pairtry/_globalm/<yyyy-mm-ddThh:mm> → hitungan klaim gagal GLOBAL per menit (pemulihan ≤ 1 menit)
import { createHash } from 'node:crypto';

const SPACE_PREFIX = 'space/';
const TOKEN_PREFIX = 'token/';
const TICKET_KINDS = { h: 'ticket/h/', s: 'ticket/s/' }; // h = handoff (sekali pakai), s = sesi polling
const REG_PREFIX = 'reg/';
const PAIR_PREFIX = 'pair/';
const PAIR_SPACE_PREFIX = 'pairSpace/';
const PAIR_TRY_PREFIX = 'pairtry/';
/** Bucket hitungan gagal global (batas total lintas IP) — IP asli tidak pernah diawali '_' (lihat clientIp). */
export const PAIR_GLOBAL_BUCKET = '_global';
/** Bucket hitungan gagal global PER MENIT: setelah cap tercapai, IP bersih pulih ≤ 1 menit (bukan sejam). */
export const PAIR_GLOBAL_MINUTE_BUCKET = '_globalm';

const jsonGet = async (env, key) => {
  const raw = await env.store.get(key);
  return raw == null ? null : JSON.parse(raw);
};
const jsonSet = (env, key, value) => env.store.set(key, JSON.stringify(value));

const tokenHashHex = (token) => createHash('sha256').update(token).digest('hex');
/** Hash token untuk index key — diekspor karena record space juga menyimpannya (tokenHash) untuk
 * penghapusan index tanpa harus dekripsi ownerToken (sweep retensi). */
export const tokenHashOf = tokenHashHex;

export const getSpace = (env, id) => jsonGet(env, SPACE_PREFIX + id);
export const putSpace = (env, space) => jsonSet(env, SPACE_PREFIX + space.id, space);
export const deleteSpace = (env, id) => env.store.delete(SPACE_PREFIX + id);

/** Semua space; record rusak (parse gagal) dilewati, bukan menghentikan sweep. */
export async function listSpaces(env) {
  const res = await env.store.list({ prefix: SPACE_PREFIX });
  const out = [];
  for (const blob of res.blobs) {
    try { out.push(await jsonGet(env, blob.key)); } catch { out.push(null); }
  }
  return out;
}

/** Index token: key = sha256(token) hex — snapshot store tidak boleh memuat token siap-pakai. */
export const spaceByToken = async (env, token) => {
  const id = await env.store.get(TOKEN_PREFIX + tokenHashHex(token));
  return id ? getSpace(env, id) : null;
};
export const putTokenIndex = (env, token, id) => env.store.set(TOKEN_PREFIX + tokenHashHex(token), id);
/** Hapus index lewat hash tersimpan di record space (space.tokenHash). */
export const deleteTokenIndexByHash = (env, hash) => env.store.delete(TOKEN_PREFIX + hash);

/** kind: 'h' (serah-terima, sekali pakai) | 's' (sesi polling, reusable sampai TTL). */
export const getTicket = (env, kind, t) => jsonGet(env, TICKET_KINDS[kind] + t);
export const putTicket = (env, kind, t, rec) => jsonSet(env, TICKET_KINDS[kind] + t, rec);
export const deleteTicket = (env, kind, t) => env.store.delete(TICKET_KINDS[kind] + t);

/** Hapus semua tiket (kedua jenis) milik satu space — dipakai delete manage & sweep retensi. */
export async function deleteTicketsOfSpace(env, spaceId) {
  for (const prefix of Object.values(TICKET_KINDS)) {
    const res = await env.store.list({ prefix });
    for (const blob of res.blobs) {
      let rec = null;
      try { rec = await jsonGet(env, blob.key); } catch { rec = null; }
      if (rec?.spaceId === spaceId) await env.store.delete(blob.key);
    }
  }
}

/** Anti-abuse register: hitung per IP per hari UTC. get+set (bukan atomik) cukup untuk throttle ini.
 * Key hari sebelumnya ikut dihapus: tanpa itu key reg/<ip>/<kemarin> menumpuk selamanya di store. */
export async function incrRegisterCount(env, ip, dayKey) {
  const res = await env.store.list({ prefix: `${REG_PREFIX}${ip}/` });
  for (const blob of res.blobs) {
    const day = blob.key.slice(REG_PREFIX.length + ip.length + 1); // 'yyyy-mm-dd'
    if (day < dayKey) await env.store.delete(blob.key); // tanggal lewat (urutan string = urutan waktu)
  }
  const key = `${REG_PREFIX}${ip}/${dayKey}`;
  const n = Number(await env.store.get(key)) || 0;
  await env.store.set(key, String(n + 1));
  return n + 1;
}

// ---------------------------------------------------------------- kode pasangan (pindah space ke perangkat lain)

/** Hash kode (sha256 hex) — key pair/ dan referensi di pairSpace/. */
export const pairCodeHash = tokenHashHex;

/** Kode tidak pernah disimpan: key = sha256(kode), value = { spaceId, exp }. */
export const putPairCode = (env, code, rec) => jsonSet(env, PAIR_PREFIX + pairCodeHash(code), rec);
export const getPairCode = (env, code) => getPairCodeByHash(env, pairCodeHash(code));
export const deletePairCode = (env, code) => env.store.delete(PAIR_PREFIX + pairCodeHash(code));

/** Cek tabrakan saat membuat kode: record yang masih berlaku tidak boleh ditimpa (milik space lain). */
export const getPairCodeByHash = (env, hash) => jsonGet(env, PAIR_PREFIX + hash);
export const deletePairCodeByHash = (env, hash) => env.store.delete(PAIR_PREFIX + hash);

/** Satu kode aktif per space: pairSpace/<spaceId> → hash kode terbaru. */
export const getPairSpaceCode = (env, spaceId) => env.store.get(PAIR_SPACE_PREFIX + spaceId);
export const putPairSpaceCode = (env, spaceId, hash) => env.store.set(PAIR_SPACE_PREFIX + spaceId, hash);
const deletePairSpaceCode = (env, spaceId) => env.store.delete(PAIR_SPACE_PREFIX + spaceId);
/** Hapus referensi HANYA kalau masih menunjuk hash ini (kode baru space yang sama tidak ikut terhapus). */
export async function deletePairSpaceCodeIf(env, spaceId, hash) {
  if ((await getPairSpaceCode(env, spaceId)) === hash) await deletePairSpaceCode(env, spaceId);
}

/** Hapus kode pasangan aktif milik satu space + referensinya (dipakai saat space dihapus / sweep retensi). */
export async function deletePairCodeOfSpace(env, spaceId) {
  const hash = await getPairSpaceCode(env, spaceId);
  if (hash) await deletePairCodeByHash(env, hash);
  await deletePairSpaceCode(env, spaceId);
}

/** Klaim kode yang GAGAL dihitung per bucket per slot waktu (jam untuk IP/'_global', menit untuk '_globalm'). */
export const pairFailures = async (env, bucket, slotKey) => Number(await env.store.get(`${PAIR_TRY_PREFIX}${bucket}/${slotKey}`)) || 0;

/** Naikkan hitungan gagal klaim untuk slot ini; key slot lampau milik bucket yang sama ikut dihapus. */
export async function incrPairFailure(env, bucket, slotKey) {
  const res = await env.store.list({ prefix: `${PAIR_TRY_PREFIX}${bucket}/` });
  for (const blob of res.blobs) {
    const slot = blob.key.slice(PAIR_TRY_PREFIX.length + bucket.length + 1); // 'yyyy-mm-ddThh' atau '…Thh:mm'
    if (slot < slotKey) await env.store.delete(blob.key); // urutan string = urutan waktu
  }
  const key = `${PAIR_TRY_PREFIX}${bucket}/${slotKey}`;
  const n = Number(await env.store.get(key)) || 0;
  await env.store.set(key, String(n + 1));
  return n + 1;
}

/** Buang hitungan klaim yang suffix-nya (jam 'yyyy-mm-ddThh' atau menit 'yyyy-mm-ddThh:mm') lebih lama dari
 *  `cutoffKey`. Dipakai cron: semua bucket (IP, '_global', '_globalm') dibersihkan sekaligus. */
export async function deleteOldPairAttempts(env, cutoffKey) {
  const res = await env.store.list({ prefix: PAIR_TRY_PREFIX });
  let removed = 0;
  for (const blob of res.blobs) {
    const suffix = blob.key.slice(blob.key.lastIndexOf('/') + 1); // bucket tidak memuat '/'
    if (suffix < cutoffKey) {
      await env.store.delete(blob.key);
      removed += 1;
    }
  }
  return removed;
}

/** Buang kode pasangan yang sudah kedaluwarsa (cron): kode yang tak pernah diklaim tidak boleh menumpuk selamanya. */
export async function deleteExpiredPairCodes(env, nowMs) {
  const res = await env.store.list({ prefix: PAIR_PREFIX });
  let removed = 0;
  for (const blob of res.blobs) {
    const hash = blob.key.slice(PAIR_PREFIX.length);
    let rec = null;
    try { rec = await jsonGet(env, blob.key); } catch { rec = null; } // record rusak: ikut dibuang
    if (!rec || !(rec.exp > nowMs)) {
      await env.store.delete(blob.key);
      if (rec?.spaceId) await deletePairSpaceCodeIf(env, rec.spaceId, hash); // referensi kode mati ikut bersih
      removed += 1;
    }
  }
  return removed;
}
