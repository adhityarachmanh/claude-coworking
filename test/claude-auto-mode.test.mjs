// Claude auto mode (src/claude-admin.js): the classifier's user-level rules in ~/.claude/settings.json.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readAutoMode, saveAutoMode } from '../src/claude-admin.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'office-am-'));

test('auto mode: baca/simpan mempertahankan kunci lain, $defaults, dan menghapus saat kosong', () => {
  const userDir = tmp();
  const file = path.join(userDir, 'settings.json');
  writeFileSync(file, JSON.stringify({ permissions: { allow: ['Read'] }, env: { A: '1' } }));
  const saved = saveAutoMode({ userDir, environment: ['$defaults', 'Source control: github.example.com/acme'], allow: [], softDeny: ['Never force-push'], hardDeny: [], classifyAllShell: true });
  assert.deepEqual(saved.environment, ['$defaults', 'Source control: github.example.com/acme']);
  assert.deepEqual(saved.softDeny, ['Never force-push']);
  assert.equal(saved.classifyAllShell, true);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(data.permissions, { allow: ['Read'] }, 'kunci lain aman');
  assert.equal(data.env.A, '1');
  saveAutoMode({ userDir, environment: [], allow: [], softDeny: [], hardDeny: [], classifyAllShell: false });
  assert.equal('autoMode' in JSON.parse(readFileSync(file, 'utf8')), false, 'autoMode kosong dibuang');
});

test('auto mode: validasi daftar dan file rusak', () => {
  const userDir = tmp();
  assert.throws(() => saveAutoMode({ userDir, environment: 'x' }), (e) => e.status === 400);
  assert.throws(() => saveAutoMode({ userDir, allow: ['a\nb'] }), (e) => e.status === 400);
  assert.throws(() => saveAutoMode({ userDir, softDeny: ['x'.repeat(501)] }), (e) => e.status === 400);
  writeFileSync(path.join(userDir, 'settings.json'), '{rusak');
  assert.throws(() => readAutoMode(userDir), (e) => e.status === 409);
  assert.throws(() => saveAutoMode({ userDir, environment: [] }), (e) => e.status === 409);
});
