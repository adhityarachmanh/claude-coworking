// bridge/src/client.mjs — klien HTTP ke provider AI. Lapisan murni: menerima `fetchImpl` (default fetch
// global) agar bisa dites tanpa jaringan. Key selalu dikirim lewat header/param yang benar per provider.
// M4 memakai testProviderKey; M5 menambah streaming chat (callModelOnce/makeCallModel).

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

/**
 * Model yang jelas-jelas bukan untuk chat (embedding/tts/gambar/video/moderasi). Dibuang dari daftar hasil
 * probe supaya default & Auto tidak memilihnya; sisanya tetap muncul agar user bisa memfilter sendiri.
 */
const NON_CHAT_MODEL = /(embedding|\bembed\b|\btts\b|whisper|dall-e|gpt-image|imagen|moderation|\baqa\b|\bveo\b|\bsora\b|davinci|babbage|\bcurie\b)/i;

/**
 * Normalisasi daftar model dari respons tiap provider menjadi [{ id, label }] (urut, tanpa duplikat,
 * tanpa model non-chat). Bentuk mentah: OpenAI/Anthropic `{ data: [{ id, display_name? }] }`,
 * Gemini `{ models: [{ name: "models/x" }] }`.
 */
export function normalizeModels(kind, payload) {
  const out = [];
  const seen = new Set();
  const push = (id, label) => {
    const key = String(id ?? '').trim();
    if (!key || seen.has(key) || NON_CHAT_MODEL.test(key)) return;
    seen.add(key);
    out.push({ id: key, label: String(label ?? key).trim() || key });
  };
  if (kind === 'google') {
    for (const m of payload?.models ?? []) {
      const name = String(m?.name ?? '').replace(/^models\//, '');
      push(name, m?.displayName);
    }
  } else {
    for (const m of payload?.data ?? []) push(m?.id, m?.display_name ?? m?.displayName);
  }
  return out;
}

/**
 * Ambil daftar model dari provider sekaligus membuktikan key berlaku. Mengembalikan
 * `{ ok, models }` saat berhasil, atau `{ ok: false, error }` (key ditolak / provider tak menjawab).
 * Key hanya dipakai untuk panggilan ini; tidak disimpan di sini.
 */
export async function probeModels(provider, apiKey, fetchImpl = globalThis.fetch) {
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
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'API key ditolak provider' };
      if (res.status === 429) return { ok: false, error: 'Provider sedang membatasi (coba lagi nanti)' };
      return { ok: false, error: `Provider menjawab ${res.status}` };
    }
    const payload = typeof res.json === 'function' ? await res.json().catch(() => null) : null;
    return { ok: true, models: normalizeModels(provider.kind, payload) };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'Provider tidak menjawab (timeout)' : 'Tidak bisa menghubungi provider' };
  } finally {
    done();
  }
}

/** Uji key: panggil endpoint ringan yang membuktikan key berlaku. Tidak menyentuh model hasil generate. */
export async function testProviderKey(provider, apiKey, fetchImpl = globalThis.fetch) {
  const probe = await probeModels(provider, apiKey, fetchImpl);
  return probe.ok ? { ok: true } : { ok: false, error: probe.error };
}

/**
 * Panggilan non-streaming satu kali ke provider (dipakai classifier Auto). Mengembalikan teks jawaban.
 * Header & bentuk body sama dengan streaming; hanya tanpa `stream: true`. Lempar bila provider gagal.
 */
export async function callModelOnce(provider, apiKey, { model, system, messages, maxTokens = 256 }, fetchImpl = globalThis.fetch) {
  const base = baseFor(provider);
  const { signal, done } = withTimeout(TIMEOUT_MS);
  try {
    let url, headers, body;
    if (provider.kind === 'openai') {
      url = `${base}/chat/completions`;
      headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      body = { model, max_completion_tokens: maxTokens, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages] };
    } else if (provider.kind === 'anthropic') {
      url = `${base}/messages`;
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
      body = { model, max_tokens: maxTokens, messages, ...(system ? { system } : {}) };
    } else {
      url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      headers = { 'Content-Type': 'application/json' };
      body = { contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) };
    }
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`provider ${res.status}`);
    const j = await res.json();
    if (provider.kind === 'openai') return j.choices?.[0]?.message?.content ?? '';
    if (provider.kind === 'anthropic') return (j.content ?? []).map((b) => b.text ?? '').join('');
    return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  } finally {
    done();
  }
}

/** Bikin `callModel({ model, system, messages })` yang terikat ke satu provider+key (untuk classifier Auto). */
export const makeCallModel = (provider, apiKey, fetchImpl = globalThis.fetch) =>
  ({ model, system, messages }) => callModelOnce(provider, apiKey, { model, system, messages }, fetchImpl);