// bridge/src/client.mjs — klien HTTP ke provider AI. Lapisan murni: menerima `fetchImpl` (default fetch
// global) agar bisa dites tanpa jaringan. Key selalu dikirim lewat header/param yang benar per provider.
// M4 memakai testProviderKey; M5 menambah streaming chat.
import { PROVIDER_KINDS } from './providers.mjs';

const TIMEOUT_MS = 15_000;

/** Endpoint dasar per kind (base_url kustom menang untuk openai-compatible). */
const baseFor = (provider) => provider.base_url || {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
}[provider.kind];

const withTimeout = (ms) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(t) };
};

/** Uji key: panggil endpoint ringan yang membuktikan key berlaku. Tidak menyentuh model hasil generate. */
export async function testProviderKey(provider, apiKey, fetchImpl = globalThis.fetch) {
  if (!PROVIDER_KINDS.includes(provider.kind)) return { ok: false, error: 'Jenis provider tidak dikenal' };
  const base = baseFor(provider);
  const { signal, done } = withTimeout(TIMEOUT_MS);
  try {
    let res;
    if (provider.kind === 'openai') {
      res = await fetchImpl(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    } else if (provider.kind === 'anthropic') {
      res = await fetchImpl(`${base}/models`, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal });
    } else {
      res = await fetchImpl(`${base}/models?key=${encodeURIComponent(apiKey)}`, { signal });
    }
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'API key ditolak provider' };
    if (res.status === 429) return { ok: false, error: 'Provider sedang membatasi (coba lagi nanti)' };
    return { ok: false, error: `Provider menjawab ${res.status}` };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'Provider tidak menjawab (timeout)' : 'Tidak bisa menghubungi provider' };
  } finally {
    done();
  }
}