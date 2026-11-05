// Price hints for the model picker (#model): the OpenCode Go catalog list price (USD per 1M tokens) and the app's own
// observed effective price from the usage ledger. Loaded lazily, kept in memory for 5 minutes, and never blocking a
// render: until the answer arrives (or when it fails, e.g. the route is refused on a plain-WiFi read-only page) the
// labels simply carry no suffix. The server is not trusted blindly: every number and id is checked here.
import { api, canCall } from '../core/api.js';

const PATH = '/api/models/prices';
const TTL = 5 * 60_000; // the catalog changes rarely; one request per 5 minutes is plenty
const MAX_ENTRIES = 3000;
const FAMILIES = ['haiku', 'sonnet', 'opus']; // a Claude alias ("sonnet") falls back to the family's busiest model

/** `{ fetchedAt, source, stale, prices: Map<model, price>, observed: Map<model, observed> }` or null. */
const cache = { data: null, at: 0, loading: false, retryAt: 0 };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');

/**
 * The `/api/models/prices` answer, validated: entries without a model id or a finite input/output price are dropped,
 * duplicates keep the first. `peakFactor` below 1 or missing means no peak. `observed` needs a finite perMillion.
 */
export function cleanPrices(data) {
  const prices = new Map();
  for (const raw of Array.isArray(data?.prices) ? data.prices : []) {
    const model = text(raw?.model);
    const input = num(raw?.input);
    const output = num(raw?.output);
    if (!model || input === null || output === null || prices.has(model) || prices.size >= MAX_ENTRIES) continue;
    prices.set(model, {
      model,
      name: text(raw?.name) || model,
      input,
      output,
      cacheRead: num(raw?.cacheRead) ?? 0,
      cacheWrite: num(raw?.cacheWrite) ?? 0,
      peakFactor: Math.max(1, num(raw?.peakFactor) ?? 1),
    });
  }
  const observed = new Map();
  for (const raw of Array.isArray(data?.observed) ? data.observed : []) {
    const model = text(raw?.model);
    const perMillion = num(raw?.perMillion);
    if (!model || perMillion === null || observed.has(model) || observed.size >= MAX_ENTRIES) continue;
    observed.set(model, {
      model,
      perMillion,
      records: Math.round(num(raw?.records) ?? 0),
      tokens: Math.round(num(raw?.tokens) ?? 0),
    });
  }
  return {
    fetchedAt: text(data?.fetchedAt),
    source: text(data?.source) || 'opencode.ai',
    stale: data?.stale === true,
    prices,
    observed,
  };
}

/**
 * The price data, asking the server when it is missing or older than 5 minutes. Returns what is cached right now
 * (null the first time) and calls `onLoaded` once the answer is in, so the caller never waits. Failures are
 * swallowed: the old data (or none) stays, and the next try waits for the normal TTL.
 */
export function modelPrices(onLoaded = () => {}) {
  const now = Date.now();
  if (cache.data && now - cache.at < TTL) return cache.data;
  if (cache.loading || now < cache.retryAt) return cache.data;
  if (!canCall(PATH)) return cache.data; // a plain-WiFi phone refuses this route: don't even ask
  cache.loading = true;
  api(PATH)
    .then((data) => {
      cache.data = cleanPrices(data);
      cache.at = Date.now();
      cache.retryAt = 0;
    })
    .catch(() => {
      cache.retryAt = Date.now() + TTL; // silent, as a phone on plain WiFi will always refuse it
    })
    .finally(() => {
      cache.loading = false;
      onLoaded();
    });
  return cache.data;
}

/** Tests only: forget the cached answer and any failed-attempt backoff. */
export function resetModelPrices() {
  cache.data = null;
  cache.at = 0;
  cache.loading = false;
  cache.retryAt = 0;
}

