// 🌉 Figma bridge: MCP stdio + the plugin's HTTP polling, without a real Figma file (a fake plugin answers).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
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
    env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_TIMEOUT_MS: '4000' },
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
  assert.equal(init.result.serverInfo.name, 'adhit-office-figma-bridge');
  const list = await request(2, 'tools/list');
  const names = list.result.tools.map((t) => t.name);
  for (const name of ['figma_status', 'figma_selection', 'figma_export', 'figma_create_frame', 'figma_set_fill']) assert.ok(names.includes(name), name);
  const status = await request(3, 'tools/call', { name: 'figma_status', arguments: {} });
  const info = JSON.parse(status.result.content[0].text);
  assert.equal(info.plugin, false, 'belum ada plugin');
  assert.match(info.bridge, /^http:\/\/127\.0\.0\.1:/);
});

test('MCP → plugin queue → result (fake plugin)', async () => {
  await fetch(`${BASE}/poll`); // the plugin's first poll marks it connected
  const call = request(10, 'tools/call', { name: 'figma_selection', arguments: {} });
  await sleep(250);
  const poll = await (await fetch(`${BASE}/poll`)).json();
  assert.equal(poll.commands.length, 1);
  const command = poll.commands[0];
  assert.equal(command.cmd, 'selection');
  await fetch(`${BASE}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: command.id, ok: true, data: [{ id: '1:2', name: 'Kartu', type: 'FRAME' }] }) });
  const answer = await call;
  assert.match(answer.result.content[0].text, /Kartu/);
  assert.equal(answer.result.isError, undefined);
});

test('plugin error becomes an MCP tool error', async () => {
  await fetch(`${BASE}/poll`);
  const call = request(20, 'tools/call', { name: 'figma_node', arguments: { id: '99:99' } });
  await sleep(250);
  const poll = await (await fetch(`${BASE}/poll`)).json();
  const command = poll.commands[0];
  await fetch(`${BASE}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: command.id, ok: false, error: 'Node tidak ditemukan' }) });
  const answer = await call;
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0].text, /Node tidak ditemukan/);
});

test('a tool that needs the plugin says so when it is not connected', async () => {
  await sleep(6200); // the plugin freshness window (6 s) expires
  const answer = await request(30, 'tools/call', { name: 'figma_selection', arguments: {} });
  assert.equal(answer.result.isError, true);
  assert.match(answer.result.content[0].text, /Plugin Figma belum terhubung/);
});
