// OpenCode as a project's engine: the full server against a fake `opencode acp` (test-support/fake-acp.mjs) —
// engine switch, streaming, tools in the office, the to-do board, approvals (allow / reject), auto mode, stop,
// token + cost into the result line. No network, no tokens, no access to your real OpenCode.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('config.engines announces OpenCode with its caps; models per project; the engine setting is validated', async () => {
  const snap = await snapshot();
  assert.equal(snap.config.engines.claude.available, true);
  assert.equal(snap.config.engines.opencode.available, true);
  assert.equal(snap.config.engines.opencode.caps.rewind, false, 'Fase 1: no rewind for OpenCode');
  assert.deepEqual(snap.config.engines.opencode.caps.modes, ['manual', 'acceptEdits', 'auto', 'plan']);
  const id = await projectId();
  await api(`/api/projects/${id}/settings`, { engine: 'claude', model: 'opus' });
  assert.deepEqual((await api(`/api/projects/${id}/models`)).body.models, [], 'Claude models come with the app config');
  await api(`/api/projects/${id}/settings`, { engine: 'opencode', model: 'opus' });
  let st = (await snapshot()).statuses[id];
  assert.equal(st.engine, 'opencode');
  assert.equal(st.model, '', 'a Claude alias does not carry over to OpenCode');
  const list = (await api(`/api/projects/${id}/models`)).body;
  assert.equal(list.engine, 'opencode');
  assert.deepEqual(list.models.map((m) => m.value), ['opencode-go/beam-free', 'opencode-go/kimi-k3', 'google/gemini-2.5-flash']);
  assert.equal(list.models[0].name, 'beam-free (gratis)');
  await api(`/api/projects/${id}/settings`, { model: 'opencode-go/beam-free; rm -rf /' });
  assert.equal((await snapshot()).statuses[id].model, '', 'only provider/model ids');
  await api(`/api/projects/${id}/settings`, { model: 'opencode-go/beam-free', engine: 'nope' });
  st = (await snapshot()).statuses[id];
  assert.equal(st.model, 'opencode-go/beam-free');
  assert.equal(st.engine, 'opencode', 'unknown engines are ignored');
});

test('switching engines is refused (409 busy) while a turn runs', async () => {
  const id = await projectId();
  await api(`/api/projects/${id}/settings`, { engine: 'opencode' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'tugas lama' });
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.streaming === true);
  const res = await api(`/api/projects/${id}/settings`, { engine: 'claude' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'busy');
  await api(`/api/projects/${id}/stop`);
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal((await snapshot()).statuses[id].engine, 'opencode');
});

test('a prompt streams, works in the office, fills the to-do board and ends with tokens and cost', async () => {
  const id = await projectId();
  await api(`/api/projects/${id}/settings`, { engine: 'opencode' });
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
  await api(`/api/projects/${id}/settings`, { engine: 'opencode', mode: 'manual' });
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
  await api(`/api/projects/${id}/settings`, { engine: 'opencode', mode: 'auto' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'izin otomatis' });
  const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(result.ok, true);
  assert.equal(seen.slice(mark - 50).filter((s) => s.type === 'approval' && s.obj.project === id && s.obj.status === 'pending' && seen.indexOf(s) >= mark).length, 0);
  await api(`/api/projects/${id}/settings`, { mode: 'manual' });
});

test('stop cancels a running OpenCode turn (session/cancel) and the session stays usable', async () => {
  const id = await projectId();
  await api(`/api/projects/${id}/settings`, { engine: 'opencode' });
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

test('switching back to Claude Code starts a fresh Claude session', async () => {
  const id = await projectId();
  await api(`/api/projects/${id}/settings`, { engine: 'opencode' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'halo' }); // an OpenCode session exists…
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  await api(`/api/projects/${id}/settings`, { engine: 'claude' }); // …and the next prompt goes to Claude Code
  await api(`/api/projects/${id}/prompt`, { text: 'halo' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'divider' && /Claude Code/.test(o.text));
  const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(result.ok, true);
  const final = seen.filter((s) => s.type === 'chat_update' && s.obj.project === id && s.obj.patch.streaming === false).at(-1);
  assert.match(final.obj.patch.text, /Claude palsu/);
});
