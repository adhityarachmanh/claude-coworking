// bridge/src/rate-limit.mjs — pembatas laju sederhana berbasis counter di store (Netlify Blobs:
// get/set/list/delete). Bukan atomik (get+set) — cukup untuk meredam brute force, sama seperti
// throttle register jembatan. Setiap bucket punya jendela; key lama di prefix itu dibersihkan saat diakses.
//
// Konvensi key: rate/<nama>/<bucket>/<jendela>. Urutan string jendela = urutan waktu (ISO), jadi key
// kedaluwarsa bisa dihapus tanpa menghitung. Bucket biasanya IP (diawali karakter IP) atau id user.

const PREFIX = 'rate/';

/** Hitung satu percobaan pada bucket `name`/`id`. Mengembalikan { count, allowed }. */
export async function hit(env, { name, id, window, limit, now = Date.now() }) {
  const bucketKey = `${PREFIX}${name}/${id}/`;
  // Bersihkan jendela lampau untuk bucket ini saja (batasi list ke prefix sempit).
  const res = await env.store.list({ prefix: bucketKey });
  const key = `${bucketKey}${window}`;
  for (const blob of res.blobs) if (blob.key !== key) await env.store.delete(blob.key);
  const n = Number(await env.store.get(key)) || 0;
  const count = n + 1;
  await env.store.set(key, String(count));
  return { count, allowed: count <= limit };
}

/** Jendela tetap dalam UTC: 'yyyy-mm-ddThh:mm' (menit) atau 'yyyy-mm-ddThh' (jam) atau 'yyyy-mm-dd'. */
export const minuteWindow = (now = Date.now()) => new Date(now).toISOString().slice(0, 16);
export const hourWindow = (now = Date.now()) => new Date(now).toISOString().slice(0, 13);
export const dayWindow = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);