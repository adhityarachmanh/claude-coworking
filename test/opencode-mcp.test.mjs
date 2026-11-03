// /mcp for OpenCode (src/opencode-mcp.js) against the fake `opencode api` (test-support/fake-acp.mjs).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openCodeMcpAction, openCodeMcpStatus } from '../src/opencode-mcp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = { command: process.execPath, args: [path.join(ROOT, 'test-support', 'fake-acp.mjs')] };

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), 'oc-mcp-'));
  mkdirSync(path.join(dir, '.opencode'));
  writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ mcp: { servers: { docs: { type: 'remote', url: 'https://docs.example' }, local: { type: 'local', command: ['x'] } } } }));
  return dir;
}

test('status: the configured servers with their live state; servers only the service knows are listed too', async () => {
  const dir = project();
  const list = await openCodeMcpStatus(bin, dir);
  const by = Object.fromEntries(list.map((s) => [s.name, s]));
  assert.equal(by.docs.status, 'connected');
  assert.equal(by.docs.scope, 'project');
  assert.equal(by.local.status, 'configured', 'not reported live: stays "terdaftar"');
  assert.equal(by.notion.status, 'needs-auth');
  assert.equal(by.notion.canLogin, true);
  assert.equal(by.broken.status, 'failed');
  assert.equal(by.broken.error, 'spawn ENOENT');
});

test('actions: reconnect / enable / disable through the service; login via the integration OAuth; pasted code completes it', async () => {
  const dir = project();
  const log = path.join(dir, 'mcp.log');
  process.env.FAKE_ACP_MCP_LOG = log;
  try {
    await openCodeMcpAction(bin, dir, 'docs', 'reconnect');
    await openCodeMcpAction(bin, dir, 'docs', 'disable');
    await openCodeMcpAction(bin, dir, 'docs', 'enable');
    const login = await openCodeMcpAction(bin, dir, 'notion', 'login');
    assert.equal(login.authUrl, 'https://example.test/login');
    assert.equal(login.callbackExpected, false);
    assert.deepEqual(await openCodeMcpAction(bin, dir, 'docs', 'login'), { authUrl: null }, 'connected: nothing to log in');
    await assert.rejects(openCodeMcpAction(bin, dir, 'broken', 'login'), /tidak memakai login OAuth/);
    await openCodeMcpAction(bin, dir, 'notion', 'callback', 'http://localhost:1/cb?code=abc123&state=x');
    await assert.rejects(openCodeMcpAction(bin, dir, 'notion', 'callback', 'abc'), /Mulai login dulu/, 'one completion per login');
    await assert.rejects(openCodeMcpAction(bin, dir, '../x', 'reconnect'), /tidak valid/);
    await assert.rejects(openCodeMcpAction(bin, dir, 'docs', 'explode'), /tidak dikenal/);
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ').slice(0, 2).join(' '));
    assert.deepEqual(lines, ['disconnect docs', 'connect docs', 'disconnect docs', 'connect docs', 'complete mcp-notion', 'connect notion']);
    assert.match(readFileSync(log, 'utf8'), /complete mcp-notion abc123/);
  } finally {
    delete process.env.FAKE_ACP_MCP_LOG;
  }
});
