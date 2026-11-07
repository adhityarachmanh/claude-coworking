// Account usage: `/usage` parsing, the per-account token ledger, and the PDF report.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { billingStatus, parseUsageText, usageNote } from '../src/account.js';
import { findBrowser, periodLabel, renderPdf, reportHtml } from '../src/report.js';
import { byPeriod, ENGINES, engineOf, periodStart, summarize, totals, UsageLedger } from '../src/usage.js';

const A = { id: 'uuid-a', email: 'kantor@example.com', org: 'Kantor' };
const B = { id: 'uuid-b', email: 'pribadi@example.com', org: null };

function ledgerWithTwoAccounts() {
  let who = A;
  const ledger = new UsageLedger({ file: path.join(mkdtempSync(path.join(tmpdir(), 'usage-')), 'usage.jsonl'), account: () => who });
  const turn = (model, input, output, cacheRead, extra = {}) => ledger.record({ source: 'web', project: { id: 'p1', name: 'toko' }, sessionId: 's1', model, input, output, cacheRead, cacheWrite: 0, turns: 1, ...extra });
  turn('opus', 100, 50, 900, { costUsd: 0.5 });
  turn('sonnet', 10, 5, 0);
  who = B;
  turn('opus', 7, 3, 0, { source: 'cli', project: { id: 'p2', name: 'blog' } });
  who = null; // logged out: cannot be attributed, so it is not recorded
  turn('opus', 1, 1, 1);
  return ledger;
}

test('parseUsageText reads the plan usage lines of /usage', () => {
  const text = 'Current session: 4% used · resets Oct 31, 10:40am (Asia/Jakarta)\nCurrent week (all models): 20.5% used · resets Nov 3, 9am (Asia/Jakarta)\nCurrent week (Fable): 0% used\nsomething else';
  assert.deepEqual(parseUsageText(text), [
    { label: 'Current session', percent: 4, resets: 'Oct 31, 10:40am (Asia/Jakarta)' },
    { label: 'Current week (all models)', percent: 20.5, resets: 'Nov 3, 9am (Asia/Jakarta)' },
    { label: 'Current week (Fable)', percent: 0, resets: null },
  ]);
});

test('usageNote keeps the /usage message of accounts without "% used" windows (Enterprise)', () => {
  const enterprise = "You've already sent a usage credit request to your admin.\n";
  assert.deepEqual(parseUsageText(enterprise), [], 'nothing to draw as a bar');
  assert.equal(usageNote(enterprise), "You've already sent a usage credit request to your admin.");
  // the tips section is about this machine, not the plan; ANSI colours are dropped
  const tips = "\u001b[1mYour organization manages usage\u001b[0m\n\nWhat's contributing to your usage?\nLast 24h · 36 requests";
  assert.equal(usageNote(tips), 'Your organization manages usage');
});

test('usage-based Enterprise seats get the organisation-limit status instead of "% used" bars', () => {
  // as seen live: seat enterprise_usage_based, an "overage" rate-limit event without utilization
  const profile = { subscriptionType: 'enterprise', seatTier: 'enterprise_usage_based' };
  const rateLimit = { status: 'allowed', resetsAt: 1796083200, rateLimitType: 'overage', overageStatus: 'allowed', overageResetsAt: 1796083200, windows: { overage: { status: 'allowed', utilization: null, resetsAt: 1796083200 } } };
  assert.deepEqual(billingStatus(profile, rateLimit), { status: 'allowed', resetsAt: 1796083200 });
  assert.deepEqual(billingStatus(profile, null), { status: null, resetsAt: null }, 'known as usage-based before the first turn');
  assert.equal(billingStatus({ subscriptionType: 'team', seatTier: 'team_premium' }, { status: 'allowed', rateLimitType: 'five_hour' }), null, 'plan seats keep their % bars');

  const summary = summarize([], { from: 0, to: Date.now() });
  const html = reportHtml({ account: A, profile, limits: { windows: [], note: 'x' }, billing: billingStatus(profile, { ...rateLimit, overageStatus: 'rejected' }), summary });
  assert.match(html, /Batas pemakaian organisasi/);
  assert.match(html, /Batas organisasi tercapai/);
  assert.doesNotMatch(html, /pesan asli dari/, 'the /usage note is only the last resort');
});

