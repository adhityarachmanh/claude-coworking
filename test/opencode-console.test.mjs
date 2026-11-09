// 📊 OpenCode Go console data (src/opencode-console.js): normalization, micro-cents, period filtering, cache and
// the fallback when the console/token is unavailable. No real network and no real OpenCode here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consoleForPeriod, consoleRequestLogs, consoleRequestTotals, consoleRequestTotalsCached, goConsoleSnapshot, normalizeConsoleActivity, normalizeConsoleStatus, normalizeRequestLogs, normalizeUsageModels, normalizeUsageSummary, planOf } from '../src/opencode-console.js';

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

const modelsToday = {
  items: [
    { model: 'deepseek-v4.1-flash', provider: 'opencode-go', totalRequests: '564', totalInputTokens: '6727223', totalOutputTokens: '360976', totalCacheReadTokens: '212861568', totalCacheWrite5mTokens: '0', totalCacheWrite1hTokens: '0', totalCostMicroCents: '256257742' },
    { model: 'hy4', provider: 'opencode-go', totalRequests: '2', totalInputTokens: '2707', totalOutputTokens: '3174', totalCacheReadTokens: '30848', totalCacheWrite5mTokens: '0', totalCacheWrite1hTokens: '0', totalCostMicroCents: '1149142' },
  ],
  pageInfo: { page: 1, pageSize: 100, total: 2, pageCount: 1 },
};

const modelsWeek = { items: [], pageInfo: { page: 1, pageSize: 100, total: 0, pageCount: 0 } };

const requestLog = {
  items: [
    {
      id: 'req_secret',
      requestID: 'req_secret',
      workspaceID: 'wrk_secret',
      sessionID: 'ses_secret',
      userID: 'acc_secret',
      startedAt: 1794190300730,
      finishedAt: 1794190307173,
      durationMs: 6443,
      outcome: 'succeeded',
      app: 'acp',
      model: 'deepseek-v4.1-flash',
      statusCode: 200,
      timeToFirstTokenMs: 4267,
      inputTokens: 614,
      outputTokens: 399,
      reasoningTokens: 78,
      cacheReadTokens: 726272,
      cacheWriteTokens: 0,
      cost: 0.00502063,
      attemptCount: 1,
      finish: { reason: 'stop' },
      requestHeaders: { authorization: 'Bearer secret' },
      country: 'ID',
      region: 'Jakarta',
      city: 'Jakarta',
    },
  ],
  nextCursor: 'next-page',
  until: '2026-11-09T00:00:00.000Z',
  retentionDays: 30,
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

test('normalizeUsageModels: per-model requests, tokens, cache write and cost', () => {
  const view = normalizeUsageModels(modelsToday);
  assert.equal(view.total, 2);
  assert.equal(view.models[0].model, 'deepseek-v4.1-flash');
  assert.equal(view.models[0].requests, 564);
  assert.equal(view.models[0].tokens, 6727223 + 360976 + 212861568);
  assert.equal(view.models[0].cacheWriteTokens, 0);
  assert.equal(view.models[0].costUsd, 2.562577);
  assert.equal(view.models[1].model, 'hy4');
  assert.equal(normalizeUsageModels(null), null);
});

test('goConsoleSnapshot: exact status + activity + today/week usage, cached for the next call', async () => {
  let calls = 0;
  const fetch = async (url) => {
    calls += 1;
    const u = String(url);
    if (u.endsWith('/go/status')) return { ok: true, json: async () => status };
    if (u.includes('/usage/models')) return { ok: true, json: async () => (u.includes('range=24h') ? modelsToday : modelsWeek) };
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
  assert.equal(first.usage.today.models[0].model, 'deepseek-v4.1-flash');
  assert.equal(first.usage.week.requests, 13274);
  assert.equal(first.fetchedAt, 1000);
  assert.equal(calls, 6, 'status + activity + two summaries + two model tables');
  assert.equal(JSON.stringify(first).includes('acc_secret'), false, 'the userId stays server-side');

  const second = await goConsoleSnapshot(bin, { readToken: async () => 'tok_secret_123', fetch, cache, now: () => 2000 });
  assert.equal(second, first, 'the cached snapshot is reused for a minute');
  assert.equal(calls, 6);
});

test('normalizeRequestLogs: safe request fields only, no ids/headers/geo', () => {
  const view = normalizeRequestLogs(requestLog);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].model, 'deepseek-v4.1-flash');
  assert.equal(view.items[0].app, 'acp');
  assert.equal(view.items[0].durationMs, 6443);
  assert.equal(view.items[0].ttftMs, 4267);
  assert.equal(view.items[0].costUsd, 0.00502063);
  assert.equal(view.items[0].finishReason, 'stop');
  assert.equal(view.nextCursor, 'next-page');
  assert.equal(view.cursorDropped, false);
  assert.equal(view.retentionDays, 30);
  const json = JSON.stringify(view);
  for (const secret of ['req_secret', 'wrk_secret', 'ses_secret', 'acc_secret', 'authorization', 'Jakarta']) assert.equal(json.includes(secret), false, secret);
});

