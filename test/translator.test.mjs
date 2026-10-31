import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StreamTranslator, parseTestSummary } from '../src/translator.js';

test('test summaries from common runners are parsed', () => {
  const cases = {
    'Tests:       1 failed, 47 passed, 48 total': [47, 1], // jest / pest
    ' Tests  1 failed | 47 passed (48)': [47, 1], // vitest
    '===== 2 failed, 10 passed in 1.2s =====': [10, 2], // pytest
    '  47 passing (2s)\n  1 failing': [47, 1], // mocha
    'test result: ok. 48 passed; 0 failed; 0 ignored': [48, 0], // cargo
    'OK (48 tests, 120 assertions)': [48, 0], // phpunit
    'Tests: 48, Assertions: 120, Failures: 2.': [46, 2],
    'ℹ tests 5\nℹ pass 4\nℹ fail 1': [4, 1], // node --test
    '--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL': [1, 1], // go test
    'compiled successfully': null,
  };
  for (const [output, want] of Object.entries(cases)) {
    const got = parseTestSummary(output);
    assert.deepEqual(got && [got.passed, got.failed], want, output);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Records what the translator sends to the hub. */
function recorder() {
  const office = [];
  const chat = new Map();
  let n = 0;
  const translator = new StreamTranslator({
    office: (evt) => office.push(evt),
    chat: (msg) => {
      const id = `c${++n}`;
      chat.set(id, { ...msg });
      return id;
    },
    updateChat: (id, patch) => Object.assign(chat.get(id), patch),
  });
  return { translator, office, chat: () => [...chat.values()] };
}

const text = (id, t, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id, content: [{ type: 'text', text: t }] } });
const use = (id, name, input, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
const done = (id, content, isError = false, parent = null) => ({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const delta = (t) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });

test('streamed text grows one bubble, then the final block replaces it', async () => {
  const { translator, chat } = recorder();
  translator.handle({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } } });
  translator.handle(delta('Halo '));
  translator.handle(delta('dunia'));
  await sleep(120);
  assert.equal(chat()[0].text, 'Halo dunia');
  assert.equal(chat()[0].streaming, true);
  translator.handle(text('m1', 'Halo dunia.'));
  translator.handle(text('m1', 'Paragraf kedua.'));
  assert.equal(chat().length, 1);
  assert.equal(chat()[0].text, 'Halo dunia.\n\nParagraf kedua.');
  assert.equal(chat()[0].streaming, false);
});

