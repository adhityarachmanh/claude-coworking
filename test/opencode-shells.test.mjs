// OpenCode shells (src/opencode-shells.js) and how a turn's bash call is linked to one (translator).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchShell, OC_TASK } from '../src/opencode-shells.js';
import { StreamTranslator } from '../src/translator.js';

const sh = (id, command, started) => ({ id, command, status: 'running', time: { started } });

test('a bash call is matched to its running shell: exact first, whitespace-insensitive, newest, never twice', () => {
  const shells = [sh('sh_a', 'npm   test', 1), sh('sh_b', 'npm test', 2), sh('sh_c', 'bash -lc "node server.js --port 1"', 3)];
  assert.equal(matchShell(shells, 'npm test').id, 'sh_b');
  assert.equal(matchShell(shells, 'npm test', new Set(['sh_b'])).id, 'sh_a');
  assert.equal(matchShell(shells, 'node server.js --port 1').id, 'sh_c', 'wrapped by OpenCode');
  assert.equal(matchShell(shells, 'cargo build'), null);
  assert.equal(matchShell(shells, ''), null);
  assert.ok(OC_TASK.test('oc:sh_b') && !OC_TASK.test('sh_b') && !OC_TASK.test('oc:../x'));
});

test('translator: running shells without a task are listed, linked once, and the chat row gets the task id', () => {
  const chats = [];
  const updates = [];
  const t = new StreamTranslator({ office() {}, chat: (m) => (chats.push(m), `c${chats.length}`), updateChat: (id, patch) => updates.push([id, patch]), status() {} });
  t.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.js' } }] } });
  const list = t.unlinkedShells();
  assert.deepEqual(list.map((s) => [s.toolUseId, s.command]), [['t1', 'npm test']]);
  t.linkShellTask('t1', 'oc:sh_b');
  t.linkShellTask('t1', 'oc:sh_x'); // already linked: ignored
  assert.deepEqual(updates.filter(([, p]) => p.taskId), [['c1', { taskId: 'oc:sh_b' }]]);
  assert.deepEqual(t.unlinkedShells(), []);
  assert.deepEqual([...t.linkedTaskIds()], ['oc:sh_b']);
});
