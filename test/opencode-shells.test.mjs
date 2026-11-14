// OpenCode shells (src/opencode-shells.js) and how a turn's bash call is linked to one (translator).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { matchShell, matchShellProcess, OC_TASK, shellFileMtime, shellFileTail, shellOutputFile } from '../src/opencode-shells.js';
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

// ---------- ACP-hosted shells: the output file (read) and the guarded stop (kill) ----------

const p = (pid, ppid, command, extra = {}) => ({ pid, ppid, command, ...extra });

test('shellOutputFile / shellFileTail: the project folder is found by one scan, cached, tail = last 8 KB', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'shellout-'));
  const prev = process.env.OFFICE_OPENCODE_SHELL_DIR;
  process.env.OFFICE_OPENCODE_SHELL_DIR = base;
  try {
    assert.equal(shellOutputFile('oc:sh_a'), null, 'nothing written yet');
    assert.equal(shellOutputFile('../evil'), null);
    const dir = path.join(base, 'proj-abc123');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'sh_a.out'), 'x'.repeat(9000) + 'EKOR');
    assert.equal(shellOutputFile('sh_a'), path.join(dir, 'sh_a.out'));
    let tail = shellFileTail('sh_a');
    assert.equal(tail.truncated, true);
    assert.equal(tail.output.length, 8192);
    assert.ok(tail.output.endsWith('EKOR'));
    assert.ok(Math.abs(tail.mtimeMs - Date.now()) < 10_000);
    assert.equal(shellFileMtime('sh_a'), tail.mtimeMs);
    // a second shell in the same folder: the cached folder answers without another full scan
    writeFileSync(path.join(dir, 'sh_b.out'), 'kecil');
    tail = shellFileTail('sh_b');
    assert.deepEqual([tail.output, tail.truncated], ['kecil', false]);
    assert.equal(shellFileTail('sh_missing'), null);
  } finally {
    process.env.OFFICE_OPENCODE_SHELL_DIR = prev;
    rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('matchShellProcess: only the unique tree inside our ACP child is killed; ambiguous or foreign fails closed', () => {
  const acp = p(100, 1, 'node ... serve --stdio');
  const wrapper = p(200, 100, 'powershell -Command npm test');
  const inner = p(300, 200, 'node .../npm test');
  const foreign = p(400, 1, 'powershell -Command npm test'); // same text, not ours
  const table = [acp, wrapper, inner, foreign];
  const top = matchShellProcess('npm test', 100, table);
  assert.equal(top?.pid, 200, 'the topmost of our own matching chain (its tree kill takes the inner one)');
  assert.equal(matchShellProcess('npm test', 100, [acp, wrapper, inner, p(500, 200, 'cmd /c npm test')])?.pid, 200);
  assert.equal(matchShellProcess('npm test', 100, [acp, foreign]), null, 'no match inside our own tree');
  assert.equal(matchShellProcess('npm test', 100, [acp]), null);
  assert.equal(matchShellProcess('', 100, table), null);
  assert.equal(matchShellProcess('npm test', 0, table), null);
  assert.equal(matchShellProcess('npm test', 100, []), null);
  assert.equal(matchShellProcess('npm test', 100, 'nope'), null);
  // unrelated commands in the same tree are left alone
  assert.equal(matchShellProcess('cargo build', 100, table), null);
});

// Linux /proc stat fields are the same shape: ppid from the same table (a fake is enough for the matcher)
test('matchShellProcess (Linux shape): the group leader is found via the ppid chain only', () => {
  const table = [p(10, 1, 'node serve --stdio'), p(20, 10, 'bash -lc "ping -c 60 localhost"'), p(30, 20, 'ping -c 60 localhost', { pgrp: 20 })];
  assert.equal(matchShellProcess('ping -c 60 localhost', 10, table)?.pid, 20);
});

// ---------- translator: `oc:` tasks of ACP-hosted shells, state from the tool call only ----------

const statusTasks = (statuses) => statuses.findLast((s) => s.tasks)?.tasks ?? [];

test('translator: an acp shell call with metadata registers oc:<shellID>, closes with its call, and stays closed', () => {
  const statuses = [];
  const t = new StreamTranslator({ office() {}, chat: () => 'c1', updateChat() {}, status: (s) => statuses.push(s) });
  t.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo shell-berkas' } }] } });
  t.handle({ type: 'system', subtype: 'task_started', task_id: 'oc:sh_fake1', is_backgrounded: false, tool_use_id: 't1', description: 'echo shell-berkas', startedAt: 5, source: 'acp' });
  let tasks = statusTasks(statuses);
  let a = tasks.find((x) => x.id === 'oc:sh_fake1');
  assert.deepEqual([a.kind, a.status, a.background, a.source, a.startedAt, a.command], ['shell', 'running', false, 'acp', 5, 'echo shell-berkas']);
  assert.deepEqual(t.runningTaskIds(), ['oc:sh_fake1']);
  // the call completes: the task ends with it, with its outcome
  t.handle({ type: 'system', subtype: 'task_updated', task_id: 'oc:sh_fake1', patch: { status: 'failed', error: 'gagal' } });
  a = statusTasks(statuses).find((x) => x.id === 'oc:sh_fake1');
  assert.equal(a.status, 'failed');
  assert.deepEqual(t.runningTaskIds(), []);
  // the service cannot see acp shells: an empty or stale service list never resurrects or re-closes it
  t.syncShellTasks([]);
  t.syncShellTasks([{ id: 'oc:sh_fake1', command: 'echo shell-berkas', startedAt: 9 }]);
  a = statusTasks(statuses).find((x) => x.id === 'oc:sh_fake1');
  assert.equal(a.status, 'failed', 'no resurrection from the service list');
  // a service task keeps today's behavior (a non-live one closes)
  t.syncShellTasks([{ id: 'oc:sh_service', command: 'npm run dev', startedAt: 2 }]);
  t.syncShellTasks([]);
  assert.equal(statusTasks(statuses).find((x) => x.id === 'oc:sh_service').status, 'completed');
});

test('translator: a turn end closes a still-open acp shell call; a background one keeps running', () => {
  const statuses = [];
  const t = new StreamTranslator({ office() {}, chat: () => 'c1', updateChat() {}, status: (s) => statuses.push(s) });
  t.handle({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo shell-gantung' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'echo shell-latar' } }] } });
  t.handle({ type: 'system', subtype: 'task_started', task_id: 'oc:sh_fake3', is_backgrounded: false, tool_use_id: 't1', description: 'echo shell-gantung', source: 'acp' });
  t.handle({ type: 'system', subtype: 'task_started', task_id: 'oc:sh_fake2', is_backgrounded: true, tool_use_id: 't2', description: 'echo shell-latar', source: 'acp' });
  t.handle({ type: 'result', subtype: 'success' });
  const tasks = statusTasks(statuses);
  assert.equal(tasks.find((x) => x.id === 'oc:sh_fake3').status, 'completed', 'the call was still open: done with the turn');
  assert.equal(tasks.find((x) => x.id === 'oc:sh_fake2').status, 'running', 'a background shell carries on past the turn');
  assert.deepEqual(t.runningTaskIds(), ['oc:sh_fake2']);
});