test('tools carry input detail and output; failures are flagged', () => {
  const { translator, office, chat } = recorder();
  translator.handle(use('t1', 'Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }));
  translator.handle(done('t1', 'ok'));
  translator.handle(use('t2', 'Bash', { command: 'npm test' }));
  translator.handle(done('t2', '2 failing', true));
  const [edit, bash] = chat();
  assert.deepEqual(edit.input, { file: 'src/a.ts', old: 'x', new: 'y' });
  assert.equal(edit.status, 'ok');
  assert.equal(edit.output, 'ok');
  assert.equal(bash.role, 'qa');
  assert.equal(bash.status, 'fail');
  assert.deepEqual(office.map((e) => e.kind), ['tool_start', 'tool_end', 'tool_start', 'tool_fail', 'tests']);
  // The main thread edited src/a.ts (backend) before QA's run went red → the bug goes to backend.
  assert.deepEqual(office.at(-1), { kind: 'tests', role: 'qa', passed: 0, failed: 2, label: '2 test gagal', to: 'backend' });
});

test('subagent work is attributed to its role and its report is kept', () => {
  const { translator, office, chat } = recorder();
  translator.handle(use('a1', 'Agent', { subagent_type: 'qa', description: 'Test login', prompt: 'Uji login' }));
  translator.handle(use('q1', 'Bash', { command: 'ls' }, 'a1'));
  translator.handle(done('q1', 'ok', false, 'a1'));
  translator.handle(text('s1', 'Saya cek dulu.', 'a1'));
  translator.handle(done('a1', 'Laporan: semua lulus.'));
  const delegate = chat()[0];
  assert.equal(delegate.kind, 'delegate');
  assert.equal(delegate.status, 'ok');
  assert.equal(delegate.output, 'Laporan: semua lulus.');
  assert.equal(chat()[1].role, 'qa'); // the ls ran inside the qa subagent
  assert.ok(office.some((e) => e.kind === 'say' && e.role === 'qa'));
  assert.equal(office.at(-1).kind, 'agent_stop');
});

test('background agents stay active through the turn result', () => {
  const { translator, office } = recorder();
  translator.handle(use('a1', 'Agent', { subagent_type: 'devops', description: 'Build' }));
  translator.handle(done('a1', 'Async agent launched successfully.'));
  translator.handle({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(office.at(-1).activeRoles, ['devops']);
  translator.finishAgent('a1');
  assert.equal(office.at(-1).kind, 'agent_stop');
});

test('todo lists update the whiteboard; internal tools are hidden', () => {
  const { translator, office, chat } = recorder();
  translator.handle(use('t1', 'TodoWrite', { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }] }));
  translator.handle(use('h1', 'SubagentHandback', {}));
  assert.deepEqual(office.find((e) => e.kind === 'board').items, [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }]);
  assert.equal(chat().length, 1);
});

test('results report tokens; interrupted turns are a halt, not a celebration', () => {
  const { translator, office, chat } = recorder();
  translator.handle({ type: 'result', subtype: 'success', is_error: false, duration_ms: 2000, num_turns: 3, usage: { input_tokens: 5, cache_read_input_tokens: 995, output_tokens: 40 } });
  assert.deepEqual(chat()[0].meta, { durationMs: 2000, turns: 3, tokensIn: 1000, tokensOut: 40, costUsd: undefined, denials: 0 });
  assert.equal(office.at(-1).kind, 'stop');
  translator.handle({ type: 'result', subtype: 'interrupted', is_error: true, result: 'Dihentikan' });
  assert.equal(office.at(-1).kind, 'halt');
  assert.equal(chat()[1].ok, false);
});

test('nested delegation knows who delegated, and the report goes back to them', () => {
  const { translator, office, chat } = recorder();
  translator.handle(use('a1', 'Agent', { subagent_type: 'architect', description: 'Review' }));
  translator.handle(use('a2', 'Agent', { subagent_type: 'qa', description: 'Tes regresi' }, 'a1'));
  const delegations = office.filter((e) => e.kind === 'delegate');
  assert.deepEqual(delegations.map((e) => [e.from, e.role]), [['claude', 'architect'], ['architect', 'qa']]);
  assert.equal(chat()[1].from, 'architect');
  translator.handle(done('a2', 'Semua test lulus. Detail di bawah.', false, 'a1'));
  const stop = office.find((e) => e.kind === 'agent_stop');
  assert.equal(stop.role, 'qa');
  assert.equal(stop.from, 'architect');
  assert.equal(stop.report, 'Semua test lulus.');
});

test('generalist and unknown subagent types go to the freelancer, not backend', () => {
  const { translator, office } = recorder();
  translator.handle(use('g1', 'Agent', { subagent_type: 'general-purpose', description: 'Cari' }));
  translator.handle(use('g2', 'Agent', { subagent_type: 'debugger', description: 'Debug' }));
  translator.handle(use('g3', 'Read', { file_path: 'src/a.js' }, 'g2'));
  assert.deepEqual(office.filter((e) => e.kind === 'delegate').map((e) => e.role), ['freelancer', 'freelancer']);
  assert.equal(office.find((e) => e.kind === 'tool_start').role, 'freelancer');
});

test('failing tests are handed to the developer who last edited code; green runs are reported', () => {
  const { translator, office } = recorder();
  translator.handle(use('b1', 'Agent', { subagent_type: 'backend', description: 'API' }));
  translator.handle(use('b2', 'Edit', { file_path: 'src/api/auth.ts' }, 'b1'));
  translator.handle(done('b2', 'ok', false, 'b1'));
  translator.handle(done('b1', 'Selesai.'));
  translator.handle(use('q1', 'Agent', { subagent_type: 'qa', description: 'Tes' }));
  translator.handle(use('q2', 'Write', { file_path: 'tests/login.spec.ts' }, 'q1')); // QA's own test file: not a "builder"
  translator.handle(done('q2', 'ok', false, 'q1'));
  translator.handle(use('q3', 'Bash', { command: 'npm test' }, 'q1'));
  translator.handle(done('q3', 'Tests:       2 failed, 22 passed, 24 total', true, 'q1'));
  const red = office.find((e) => e.kind === 'tests');
  assert.deepEqual([red.role, red.passed, red.failed, red.to], ['qa', 22, 2, 'backend']);
  translator.handle(use('q4', 'Bash', { command: 'npm test' }, 'q1'));
  translator.handle(done('q4', 'ℹ tests 24\nℹ pass 24\nℹ fail 0', false, 'q1'));
  const green = office.filter((e) => e.kind === 'tests')[1];
  assert.deepEqual([green.passed, green.failed, green.to], [24, 0, undefined]);
  // Output of a non-test command is never read as a test summary.
  translator.handle(use('x1', 'Bash', { command: 'cat notes.txt' }));
  translator.handle(done('x1', '3 failed attempts'));
  assert.equal(office.filter((e) => e.kind === 'tests').length, 2);
});

test('plan mode gathers the planners', () => {
  const { translator, office } = recorder();
  translator.handle(use('p1', 'EnterPlanMode', {}));
  translator.handle(use('p2', 'ExitPlanMode', { plan: '1. a' }));
  assert.deepEqual(office.filter((e) => e.kind === 'huddle').map((e) => e.roles), [['pm', 'architect', 'ba'], ['pm', 'architect']]);
});

/** Like recorder(), plus the live status patches (todos, context). */
function statusRecorder() {
  const status = {};
  const chat = new Map();
  let n = 0;
  const translator = new StreamTranslator({
    office: () => {},
    chat: (msg) => {
      const id = `c${++n}`;
      chat.set(id, { ...msg });
      return id;
    },
    updateChat: (id, patch) => Object.assign(chat.get(id), patch),
    status: (patch) => Object.assign(status, patch),
  });
  return { translator, status, chat: () => [...chat.values()] };
}

test('thinking streams into a collapsible row; subagent thinking stays out of the chat', async () => {
  const { translator, chat } = statusRecorder();
  const thinkDelta = (t) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: t } } });
  translator.handle(thinkDelta('Cek dulu '));
  translator.handle(thinkDelta('file-nya.'));
  await sleep(120);
  assert.deepEqual(chat().map((m) => [m.kind, m.text, m.streaming]), [['thinking', 'Cek dulu file-nya.', true]]);
  translator.handle({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'thinking', thinking: 'Cek dulu file-nya. Final.' }] } });
  assert.deepEqual(chat().map((m) => [m.kind, m.text, m.streaming]), [['thinking', 'Cek dulu file-nya. Final.', false]]);
  translator.handle({ type: 'assistant', parent_tool_use_id: 'agent-1', message: { id: 'm2', content: [{ type: 'thinking', thinking: 'sub' }] } });
  translator.handle({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm3', content: [{ type: 'thinking', thinking: '' }] } }); // hidden thinking
  assert.equal(chat().length, 1);
});

