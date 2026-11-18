// A provider error in the chat, turned into one in-app action (pure): the raw message stays visible for whoever wants
// it, and under it a short hint with the button that actually fixes it — Akun (key/login), the model picker, or 🧹
// Ringkas konteks. Matching is deliberately conservative: a guess that opens the wrong dialog is worse than none.

const AUTH = [
  /invalid api key/,
  /incorrect api key/,
  /x-api-key/,
  /api key (?:is )?(?:missing|invalid|not set)/,
  /\b401\b/,
  /unauthori[sz]ed/,
  /not authenticated/,
  /authentication[_ ]?(?:error|failed|failure)/,
  /no credentials/,
  /belum login/,
];

const QUOTA = [
  /insufficient (?:credit|credits|balance|quota|funds)/,
  /credit balance is too low/,
  /out of credits/,
  /payment required/,
  /\b402\b/,
  /quota (?:exceeded|habis|penuh)/,
  /kuota (?:habis|penuh|terlampaui)/,
  /exceeded your current quota/,
  /usage limit/,
  /\bbilling\b/,
];

// Also 529 "overloaded": waiting or another model helps in the same way.
const RATE = [/\b429\b/, /rate limit/, /too many requests/, /overloaded/];

const CONTEXT = [/context (?:length|window)/, /maximum context/, /too many tokens/, /prompt is too long/];

const NOT_FOUND = [/model[_ ]not[_ ]found/, /no endpoints found/];
const MODEL_WORD = /model|endpoint/;

const MODEL_MISS = [/not found/, /not available/, /unknown/, /unsupported/, /does not exist/, /invalid/];

const HINTS = {
  auth: { kind: 'auth', text: 'API key / login provider ditolak. Periksa akun dan kunci API-nya.', button: '🔑 Buka Akun', act: 'account' },
  quota: { kind: 'quota', text: 'Kuota atau kredit provider habis. Pilih model lain, atau isi ulang kreditnya di akun provider.', button: '🔄 Ganti model', act: 'model' },
  rate: { kind: 'rate', text: 'Provider sedang membatasi permintaan. Tunggu sebentar, atau pilih model lain.', button: '🔄 Ganti model', act: 'model' },
  context: { kind: 'context', text: 'Konteks percakapan melebihi batas model ini. Ringkas konteks agar bisa lanjut.', button: '🧹 Ringkas konteks', act: 'compact' },
  model: { kind: 'model', text: 'Model ini tidak tersedia di provider. Pilih model lain.', button: '🔄 Ganti model', act: 'model' },
};

/** `{ kind, text, button, act }` for an error a provider caused, or null when it is not one we know. */
export function providerErrorHint(text) {
  const s = String(text ?? '').toLowerCase();
  if (!s) return null;
  if (AUTH.some((re) => re.test(s))) return { ...HINTS.auth };
  if (QUOTA.some((re) => re.test(s))) return { ...HINTS.quota };
  if (RATE.some((re) => re.test(s))) return { ...HINTS.rate };
  if (CONTEXT.some((re) => re.test(s))) return { ...HINTS.context };
  // "model" must be part of the message: "404 not found" alone is not a model problem.
  if (MODEL_WORD.test(s) && (NOT_FOUND.some((re) => re.test(s)) || MODEL_MISS.some((re) => re.test(s)))) return { ...HINTS.model };
  return null;
}
