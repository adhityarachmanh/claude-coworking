// Claude flags (src/hub.js cleanSettings): per-project spawn flags are validated so a hand-edited state.json can
// never put junk into the Claude process arguments.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';

test('cleanSettings: flag Claude valid disimpan, junk diabaikan', () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'cf-data-')) });
  const dir = mkdtempSync(path.join(tmpdir(), 'cf-proj-'));
  const project = hub.upsertProject(dir, 'custom');

  hub.updateSettings(project.id, {
    claudeFallbackModel: 'sonnet,haiku',
    claudeMaxTurns: 3,
    claudeMaxBudgetUsd: 5,
    claudeTools: 'Bash,Edit,Read',
    claudeAllowedTools: ['Read', 'Bash(git log *)'],
    claudeDisallowedTools: ['Edit', 'Bash(rm *)'],
    claudeSettingSources: 'user,project',
  });
  const s = hub.settingsFor(project.id);
  assert.equal(s.claudeFallbackModel, 'sonnet,haiku');
  assert.equal(s.claudeMaxTurns, 3);
  assert.equal(s.claudeMaxBudgetUsd, 5);
  assert.equal(s.claudeTools, 'Bash,Edit,Read');
  assert.deepEqual(s.claudeAllowedTools, ['Read', 'Bash(git log *)']);
  assert.deepEqual(s.claudeDisallowedTools, ['Edit', 'Bash(rm *)']);
  assert.equal(s.claudeSettingSources, 'user,project');

  hub.updateSettings(project.id, {
    claudeFallbackModel: 'bad model name!',
    claudeMaxTurns: -1,
    claudeMaxBudgetUsd: 'sepuluh',
    claudeTools: ['Bash', 'Edit'], // wrong shape
    claudeAllowedTools: ['a\nb'],
    claudeDisallowedTools: 'Edit',
    claudeSettingSources: 'user,cloud',
  });
  const cleaned = hub.settingsFor(project.id);
  // Invalid patches are ignored: the stored values stay.
  assert.equal(cleaned.claudeFallbackModel, 'sonnet,haiku');
  assert.equal(cleaned.claudeMaxTurns, 3);
  assert.equal(cleaned.claudeMaxBudgetUsd, 5);
  assert.deepEqual(cleaned.claudeAllowedTools, ['Read', 'Bash(git log *)']);

  assert.equal(cleaned.claudeSettingSources, 'user,project');
  // A decimal budget is valid (the CLI takes 5.00); a fractional turn count is not.
  hub.updateSettings(project.id, { claudeMaxBudgetUsd: 2.5, claudeMaxTurns: 3.5 });
  assert.equal(hub.settingsFor(project.id).claudeMaxBudgetUsd, 2.5);
  assert.equal(hub.settingsFor(project.id).claudeMaxTurns, 3);
  // A tool rule starting with "-" would be read as another CLI option: it is dropped, never passed through.
  hub.updateSettings(project.id, { claudeAllowedTools: ['Read', '--dangerously-skip-permissions'] });
  assert.deepEqual(hub.settingsFor(project.id).claudeAllowedTools, ['Read']);

  hub.updateSettings(project.id, { claudeMaxTurns: null, claudeTools: '', claudeAllowedTools: [], claudeSettingSources: '' });
  const cleared = hub.settingsFor(project.id);
  assert.equal(cleared.claudeMaxTurns, null);
  assert.equal(cleared.claudeTools, null);
  assert.deepEqual(cleared.claudeAllowedTools, []);
  assert.equal(cleared.claudeSettingSources, null);
});

test('cleanSettings: default kosong untuk project baru', () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'cf-def-')) });
  const project = hub.upsertProject(mkdtempSync(path.join(tmpdir(), 'cf-defp-')), 'custom');
  const s = hub.settingsFor(project.id);
  assert.equal(s.claudeFallbackModel, '');
  assert.equal(s.claudeMaxTurns, null);
  assert.equal(s.claudeMaxBudgetUsd, null);
  assert.equal(s.claudeTools, null);
  assert.deepEqual(s.claudeAllowedTools, []);
  assert.deepEqual(s.claudeDisallowedTools, []);
  assert.equal(s.claudeSettingSources, null);
});

