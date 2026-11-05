// OpenCode Go allowance estimate: token windows, the token → USD pricing (cache and DeepSeek peak), the limits table,
// unknown and free models, and the empty ledger. No server, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOf, GO_LIMITS, GO_PLAN_LIMITS, GO_PLANS, goAllowance, inPeakHours, modelIdOf } from '../src/opencode-go.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Thursday 5 Nov 2026, 12:00 UTC: outside DeepSeek's peak hours.
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

const GLM = { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25, peakFactor: 1, hasPeak: false };
const DEEPSEEK = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, peakFactor: 2, hasPeak: true };

/** A ledger row of the OpenCode engine, as src/usage.js records it. */
const row = (model, ts, tokens = {}, extra = {}) => ({
  ts,
  account: { id: 'opencode', email: 'OpenCode', org: null },
  engine: 'opencode',
  source: 'web',
  project: 'toko',
  sessionId: 'ses_go',
  model,
  input: tokens.input ?? 0,
  output: tokens.output ?? 0,
  cacheRead: tokens.cacheRead ?? 0,
  cacheWrite: tokens.cacheWrite ?? 0,
  ...extra,
});

/** A Claude row: never part of the Go allowance. */
const claudeRow = (model, ts, tokens = {}) => row(model, ts, tokens, { account: { id: 'tester@example.com', email: 'tester@example.com', org: null }, engine: 'claude' });

test('model ids lose the provider prefix and the variant', () => {
  assert.equal(modelIdOf('opencode-go/glm-5.3'), 'glm-5.3');
  assert.equal(modelIdOf('opencode-go/deepseek-v4.1-flash#high'), 'deepseek-v4.1-flash');
  assert.equal(modelIdOf('glm-5.3'), 'glm-5.3');
  assert.equal(modelIdOf(''), 'unknown');
  assert.equal(modelIdOf(null), 'unknown');
});

test('5h / 7d / 30d windows: only rows inside a window count, and only OpenCode rows', () => {
  const rows = [
    row('opencode-go/glm-5.3', NOW - HOUR, { input: 1_000_000 }),
    row('opencode-go/glm-5.3', NOW - 6 * HOUR, { input: 1_000_000 }), // in 7d, out of 5h
    row('opencode-go/glm-5.3', NOW - 3 * DAY, { input: 1_000_000 }), // in 30d, out of 7d
    row('opencode-go/glm-5.3', NOW - 20 * DAY, { input: 1_000_000 }),
    claudeRow('glm-5.3', NOW - HOUR, { input: 5_000_000 }), // same model id, another engine: ignored
  ];
  const { plan, models, note } = goAllowance({ rows, prices: { 'glm-5.3': GLM }, now: NOW });
  assert.equal(plan, 'go');
  assert.match(note, /Perkiraan/);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], {
    model: 'glm-5.3',
    limit: 15,
    used5h: 1,
    used7d: 3,
    used30d: 4,
    remaining: 11,
    percent5h: 0.3333, // 1 of 20% × 15 = 3: a third of the 5-hour allowance
    percent7d: 0.4, // 3 of 50% × 15 = 7.5
    percent30d: 0.2667, // 4 of 15 (0..1: the page multiplies by 100)
  });
});

test('a row older than 30 days is neither spent nor shown for a model it alone mentions', () => {
  const rows = [row('opencode-go/mystery-1', NOW - 31 * DAY, { input: 1_000_000 })];
  assert.deepEqual(goAllowance({ rows, prices: { 'mystery-1': GLM }, now: NOW }).models, [], 'no limit, no spend: nothing to say');
  // A model with a plan limit stays listed, with zeros, so its allowance is visible.
  const known = goAllowance({ rows: [row('opencode-go/glm-5.3', NOW - 31 * DAY, { input: 1_000_000 })], prices: {}, now: NOW }).models;
  assert.equal(known.length, 1);
  assert.deepEqual([known[0].limit, known[0].used30d, known[0].remaining], [15, 0, 15]);
});

