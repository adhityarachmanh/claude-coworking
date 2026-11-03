// OpenCode as the app's engine: the full server against a fake `opencode acp` (test-support/fake-acp.mjs) —
// the engine switch (each engine its own workspace), streaming, tools in the office, the to-do board, approvals
// (allow / reject), auto mode, stop, token + cost into the result line, provider logins (`opencode api`).
// No network, no tokens, no access to your real OpenCode.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-opencode-'));
const PORT = 4900 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let token;
const seen = [];
const waiters = [];
let stream;
let mark = 0;

before(async () => {
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko'), { recursive: true });
  writeFileSync(path.join(projects, 'toko', 'README.md'), '# Toko\n');
  mkdirSync(path.join(TMP, 'claude-projects'));
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      FAKE_ACP_FAIL_ONCE: path.join(TMP, 'acp-cold-start'), // the first OpenCode process dies: the retry must hide it
      FAKE_ACP_AUTH_FILE: path.join(TMP, 'acp-auth.json'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPEN_DRY_RUN: '1',
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale'),
      OFFICE_CLAUDE_CHECK_DELAY_MS: '0',
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

function waitFor(pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    for (let i = mark; i < seen.length; i++) if (pred(seen[i].type, seen[i].obj)) return ((mark = i + 1), resolve(seen[i].obj));
    const recent = () => seen.slice(Math.max(mark, seen.length - 8)).map((s) => `${s.type}:${JSON.stringify(s.obj).slice(0, 160)}`).join('\n  ');
    const timer = setTimeout(() => reject(new Error(`timeout waiting for event; last events:\n  ${recent()}`)), ms);
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
const projectId = async () => (await snapshot()).projects.find((p) => p.name === 'toko').id;

/** Moves the whole app to `engine` (Akun) and checks it took. */
async function useEngine(engine) {
  const res = await api('/api/engine', { engine });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await snapshot()).config.engine, engine);
}
const lastText = (id) => seen.filter((s) => s.type === 'chat_update' && s.obj.project === id && s.obj.patch.streaming === false).at(-1)?.obj.patch.text;

test('config.engines announces OpenCode with its caps; the engine is app-wide; models per project are validated', async () => {
  const snap = await snapshot();
  assert.equal(snap.config.engine, 'claude', 'Claude Code until OpenCode is chosen in Akun');
  assert.equal(snap.config.engines.claude.available, true);
  assert.equal(snap.config.engines.opencode.available, true);
  assert.equal(snap.config.engines.opencode.caps.rewind, false, 'Fase 1: no rewind for OpenCode');
  assert.deepEqual(snap.config.engines.opencode.caps.modes, ['manual', 'acceptEdits', 'auto', 'plan']);
  const id = await projectId();
  await api(`/api/projects/${id}/settings`, { model: 'opus' });
  assert.deepEqual((await api(`/api/projects/${id}/models`)).body.models, [], 'Claude models come with the app config');
  await api(`/api/projects/${id}/settings`, { engine: 'opencode' });
  assert.equal((await snapshot()).statuses[id].engine, 'claude', "a project's settings can't change the engine");
  assert.equal((await api('/api/engine', { engine: 'nope' })).status, 409, 'unknown engines are refused');
  await useEngine('opencode');
  let st = (await snapshot()).statuses[id];
  assert.equal(st.engine, 'opencode');
  assert.equal(st.model, '', "OpenCode's workspace has its own settings: the Claude alias stays with Claude");
  const list = (await api(`/api/projects/${id}/models`)).body;
  assert.equal(list.engine, 'opencode');
  assert.deepEqual(list.models.map((m) => m.value), ['opencode-go/beam-free', 'opencode-go/kimi-k3', 'google/gemini-2.5-flash']);
  assert.equal(list.models[0].name, 'beam-free (gratis)');
  await api(`/api/projects/${id}/settings`, { model: 'opencode-go/beam-free; rm -rf /' });
  assert.equal((await snapshot()).statuses[id].model, '', 'only provider/model ids');
  await api(`/api/projects/${id}/settings`, { model: 'opencode-go/beam-free' });
  st = (await snapshot()).statuses[id];
  assert.equal(st.model, 'opencode-go/beam-free');
});

test('switching engines is refused (409) while a turn runs', async () => {
  const id = await projectId();
  await useEngine('opencode');
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'tugas lama' });
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.streaming === true);
  const res = await api('/api/engine', { engine: 'claude' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.busy, ['toko']);
  await api(`/api/projects/${id}/stop`);
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal((await snapshot()).config.engine, 'opencode');
});