test('settingsFor: state.json yang diedit tangan tidak bisa mengirim argumen aneh', () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'cf-junk-')) });
  const project = hub.upsertProject(mkdtempSync(path.join(tmpdir(), 'cf-junkp-')), 'custom');
  hub.updateSettings(project.id, {});
  Object.assign(hub.persisted.settings[project.id], {
    claudeAllowedTools: 'Read', // a string must never be spread into argv characters
    claudeDisallowedTools: ['-x'],
    claudeMaxTurns: 3.5,
    claudeMaxBudgetUsd: -2,
    claudeTools: '--evil',
    claudeSettingSources: 'user,cloud',
  });
  const s = hub.settingsFor(project.id);
  assert.deepEqual(s.claudeAllowedTools, []);
  assert.deepEqual(s.claudeDisallowedTools, []);
  assert.equal(s.claudeMaxTurns, null);
  assert.equal(s.claudeMaxBudgetUsd, null);
  assert.equal(s.claudeTools, null);
  assert.equal(s.claudeSettingSources, null);
});

test('cleanSettings: advisor, fast mode, dan saran prompt divalidasi', () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'cf-adv-')) });
  const project = hub.upsertProject(mkdtempSync(path.join(tmpdir(), 'cf-advp-')), 'custom');
  const defaults = hub.settingsFor(project.id);
  assert.equal(defaults.claudeAdvisor, '');
  assert.equal(defaults.claudeFastMode, false);
  assert.equal(defaults.claudePromptSuggestions, false);
  assert.equal(defaults.claudeForwardSubagentText, false);
  assert.equal(defaults.claudeNoSessionPersistence, false);
  assert.equal(defaults.claudeSafeMode, false);
  assert.equal(defaults.claudeDebug, false);
  hub.updateSettings(project.id, { claudeAdvisor: 'opus', claudeFastMode: true, claudePromptSuggestions: true, claudeAutocompact: '500k', claudeIncludeHookEvents: true });
  assert.equal(hub.settingsFor(project.id).claudeAdvisor, 'opus');
  assert.equal(hub.settingsFor(project.id).claudeFastMode, true);
  assert.equal(hub.settingsFor(project.id).claudePromptSuggestions, true);
  assert.equal(hub.settingsFor(project.id).claudeAutocompact, '500k');
  assert.equal(hub.settingsFor(project.id).claudeIncludeHookEvents, true);
  hub.updateSettings(project.id, { claudeAutocompact: '50k' });
  assert.equal(hub.settingsFor(project.id).claudeAutocompact, '500k', 'window minimal 100k');
  hub.updateSettings(project.id, { claudeAutocompact: 'auto' });
  assert.equal(hub.settingsFor(project.id).claudeAutocompact, 'auto');
  hub.updateSettings(project.id, { claudeAutocompact: '500000' });
  assert.equal(hub.settingsFor(project.id).claudeAutocompact, '500000');
  hub.updateSettings(project.id, { claudeAutocompact: 'junk' });
  assert.equal(hub.settingsFor(project.id).claudeAutocompact, '500000', 'nilai aneh diabaikan');
  hub.updateSettings(project.id, { claudeAdvisor: '--evil', claudeFastMode: 'yes', claudePromptSuggestions: 'yes' });
  assert.equal(hub.settingsFor(project.id).claudeAdvisor, 'opus', 'nilai berawalan - diabaikan');
  assert.equal(hub.settingsFor(project.id).claudeFastMode, true, 'bukan boolean diabaikan');
  assert.equal(hub.settingsFor(project.id).claudePromptSuggestions, true, 'bukan boolean diabaikan');
});
