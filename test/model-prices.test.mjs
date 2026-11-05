// Model prices: parsing the OpenCode Go catalog, its daily cache, and the failure paths (never throws).
// No network: every fetch here is a fake, and the cache lives in a temp folder.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CACHE_FILE, parseGoCatalog, readModelPrices } from '../src/model-prices.js';

const HOUR = 60 * 60 * 1000;

const CATALOG = {
  data: [
    {
      id: 'hy4',
      name: 'HY4',
      cost: { text: { input: { price: 0.5, cache: { read: 0.05, write: 0.1 } }, output: { price: 2 } }, multipliers: [{ factor: 1.2 }, { factor: 1.5 }] },
    },
    // no cache.write, no multipliers (the endpoint omits both)
    { id: 'no-write', name: 'No Write', cost: { text: { input: { price: 1, cache: { read: 0.2 } }, output: { price: 3 } } } },
    // nothing priced: everything becomes 0 rather than undefined
    { id: 'bare', name: '' },
    { id: '   ', name: 'blank id is skipped' },
    { name: 'no id at all' },
    null,
  ],
};

const okResponse = (catalog) => ({ ok: true, text: async () => JSON.stringify(catalog) });
const failingFetch = async () => {
  throw new Error('offline');
};

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'model-prices-'));

test('parseGoCatalog reads prices, an absent cache write, and the highest peak factor', () => {
  const models = parseGoCatalog(CATALOG);
  assert.deepEqual(Object.keys(models).sort(), ['bare', 'hy4', 'no-write']);
  assert.deepEqual(models.hy4, { name: 'HY4', input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0.1, peakFactor: 1.5, hasPeak: true });
  assert.deepEqual(models['no-write'], { name: 'No Write', input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0, peakFactor: 1, hasPeak: false });
  assert.deepEqual(models.bare, { name: 'bare', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peakFactor: 1, hasPeak: false });
  assert.deepEqual(parseGoCatalog({}), {}, 'no data array');
  assert.deepEqual(parseGoCatalog(null), {}, 'not even an object');
});

test('readModelPrices: a fresh cache is served without any fetch', async () => {
  const dataDir = tempDir();
  const fetchedAt = Date.now() - HOUR;
  writeFileSync(path.join(dataDir, CACHE_FILE), JSON.stringify({ fetchedAt, source: 'opencode.ai', models: { hy4: { name: 'HY4', input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0.1, peakFactor: 1.5, hasPeak: true } } }));
  let calls = 0;
  const result = await readModelPrices({ dataDir, fetchImpl: async () => (calls++, okResponse(CATALOG)) });
  assert.equal(calls, 0, 'no network for a fresh cache');
  assert.equal(result.stale, false);
  assert.equal(result.fetchedAt, fetchedAt);
  assert.equal(result.source, 'opencode.ai');
  assert.equal(result.models.hy4.output, 2);
});

test('readModelPrices: a successful fetch is written atomically (tmp + rename, no tmp left)', async () => {
  const dataDir = tempDir();
  const now = Date.now();
  const result = await readModelPrices({ dataDir, now, fetchImpl: async () => okResponse(CATALOG) });
  assert.equal(result.stale, false);
  assert.equal(result.fetchedAt, now);
  assert.deepEqual(Object.keys(result.models).sort(), ['bare', 'hy4', 'no-write']);
  assert.deepEqual(readdirSync(dataDir), [CACHE_FILE], 'no leftover .tmp');
  const stored = JSON.parse(readFileSync(path.join(dataDir, CACHE_FILE), 'utf8'));
  assert.deepEqual(stored, { fetchedAt: now, source: 'opencode.ai', models: result.models }, 'only the catalog is stored');
});

test('readModelPrices: a failed fetch returns the stale cache, marked stale', async () => {
  const dataDir = tempDir();
  const fetchedAt = Date.now() - 3 * 24 * HOUR; // older than the TTL
  const models = { hy4: { name: 'HY4', input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0.1, peakFactor: 1.5, hasPeak: true } };
  writeFileSync(path.join(dataDir, CACHE_FILE), JSON.stringify({ fetchedAt, source: 'opencode.ai', models }));
  const result = await readModelPrices({ dataDir, fetchImpl: failingFetch });
  assert.equal(result.stale, true);
  assert.equal(result.fetchedAt, fetchedAt, 'the old catalog, with its own time');
  assert.deepEqual(result.models, models);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, CACHE_FILE), 'utf8')), { fetchedAt, source: 'opencode.ai', models }, 'the cache is kept as it was');
});

test('readModelPrices: no cache and a failed fetch → an empty catalog, never a throw', async () => {
  const dataDir = tempDir();
  for (const fetchImpl of [failingFetch, async () => ({ ok: false, status: 503, text: async () => '{}' }), async () => okResponse({ data: [] }), async () => ({ ok: true, text: async () => 'not json' })]) {
    const result = await readModelPrices({ dataDir, fetchImpl });
    assert.deepEqual({ fetchedAt: result.fetchedAt, models: result.models, stale: result.stale }, { fetchedAt: null, models: {}, stale: true });
  }
  assert.deepEqual(readdirSync(dataDir), [], 'nothing written for a failed fetch');
});

test('readModelPrices: a hung fetch is aborted at the timeout and still returns', async () => {
  const dataDir = tempDir();
  const hung = (url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const result = await readModelPrices({ dataDir, fetchImpl: hung, timeoutMs: 20 });
  assert.equal(result.stale, true);
  assert.deepEqual(result.models, {});
});

test('readModelPrices: an unreadable cache is ignored (a fresh fetch replaces it)', async () => {
  const dataDir = tempDir();
  writeFileSync(path.join(dataDir, CACHE_FILE), '{ broken');
  const result = await readModelPrices({ dataDir, fetchImpl: async () => okResponse(CATALOG) });
  assert.equal(result.stale, false);
  assert.ok(result.models.hy4);
});
