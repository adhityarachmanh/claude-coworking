// OpenCode slash commands (.opencode/commands + the global config folder): list/read/save/delete with backups.
// No OpenCode process: this only reads and writes the user's own Markdown files.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CommandError, deleteCommand, listCommands, parseCommandFile, readCommand, saveCommand } from '../src/opencode-commands.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const envFor = (home) => ({ OFFICE_OPENCODE_CONFIG_HOME: home });

test('listCommands: project menang atas global, nested id, legacy dibaca, frontmatter terurai', () => {
  const project = tmp('oc-p-');
  const home = tmp('oc-h-');
  write(path.join(project, '.opencode', 'commands', 'review.md'), '---\ndescription: Review PR\nagent: build\nmodel: openai/gpt-5#high\nsubagent: true\n---\n\nReview $ARGUMENTS\n');
  write(path.join(project, '.opencode', 'commands', 'team', 'deploy.md'), '---\ndescription: Deploy\n---\n\ndeploy\n');
  write(path.join(project, '.opencode', 'command', 'lama.md'), '---\ndescription: Lama\n---\nlama\n');
  write(path.join(home, 'opencode', 'commands', 'review.md'), '---\ndescription: global\n---\nglobal\n');
  const list = listCommands({ projectPath: project, env: envFor(home) });
  assert.deepEqual(list.map((c) => c.id), ['lama', 'review', 'team/deploy']);
  assert.equal(list.find((c) => c.id === 'review').description, 'Review PR');
  assert.equal(list.find((c) => c.id === 'review').scope, 'project');
  assert.equal(list.find((c) => c.id === 'team/deploy').source, '.opencode/commands (project)');
  assert.equal(list.find((c) => c.id === 'lama').source, '.opencode/command (project, lama)');
  assert.equal(list.find((c) => c.id === 'review').subagent, true);
  assert.equal(parseCommandFile('tanpa frontmatter').template, 'tanpa frontmatter');
});

test('save/read/delete: frontmatter ditulis, backup, mtime, dan id tidak boleh keluar folder', () => {
  const project = tmp('oc-s-');
  const home = tmp('oc-sh-');
  const dataDir = tmp('oc-sd-');
  const base = { projectPath: project, env: envFor(home), dataDir, scope: 'project', source: '.opencode/commands (project)' };
  const saved = saveCommand({ ...base, id: 'review', description: 'Review PR', agent: 'build', model: 'openai/gpt-5#high', subagent: true, template: 'Review $ARGUMENTS\n' });
  assert.equal(saved.command.id, 'review');
  const file = path.join(project, '.opencode', 'commands', 'review.md');
  assert.match(readFileSync(file, 'utf8'), /^---\ndescription: "Review PR"\nagent: "build"\nmodel: "openai\/gpt-5#high"\nsubagent: true\n---\n\nReview \$ARGUMENTS\n$/);
  const read = readCommand({ ...base, id: 'review' });
  assert.equal(read.template, 'Review $ARGUMENTS\n');
  assert.equal(read.subagent, true);
  const again = saveCommand({ ...base, previous: 'review', id: 'review', description: 'Baru', agent: '', model: '', subagent: false, template: 'x\n', mtime: read.mtime });
  assert.ok(again.backedUp);
  assert.equal(readFileSync(file, 'utf8').includes('subagent:'), false, 'subagent false removes the key');
  const removed = deleteCommand({ ...base, id: 'review' });
  assert.ok(removed.backedUp);
  assert.equal(existsSync(file), false);
  for (const id of ['', '../evil', 'a//b', '/abs', 'a\\b', '..']) {
    assert.throws(() => saveCommand({ ...base, id, description: '', agent: '', model: '', subagent: false, template: 'x' }), (e) => e instanceof CommandError && e.status === 400, id);
  }
  if (process.platform === 'win32') {
    assert.throws(() => saveCommand({ ...base, id: 'nul', description: '', agent: '', model: '', subagent: false, template: 'x' }), (e) => e.status === 400, 'Windows device name');
  }
});

test('saveCommand: rename memindahkan berkas, nama ganda 409, mtime basi 409, frontmatter asing dipertahankan', () => {
  const project = tmp('oc-r-');
  const home = tmp('oc-rh-');
  const dataDir = tmp('oc-rd-');
  const base = { projectPath: project, env: envFor(home), dataDir, scope: 'project', source: '.opencode/commands (project)' };
  write(path.join(project, '.opencode', 'commands', 'lama.md'), '---\ndescription: Lama\nmetadata:\n  owner: saya\n---\n\nisi\n');
  const before = readCommand({ ...base, id: 'lama' });
  assert.equal(before.front.includes('metadata:'), true);
  const moved = saveCommand({ ...base, previous: 'lama', id: 'baru', description: 'Baru', agent: '', model: '', subagent: null, template: 'isi baru\n', mtime: before.mtime });
  assert.equal(moved.command.id, 'baru');
  assert.equal(existsSync(path.join(project, '.opencode', 'commands', 'lama.md')), false);
  const text = readFileSync(path.join(project, '.opencode', 'commands', 'baru.md'), 'utf8');
  assert.match(text, /metadata:\n {2}owner: saya/);
  write(path.join(project, '.opencode', 'commands', 'berebut.md'), '---\ndescription: Lain\n---\nx\n');
  assert.throws(() => saveCommand({ ...base, id: 'berebut', previous: 'baru', description: '', agent: '', model: '', subagent: null, template: 'x', mtime: readCommand({ ...base, id: 'baru' }).mtime }), (e) => e.status === 409);
  assert.throws(() => saveCommand({ ...base, id: 'baru', description: '', agent: '', model: '', subagent: null, template: 'x', mtime: 1 }), (e) => e.status === 409);
});

