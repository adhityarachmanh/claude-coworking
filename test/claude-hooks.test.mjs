// Claude Code hooks (src/claude-admin.js): write/delete `hooks` in the settings files. Pure file IO in a throwaway
// project/home, no Claude process.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deleteHook, HookError, listHooks, saveHook } from '../src/claude-admin.js';

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

  saveHook({ projectPath: project, userDir, scope: 'project', event: 'PreToolUse', matcher: 'Edit', command: 'npm run lint', timeout: 30 });
  let data = readJson(file);
  assert.deepEqual(data.permissions, { allow: ['Read'] });
  assert.equal(data.outputStyle, 'Concise');
  const group = data.hooks.PreToolUse[0];
  assert.equal(group.matcher, 'Edit');
  assert.deepEqual(group.hooks, [{ type: 'command', command: 'npm run lint', timeout: 30 }]);

  // Same event+matcher with a different command adds another handler; the old one stays.
  saveHook({ projectPath: project, userDir, scope: 'project', event: 'PreToolUse', matcher: 'Edit', command: 'npm run test' });
  data = readJson(file);
  assert.equal(data.hooks.PreToolUse.length, 1);
  assert.deepEqual(data.hooks.PreToolUse[0].hooks.map((h) => h.command), ['npm run lint', 'npm run test']);

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

test('saveHook: hanya command yang cocok diganti; handler lain dan timeout dipertahankan', () => {
  const project = tmp();
  const userDir = tmp();
  const file = path.join(project, '.claude', 'settings.json');
  write(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [
    { type: 'command', command: 'lint', timeout: 30, note: 'x' },
    { type: 'command', command: 'audit' },
    { type: 'http', url: 'https://contoh.test/hook' },
  ] }] } }));
  saveHook({ projectPath: project, userDir, scope: 'project', event: 'PreToolUse', matcher: 'Edit', command: 'lint', timeout: 45 });
  const handlers = readJson(file).hooks.PreToolUse[0].hooks;
  assert.equal(handlers.length, 3, 'handler lain tidak hilang');
  assert.deepEqual(handlers[0], { type: 'command', command: 'lint', timeout: 45, note: 'x' });
  assert.equal(handlers[1].command, 'audit');
  assert.equal(handlers[2].type, 'http');
});

test('listHooks: handler non-command ditandai, timeout ikut, matcher kosong round-trip', () => {
  const project = tmp();
  const userDir = tmp();
  const file = path.join(project, '.claude', 'settings.json');
  write(file, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [
    { type: 'command', command: 'lint', timeout: 30 },
    { type: 'http', url: 'https://contoh.test/h' },
  ] }] } }));
  const listed = listHooks(project, userDir);
  assert.equal(listed[0].scope, 'project');
  assert.equal(listed[0].matcher, '');
  assert.deepEqual(listed[0].handlers[0], { type: 'command', command: 'lint', timeout: 30 });
  assert.equal(listed[0].handlers[1].type, 'http');
  saveHook({ projectPath: project, userDir, scope: 'project', event: 'PreToolUse', matcher: '', command: 'baru' });
  assert.equal(readJson(file).hooks.PreToolUse.length, 1, 'matcher kosong memakai grup yang sama');
  assert.equal(readJson(file).hooks.PreToolUse[0].hooks.length, 3);
});

test('saveHook: event tak dikenal dan hooks[event] bukan array ditolak 400', () => {
  const project = tmp();
  const userDir = tmp();
  assert.throws(() => saveHook({ projectPath: project, userDir, scope: 'project', event: 'BukanEvent', command: 'x' }), (e) => e.status === 400);
  const file = path.join(project, '.claude', 'settings.json');
  write(file, JSON.stringify({ hooks: { PreToolUse: { broken: true } } }));
  assert.throws(() => saveHook({ projectPath: project, userDir, scope: 'project', event: 'PreToolUse', command: 'x' }), (e) => e.status === 400);
});
