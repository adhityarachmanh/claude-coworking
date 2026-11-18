// ⚡ Aksi daya (⏻ Matikan PC) dari HP: satu aturan akses, dipakai server.js dan src/routes/misc.js.
//
// Laptop selalu boleh (isLocal: http di 127.0.0.1). HP hanya boleh lewat tautan HTTPS Tailscale — socket TLS
// yang terenkripsi DAN bukan read-only (readOnly = HP WiFi HTTP yang cookie-nya bisa disadap). HP WiFi HTTP
// tetap DILARANG: gate read-only di server.js tidak dilemahkan sama sekali.
//
// Fungsi murni (tanpa server, tanpa I/O) supaya bisa diuji langsung di test/power.test.mjs.

/** Pesan 403 yang sama di gate server.js dan di pertahanan berlapis route (satu sumber teks). */
export const POWER_SECURE_ERROR = 'Aksi daya hanya lewat Tailscale (HTTPS).';

/**
 * Boleh melakukan aksi daya?
 * @param {{ local?: boolean, secure?: boolean, readOnly?: boolean }} access
 *   local: request dari laptop · secure: masuk lewat listener https (Tailscale) · readOnly: HP WiFi HTTP.
 * @returns {boolean} true = boleh; tanpa penanda apa pun hasilnya false (fail closed).
 */
export const powerAllowed = ({ local, secure, readOnly }) => Boolean(local) || (Boolean(secure) && !readOnly);

/**
 * URL jembatan yang aman ditampilkan ke browser: hanya `https:` absolut, tanpa kredensial, query string dan hash.
 * Operator kadang menempel `https://bridge/?token=…` — token itu tidak boleh ikut terkirim ke browser.
 * @returns {string|null} url bersih (origin + path), atau null bila tidak valid / bukan https.
 */
export function safeBridgeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname) return null;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.origin + (url.pathname === '/' ? '' : url.pathname);
}

/**
 * Berapa detik Windows menunggu sebelum benar-benar mati. Waktu ini yang dipakai UI ("mati dalam 45 dtk") dan
 * argumen `/t`, jadi satu sumber: jangan sampai teks dan perintah berbeda.
 */
export const PC_SHUTDOWN_SECONDS = 45;

/**
 * Perintah OS shutdown yang dipakai route ⏻ Matikan PC. Path absolut (tidak bergantung PATH proses — kalau
 * `shutdown.exe` tidak ketemu, Windows tidak pernah menerima perintah dan dulu tidak ada yang tahu), dan `/f`
 * eksplisit: aplikasi yang memblokir tidak boleh membuat PC tetap hidup setelah kamu mengira ia mati.
 * @param {string} [platform] default process.platform
 * @param {Record<string, string|undefined>} [env] default process.env (SystemRoot/windir untuk folder Windows)
 * @returns {{ command: string, args: string[] }}
 */
export function pcShutdownPlan(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const root = String(env?.SystemRoot || env?.windir || 'C:\\Windows').replace(/[\\/]+$/, '');
    return { command: `${root}\\System32\\shutdown.exe`, args: ['/s', '/t', String(PC_SHUTDOWN_SECONDS), '/f'] };
  }
  return { command: 'shutdown', args: ['-h', '+1'] };
}

/**
 * Status jembatan remote power untuk UI (⚙/📱): cukup untuk menampilkan tombol dan URL-nya.
 * Token jembatan TIDAK pernah ikut — sama seperti remotePower() tidak pernah dikirim utuh ke HP.
 * `configured` mengikuti setelan di hub (bridgeUrl + token ada); `bridgeUrl` hanya URL https yang sudah
 * disanitasi (null bila setelannya tidak bisa dipakai sebagai tautan).
 * @returns {{ configured: boolean, bridgeUrl: string|null, offDelaySec: number }}
 */
export function powerStatus(hub) {
  const rp = hub?.remotePower?.() ?? {};
  const bridgeUrl = String(rp.bridgeUrl ?? '');
  const token = String(rp.token ?? '');
  const offDelaySec = Number(rp.offDelaySec ?? 120);
  return { configured: Boolean(bridgeUrl && token), bridgeUrl: safeBridgeUrl(bridgeUrl), offDelaySec };
}