test('command bersarang: create, read, edit, rename, delete dan folder kosong dibersihkan', () => {
  const project = tmp('oc-n-');
  const home = tmp('oc-nh-');
  const dataDir = tmp('oc-nd-');
  const base = { projectPath: project, env: envFor(home), dataDir, scope: 'project', source: '.opencode/commands (project)' };
  const created = saveCommand({ ...base, id: 'team/deploy', description: 'Deploy', agent: '', model: '', subagent: false, template: 'deploy\n' });
  assert.equal(created.command.id, 'team/deploy');
  assert.equal(readCommand({ ...base, id: 'team/deploy' }).template, 'deploy\n');
  const edited = saveCommand({ ...base, previous: 'team/deploy', id: 'team/deploy', description: 'Deploy baru', agent: 'build', model: '', subagent: true, template: 'deploy ulang\n', mtime: readCommand({ ...base, id: 'team/deploy' }).mtime });
  assert.equal(edited.command.description, 'Deploy baru');
  const renamed = saveCommand({ ...base, previous: 'team/deploy', id: 'team/review', description: 'Deploy baru', agent: '', model: '', subagent: false, template: 'x\n', mtime: readCommand({ ...base, id: 'team/deploy' }).mtime });
  assert.equal(renamed.command.id, 'team/review');
  assert.equal(existsSync(path.join(project, '.opencode', 'commands', 'team', 'deploy.md')), false);
  assert.ok(existsSync(path.join(project, '.opencode', 'commands', 'team', 'review.md')));
  deleteCommand({ ...base, id: 'team/review' });
  assert.equal(existsSync(path.join(project, '.opencode', 'commands', 'team')), false, 'folder kosong ikut dibersihkan');
});

test('frontmatter: titik dua/#/kutip di-escape, BOM dibaca, subtask lama dihormati', () => {
  const project = tmp('oc-y-');
  const home = tmp('oc-yh-');
  const dataDir = tmp('oc-yd-');
  const base = { projectPath: project, env: envFor(home), dataDir, scope: 'project', source: '.opencode/commands (project)' };
  const description = 'Review kode: backend #123 "kutip"';
  saveCommand({ ...base, id: 'review', description, agent: 'build', model: 'openai/gpt-5#high', subagent: false, template: 'x\n' });
  const back = readCommand({ ...base, id: 'review' });
  assert.equal(back.description, description);
  assert.equal(back.agent, 'build');
  assert.equal(back.model, 'openai/gpt-5#high');
  write(path.join(project, '.opencode', 'commands', 'bom.md'), '\uFEFF\n---\ndescription: "Bom"\n---\n\nisi asli\n');
  const bom = readCommand({ ...base, id: 'bom' });
  assert.equal(bom.description, 'Bom');
  assert.equal(bom.template, 'isi asli\n');
  write(path.join(project, '.opencode', 'commands', 'lama.md'), '---\nsubtask: true\n---\nlama\n');
  assert.equal(listCommands({ projectPath: project, env: envFor(home) }).find((command) => command.id === 'lama').subagent, true);
});

test('delete: mtime basi 409; folder command berupa symlink ditolak', (t) => {
  const project = tmp('oc-d-');
  const home = tmp('oc-dh-');
  const dataDir = tmp('oc-dd-');
  const base = { projectPath: project, env: envFor(home), dataDir, scope: 'project', source: '.opencode/commands (project)' };
  saveCommand({ ...base, id: 'hapus', description: '', agent: '', model: '', subagent: false, template: 'x\n' });
  assert.throws(() => deleteCommand({ ...base, id: 'hapus', mtime: 1 }), (e) => e.status === 409);
  assert.ok(existsSync(path.join(project, '.opencode', 'commands', 'hapus.md')));

  const linked = tmp('oc-dl-');
  const outside = tmp('oc-out-');
  mkdirSync(path.join(linked, '.opencode'), { recursive: true });
  try {
    symlinkSync(outside, path.join(linked, '.opencode', 'commands'), 'junction');
  } catch {
    return t.skip('no privilege for symlinks here');
  }
  const linkedBase = { ...base, projectPath: linked };
  assert.throws(() => saveCommand({ ...linkedBase, id: 'x', description: '', agent: '', model: '', subagent: false, template: 'x' }), (e) => e.status === 409);
});