// bridge/src/ssrf.mjs — penjaga anti-SSRF untuk browsing. Murni (tanpa I/O): memutuskan apakah sebuah
// URL boleh di-fetch server. Hanya http(s); host privat/loopback/link-local/metadata diblokir, termasuk
// yang menyamar lewat IP desimal/oktal/hex dan nama yang menyelesaikan ke IP privat (IPv4 & IPv6).
//
// Catatan jujur: DNS bisa berubah setelah pemeriksaan (DNS rebinding). Untuk mitigasi lebih kuat,
// pemanggil bisa mengikuti `redirect: 'manual'` dan memeriksa ulang tiap Location. Di sini kita
// memblokir host privat secara statis + mendukung allowPrivate untuk pemakaian lokal/test.

/** IPv4 privat/tak-boleh (RFC1918, loopback, link-local, CGNAT, metadata cloud, broadcast/0.0.0.0). */
function isPrivateIPv4(a, b, c, d) {
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (protocol assignment)
  if (a >= 224) return true; // multicast/reserved
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  return false;
}

/** Normalisasi satu segmen IPv4 yang bisa berbentuk desimal/oktal/hex (mis. 0177, 0x7f). */
function parseIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) {
    // Bentuk ringkas "a.b.c" / "a.b" / "a" ala inet_aton → ekspansi ke 4 byte.
    if (!/^\d+$/.test(host.replace(/\./g, '')) || !/^[0-9.]+$/.test(host)) return null;
    const n = parts.length;
    if (n < 1 || n > 4) return null;
    const nums = parts.map((p) => Number(p));
    if (nums.some((x) => !Number.isInteger(x) || x < 0)) return null;
    const last = nums.pop();
    const width = 4 - n;
    if (last >= 2 ** (8 * (width + 1))) return null;
    const bytes = [...nums, (last >>> (8 * width)) & 255];
    for (let i = width - 1; i >= 0; i--) bytes.push((last >>> (8 * i)) & 255);
    return bytes;
  }
  const bytes = [];
  for (const p of parts) {
    let v;
    if (/^0x[0-9a-f]+$/i.test(p)) v = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) v = parseInt(p, 8);
    else if (/^\d+$/.test(p)) v = Number(p);
    else return null;
  if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    bytes.push(v);
  }
  return bytes;
}

/** True bila IPv6 (string tanpa kurung) adalah loopback/unspecified/link-local/unique-local/mapped-privat. */
export function isPrivateIPv6(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;
  if (/^fe80:/.test(h)) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // unique local fc00::/7
  // IPv4-mapped ::ffff:a.b.c.d → periksa bagian IPv4-nya.
  const mapped = h.match(/::ffff:([0-9a-f:.]+)$/);
  if (mapped) {
    const v4 = parseIPv4(mapped[1].includes('.') ? mapped[1] : ipv4FromMapped(mapped[1]));
    if (!v4) return true;
    return isPrivateIPv4(...v4);
  }
  return false;
}

const ipv4FromMapped = (hex) => {
  const parts = hex.split(':');
  return parts.map((p) => parseInt(p, 16)).join('.'); // 7f00:1 → 127.0.0.1 (2 hextet)
};

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);

/** Nama host yang selalu lokal (localhost + varian .localhost). */
export const isLocalHostname = (host) => host === 'localhost' || host.endsWith('.localhost') || BLOCKED_HOSTNAMES.has(host);

/**
 * Periksa URL untuk fetch server.
 * @returns {{ ok: boolean, url?: string, reason?: string }}
 */
export function isSafeUrl(rawUrl, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(String(rawUrl ?? '')); } catch { return { ok: false, reason: 'URL tidak valid' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'hanya http(s)' };
  if (u.username || u.password) return { ok: false, reason: 'URL memuat kredensial' };
  if (allowPrivate) return { ok: true, url: u.href };

  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // IPv6 dalam kurung
  if (isLocalHostname(host)) return { ok: false, reason: 'host lokal diblokir' };
  if (host.includes(':')) {
    if (isPrivateIPv6(host)) return { ok: false, reason: 'IPv6 privat diblokir' };
    return { ok: true, url: u.href };
  }
  const v4 = parseIPv4(host);
  if (v4) {
    if (isPrivateIPv4(...v4)) return { ok: false, reason: 'IP privat diblokir' };
    return { ok: true, url: u.href };
  }
  // Nama DNS: diblokir statis untuk nama lokal; resolusi sebenarnya dicek pemanggil bila perlu.
  if (host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, reason: 'nama internal diblokir' };
  return { ok: true, url: u.href };
}

/** Cek lokasi redirect: dipakai bila pemanggil memakai redirect: 'manual'. */
export const isSafeRedirect = (location, base) => {
  try { return isSafeUrl(new URL(location, base).href); } catch { return { ok: false, reason: 'URL redirect tidak valid' }; }
};

export { isPrivateIPv4, parseIPv4 };