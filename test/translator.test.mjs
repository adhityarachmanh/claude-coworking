import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StreamTranslator } from '../src/translator.js';

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
  assert.deepEqual(office.map((e) => e.kind), ['tool_start', 'tool_end', 'tool_start', 'tool_fail']);
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
