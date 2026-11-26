// 📊 /context breakdown (src/context-usage.js): the categories Claude Code reports, tolerant of a missing detail.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextBreakdown } from '../src/context-usage.js';

test('contextBreakdown: kategori dijumlahkan, diurutkan, dan dipersenkan dari total', () => {
  const rows = contextBreakdown({
    totalTokens: 1000,
    systemPromptTokens: 300,
    claudeMdTokens: 100,
    builtInToolTokens: 200,
    deferredBuiltinTokens: 50,
    toolCallTokens: 100,
    toolResultTokens: 150,
    userMessageTokens: 50,
    assistantMessageTokens: 50,
  });
  assert.deepEqual(rows.map((r) => r.key), ['conversation', 'system', 'tools', 'memory']);
  assert.equal(rows[0].tokens, 350);
  assert.equal(rows[0].percent, 35);
  assert.equal(rows.find((r) => r.key === 'tools').tokens, 250);
});

test('contextBreakdown: field hilang/aneh diabaikan, total jatuh ke jumlah baris', () => {
  const rows = contextBreakdown({ systemPromptTokens: 'x', mcpToolTokens: -5, agentTokens: 40 });
  assert.deepEqual(rows, [{ key: 'agents', label: 'Agent kustom', tokens: 40, percent: 100 }]);
  assert.deepEqual(contextBreakdown({}), []);
  assert.deepEqual(contextBreakdown(null), []);
});
