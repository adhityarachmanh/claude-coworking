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

/** Daftar model statis (salinan aman) untuk sebuah kind. */
export const modelsFor = (kind) => (MODELS[kind] ?? []).map((m) => ({ ...m }));

/**
 * Tier perkiraan dari nama model: katalog statis menang bila id cocok; kalau tidak, tebak dari pola
 * nama (meniru kelas model yang lazim). Dipakai untuk daftar model yang diambil langsung dari provider.
 */
const TIER_GUESS = [
  [/nano|flash-lite|flash-lite|haiku|\bmini\b|\blite\b|\bsmall\b/, 'hemat'],
  [/opus|\bpro\b|ultra|\blarge\b|gpt-5|o3|o4|sonnet/, 'kuat'],
];
export function tierFor(kind, modelId) {
  const known = MODELS[kind]?.find((m) => m.id === modelId);
  if (known) return known.tier;
  const id = String(modelId).toLowerCase();
  for (const [re, tier] of TIER_GUESS) if (re.test(id)) return tier;
  return 'sedang';
}

/** Heuristik effort untuk model tak ada di katalog statis: hanya keluarga penalaran yang jelas. */
const EFFORT_GUESS = /(^|[-_/])(o1|o3|o4|gpt-5|thinking|reasoning)($|[-_/])/;

/**
 * Apakah model (kind+id) mendukung effort. Katalog statis menang bila id cocok; kalau tidak, heuristik
 * nama (model penalaran yang jelas). Selain itu false — parameter effort tidak dikirim (diabaikan diam-diam).
 */
export function modelSupportsEffort(kind, modelId) {
  const known = MODELS[kind]?.find((m) => m.id === modelId);
  if (known) return Boolean(known.effort);
  return EFFORT_GUESS.test(String(modelId).toLowerCase());
}

/**
 * Daftar model efektif untuk sebuah provider: daftar milik provider (hasil "cek key & muat model") bila ada,
 * atau katalog statis bila belum. Selalu menyertakan tier & effort yang siap dipakai UI.
 */
export function effectiveModels(kind, providerModels) {
  const custom = Array.isArray(providerModels) ? providerModels.filter((m) => m && m.id) : [];
  if (!custom.length) return modelsFor(kind);
  return custom.map((m) => ({
    id: String(m.id),
    label: String(m.label ?? m.id),
    tier: tierFor(kind, m.id),
    effort: modelSupportsEffort(kind, m.id),
  }));
}

/** Label model untuk satu id (dari daftar efektif atau id itu sendiri). */
export const labelForModel = (kind, providerModels, modelId) =>
  effectiveModels(kind, providerModels).find((m) => m.id === modelId)?.label ?? modelId;

/** Model default per kind (yang pertama). `providerModels` opsional (daftar milik provider). */
export const defaultModelFor = (kind, providerModels) => effectiveModels(kind, providerModels)[0]?.id ?? null;

/** Model termurah per kind — untuk classifier Auto effort (meniru Adhitron lokal). */
export const cheapestModelFor = (kind, providerModels) => {
  const list = effectiveModels(kind, providerModels);
  return list.find((m) => m.tier === 'hemat')?.id ?? list.at(-1)?.id ?? null;
};

/** Id model yang dikenal: dari daftar provider bila ada, kalau tidak dari katalog statis. */
export const isKnownModel = (kind, modelId, providerModels) =>
  effectiveModels(kind, providerModels).some((m) => m.id === modelId);

/** Tier → model pilihan user (dari model_tiers percakapan), dengan fallback ke model pertama daftar efektif. */
export function modelForTier(kind, tier, modelTiers, providerModels) {
  const list = effectiveModels(kind, providerModels);
  const picked = modelTiers?.[tier];
  if (typeof picked === 'string' && list.some((m) => m.id === picked)) return picked;
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