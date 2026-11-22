// bridge/src/chat-list.mjs — pengelompokan riwayat percakapan berdasarkan waktu (gaya claude.ai).
// Murni: tanpa impor, tanpa I/O, tanpa referensi luar — supaya bisa (a) dites langsung dan (b) disematkan
// ke string klien /chat lewat `groupConversations.toString()` (satu sumber kebenaran, anti-drift by
// construction). Karena itu fungsi ini WAJIB berdiri sendiri: semua konstanta ada di dalam badan fungsi.
//
// Kelompok memakai HARI KALENDER LOKAL (bukan selisih 24 jam), sehingga batas Hari ini/Kemarin tepat
// walau ada pergeseran DST.

/**
 * Kelompokkan percakapan ke [Hari ini, Kemarin, 7 hari terakhir, Lebih lama].
 * @param {Array<{updatedAt?: string}>} convs daftar percakapan (biasanya sudah terurut dari server).
 * @param {number} nowMs waktu "sekarang" (Date.now()).
 * @returns {Array<{key:string,label:string,items:Array}>} hanya kelompok yang tidak kosong, terurut.
 */
export function groupConversations(convs, nowMs) {
  const GROUPS = [
    ['today', 'Hari ini'],
    ['yesterday', 'Kemarin'],
    ['week', '7 hari terakhir'],
    ['older', 'Lebih lama'],
  ];
  const DAY = 86400000;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayStart = startOfDay(new Date(nowMs));
  const list = Array.isArray(convs) ? convs.slice() : [];
  const keyOf = (c) => {
    const t = Date.parse(c && c.updatedAt);
    if (!Number.isFinite(t)) return 'older';
    // Selisih hari kalender lokal; dibulatkan agar aman terhadap DST (23/25 jam).
    const daysAgo = Math.round((todayStart - startOfDay(new Date(t))) / DAY);
    if (daysAgo <= 0) return 'today';        // termasuk tanggal di masa depan (jam perangkat bergeser)
    if (daysAgo === 1) return 'yesterday';
    if (daysAgo < 7) return 'week';
    return 'older';
  };
  // Terbaru dulu di dalam tiap kelompok; tanggal tak valid dianggap paling lama.
  list.sort((a, b) => (Date.parse(b && b.updatedAt) || 0) - (Date.parse(a && a.updatedAt) || 0));
  const out = [];
  for (const [key, label] of GROUPS) {
    const items = list.filter((c) => keyOf(c) === key);
    if (items.length) out.push({ key, label, items });
  }
  return out;
}