test('a prompt streams, works in the office, fills the to-do board and ends with tokens and cost', async () => {
  const id = await projectId();
  await useEngine('opencode');
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'halo' });
  // (the fake answers within ~50 ms, faster than the 80 ms streaming flush: only the final text is checked here;
  // streaming itself is covered by the stop test, which keeps a turn open)
  // in the order the fake sends them: the plan, then the read
  await waitFor((t, o) => t === 'office' && o.project === id && o.kind === 'board' && o.items?.length === 2);
  const read = await waitFor((t, o) => t === 'office' && o.project === id && o.kind === 'tool_start' && o.tool === 'Read');
  assert.match(read.label, /README\.md/);
  const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(result.ok, true);
  assert.equal(result.meta.tokensIn, 195, 'input + cache read');
  assert.equal(result.meta.tokensOut, 25, 'output + thinking');
  assert.ok(Math.abs(result.meta.costUsd - 0.0025) < 1e-9, 'cost of this turn from usage_update');
  const texts = seen.filter((s) => s.type === 'chat_update' && s.obj.project === id && s.obj.patch.streaming === false).map((s) => s.obj.patch.text);
  assert.ok(texts.includes('Halo dari OpenCode palsu.'));
  const st = await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);
  assert.match(st.sessionId ?? (await snapshot()).statuses[id].sessionId, /^ses_fake/);
});

