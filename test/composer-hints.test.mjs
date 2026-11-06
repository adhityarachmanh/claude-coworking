// The composer's hint line: the most important 2 messages on screen, every message still available in the tooltip.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerHints, hintLine } from '../public/js/features/hints.js';

const busy = { busy: true, queue: 2, cliBusy: true, autoApprove: true };

test('hintLine: max 2 messages on screen, the rest stay in the title', () => {
  const hints = composerHints(busy, { readOnly: true, readOnlyHint: 'Hanya lihat lewat WiFi' });
  assert.deepEqual(hints, ['👁 Hanya lihat lewat WiFi.', '⚠ Semua izin otomatis.', 'Tim bekerja — 2 pesan antre.']);
  const line = hintLine(hints);
  assert.equal(line.text, '👁 Hanya lihat lewat WiFi. · ⚠ Semua izin otomatis.');
  assert.equal(line.title, hints.join(' · '), 'nothing is lost: the full line is the tooltip');
});

test('composerHints: priority is read-only, auto-approve, busy, terminal; a quiet composer is empty', () => {
  assert.deepEqual(composerHints({ busy: true, cliBusy: true }, { readOnly: true, readOnlyHint: 'x' }), ['👁 x.', 'Tim bekerja — pesan baru dibaca di langkah berikutnya.']);
  assert.deepEqual(composerHints({ cliBusy: true }), ['Sesi terminal berjalan.']);
  assert.deepEqual(composerHints({}), []);
  assert.equal(hintLine([]).text, '');
});
