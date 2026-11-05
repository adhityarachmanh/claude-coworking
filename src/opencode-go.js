// OpenCode Go allowance estimate.
//
// OpenCode never puts `opencode.allowance` in the session messages and reports cost 0 for the Go plan, so the app
// cannot read what is left of the plan. It can estimate it from what it already keeps: the token counts in the usage
// ledger (src/usage.js), priced with the official Go list prices (src/model-prices.js), against the monthly USD limit
// each model has on the Go plan. The 5-hour and weekly allowances are 20% and 50% of that monthly limit.
//
// This is an estimate, never a bill: a turn the ledger never saw, a price change, or the DeepSeek peak surcharge all
// move the number away from OpenCode's own. A model missing from the plan table keeps its (estimated) usage with no
// limit, and a free model has no limit to spend at all.
import { engineOf } from './usage.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The three Go plans and their prices. The app cannot read a plan from OpenCode, so the user picks one in 👤 Akun;
 * the limits below are the official per-model monthly allowances from opencode.ai/docs/go.
 */
export const GO_PLANS = Object.freeze({
  go: { label: 'Go', price: '$10/bulan', perMember: false },
  plus: { label: 'Go Plus', price: '$40/bulan', perMember: false },
  teams: { label: 'Go Teams', price: '$20/anggota/bulan', perMember: true },
});

// [Go, Go Plus, Go Teams] monthly USD per model id. Infinity = free (no monthly limit); null = not in that plan's
// table (usage is still estimated, but no limit is shown). Keep one row per model so the three plans cannot drift.
const PLAN_TABLE = Object.freeze({
  'glm-5.3-flash': [60, 180, 65],
  'glm-5.3': [15, 120, 20],
  'glm-5.2': [60, 180, 65],
  'kimi-k3.1-pro': [15, 60, 20],
  'kimi-k3': [15, 60, 20],
  'kimi-k2.7-code': [60, 180, 65],
  'kimi-k2.5': [60, null, null], // older Go model: not in the current Plus/Teams table
  'longcat-2.0': [60, 240, 65],
  'step-5-preview': [15, 60, 20],
  'beam-free': [Infinity, Infinity, Infinity],
  'iceman-contributor-free': [Infinity, Infinity, Infinity],
  'mimo-v2.6-flash': [60, 120, 65],
  'mimo-v2.6-pro': [15, 60, 20],
  'mimo-v2.5': [60, 120, 65],
  'mimo-v2.5-pro': [15, 60, 20],
  'minimax-m3.1-flash': [20, 80, 25],
  'minimax-m3': [60, 180, 65],
  'muse-spark-1.3-contributor': [60, 120, 65],
  'muse-spark-1.2-contributor': [60, 120, 65],
  'qwen3.8-max': [15, 60, 20],
  'qwen3.8-flash': [30, 90, 35],
  'qwen3.7-plus': [60, 180, 65],
  'deepseek-v4.1-flash': [100, 200, 105],
  'deepseek-v4-pro': [15, 60, 20],
  hy4: [60, 240, 65],
  'hy4-preview': [30, 120, 35],
  hy3: [60, 240, 65],
  'grok-4.7': [15, 60, 20],
  'gpt-6-luna': [15, 60, 20],
  'gpt-5.6-luna': [15, 60, 20],
  'claude-haiku-5-5': [15, 60, 20],
  'gemini-4-argon': [30, 120, 35],
});

const limitsAt = (index) => Object.freeze(Object.fromEntries(Object.entries(PLAN_TABLE).map(([model, values]) => [model, values[index]])));
/** Monthly USD allowance per model for the default Go plan (kept exported for callers and tests). */
export const GO_LIMITS = limitsAt(0);
export const GO_PLAN_LIMITS = Object.freeze({ go: GO_LIMITS, plus: limitsAt(1), teams: limitsAt(2) });

/** The windows the plan measures usage in (a rolling 5 hours / 7 days / 30 days). */
const WINDOWS = [
  { key: 'used5h', ms: 5 * HOUR_MS },
  { key: 'used7d', ms: 7 * DAY_MS },
  { key: 'used30d', ms: 30 * DAY_MS },
];

const noteFor = (plan) => {
  const info = GO_PLANS[plan];
  const member = info.perMember ? ' Batas per anggota.' : '';
  return `Perkiraan dari token di ledger × harga list, dibandingkan batas paket ${info.label} (${info.price}).${member} Angka ini bukan tagihan.`;
};