test('todos and context usage are reported as live status', () => {
  const { translator, status } = statusRecorder();
  translator.handle({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000 }, content: [] },
  });
  assert.deepEqual(status.context, { used: 42010, window: null, autoCompactAt: null });
  translator.handle(use('t1', 'TodoWrite', { todos: [{ content: 'Tulis tes', activeForm: 'Menulis tes', status: 'in_progress' }, { content: 'Rapikan', status: 'pending' }] }));
  assert.deepEqual(status.todos.map((t) => [t.content, t.activeForm, t.status]), [['Tulis tes', 'Menulis tes', 'in_progress'], ['Rapikan', undefined, 'pending']]);
  translator.handle({ type: 'result', subtype: 'success', modelUsage: { 'claude-opus': { contextWindow: 1000000 }, 'claude-haiku': { contextWindow: 200000 } }, usage: {} });
  assert.deepEqual(status.context, { used: 42010, window: 1000000, autoCompactAt: null });
});

test('Claude Code system events: retries, compaction, title, background tasks, tool progress', () => {
  const { translator, status, chat } = statusRecorder();
  translator.handle({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 2000, error_status: 529 });
  translator.handle({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529 });
  assert.equal(chat().filter((m) => m.kind === 'info').length, 1, 'one retry line, updated in place');
  assert.match(chat()[0].text, /529 .*\(2\/10\) dalam 4 dtk/);
  translator.handle({ type: 'system', subtype: 'status', status: 'compacting' });
  assert.equal(status.compacting, true);
  translator.handle({ type: 'system', subtype: 'compact_boundary' });
  assert.equal(status.compacting, false);
  translator.handle({ type: 'system', subtype: 'session_title_changed', title: 'Perbaiki login' });
  assert.equal(status.title, 'Perbaiki login');
  translator.handle({ type: 'system', subtype: 'task_started', task_id: 'b1', description: 'npm run dev', is_backgrounded: true });
  translator.handle({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'npm run dev' }] });
  assert.deepEqual(status.tasks.map((t) => [t.id, t.kind, t.status, t.background]), [['b1', 'shell', 'running', true]]);
  translator.handle({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(status.tasks[0].status, 'completed', 'gone from the live set: finished');
  translator.handle({ type: 'system', subtype: 'local_command_output', content: 'Voice mode on' });
  assert.ok(chat().some((m) => m.kind === 'assistant' && m.text === 'Voice mode on'));
  translator.handle({ type: 'system', subtype: 'informational', level: 'info', content: 'transcript only' });
  assert.ok(!chat().some((m) => m.text === 'transcript only'), "'info' level shows only in the CLI's transcript mode");

  translator.handle(use('t9', 'Bash', { command: 'npm test' }));
  translator.handle({ type: 'tool_progress', tool_use_id: 't9', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 12 });
  assert.equal(chat().find((m) => m.kind === 'tool').elapsed, 12);
});

