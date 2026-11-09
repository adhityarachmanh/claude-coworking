// Effort Auto's model router with injected model runners: no real CLI and no tokens in these tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoContext, classifyEffort } from '../src/effort-classifier.js';

const bin = { command: 'fake', args: [] };

test('classifierModel: the Seimbang model wins over the active model (routing never spends pro tokens)', async () => {
  let seen = null;
  const r = await classifyEffort({
    engine: 'opencode',
    opencode: bin,
    currentModel: 'opencode-go/deepseek-v4-pro',
    classifierModel: 'opencode-go/deepseek-v4.1-flash',
    text: 'refactor modul auth di beberapa file',
    runOpenCode: async (gotBin, gotModel) => {
      seen = { gotBin, gotModel };
      return '{"level":"high","reason":"multi-file refactor"}';
    },
  });
  assert.equal(seen.gotBin, bin);
  assert.equal(seen.gotModel, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(r.level, 'high');
  assert.equal(r.model, 'opencode-go/deepseek-v4.1-flash');
});

test('Claude: falls back to currentModel when classifierModel is absent, reads the JSON result envelope, and reports the level', async () => {
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

test('OpenCode: falls back to currentModel when classifierModel is absent, sends the task, and accepts a fenced answer', async () => {
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

test('a short follow-up is classified against the plan that came before it', async () => {
  let prompt = '';
  const r = await classifyEffort({
    engine: 'claude',
    claude: bin,
    text: 'kerjakan',
    context: 'Agen: Rencana: 1) perbaiki 3 file 2) tambah test 3) update docs\nRencana/todo: pending perbaiki 3 file',
    runClaude: async (_bin, _model, seen) => {
      prompt = seen;
      return '{"level":"high"}';
    },
  });
  assert.match(prompt, /<context>[\s\S]*perbaiki 3 file[\s\S]*<\/context>/, 'the plan rides along with the short prompt');
  assert.match(prompt, /<task>\nkerjakan\n<\/task>/);
  assert.equal(r.level, 'high');
});

test('autoContext: the recent conversation plus the current todo list, bounded', () => {
  const hub = {
    chatOf: () => [
      { kind: 'user', text: 'apakah aplikasi ini masih kurang?' },
      { kind: 'assistant', text: 'Rencana: perbaiki A, B, C' },
      { kind: 'tool', text: 'ignored' },
    ],
    statusFor: () => ({ todos: [{ status: 'pending', content: 'perbaiki A' }, { status: 'in_progress', content: 'perbaiki B' }] }),
  };
  const context = autoContext(hub, 'p1');
  assert.match(context, /Saya: apakah aplikasi ini masih kurang/);
  assert.match(context, /Agen: Rencana: perbaiki A, B, C/);
  assert.match(context, /Rencana\/todo: pending perbaiki A; in_progress perbaiki B/);
  assert.ok(!context.includes('ignored'), 'tool rows are not plan context');
  assert.ok(autoContext({ chatOf: () => [], statusFor: () => ({}) }, 'p1') === '');
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
