// Composer typing row text, the pure rules (public/js/core/composer-typing.js): one line per active state,
// priority order, and a CLI label that follows the project's engine (an OpenCode project must never say
// "Claude Code", or the user thinks a CLI that is not logged in is the one working).
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

test('a CLI process names its own engine, not always Claude Code', () => {
  const label = (e) => ({ claude: 'Claude Code', opencode: 'OpenCode' })[e] ?? String(e ?? 'Claude Code');
  assert.equal(typingText({ cliBusy: true, engine: 'claude' }, label), 'Claude Code (terminal) sedang bekerja…');
  assert.equal(typingText({ cliBusy: true, engine: 'opencode' }, label), 'OpenCode (terminal) sedang bekerja…');
  assert.ok(!typingText({ cliBusy: true, engine: 'opencode' }, label).includes('Claude Code'));
});

test('a long turn says how long it has been running (busyMs), only after 2 minutes', () => {
  const label = (e) => ({ claude: 'Claude Code', opencode: 'OpenCode' })[e] ?? String(e);
  assert.equal(typingText({ cliBusy: true, engine: 'opencode', busyMs: 60_000 }, label), 'OpenCode (terminal) sedang bekerja…');
  assert.equal(typingText({ cliBusy: true, engine: 'opencode', busyMs: 130_000 }, label), 'OpenCode (terminal) sedang bekerja… · 2 mnt');
  assert.equal(typingText({ busy: true, busyMs: 125_000 }, label), 'Tim sedang bekerja… · 2 mnt');
  // The priority states are untouched by the elapsed suffix.
  assert.equal(typingText({ classifying: true, busyMs: 130_000 }, label), 'Menentukan effort…');
  assert.equal(typingText({ compacting: true, busyMs: 130_000 }, label), '⏳ Memadatkan konteks percakapan…');
});

test('the default label only fills in when no engine is known; otherwise it prints the engine verbatim', () => {
  assert.equal(typingText({ cliBusy: true }), 'Claude Code (terminal) sedang bekerja…');
  assert.equal(typingText({ cliBusy: true, engine: 'claude' }), 'claude (terminal) sedang bekerja…');
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
