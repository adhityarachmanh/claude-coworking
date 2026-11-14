// bridge/src/tuya.mjs — adapter Tuya Cloud (Bardi / Smart Life), diporting dari bridge/worker.js lama.
// Config kini per-space (bukan env): cfg = { region, clientId, clientSecret, deviceId } — hasil dekripsi
// vault.mjs. Logika Tuya dipakai ulang apa adanya: HMAC-SHA256 dua lapis (token lalu komando),
// ON disiklus OFF → ON karena BIOS butuh kejadian listrik baru.
// Kredensial tidak pernah di-log dan tidak pernah masuk respons HTTP.

const REGIONS = {
  eu: 'https://openapi.tuyaeu.com',      // Eropa Barat — plug Bardi Indonesia biasanya terdaftar di sini
  america: 'https://openapi.tuyaus.com', // Amerika
  asia: 'https://openapi.tuyacn.com',    // Tiongkok / Asia
};

/** Nama region spesifikasi bridge ini: eu | america | asia. Alias portal lama dikanonisasi. */
export function normalizeRegion(region) {
  const r = String(region ?? '').trim().toLowerCase();
  if (r === 'us') return 'america';
  if (r === 'cn') return 'asia';
  return r;
}

export function isValidRegion(region) {
  return normalizeRegion(region) in REGIONS;
}

const sha256Hex = async (text) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};
const hmacHex = async (secret, text) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
};

/** Error adapter Tuya dengan kode STABIL (bukan pesan mentah Tuya) supaya pemanggil bisa memetakan
 *  status HTTP tanpa menebak isi pesan. `message` selalu teks tetap; `detail`/`hint` hanya untuk
 *  KLASIFIKASI internal (kode numerik + pesan Tuya) dan TIDAK PERNAH dikirim ke klien. */
export class TuyaError extends Error {
  constructor(code, message, { status = null, detail = null, hint = null } = {}) {
    super(message);
    this.name = 'TuyaError';
    this.code = code;     // TOKEN_REJECTED | DEVICE_REJECTED | NOT_A_PLUG | API_REJECTED | TUYA_BUSY | NETWORK
    this.status = status; // status HTTP respons Tuya kalau ada
    this.detail = detail; // kode error numerik Tuya kalau ada
    this.hint = hint === null || hint === undefined ? null : String(hint).slice(0, 200); // pesan Tuya, internal saja
  }
}

const TUYA_TIMEOUT_MS = 10_000; // B5: Tuya tidak boleh menggantung request sampai timeout platform
const devicePath = (cfg) => `/v1.0/devices/${encodeURIComponent(cfg.deviceId)}`; // ID user tidak boleh mengubah path

// Kode error Tuya IoT Cloud yang dikenal → kelas pesan aman (tanpa JSON mentah / kredensial).
const TUYA_SIGN_CODES = new Set([1004, 1005, 1006, 1010, 1011, 1012]); // sign / client id / timestamp / token
const TUYA_DEVICE_CODES = new Set([1106, 2009]);                      // permission deny / device tidak ada
const TUYA_QUOTA_CODES = new Set([28841002, 28841105]);               // paket berakhir / kuota / rate limit

/** Pesan publik STABIL per kelas error. Semua konstan: tidak memuat Client ID/Secret/Device ID. */
const PUBLIC_MESSAGE = {
  TOKEN_REJECTED: 'Client ID/Secret atau region ditolak Tuya.',
  DEVICE_REJECTED: 'Device ID tidak ada di project ini (pastikan akun Smart Life sudah di-link).',
  NOT_A_PLUG: 'Device ini bukan smart plug dengan saklar.',
  TUYA_BUSY: 'Tuya sedang menolak permintaan (kuota/limit). Coba lagi nanti.',
  NETWORK: 'Tidak bisa menghubungi Tuya Cloud, coba lagi.',
};

const KNOWN_CLASSES = new Set(Object.keys(PUBLIC_MESSAGE));

/** Kelas aman sebuah error Tuya: kode internal yang sudah stabil, atau klasifikasi dari kode/pesan Tuya.
 *  API_REJECTED yang tidak dikenal diperlakukan sebagai TUYA_BUSY (gangguan sementara) — lebih jujur
 *  daripada menuduh Device ID salah saat masalahnya kuota. */
