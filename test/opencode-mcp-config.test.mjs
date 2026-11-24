// 🔌 Advanced MCP server options in OpenCode config: only the named keys change, other keys and servers stay,
// a backup is written, and a file changed meanwhile is refused. A throwaway home/project/data folder.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { readOpenCodeMcpAdvanced, saveOpenCodeMcpAdvanced } from '../src/opencode-config.js';
import { applyMcpAdvanced, mcpAdvancedFields } from '../src/opencode-mcp-config.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-opencode-mcp-config-'));
const HOME = path.join(TMP, 'xdg');
const PROJECT = path.join(TMP, 'projects', 'toko');
const DATA = path.join(TMP, 'data');
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const projectJson = () => path.join(PROJECT, 'opencode.json');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const read = (name) => readOpenCodeMcpAdvanced({ projectPath: PROJECT, home: HOME, name });
const save = (name, fields, extra = {}) => {
  const view = read(name);
  return saveOpenCodeMcpAdvanced({ scope: view.scope ?? 'project', projectPath: PROJECT, projectId: 'p1', home: HOME, dataDir: DATA, name, fields, baseHash: view.hash, ...extra });
};

test('applyMcpAdvanced: inherit menghapus kunci, on/off menulis boolean, timeout hanya yang diisi', () => {
  const server = { type: 'local', command: ['npx', 'x'], disabled: true, codemode: true, pool: false, protocol: 'legacy', cwd: '/lama', timeout: { startup: 1000, catalog: 2000 } };
  applyMcpAdvanced(server, { disabled: 'off', codemode: 'inherit', pool: 'on', protocol: 'auto', cwd: ' ~/work ', timeoutCatalog: '', timeoutExecution: '600000' });
  assert.deepEqual(server, { type: 'local', command: ['npx', 'x'], disabled: false, pool: true, protocol: 'auto', cwd: '~/work', timeout: { startup: 1000, execution: 600000 } });

  assert.throws(() => applyMcpAdvanced({ type: 'local' }, { protocol: 'baru' }), (e) => e.status === 400);
  assert.throws(() => applyMcpAdvanced({ type: 'local' }, { timeoutStartup: '0' }), (e) => e.status === 400);
  assert.throws(() => applyMcpAdvanced({ type: 'remote', url: 'https://x' }, { cwd: '.' }), (e) => e.status === 400);
  assert.equal(applyMcpAdvanced({ type: 'local' }, { disabled: 'inherit' }).disabled, undefined);
});

test('mcpAdvancedFields: server tanpa kunci terbaca inherit/kosong', () => {
  assert.deepEqual(mcpAdvancedFields({}), { disabled: 'inherit', codemode: 'inherit', pool: 'inherit', protocol: 'inherit', cwd: '', timeoutStartup: '', timeoutCatalog: '', timeoutExecution: '' });
  assert.equal(mcpAdvancedFields({ timeout: { catalog: 60000 } }).timeoutCatalog, 60000);
  assert.equal(mcpAdvancedFields({ disabled: false }).disabled, 'off');
});

test('read/save: hanya server itu yang berubah, kunci lain tetap, backup dibuat', () => {
  write(
    projectJson(),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: 'anthropic/claude',
        mcp: {
          servers: {
            crm: { type: 'remote', url: 'https://crm.example/mcp', headers: { Authorization: 'Bearer x' }, disabled: true },
            lokal: { type: 'local', command: ['npx', '-y', 'lokal'] },
          },
        },
      },
      null,
      2,
    ),
  );
  const before = read('crm');
  assert.equal(before.found, true);
  assert.equal(before.scope, 'project');
  assert.equal(before.fields.disabled, 'on');

  const saved = save('crm', { disabled: 'off', codemode: 'off', protocol: '2026-07-28', timeoutExecution: 600000 });
  assert.equal(saved.found, true);
  assert.equal(saved.fields.disabled, 'off');
  assert.equal(saved.fields.timeoutExecution, 600000);
  assert.ok(saved.backup, 'file lama dicadangkan');

  const file = readJson(projectJson());
  assert.equal(file.model, 'anthropic/claude', 'kunci config lain tetap');
  assert.deepEqual(file.mcp.servers.crm, { type: 'remote', url: 'https://crm.example/mcp', headers: { Authorization: 'Bearer x' }, disabled: false, codemode: false, protocol: '2026-07-28', timeout: { execution: 600000 } });
  assert.deepEqual(file.mcp.servers.lokal, { type: 'local', command: ['npx', '-y', 'lokal'] }, 'server lain tidak tersentuh');

  // inherit deletes the key again (a newer OpenCode default keeps applying).
  save('crm', { protocol: 'inherit', timeoutExecution: '' });
  assert.deepEqual(readJson(projectJson()).mcp.servers.crm, { type: 'remote', url: 'https://crm.example/mcp', headers: { Authorization: 'Bearer x' }, disabled: false, codemode: false });
  assert.ok(readdirSync(path.join(DATA, 'opencode-config-backups')).length > 0, 'backup tersimpan di data aplikasi');
});

test('read/save: bentuk v1 (nama server langsung di bawah mcp) tetap v1, server asing ditolak', () => {
  write(projectJson(), JSON.stringify({ mcp: { lama: { type: 'local', command: ['node', 'lama.js'] } } }, null, 2));
  const view = read('lama');
  assert.equal(view.found, true);
  save('lama', { pool: 'on' });
  const file = readJson(projectJson());
  assert.deepEqual(file.mcp.lama, { type: 'local', command: ['node', 'lama.js'], pool: true });

  const missing = read('tidak-ada');
  assert.equal(missing.found, false);
  assert.throws(() => saveOpenCodeMcpAdvanced({ scope: 'project', projectPath: PROJECT, projectId: 'p1', home: HOME, dataDir: DATA, name: 'tidak-ada', fields: {}, baseHash: missing.hash }), (e) => e.status === 404);
  assert.throws(() => readOpenCodeMcpAdvanced({ projectPath: PROJECT, home: HOME, name: '--evil' }), (e) => e.status === 400);
});

test('save: file berubah setelah dibaca (baseHash lama) ditolak 409', () => {
  write(projectJson(), JSON.stringify({ mcp: { servers: { a: { type: 'local', command: ['node', 'a.js'] } } } }, null, 2));
  const view = read('a');
  writeFileSync(projectJson(), JSON.stringify({ mcp: { servers: { a: { type: 'local', command: ['node', 'a.js'], codemode: true } } } }, null, 2));
  assert.throws(() => saveOpenCodeMcpAdvanced({ scope: 'project', projectPath: PROJECT, projectId: 'p1', home: HOME, dataDir: DATA, name: 'a', fields: { disabled: 'on' }, baseHash: view.hash }), (e) => e.status === 409);
});
