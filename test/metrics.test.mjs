// 📈 src/metrics.js: the rolling 7-day operational history behind 🩺 Kesehatan — counts, percentiles, persistence,
// and the promise that it never carries conversation data (it only stores numbers).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Metrics, percentile } from '../src/metrics.js';

const DAY = 86_400_000;
const BASE = new Date(2026, 10, 8, 10, 0, 0).getTime(); // local time, 8 Nov 2026
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));

function tempFile() {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-metrics-'));
  dirs.push(dir);
  return path.join(dir, 'metrics.json');
}

test('percentile: nearest rank, empty = null', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([100], 50), 100);
  assert.equal(percentile([100, 300], 50), 100);
  assert.equal(percentile([100, 300], 95), 300);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);
});

test('metrics: turns, queue waits, capacity hits and today in the 7-day view', () => {
  let now = BASE;
  const file = tempFile();
  const metrics = new Metrics({ file, now: () => now, saveDelayMs: 0 });
  metrics.turn({ ok: true, durationMs: 1000 });
  metrics.turn({ ok: false, durationMs: 3000 });
  metrics.queueStart({ waitMs: 100 });
  metrics.queueStart({ waitMs: 300 });
  metrics.capacityQueued();
  metrics.capacityRefused();
  const view = metrics.view(now);
  assert.equal(view.today.turns, 2);
  assert.equal(view.today.ok, 1);
  assert.equal(view.today.failed, 1);
  assert.equal(view.today.avgTurnMs, 2000);
  assert.equal(view.today.queueStarted, 2);
  assert.equal(view.today.waitP50Ms, 100);
  assert.equal(view.today.waitP95Ms, 300);
  assert.equal(view.today.capacityQueued, 1);
  assert.equal(view.today.capacityRefused, 1);
  assert.equal(view.days.length, 7);
  assert.equal(view.days[6].turns, 2, 'today is the last row');

  // The file holds numbers only: no project, prompt or conversation keys.
  metrics.save();
  const stored = readFileSync(file, 'utf8');
  assert.equal(/project|prompt|text|chat|message/i.test(stored), false);
});

test('metrics: restart survives a reload, old days are trimmed, a corrupt file starts clean', () => {
  let now = BASE;
  const file = tempFile();
  const metrics = new Metrics({ file, now: () => now, saveDelayMs: 0 });
  metrics.restart();
  assert.equal(metrics.view(now).restarts.count, 1);
  const again = new Metrics({ file, now: () => now });
  assert.equal(again.view(now).restarts.count, 1, 'the restart count survives a server restart');
  assert.ok(Number.isFinite(again.view(now).restarts.lastAt));

  now = BASE - 8 * DAY;
  again.turn({ ok: true, durationMs: 500 });
  now = BASE;
  again.turn({ ok: true, durationMs: 500 });
  const view = again.view(now);
  assert.equal(view.days.length, 7, 'only the rolling week is kept');
  assert.equal(view.today.ok, 1);
  assert.equal(view.days.some((d) => d.ok === 1 && d.day !== view.today.day), false, 'the eight-day-old day is gone');

  writeFileSync(file, 'bukan json');
  const fresh = new Metrics({ file, now: () => now });
  assert.equal(fresh.view(now).today.turns, 0, 'a corrupt diagnostics file never breaks the app');
});

test('metrics: reset clears the rolling days and the restart count, then writes an empty file', () => {
  const file = tempFile();
  const metrics = new Metrics({ file, now: () => BASE, saveDelayMs: 0 });
  metrics.restart();
  metrics.turn({ ok: true, durationMs: 100 });
  assert.equal(metrics.view(BASE).restarts.count, 1);
  metrics.reset();
  const view = metrics.view(BASE);
  assert.equal(view.restarts.count, 0);
  assert.equal(view.days.length, 7, 'the week is still drawn, all empty');
  assert.ok(view.days.every((d) => d.turns === 0));
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(stored.days, {});
  assert.deepEqual(stored.restarts, { count: 0, lastAt: null });
});
