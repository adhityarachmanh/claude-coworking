// Cost estimate for the next prompt (#cost-estimate in the composer): a rough, honest range from the model's price and
// the tokens the turn will carry. Pure and testable: no DOM, no network, never throws — the number comes from a server
// answer, so every field is validated here before it is used.

const MAX_CHARS = 1_000_000; // clamp absurd inputs (a browser reports its own length, the server data is what is untrusted)

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** A finite, non-negative number or null (the caller's "not usable"). */
const nonNeg = (v) => (finite(v) && v >= 0 ? v : null);

/**
 * DeepSeek's peak window, in UTC: weekdays 01:00–04:00 and 06:00–10:00 (the API charges `peakFactor` there).
 * `at` is a timestamp (ms) or a Date; anything unreadable counts as off-peak.
 */
export function isPeak(at = Date.now()) {
  const date = at instanceof Date ? at : new Date(at);
  const time = date.getTime();
  if (!finite(time)) return false;
  const day = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * The estimated cost of one prompt, in USD, from a `priceFor()` object:
 *   list:     (context × cacheRead + prompt × input + output × output) / 1M, × peakFactor inside the peak window
 *   observed: (context + prompt + output) × perMillion / 1M
 * `contextTokens` is what the turn already carries, `promptChars` the box's length (≈ 4 characters per token).
 * Returns `{ usd, kind, promptTokens, contextTokens, outputTokens }`, or null when the price is not usable.
 */
export function estimateUsd(price, opts = {}) {
  const { contextTokens = 0, promptChars = 0, outputTokens = 600, at = Date.now() } = opts && typeof opts === 'object' ? opts : {};
  if (!price || typeof price !== 'object') return null;
  const chars = Math.min(nonNeg(promptChars) ?? 0, MAX_CHARS);
  const promptTokens = Math.ceil(chars / 4);
  const context = Math.min(nonNeg(contextTokens) ?? 0, MAX_CHARS);
  // A caller asking for 0 output tokens means it (a context-only estimate); anything unusable falls back to 600.
  const output = finite(outputTokens) && outputTokens >= 0 ? Math.min(outputTokens, MAX_CHARS) : 600;

  if (price.kind === 'list') {
    const input = nonNeg(price.input);
    const out = nonNeg(price.output);
    if (input === null || out === null) return null;
    const cacheRead = nonNeg(price.cacheRead) ?? 0;
    const tokens = context * cacheRead + promptTokens * input + output * out;
    const peakFactor = nonNeg(price.peakFactor) ?? 1;
    return { usd: (peakFactor > 1 && isPeak(at) ? tokens * peakFactor : tokens) / 1e6, kind: 'list', promptTokens, contextTokens: context, outputTokens: output };
  }
  if (price.kind === 'observed') {
    const perMillion = nonNeg(price.perMillion);
    if (perMillion === null) return null;
    return { usd: ((context + promptTokens + output) * perMillion) / 1e6, kind: 'observed', promptTokens, contextTokens: context, outputTokens: output };
  }
  return null;
}

/** `0.0234` → `"±$0,02"`; less than half a cent → `"±<$0,01"`; no estimate → `""` (the line hides itself). */
export function formatEstimate(est) {
  if (!est || !finite(est.usd) || est.usd < 0) return '';
  if (est.usd < 0.005) return '±<$0,01';
  return `±$${est.usd.toFixed(2).replace('.', ',')}`;
}
