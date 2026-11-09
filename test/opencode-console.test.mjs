// 📊 OpenCode Go console data (src/opencode-console.js): normalization, micro-cents, period filtering, cache and
// the fallback when the console/token is unavailable. No real network and no real OpenCode here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleForPeriod, goConsoleSnapshot, normalizeConsoleActivity, normalizeConsoleStatus, normalizeUsageSummary, planOf } from '../src/opencode-console.js';

const status = {
  subscriberUserId: 'acc_secret',
  product: 'go-plus',
  renewalProduct: 'go-plus',
  paymentMethodId: 'payment_secret',
  access: {
    startsAt: '2026-10-21T06:39:17.000Z',
    endsAt: '2026-11-21T06:39:17.000Z',
    cancelAtPeriodEnd: false,
    meters: {
      fiveHour: { startsAt: '2026-11-08T23:17:00.000Z', resetsAt: '2026-11-09T04:17:00.000Z', limitMicroCents: '4800000000', usedMicroCents: '175312113' },
      week: { startsAt: '2026-11-09T00:00:00.000Z', resetsAt: '2026-11-16T00:00:00.000Z', limitMicroCents: '12000000000', usedMicroCents: '119989924' },
      month: { resetsAt: '2026-11-21T06:39:17.000Z', limitMicroCents: '24000000000', usedMicroCents: '8351257490' },
    },
  },
  teamsUpgradePrice: { amountMicroCents: '0', currency: 'usd' },
};

const activity = {
  startsAt: '2026-10-21T06:39:17.000Z',
  daily: [
    { date: '2026-11-08', totalCostMicroCents: '549653457', totalTokens: '618643867', totalRequests: '2278' },
    { date: '2026-11-09', totalCostMicroCents: '101900540', totalTokens: '112085150', totalRequests: '383' },
  ],
  models: [
    { provider: 'opencode-go', model: 'glm-5.3-flash', totalRequests: '244' },
    { provider: 'opencode-go', model: 'deepseek-v4.1-flash', totalRequests: '17406' },
  ],
};

const usageToday = {
  totalRequests: '512',
  totalInputTokens: '5300677',
  totalOutputTokens: '326582',
  totalCacheReadTokens: '181586432',
  totalCacheWrite5mTokens: '0',
  totalCacheWrite1hTokens: '0',
  totalCostMicroCents: '191237541',
  services: [],
};

const usageWeek = {
  totalRequests: '13274',
  totalInputTokens: '3000000',
  totalOutputTokens: '500000',
  totalCacheReadTokens: '3926443307',
  totalCacheWrite5mTokens: '0',
  totalCacheWrite1hTokens: '0',
  totalCostMicroCents: '3732473719',
};

const bin = { command: 'fake-opencode', args: [] };

test('normalizeConsoleStatus: plan, exact meters in USD, and no personal/payment fields', () => {
  const view = normalizeConsoleStatus(status);
  assert.equal(view.plan, 'plus');
  assert.equal(view.product, 'go-plus');
  assert.equal(view.activeUntil, '2026-11-21T06:39:17.000Z');
  assert.equal(view.meters.find((m) => m.key === 'fiveHour').usedUsd, 1.753121);
  assert.equal(view.meters.find((m) => m.key === 'fiveHour').limitUsd, 48);
  assert.equal(view.meters.find((m) => m.key === 'month').usedUsd, 83.512575);
  assert.equal(view.meters.find((m) => m.key === 'month').limitUsd, 240);
  assert.equal(view.meters.find((m) => m.key === 'month').percent, 0.348);
  assert.equal(JSON.stringify(view).includes('subscriberUserId'), false);
  assert.equal(JSON.stringify(view).includes('paymentMethodId'), false);
  assert.equal(JSON.stringify(view).includes('teamsUpgradePrice'), false);
  assert.equal(planOf('go'), 'go');
  assert.equal(planOf('go-teams'), 'teams');
  assert.equal(planOf('baru'), null);
});

