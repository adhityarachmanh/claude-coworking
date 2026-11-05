// List prices of the OpenCode Go models (PRD: the turn settings picker shows a cost per model).
//
// Source: the official catalog endpoint, not the docs page. Its shape (verified by hand):
//   { data: [{ id, name,
//              cost: { text: { input: { price, cache: { read, write } }, output: { price } },
//                      multipliers: [{ factor }] } }] }
// `price`/`cache.*` are USD per 1M tokens; `cache.write` may be absent; `multipliers` (peak hours) may be
// absent, and the highest factor is the one reported. Anything missing becomes 0, a bad entry is skipped.
//
// The catalog is cached in <dataDir>/model-prices.json as { fetchedAt, source, models } for a day, so the
// picker never waits on the network twice. A failed fetch (offline, HTTP error, timeout) returns the stale
// cache when there is one, or an empty catalog — this module never throws, and it writes no user data.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const GO_CATALOG_URL = 'https://opencode.ai/inference/go/v1/models';
export const SOURCE = 'opencode.ai';
export const CACHE_FILE = 'model-prices.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
// A runaway answer must not turn into a huge cache file.
const MAX_MODELS = 500;

const usd = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

/** The endpoint's JSON → { [id]: { name, input, output, cacheRead, cacheWrite, peakFactor, hasPeak } }. */
export function parseGoCatalog(json) {
  const entries = Array.isArray(json?.data) ? json.data.slice(0, MAX_MODELS) : [];
  const models = {};
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id.trim().slice(0, 120) : '';
    if (!id) continue;
    const text = entry.cost?.text;
    const input = text?.input;
    // Only a factor above 1 is a peak surcharge; a missing/garbled list leaves the price as listed.
    const factors = (Array.isArray(entry.cost?.multipliers) ? entry.cost.multipliers : [])
      .map((m) => m?.factor)
      .filter((f) => typeof f === 'number' && Number.isFinite(f) && f > 0);
    const peakFactor = factors.length ? Math.max(...factors) : 1;
    models[id] = {
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 200) : id,
      input: usd(input?.price),
      output: usd(text?.output?.price),
      cacheRead: usd(input?.cache?.read),
      cacheWrite: usd(input?.cache?.write),
      peakFactor,
      hasPeak: peakFactor > 1,
    };
  }
  return models;
}

/** Only the catalog fields are ever served or stored (a hand-edited cache can't smuggle anything else in). */
function cleanModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    name: typeof raw.name === 'string' ? raw.name.slice(0, 200) : '',
    input: usd(raw.input),
    output: usd(raw.output),
    cacheRead: usd(raw.cacheRead),
    cacheWrite: usd(raw.cacheWrite),
    peakFactor: usd(raw.peakFactor) || 1,
    hasPeak: raw.hasPeak === true,
  };
}

function readCache(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Number.isFinite(parsed.fetchedAt) || !parsed.models || typeof parsed.models !== 'object') return null;
    const models = {};
    for (const [id, raw] of Object.entries(parsed.models).slice(0, MAX_MODELS)) {
      const model = cleanModel(raw);
      if (model) models[String(id).slice(0, 120)] = model;
    }
    return { fetchedAt: parsed.fetchedAt, source: typeof parsed.source === 'string' ? parsed.source : SOURCE, models };
  } catch {
    return null; // no cache yet, or unreadable: treated as absent
  }
}

/** tmp + rename, so a crash mid-write never leaves a half-written cache; a leftover tmp is removed. */
function writeCache(file, data) {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
    return true;
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // already gone
    }
    console.error(`Menyimpan cache harga model gagal: ${err.message}`);
    return false;
  }
}

/**
 * The model catalog: the fresh cache, a new fetch, or (when that fails) the stale cache.
 * @param {{ dataDir: string, fetchImpl?: Function, now?: number, ttlMs?: number, timeoutMs?: number }} options
 * @returns {Promise<{ fetchedAt: number|null, source: string, models: object, stale: boolean }>} never throws
 */
export async function readModelPrices({ dataDir, fetchImpl = fetch, now = Date.now(), ttlMs = CACHE_TTL_MS, timeoutMs = FETCH_TIMEOUT_MS }) {
  const file = path.join(dataDir, CACHE_FILE);
  const cache = readCache(file);
  if (cache && now - cache.fetchedAt < ttlMs) return { ...cache, stale: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(GO_CATALOG_URL, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? '?'}`);
    const models = parseGoCatalog(JSON.parse(await response.text()));
    if (!Object.keys(models).length) throw new Error('katalog kosong');
    const next = { fetchedAt: now, source: SOURCE, models };
    writeCache(file, next);
    return { ...next, stale: false };
  } catch {
    // Offline, timeout, HTTP error or a changed shape: the last known catalog is still worth showing.
    return cache ? { ...cache, stale: true } : { fetchedAt: null, source: SOURCE, models: {}, stale: true };
  } finally {
    clearTimeout(timer);
  }
}
