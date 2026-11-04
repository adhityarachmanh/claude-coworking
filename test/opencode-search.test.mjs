// Global search over OpenCode's own sessions, with an injected session list/API (no CLI, no tokens).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchOpenCodeSessions } from '../src/opencode-search.js';

const project = { id: 'p1', name: 'toko', path: 'C:\\projects\\toko' };
const bin = { command: 'fake', args: [] };

test('OpenCode search: user prompts and assistant text, with project/session metadata', async () => {
  const r = await searchOpenCodeSessions([project], 'checkout', {
    opencode: bin,
    limit: 20,
    list: async () => [
      { id: 'ses_one', title: 'Perbaikan checkout', updated: 500 },
      { id: 'ses_two', title: 'Lain', updated: 400 },
    ],
    api: async (_bin, op, { params }) => {
      assert.equal(op, 'session.message.list');
      if (params.sessionID === 'ses_one') {
        return [
          { type: 'assistant', content: [{ type: 'text', text: 'Bug checkout sudah diperbaiki.' }], time: { created: 450 } },
          { type: 'user', text: 'tolong cek checkout', time: { created: 400 } },
        ];
      }
      return [{ type: 'assistant', content: [{ type: 'text', text: 'tidak ada' }], time: { created: 300 } }];
    },
  });
  assert.equal(r.query, 'checkout');
  assert.equal(r.sessions, 2);
  assert.deepEqual(r.results.map((x) => [x.projectId, x.sessionId, x.source, x.engine, x.role, x.title]), [
    ['p1', 'ses_one', 'opencode', 'opencode', 'assistant', 'Perbaikan checkout'],
    ['p1', 'ses_one', 'opencode', 'opencode', 'user', 'Perbaikan checkout'],
  ]);
  assert.match(r.results[0].snippet.before + r.results[0].snippet.match, /checkout/);
});

test('OpenCode search: query bounds, missing binary, and a failing session do not throw', async () => {
  assert.rejects(searchOpenCodeSessions([project], 'a', { opencode: bin }), { status: 400 });
  assert.deepEqual(await searchOpenCodeSessions([project], 'halo', { opencode: null }), { query: 'halo', results: [], truncated: false, sessions: 0 });
  const r = await searchOpenCodeSessions([project], 'halo', {
    opencode: bin,
    list: async () => [{ id: 'ses_x', title: 'X', updated: 1 }],
    api: async () => {
      throw new Error('service down');
    },
  });
  assert.deepEqual(r.results, []);
});
