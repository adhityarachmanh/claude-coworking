// Prompt templates (src/templates.js), rate-limit bookkeeping (src/account.js) and the quota-warning rules
// the browser uses (public/js/core/quota-rules.js: pure, no DOM).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AccountService } from '../src/account.js';
import { Hub } from '../src/hub.js';
import { TEMPLATE_LIMITS, TemplateError, TemplateStore, cleanTemplate } from '../src/templates.js';
import { alertText, cleanThresholds, evaluateQuota, fmtReset, quotaTooltip, quotaWindows, thresholdError, tone, usageKey } from '../public/js/core/quota-rules.js';

// ---------- templates ----------

test('templates: name ≤ 60 and text ≤ 8000, both required, control characters dropped', () => {
  assert.deepEqual(cleanTemplate({ name: '  Review\u0007  cepat ', text: ' a\r\nb\u0000 ' }), { name: 'Review cepat', text: 'a\nb' });
  assert.throws(() => cleanTemplate({ name: ' ', text: 'x' }), TemplateError);
  assert.throws(() => cleanTemplate({ name: 'x', text: ' \n ' }), /Isi template wajib/);
  assert.throws(() => cleanTemplate({ name: 'x'.repeat(61), text: 'x' }), /maksimal 60/);
  assert.throws(() => cleanTemplate({ name: 'x', text: 'x'.repeat(8001) }), /maksimal 8000/);
  assert.doesNotThrow(() => cleanTemplate({ name: 'x'.repeat(60), text: 'x'.repeat(8000) }));
  assert.throws(() => cleanTemplate(null), /Nama template wajib/);
});

test('templates: add, update, delete; unique names; at most 50', () => {
  const hub = { persisted: {}, saves: 0, save() { this.saves++; } };
  const store = new TemplateStore(hub);
  assert.deepEqual(store.list(), []);
  const a = store.save({ name: 'Review', text: 'Review {file}' });
  assert.match(a.id, /^t_[a-f0-9]{12}$/);
  assert.equal(hub.saves, 1, 'written right away');
  assert.throws(() => store.save({ name: 'review', text: 'lain' }), /Sudah ada template bernama/);
  const b = store.save({ name: 'Commit', text: 'Commit' });
  assert.throws(() => store.save({ id: b.id, name: 'REVIEW', text: 'x' }), /Sudah ada/, 'renaming onto another name is refused too');
  const a2 = store.save({ id: a.id, name: 'Review diff', text: 'Review semua' });
  assert.equal(a2.id, a.id);
  assert.deepEqual(store.list().map((t) => t.name), ['Review diff', 'Commit']);
  assert.throws(() => store.save({ id: 't_ffffffffffff', name: 'x', text: 'x' }), /tidak ditemukan/);
  store.remove(b.id);
  assert.throws(() => store.remove(b.id), /tidak ditemukan/);
  assert.deepEqual(store.list().map((t) => t.id), [a.id]);
  for (let i = store.list().length; i < TEMPLATE_LIMITS.count; i++) store.save({ name: `T${i}`, text: 'x' });
  assert.throws(() => store.save({ name: 'satu lagi', text: 'x' }), /Maksimal 50 template/);
});

test('templates: junk in a hand-edited state.json is skipped, not shown', () => {
  const hub = { persisted: { templates: [{ id: 't_abcdef', name: 'ok', text: 'ok' }, { id: '../x', name: 'bad', text: 'x' }, null, { id: 't_abcdeg', name: 1, text: 'x' }] }, save() {} };
  assert.deepEqual(new TemplateStore(hub).list().map((t) => t.name), ['ok']);
});

