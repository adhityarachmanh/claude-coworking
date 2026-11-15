// bridge/src/tuya.mjs — adapter Tuya Cloud (Bardi / Smart Life), diporting dari bridge/worker.js lama.
// Config kini per-space (bukan env): cfg = { region, clientId, clientSecret, deviceId } — hasil dekripsi
// vault.mjs. Logika Tuya dipakai ulang apa adanya: HMAC-SHA256 dua lapis (token lalu komando),
// ON disiklus OFF → ON karena BIOS butuh kejadian listrik baru.
// Kredensial tidak pernah di-log dan tidak pernah masuk respons HTTP.
//
// HANYA endpoint IoT Core GRATIS yang dipakai: `GET /v1.0/devices/{id}/status` dan
// `POST /v1.0/devices/{id}/commands`. API statistik energi Power Management BERBAYAR dan tidak
// tersedia untuk akun ini, jadi sengaja TIDAK dipanggil sama sekali.

// Tuya punya 7 data center (bukan 3): kredensial/Cloud Project hanya valid di DC tempat project dibuat.
// Kunci lama (eu/america/asia) DIPERTAHANKAN supaya record space yang sudah ada tetap terbaca.
const REGIONS = {
  eu: 'https://openapi.tuyaeu.com',              // Central Europe (Frankfurt)
  'eu-west': 'https://openapi-weaz.tuyaeu.com',  // Western Europe (Amsterdam)
  america: 'https://openapi.tuyaus.com',         // Western America (Oregon)
  'us-east': 'https://openapi-ueaz.tuyaus.com',  // Eastern America (Virginia)
  asia: 'https://openapi.tuyacn.com',            // China (Shanghai)
  india: 'https://openapi.tuyain.com',           // India (Mumbai)
  singapore: 'https://openapi-sg.iotbing.com',   // Singapore
};

/** Urutan pilihan di form (label manusiawi, bukan cuma kode). */
export const REGION_LABELS = {
  eu: 'eu — Eropa Tengah (Frankfurt)',
  'eu-west': 'eu-west — Eropa Barat (Amsterdam)',
  america: 'america — Amerika Barat (Oregon)',
  'us-east': 'us-east — Amerika Timur (Virginia)',
  asia: 'asia — Tiongkok (Shanghai)',
  india: 'india — India (Mumbai)',
  singapore: 'singapore — Singapura',
};
export const REGION_KEYS = Object.keys(REGIONS);

