// Cost estimate before send: the pure maths behind #cost-estimate (no DOM, no network).
// The price object is exactly what features/model-prices.js priceFor() returns, so these numbers are the ones the
// composer shows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateUsd, formatEstimate, isPeak } from '../public/js/core/cost-estimate.js';

// Thursday 2026-11-05, 12:00 UTC (off-peak) and 02:00 UTC (peak).
const OFF_PEAK = Date.UTC(2026, 10, 5, 12, 0);
const PEAK = Date.UTC(2026, 10, 5, 2, 0);
const SATURDAY_PEAK = Date.UTC(2026, 10, 7, 2, 0);

const LIST = { kind: 'list', input: 3, output: 0.6, cacheRead: 0.3, cacheWrite: 0, peakFactor: 2 };
const FLAT = { kind: 'list', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, peakFactor: 1 };
const OBSERVED = { kind: 'observed', perMillion: 1.23, records: 7, tokens: 1_234_567 };

test('estimateUsd: list price = (context×cacheRead + prompt×input + output×output) / 1M', () => {
  const est = estimateUsd(LIST, { contextTokens: 100_000, promptChars: 400, outputTokens: 1000, at: OFF_PEAK });
  assert.equal(est.usd, 30900 / 1e6, '30000 + 300 + 600 token-dollar over 1 juta');
  assert.deepEqual(
    { kind: est.kind, promptTokens: est.promptTokens, contextTokens: est.contextTokens, outputTokens: est.outputTokens },
    { kind: 'list', promptTokens: 100, contextTokens: 100_000, outputTokens: 1000 },
  );
  assert.equal(formatEstimate(est), '±$0,03');
});

test('estimateUsd: peakFactor only multiplies the token part, and only inside a weekday peak hour', () => {
  const peak = estimateUsd(LIST, { contextTokens: 100_000, promptChars: 400, outputTokens: 1000, at: PEAK });
  const off = estimateUsd(LIST, { contextTokens: 100_000, promptChars: 400, outputTokens: 1000, at: OFF_PEAK });
  assert.equal(peak.usd, off.usd * 2, 'jam sibuk: 2× harga token');
  assert.equal(formatEstimate(peak), '±$0,06');
  assert.equal(estimateUsd(LIST, { contextTokens: 100_000, promptChars: 400, outputTokens: 1000, at: SATURDAY_PEAK }).usd, off.usd, 'akhir pekan: tanpa factor');
  assert.equal(estimateUsd({ ...LIST, peakFactor: 1 }, { contextTokens: 100_000, promptChars: 400, outputTokens: 1000, at: PEAK }).usd, off.usd, 'tanpa peakFactor: tidak ada tambahan');
});

test('estimateUsd: observed price = all tokens × perMillion / 1M, never a peak factor', () => {
  const est = estimateUsd(OBSERVED, { contextTokens: 10_000, promptChars: 400, outputTokens: 600, at: PEAK });
  assert.equal(est.usd, (10_700 * 1.23) / 1e6);
  assert.equal(est.kind, 'observed');
  assert.equal(formatEstimate(est), '±$0,01');
  assert.equal(estimateUsd(OBSERVED, { contextTokens: 10_000, promptChars: 400, outputTokens: 600, at: OFF_PEAK }).usd, est.usd, 'jam tidak mengubah harga tercatat');
});

test('estimateUsd: prompt tokens round up from ~4 characters per token', () => {
  const tokens = (promptChars) => estimateUsd(FLAT, { promptChars, outputTokens: 0, at: OFF_PEAK }).promptTokens;
  assert.equal(tokens(0), 0);
  assert.equal(tokens(1), 1);
  assert.equal(tokens(4), 1);
  assert.equal(tokens(5), 2);
  assert.equal(tokens(401), 101);
});

test('estimateUsd: zero context is a prompt-only estimate (and negative context is clamped)', () => {
  const est = estimateUsd(FLAT, { promptChars: 400, outputTokens: 0, at: OFF_PEAK });
  assert.equal(est.contextTokens, 0);
  assert.equal(est.usd, 100 / 1e6);
  assert.equal(estimateUsd(FLAT, { contextTokens: -500, promptChars: 400, outputTokens: 0, at: OFF_PEAK }).contextTokens, 0);
});

test('estimateUsd: an unusable price gives null instead of NaN (odd token numbers are clamped)', () => {
  for (const price of [null, undefined, 'list', 42, {}, { kind: 'other', perMillion: 1 }, { kind: 'list' }, { kind: 'list', input: -1, output: 1 }, { kind: 'observed' }, { kind: 'observed', perMillion: Number.NaN }, { kind: 'observed', perMillion: -2 }]) {
    assert.equal(estimateUsd(price, { promptChars: 10 }), null, JSON.stringify(price));
  }
  assert.equal(estimateUsd(FLAT, { promptChars: Number.NaN }).promptTokens, 0, 'NaN bukan jumlah karakter');
  assert.equal(estimateUsd(FLAT, { promptChars: -3, contextTokens: Number.POSITIVE_INFINITY, outputTokens: 0 }).promptTokens, 0, 'input aneh dianggap 0');
  assert.equal(estimateUsd(FLAT, null).outputTokens, 600, 'opsi null tidak melempar: asumsi bawaan dipakai');
});

test('isPeak: weekdays 01:00–04:00 and 06:00–10:00 UTC only', () => {
  const at = (hour, minute = 0, day = 5) => Date.UTC(2026, 10, day, hour, minute);
  for (const t of [at(1), at(3, 59), at(6), at(9, 59)]) assert.equal(isPeak(t), true, new Date(t).toISOString());
  for (const t of [at(0, 59), at(4), at(5, 59), at(10), at(12), at(2, 0, 7), at(2, 0, 8)]) assert.equal(isPeak(t), false, new Date(t).toISOString());
  assert.equal(isPeak(new Date(PEAK)), true, 'menerima Date');
  assert.equal(isPeak(Number.NaN), false);
  assert.equal(isPeak('bukan tanggal'), false);
});

test('formatEstimate: two decimals with an Indonesian comma, half a cent and below as "<$0,01"', () => {
  assert.equal(formatEstimate({ usd: 0.0234 }), '±$0,02');
  assert.equal(formatEstimate({ usd: 1.5 }), '±$1,50');
  assert.equal(formatEstimate({ usd: 0.0049 }), '±<$0,01');
  assert.equal(formatEstimate({ usd: 0 }), '±<$0,01');
  assert.equal(formatEstimate({ usd: 0.005 }), '±$0,01');
  assert.equal(formatEstimate(null), '');
  assert.equal(formatEstimate({}), '');
  assert.equal(formatEstimate({ usd: Number.NaN }), '');
  assert.equal(formatEstimate({ usd: -1 }), '');
});
