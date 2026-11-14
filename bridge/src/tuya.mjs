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

/** Request Tuya bertanda tangan per dokumen Tuya IoT Cloud: sign = HMAC(secret, clientId + (token) + ts + method + \n + bodyHash). */
async function tuyaRequest(cfg, path, method = 'GET', body = null) {
  const base = REGIONS[normalizeRegion(cfg.region)] ?? REGIONS.eu;
  const ts = Date.now().toString();
  const bodyText = body === null ? '' : JSON.stringify(body);
  const bodyHash = await sha256Hex(bodyText);
  const tokenRes = await fetch(`${base}/v1.0/token?grant_type=1`, {
    headers: {
      client_id: cfg.clientId,
      sign_method: 'HMAC-SHA256',
      sign: await hmacHex(cfg.clientSecret, cfg.clientId + ts + 'GET\n' + bodyHash + '\n'),
      timestamp: ts,
    },
    signal: AbortSignal.timeout(10_000), // B5: Tuya tidak boleh menggantung request sampai timeout platform
  });
  const tokenData = await tokenRes.json();
  if (!tokenData?.success) throw new Error('Tuya token ditolak');
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
    signal: AbortSignal.timeout(10_000), // B5
  });
  const data = await res.json();
  if (!data?.success) throw new Error('Tuya menolak: ' + JSON.stringify(data));
  return data.result;
}

/** Status saklar plug (switch_1 / switch), atau null kalau kode statusnya absen. */
export async function tuyaPlugState(cfg) {
  const status = await tuyaRequest(cfg, `/v1.0/devices/${cfg.deviceId}/status`);
  const codes = Array.isArray(status) ? status : [];
  const on = codes.find((c) => c.code === 'switch_1' || c.code === 'switch')?.value;
  return typeof on === 'boolean' ? (on ? 'on' : 'off') : null;
}

/** Daya terukur plug (watt), atau null kalau plug tidak punya sensor daya.
 * Catatan: sebagian firmware melapor dalam 0,1 W — nilai apa adanya dipakai, ambang 5 W (spesifikasi). */
export async function readPowerW(cfg) {
  const status = await tuyaRequest(cfg, `/v1.0/devices/${cfg.deviceId}/status`);
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
      await tuyaRequest(cfg, `/v1.0/devices/${cfg.deviceId}/commands`, 'POST', { commands: [{ code, value: false }] });
      await new Promise((r) => setTimeout(r, waitMs));
    }
    await tuyaRequest(cfg, `/v1.0/devices/${cfg.deviceId}/commands`, 'POST', { commands: [{ code, value: true }] });
    return;
  }
  await tuyaRequest(cfg, `/v1.0/devices/${cfg.deviceId}/commands`, 'POST', { commands: [{ code, value: false }] });
}

/** Nyalakan (on=true) atau matikan (false) plug milik space ini. */
export function drivePlug(cfg, on, waitMs) {
  return tuyaSetPlug(cfg, on, waitMs);
}
