// Claude Code hooks (src/claude-admin.js): write/delete `hooks` in the settings files. Pure file IO in a throwaway
// project/home, no Claude process.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deleteHook, HookError, saveHook } from '../src/claude-admin.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'office-hooks-'));
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('saveHook: menambah/mengganti hook tanpa menyentuh kunci lain; timeout; event dengan matcher', () => {
  const project = tmp();
  const userDir = tmp();
  const file = path.join(project, '.claude', 'settings.json');
  write(file, JSON.stringify({ permissions: { allow: ['Read'] }, outputStyle: 'Concise' }));

  saveHook({ projectPath: project, userDir, scope: 'project', event: 'PreToolUse', matcher: 'Edit', command: 'npm run lint', timeout: 30000 });
  let data = readJson(file);
  assert.deepEqual(data.permissions, { allow: ['Read'] });
  assert.equal(data.outputStyle, 'Concise');
  const group = data.hooks.PreToolUse[0];
  assert.equal(group.matcher, 'Edit');
  assert.deepEqual(group.hooks, [{ type: 'command', command: 'npm run lint', timeout: 30000 }]);

  // Same event+matcher replaces the command; other keys survive.
  saveHook({ projectPath: project, userDir, scope: 'project', event: 'PreToolUse', matcher: 'Edit', command: 'npm run test' });
  data = readJson(file);
  assert.equal(data.hooks.PreToolUse.length, 1);
  assert.equal(data.hooks.PreToolUse[0].hooks[0].command, 'npm run test');

  saveHook({ projectPath: project, userDir, scope: 'project', event: 'UserPromptSubmit', command: 'echo hi' });
  data = readJson(file);
  assert.equal(data.hooks.UserPromptSubmit[0].matcher, undefined);
  assert.deepEqual(data.hooks.UserPromptSubmit[0].hooks[0], { type: 'command', command: 'echo hi' });
});

test('deleteHook: membuang command yang cocok, group kosong dihapus, 404 bila tak ada', () => {
  const project = tmp();
  const userDir = tmp();
  const file = path.join(project, '.claude', 'settings.json');
  write(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }, { type: 'command', command: 'echo other' }] }] } }));

  deleteHook({ projectPath: project, userDir, scope: 'project', event: 'PreToolUse', matcher: 'Edit', command: 'npm run lint' });
  const data = readJson(file);
  assert.deepEqual(data.hooks.PreToolUse[0].hooks, [{ type: 'command', command: 'echo other' }]);
  deleteHook({ projectPath: project, userDir, scope: 'project', event: 'PreToolUse', matcher: 'Edit', command: 'echo other' });
  assert.equal(readJson(file).hooks?.PreToolUse, undefined, 'event kosong dibuang');
  assert.throws(() => deleteHook({ projectPath: project, userDir, scope: 'project', event: 'PreToolUse', matcher: 'Edit', command: 'x' }), (e) => e instanceof HookError && e.status === 404);
});

test('saveHook: validasi event/matcher/command/timeout; file rusak ditolak 409', () => {
  const project = tmp();
  const userDir = tmp();
  for (const bad of [
    { event: 'Bad Event', command: 'x' },
    { event: 'PreToolUse', command: '' },
    { event: 'PreToolUse', command: 'x', timeout: -1 },
    { event: 'PreToolUse', command: 'x', timeout: 1.5 },
    { event: 'PreToolUse', matcher: 'a\nb', command: 'x' },
    { event: 'PreToolUse', command: 'x'.repeat(2001) },
  ]) {
    assert.throws(() => saveHook({ projectPath: project, userDir, scope: 'project', ...bad }), (e) => e instanceof HookError && e.status === 400, JSON.stringify(bad));
  }
  const file = path.join(project, '.claude', 'settings.json');
  write(file, '{rusak');
  assert.throws(() => saveHook({ projectPath: project, userDir, scope: 'project', event: 'PreToolUse', command: 'x' }), (e) => e instanceof HookError && e.status === 409);
  assert.equal(readFileSync(file, 'utf8'), '{rusak', 'file rusak tidak ditimpa');
});
