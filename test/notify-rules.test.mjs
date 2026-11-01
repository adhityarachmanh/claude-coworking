// 🔔 notification settings, the pure rules (public/js/core/notify-rules.js): defaults, cleaning, quiet hours, plan.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOTIFY_DEFAULTS, cleanNotifySettings, inQuietHours, notifyPlan, quietError } from '../public/js/core/notify-rules.js';

const at = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2026, 10, 1, h, m);
};
const plain = (v) => JSON.parse(JSON.stringify(v));

test('cleanNotifySettings: nothing / garbage → the defaults; partial values are kept, bad ones replaced', () => {
  assert.deepEqual(cleanNotifySettings(null), plain(NOTIFY_DEFAULTS));
  assert.deepEqual(cleanNotifySettings('x'), plain(NOTIFY_DEFAULTS));
  const s = cleanNotifySettings({ events: { done: { sound: false } }, quiet: { enabled: true, from: '25:00', to: '06:30' }, volume: 140, favoritesOnly: 'yes' });
  assert.deepEqual(s.events.done, { popup: true, sound: false });
  assert.deepEqual(s.events.ask, { popup: true, sound: true });
  assert.deepEqual(s.quiet, { enabled: true, from: '22:00', to: '06:30', allowAsk: true });
  assert.equal(s.volume, 100);
  assert.equal(s.favoritesOnly, false);
  assert.equal(cleanNotifySettings({ volume: -3 }).volume, 0);
  assert.equal(cleanNotifySettings({ volume: '42.4' }).volume, 42);
  for (const v of [null, '', '  ', true, 'abc', NaN, {}, []]) assert.equal(cleanNotifySettings({ volume: v }).volume, 100, `volume ${JSON.stringify(v)} → bawaan`);
  assert.equal(cleanNotifySettings({ volume: 0 }).volume, 0);
  assert.equal(cleanNotifySettings({ volume: '0' }).volume, 0);
});

test('notifyPlan cleans what it is given (raw / partial / missing settings)', () => {
  assert.deepEqual(notifyPlan('done', undefined, { away: true }), { sound: true, popup: true });
  assert.deepEqual(notifyPlan('done', { favoritesOnly: true }, { away: true }), { sound: false, popup: false });
  assert.deepEqual(notifyPlan('done', { volume: null }, { away: true }), { sound: true, popup: true }, 'volume null → 100, bukan 0');
  assert.deepEqual(notifyPlan('error', { events: { error: { sound: false } } }, { away: true }), { sound: false, popup: true });
});

test('inQuietHours: same-day and across-midnight ranges, end exclusive, empty range never quiet', () => {
  assert.equal(inQuietHours(at('13:00'), '12:00', '14:00'), true);
  assert.equal(inQuietHours(at('14:00'), '12:00', '14:00'), false);
  assert.equal(inQuietHours(at('11:59'), '12:00', '14:00'), false);
  assert.equal(inQuietHours(at('23:30'), '22:00', '07:00'), true);
  assert.equal(inQuietHours(at('00:00'), '22:00', '07:00'), true);
  assert.equal(inQuietHours(at('06:59'), '22:00', '07:00'), true);
  assert.equal(inQuietHours(at('07:00'), '22:00', '07:00'), false);
  assert.equal(inQuietHours(at('21:59'), '22:00', '07:00'), false);
  assert.equal(inQuietHours(at('10:00'), '10:00', '10:00'), false);
  assert.equal(inQuietHours(at('10:00'), 'x', '11:00'), false);
  assert.equal(quietError('22:00', '07:00'), null);
  assert.match(quietError('08:00', '08:00'), /tidak boleh sama/);
  assert.match(quietError('', '08:00'), /JJ:MM/);
});

test('notifyPlan with the defaults reproduces the old behaviour', () => {
  const d = cleanNotifySettings(null);
  for (const kind of ['ask', 'done', 'error']) assert.deepEqual(notifyPlan(kind, d, { away: true }), { sound: true, popup: true }, `${kind} away`);
  assert.deepEqual(notifyPlan('done', d, { away: false }), { sound: false, popup: false }, 'looking at it: nothing');
  assert.deepEqual(notifyPlan('error', d, { away: false }), { sound: false, popup: false });
  assert.deepEqual(notifyPlan('ask', d, { away: false }), { sound: true, popup: false }, 'a permission request still chimes');
  assert.deepEqual(notifyPlan('notice', d, { away: false }), { sound: true, popup: true }, 'app-wide notice');
});

test('notifyPlan: per-type toggles, favourites only, quiet hours (with / without the permission exception), volume 0', () => {
  const base = cleanNotifySettings(null);
  const s = cleanNotifySettings({ ...base, events: { ...base.events, done: { popup: false, sound: true }, error: { popup: true, sound: false } } });
  assert.deepEqual(notifyPlan('done', s, { away: true }), { sound: true, popup: false });
  assert.deepEqual(notifyPlan('error', s, { away: true }), { sound: false, popup: true });

  const fav = cleanNotifySettings({ favoritesOnly: true });
  assert.deepEqual(notifyPlan('done', fav, { away: true, favorite: false }), { sound: false, popup: false });
  assert.deepEqual(notifyPlan('done', fav, { away: true, favorite: true }), { sound: true, popup: true });
  assert.deepEqual(notifyPlan('notice', fav, { away: true }), { sound: true, popup: true }, 'a notice has no project');

  const quiet = cleanNotifySettings({ quiet: { enabled: true, from: '22:00', to: '07:00', allowAsk: true } });
  const night = at('23:15');
  assert.deepEqual(notifyPlan('done', quiet, { away: true, now: night }), { sound: false, popup: false });
  assert.deepEqual(notifyPlan('notice', quiet, { away: true, now: night }), { sound: false, popup: false });
  assert.deepEqual(notifyPlan('ask', quiet, { away: true, now: night }), { sound: true, popup: true }, 'permission still notifies');
  assert.deepEqual(notifyPlan('done', quiet, { away: true, now: at('12:00') }), { sound: true, popup: true }, 'outside quiet hours');
  const strict = cleanNotifySettings({ quiet: { enabled: true, from: '22:00', to: '07:00', allowAsk: false } });
  assert.deepEqual(notifyPlan('ask', strict, { away: true, now: night }), { sound: false, popup: false });

  assert.deepEqual(notifyPlan('done', cleanNotifySettings({ volume: 0 }), { away: true }), { sound: false, popup: true });
});