/** Nama region bridge: 7 kunci di atas; alias portal lama dikanonisasi. */
export function normalizeRegion(region) {
  const r = String(region ?? '').trim().toLowerCase();
  if (r === 'us') return 'america';
  if (r === 'cn') return 'asia';
  if (r === 'sg') return 'singapore';
  if (r === 'in') return 'india';
  if (r === 'east-america' || r === 'us-east-1') return 'us-east';
  if (r === 'west-europe') return 'eu-west';
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

/** Nomor DP standar smart plug Tuya: dipakai kalau payload hanya membawa `id` (tanpa `code`). */
const DP_ID = { switchOn: 1, energyKwh: 17, currentMa: 18, powerW: 19, voltageV: 20 };

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
  // Tuya signs `client_id + t + stringToSign` where stringToSign = method + "\n" + contentHash + "\n" +
  // optionalHeaders + "\n" + URL (path + alphabetically sorted query). The URL is MANDATORY — without it the
  // server rejects every call as "sign invalid" (1004). The token call has its own empty body and its own URL.
  const tokenUrl = '/v1.0/token?grant_type=1';
  const emptyHash = await sha256Hex('');
  const stringToSign = (m, hash, url) => `${m}\n${hash}\n\n${url}`;
  try {
    const tokenRes = await fetch(`${base}${tokenUrl}`, {
      headers: {
        client_id: cfg.clientId,
        sign_method: 'HMAC-SHA256',
        sign: await hmacHex(cfg.clientSecret, cfg.clientId + ts + stringToSign('GET', emptyHash, tokenUrl)),
        t: ts,
        timestamp: ts, // kept for older gateways; Tuya reads `t`
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
    const sign2 = await hmacHex(cfg.clientSecret, cfg.clientId + access + ts2 + stringToSign(method, bodyHash, path));
    const res = await fetch(base + path, {
      method,
      headers: {
        client_id: cfg.clientId,
        access_token: access,
        sign_method: 'HMAC-SHA256',
        sign: sign2,
        t: ts2,
        timestamp: ts2, // kept for older gateways; Tuya reads `t`
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
  // Plug Bardi melaporkan `cur_power` (DP 19), bukan `power`/`power_current` firmware lama.
  const hasPowerMeter = codes.some((c) => c.code === 'cur_power' || c.code === 'power'
    || c.code === 'power_current' || c.id === DP_ID.powerW);
  return { switchCode: sw.code, hasPowerMeter };
}

/** Cari data center yang benar dengan mencoba ketujuh endpoint Tuya secara paralel (read-only: tiap percobaan
 *  hanya token + GET status). Dipakai saat region pilihan user ditolak: kredensial/Cloud Project hanya valid
 *  di DC asalnya, dan user sering tidak tahu DC mana yang dipilih saat membuat project.
 *  Kembalikan kunci region yang berhasil; gagal → TuyaError yang sudah diklasifikasikan (aman untuk klien).
 *  @param {{ region?: string, clientId: string, clientSecret: string, deviceId: string }} cfg
 *  @param {{ timeoutMs?: number }} [options] short per-request timeout (default 4 dtk, 7 request paralel)
 *  @returns {Promise<string>} salah satu dari REGION_KEYS
 */
export async function detectRegion(cfg, { timeoutMs = 4000 } = {}) {
  const attempts = REGION_KEYS.map(async (region) => {
    const status = await tuyaRequest({ ...cfg, region }, `${devicePath(cfg)}/status`, 'GET', null, timeoutMs);
    const codes = Array.isArray(status) ? status : [];
    if (!codes.some((c) => c.code === 'switch_1' || c.code === 'switch')) {
      throw new TuyaError('NOT_A_PLUG', PUBLIC_MESSAGE.NOT_A_PLUG);
    }
    return region;
  });
  const settled = await Promise.allSettled(attempts);
  const ok = settled.find((r) => r.status === 'fulfilled');
  if (ok) return ok.value;
  const errors = settled.filter((r) => r.status === 'rejected').map((r) => r.reason).filter((e) => e instanceof TuyaError);
  // A status call that succeeded but had no switch proves the credentials are valid in that DC.
  const notPlug = errors.find((e) => classOf(e) === 'NOT_A_PLUG');
  if (notPlug) throw notPlug;
  const device = errors.find((e) => classOf(e) === 'DEVICE_REJECTED');
  if (device) throw new TuyaError('DEVICE_REJECTED', PUBLIC_MESSAGE.DEVICE_REJECTED);
  const tokenRejected = errors.some((e) => classOf(e) === 'TOKEN_REJECTED');
  const network = errors.find((e) => classOf(e) === 'NETWORK');
  const busy = errors.find((e) => classOf(e) === 'TUYA_BUSY');
  if (!tokenRejected && network) throw network;
  if (!tokenRejected && busy) throw busy;
  throw new TuyaError('TOKEN_REJECTED', PUBLIC_MESSAGE.TOKEN_REJECTED);
}

/** Status saklar plug (switch_1 / switch), atau null kalau kode statusnya absen. */
export async function tuyaPlugState(cfg) {
  const status = await tuyaRequest(cfg, `${devicePath(cfg)}/status`);
  const codes = Array.isArray(status) ? status : [];
  const on = codes.find((c) => c.code === 'switch_1' || c.code === 'switch')?.value;
  return typeof on === 'boolean' ? (on ? 'on' : 'off') : null;
}

/** Cari satu datapoint numerik: nama `code` lebih dulu, lalu nomor DP `id`.
 *  Tidak pernah melempar — field yang absen/non-numerik dianggap tidak ada (null). */
function findDp(codes, names, ids) {
  for (const name of names) {
    const found = codes.find((c) => c && c.code === name && Number.isFinite(c.value));
    if (found) return { value: found.value, code: name };
  }
  for (const id of ids) {
    const found = codes.find((c) => c && c.id === id && Number.isFinite(c.value));
    if (found) return { value: found.value, code: null };
  }
  return null;
}

/** Saklar bisa boolean (Tuya normal) atau 0/1 (sebagian firmware): selain itu → null (tidak diketahui). */
const asSwitch = (value) => (typeof value === 'boolean' ? value : value === 1 || value === 0 ? value === 1 : null);

/** Status plug lengkap dari SATU panggilan `GET /devices/{id}/status` (IoT Core, gratis).
 *  Cocok lewat `code` MAUPUN nomor DP `id`, karena firmware Bardi melaporkan `cur_power`/`add_ele`
 *  dan sebagian gateway hanya meneruskan `id`. Skala firmware Tuya: `cur_power` 0,1 W,
 *  `cur_voltage` 0,1 V, `cur_current` mA, `add_ele` 0,01 kWh. Field opsional yang hilang → null
 *  (plug tanpa sensor daya tidak boleh membuat pembacaan gagal). */
export async function readPlugStatus(cfg) {
  const status = await tuyaRequest(cfg, `${devicePath(cfg)}/status`, 'GET', null, 6000);
  const codes = Array.isArray(status) ? status : [];
  const sw = codes.find((c) => c.code === 'switch_1')
    ?? codes.find((c) => c.code === 'switch') // firmware lama: `switch_1` absen, `switch` dipakai
    ?? codes.find((c) => c.id === DP_ID.switchOn);
  const power = findDp(codes, ['cur_power', 'power', 'power_current'], [DP_ID.powerW]);
  const voltage = findDp(codes, ['cur_voltage', 'voltage'], [DP_ID.voltageV]);
  const current = findDp(codes, ['cur_current', 'current'], [DP_ID.currentMa]);
  const energy = findDp(codes, ['add_ele'], [DP_ID.energyKwh]);
  // `cur_power` (dan DP 19 tanpa code) selalu 0,1 W; `power`/`power_current` firmware lama sudah watt.
  const powerW = power ? (power.code === 'cur_power' || power.code === null ? power.value / 10 : power.value) : null;
  // `cur_voltage` (dan DP 20) selalu 0,1 V; `voltage` lama kadang mV.
  const voltageV = voltage
    ? (voltage.code === 'cur_voltage' || voltage.code === null ? voltage.value / 10 : (voltage.value > 1000 ? voltage.value / 10 : voltage.value))
    : null;
  // `current` tanpa awalan `cur_` biasanya ampere; `cur_current` selalu mA.
  const currentMa = current
    ? (current.code === 'cur_current' || current.code === null ? current.value : (current.value < 20 ? current.value * 1000 : current.value))
    : null;
  return {
    switchOn: asSwitch(sw?.value),
    powerW: powerW === null ? null : Math.round(powerW * 10) / 10,
    voltageV: voltageV === null ? null : Math.round(voltageV * 10) / 10,
    currentMa: currentMa === null ? null : Math.round(currentMa),
    energyKwh: energy === null ? null : Math.round(energy.value) / 100,
  };
}

/** Set plug. ON saat plug sudah ON disiklus OFF → ON: BIOS butuh kejadian listrik baru untuk boot. */export async function tuyaSetPlug(cfg, on, waitMs = 2000) {
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