test('tokens → USD: input, output and both cache prices, a missing cache-write price is free', () => {
  const tokens = { input: 1_000_000, output: 2_000_000, cacheRead: 4_000_000, cacheWrite: 8_000_000 };
  assert.equal(costOf(row('opencode-go/glm-5.3', NOW, tokens), GLM), 9); // 1 + 4 + 2 + 2
  const { cacheWrite: _ignored, ...noWrite } = GLM;
  assert.equal(costOf(row('opencode-go/glm-5.3', NOW, tokens), noWrite), 7, 'cacheWrite falls back to 0');
  assert.equal(costOf(row('opencode-go/glm-5.3', NOW, tokens), null), 0, 'no price, no cost');
  assert.equal(costOf(null, GLM), 0);
  assert.equal(costOf(row('opencode-go/glm-5.3', NOW, { input: -5, output: 'x' }), GLM), 0, 'a malformed count never makes NaN');
});

test('DeepSeek peak: ×2 on weekday 01:00–04:00 and 06:00–10:00 UTC, the listed price otherwise', () => {
  const at = (ts) => costOf(row('opencode-go/deepseek-v4.1-flash', ts, { input: 1_000_000 }), DEEPSEEK);
  const wed = (hour, minute = 0) => Date.UTC(2026, 10, 4, hour, minute); // Wednesday
  assert.equal(at(wed(2)), 2, 'weekday 02:00 UTC: peak');
  assert.equal(at(wed(1)), 2, 'the window opens at 01:00');
  assert.equal(at(wed(3, 59)), 2);
  assert.equal(at(wed(4)), 1, '04:00 is outside the window');
  assert.equal(at(wed(6)), 2, 'the second window opens at 06:00');
  assert.equal(at(wed(9, 59)), 2);
  assert.equal(at(wed(10)), 1);
  assert.equal(at(wed(12)), 1, 'weekday 12:00 UTC: list price');
  assert.equal(at(Date.UTC(2026, 10, 7, 2)), 1, 'Saturday 02:00: no peak');
  assert.equal(inPeakHours(wed(2)), true);
  assert.equal(inPeakHours(Date.UTC(2026, 10, 8, 2)), false, 'Sunday');
  // The documented peak window is DeepSeek's: another model keeps its list price even with a peak factor.
  assert.equal(costOf(row('opencode-go/glm-5.3', wed(2), { input: 1_000_000 }), { ...GLM, peakFactor: 2 }), 1);
});

test('a model with no plan limit keeps its usage (limit and percentages are null)', () => {
  const rows = [row('opencode-go/mystery-9', NOW - HOUR, { input: 1_000_000 })];
  const [m] = goAllowance({ rows, prices: { 'mystery-9': GLM }, now: NOW }).models;
  assert.deepEqual(m, { model: 'mystery-9', limit: null, used5h: 1, used7d: 1, used30d: 1, remaining: null, percent5h: null, percent7d: null, percent30d: null });
  assert.ok(!('unlimited' in m), 'unknown is not unlimited');
});

test('a free Go model has no monthly limit: limit null, unlimited true, even with no spend', () => {
  assert.equal(GO_LIMITS['beam-free'], Infinity);
  assert.equal(GO_LIMITS['iceman-contributor-free'], Infinity);
  // Not in the catalog at all: nothing is spent, but "unlimited" is not "unknown", so the model is still listed.
  const [free] = goAllowance({ rows: [row('opencode-go/beam-free', NOW - HOUR, { input: 1_000_000 })], prices: {}, now: NOW }).models;
  assert.deepEqual(free, { model: 'beam-free', limit: null, unlimited: true, used5h: 0, used7d: 0, used30d: 0, remaining: null, percent5h: null, percent7d: null, percent30d: null });
  // Priced anyway (the catalog has prices for it): the spend is estimated, the allowance stays unlimited.
  const [priced] = goAllowance({ rows: [row('opencode-go/beam-free', NOW - HOUR, { input: 1_000_000 })], prices: { 'beam-free': GLM }, now: NOW }).models;
  assert.deepEqual([priced.used5h, priced.limit, priced.unlimited, priced.percent5h], [1, null, true, null]);
});