test('consoleRequestLogs: session/model/cursor are sent; the response is normalized', async () => {
  let seen = null;
  const result = await consoleRequestLogs(bin, {
    sessionId: 'ses_abcdef',
    model: 'deepseek-v4.1-flash',
    since: 1_700_000_000_000,
    limit: 50,
    cursor: 'page-2',
    readToken: async () => 'tok_secret_123',
    fetch: async (url) => {
      seen = String(url);
      return { ok: true, json: async () => requestLog };
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.items[0].costUsd, 0.00502063);
  assert.match(seen, /category=inference/);
  assert.match(seen, /sessionID=ses_abcdef/);
  assert.match(seen, /model=deepseek-v4\.1-flash/);
  assert.match(seen, /limit=50/);
  assert.match(seen, /cursor=page-2/);
  assert.match(seen, /since=1700000000000/);
  assert.equal(JSON.stringify(result).includes('tok_secret_123'), false, 'token never in the result');

  const bad = await consoleRequestLogs(bin, { sessionId: 'bukan-sesi', readToken: async () => 'x', fetch: async () => ({ ok: true, json: async () => requestLog }) });
  assert.deepEqual([bad.available, bad.state], [false, 'bad-params']);
});

test('consoleRequestTotals: walks cursor pages and sums provider cost/tokens for one session', async () => {
  let calls = 0;
  const result = await consoleRequestTotals(bin, {
    sessionId: 'ses_abcdef',
    readToken: async () => 'tok_secret_123',
    fetch: async (url) => {
      calls += 1;
      assert.match(String(url), /sessionID=ses_abcdef/);
      if (calls === 1) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { startedAt: 1, model: 'm', cost: 0.005, inputTokens: 10, outputTokens: 2, reasoningTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5 },
              { startedAt: 2, model: 'm', cost: 0.006, inputTokens: 1 },
            ],
            nextCursor: 'page-2',
            retentionDays: 30,
          }),
        };
      }
      return { ok: true, json: async () => ({ items: [{ startedAt: 3, model: 'm', cost: 0.007, inputTokens: 2 }], nextCursor: null, retentionDays: 30 }) };
    },
  });
  assert.equal(result.available, true);
  assert.deepEqual(result.totals, { requests: 3, tokens: 10 + 2 + 3 + 4 + 5 + 1 + 2, costUsd: 0.018 });
  assert.equal(result.pages, 2);
  assert.equal(result.truncated, false);
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(result).includes('tok_secret_123'), false);

  const truncated = await consoleRequestTotals(bin, {
    sessionId: 'ses_abcdef',
    maxPages: 1,
    readToken: async () => 'tok',
    fetch: async () => ({ ok: true, json: async () => ({ items: [{ startedAt: 1, model: 'm', cost: 0.1 }], nextCursor: 'more', retentionDays: 30 }) }),
  });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.pages, 1);

  const dropped = await consoleRequestTotals(bin, {
    sessionId: 'ses_abcdef',
    readToken: async () => 'tok',
    fetch: async () => ({ ok: true, json: async () => ({ items: [{ startedAt: 1, model: 'm', cost: 0.1 }], nextCursor: 'x'.repeat(501) }) }),
  });
  assert.equal(dropped.truncated, true, 'a dropped cursor is never reported as complete');
});

test('consoleRequestTotalsCached: parallel/duplicate reports share one page walk', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const page = { ok: true, json: async () => ({ items: [{ startedAt: 1, model: 'm', cost: 0.2, inputTokens: 7 }], nextCursor: null }) };
  const opts = {
    sessionId: 'ses_cached_1',
    since: 1,
    readToken: async () => 'tok_cached',
    fetch: async () => {
      calls += 1;
      await gate;
      return page;
    },
  };
  const first = consoleRequestTotalsCached(bin, opts);
  const second = consoleRequestTotalsCached(bin, opts);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1, 'the in-flight walk is shared');
  assert.deepEqual(a.totals, b.totals);
  const cached = await consoleRequestTotalsCached(bin, { ...opts, fetch: async () => { calls += 1; return page; } });
  assert.equal(calls, 1, 'a successful result is reused for a minute');
  assert.deepEqual(cached.totals, a.totals);
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
