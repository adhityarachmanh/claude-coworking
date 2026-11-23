// 📅 Rekap mingguan: totals for 7 days, per project and model, plus the busiest hour.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { weeklyDigest } from '../src/digest.js';

const at = (day, hour) => new Date(2026, 10, day, hour).getTime();
const now = at(24, 12);
const row = (over = {}) => ({ ts: at(23, 10), projectId: 'p1', project: 'toko', model: 'opus', input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 1, requests: 2, turns: 1, sessionId: 's1', ...over });

test('weeklyDigest: markdown berisi total, project, model, jam tersibuk', () => {
  const { markdown, summary } = weeklyDigest([row(), row({ projectId: 'p2', project: 'blog', model: 'sonnet', costUsd: 2, requests: 3, ts: at(22, 14) })], { now });
  assert.match(markdown, /Rekap 7 hari/);
  assert.match(markdown, /Biaya \$3,00/);
  assert.match(markdown, /## Project/);
  assert.match(markdown, /blog/);
  assert.match(markdown, /`sonnet`/);
  assert.equal(summary.busiestHour, 14);
});

test('weeklyDigest: tanpa data tetap jujur', () => {
  const { markdown } = weeklyDigest([], { now });
  assert.match(markdown, /Belum ada aktivitas/);
  assert.doesNotMatch(markdown, /## Project/);
});