test('sorted by the share of the month used, then by spend', () => {
  const rows = [
    row('opencode-go/glm-5.3', NOW - HOUR, { input: 3_000_000 }), // 3 of 15 = 20%
    row('opencode-go/mimo-v2.6-flash', NOW - HOUR, { input: 30_000_000 }), // 30 of 60 = 50%
    row('opencode-go/kimi-k3', NOW - HOUR, { input: 12_000_000 }), // 12 of 15 = 80%
  ];
  const prices = { 'glm-5.3': GLM, 'mimo-v2.6-flash': GLM, 'kimi-k3': GLM };
  assert.deepEqual(goAllowance({ rows, prices, now: NOW }).models.map((m) => [m.model, m.percent30d]), [
    ['kimi-k3', 0.8],
    ['mimo-v2.6-flash', 0.5],
    ['glm-5.3', 0.2],
  ]);
});

test('Go Plus and Go Teams use their own monthly table, with Teams limits per member', () => {
  assert.deepEqual(Object.keys(GO_PLANS), ['go', 'plus', 'teams']);
  assert.equal(GO_PLANS.teams.perMember, true);
  assert.equal(GO_PLAN_LIMITS.plus['glm-5.3'], 120);
  assert.equal(GO_PLAN_LIMITS.teams['glm-5.3'], 20);
  assert.equal(GO_PLAN_LIMITS.plus['kimi-k2.5'], null, 'an older model has no Plus/Teams row, not a guessed limit');
  const rows = [
    row('opencode-go/glm-5.3', NOW - HOUR, { input: 1_000_000 }),
    row('opencode-go/glm-5.3', NOW - 6 * HOUR, { input: 1_000_000 }),
    row('opencode-go/glm-5.3', NOW - 3 * DAY, { input: 2_000_000 }),
  ];
  const plus = goAllowance({ rows, prices: { 'glm-5.3': GLM }, now: NOW, plan: 'plus' });
  assert.equal(plus.plan, 'plus');
  assert.match(plus.note, /Go Plus/);
  assert.match(plus.note, /\$40\/bulan/);
  assert.deepEqual([plus.models[0].limit, plus.models[0].used30d, plus.models[0].remaining, plus.models[0].percent30d], [120, 4, 116, 0.0333]);
  const teams = goAllowance({ rows, prices: { 'glm-5.3': GLM }, now: NOW, plan: 'teams' });
  assert.equal(teams.plan, 'teams');
  assert.match(teams.note, /Go Teams/);
  assert.match(teams.note, /per anggota/);
  assert.deepEqual([teams.models[0].limit, teams.models[0].remaining, teams.models[0].percent30d], [20, 16, 0.2]);
});

test('an unknown plan falls back to Go; a plan without a model leaves the limit unknown, not zero', () => {
  const rows = [row('opencode-go/kimi-k2.5', NOW - HOUR, { input: 1_000_000 })];
  const fallback = goAllowance({ rows, prices: { 'kimi-k2.5': GLM }, now: NOW, plan: 'enterprise' });
  assert.equal(fallback.plan, 'go');
  assert.equal(fallback.models[0].limit, 60);
  const plus = goAllowance({ rows, prices: { 'kimi-k2.5': GLM }, now: NOW, plan: 'plus' });
  assert.equal(plus.plan, 'plus');
  assert.equal(plus.models[0].limit, null);
  assert.equal(plus.models[0].remaining, null);
});

test('no rows → an empty estimate, never a throw', () => {
  for (const rows of [[], undefined]) {
    assert.deepEqual(goAllowance({ rows, prices: {}, now: NOW }), { plan: 'go', models: [], note: goAllowance({ rows: [], prices: {}, now: NOW }).note });
  }
  assert.deepEqual(goAllowance({ now: NOW }).models, []);
});