test('normalizeConsoleActivity: daily totals, requests per model, sorted', () => {
  const view = normalizeConsoleActivity(activity);
  assert.equal(view.startsAt, '2026-10-21T06:39:17.000Z');
  assert.equal(view.daily.length, 2);
  assert.equal(view.daily[1].costUsd, 1.019005);
  assert.equal(view.totals.costUsd, 6.51554, 'both days are added and rounded');
  assert.equal(view.totals.tokens, 730729017);
  assert.equal(view.totals.requests, 2661);
  assert.deepEqual(view.models.map((m) => m.model), ['deepseek-v4.1-flash', 'glm-5.3-flash']);
  assert.equal(view.models[0].requests, 17406);
});

test('consoleForPeriod: only daily rows in the selected UTC dates', () => {
  const snapshot = { available: true, ...normalizeConsoleStatus(status), activity: normalizeConsoleActivity(activity), fetchedAt: 1 };
  const view = consoleForPeriod(snapshot, Date.parse('2026-11-09T00:00:00Z'), Date.parse('2026-11-09T23:59:59Z'));
  assert.equal(view.plan, 'plus');
  assert.deepEqual(view.daily.map((d) => d.date), ['2026-11-09']);
  assert.equal(view.totals.costUsd, 1.019005);
  assert.equal(consoleForPeriod({ available: false }, 0, Date.now()), null);
});

test('normalizeUsageSummary: cost, requests and the full token total', () => {
  const view = normalizeUsageSummary(usageToday);
  assert.equal(view.requests, 512);
  assert.equal(view.costUsd, 1.912375);
  assert.equal(view.tokens, 187213691);
  assert.equal(view.inputTokens, 5300677);
  assert.equal(view.outputTokens, 326582);
  assert.equal(view.cacheReadTokens, 181586432);
  assert.equal(view.cacheWriteTokens, 0);
  assert.equal(normalizeUsageSummary(null), null);
});

test('goConsoleSnapshot: exact status + activity + today/week usage, cached for the next call', async () => {
  let calls = 0;
  const fetch = async (url) => {
    calls += 1;
    const u = String(url);
    if (u.endsWith('/go/status')) return { ok: true, json: async () => status };
    if (u.includes('/usage/summary')) return { ok: true, json: async () => (u.includes('range=24h') ? usageToday : usageWeek) };
    return { ok: true, json: async () => activity };
  };
  const cache = new Map();
  const first = await goConsoleSnapshot(bin, { readToken: async () => 'tok_secret_123', fetch, cache, now: () => 1000 });
  assert.equal(first.available, true);
  assert.equal(first.plan, 'plus');
  assert.equal(first.activity.totals.requests, 2661);
  assert.equal(first.usage.today.requests, 512);
  assert.equal(first.usage.today.costUsd, 1.912375);
  assert.equal(first.usage.today.tokens, 187213691);
  assert.equal(first.usage.week.requests, 13274);
  assert.equal(first.fetchedAt, 1000);
  assert.equal(calls, 4, 'status + activity + today usage + week usage');
  assert.equal(JSON.stringify(first).includes('acc_secret'), false, 'the userId stays server-side');

  const second = await goConsoleSnapshot(bin, { readToken: async () => 'tok_secret_123', fetch, cache, now: () => 2000 });
  assert.equal(second, first, 'the cached snapshot is reused for a minute');
  assert.equal(calls, 4);
});

test('goConsoleSnapshot: missing token / 401 / network / bad shape fall back without throwing', async () => {
  const none = await goConsoleSnapshot(bin, { readToken: async () => null, fetch: async () => ({ ok: true, json: async () => ({}) }), cache: new Map() });
  assert.deepEqual([none.available, none.state], [false, 'no-token']);

  const expired = await goConsoleSnapshot(bin, {
    readToken: async () => 'token',
    fetch: async () => ({ ok: false, status: 401 }),
    cache: new Map(),
  });
  assert.deepEqual([expired.available, expired.state], [false, 'expired']);

  const down = await goConsoleSnapshot(bin, {
    readToken: async () => 'token',
    fetch: async () => {
      throw new Error('offline');
    },
    cache: new Map(),
  });
  assert.deepEqual([down.available, down.state], [false, 'shape']);

  const bad = await goConsoleSnapshot(bin, { readToken: async () => 'token', fetch: async () => ({ ok: true, json: async () => ({ foo: 1 }) }), cache: new Map() });
  assert.deepEqual([bad.available, bad.state], [false, 'shape']);
  assert.equal(JSON.stringify([none, expired, down, bad]).includes('tok_secret_123'), false, 'no token in a snapshot');
});
