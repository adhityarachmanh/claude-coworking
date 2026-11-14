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
import { createHash } from 'node:crypto';

const SPACE_PREFIX = 'space/';
const TOKEN_PREFIX = 'token/';
const TICKET_KINDS = { h: 'ticket/h/', s: 'ticket/s/' }; // h = handoff (sekali pakai), s = sesi polling
const REG_PREFIX = 'reg/';

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