/** The price of a picker value: the exact OpenCode Go catalog entry, else the observed price (exact, then family). */
export function priceFor(value) {
  const data = cache.data;
  const id = typeof value === 'string' ? value : '';
  if (!data || !id) return null;
  if (id.startsWith('opencode-go/')) {
    const hit = data.prices.get(id);
    if (hit) return { kind: 'list', ...hit };
  }
  const exact = data.observed.get(id);
  if (exact) return { kind: 'observed', ...exact };
  // Family fallback for a Claude alias ("sonnet", "opus[1m]"): a provider-qualified id is a different model.
  if (id.includes('/')) return null;
  const family = FAMILIES.find((f) => id.toLowerCase().includes(f));
  if (!family) return null;
  const hit = [...data.observed.values()]
    .filter((o) => o.model.toLowerCase().includes(family))
    .sort((a, b) => b.records - a.records)[0]; // the busiest family member speaks for the alias
  return hit ? { kind: 'observed', ...hit } : null;
}

// ---------- formatting ----------

/** 2 decimals with trailing zeros trimmed: 0.15 → "0.15", 0.6 → "0.6", 0 → "0". */
const usd = (n) => String(Number(n.toFixed(2)));

/** Up to 4 decimals, trimmed: a cache-read price of 0.003 stays readable (usd() would show it as 0). */
const fine = (n) => String(Number(n.toFixed(4)));

/** 2 → "2", 1.5 → "1,5" (Indonesian decimal comma). */
const factor = (n) => fine(n).replace('.', ',');

/** " — $0.15 in / $0.6 out /1M", " — ±…" during peak hours, " — gratis" for a zero price. */
export function priceSuffix(value) {
  const p = priceFor(value);
  if (!p) return '';
  if (p.kind === 'list') {
    if (p.input === 0 && p.output === 0) return ' — gratis';
    return ` — ${p.peakFactor > 1 ? '±' : ''}$${usd(p.input)} in / $${usd(p.output)} out /1M`;
  }
  return ` — ≈$${usd(p.perMillion)}/1M tercatat`;
}

/** The option's tooltip: model id, the numbers behind the suffix, and where they come from. */
export function priceDetail(value) {
  const p = priceFor(value);
  if (!p) return '';
  if (p.kind === 'list') {
    if (p.input === 0 && p.output === 0) return `${p.model} · gratis (harga list OpenCode Go)`;
    const parts = [`$${fine(p.input)} input`, `$${fine(p.output)} output`];
    if (p.cacheRead > 0) parts.push(`$${fine(p.cacheRead)} cache read`);
    if (p.cacheWrite > 0) parts.push(`$${fine(p.cacheWrite)} cache write`);
    const peak = p.peakFactor > 1 ? ` · hingga ${factor(p.peakFactor)}× saat jam sibuk` : '';
    const stale = cache.data?.stale ? ' · data mungkin lama' : '';
    return `${p.model} · ${parts.join(' / ')} per 1 juta token · sumber ${cache.data?.source ?? 'opencode.ai'}${peak}${stale}`;
  }
  return `${p.model} · ≈$${fine(p.perMillion)} per 1 juta token tercatat · ${p.records} catatan · ${p.tokens} token · 90 hari terakhir`;
}

/** The muted line under the model select. Empty string = no note (no model chosen, or the demo project). */
export function priceNote(value) {
  const p = priceFor(value);
  if (!p) return value ? 'Belum ada data harga untuk model ini.' : '';
  if (p.kind === 'list') {
    if (p.input === 0 && p.output === 0) return 'Gratis';
    const parts = [`$${p.input.toFixed(2)} input`, `$${p.output.toFixed(2)} output`];
    if (p.cacheRead > 0) parts.push(`$${fine(p.cacheRead)} cache read`);
    if (p.cacheWrite > 0) parts.push(`$${fine(p.cacheWrite)} cache write`);
    const peak = p.peakFactor > 1 ? ` (bisa ${factor(p.peakFactor)}× saat jam sibuk)` : '';
    return `Harga list OpenCode Go: ${parts.join(' · ')} per 1 juta token${peak}`;
  }
  return `Harga efektif dari ${p.records} catatan: ≈$${fine(p.perMillion)} per 1 juta token`;
}
