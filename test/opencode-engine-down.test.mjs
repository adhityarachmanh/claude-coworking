// ⚠ OpenCode berhenti (src/acp-session.js → status.openCodeDown): the real server on the fake ACP engine, whose prompt
// "crash" kills the process mid-turn. The project's status must say so (with the exit code), the chat keeps the reason,
// and ▶ /engine-start starts the same conversation again without sending a prompt. No network, no tokens, no access to
// the real OpenCode or its service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-engine-down-'));
const PORT = 4870 + Math.floor(Math.random() * 50);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let token;
let id;
let otherId;
const seen = [];
const waiters = [];
let stream;
let mark = 0;

before(async () => {
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko'), { recursive: true });
  writeFileSync(path.join(projects, 'toko', 'README.md'), '# Toko\n');
  mkdirSync(path.join(projects, 'warung'), { recursive: true });
  writeFileSync(path.join(projects, 'warung', 'README.md'), '# Warung\n');
  mkdirSync(path.join(TMP, 'claude-projects'));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENCODE_')));
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...cleanEnv,
      OFFICE_APP_DIR: APP,
      OFFICE_PORT: String(PORT),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPENCODE_CONFIG_HOME: path.join(TMP, 'xdg'),
      OFFICE_OPEN_DRY_RUN: '1',
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale'),
      OFFICE_CLAUDE_CHECK_DELAY_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (d) => {
    stderr = (stderr + String(d)).slice(-4000);
    if (String(d).trim()) console.error('[server-err]', String(d).trim().slice(0, 500));
  });
  server.stdout.on('data', (d) => {
    if (String(d).includes('berjalan di')) return;
    if (String(d).trim()) console.error('[server]', String(d).trim().slice(0, 400));
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}:\n${stderr.trim()}`)));
  });
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  stream = listen();
  id = (await snapshot()).projects.find((p) => p.name === 'toko').id;
  otherId = (await snapshot()).projects.find((p) => p.name === 'warung').id;
  const eng = await api(`/api/projects/${id}/settings`, { engine: 'opencode' });
  if (eng.status !== 200) throw new Error(`engine switch failed: ${JSON.stringify(eng.body)}`);
  for (let i = 0; i < 100 && !(await snapshot()).statuses[id]; i++) await sleep(50);
});

after(async () => {
  stream?.abort();
  server?.kill();
  await sleep(500);
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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

function waitFor(pred, ms = 20000) {
  return new Promise((resolve, reject) => {
    for (let i = mark; i < seen.length; i++) if (pred(seen[i].type, seen[i].obj)) return ((mark = i + 1), resolve(seen[i].obj));
    const recent = () => seen.slice(Math.max(mark, seen.length - 8)).map((s) => `${s.type}:${JSON.stringify(s.obj).slice(0, 160)}`).join('\n  ');
    const timer = setTimeout(() => reject(new Error(`timeout; last:\n  ${recent()}`)), ms);
    waiters.push({ pred, resolve: (o) => (clearTimeout(timer), (mark = seen.length), resolve(o)) });
  });
}

const api = (p, body = {}) =>
  fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function snapshot() {
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

test('a process that dies on its own is flagged; ▶ engine-start brings the same conversation back', async () => {
  mark = seen.length;
  const sent = await api(`/api/projects/${id}/prompt`, { text: 'tolong crash sekarang' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const down = await waitFor((t, o) => t === 'status' && o.project === id && o.openCodeDown === true);
  assert.equal(down.openCodeExit, 7, 'the exit code is kept for the chip tooltip');
  assert.equal(down.busy, false, 'the dead turn is closed, not left running');
  // the chat keeps the reason: the chip is not the only clue
  const chat = (await snapshot()).chats?.[id] ?? [];
  assert.ok(chat.some((c) => c.kind === 'error' && /OpenCode berhenti/.test(c.text)), 'the exit is explained in the chat');

  // ▶ the chip's button: no prompt, the same session comes back (session/load in the handshake)
  const started = await api(`/api/projects/${id}/engine-start`);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const back = await waitFor((t, o) => t === 'status' && o.project === id && o.openCodeDown === false);
  assert.equal(back.openCodeDown, false, 'the chip goes away once the engine answers');

  // and it really works again
  mark = seen.length;
  const again = await api(`/api/projects/${id}/prompt`, { text: 'halo lagi' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok === true);
});

test('▶ engine-start is refused for a project that is not on OpenCode', async () => {
  const other = await api(`/api/projects/${otherId}/settings`, { engine: 'claude' });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const res = await api(`/api/projects/${otherId}/engine-start`);
  assert.equal(res.status, 409);
});
