// 📊 reportHtml: the per-role estimate is a real section in the PDF HTML, with the same totals and a clear note.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportHtml } from '../src/report.js';

const now = Date.now();
const period = { start: now - 86_400_000, end: now, input: 60, output: 40, cacheRead: 0, cacheWrite: 0, total: 100, costUsd: 1, costCoverage: 1, cacheHitRate: 0 };

test('reportHtml: per-role table shows labels, tokens, share, cost and delegations', () => {
  const summary = {
    from: now - 6 * 86_400_000,
    to: now,
    groupBy: 'day',
    records: 1,
    totals: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0, total: 100, requests: 1, turns: 1, costUsd: 1, costCoverage: 1, cacheHitRate: 0 },
    byModel: [],
    byProject: [],
    bySource: [],
    byEngine: [],
    byEngineSource: [],
    byPeriod: [period],
    topSessions: [],
    byRole: {
      totalTokens: 100,
      estimated: true,
      coverage: { percent: 0.8, knownTokens: 80, unknownTokens: 20, sessionsWithTranscript: 3, sessions: 4 },
      note: 'Perkiraan dari proporsi transcript.',
      roles: [
        { role: 'backend', label: 'Backend Developer', tokens: 60, share: 0.6, costUsd: 0.6, costCoverage: 1, delegations: 2 },
        { role: 'claude', label: 'Lead (utama)', tokens: 20, share: 0.2, costUsd: 0.2, costCoverage: 1, delegations: 0 },
        { role: 'unknown', label: 'Tanpa rincian role', tokens: 20, share: 0.2, costUsd: 0.2, costCoverage: 1, delegations: 0 },
      ],
    },
  };
  const html = reportHtml({ account: { email: 'uji@example.com', org: null }, profile: null, limits: null, summary });
  assert.match(html, /Per role/);
  assert.match(html, /Backend Developer/);
  assert.match(html, /Lead \(utama\)/);
  assert.match(html, /Tanpa rincian role/);
  assert.match(html, /60\.0%/);
  assert.match(html, /Perkiraan dari proporsi transcript/);
  assert.match(html, />2<\/td>/, 'delegations column');
});

test('reportHtml: a server without byRole keeps the rest of the report', () => {
  const summary = {
    from: now - 86_400_000,
    to: now,
    groupBy: 'day',
    records: 1,
    totals: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0, total: 100, requests: 1, turns: 1, costUsd: 1, costCoverage: 1, cacheHitRate: 0 },
    byModel: [],
    byProject: [],
    bySource: [],
    byEngine: [],
    byEngineSource: [],
    byPeriod: [period],
    topSessions: [],
  };
  const html = reportHtml({ account: { email: 'uji@example.com', org: null }, profile: null, limits: null, summary });
  assert.doesNotMatch(html, /Per role/);
  assert.match(html, /Laporan Penggunaan Token/);
});
