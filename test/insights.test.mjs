// 📈 Pola kerja: totals per project/model/hour from the usage ledger, with the range filter.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insightSummary } from '../src/insights.js';

const at = (day, hour) => new Date(2026, 10, day, hour).getTime(); // November 2026, local time
const now = at(23, 12);
const row = (over) => ({ ts: now, projectId: 'p1', project: 'toko', model: 'opus', input: 100, output: 50, cacheRead: 10, cacheWrite: 0, costUsd: 1, requests: 2, turns: 1, sessionId: 's1', ...over });

test('insightSummary: rentang, total, urutan project/model, jam tersibuk', () => {
  const summary = insightSummary(
    [
      row({ ts: at(22, 14) }),
      row({ ts: at(21, 14), projectId: 'p2', project: 'blog', model: 'sonnet', costUsd: 3, requests: 5, sessionId: 's2' }),
      row({ ts: at(1, 9), costUsd: 9, requests: 100 }), // outside 7 days
    ],
    { now, days: 7 },
  );
  assert.equal(summary.days, 7);
  assert.equal(summary.projects.length, 2);
  assert.equal(summary.projects[0].name, 'blog', 'biaya terbesar dulu');
  assert.equal(summary.models[0].model, 'sonnet');
  assert.equal(summary.busiestHour, 14);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.tokens, 2 * 160);
  assert.equal(summary.costUsd, 4);
  assert.equal(summary.requests, 7);
});

test('insightSummary: kosong tetap bentuk yang sama, hari salah jatuh ke 30', () => {
  const empty = insightSummary([], { now, days: 12 });
  assert.equal(empty.days, 30);
  assert.equal(empty.busiestHour, null);
  assert.deepEqual(empty.projects, []);
  assert.equal(empty.costUsd, 0);
  assert.equal(empty.hours.length, 24);
});
