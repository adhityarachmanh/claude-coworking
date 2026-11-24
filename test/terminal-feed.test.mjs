// 💻 Mode Terminal: the chat timeline → one terminal panel per role (public/js/core/terminal-feed.js). Pure logic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalFeed } from '../public/js/core/terminal-feed.js';

const texts = (panel) => panel.lines.map((l) => l.text);
const tones = (panel) => panel.lines.map((l) => l.tone);

test('every line comes from the real chat rows, on the panel of the role that did it', () => {
  const chat = [
    { id: 'u1', kind: 'user', text: 'tambahkan validasi email\ndan test-nya' },
    { id: 'a1', kind: 'assistant', text: 'Baik. Saya pecah jadi dua tugas.\nDetail…' },
    { id: 'd1', kind: 'delegate', role: 'backend', from: 'claude', text: 'Validasi email di API', status: 'ok' },
    { id: 't1', kind: 'tool', role: 'backend', tool: 'Edit', text: 'Mengedit user.js', status: 'ok', input: { file: 'src/routes/user.js', old: 'const ok = true;', new: 'const ok = isEmail(body.email);\nif (!ok) return 400;' } },
    { id: 't2', kind: 'tool', role: 'qa', tool: 'Bash', text: 'Menjalankan test', status: 'fail', input: { command: 'npm test' }, output: 'ok 1 - a\nnot ok 2 - email\n\n# fail 1' },
  ];
  const feed = terminalFeed(chat, { coordinator: 'pm' });
  assert.deepEqual(texts(feed.get('claude')), ['> tambahkan validasi email']);
  // the PM speaks for the team and hands the Lead's work out
  assert.deepEqual(texts(feed.get('pm')), ['» Baik. Saya pecah jadi dua tugas.', '⇢ backend: Validasi email di API']);
  const be = feed.get('backend');
  assert.deepEqual(texts(be), ['⇠ PM: Validasi email di API', '✎ edit user.js', '- const ok = true;', '+ const ok = isEmail(body.email);', '+ if (!ok) return 400;', '✔ laporan ke PM']);
  assert.deepEqual(tones(be).slice(1, 5), ['cmd', 'del', 'add', 'add']);
  const qa = feed.get('qa');
  assert.deepEqual(texts(qa), ['$ npm test', 'ok 1 - a', 'not ok 2 - email', '# fail 1', '✖ gagal']);
  assert.equal(qa.lines.at(-1).tone, 'err');
  assert.equal(feed.has('dba'), false, 'a role that did nothing has no panel');
});

test('without a PM the Lead coordinates; running shells show their live output; approvals and boards', () => {
  const chat = [
    { id: 'a1', kind: 'assistant', text: 'Oke.' },
    { id: 'd1', kind: 'delegate', role: 'devops', from: 'claude', text: 'Deploy', status: 'running' },
    { id: 't1', kind: 'tool', role: 'devops', tool: 'Bash', text: 'Build', status: 'running', taskId: 'oc:sh_1', input: { command: 'npm run build' } },
    { id: 'p1', kind: 'approval', role: 'devops', text: 'Menjalankan git push', status: 'pending' },
    { id: 't2', kind: 'tool', role: 'claude', tool: 'TodoWrite', text: 'Update papan', status: 'ok', input: { todos: [{ content: 'Build', status: 'completed' }, { content: 'Deploy', status: 'in_progress' }, { content: 'Cek', status: 'pending' }] } },
  ];
  const live = (msg) => (msg.taskId === 'oc:sh_1' ? 'step 1\nstep 2\nstep 3\nstep 4\nstep 5' : '');
  const feed = terminalFeed(chat, { coordinator: 'claude', live });
  assert.deepEqual(texts(feed.get('claude')), ['» Oke.', '⇢ devops: Deploy', '⊞ papan task diperbarui (3)']);
  assert.deepEqual(feed.get('claude').board, [{ text: 'Build', status: 'completed' }, { text: 'Deploy', status: 'in_progress' }, { text: 'Cek', status: 'pending' }]);
  const ops = feed.get('devops');
  assert.deepEqual(texts(ops), ['⇠ Lead: Deploy', '$ npm run build', 'step 2', 'step 3', 'step 4', 'step 5', '⚠ ACCESS REQUEST ▸ Menjalankan git push']);
  assert.equal(ops.state, 'ask');
  assert.equal(ops.lines.at(-1).tone, 'warn');
});

test('states, test counts, line cap and ordering', () => {
  const chat = [
    { id: 'u1', kind: 'user', text: 'go' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, kind: 'tool', role: 'ba', tool: 'Read', text: 'Membaca', status: 'ok', input: { file: `docs/f${i}.md` } })),
    { id: 'g1', kind: 'tool', role: 'architect', tool: 'Grep', text: 'Cari', status: 'running', input: { pattern: 'TODO', path: 'src' } },
    { id: 'x1', kind: 'tool', role: 'security', tool: 'Bash', text: 'Audit', status: 'denied', input: { command: 'npm audit' } },
  ];
  const events = [{ kind: 'tests', role: 'qa', passed: 41, failed: 1 }, { kind: 'tests', role: 'qa', passed: 42, failed: 0 }];
  const feed = terminalFeed(chat, { coordinator: 'pm', maxLines: 10, events });
  assert.equal(feed.get('ba').lines.length, 10, 'only the newest lines are kept');
  assert.equal(feed.get('ba').lines.at(-1).text, 'cat f29.md');
  assert.equal(feed.get('architect').state, 'busy');
  assert.deepEqual(texts(feed.get('architect')), ['grep "TODO" src']);
  assert.equal(feed.get('security').lines.at(-1).text, '⛔ ditolak');
  assert.deepEqual(feed.get('qa').tests, { passed: 42, failed: 0 }, 'the latest test run, even without a row of its own');
  assert.equal(feed.get('ba').state, 'idle');
  // Lead first, then the coordinator, then the most recent activity first
  assert.deepEqual([...feed.keys()], ['claude', 'pm', 'security', 'architect', 'ba', 'qa']);
});

test('untrusted text is kept as plain text: no control characters, clipped lines', () => {
  const chat = [{ id: 't1', kind: 'tool', role: 'backend', tool: 'Bash', text: 'x', status: 'ok', input: { command: `echo ${'a'.repeat(400)}\u001b[31m` }, output: '\u0007bell\r\nok' }];
  const lines = texts(terminalFeed(chat).get('backend'));
  assert.ok(lines[0].length <= 140 && !/[\u0000-\u001f]/.test(lines.join('')));
  assert.deepEqual(lines.slice(1), ['bell', 'ok']);
});
