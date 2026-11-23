// OpenCode agents V2: the form edits `agents` (falling back to V1 `agent`), its extra fields and `default_agent`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeForm } from '../src/opencode-config.js';

test('mergeForm agents: V2 fields, default_agent, dan kunci agent lain tetap utuh', () => {
  const base = { agents: { lama: { description: 'lama', permissions: { edit: 'deny' } } }, default_agent: 'lama' };
  const config = mergeForm(base, {
    agents: [
      { name: 'lama', description: 'baru', steps: '8', color: '#f00', hidden: true, disabled: true },
      { name: 'baru', mode: 'subagent', prompt: 'Kerjakan X' },
    ],
    defaultAgent: 'baru',
  });
  assert.deepEqual(config.agents.lama, { description: 'baru', permissions: { edit: 'deny' }, steps: 8, color: '#f00', hidden: true, disabled: true });
  assert.deepEqual(config.agents.baru, { mode: 'subagent', system: 'Kerjakan X' });
  assert.equal(config.default_agent, 'baru');
  assert.equal('agent' in config, false, 'V2 tetap di agents');
});

test('mergeForm agents: V1 tetap di agent; default_agent harus ada; steps divalidasi', () => {
  const v1 = mergeForm({ agent: { a: { description: 'x' } } }, { agents: [{ name: 'a', description: 'y' }] });
  assert.deepEqual(v1.agent, { a: { description: 'y' } });
  assert.equal('agents' in v1, false);
  assert.throws(() => mergeForm({}, { agents: [{ name: 'a' }], defaultAgent: 'tidak-ada' }), (e) => e.status === 400);
  assert.throws(() => mergeForm({}, { agents: [{ name: 'a', steps: '0' }] }), (e) => e.status === 400);
  assert.throws(() => mergeForm({}, { agents: [{ name: 'a', steps: '101' }] }), (e) => e.status === 400);
  const cleared = mergeForm({ agents: { a: { steps: 3, color: 'red', hidden: true } } }, { agents: [{ name: 'a', steps: '', color: '', hidden: false }] });
  assert.deepEqual(cleared.agents.a, {});
});

test('mergeForm skills: folder dan katalog http, skema lain ditolak', async () => {
  const assertOk = (value) => {
    const config = mergeForm({}, { skills: [value] });
    assert.deepEqual(config.skills, [value]);
  };
  for (const value of ['./team-skills', '~/shared/opencode-skills', '/opt/company-skills', 'https://example.com/opencode/skills/']) assertOk(value);
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'x'.repeat(501), 'a\u0000b']) {
    assert.throws(() => mergeForm({}, { skills: [bad] }), (e) => e.status === 400, bad.slice(0, 40));
  }
  assert.equal('skills' in mergeForm({ skills: ['a'] }, { skills: [] }), false);
});
