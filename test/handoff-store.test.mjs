// Cross-source continuation (src/handoff.js + src/handoff-store.js): the persisted brief that lets work started in
// one source be continued in the other. Pure logic and file I/O only — no model call, no git.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildBrief } from '../src/handoff.js';
import { HandoffStore } from '../src/handoff-store.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'adhitron-handoff-'));

const CHAT = [
  { kind: 'user', text: 'Perbaiki login di public/js/features/auth.js, lalu jalankan test.' },
  { kind: 'assistant', text: 'Sudah saya ubah. Berikutnya: perbarui docs/FITUR.md.' },
  { kind: 'tool', tool: 'Edit', text: 'Edit auth.js', input: { file_path: 'C:/repo/public/js/features/auth.js' } },
  { kind: 'tool', tool: 'Bash', text: 'Bash: npm test', input: { command: 'npm run test:related -- public/js/features/auth.js' } },
  { kind: 'assistant', text: '- [ ] Perbarui test UI\n- [ ] Cek di HP' },
];

test('buildBrief carries talk, files, commands and open TODOs, and reports their counts', () => {
  const { note, stats, brief } = buildBrief(CHAT, 'claude');
  assert.equal(stats.messages, 3, 'only user + assistant rows count as talk');
  assert.ok(brief.files.includes('C:/repo/public/js/features/auth.js'));
  assert.ok(brief.files.some((f) => f === 'public/js/features/auth.js'), 'paths mentioned in the talk are picked up too');
  assert.ok(brief.commands.includes('npm run test:related -- public/js/features/auth.js'));
  assert.ok(brief.todos.some((t) => t.includes('Perbarui test UI')));
  assert.match(note, /Konteks dari Claude Code/);
  assert.match(note, /## File yang disentuh/);
  assert.match(note, /## Perintah yang dijalankan/);
  assert.match(note, /## TODO yang masih terbuka/);
  assert.ok(note.length <= 20_000, 'the note stays within its cap');
});

test('buildBrief masks secrets and never includes thinking or raw tool payloads', () => {
  const { note } = buildBrief(
    [
      { kind: 'user', text: 'pakai token sk-abcdefgh12345678' },
      { kind: 'thinking', text: 'rahasia proses berpikir' },
      { kind: 'tool', tool: 'Edit', text: 'Edit a.js', input: { file_path: 'a.js', content: 'ISI FILE PENUH' } },
    ],
    'opencode',
  );
  assert.doesNotMatch(note, /sk-abcdefgh12345678/);
  assert.doesNotMatch(note, /rahasia proses berpikir/);
  assert.doesNotMatch(note, /ISI FILE PENUH/);
});

test('buildBrief on an empty chat is empty (no note, zero counts)', () => {
  assert.deepEqual(buildBrief([], 'claude'), { note: '', stats: { messages: 0, files: 0, commands: 0, todos: 0 }, brief: { files: [], commands: [], todos: [] } });
});

test('HandoffStore: write, read and take-once; a taken brief is gone', () => {
  const dir = tmp();
  try {
    const store = new HandoffStore(dir);
    const written = store.write('proj-1', { from: 'claude', to: 'opencode', note: 'ringkasan', stats: { messages: 2, files: 1, commands: 0, todos: 0 }, brief: { files: ['a.js'], commands: [], todos: [] } });
    assert.equal(written?.to, 'opencode');
    assert.equal(store.read('proj-1')?.note, 'ringkasan');
    // Reading never consumes: a restart between the switch and the next prompt finds the same brief.
    assert.equal(store.read('proj-1')?.note, 'ringkasan', 'read is non-destructive');
    const taken = store.take('proj-1');
    assert.equal(taken?.from, 'claude');
    assert.equal(store.read('proj-1'), null, 'consumed once');
    assert.equal(store.take('proj-1'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HandoffStore: a corrupt, foreign or empty file degrades to no brief', () => {
  const dir = tmp();
  try {
    const store = new HandoffStore(dir);
    assert.equal(store.read('proj-2'), null, 'missing file');
    writeFileSync(path.join(dir, 'proj-2.json'), '{not json', 'utf8');
    assert.equal(store.read('proj-2'), null);
    writeFileSync(path.join(dir, 'proj-2.json'), JSON.stringify({ version: 99, from: 'claude', to: 'opencode', note: 'x' }), 'utf8');
    assert.equal(store.read('proj-2'), null, 'a version this app does not write');
    assert.equal(store.write('proj-2', { from: 'claude', to: 'opencode', note: '   ' }), null, 'an empty note is not stored');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HandoffStore: a project id that could escape the folder is refused', () => {
  const dir = tmp();
  try {
    const store = new HandoffStore(dir);
    assert.equal(store.file('../../evil'), null);
    assert.equal(store.write('../evil', { from: 'claude', to: 'opencode', note: 'x' }), null);
    assert.equal(store.take('../evil'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
