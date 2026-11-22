// OpenCode policies (top-level `policies`): ordered allow/deny statements that only ever tighten what agents may use.
// A policy is never a permission prompt; an effect other than allow/deny is invalid upstream. Order is preserved
// (last match wins), and unknown keys of a statement survive an edit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergePolicies, policiesView } from '../src/opencode-policies.js';

test('policiesView: hanya statement berbentuk benar, urutan dipertahankan', () => {
  const view = policiesView({
    policies: [
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'tool.use', resource: 'shell:git push *', effect: 'allow' },
      { action: 'x', resource: 'y' },
      'bukan objek',
    ],
  });
  assert.deepEqual(view, [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'tool.use', resource: 'shell:git push *', effect: 'allow' },
  ]);
  assert.deepEqual(policiesView({}), []);
});

test('mergePolicies: urutan, validasi effect/action/resource, field asing dipertahankan', () => {
  const base = { theme: 'x', policies: [{ action: 'tool.use', resource: 'shell:rm *', effect: 'deny', note: 'dari admin' }] };
  mergePolicies(base, [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'tool.use', resource: 'shell:rm *', effect: 'deny' },
  ]);
  assert.deepEqual(base.policies, [
    { action: 'provider.use', resource: '*', effect: 'deny' },
    { action: 'tool.use', resource: 'shell:rm *', effect: 'deny', note: 'dari admin' },
  ]);
  mergePolicies(base, []);
  assert.equal('policies' in base, false);
  for (const bad of [
    [{ action: 'provider.use', resource: '*', effect: 'ask' }],
    [{ action: 'Bad Action', resource: '*', effect: 'deny' }],
    [{ action: 'tool.use', resource: '', effect: 'deny' }],
    [{ action: 'tool.use', resource: 'a\nb', effect: 'deny' }],
    [{ action: 'tool.use', resource: 'x'.repeat(501), effect: 'deny' }],
    Array.from({ length: 101 }, () => ({ action: 'tool.use', resource: 'x', effect: 'deny' })),
    'x',
  ]) {
    assert.throws(() => mergePolicies({}, bad), (e) => e.status === 400, JSON.stringify(bad).slice(0, 80));
  }
});