function classOf(err) {
  const code = err?.code;
  if (KNOWN_CLASSES.has(code)) return code; // sudah dinormalisasi (verifyCreds) atau NETWORK/NOT_A_PLUG
  if (code !== 'API_REJECTED') return 'TUYA_BUSY';
  const detail = Number(err?.detail);
  if (TUYA_SIGN_CODES.has(detail)) return 'TOKEN_REJECTED';
  if (TUYA_DEVICE_CODES.has(detail)) return 'DEVICE_REJECTED';
  if (TUYA_QUOTA_CODES.has(detail)) return 'TUYA_BUSY';
  const hint = String(err?.hint ?? '').toLowerCase();
  if (/(devid|device)/.test(hint) && /(not exist|not found|no such|permission)/.test(hint)) return 'DEVICE_REJECTED';
  if (/(sign|token|client.?id|secret)/.test(hint)) return 'TOKEN_REJECTED';
  return 'TUYA_BUSY';
}

/** Kelas publik untuk pemanggil (menentukan status HTTP: kredensial/device vs sementara). */
export const tuyaErrorClass = (err) => classOf(err);

/** Pesan publik stabil untuk sebuah TuyaError — satu-satunya teks yang boleh sampai ke klien. */
export const tuyaPublicMessage = (err) => PUBLIC_MESSAGE[classOf(err)] ?? PUBLIC_MESSAGE.TUYA_BUSY;

/** Request Tuya bertanda tangan per dokumen Tuya IoT Cloud: sign = HMAC(secret, clientId + (token) + ts + method + \n + bodyHash).
 *  `timeoutMs` per request (B5) — validasi kredensial memakai batas lebih pendek supaya form tidak menggantung. */
