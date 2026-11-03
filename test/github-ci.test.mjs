// ✅ GitHub checks after a push (src/github-ci.js): the watcher's states and chat lines, with a stubbed check.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiWatcher } from '../src/github-ci.js';
import { StreamTranslator } from '../src/translator.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function hub() {
  const h = { statuses: [], chats: [], projects: new Map([['p1', { id: 'p1', path: 'C:/p' }]]) };
  h.setStatus = (id, s) => h.statuses.push(s);
  h.chat = (id, m) => h.chats.push(m);
  return h;
}

test('follows the pushed commit until its runs finish; one chat line for the result', async () => {
  const h = hub();
  const answers = [
    { state: 'pending', runs: [] },
    { state: 'running', runs: [{ name: 'test', status: 'in_progress', conclusion: '' }] },
    { state: 'failure', runs: [{ name: 'test', status: 'completed', conclusion: 'failure', url: 'https://github.com/o/r/actions/runs/1' }], url: 'https://github.com/o/r/actions/runs/1' },
  ];
  const w = new CiWatcher({ hub: h, gh: 'gh', check: async () => answers.shift() ?? { state: 'success', runs: [] }, pollMs: 5, firstMs: 5 });
  assert.equal(w.watch('p1'), true);
  assert.equal(h.statuses[0].ci.state, 'pending');
  await wait(80);
  assert.deepEqual(h.statuses.map((s) => s.ci.state), ['pending', 'pending', 'running', 'failure']);
  assert.equal(h.chats.length, 1);
  assert.match(h.chats[0].text, /CI GitHub gagal: test \(failure\) — https:\/\/github\.com\/o\/r\/actions\/runs\/1/);
  assert.equal(w.watching.size, 0);
  assert.equal(new CiWatcher({ hub: h, gh: null }).watch('p1'), false, 'no gh: nothing to follow');
});

test('not logged in to gh: said once', async () => {
  const h = hub();
  const w = new CiWatcher({ hub: h, gh: 'gh', check: async () => ({ state: 'login', runs: [] }), pollMs: 5, firstMs: 5 });
  w.watch('p1');
  await wait(30);
  w.watch('p1');
  await wait(30);
  assert.equal(h.chats.filter((c) => /login GitHub/.test(c.text)).length, 1);
});

test('a `git push` the team ran (and only a successful one) starts the watch', () => {
  let pushed = 0;
  const t = new StreamTranslator({ office() {}, chat: () => 'c', updateChat() {}, status() {}, gitPushed: () => pushed++ });
  const run = (id, command, isError = false) => {
    t.handle({ type: 'assistant', message: { id: `m${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    t.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done', is_error: isError }] } });
  };
  run('a', 'git add -A && git commit -m x && git push');
  run('b', 'git push origin main', true);
  run('c', 'npm test');
  assert.equal(pushed, 1);
});
