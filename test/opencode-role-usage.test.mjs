// 🧩 src/opencode-role-usage.js: OpenCode's session list → role map, with a fake API (no CLI, no real store).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCodeRoleSessions } from '../src/opencode-role-usage.js';

const bin = { command: 'opencode', args: [] };
const session = (id, agent, tokens = {}, cost = null) => ({ id, agent, tokens, cost });

test('openCodeRoleSessions: id, agent, token total and cost; malformed entries are skipped', async () => {
  const api = async (b, operation, opts) => {
    assert.equal(operation, 'session.list');
    assert.equal(opts.params.limit, 500);
    return {
      data: [
        session('ses_a', 'QA', { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }, 0.5),
        session('ses_b', 'build', { input: 10, output: 0 }, 0),
        session('not-a-session', 'qa', { input: 99 }),
        { id: 'ses_c' },
      ],
    };
  };
  const map = await openCodeRoleSessions(bin, { api, now: () => 1000 });
  assert.equal(map.size, 3);
  assert.deepEqual(map.get('ses_a'), { agent: 'qa', tokens: 15, cost: 0.5 });
  assert.equal(map.get('ses_b').agent, 'build');
  assert.equal(map.get('ses_c').agent, '');
});

test('openCodeRoleSessions: a missing binary or a failing service is an empty map', async () => {
  assert.equal((await openCodeRoleSessions(null, { api: async () => ({ data: [] }) })).size, 0);
  const failing = await openCodeRoleSessions({ command: 'opencode-fail', args: [] }, {
    api: async () => {
      throw new Error('service down');
    },
    now: () => 2000,
  });
  assert.equal(failing.size, 0);
});

test('openCodeRoleSessions: the session list is cached for a minute', async () => {
  let calls = 0;
  let now = 5000;
  const api = async () => {
    calls++;
    return { data: [session('ses_cache', 'backend', { input: 1 })] };
  };
  const first = await openCodeRoleSessions({ command: 'opencode-cache', args: [] }, { api, now: () => now });
  const second = await openCodeRoleSessions({ command: 'opencode-cache', args: [] }, { api, now: () => now + 1000 });
  assert.equal(calls, 1, 'cached');
  assert.equal(first.size, 1);
  assert.equal(second.size, 1);
  now += 61_000;
  await openCodeRoleSessions({ command: 'opencode-cache', args: [] }, { api, now: () => now });
  assert.equal(calls, 2, 'expired after a minute');
});