test('templates: persisted in the office state (survive a restart)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-tpl-'));
  try {
    const t = new TemplateStore(new Hub({ dataDir: dir })).save({ name: 'Audit UX', text: 'Audit {halaman}' });
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).templates[0].id, t.id);
    const again = new TemplateStore(new Hub({ dataDir: dir })); // a new server process reading the same data
    assert.deepEqual(again.list().map(({ name, text }) => ({ name, text })), [{ name: 'Audit UX', text: 'Audit {halaman}' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- rate_limit_event bookkeeping ----------

test('rate limits: kept per window, broadcast only when what browsers show changes', () => {
  const emitted = [];
  const acct = new AccountService({ claude: null, onChange: (s) => emitted.push(s) });
  const reset5 = 1_900_000_000;
  acct.noteRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: reset5 });
  acct.noteRateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.71, resetsAt: reset5 + 86400 });
  assert.equal(emitted.length, 2);
  assert.deepEqual(Object.keys(acct.rateLimit.windows).sort(), ['five_hour', 'seven_day'], 'one event per window, both kept');
  acct.noteRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.421, resetsAt: reset5 }); // same whole percent
  assert.equal(emitted.length, 2, 'no broadcast for an unchanged view');
  acct.noteRateLimit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: reset5 }); // no utilization: keep the known one
  assert.equal(acct.rateLimit.windows.five_hour.utilization, 0.421);
  acct.noteRateLimit({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: reset5 });
  assert.equal(emitted.length, 3);
  assert.equal(emitted.at(-1).rateLimit.windows.five_hour.status, 'rejected');
  acct.noteRateLimit(null); // malformed events are ignored
  assert.equal(emitted.length, 3);
});

// ---------- quota-warning rules (browser) ----------

const NOW = Date.parse('2026-11-02T08:00:00Z');
const H = 3_600_000;
const event = (windows) => ({ rateLimit: { windows: Object.fromEntries(Object.entries(windows).map(([k, [pct, resetMs, status = 'allowed']]) => [k, { status, utilization: pct / 100, resetsAt: resetMs / 1000, at: NOW }])), at: NOW } });
const TH = cleanThresholds(null);

test('quota rules: windows from session events and /usage, stale periods dropped', () => {
  assert.equal(usageKey('Current session'), 'five_hour');
  assert.equal(usageKey('Current week (all models)'), 'seven_day');
  assert.equal(usageKey('Current week (Fable)'), 'seven_day_fable');
  assert.equal(usageKey('Something else'), null);
  const ws = quotaWindows(event({ five_hour: [75, NOW + 2 * H], seven_day: [95, NOW - 1000] }), NOW);
  assert.deepEqual(ws.map((w) => [w.key, w.label, w.percent]), [['five_hour', 'Sesi 5 jam', 75]], 'a window whose reset passed is old news');
  const mixed = quotaWindows({ ...event({ five_hour: [75, NOW + 2 * H] }), limits: { at: NOW + 1, windows: [{ label: 'Current session', percent: 80, resets: 'Nov 2, 5pm' }, { label: 'Current week (all models)', percent: 30, resets: 'Nov 5, 9pm' }] } }, NOW);
  assert.deepEqual(mixed.map((w) => [w.key, w.percent, Boolean(w.resetsAt)]), [['five_hour', 80, true], ['seven_day', 30, false]], 'newer /usage wins, the exact reset time is kept');
  const limited = quotaWindows(event({ seven_day: [NaN, NOW + 50 * H, 'rejected'] }), NOW);
  assert.deepEqual(limited.map((w) => [w.percent, w.limited]), [[100, true]]);
});

test('quota rules: once per threshold per reset period; again after the reset', () => {
  const reset1 = NOW + 3 * H;
  let mem = {};
  const step = (pct, reset, now = NOW) => {
    const r = evaluateQuota(quotaWindows(event({ seven_day: [pct, reset] }), now), mem, TH, now);
    mem = r.memory;
    return r.alerts.map((a) => a.level);
  };
  assert.deepEqual(step(50, reset1), []);
  assert.deepEqual(step(72, reset1), [70]);
  assert.deepEqual(step(75, reset1), [], 'no repeat');
  mem = JSON.parse(JSON.stringify(mem)); // "reload": the memory comes back from localStorage
  assert.deepEqual(step(78, reset1), [], 'no repeat after a reload in the same period');
  assert.deepEqual(step(91, reset1), [90]);
  assert.deepEqual(step(100, reset1), [100]);
  // reset passed: the next period starts over
  const reset2 = reset1 + 7 * 24 * H;
  assert.deepEqual(step(71, reset2, reset1 + 1000), [70], 'again after the reset');
  // straight to 95 in a fresh period: one alert, the highest
  mem = {};
  assert.deepEqual(step(95, reset1), [90]);
});

