// bridge/src/providers.mjs — katalog provider & model Adhitron Web + pemetaan Effort, murni (tanpa I/O).
// Meniru Adhitron lokal: tiap provider punya daftar model + chip sumber, dan Effort
// (Default/Low/Medium/High/X-High/Max) dipetakan sesuai kemampuan provider. Yang tidak didukung
// diabaikan diam-diam (tidak error) — model tetap menerima permintaan tanpa parameter itu.

/** Jenis provider yang didukung v1. 'openai' mencakup semua endpoint OpenAI-compatible (base_url kustom). */
export const PROVIDER_KINDS = Object.freeze(['openai', 'anthropic', 'google']);

export const KIND_LABELS = Object.freeze({
  openai: 'OpenAI / kompatibel',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
});

/** Level effort yang dikenal UI, berurutan dari paling ringan. */
export const EFFORT_LEVELS = Object.freeze(['default', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Tier model (Hemat/Sedang/Kuat) untuk pemetaan cepat di UI, meniru Adhitron lokal. */
export const TIERS = Object.freeze(['hemat', 'sedang', 'kuat']);

/**
 * Katalog model per provider. `tier` = kelas kasar untuk pengelompokan UI. `effort` = true bila model
 * memakai penalaran/thinking (parameter effort diteruskan). Daftar ini sengaja data, bukan kode: mudah
 * ditambah tanpa mengubah logika. Bukan daftar lengkap — hanya yang lazim.
 */
export const MODELS = Object.freeze({
  openai: [
    { id: 'gpt-5', label: 'GPT-5', tier: 'kuat', effort: true },
    { id: 'gpt-5-mini', label: 'GPT-5 mini', tier: 'sedang', effort: true },
    { id: 'gpt-5-nano', label: 'GPT-5 nano', tier: 'hemat', effort: true },
    { id: 'gpt-4.1', label: 'GPT-4.1', tier: 'kuat', effort: false },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', tier: 'sedang', effort: false },
    { id: 'o4-mini', label: 'o4-mini', tier: 'sedang', effort: true },
  ],
  anthropic: [
    { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', tier: 'kuat', effort: true },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', tier: 'sedang', effort: true },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'hemat', effort: false },
  ],
  google: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'kuat', effort: true },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'sedang', effort: true },
    { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', tier: 'hemat', effort: false },
  ],
});

/** Daftar model (salinan aman) untuk sebuah kind. */
export const modelsFor = (kind) => (MODELS[kind] ?? []).map((m) => ({ ...m }));

/** Model default per kind (yang pertama). */
export const defaultModelFor = (kind) => modelsFor(kind)[0]?.id ?? null;

/** Model termurah per kind — untuk classifier Auto effort (meniru Adhitron lokal). */
export const cheapestModelFor = (kind) => {
  const list = modelsFor(kind);
  return list.find((m) => m.tier === 'hemat')?.id ?? list.at(-1)?.id ?? null;
};

/** Apakah model (kind+id) mendukung effort. Model tak dikenal → false (jangan kirim parameter). */
export function modelSupportsEffort(kind, modelId) {
  return Boolean(MODELS[kind]?.find((m) => m.id === modelId)?.effort);
}

/** Id model apa pun yang dikenal semua kind (untuk validasi tanpa tahu provider). */
export const isKnownModel = (kind, modelId) => Boolean(MODELS[kind]?.some((m) => m.id === modelId));

/** Tier → model pilihan user (dari model_tiers percakapan), dengan fallback ke model pertama kind. */
export function modelForTier(kind, tier, modelTiers) {
  const picked = modelTiers?.[tier];
  if (typeof picked === 'string' && isKnownModel(kind, picked)) return picked;
  const list = modelsFor(kind);
  return (list.find((m) => m.tier === tier) ?? list[0])?.id ?? null;
}

// ---------------------------------------------------------------- Effort → parameter provider

/** Peta effort → budget token thinking Gemini (0 = tanpa thinking budget). */
const GEMINI_THINKING_BUDGET = { default: null, low: 0, medium: 4096, high: 16384, xhigh: 32768, max: 49152 };
/** Peta effort → reasoning_effort OpenAI (null = jangan kirim). */
const OPENAI_REASONING = { default: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };
/** Peta effort → token budget thinking Anthropic (null = tanpa extended thinking). */
const ANTHROPIC_THINKING_BUDGET = { default: null, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 63999 };

/**
 * Terjemahkan (kind, model, effort) menjadi parameter body provider. `{}` bila tidak ada yang berlaku —
 * pemanggil menggabungkannya ke body permintaan. Pemetaan ini adalah satu-satunya tempat aturan effort,
 * jadi UI tidak pernah menyentuh detail provider.
 */
export function effortParams(kind, modelId, effort = 'default') {
  const level = EFFORT_LEVELS.includes(effort) ? effort : 'default';
  if (!modelSupportsEffort(kind, modelId)) return {};
  if (kind === 'openai') {
    const re = OPENAI_REASONING[level];
    return re ? { reasoning_effort: re } : {};
  }
  if (kind === 'google') {
    const budget = GEMINI_THINKING_BUDGET[level];
    return budget == null ? {} : { thinkingConfig: { thinkingBudget: budget } };
  }
  if (kind === 'anthropic') {
    const budget = ANTHROPIC_THINKING_BUDGET[level];
    return budget == null ? {} : { thinking: { type: 'enabled', budget_tokens: budget } };
  }
  return {};
}

/** Validasi kind. */
export const isValidKind = (kind) => PROVIDER_KINDS.includes(kind);

/** Validasi base_url kustom: https absolut saja (tanpa kredensial/query/hash), atau null. */
export function cleanBaseUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, value: null };
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: 'URL tidak valid' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'URL harus https' };
  if (u.username || u.password) return { ok: false, error: 'URL tidak boleh memuat kredensial' };
  if (u.search || u.hash) return { ok: false, error: 'URL tidak boleh memuat query/fragmen' };
  return { ok: true, value: `${u.origin}${u.pathname.replace(/\/$/, '')}` };
}