test('status.working counts open tools and running subagents per role (for an office rebuilt after a refresh)', () => {
  const statuses = [];
  const translator = new StreamTranslator({ office: () => {}, chat: () => 'c', updateChat: () => {}, status: (p) => p.working && statuses.push(p.working) });
  const last = () => statuses.at(-1);
  translator.handle(use('t1', 'Bash', { command: 'npm test' }));
  const role = Object.keys(last())[0];
  assert.equal(last()[role].tools, 1, 'a running tool is counted');
  assert.match(last()[role].label, /npm test/);
  translator.handle(use('a1', 'Agent', { subagent_type: 'qa', description: 'cek', prompt: 'cek', run_in_background: true }));
  assert.equal(last().qa.agents, 1, 'a delegated subagent is counted under its role');
  translator.handle(done('t1', 'ok'));
  assert.equal(last()[role]?.tools ?? 0, 0, 'tool finished');
  translator.handle(done('a1', 'Async agent launched successfully.'));
  assert.equal(last().qa.agents, 1, 'a background agent keeps working after its launch result');
  translator.handle({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, usage: {}, modelUsage: {} });
  assert.equal(last().qa.agents, 1, 'still at work after the turn ends');
  translator.finishAgent('a1');
  assert.deepEqual(last(), {}, 'nobody at work once it reports back');
});