test('daySummary: today’s totals, coverage, projects and sessions from every account', async () => {
  const { daySummary } = await import('../src/usage.js');
  const ledger = ledgerWithEngines();
  const now = Date.now() + 1000;
  const t = daySummary(ledger, now);
  assert.equal(t.rows, 4);
  assert.equal(t.turns, 2);
  assert.equal(t.tokens, 110 + 22 + 33 + 5);
  assert.equal(t.costUsd, 0.5, '0 counts as priced, missing cost does not');
  assert.equal(t.costCoverage, 0.5);
  assert.deepEqual([t.projects, t.sessions], [1, 1]);
  assert.equal(daySummary(ledger, now + 86_400_000).rows, 0, 'a new day starts empty');
  assert.deepEqual(daySummary(null, now), { from: periodStart(now, 'day'), rows: 0, costUsd: null, costCoverage: 0, turns: 0, tokens: 0, projects: 0, sessions: 0 });
});

test('ledger keeps accounts apart', () => {
  const ledger = ledgerWithTwoAccounts();
  assert.equal(ledger.rows().length, 3, 'logged-out usage is skipped');
  assert.deepEqual(ledger.accounts().map((a) => a.email).sort(), [A.email, B.email]);
  const a = totals(ledger.query({ accountId: A.id }));
  assert.equal(a.input, 110);
  assert.equal(a.cacheRead, 900);
  assert.equal(a.total, 110 + 55 + 900);
  assert.equal(a.costUsd, 0.5);
  assert.equal(a.costCoverage, 0.5, 'one of two rows had a cost');
  assert.equal(totals(ledger.query({ accountId: B.id })).total, 10);
  assert.equal(ledger.query({ accountId: A.id, from: Date.now() + 1000 }).length, 0, 'period filter');
});

/** One row per engine × source, so every bucket exists: claude:web, claude:cli, opencode:web, opencode:cli. */
function ledgerWithEngines() {
  const ledger = new UsageLedger({ file: path.join(mkdtempSync(path.join(tmpdir(), 'usage-')), 'usage.jsonl'), account: () => A });
  const row = (engine, source, input, output, extra = {}) =>
    ledger.record({ engine, source, project: { id: 'p1', name: 'toko' }, sessionId: 's1', model: 'm', input, output, cacheRead: 0, cacheWrite: 0, ...extra });
  row('claude', 'web', 100, 10, { turns: 1, costUsd: 0.5 });
  row('claude', 'cli', 20, 2, { requests: 1 });
  row('opencode', 'web', 30, 3, { turns: 1, costUsd: 0 });
  row('opencode', 'cli', 4, 1, { requests: 1 });
  return ledger;
}

