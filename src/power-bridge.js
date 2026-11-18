// Calls to the self-hosted remote-power bridge (Netlify): schedule a power cut and create a pairing code.
// Pure-ish on purpose: fetch and the clock are injected, so tests never touch the network and the routes stay thin.
// Contract: docs/remote-power-bridge.md (POST /api/off?delay=&hold=1, POST /api/pair).
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;
const BRIDGE_TIMEOUT_MS = 5000;

/** An absolute https URL for a bridge endpoint + query. Returns null for anything that is not an https absolute URL. */
export function bridgeEndpoint(bridgeUrl, path, params = {}) {
  let url;
  try {
    url = new URL(path, String(bridgeUrl ?? ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.href;
}

async function postJson(url, token, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'X-Bridge-Token': token, 'Content-Type': 'text/plain' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok === true, status: res.status, data };
}

/**
 * POST /api/off?delay=N&hold=1: the bridge cuts the plug itself N seconds from now. `hold=1` means a heartbeat
 * arriving before then must not cancel it (the PC is already shutting down).
 * @returns {Promise<{ok: boolean, offAt?: number|null, handoffUrl?: string|null, error?: string}>}
 */
export async function scheduleBridgeCut({ bridgeUrl, token, delay, fetchImpl = globalThis.fetch, timeoutMs = BRIDGE_TIMEOUT_MS }) {
  const seconds = Number(delay);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 600) return { ok: false, error: 'Jeda putus arus tidak valid.' };
  const url = bridgeEndpoint(bridgeUrl, '/api/off', { delay: seconds, hold: 1 });
  if (!url || !token) return { ok: false, error: 'Jembatan belum diset.' };
  try {
    const { ok, status, data } = await postJson(url, token, fetchImpl, timeoutMs);
    if (!ok) return { ok: false, error: `Jembatan menolak jadwal putus arus (HTTP ${status}).` };
    const handoff = typeof data?.handoffUrl === 'string' && data.handoffUrl.startsWith('/') && !data.handoffUrl.startsWith('//') ? data.handoffUrl : null;
    return { ok: true, offAt: Number.isFinite(data?.offAt) ? data.offAt : null, handoffUrl: handoff };
  } catch (err) {
    return { ok: false, error: `Jembatan tidak terjangkau: ${String(err?.message ?? err).slice(0, 160)}` };
  }
}

/**
 * POST /api/pair (owner token only) → an 8-character one-time code for another device (the phone).
 * @returns {Promise<{ok: boolean, code?: string, expiresAt?: number|null, error?: string}>}
 */
export async function pairBridge({ bridgeUrl, token, fetchImpl = globalThis.fetch, timeoutMs = BRIDGE_TIMEOUT_MS }) {
  const url = bridgeEndpoint(bridgeUrl, '/api/pair');
  if (!url || !token) return { ok: false, error: 'Jembatan belum diset.' };
  try {
    const { ok, status, data } = await postJson(url, token, fetchImpl, timeoutMs);
    if (!ok) return { ok: false, error: `Jembatan menolak membuat kode (HTTP ${status}).` };
    const code = typeof data?.code === 'string' ? data.code.toUpperCase() : '';
    if (!CODE_RE.test(code)) return { ok: false, error: 'Jembatan tidak mengembalikan kode pasangan yang valid.' };
    return { ok: true, code, expiresAt: Number.isFinite(data?.expiresAt) ? data.expiresAt : null };
  } catch (err) {
    return { ok: false, error: `Jembatan tidak terjangkau: ${String(err?.message ?? err).slice(0, 160)}` };
  }
}
