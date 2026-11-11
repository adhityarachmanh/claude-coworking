import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Hub } from '../src/hub.js';
import { appModeFromCli, claudePermissionMode, isMode, migrateMode, normalizeMode } from '../src/modes.js';

describe('Plan/Build modes', () => {
  test('migrateMode: legacy asks become build, dontAsk waits for a choice, canonical values are untouched', () => {
    assert.equal(migrateMode('plan'), null);
    assert.equal(migrateMode('build'), null);
    assert.deepEqual(migrateMode('manual'), { mode: 'build', legacyMode: 'manual' });
    assert.deepEqual(migrateMode('acceptEdits'), { mode: 'build', legacyMode: 'acceptEdits' });
    assert.deepEqual(migrateMode('auto'), { mode: 'build', legacyMode: 'auto' });
    assert.deepEqual(migrateMode('dontAsk'), { mode: 'plan', legacyMode: 'dontAsk', pending: true });
    assert.equal(migrateMode('build'), null);
    assert.equal(migrateMode('nonsense'), null);
    assert.equal(migrateMode(undefined), null);
  });

  test('only build and plan are storable; legacy/unknown values read as build', () => {
    assert.equal(isMode('build'), true);
    assert.equal(isMode('plan'), true);
    for (const value of ['manual', 'acceptEdits', 'auto', 'dontAsk', '', null]) assert.equal(isMode(value), false);
    assert.equal(normalizeMode('plan'), 'plan');
    for (const value of ['build', 'manual', 'auto', 'dontAsk', 'nonsense', null]) assert.equal(normalizeMode(value), 'build');
  });

  test('Claude gets Plan or auto-edit only: never a permission bypass', () => {
    assert.equal(claudePermissionMode('plan'), 'plan');
    assert.equal(claudePermissionMode('build'), 'acceptEdits');
    for (const value of ['auto', 'dontAsk', 'manual', undefined]) {
      assert.equal(claudePermissionMode(value), 'acceptEdits');
      assert.notEqual(claudePermissionMode(value), 'bypassPermissions');
    }
  });

  test('a CLI mode reported outside the app is shown as build/plan, never stored as a looser mode', () => {
    assert.equal(appModeFromCli('plan'), 'plan');
    for (const value of ['acceptEdits', 'default', 'auto', 'dontAsk', undefined]) assert.equal(appModeFromCli(value), 'build');
  });

  test('Hub migrates stored modes once; dontAsk becomes Plan pending an explicit choice', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'modes-hub-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        settings: {
          p1: { mode: 'manual' },
          p2: { mode: 'acceptEdits' },
          p3: { mode: 'auto' },
          p4: { mode: 'plan' },
          p5: { mode: 'dontAsk' },
          p6: { mode: 'build' },
          p7: {},
        },
      }),
    );
    const hub = new Hub({ dataDir: dir });
    assert.equal(hub.settingsFor('p5').modePendingChoice, true);
    const stored = JSON.parse(readFileSync(file, 'utf8')).settings;
    assert.equal(stored.p1.mode, 'build');
    assert.equal(stored.p1.legacyMode, 'manual');
    assert.equal(stored.p2.mode, 'build');
    assert.equal(stored.p3.mode, 'build');
    assert.equal(stored.p4.mode, 'plan');
    assert.equal(stored.p5.mode, 'plan');
    assert.equal(stored.p5.modePendingChoice, true);
    assert.equal(stored.p5.legacyMode, 'dontAsk');
    assert.equal(stored.p6.mode, 'build');
    assert.equal(stored.p7.mode, undefined, 'a project without a mode is not rewritten');
    // The first run saves; the second is a no-op (idempotent).
    const once = readFileSync(file, 'utf8');
    const again = new Hub({ dataDir: dir });
    assert.equal(readFileSync(file, 'utf8'), once);
    assert.equal(again.settingsFor('p5').modePendingChoice, true);
    assert.equal(again.settingsFor('p5').mode, 'plan');
  });

  test('an explicit mode choice clears the pending flag; an unrelated model save does not', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'modes-choice-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ settings: { p1: { mode: 'dontAsk' } } }));
    const hub = new Hub({ dataDir: dir });
    assert.equal(hub.settingsFor('p1').modePendingChoice, true);
    hub.updateSettings('p1', { model: 'sonnet' });
    assert.equal(hub.settingsFor('p1').modePendingChoice, true, 'a model change is not a mode choice');
    hub.updateSettings('p1', { mode: 'build', modeChosen: true });
    assert.equal(hub.settingsFor('p1').modePendingChoice, undefined);
    assert.equal(hub.settingsFor('p1').mode, 'build');
    // An old tab's dontAsk is ignored instead of loosening the project.
    hub.updateSettings('p1', { mode: 'dontAsk' });
    assert.equal(hub.settingsFor('p1').mode, 'build');
  });
});
