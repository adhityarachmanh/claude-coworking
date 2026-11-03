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

test('⧗ Tugas latar: the service shells become tasks; one whose call ended is in the background; gone = completed', () => {
  const statuses = [];
  const t = new StreamTranslator({ office() {}, chat: () => 'c1', updateChat() {}, status: (p) => statuses.push(p) });
  t.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run dev' } }] } });
  t.linkShellTask('t1', 'oc:sh_a');
  t.syncShellTasks([{ id: 'oc:sh_a', command: 'npm run dev', startedAt: 1, toolUseId: 't1' }, { id: 'oc:sh_b', command: 'npm test', startedAt: 2 }]);
  let tasks = statuses.findLast((s) => s.tasks).tasks;
  const a = tasks.find((x) => x.id === 'oc:sh_a');
  assert.deepEqual([a.kind, a.status, a.background, a.command], ['shell', 'running', false, 'npm run dev']);
  assert.equal(tasks.find((x) => x.id === 'oc:sh_b').background, true, 'no open call: in the background');
  assert.equal(tasks.find((x) => x.id === 'oc:sh_b').role, 'qa');
  assert.deepEqual(t.runningTaskIds().sort(), ['oc:sh_a', 'oc:sh_b']);
  t.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'moved to background' }] } });
  t.syncShellTasks([{ id: 'oc:sh_a', command: 'npm run dev', toolUseId: 't1' }]);
  tasks = statuses.findLast((s) => s.tasks).tasks;
  assert.equal(tasks.find((x) => x.id === 'oc:sh_a').background, true);
  assert.equal(tasks.find((x) => x.id === 'oc:sh_b').status, 'completed');
});

test('model picker stand-in: the models running ACP sessions offer, valid ids only, no duplicates', async () => {
  const { modelsOffered } = await import('../src/opencode-bin.js');
  const a = { configOptions: [{ id: 'model', options: [{ value: 'opencode-go/beam-free' }, { value: 'google/gemini-2.5-flash' }] }, { id: 'mode', options: [{ value: 'build' }] }] };
  const b = { configOptions: [{ id: 'model', options: [{ value: 'google/gemini-2.5-flash' }, { value: 'bad id; rm' }, { value: 42 }] }] };
  assert.deepEqual(modelsOffered([a, b, {}, { configOptions: null }]), ['opencode-go/beam-free', 'google/gemini-2.5-flash']);
  assert.deepEqual(modelsOffered([]), []);
});