const DEEPSEEK = /^deepseek/i;
// A row/catalog value that is not a usable number counts as 0 (never NaN in a sum).
const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const round = (value, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;
/**
 * Share of a window's allowance already spent, as a ratio (1 = the whole window, above 1 = over it), 4 decimals;
 * null when there is no finite limit to spend. The page multiplies by 100 for the bar, so the field is not 0–100.
 */
const ratio = (used, allowance) => (Number.isFinite(allowance) && allowance > 0 ? round(used / allowance, 4) : null);

/**
 * "opencode-go/deepseek-v4.1-flash#high" → "deepseek-v4.1-flash": neither the provider prefix nor the variant is part
 * of a catalog id, and a name without any of them is already the id.
 */
export function modelIdOf(model) {
  return String(model ?? '').replace(/^opencode-go\//, '').replace(/#.*$/, '').trim() || 'unknown';
}

/** DeepSeek's documented peak hours: weekdays 01:00–04:00 and 06:00–10:00 UTC. */
export function inPeakHours(ts) {
  const at = new Date(ts);
  const day = at.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** The peak factor a row is charged at: DeepSeek alone has a documented peak surcharge; outside those hours it is 1. */
function peakFactorFor(row, price) {
  const factor = num(price.peakFactor) || 1;
  return DEEPSEEK.test(modelIdOf(row.model)) && factor > 1 && inPeakHours(row.ts) ? factor : 1;
}

/**
 * What one ledger row cost at a catalog price (USD per 1M tokens for input, output, cache read and cache write).
 * A missing cache-write price costs nothing, and a DeepSeek row in a peak window pays the catalog's peak factor.
 * @param {object} row a ledger row (src/usage.js record())
 * @param {{ input: number, output: number, cacheRead: number, cacheWrite: number, peakFactor?: number }|null} price
 * @returns {number} USD, never NaN
 */
export function costOf(row, price) {
  if (!row || !price) return 0;
  const perMillion = num(row.input) * num(price.input) + num(row.output) * num(price.output) + num(row.cacheRead) * num(price.cacheRead) + num(row.cacheWrite) * num(price.cacheWrite);
  return (perMillion / 1e6) * peakFactorFor(row, price);
}

/**
 * Estimated Go allowance per model: USD spent in the last 5 hours / 7 days / 30 days, against 20% / 50% / 100% of the
 * model's monthly limit. `percent*` is the share of that window's allowance used (0..1+, 1 = 100%). Only rows of the
 * OpenCode engine/account count; a model with no plan limit keeps its usage with `limit: null`, and a free model is
 * reported as `limit: null` + `unlimited: true`. The models with the most of their month used come first.
 * @param {{ rows?: object[], prices?: object, now?: number, plan?: 'go'|'plus'|'teams' }} options prices = the
 *   catalog's `models` map; plan = the user's selected Go plan (unknown/missing falls back to Go)
 * @returns {{ plan: 'go'|'plus'|'teams', models: object[], note: string }}
 */
export function goAllowance({ rows = [], prices = {}, now = Date.now(), plan = 'go' } = {}) {
  const selected = Object.hasOwn(GO_PLANS, plan) ? plan : 'go';
  const limits = GO_PLAN_LIMITS[selected];
  const seen = new Map();
  for (const row of rows) {
    if (!row || engineOf(row) !== 'opencode') continue;
    const ts = num(row.ts);
    if (!ts || ts > now) continue; // a future row can't have been spent yet
    const model = modelIdOf(row.model);
    const price = prices?.[model] ?? null;
    const cost = costOf(row, price);
    const entry = seen.get(model) ?? { model, cost: { used5h: 0, used7d: 0, used30d: 0 } };
    const age = now - ts;
    for (const window of WINDOWS) if (age <= window.ms) entry.cost[window.key] += cost;
    seen.set(model, entry);
  }

  const models = [...seen.values()]
    .map(({ model, cost }) => {
      const monthly = Object.hasOwn(limits, model) ? limits[model] : null;
      const unlimited = monthly === Infinity;
      const used30d = round(cost.used30d);
      return {
        model,
        limit: Number.isFinite(monthly) ? monthly : null,
        ...(unlimited ? { unlimited: true } : {}),
        used5h: round(cost.used5h),
        used7d: round(cost.used7d),
        used30d,
        remaining: Number.isFinite(monthly) ? round(Math.max(0, monthly - used30d)) : null,
        percent5h: ratio(cost.used5h, monthly * 0.2),
        percent7d: ratio(cost.used7d, monthly * 0.5),
        percent30d: ratio(used30d, monthly),
      };
    })
    // A model with no known limit and nothing spent says nothing about the plan (a free one is still listed).
    .filter((m) => m.limit != null || m.unlimited || m.used5h || m.used7d || m.used30d)
    .sort((a, b) => (b.percent30d ?? 0) - (a.percent30d ?? 0) || b.used30d - a.used30d || a.model.localeCompare(b.model));

  return { plan: selected, models, note: noteFor(selected) };
}
