// Effort Auto's model router with injected model runners: no real CLI and no tokens in these tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyEffort } from '../src/effort-classifier.js';

const bin = { command: 'fake', args: [] };

test('Claude: uses the active model, reads the JSON result envelope, and reports the chosen level', async () => {
  let seen = null;
  const r = await classifyEffort({
    engine: 'claude',
    claude: bin,
    currentModel: 'sonnet',
    text: 'refactor modul auth di beberapa file',
    runClaude: async (gotBin, gotModel, prompt, timeout) => {
      seen = { gotBin, gotModel, prompt, timeout };
      return JSON.stringify({ result: '{"level":"high","reason":"multi-file refactor"}' });
    },
  });
  assert.equal(seen.gotBin, bin);
  assert.equal(seen.gotModel, 'sonnet');
  assert.match(seen.prompt, /refactor modul auth/);
  assert.equal(r.level, 'high');
  assert.equal(r.reason, 'multi-file refactor');
  assert.equal(r.source, 'llm');
  assert.equal(r.model, 'sonnet');
});

test('OpenCode: uses the active model (never a model picked from the catalog), sends the task, and accepts a fenced answer', async () => {
  let model = null;
  const r = await classifyEffort({
    engine: 'opencode',
    opencode: bin,
    currentModel: 'openai/gpt-5',
    text: 'perbaiki bug checkout',
    runOpenCode: async (gotBin, gotModel, prompt) => {
      model = gotModel;
      assert.match(prompt, /perbaiki bug checkout/);
      return '```json\n{"level":"medium","reason":"bug fix"}\n```';
    },
  });
  assert.equal(model, 'openai/gpt-5');
  assert.equal(r.level, 'medium');
  assert.equal(r.source, 'llm');
});

test('an empty current model means the engine default, not a catalog pick', async () => {
  let model = null;
  const r = await classifyEffort({
    engine: 'opencode',
    opencode: bin,
    currentModel: '',
    text: 'halo',
    runOpenCode: async (gotBin, gotModel) => {
      model = gotModel;
      return '{"level":"low","reason":"halo"}';
    },
  });
  assert.equal(model, '');
  assert.equal(r.level, 'low');
  assert.equal(r.model, 'default');
});

test('a failed or empty classifier falls back to the local estimate (no throw)', async () => {
  const failed = await classifyEffort({
    engine: 'claude',
    claude: bin,
    text: 'migrasi database production tanpa downtime',
    runClaude: async () => {
      throw new Error('timeout');
    },
  });
  assert.equal(failed.source, 'fallback');
  assert.ok(['high', 'xhigh', 'max'].includes(failed.level));

  const empty = await classifyEffort({
    engine: 'opencode',
    opencode: bin,
    currentModel: 'x/y',
    runOpenCode: async () => 'no json here',
  });
  assert.equal(empty.source, 'fallback');
  assert.equal(empty.level, 'medium');
});

test('a classifier without an engine/model also falls back instead of blocking the prompt', async () => {
  const r = await classifyEffort({ engine: 'opencode', opencode: null, text: 'perbaiki bug kecil' });
  assert.equal(r.source, 'fallback');
  assert.equal(typeof r.level, 'string');
});
