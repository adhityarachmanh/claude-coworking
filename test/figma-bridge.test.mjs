// 🌉 Figma bridge: MCP stdio + the plugin's HTTP polling, without a real Figma file (a fake plugin answers).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-token-0123456789abcdef';
const AUTH = { 'X-Bridge-Token': TOKEN };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let lines;
const pending = new Map(); // id -> resolve

function send(msg) {
  server.stdin.write(`${JSON.stringify(msg)}\n`);
}

function request(id, method, params = {}) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

before(async () => {
  server = spawn(process.execPath, [path.join(APP, 'tools', 'figma-bridge', 'server.mjs')], {
    env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_TIMEOUT_MS: '4000', FIGMA_BRIDGE_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  lines = readline.createInterface({ input: server.stdout });
  lines.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) break;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error('bridge tidak menyala');
    await sleep(100);
  }
});

after(() => {
  lines?.close();
  server?.kill();
});

test('MCP: initialize, tools/list, and status without a plugin', async () => {
  const init = await request(1, 'initialize');
  assert.equal(init.result.serverInfo.name, 'adhitron-figma-bridge');
  const list = await request(2, 'tools/list');
  const names = list.result.tools.map((t) => t.name);
  for (const name of ['figma_status', 'figma_selection', 'figma_export', 'figma_create_frame', 'figma_set_fill']) assert.ok(names.includes(name), name);
  const status = await request(3, 'tools/call', { name: 'figma_status', arguments: {} });
  const info = JSON.parse(status.result.content[0].text);
  assert.equal(info.plugin, false, 'belum ada plugin');
  assert.match(info.bridge, /^http:\/\/127\.0\.0\.1:/);
});

test('MCP → plugin queue → result (fake plugin)', async () => {
  await fetch(`${BASE}/poll`, { headers: AUTH }); // the plugin's first poll marks it connected
  const call = request(10, 'tools/call', { name: 'figma_selection', arguments: {} });
  await sleep(250);
  const poll = await (await fetch(`${BASE}/poll`, { headers: AUTH })).json();
  assert.equal(poll.commands.length, 1);
  const command = poll.commands[0];
  assert.equal(command.cmd, 'selection');
  await fetch(`${BASE}/result`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: command.id, ok: true, data: [{ id: '1:2', name: 'Kartu', type: 'FRAME' }] }) });
  const answer = await call;
  assert.match(answer.result.content[0].text, /Kartu/);
  assert.equal(answer.result.isError, undefined);
});

test('plugin error becomes an MCP tool error', async () => {
  await fetch(`${BASE}/poll`, { headers: AUTH });
  const call = request(20, 'tools/call', { name: 'figma_node', arguments: { id: '99:99' } });
  await sleep(250);
  const poll = await (await fetch(`${BASE}/poll`, { headers: AUTH })).json();
  const command = poll.commands[0];
  await fetch(`${BASE}/result`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: command.id, ok: false, error: 'Node tidak ditemukan' }) });
  const answer = await call;
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0].text, /Node tidak ditemukan/);
});

test('poll/result refuse a missing token, and a broken URL does not kill the bridge', async () => {
  const poll = await fetch(`${BASE}/poll`);
  assert.equal(poll.status, 403, 'a web page without the token cannot read commands');
  const result = await fetch(`${BASE}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(result.status, 403, 'a web page cannot forge plugin results');
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: '//[' }, () => resolve());
    req.on('error', resolve);
    req.end();
  });
  const health = await fetch(`${BASE}/health`);
  assert.equal(health.status, 200, 'the bridge survives a malformed request-target');
});

test('CORS: only the Figma plugin origin may read responses', async () => {
  const evil = await fetch(`${BASE}/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const plugin = await fetch(`${BASE}/health`, { headers: { Origin: 'null' } });
  assert.equal(plugin.headers.get('access-control-allow-origin'), 'null');
});

test('/exec needs the token, works for allowed commands, and refuses destructive ones', async () => {
  await fetch(`${BASE}/poll`, { headers: AUTH }); // mark the plugin connected
  const noToken = await fetch(`${BASE}/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'resize', args: { id: '1:2', width: 10, height: 10 } }) });
  assert.equal(noToken.status, 403, 'no token, no command');
  const destructive = await fetch(`${BASE}/exec`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'delete', args: { id: '1:2' } }) });
  assert.equal(destructive.status, 400, 'delete is not exposed over HTTP');

  const call = fetch(`${BASE}/exec`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'resize', args: { id: '1:2', width: 10, height: 20 } }) });
  await sleep(250);
  const poll = await (await fetch(`${BASE}/poll`, { headers: AUTH })).json();
  assert.equal(poll.commands.length, 1);
  const command = poll.commands[0];
  assert.equal(command.cmd, 'resize');
  await fetch(`${BASE}/result`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: command.id, ok: true, data: { id: '1:2', width: 10, height: 20 } }) });
  const answer = await call;
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).data.height, 20);
});

test('a tool that needs the plugin says so when it is not connected', async () => {
  await sleep(6200); // the plugin freshness window (6 s) expires
  const answer = await request(30, 'tools/call', { name: 'figma_selection', arguments: {} });
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0].text, /Plugin Figma belum terhubung/);
});

test('the plugin manifest is valid JSON and keeps the Adhitron brand plus the stable Figma id', () => {
  const manifest = JSON.parse(readFileSync(path.join(APP, 'tools', 'figma-bridge', 'plugin', 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'Adhitron Bridge');
  assert.equal(manifest.id, 'adhit-office-figma-bridge', 'the Figma plugin id must not change');
});