async function tuyaRequest(cfg, path, method = 'GET', body = null, timeoutMs = TUYA_TIMEOUT_MS) {
  const base = REGIONS[normalizeRegion(cfg.region)] ?? REGIONS.eu;
  const ts = Date.now().toString();
  const bodyText = body === null ? '' : JSON.stringify(body);
  const bodyHash = await sha256Hex(bodyText);
  try {
    const tokenRes = await fetch(`${base}/v1.0/token?grant_type=1`, {
      headers: {
        client_id: cfg.clientId,
        sign_method: 'HMAC-SHA256',
        sign: await hmacHex(cfg.clientSecret, cfg.clientId + ts + 'GET\n' + bodyHash + '\n'),
        timestamp: ts,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData?.success) {
      // A token call can fail for reasons other than bad credentials: HTTP 5xx, quota/rate-limit codes, or a
      // "too frequent" message. Those are temporary (TUYA_BUSY → 503), not "your Client ID is wrong" (422).
      const detail = Number(tokenData?.code);
      const busy = tokenRes.status >= 500 || TUYA_QUOTA_CODES.has(detail) || /limit|quota|busy|frequent/i.test(String(tokenData?.msg ?? ''));
      throw new TuyaError(busy ? 'TUYA_BUSY' : 'TOKEN_REJECTED', busy ? 'Tuya sedang menolak permintaan' : 'Tuya token ditolak', {
        status: tokenRes.status, detail: tokenData?.code ?? null, hint: tokenData?.msg ?? null,
      });
    }
    const access = tokenData.result.access_token;
    const ts2 = Date.now().toString();
    const sign2 = await hmacHex(cfg.clientSecret, cfg.clientId + access + ts2 + method + '\n' + bodyHash + '\n');
    const res = await fetch(base + path, {
      method,
      headers: {
        client_id: cfg.clientId,
        access_token: access,
        sign_method: 'HMAC-SHA256',
        sign: sign2,
        timestamp: ts2,
        'Content-Type': 'application/json',
      },
      body: body === null ? undefined : bodyText,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json();
    if (!data?.success) {
      // Pesan Tuya mentah TIDAK dimasukkan ke `message`: JSON-nya bisa memuat detail internal dan
      // tidak pernah boleh sampai ke klien. Simpan hanya untuk klasifikasi (detail/hint).
      throw new TuyaError('API_REJECTED', 'Tuya menolak permintaan', {
        status: res.status, detail: data?.code ?? null, hint: data?.msg ?? data?.tmsg ?? null,
      });
    }
    return data.result;
  } catch (err) {
    if (err instanceof TuyaError) throw err;
    // fetch gagal / timeout / respons bukan JSON: detail jaringan tidak perlu sampai ke pengguna.
    throw new TuyaError('NETWORK', 'Tidak bisa menghubungi Tuya Cloud');
  }
}

/** Validasi kredensial TANPA efek samping: token + GET /status (read-only, TIDAK pernah /commands).
 *  Kembalikan { switchCode, hasPowerMeter }; gagal → TuyaError yang sudah DINORMALISASI ke kelas publik
 *  (TOKEN_REJECTED | DEVICE_REJECTED | NOT_A_PLUG | TUYA_BUSY | NETWORK) dengan pesan aman yang sama
 *  dengan yang dipakai jalur API (tuyaPublicMessage) — jadi kuota tidak pernah disebut "Device ID salah".
 *  Fail closed: kalau tidak bisa dipastikan, anggap kredensial tidak sah. */
export async function verifyCreds(cfg, { timeoutMs = 5000 } = {}) {
  let status;
  try {
    status = await tuyaRequest(cfg, `${devicePath(cfg)}/status`, 'GET', null, timeoutMs);
  } catch (err) {
    const cls = classOf(err);
    throw new TuyaError(cls, PUBLIC_MESSAGE[cls], {
      status: err?.status ?? null, detail: err?.detail ?? null, hint: err?.hint ?? null,
    });
  }
  const codes = Array.isArray(status) ? status : [];
  const sw = codes.find((c) => c.code === 'switch_1' || c.code === 'switch');
  if (!sw) throw new TuyaError('NOT_A_PLUG', PUBLIC_MESSAGE.NOT_A_PLUG);
  return { switchCode: sw.code, hasPowerMeter: codes.some((c) => c.code === 'power' || c.code === 'power_current') };
}

/** Status saklar plug (switch_1 / switch), atau null kalau kode statusnya absen. */
export async function tuyaPlugState(cfg) {
  const status = await tuyaRequest(cfg, `${devicePath(cfg)}/status`);
  const codes = Array.isArray(status) ? status : [];
  const on = codes.find((c) => c.code === 'switch_1' || c.code === 'switch')?.value;
  return typeof on === 'boolean' ? (on ? 'on' : 'off') : null;
}

/** Daya terukur plug (watt), atau null kalau plug tidak punya sensor daya.
 * Catatan: sebagian firmware melapor dalam 0,1 W — nilai apa adanya dipakai, ambang 5 W (spesifikasi). */
export async function readPowerW(cfg) {
  const status = await tuyaRequest(cfg, `${devicePath(cfg)}/status`);
  const codes = Array.isArray(status) ? status : [];
  const code = codes.find((c) => c.code === 'power' || c.code === 'power_current');
  return typeof code?.value === 'number' ? code.value : null;
}

/** Set plug. ON saat plug sudah ON disiklus OFF → ON: BIOS butuh kejadian listrik baru untuk boot. */
export async function tuyaSetPlug(cfg, on, waitMs = 2000) {
  const code = 'switch_1';
  if (on) {
    let state = null;
    try { state = await tuyaPlugState(cfg); } catch { state = null; }
    if (state === 'on') {
      await tuyaRequest(cfg, `${devicePath(cfg)}/commands`, 'POST', { commands: [{ code, value: false }] });
      await new Promise((r) => setTimeout(r, waitMs));
    }
    await tuyaRequest(cfg, `${devicePath(cfg)}/commands`, 'POST', { commands: [{ code, value: true }] });
    return;
  }
  await tuyaRequest(cfg, `${devicePath(cfg)}/commands`, 'POST', { commands: [{ code, value: false }] });
}

/** Nyalakan (on=true) atau matikan (false) plug milik space ini. */
export function drivePlug(cfg, on, waitMs) {
  return tuyaSetPlug(cfg, on, waitMs);
}
