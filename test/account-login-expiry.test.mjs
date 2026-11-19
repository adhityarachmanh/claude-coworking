// ⚠ Login Claude Code yang hampir kedaluwarsa (src/account.js loginExpiryNote): the pure decision behind the
// one-line nudge in 👤 Akun. `claude auth status --json` on 2.1.328 reports `loginExpiresAt`; the app turns it into
// a warning only when it is close (and never nags otherwise). No server, no CLI.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginExpiryNote } from '../src/account.js';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const hours = (h) => new Date(NOW + h * 3_600_000).toISOString();
const loggedIn = (loginExpiresAt) => ({ loggedIn: true, loginExpiresAt });

test('loginExpiryNote: a close ISO expiry yields an Indonesian nudge with the remaining time', () => {
  const note = loginExpiryNote(loggedIn(hours(30)), NOW);
  assert.match(note, /Login Claude Code berakhir dalam 30 jam/);
  assert.match(note, /👤 Akun/);
});

test('loginExpiryNote: an expiry under 48 h reads in hours, further out in days', () => {
  assert.match(loginExpiryNote(loggedIn(hours(5)), NOW), /dalam 5 jam/);
  const days = loginExpiryNote(loggedIn(hours(60)), NOW); // 2.5 days → rounds to 3 hari
  assert.match(days, /dalam 3 hari/);
});

test('loginExpiryNote: nothing to warn about stays silent', () => {
  assert.equal(loginExpiryNote(loggedIn(hours(24 * 10)), NOW), null, 'further out than the window');
  assert.equal(loginExpiryNote(loggedIn(hours(-1)), NOW), null, 'already expired');
  assert.equal(loginExpiryNote(loggedIn(null), NOW), null, 'no expiry reported');
  assert.equal(loginExpiryNote({ loggedIn: false, loginExpiresAt: hours(1) }, NOW), null, 'not logged in');
  assert.equal(loginExpiryNote(null, NOW), null, 'no profile');
});

test('loginExpiryNote: epoch seconds and epoch milliseconds are both accepted', () => {
  const sec = Math.floor(NOW / 1000) + 36_000; // +10 h, seconds
  const ms = NOW + 36_000_000; // +10 h, ms
  assert.match(loginExpiryNote(loggedIn(sec), NOW), /dalam 10 jam/);
  assert.match(loginExpiryNote(loggedIn(ms), NOW), /dalam 10 jam/);
});

test('loginExpiryNote: the window is configurable and the default is 3 days', () => {
  assert.equal(loginExpiryNote(loggedIn(hours(24 * 4)), NOW), null, '4 days: outside the default 3-day window');
  assert.match(loginExpiryNote(loggedIn(hours(24 * 4)), NOW, 7), /dalam 4 hari/, 'a 7-day window includes it');
});