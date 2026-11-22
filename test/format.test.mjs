// Label/format helpers used by the composer (pure, no DOM).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsChipText, shortOptionLabel } from '../public/js/core/format.js';

test('settings chip label drops the parenthetical detail always and the price hint on a phone', () => {
  assert.equal(shortOptionLabel('Default (Fable 5 · 200k konteks)'), 'Default');
  // A laptop keeps the price hint: the chip has room there.
  assert.equal(shortOptionLabel('deepseek-v4.1-flash — ±$0.15 in / $0.6 out /1M'), 'deepseek-v4.1-flash — ±$0.15 in / $0.6 out /1M');
  // The phone chip is one short line: the dialog shows the numbers instead.
  assert.equal(shortOptionLabel('deepseek-v4.1-flash — ±$0.15 in / $0.6 out /1M', { price: true }), 'deepseek-v4.1-flash');
  assert.equal(shortOptionLabel('GPT-5 — gratis', { price: true }), 'GPT-5');
  assert.equal(shortOptionLabel('Auto (LLM)', { price: true }), 'Auto');
  // A model name without a price hint is untouched.
  assert.equal(shortOptionLabel('claude-opus-5-5', { price: true }), 'claude-opus-5-5');
  assert.equal(shortOptionLabel(''), '');
  assert.equal(shortOptionLabel(undefined), '');
});

test('settingsChipText: token yang sama tidak diulang (emoji tidak dihitung)', () => {
  // The phone chip showed "⚡ Auto · Auto · Auto · Tim": mode, model and effort all said the same thing.
  assert.equal(settingsChipText(['⚡ Auto', 'Auto', 'Auto', 'Tim']), '⚡ Auto · Tim');
  assert.equal(settingsChipText(['🔨 Build', 'Auto', 'High', 'Tim']), '🔨 Build · Auto · High · Tim');
  assert.equal(settingsChipText(['📋 Plan', 'Opus', '', '', 'Tim']), '📋 Plan · Opus · Tim');
  assert.equal(settingsChipText(['Auto', 'auto']), 'Auto');
  assert.equal(settingsChipText([]), '');
});
