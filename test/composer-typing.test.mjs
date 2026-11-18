// Composer typing row text, the pure rules (public/js/core/composer-typing.js): one line per active state,
// priority order, and neutral wording — Adhitron reads as ONE app, so the row never names an engine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typingText } from '../public/js/core/composer-typing.js';

test('nothing running: empty text so the composer hides the row', () => {
  assert.equal(typingText({}), '');
  assert.equal(typingText(), '');
  assert.equal(typingText({ classifying: false, planPreparing: null, compacting: false, busy: false, cliBusy: false }), '');
});

test('classifier and plan preparation texts', () => {
  assert.equal(typingText({ classifying: true }), 'Menentukan effort…');
  assert.equal(typingText({ planPreparing: 'build' }), 'Menentukan model & effort…');
  assert.equal(typingText({ planPreparing: 'revisi' }), 'Menyiapkan revisi…');
});

test('compaction and a busy turn', () => {
  assert.equal(typingText({ compacting: true }), '⏳ Memadatkan konteks percakapan…');
  assert.equal(typingText({ busy: true }), 'Tim sedang bekerja…');
});

test('a CLI process is "AI (terminal)", never an engine name (one app, one timeline)', () => {
  for (const state of [{}, { engine: 'claude' }, { engine: 'opencode' }]) {
    const text = typingText({ cliBusy: true, ...state });
    assert.equal(text, 'AI (terminal) sedang bekerja…');
    assert.doesNotMatch(text, /Claude|OpenCode/i);
  }
});

test('a long turn says how long it has been running (busyMs), only after 2 minutes', () => {
  assert.equal(typingText({ cliBusy: true, busyMs: 60_000 }), 'AI (terminal) sedang bekerja…');
  assert.equal(typingText({ cliBusy: true, busyMs: 130_000 }), 'AI (terminal) sedang bekerja… · 2 mnt');
  assert.equal(typingText({ busy: true, busyMs: 125_000 }), 'Tim sedang bekerja… · 2 mnt');
  // The priority states are untouched by the elapsed suffix.
  assert.equal(typingText({ classifying: true, busyMs: 130_000 }), 'Menentukan effort…');
  assert.equal(typingText({ compacting: true, busyMs: 130_000 }), '⏳ Memadatkan konteks percakapan…');
});

test('priority: classifying beats everything', () => {
  const all = { classifying: true, planPreparing: 'build', compacting: true, busy: true, cliBusy: true, engine: 'opencode' };
  assert.equal(typingText(all), 'Menentukan effort…');
});

test('priority: plan preparation beats compaction, busy and CLI', () => {
  assert.equal(typingText({ planPreparing: 'build', compacting: true, busy: true, cliBusy: true }), 'Menentukan model & effort…');
  assert.equal(typingText({ planPreparing: 'revisi', compacting: true, busy: true, cliBusy: true }), 'Menyiapkan revisi…');
});

test('priority: compaction beats busy and CLI', () => {
  assert.equal(typingText({ compacting: true, busy: true, cliBusy: true }), '⏳ Memadatkan konteks percakapan…');
});

test('priority: a busy turn beats a CLI process', () => {
  assert.equal(typingText({ busy: true, cliBusy: true, engine: 'opencode' }), 'Tim sedang bekerja…');
});
