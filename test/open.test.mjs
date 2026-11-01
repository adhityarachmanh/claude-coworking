// "Buka di VS Code / folder": commands are built per platform and never go through a shell.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findVsCode, openCommand } from '../src/open.js';

test('folders open in the platform file manager', () => {
  assert.deepEqual(openCommand('folder', 'C:\\p\\toko', { platform: 'win32' }), { command: 'explorer.exe', args: ['C:\\p\\toko'] });
  assert.deepEqual(openCommand('folder', '/p/toko', { platform: 'darwin' }), { command: 'open', args: ['/p/toko'] });
  assert.deepEqual(openCommand('folder', '/p/toko', { platform: 'linux' }), { command: 'xdg-open', args: ['/p/toko'] });
});

test('VS Code: Code.exe found per user, OFFICE_EDITOR wins, missing → null', () => {
  const local = mkdtempSync(path.join(tmpdir(), 'vscode-'));
  const exe = path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe');
  assert.equal(findVsCode({ LOCALAPPDATA: local }, 'win32'), null, 'not installed');
  assert.equal(openCommand('code', 'C:\\p', { platform: 'win32', env: { LOCALAPPDATA: local } }), null);

  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, '');
  assert.equal(findVsCode({ LOCALAPPDATA: local }, 'win32'), exe);
  // the project folder plus, optionally, one file inside it — as separate arguments
  assert.deepEqual(openCommand('code', 'C:\\p', { platform: 'win32', env: { LOCALAPPDATA: local }, file: 'C:\\p\\a b.ts' }), { command: exe, args: ['C:\\p', 'C:\\p\\a b.ts'] });
  // …at a line (`-g file:line`); anything but a positive integer line is ignored
  assert.deepEqual(openCommand('code', 'C:\\p', { platform: 'win32', env: { LOCALAPPDATA: local }, file: 'C:\\p\\a.ts', line: 12 }).args, ['C:\\p', '-g', 'C:\\p\\a.ts:12']);
  assert.deepEqual(openCommand('code', 'C:\\p', { platform: 'win32', env: { LOCALAPPDATA: local }, file: 'C:\\p\\a.ts', line: '12; rm' }).args, ['C:\\p', 'C:\\p\\a.ts']);
  assert.equal(findVsCode({ LOCALAPPDATA: local, OFFICE_EDITOR: 'D:\\Cursor\\Cursor.exe' }, 'win32'), 'D:\\Cursor\\Cursor.exe');
  assert.equal(findVsCode({}, 'linux'), 'code');
});
