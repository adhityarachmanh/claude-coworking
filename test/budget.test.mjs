// 💰 Batas pemakaian global (src/budget.js + Hub.cleanBudget/setBudget): the local day / week (Monday) / month
// windows over the token ledger, cost coverage, the off/ok/warn/over states and the validation of a limit.
// A throwaway ledger and data dir: nothing here touches your real data.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { BudgetError, budgetOverridden, budgetStop, budgetView, cleanBudgetPatch, cleanLimits, consumeBudgetOverride, grantBudgetOverride, hasBudget, spend, WARN_RATIO } from '../src/budget.js';
import { Hub } from '../src/hub.js';
import { periodStart, UsageLedger } from '../src/usage.js';

const A = { id: 'acc-a', email: 'kantor@example.com', org: null };
const temps = [];
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-budget-'));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** A local time in November 2026 (the tests must not depend on the machine's time zone). */
const at = (day, hour = 10, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();
const NOW = at(5, 12); // Thursday 5 Nov 2026, 12:00 local

/**
 * A ledger holding exactly `rows` (written as JSONL, so the times are the ones the test wants). Every row carries
 * `costUsd` as given: a number (0 included: an OpenCode Go row) or null (unpriced).
 */
function ledgerWith(rows) {
  const file = path.join(tempDir(), 'usage.jsonl');
  const line = (r) => ({
    ts: r.ts,
    account: A,
    engine: 'claude',
    source: 'web',
    project: 'toko',
    projectId: 'p1',
    sessionId: null,
    model: 'm',
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: r.costUsd ?? null,
    requests: 0,
    turns: 0,
  });
  writeFileSync(file, rows.map((r) => `${JSON.stringify(line(r))}\n`).join(''));
  return new UsageLedger({ file, account: () => A });
}

const ROWS = [
  { ts: at(5, 9), costUsd: 2 }, // today
  { ts: at(5, 10), costUsd: null }, // today, unpriced
  { ts: at(5, 11), costUsd: 0 }, // today, $0 (the usual OpenCode Go row)
  { ts: at(5, 18), costUsd: 100 }, // today but after `now`: outside every window
  { ts: at(4, 9), costUsd: 3 }, // Wednesday: this week + month
  { ts: at(2, 0), costUsd: 5 }, // Monday 00:00: this week starts here
  { ts: at(1, 23, 59), costUsd: 7 }, // Sunday 23:59: last week, this month
  { ts: new Date(2026, 9, 31, 9).getTime(), costUsd: 11 }, // 31 Oct: previous month
];

/** A hub stand-in that only carries the stored budget (budgetView reads nothing else). */
const hubOf = (budget) => ({ persisted: { budget } });

test('spend: local day / week (Monday) / month windows from every account, with the cost coverage', () => {
  const ledger = ledgerWith(ROWS);
  assert.equal(periodStart(NOW, 'week'), at(2, 0), 'the week starts on Monday at 00:00 local, not Sunday');
  assert.deepEqual(spend(ledger, NOW), {
    day: { usd: 2, rows: 3, known: 2 }, // 2 + null + 0; the 18:00 row is after `now`
    week: { usd: 10, rows: 5, known: 4 }, // Monday 00:00 included, Sunday 23:59 not
    month: { usd: 17, rows: 6, known: 5 }, // 1 Nov included, 31 Oct not
  });
  // the same rows a moment later: the windows are calendar periods, not "the last 24 h / 7 / 30 days"
  assert.deepEqual(spend(ledger, at(6, 0)).day, { usd: 0, rows: 0, known: 0 }, 'a new day starts empty');
  // a ctx without a ledger (a test, a future caller) spends 0 and never throws
  const none = { usd: 0, rows: 0, known: 0 };
  assert.deepEqual(spend(null, NOW), { day: none, week: none, month: none });
  assert.deepEqual(spend(undefined, NOW), { day: none, week: none, month: none });
});

test('spend: only a numeric costUsd counts, and float dust never reaches the view', () => {
  const ledger = ledgerWith([
    { ts: at(5, 9), costUsd: 0.1 },
    { ts: at(5, 10), costUsd: 0.2 },
    { ts: at(5, 11), costUsd: null },
  ]);
  assert.deepEqual(spend(ledger, NOW).day, { usd: 0.3, rows: 3, known: 2 });
});

test('budgetView: one window per limit with its share and state (off / ok / warn / over)', () => {
  const ledger = ledgerWith(ROWS);

  const off = budgetView(hubOf({ dailyUsd: null, weeklyUsd: null, monthlyUsd: null }), ledger, NOW);
  assert.deepEqual(off.budget, { dailyUsd: null, weeklyUsd: null, monthlyUsd: null });
  for (const unit of ['day', 'week', 'month']) {
    assert.deepEqual(off.windows[unit], { limit: null, usd: off.spend[unit].usd, percent: 0, state: 'off' }, unit);
  }
  assert.match(off.note, /OpenCode Go/, 'the note says why the sum can be lower than the bill');
  assert.match(off.note, /catatan punya biaya/);

  const view = budgetView(hubOf({ dailyUsd: 20, weeklyUsd: 50, monthlyUsd: 17 }), ledger, NOW);
  assert.deepEqual(view.windows.day, { limit: 20, usd: 2, percent: 0.1, state: 'ok' });
  assert.deepEqual(view.windows.week, { limit: 50, usd: 10, percent: 0.2, state: 'ok' });
  assert.deepEqual(view.windows.month, { limit: 17, usd: 17, percent: 1, state: 'over' }, 'usd >= limit is over');

  const warn = budgetView(hubOf({ dailyUsd: 2.5 }), ledger, NOW);
  assert.equal(warn.windows.day.percent, WARN_RATIO, '2 / 2,50 = 80%');
  assert.equal(warn.windows.day.state, 'warn');
  assert.equal(warn.windows.week.limit, null);

  const over = budgetView(hubOf({ dailyUsd: 1 }), ledger, NOW);
  assert.equal(over.windows.day.state, 'over');
  assert.equal(over.windows.day.percent, 2, 'percent passes 1 when over');

  // a hand-edited state.json: anything that is not a real limit reads as off
  const bad = budgetView(hubOf({ dailyUsd: -1, weeklyUsd: '10', monthlyUsd: 10001 }), ledger, NOW);
  assert.deepEqual(bad.budget, { dailyUsd: null, weeklyUsd: null, monthlyUsd: null });
  assert.deepEqual(bad.windows.month, { limit: null, usd: 17, percent: 0, state: 'off' });
});

test('budgetStop: null while under every limit, one clear message naming the window once over', () => {
  const ledger = ledgerWith(ROWS);
  assert.equal(budgetStop(hubOf({ dailyUsd: 6, weeklyUsd: null, monthlyUsd: null }), ledger, NOW), null, 'today $2 / $6');
  const stop = budgetStop(hubOf({ dailyUsd: 2, weeklyUsd: null, monthlyUsd: null }), ledger, NOW); // exactly at the limit
  assert.deepEqual(stop.windows, ['day']);
  assert.match(stop.label, /^harian \$2,00 \/ \$2,00$/);
  assert.match(stop.message, /Budget harian/);
  assert.match(stop.message, /Pengaturan → Umum → Budget pemakaian/);
  // A per-project limit is checked against that project's rows only; the global view stays clean.
  const projectHub = { persisted: { budget: { dailyUsd: null, weeklyUsd: null, monthlyUsd: null }, projectBudgets: { p1: { dailyUsd: 1, weeklyUsd: null, monthlyUsd: null } } } };
  const scoped = budgetStop(projectHub, ledger, NOW, 'p1');
  assert.deepEqual(scoped.projectWindows, ['day']);
  assert.match(scoped.label, /^project harian \$2,00 \/ \$1,00$/);
  assert.equal(budgetStop(projectHub, ledger, NOW, 'p2'), null, 'another project is untouched');
});

test('budget override: one turn, expires on its own, never consumed twice', () => {
  const hub = {};
  assert.equal(consumeBudgetOverride(hub, NOW), false, 'nothing granted');
  const until = grantBudgetOverride(hub, 5 * 60 * 1000, NOW);
  assert.equal(until, NOW + 300_000);
  assert.equal(budgetOverridden(hub, NOW + 1), true);
  assert.equal(consumeBudgetOverride(hub, NOW + 1), true);
  assert.equal(budgetOverridden(hub, NOW + 2), false, 'one prompt only');
  grantBudgetOverride(hub, 1000, NOW);
  assert.equal(budgetOverridden(hub, NOW + 1001), false, 'expired');
});

test('cleanLimits: only a real amount 0.01…10000 survives, rounded to cents (anything else is off)', () => {
  assert.deepEqual(cleanLimits({ dailyUsd: 12.346, weeklyUsd: 0, monthlyUsd: null }), { dailyUsd: 12.35, weeklyUsd: null, monthlyUsd: null });
  assert.deepEqual(cleanLimits({ dailyUsd: '5', weeklyUsd: -2, monthlyUsd: 20000 }), { dailyUsd: null, weeklyUsd: null, monthlyUsd: null });
  assert.deepEqual(cleanLimits(null), { dailyUsd: null, weeklyUsd: null, monthlyUsd: null });
  assert.deepEqual(cleanLimits(undefined), { dailyUsd: null, weeklyUsd: null, monthlyUsd: null });
  assert.equal(hasBudget({ dailyUsd: null, weeklyUsd: null, monthlyUsd: 0 }), false, '0 is off');
  assert.equal(hasBudget({ dailyUsd: null, weeklyUsd: 1, monthlyUsd: null }), true);
});

test('cleanBudgetPatch: cents-rounded limits, null / \'\' / 0 clear one, anything else is a 400 BudgetError', () => {
  assert.deepEqual(cleanBudgetPatch({ dailyUsd: 12.346, weeklyUsd: null, monthlyUsd: '' }), { dailyUsd: 12.35, weeklyUsd: null, monthlyUsd: null });
  assert.deepEqual(cleanBudgetPatch({ dailyUsd: 0 }), { dailyUsd: null }, '0 turns the limit off');
  assert.deepEqual(cleanBudgetPatch({ monthlyUsd: '12,5' }), { monthlyUsd: 12.5 }, 'a comma decimal from a form');
  assert.deepEqual(cleanBudgetPatch({}), {}, 'an absent key keeps its stored value');
  assert.deepEqual(cleanBudgetPatch(undefined), {});
  assert.deepEqual(cleanBudgetPatch({ dailyUsd: 10000 }), { dailyUsd: 10000 }, 'the maximum is allowed');
  assert.deepEqual(cleanBudgetPatch({ dailyUsd: 0.001 }), { dailyUsd: null }, 'below a cent rounds to 0 = off');

  const refused = [{ dailyUsd: 'abc' }, { dailyUsd: true }, { dailyUsd: {} }, { weeklyUsd: -1 }, { monthlyUsd: 10001 }, { dailyUsd: Number.NaN }, [{ dailyUsd: 5 }], 'x'];
  for (const bad of refused) {
    assert.throws(
      () => cleanBudgetPatch(bad),
      (err) => err instanceof BudgetError && err.status === 400 && /^(Batas|Data batas)/.test(err.message),
      JSON.stringify(bad),
    );
  }
  assert.throws(() => cleanBudgetPatch({ weeklyUsd: -1 }), /Batas mingguan harus antara \$0 dan \$10\.000/);
  assert.throws(() => cleanBudgetPatch({ dailyUsd: 'abc' }), /Batas harian harus berupa angka dolar/);
});

test('hub: setBudget rounds to cents, writes state.json at once, broadcasts, and never stores a bad value', () => {
  const dir = tempDir();
  const hub = new Hub({ dataDir: dir });
  assert.deepEqual(hub.persisted.budget, { dailyUsd: null, weeklyUsd: null, monthlyUsd: null }, 'off by default');
  const events = [];
  hub.broadcast = (type, data) => events.push({ type, data });

  const first = hub.setBudget({ dailyUsd: 12.346 });
  assert.deepEqual(first, { dailyUsd: 12.35, weeklyUsd: null, monthlyUsd: null });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).budget, first, 'written right away');
  assert.deepEqual(events, [{ type: 'budget', data: first }], 'open pages are told');

  assert.deepEqual(hub.setBudget({ dailyUsd: 20000, weeklyUsd: 'abc', monthlyUsd: 3 }), { dailyUsd: 12.35, weeklyUsd: null, monthlyUsd: 3 }, 'a bad value never replaces a stored limit');
  assert.deepEqual(hub.cleanBudget({ monthlyUsd: '7,256' }), { dailyUsd: 12.35, weeklyUsd: null, monthlyUsd: 7.26 }, 'a comma decimal, rounded to cents');
  hub.setBudget({ dailyUsd: 0, monthlyUsd: '' });
  assert.deepEqual(hub.persisted.budget, { dailyUsd: null, weeklyUsd: null, monthlyUsd: null }, '0 and "" turn a limit off');

  // a hand-edited state.json: only valid limits survive the next start
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ budget: { dailyUsd: -5, weeklyUsd: 5.5, monthlyUsd: 'x' } }));
  const restarted = new Hub({ dataDir: dir });
  assert.deepEqual(restarted.persisted.budget, { dailyUsd: null, weeklyUsd: 5.5, monthlyUsd: null });
});