test('approvals: OpenCode asks (permission config "ask"), allow runs the tool, reject stops the turn quietly', async () => {
  const id = await projectId();
  await useEngine('opencode');
  await api(`/api/projects/${id}/settings`, { mode: 'manual' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'minta izin' });
  let approval = await waitFor((t, o) => t === 'approval' && o.project === id && o.status === 'pending');
  assert.equal(approval.tool, 'Bash');
  assert.equal(approval.input.command, 'echo halo');
  assert.equal(approval.canAlways, true);
  assert.equal((await api(`/api/approvals/${approval.id}`, { allow: true })).status, 200);
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.status === 'ok' && /halo/.test(o.patch.output ?? ''));
  assert.equal((await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result')).ok, true);

  await api(`/api/projects/${id}/prompt`, { text: 'izin lagi' });
  approval = await waitFor((t, o) => t === 'approval' && o.project === id && o.status === 'pending');
  await api(`/api/approvals/${approval.id}`, { allow: false });
  const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(result.ok, false);
  assert.match(result.text, /Dihentikan/, 'a refusal stops the turn, it is not an error');
});

test('⚡ Auto: no approval card, the tool just runs (a fresh process gets the new permission config)', async () => {
  const id = await projectId();
  await useEngine('opencode');
  await api(`/api/projects/${id}/settings`, { mode: 'auto' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'izin otomatis' });
  const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(result.ok, true);
  assert.equal(seen.slice(mark - 50).filter((s) => s.type === 'approval' && s.obj.project === id && s.obj.status === 'pending' && seen.indexOf(s) >= mark).length, 0);
  await api(`/api/projects/${id}/settings`, { mode: 'manual' });
});

test('stop cancels a running OpenCode turn (session/cancel) and the session stays usable', async () => {
  const id = await projectId();
  await useEngine('opencode');
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

test('each engine is its own workspace: chats, conversation and settings come back when switching back', async () => {
  const id = await projectId();
  await useEngine('opencode');
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'halo opencode' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  const ocSnap = await snapshot();
  const ocSession = ocSnap.statuses[id].sessionId;
  assert.match(ocSession, /^ses_fake/);
  assert.ok(ocSnap.chats[id].some((m) => m.kind === 'user' && m.text === 'halo opencode'));

  mark = seen.length;
  await useEngine('claude');
  assert.ok(seen.slice(mark).some((s) => s.type === 'engine' && s.obj.engine === 'claude'), 'open pages are told to reload');
  let snap = await snapshot();
  assert.ok(!(snap.chats[id] ?? []).some((m) => m.text === 'halo opencode'), "OpenCode's chat is not in Claude Code's workspace");
  assert.notEqual(snap.statuses[id].sessionId, ocSession);
  assert.equal(snap.statuses[id].model, 'opus', "Claude Code's own model setting is back");
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'halo claude' });
  assert.equal((await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result')).ok, true);
  assert.match(lastText(id), /Claude palsu/, 'the prompt went to Claude Code');

  await useEngine('opencode');
  snap = await snapshot();
  assert.equal(snap.statuses[id].sessionId, ocSession, "OpenCode's conversation is resumed, not lost");
  assert.equal(snap.statuses[id].model, 'opencode-go/beam-free');
  assert.ok(snap.chats[id].some((m) => m.text === 'halo opencode'), "OpenCode's chat is back");
  assert.ok(!snap.chats[id].some((m) => m.text === 'halo claude'));
  const history = (await api(`/api/projects/${id}/sessions`)).body;
  assert.equal(history.engine, 'opencode');
  assert.deepEqual(history.sessions.map((x) => [x.id, x.title, x.source]), [['ses_fakeold', 'Sesi lama OpenCode', 'opencode']], "🕘 Riwayat sesi lists OpenCode's sessions");
  const dataDir = path.join(TMP, 'data');
  assert.ok(existsSync(path.join(dataDir, 'chats')) && existsSync(path.join(dataDir, 'chats-opencode')), 'one chat folder per engine');
  assert.ok(readdirSync(path.join(dataDir, 'chats-opencode')).some((f) => f.endsWith('.jsonl')));
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'halo lagi' });
  assert.equal((await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result')).ok, true);
  assert.match((await snapshot()).statuses[id].sessionId, /^ses_fake/, 'OpenCode keeps answering in its workspace');
});

test('review regressions: resume an OpenCode session, queue and bad engine block a switch, import only under Claude', async () => {
  const id = await projectId();
  await useEngine('opencode');
  assert.equal((await api(`/api/projects/${id}/resume`, { sessionId: 'ses_fakeold' })).status, 200, "an OpenCode session from 🕘 resumes");
  assert.equal((await snapshot()).statuses[id].sessionId, 'ses_fakeold');
  assert.equal((await api(`/api/projects/${id}/resume`, { sessionId: '11111111-2222-3333-4444-555555555555' })).status, 404, 'a Claude id is not an OpenCode session');
  assert.equal((await api('/api/engine', { engine: '' })).status, 409);
  // 📋 Antrian with a waiting item: the item would run on the other engine
  await api(`/api/projects/${id}/queue-pause`, { paused: true });
  const added = (await api(`/api/projects/${id}/queue-add`, { text: 'tugas antre' })).body;
  const refused = await api('/api/engine', { engine: 'claude' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Antrian/);
  await api(`/api/projects/${id}/queue-remove`, { itemId: added.item.id });
  await api(`/api/projects/${id}/queue-pause`, { paused: false });
  const imp = await fetch(`${BASE}/api/backup/import`, { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Office-Token': token }, body: new Uint8Array([80, 75, 3, 4]) });
  assert.equal(imp.status, 409, 'a backup (Claude history) is not imported into OpenCode');
  await useEngine('claude');
  await useEngine('opencode');
});

test('OpenCode provider logins: list, API key, OAuth, logout (through `opencode api`)', async () => {
  let list = (await api('/api/opencode/providers')).body;
  assert.deepEqual(list.connected.map((p) => [p.id, p.connections[0].type]), [['google', 'env']], 'an environment variable counts as connected');
  assert.deepEqual(list.available.map((p) => p.id), ['opencode-go', 'github-copilot', 'google']);
  assert.equal(list.available[1].methods[0].type, 'oauth');
  assert.equal(list.available[1].methods[0].form[0].options[0].value, 'github.com');

  const wrong = await api('/api/opencode/login/key', { provider: 'opencode-go', key: 'sk-salah' });
  assert.equal(wrong.status, 502);
  assert.equal(wrong.body.error, 'Authentication failed', 'the first line of the cause, no stack');
  assert.equal((await api('/api/opencode/login/key', { provider: 'opencode-go', key: '' })).status, 400);
  assert.equal((await api('/api/opencode/login/key', { provider: '../x', key: 'k' })).status, 400, 'ids are checked');
  assert.equal((await api('/api/opencode/login/key', { provider: 'opencode-go', key: 'sk-benar' })).status, 200);

  const attempt = (await api('/api/opencode/login/oauth', { provider: 'github-copilot', methodID: 'device', answer: { deploymentType: 'github.com' } })).body;
  assert.deepEqual(attempt, { attemptID: 'con_fake1', url: 'https://example.test/login', instructions: 'Masukkan kode ABCD-1234', mode: 'auto' });
  assert.equal((await api('/api/opencode/login/status', { provider: 'github-copilot', attemptID: attempt.attemptID })).body.status, 'complete');

  list = (await api('/api/opencode/providers')).body;
  const go = list.connected.find((p) => p.id === 'opencode-go');
  assert.equal(go.connections[0].method, 'key');
  assert.ok(list.connected.some((p) => p.id === 'github-copilot'));
  assert.equal((await api('/api/opencode/logout', { credentialID: go.connections[0].id })).status, 200);
  list = (await api('/api/opencode/providers')).body;
  assert.ok(!list.connected.some((p) => p.id === 'opencode-go'), 'logged out');
});
