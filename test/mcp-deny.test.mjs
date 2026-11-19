// 🔌 `deniedMcpServers` (Claude Code): a top-level list of MCP servers a settings file refuses — a server listed
// there is never connected, whatever its own config says. It sits at the FILE's root (not under `permissions`), so it
// gets its own edit function; every other key must survive, and an emptied list is removed again so the file reads as
// it did before the first add.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deniedMcpOf, editDeniedMcp, readPermissions } from '../src/permissions.js';

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'office-mcpdeny-'));
  const project = path.join(root, 'proj');
  const userDir = path.join(root, 'user');
  mkdirSync(path.join(project, '.claude'), { recursive: true });
  mkdirSync(userDir, { recursive: true });
  return { root, project, userDir, done: () => rmSync(root, { recursive: true, force: true }) };
}

const localFile = (project) => path.join(project, '.claude', 'settings.local.json');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('deniedMcpOf: kosong/null = daftar kosong; bentuk salah ditolak (tidak ditulis ulang)', () => {
  assert.deepEqual(deniedMcpOf({}), []);
  assert.deepEqual(deniedMcpOf(null), []);
  assert.deepEqual(deniedMcpOf({ deniedMcpServers: ['a', 'b'] }), ['a', 'b']);
  assert.throws(() => deniedMcpOf({ deniedMcpServers: 'a' }), /bukan array/);
});

test('editDeniedMcp: menambah tanpa menyentuh key lain, dan menghapusnya mengembalikan file seperti semula', async () => {
  const box = sandbox();
  try {
    writeFileSync(localFile(box.project), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, model: 'x' }, null, 2));
    const added = await editDeniedMcp(box.project, { scope: 'local', action: 'add', server: 'crm-mcp' }, { userDir: box.userDir });
    assert.deepEqual(added.denied, ['crm-mcp']);
    assert.deepEqual(readJson(localFile(box.project)), {
      permissions: { allow: ['Bash(ls)'] }, // untouched
      model: 'x', // untouched
      deniedMcpServers: ['crm-mcp'],
    });

    await editDeniedMcp(box.project, { scope: 'local', action: 'remove', server: 'crm-mcp' }, { userDir: box.userDir });
    const after = readJson(localFile(box.project));
    assert.equal('deniedMcpServers' in after, false, 'daftar kosong dihapus, bukan disisakan sebagai []');
    assert.deepEqual(after, { permissions: { allow: ['Bash(ls)'] }, model: 'x' });
  } finally {
    box.done();
  }
});

test('editDeniedMcp: menolak nama aneh dan penambahan ganda', async () => {
  const box = sandbox();
  try {
    await assert.rejects(() => editDeniedMcp(box.project, { scope: 'local', action: 'add', server: '../evil' }, { userDir: box.userDir }), /tidak valid/);
    await assert.rejects(() => editDeniedMcp(box.project, { scope: 'nope', action: 'add', server: 'x' }, { userDir: box.userDir }), /tidak dikenal/);
    await editDeniedMcp(box.project, { scope: 'local', action: 'add', server: 'crm-mcp' }, { userDir: box.userDir });
    await assert.rejects(() => editDeniedMcp(box.project, { scope: 'local', action: 'add', server: 'crm-mcp' }, { userDir: box.userDir }), /sudah dilarang/);
    await assert.rejects(() => editDeniedMcp(box.project, { scope: 'local', action: 'remove', server: 'tidak-ada' }, { userDir: box.userDir }), /tidak ada/);
  } finally {
    box.done();
  }
});

test('readPermissions: daftar larangan MCP ikut terbaca per sumber', async () => {
  const box = sandbox();
  try {
    await editDeniedMcp(box.project, { scope: 'local', action: 'add', server: 'crm-mcp' }, { userDir: box.userDir });
    const { scopes } = await readPermissions(box.project, { userDir: box.userDir });
    const local = scopes.find((s) => s.scope === 'local');
    assert.deepEqual(local.deniedMcp, ['crm-mcp']);
    assert.deepEqual(scopes.find((s) => s.scope === 'user').deniedMcp, []);
  } finally {
    box.done();
  }
});