test('quota rules: /usage text periods, usage drop = reset, thresholds off', () => {
  let mem = {};
  const usage = (percent, resets) => quotaWindows({ limits: { at: NOW, windows: [{ label: 'Current session', percent, resets }] } }, NOW);
  let r = evaluateQuota(usage(72, 'Nov 2, 5pm'), mem, TH, NOW);
  assert.deepEqual(r.alerts.map((a) => a.level), [70]);
  mem = r.memory;
  assert.deepEqual(evaluateQuota(usage(73, 'Nov 2, 5pm'), mem, TH, NOW).alerts, []);
  assert.deepEqual(evaluateQuota(usage(71, 'Nov 2, 10pm'), mem, TH, NOW).alerts.map((a) => a.level), [70], 'another reset text = another period');
  r = evaluateQuota(quotaWindows(event({ five_hour: [91, NOW + H] }), NOW), {}, TH, NOW);
  assert.deepEqual(evaluateQuota(quotaWindows(event({ five_hour: [5, NOW + H] }), NOW), r.memory, TH, NOW).memory, {}, 'a big drop means the window was reset');
  // After a reload the page may still hold an older `/usage` (lower numbers): it must not count as a reset.
  const warned = evaluateQuota(quotaWindows(event({ seven_day: [76, NOW + 50 * H] }), NOW), {}, TH, NOW).memory;
  const stale = quotaWindows({ limits: { at: NOW - H, windows: [{ label: 'Current week (all models)', percent: 20, resets: 'Nov 5, 9pm' }] } }, NOW);
  const afterStale = evaluateQuota(stale, warned, TH, NOW);
  assert.deepEqual(afterStale.memory, warned, 'older numbers neither warn nor reset');
  assert.deepEqual(evaluateQuota(quotaWindows(event({ seven_day: [77, NOW + 50 * H] }), NOW), afterStale.memory, TH, NOW).alerts, []);
  const off = cleanThresholds({ enabled: false });
  assert.deepEqual(evaluateQuota(quotaWindows(event({ five_hour: [99, NOW + H] }), NOW), {}, off, NOW).alerts, []);
});

test('quota rules: thresholds, colours and texts', () => {
  assert.deepEqual(cleanThresholds({ warn: '60', crit: 85 }), { enabled: true, warn: 60, crit: 85 });
  assert.deepEqual(cleanThresholds({ warn: 90, crit: 80 }), { enabled: true, warn: 70, crit: 90 }, 'nonsense falls back to the defaults');
  assert.equal(thresholdError('70', '90'), null);
  assert.match(thresholdError('90', '80'), /lebih kecil/);
  assert.match(thresholdError('0', '80'), /antara 1 dan 100/);
  assert.match(thresholdError('7.5', '80'), /bulat/);
  const w = (percent, limited = false) => ({ key: 'seven_day', label: 'Mingguan', percent, limited, resetsAt: Date.parse('2026-11-09T02:00:00Z'), resetsText: null });
  assert.equal(tone(w(69), TH), null);
  assert.equal(tone(w(70), TH), 'warn');
  assert.equal(tone(w(90), TH), 'crit');
  assert.equal(tone(w(10, true), TH), 'crit');
  // The reset in the viewer's time zone, formatted like the app (weekday + time)
  const reset = fmtReset(w(92), Date.parse('2026-11-08T00:00:00Z'));
  assert.match(reset, /^\S+ \d{2}\.\d{2}$/);
  assert.equal(quotaTooltip(w(92), Date.parse('2026-11-08T00:00:00Z')), `Kuota mingguan 92% · reset ${reset}`);
  assert.match(alertText({ window: w(100, true), level: 100 }, Date.parse('2026-11-08T00:00:00Z')), /^⛔ Kuota mingguan habis — Claude tidak bisa dipakai sampai reset /);
  assert.match(alertText({ window: { ...w(91), resetsAt: null }, level: 90 }), /waktu reset belum diketahui/);
});
