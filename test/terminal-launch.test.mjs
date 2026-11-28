// 🖥 Fallback terminal argv (src/terminal-launch.js): only the pinned modes, never a free-form command.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalArgv } from '../src/terminal-launch.js';

const claude = { command: 'C:\\bin\\claude.exe', args: [] };
const opencode = { command: 'C:\\bin\\opencode.exe', args: [] };

test('terminalArgv: mode tetap, attach hanya dengan id aman', () => {
  assert.deepEqual(terminalArgv({ mode: 'claude' }, { claude, opencode }), ['C:\\bin\\claude.exe']);
  assert.deepEqual(terminalArgv({ mode: 'opencode' }, { claude, opencode }), ['C:\\bin\\opencode.exe']);
  assert.deepEqual(terminalArgv({ mode: 'attach', agentId: 'abc-123' }, { claude }), ['C:\\bin\\claude.exe', 'attach', 'abc-123']);
  assert.equal(terminalArgv({ mode: 'attach', agentId: '; rm -rf' }, { claude }), null);
  assert.equal(terminalArgv({ mode: 'shell', agentId: 'x' }, { claude }), null);
  assert.equal(terminalArgv({ mode: 'claude' }, {}), null);
});
