// bridge/src/db.mjs — adaptor tipis ke Neon Postgres lewat @neondatabase/serverless (driver HTTP).
// Netlify Functions cocok dengan driver HTTP (satu request per query, tanpa koneksi persisten).
// Modul ini SENGAJA mengimpor driver secara lazy: seluruh logika & test berjalan lewat repo in-memory
// (src/repo-memory.mjs) tanpa perlu paket Neon terpasang, dan hanya jalur produksi/integrasi yang menyentuhnya.
//
// Kontrak yang dipakai seluruh kode lain (repo SQL):
//   db.query(text, params?) -> Promise<Array<row>>
// Inilah satu-satunya permukaan yang harus dipenuhi implementasi lain (mis. memory) agar repo bisa ditukar.

/** Apakah sebuah string terlihat seperti connection string Postgres/Neon. */
export const isConnectionString = (value) =>
  typeof value === 'string' && /^postgres(ql)?:\/\//i.test(value.trim());

/**
 * Buat `db` dari connection string Neon. Driver diimpor dinamis supaya modul ini tidak gagal di
 * lingkungan yang belum memasang @neondatabase/serverless (dev lokal, test cepat).
 * @param {string} databaseUrl
 * @returns {Promise<{query: (text: string, params?: unknown[]) => Promise<object[]>}>}
 */
export async function createNeonDb(databaseUrl) {
  if (!isConnectionString(databaseUrl)) {
    throw new Error('DATABASE_URL tidak valid (harus postgres:// atau postgresql://)');
  }
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(databaseUrl);
  return {
    // sql.query mengembalikan array baris. Param selalu diteruskan sebagai array agar tidak ada
    // interpolasi string ke SQL (mencegah injeksi lewat nilai user).
    query: (text, params = []) => sql.query(text, params),
  };
}