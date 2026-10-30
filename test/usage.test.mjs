// Account usage: `/usage` parsing, the per-account token ledger, and the PDF report.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseUsageText } from '../src/account.js';
import { findBrowser, renderPdf, reportHtml } from '../src/report.js';
import { summarize, totals, UsageLedger } from '../src/usage.js';

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

test('summarize groups by model, project, source and day', () => {
  const ledger = ledgerWithTwoAccounts();
  const rows = ledger.query({ accountId: A.id });
  const s = summarize(rows, { from: 0, to: Date.now() });
  assert.equal(s.records, 2);
  assert.deepEqual(s.byModel.map((m) => m.key), ['opus', 'sonnet']);
  assert.deepEqual(s.byProject.map((p) => p.key), ['toko']);
  assert.deepEqual(s.bySource.map((p) => p.key), ['Web']);
  assert.equal(s.byDay.length, 1);
  assert.equal(s.byDay[0].total, s.totals.total);
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
