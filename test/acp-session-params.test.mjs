// ACP session parameters: 📂 folder tambahan reach OpenCode as `additionalDirectories` (docs: session/new, load,
// resume, fork accept it; each request replaces the session's list).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionParams } from '../src/acp-session.js';

test('sessionParams: daftar folder valid ikut, daftar kosong tetap bentuk lama', () => {
  assert.deepEqual(sessionParams('/x'), { cwd: '/x', mcpServers: [] });
  assert.deepEqual(sessionParams('/x', { additionalDirectories: [] }), { cwd: '/x', mcpServers: [] });
  assert.deepEqual(sessionParams('/x', { additionalDirectories: ['/a', '', 3, '/b'] }), { cwd: '/x', mcpServers: [], additionalDirectories: ['/a', '/b'] });
});
