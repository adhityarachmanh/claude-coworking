// Full server against a fake Claude Code (test-support/fake-claude.mjs): API, security, chat flow,
// permission prompts and interrupts — no network, no tokens, no access to your real data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-server-'));
const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let token;
const seen = [];
const waiters = [];
let stream;

before(async () => {
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko', 'src'), { recursive: true });
  writeFileSync(path.join(projects, 'toko', 'src', 'checkout.ts'), 'export {};\n');
  mkdirSync(path.join(TMP, 'claude-projects'));
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  stream = listen();
});

after(async () => {
  stream?.abort();
  server?.kill();
  await sleep(500);
  rmSync(TMP, { recursive: true, force: true });
});

function listen() {
  const controller = new AbortController();
  (async () => {
    const res = await fetch(`${BASE}/stream`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = frame.match(/^event: (.*)$/m)?.[1];
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (!type || !data) continue;
        const obj = JSON.parse(data);
        seen.push({ type, obj });
        for (const w of [...waiters]) if (w.pred(type, obj)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(obj));
      }
    }
  })();
  return controller;
}

let mark = 0;
function waitFor(pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    for (let i = mark; i < seen.length; i++) if (pred(seen[i].type, seen[i].obj)) return ((mark = i + 1), resolve(seen[i].obj));
    const timer = setTimeout(() => reject(new Error('timeout waiting for event')), ms);
    waiters.push({ pred, resolve: (o) => (clearTimeout(timer), (mark = seen.length), resolve(o)) });
  });
}

function api(p, body = {}, headers = {}) {
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token, ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

/** Request with a forged Host header (fetch can't set Host). */
function rawRequest(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', headers: { Connection: 'close', ...headers } }, (res) => {
      res.resume(); // drain so the socket closes cleanly
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

const projectId = async () => (await snapshot()).projects.find((p) => p.name === 'toko').id;
async function snapshot() {
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

test('security: token, origin, host and path checks', async () => {
  assert.equal((await fetch(`${BASE}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await api('/api/demo', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${BASE}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Office-Token': token }, body: '{}' })).status, 415);
  assert.equal(await rawRequest({ Host: 'evil.example' }), 421); // DNS rebinding
  assert.equal((await fetch(`${BASE}/..%2fserver.js`)).status, 404);
});

test('projects come from the configured root; bad roots are rejected', async () => {
  const snap = await snapshot();
  assert.ok(snap.projects.some((p) => p.name === 'toko'));
  assert.equal((await api('/api/config', { roots: ['Z:/tidak/ada'] })).status, 400);
  const files = await api(`/api/projects/${await projectId()}/files`, { q: 'check' });
  assert.deepEqual(files.body.files, ['src/checkout.ts']);
});

test('a prompt streams a reply and finishes with token stats', async () => {
  const id = await projectId();
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'halo' });
  const user = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'user');
  assert.equal(user.text, 'halo');
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.streaming === true);
  const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(result.ok, true);
  assert.equal(result.meta.tokensIn, 100);
  const final = seen.filter((s) => s.type === 'chat_update' && s.obj.project === id && s.obj.patch.streaming === false).at(-1);
  assert.equal(final.obj.patch.text, 'Halo dari Claude palsu yang sedang mengetik.');
  const status = await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);
  assert.ok(status.sessionId, 'session id remembered for --resume');
});

test('permission prompts: allow and deny from the web', async () => {
  const id = await projectId();
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'minta izin tulis file' });
  let approval = await waitFor((t, o) => t === 'approval' && o.project === id && o.status === 'pending');
  assert.equal(approval.tool, 'Write');
  assert.equal(approval.canAlways, true);
  assert.equal((await api(`/api/approvals/${approval.id}`, { allow: true })).status, 200);
  assert.equal((await api(`/api/approvals/${approval.id}`, { allow: true })).status, 409, 'cannot decide twice');
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.status === 'ok' && o.patch.output === 'File created successfully');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok);

  await api(`/api/projects/${id}/prompt`, { text: 'izin lagi' });
  approval = await waitFor((t, o) => t === 'approval' && o.project === id && o.status === 'pending');
  await api(`/api/approvals/${approval.id}`, { allow: false, message: 'Jangan' });
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.status === 'fail');
  const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(result.meta.denials, 1);
});

test('stop interrupts a running turn and the session stays usable', async () => {
  const id = await projectId();
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'tugas lama' });
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.streaming === true);
  await api(`/api/projects/${id}/stop`);
  const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(result.ok, false);
  assert.match(result.text, /Dihentikan/);
  await api(`/api/projects/${id}/prompt`, { text: 'halo lagi' });
  assert.equal((await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result')).ok, true);
});

test('settings are validated; the demo runs without Claude', async () => {
  const id = await projectId();
  await api(`/api/projects/${id}/settings`, { mode: 'rm -rf', model: 'gpt', team: false });
  const snap = await snapshot();
  assert.equal(snap.statuses[id].mode, 'manual');
  assert.equal(snap.statuses[id].model, '');
  assert.equal(snap.statuses[id].team, false);
  assert.equal((await api('/api/demo')).status, 202);
  await waitFor((t, o) => t === 'chat' && o.project === 'demo' && o.kind === 'assistant');
});