test('engine: an explicit value is stored, otherwise the account decides (legacy rows too)', () => {
  assert.deepEqual(ENGINES, ['claude', 'opencode']);
  assert.equal(engineOf({ engine: 'opencode', account: A }), 'opencode');
  assert.equal(engineOf({ engine: 'claude', account: { id: 'opencode' } }), 'claude', 'the stored engine wins');
  assert.equal(engineOf({ account: { id: 'opencode' } }), 'opencode', 'legacy OpenCode rows have no engine field');
  assert.equal(engineOf({ account: A }), 'claude', 'every other legacy row was Claude');
  assert.equal(engineOf({}), 'unknown', 'no engine and no account is never guessed');

  const ledger = new UsageLedger({ file: path.join(mkdtempSync(path.join(tmpdir(), 'usage-')), 'usage.jsonl'), account: () => A });
  ledger.record({ source: 'web', project: { id: 'p1', name: 'toko' }, model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
  ledger.record({ engine: 'opencode', source: 'web', project: { id: 'p1', name: 'toko' }, model: 'm', input: 2, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(ledger.rows().map((r) => r.engine), ['claude', 'opencode']);

  // a row written before `engine` existed (old file or restored backup) keeps merging; engine is derived on read
  const legacy = { ts: Date.now(), account: { id: 'opencode', email: 'OpenCode', org: null }, source: 'cli', project: null, projectId: null, sessionId: 'old', model: 'oc', input: 7, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, requests: 1, turns: 0 };
  assert.equal(ledger.importRows([legacy]), 1, 'legacy rows are still valid');
  const s = summarize(ledger.query({ accountId: 'opencode' }), { from: 0, to: Date.now() });
  assert.deepEqual(s.byEngine.map((e) => e.key), ['opencode']);
  assert.deepEqual(s.byEngineSource.map((e) => e.key), ['opencode:cli']);

  const missingAccount = summarize([{ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }], { from: 0, to: Date.now() });
  assert.deepEqual(missingAccount.byEngine.map((e) => e.key), ['unknown'], 'nothing to attribute it to');
});

test('summarize adds per-engine totals (and engine × source) that add up to the overall totals', () => {
  const ledger = ledgerWithEngines();
  const s = summarize(ledger.query({ accountId: A.id }), { from: 0, to: Date.now() });
  const totalOf = (items) => items.reduce((n, i) => n + i.total, 0);

  assert.deepEqual(s.byEngine.map((e) => e.key).sort(), [...ENGINES].sort());
  assert.equal(totalOf(s.byEngine), s.totals.total, 'no token lost or counted twice');
  assert.equal(s.byEngine.reduce((n, e) => n + e.requests, 0), s.totals.requests);

  assert.deepEqual(s.byEngineSource.map((e) => e.key).sort(), ['claude:cli', 'claude:web', 'opencode:cli', 'opencode:web']);
  for (const item of s.byEngineSource) {
    assert.ok(ENGINES.includes(item.engine));
    assert.ok(['web', 'cli'].includes(item.source));
    assert.ok(Number.isFinite(item.total), 'group fields are kept');
  }
  assert.equal(totalOf(s.byEngineSource), s.totals.total);
  assert.equal(totalOf(s.bySource), s.totals.total, 'the source breakdown stays a separate dimension');
});

test('removeProject deletes only that project\'s rows, with a backup', () => {
  const ledger = ledgerWithTwoAccounts();
  const before = ledger.rows().length;
  const removed = ledger.removeProject('p1');
  assert.equal(removed, 2, 'only the rows of project p1');
  assert.equal(ledger.rows().length, before - 2);
  // an unknown project changes nothing
  assert.equal(ledger.removeProject('nope'), 0);
  assert.ok(readdirSync(path.dirname(ledger.file)).some((f) => f.startsWith('usage.jsonl.bak-purge-')), 'a backup was written');
});

test('usage ledger rotation: archives keep every row, the active file restarts, and queries stay complete', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-rot-'));
  const ledger = new UsageLedger({ file: path.join(dir, 'usage.jsonl'), account: () => A, maxBytes: 700 });
  for (let i = 0; i < 20; i++) ledger.record({ source: 'web', project: { id: 'p1', name: 'toko' }, model: 'm', input: 10, output: 1, cacheRead: 0, cacheWrite: 0 });
  assert.ok(readdirSync(path.join(dir, 'usage-archive')).some((n) => /^usage-[\w-]+\.jsonl$/.test(n)), 'an archive was written');
  assert.ok(statSync(path.join(dir, 'usage.jsonl')).size < 700, 'the active file stays small');
  assert.equal(ledger.rows().length, 20, 'every row is read back across the active file and its archives');
  assert.equal(ledger.accounts().length, 1);
  const totalsAll = ledger.query({ accountId: A.id }).reduce((n, r) => n + r.input, 0);
  assert.equal(totalsAll, 200, 'queries cover the archives too');
  // A restored backup of an archived row is not added twice.
  const archived = ledger.rows()[0];
  assert.equal(ledger.importRows([archived]), 0, 'dedup spans the archives');
  assert.equal(ledger.rows().length, 20);
});

test('query("all") covers every account; one report can show Claude and OpenCode together', () => {
  const ledger = ledgerWithTwoAccounts();
  const all = ledger.query({ accountId: 'all' });
  assert.equal(all.length, 3, 'both accounts');
  assert.equal(totals(all).total, totals(ledger.query({ accountId: A.id })).total + totals(ledger.query({ accountId: B.id })).total);
  assert.equal(ledger.query({ accountId: 'all', from: Date.now() + 1000 }).length, 0, 'the period still filters');
  assert.equal(ledger.query({}).length, 0, 'a missing account id is strict: no silent all-account sum');
  assert.equal(ledger.query({ accountId: null }).length, 0, 'null is strict too');
  assert.equal(ledger.query({ accountId: A.id }).length, 2, 'an exact id is unchanged');

  // an OpenCode account next to the Claude one: the combined summary has both engines, no token lost
  ledger.record({ account: { id: 'opencode', email: 'OpenCode', org: null }, engine: 'opencode', source: 'web', project: { id: 'p1', name: 'toko' }, sessionId: 's2', model: 'oc', input: 40, output: 4, cacheRead: 0, cacheWrite: 0 });
  const s = summarize(ledger.query({ accountId: 'all' }), { from: 0, to: Date.now() });
  assert.equal(s.byEngine.length, 2);
  assert.deepEqual(s.byEngine.map((e) => e.key).sort(), ['claude', 'opencode']);
  assert.equal(s.byEngine.reduce((n, e) => n + e.total, 0), s.totals.total);
  assert.equal(s.byEngineSource.reduce((n, e) => n + e.total, 0), s.totals.total);

  const html = reportHtml({ account: { email: 'Semua akun', org: null }, profile: null, limits: null, summary: s });
  assert.match(html, /Semua akun/);
  assert.match(html, /Claude · Web/);
  assert.match(html, /OpenCode · Web/);
  assert.doesNotMatch(html, /kantor@example\.com|pribadi@example\.com/, 'the combined report names no account');
  assert.doesNotMatch(html, /Kuota langganan|Batas pemakaian organisasi/, 'no profile, limits or billing for a combined report');
});

test('summarize groups by model, project, source and period', () => {
  const ledger = ledgerWithTwoAccounts();
  const rows = ledger.query({ accountId: A.id });
  const s = summarize(rows, { from: 0, to: Date.now() });
  assert.equal(s.records, 2);
  assert.deepEqual(s.byModel.map((m) => m.key), ['opus', 'sonnet']);
  assert.deepEqual(s.byProject.map((p) => p.key), ['toko']);
  assert.deepEqual(s.bySource.map((p) => p.key), ['Web']);
  assert.equal(s.groupBy, 'day');
  assert.equal(s.byPeriod.length, 1, 'no range start: the breakdown begins at the first record');
  assert.equal(s.byPeriod[0].total, s.totals.total);
});

test('usage is broken down per day, week (Mon–Sun) or month, gaps included', () => {
  const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
  const row = (ts, input) => ({ ts, input, output: 0, cacheRead: 0, cacheWrite: 0 });
  const rows = [row(at(2026, 10, 1), 10), row(at(2026, 10, 3), 20), row(at(2026, 10, 30), 5), row(at(2026, 11, 2), 7)];
  const range = { from: at(2026, 10, 1, 0), to: at(2026, 11, 2, 23) };

  const days = byPeriod(rows, { ...range, unit: 'day' });
  assert.equal(days.length, 33, '1 Oct – 2 Nov, empty days included');
  assert.equal(days[1].total, 0);
  assert.equal(days.reduce((n, d) => n + d.total, 0), 42, 'nothing lost or counted twice');

  const weeks = byPeriod(rows, { ...range, unit: 'week' });
  assert.equal(weeks[0].start, range.from, 'the first week is clipped to the range (Thu 1 Oct, not Mon 28 Sep)');
  assert.equal(weeks[0].end, at(2026, 10, 4, 23) + 59 * 60_000 + 59_999, '…and ends on Sunday 4 Oct');
  assert.equal(new Date(weeks[1].start).getDay(), 1, 'weeks start on Monday');
  assert.equal(weeks[0].total, 30);
  assert.equal(weeks.at(-1).total, 7, 'Mon 2 Nov opens a new week');
  assert.equal(weeks.at(-1).end, range.to, 'the last week stops at the end of the range');

  const months = byPeriod(rows, { ...range, unit: 'month' });
  assert.deepEqual(months.map((m) => m.total), [35, 7]);
  assert.equal(periodLabel(months[0], 'month'), 'Oktober 2026');
  assert.equal(periodStart(at(2026, 10, 31), 'month'), at(2026, 10, 1, 0));

  const s = summarize(rows, { ...range, groupBy: 'week' });
  assert.equal(s.groupBy, 'week');
  assert.match(reportHtml({ account: A, profile: null, limits: null, summary: s }), /Rincian per minggu/);
});

test('a 7-day range with usage only today still shows all 7 days (the empty ones too)', () => {
  const now = new Date(2026, 9, 31, 15).getTime(); // Sat 31 Oct
  const from = new Date(2026, 9, 25).getTime(); // Sun 25 Oct, 7 days back
  const rows = [{ ts: now - 3_600_000, input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }];
  const days = byPeriod(rows, { from, to: now, unit: 'day' });
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((d) => d.total), [0, 0, 0, 0, 0, 0, 110]);
  const weeks = byPeriod(rows, { from, to: now, unit: 'week' });
  assert.equal(weeks.length, 2, 'Sun 25 Oct is the tail of one week, Mon 26 – Sat 31 the next');
  assert.equal(periodLabel(weeks[0], 'week'), 'Min, 25 Okt 2026', 'a one-day week reads as that day');
  assert.equal(byPeriod(rows, { from, to: now, unit: 'month' }).length, 1, 'still one month: the UI disables "per bulan" here');
});

test('an OpenCode report labels local usage and says provider quota is unavailable', () => {
  const summary = summarize([], { from: 0, to: Date.now() });
  const html = reportHtml({ account: { id: 'opencode', email: 'OpenCode', org: null }, profile: null, limits: null, summary });
  assert.match(html, /pemakaian lokal/);
  assert.match(html, /sisa kuota provider/);
  assert.doesNotMatch(html, /Estimasi harga list dari Claude Code/);
});

test('report shows usage per engine and engine × source, and notes that roles are not split', () => {
  const ledger = ledgerWithEngines();
  const summary = summarize(ledger.query({ accountId: A.id }), { from: 0, to: Date.now() });
  const html = reportHtml({ account: A, profile: null, limits: null, summary });
  assert.match(html, /<h2>Per mesin<\/h2>/);
  assert.match(html, /<th>Mesin<\/th>/, 'the engine table');
  assert.match(html, /<th>Mesin · sumber<\/th>/, 'the engine × source table');
  for (const label of ['Claude', 'OpenCode', 'Claude · Web', 'Claude · Terminal', 'OpenCode · Web', 'OpenCode · Terminal']) {
    assert.ok(html.includes(label), `shows ${label}`);
  }
  assert.match(html, /Per sumber/, 'the per-source table stays');
  assert.match(html, /Rincian per role belum tersedia; pemakaian subagent digabung ke sesi induknya\./);
  assert.match(html, /\$0\.00/, 'a zero cost is spelled out');
  assert.match(html, /\(50%\)/, 'partial cost coverage is shown');
  assert.match(html, /<td>—<\/td>/, 'no cost on record reads as a dash');
});

test('report HTML shows only the chosen account and escapes text', async (t) => {
  const ledger = ledgerWithTwoAccounts();
  const summary = summarize(ledger.query({ accountId: A.id }), { from: 0, to: Date.now() });
  const html = reportHtml({ account: { ...A, org: '<b>Kantor</b>' }, profile: null, limits: null, summary });
  assert.match(html, /kantor@example\.com/);
  assert.doesNotMatch(html, /pribadi@example\.com|blog/, 'nothing from the other account');
  assert.doesNotMatch(html, /<b>Kantor<\/b>/, 'escaped');
  if (!findBrowser()) return t.skip('no Edge/Chrome for headless PDF');
  const pdf = await renderPdf(html);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('a process keeps billing the account it started with after a switch', () => {
  const ledger = new UsageLedger({ file: path.join(mkdtempSync(path.join(tmpdir(), 'usage-')), 'usage.jsonl'), account: () => B });
  // web session spawned under A, its turn ends after the user already logged in as B
  ledger.record({ account: A, source: 'web', project: { id: 'p1', name: 'toko' }, model: 'opus', input: 5, output: 5, cacheRead: 0, cacheWrite: 0 });
  ledger.record({ source: 'cli', project: { id: 'p1', name: 'toko' }, model: 'opus', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
  assert.equal(totals(ledger.query({ accountId: A.id })).total, 10);
  assert.equal(totals(ledger.query({ accountId: B.id })).total, 2);
});
