// OpenCode as the app's engine: the full server against a fake `opencode acp` (test-support/fake-acp.mjs) —
// the engine switch (each engine its own workspace), streaming, tools in the office, the to-do board, approvals
// (allow / reject), auto mode, stop, token + cost into the result line, provider logins (`opencode api`).
// No network, no tokens, no access to your real OpenCode.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { autoModelFor, shortModelLabel, tierFor } from '../src/model-auto.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-opencode-'));
// 4900–5049: stays clear of 5060/5061, which fetch() refuses as "bad port".
const PORT = 4900 + Math.floor(Math.random() * 150);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A code rewind snapshots the worktree first (src/redo.js), so that test needs a git repository.
let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}
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
  mkdirSync(path.join(TMP, 'acp-store'));
  // Tests must not inherit the environment of an agent runtime that launched them: a nested `opencode` session
  // exports OPENCODE_CONFIG (another project's team file) and OPENCODE_SESSION_ID, which would reach every
  // `opencode acp` child and make "Mode tim off" look broken.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENCODE_')));
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...cleanEnv,
      OFFICE_PORT: String(PORT),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      FAKE_ACP_FAIL_ONCE: path.join(TMP, 'acp-cold-start'), // the first OpenCode process dies: the retry must hide it
      FAKE_ACP_AUTH_FILE: path.join(TMP, 'acp-auth.json'),
      FAKE_ACP_STORE: path.join(TMP, 'acp-store'), // the sessions' messages (⏪ Rewind)
      // ⏪ switch files, off until a test creates them
      FAKE_ACP_COMMIT_FAIL: path.join(TMP, 'commit-fail'),
      FAKE_ACP_REVERT_SLOW: path.join(TMP, 'revert-slow'),
      FAKE_ACP_CLEAR_LOG: path.join(TMP, 'revert-clear.log'),
      FAKE_ACP_SLOW_MODEL: path.join(TMP, 'slow-model'), // a model switch that takes 1.2 s (race test)
      FAKE_ACP_CLI_LOG: path.join(TMP, 'acp-cli.log'),
      FAKE_ACP_COMPACT: path.join(TMP, 'acp-compact'), // ✂ /compact advertised only while this file exists
      FAKE_MCP_LOG: path.join(TMP, 'mcp-add.log'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPENCODE_CONFIG_HOME: path.join(TMP, 'xdg'),
      OFFICE_OPEN_DRY_RUN: '1',
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale'),
      OFFICE_CLAUDE_CHECK_DELAY_MS: '0',
      OFFICE_EFFORT_FAKE: 'high', // Effort Auto is tested without spawning a real classifier model
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let stderr = '';
    server.stderr.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    // The reason the server did not come up (a busy port, a bad setting) must be in the failure, not swallowed by
    // the pipe: without it a red run only says "server exited 1".
    server.on('exit', (code) => reject(new Error(`server exited ${code}${stderr.trim() ? `:\n${stderr.trim()}` : ''}`)));
  });
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  stream = listen();
  // The Go allowance in /api/opencode/providers prices the ledger with this daily cache (src/model-prices.js):
  // a fresh fixture keeps every providers call off the network.
  writeFileSync(
    path.join(TMP, 'data', 'model-prices.json'),
    JSON.stringify({ fetchedAt: Date.now(), source: 'opencode.ai', models: { hy4: { name: 'HY4', input: 0.5, output: 2, cacheRead: 0.05, cacheWrite: 0.1, peakFactor: 1, hasPeak: false } } }),
  );
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
  assert.equal(snap.config.engines.opencode.caps.rewind, true, 'rewind through the session revert of OpenCode');
  assert.equal(snap.config.engines.opencode.caps.team, true);
  assert.equal(snap.config.engines.opencode.caps.effort, true);
  assert.equal(snap.config.engines.opencode.caps.permissions, false, 'Claude permission files are Claude-only');
  assert.equal(snap.config.engines.opencode.caps.extensions, false, 'Claude plugins/agents/hooks are Claude-only');
  assert.equal(snap.config.engines.opencode.caps.search, true, 'conversation search covers Claude and OpenCode sessions');
  assert.deepEqual(snap.config.engines.opencode.caps.modes, ['manual', 'plan'], 'OpenCode shows only Build and Plan');
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
  // each model's own effort levels (OpenCode model.list): [] = none, invalid ids dropped
  assert.deepEqual(list.models.map((m) => m.efforts), [['low', 'high', 'max'], [], ['minimal', 'low']]);
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

test('approvals: OpenCode asks (permission config "ask"), allow runs the tool, ✕ Tolak continues with the rejection note', async () => {
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
  await api(`/api/approvals/${approval.id}`, { allow: false, message: 'pakai cara lain' });
  // OpenCode ends the turn on a rejection; like Claude Code, the work goes on: the note (with the reason) is sent next
  const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.doesNotMatch(result.text ?? '', /Dihentikan/, 'a rejection is not a stop');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'info' && /Izin ditolak/.test(o.text));
  const follow = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'user' && /Saya menolak izin untuk/.test(o.text));
  assert.match(follow.text, /Alasan: pakai cara lain/);
  assert.ok((await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && seen.findIndex((x) => x.obj === o) > seen.findIndex((x) => x.obj === follow))));
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

test('Mode tim: roles as OpenCode subagents (OPENCODE_CONFIG), their tools worked by that role; effort per model', async () => {
  const id = await projectId();
  await useEngine('opencode');
  await api(`/api/projects/${id}/settings`, { team: true, mode: 'auto' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'kerja tim' });
  const delegate = await waitFor((t, o) => t === 'office' && o.project === id && o.kind === 'delegate');
  assert.equal(delegate.role, 'backend', 'the subagent call is a delegation to the Backend role');
  const read = await waitFor((t, o) => t === 'office' && o.project === id && o.kind === 'tool_start' && o.tool === 'Read');
  assert.equal(read.role, 'backend', "the subagent's own read is the Backend's work, not the Lead's");
  assert.equal((await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result')).ok, true);
  assert.ok(readdirSync(path.join(TMP, 'data', 'team')).some((f) => /^opencode-[0-9a-f]{16}\.json$/.test(f)), 'the team config file');

  await api(`/api/projects/${id}/settings`, { effort: 'xhigh' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'cek effort' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(lastText(id), 'effort=max', 'xhigh → the nearest level the model offers');
  await api(`/api/projects/${id}/settings`, { effort: '', team: false, mode: 'manual' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'kerja tim lagi' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(lastText(id), 'tanpa tim', 'Mode tim off: a fresh process without the team config');
});

test('📦 Backup carries OpenCode\'s chats (office/chats-opencode/) and restores them into its parked workspace', async () => {
  await useEngine('claude');
  const zip = Buffer.from(await (await fetch(`${BASE}/api/backup/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: '{}' })).arrayBuffer());
  assert.ok(zip.includes('office/chats-opencode/'), `OpenCode's chat files are in the backup (${zip.length} B: ${zip.subarray(0, 120).toString('latin1')})`);
  assert.ok(zip.includes('office/chats/'), "and Claude Code's as before");
  await useEngine('opencode');

  const { Hub } = await import('../src/hub.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'office-hub-'));
  try {
    const hub = new Hub({ dataDir: dir });
    const msg = (text, ts) => ({ id: `m${ts}`, ts, project: 'old', kind: 'user', text });
    const idMap = new Map([['old', 'proj1']]);
    assert.equal(hub.importEngineChats('opencode', idMap, { old: [msg('dari opencode', 1000), msg('kedua', 2000)] }), 2);
    assert.equal(hub.importEngineChats('opencode', idMap, { old: [msg('dari opencode', 1000)] }), 0, 'idempotent');
    assert.equal(hub.chatOf('proj1').length, 0, "Claude Code's workspace untouched");
    assert.ok(readdirSync(path.join(dir, 'chats-opencode')).includes('proj1.jsonl'));
    hub.switchEngine('opencode');
    assert.deepEqual(hub.chatOf('proj1').map((m) => m.text), ['dari opencode', 'kedua'], 'shown once OpenCode is the engine');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenCode like the real one: its commands, its agents (custom too), the user\'s own permission rules kept', async () => {
  const id = await projectId();
  await useEngine('opencode');
  writeFileSync(path.join(TMP, 'projects', 'toko', 'opencode.json'), '{\n  // aturan milik user\n  "permission": { "bash": { "rm *": "deny", "git *": "ask" }, "webfetch": "deny", },\n}\n');
  await api(`/api/projects/${id}/settings`, { mode: 'auto', agent: 'docs' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'agent?' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(lastText(id), 'agent=docs bash={"*":"allow","rm *":"deny","git *":"allow"}', 'custom agent picked; ⚡ Auto keeps the user\'s deny');
  const st = (await snapshot()).statuses[id];
  assert.deepEqual(st.commands.map((c) => c.name), ['init', 'rilis'], "OpenCode's commands for the autocomplete");
  assert.equal(st.commands[1].argumentHint, '<versi>');
  assert.deepEqual(st.agents.map((a) => a.value), ['build', 'plan', 'docs']);
  await api(`/api/projects/${id}/settings`, { mode: 'plan' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'agent? lagi' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.match(lastText(id), /^agent=plan /, '📋 Rencana dulu = the plan agent, whatever agent is picked');
  await api(`/api/projects/${id}/settings`, { mode: 'manual', agent: '' });
  rmSync(path.join(TMP, 'projects', 'toko', 'opencode.json'));
});

test('OpenCode without the CLI: @file as a file reference, sessions forked / renamed / deleted / exported, AGENTS.md memory', async () => {
  const id = await projectId();
  await useEngine('opencode');
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'link? lihat @README.md dan @tidak-ada.md' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(lastText(id), 'links=README.md', 'existing project files only');

  mark = seen.length;
  const fork = await api(`/api/projects/${id}/session-fork`, { sessionId: 'ses_fakeold' });
  assert.equal(fork.status, 200);
  assert.equal(fork.body.sessionId, 'ses_fork_fakeold');
  assert.equal((await snapshot()).statuses[id].sessionId, 'ses_fork_fakeold', 'continues the copy');
  assert.equal((await api(`/api/projects/${id}/session-rename`, { sessionId: 'ses_fakeold', title: 'Nama baru' })).status, 200);
  assert.equal(readFileSync(path.join(TMP, 'acp-auth.json.title'), 'utf8'), 'ses_fakeold=Nama baru');
  assert.equal((await api(`/api/projects/${id}/session-delete`, { sessionId: 'ses_fork_fakeold' })).status, 409, 'not the open one');
  assert.equal((await api(`/api/projects/${id}/session-delete`, { sessionId: 'ses_fakeold' })).status, 200);
  assert.equal(readFileSync(path.join(TMP, 'acp-auth.json.removed'), 'utf8'), 'ses_fakeold');
  const exp = (await api(`/api/projects/${id}/session-export-json`, { sessionId: 'ses_fakeold' })).body;
  assert.match(exp.name, /^opencode-toko-fakeold\.json$/);
  assert.equal(exp.data.info.title, 'Sesi lama OpenCode');

  const mem = (await api(`/api/projects/${id}/memory`)).body;
  assert.deepEqual(mem.files.map((f) => f.label), ['AGENTS.md (project)', 'AGENTS.md (semua project)'], 'OpenCode reads AGENTS.md');
  assert.equal((await api(`/api/projects/${id}/memory/save`, { key: 'project', content: '# Aturan\n', mtime: mem.file.mtime })).status, 200);
  assert.equal(readFileSync(path.join(TMP, 'projects', 'toko', 'AGENTS.md'), 'utf8'), '# Aturan\n');
  rmSync(path.join(TMP, 'projects', 'toko', 'AGENTS.md'));
});

test('🔌 MCP without the terminal: OpenCode lists opencode.json servers; ＋ Tambah through each engine\'s own `mcp add`', async () => {
  const id = await projectId();
  await useEngine('opencode');
  writeFileSync(path.join(TMP, 'projects', 'toko', 'opencode.json'), JSON.stringify({ mcp: { servers: { github: { type: 'remote', url: 'https://api.example.com/mcp' }, lokal: { type: 'local', command: ['npx', 'srv'], enabled: false } } } }));
  const list = (await api(`/api/projects/${id}/mcp`)).body.servers;
  // configured servers keep their config state unless the service reports them; servers only the service knows join
  assert.deepEqual(list.map((s) => [s.name, s.type, s.status]), [['github', 'remote', 'configured'], ['lokal', 'local', 'disabled'], ['docs', undefined, 'connected'], ['notion', undefined, 'needs-auth'], ['broken', undefined, 'failed']]);
  rmSync(path.join(TMP, 'projects', 'toko', 'opencode.json'));

  const log = () => readFileSync(path.join(TMP, 'mcp-add.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal((await api(`/api/projects/${id}/mcp-add`, { name: 'sentry', kind: 'remote', url: 'https://mcp.sentry.dev/mcp', scope: 'user' })).status, 200);
  assert.deepEqual(log().at(-1), ['opencode', '--global', 'sentry', '--url', 'https://mcp.sentry.dev/mcp']);
  await useEngine('claude');
  assert.equal((await api(`/api/projects/${id}/mcp-add`, { name: 'pw', kind: 'local', command: 'npx -y "@playwright/mcp@latest"', env: ['TOKEN=a b'] })).status, 200);
  assert.deepEqual(log().at(-1), ['claude', '-s', 'local', '-e', 'TOKEN=a b', 'pw', '--', 'npx', '-y', '@playwright/mcp@latest']);
  assert.equal((await api(`/api/projects/${id}/mcp-add`, { name: 'x; rm -rf', kind: 'local', command: 'a' })).status, 400, 'names are checked');
  assert.equal((await api(`/api/projects/${id}/mcp-add`, { name: 'y', kind: 'remote', url: 'file:///etc/passwd' })).status, 400, 'http(s) only');
  await useEngine('opencode');
});

test('🔁 Lanjutkan dari mesin lain: Cepat from the stored chat, Pintar on the ACTIVE engine, both ways', async () => {
  const id = await projectId();
  await useEngine('claude');
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'halo dari claude untuk handoff' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  await useEngine('opencode');
  const info = (await api(`/api/projects/${id}/handoff/info`)).body;
  assert.equal(info.from, 'claude');
  assert.ok(info.messages >= 2);
  assert.equal(info.hasSession, true);
  const quick = (await api(`/api/projects/${id}/handoff`, { mode: 'quick' })).body;
  assert.match(quick.text, /^🔁 Konteks dari Claude Code/);
  assert.match(quick.text, /halo dari claude untuk handoff/, "the other workspace's own messages");
  // A real OpenCode turn with an explicit model, so the reverse handoff has a source chat and an active model.
  await api(`/api/projects/${id}/settings`, { model: 'google/gemini-2.5-flash' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'halo dari opencode untuk handoff' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  const ocActive = (await snapshot()).statuses[id].activeModel;
  assert.equal(ocActive, 'google/gemini-2.5-flash');
  const smart = (await api(`/api/projects/${id}/handoff`, { mode: 'smart' })).body;
  assert.match(smart.text, /Handoff palsu dari OpenCode/, 'the ACTIVE engine (OpenCode) writes it, not Claude');
  assert.ok(smart.text.includes(ocActive), `smart handoff uses the chat's active model (${ocActive}): ${smart.text}`);

  await useEngine('claude');
  const back = (await api(`/api/projects/${id}/handoff/info`)).body;
  assert.equal(back.from, 'opencode');
  assert.match((await api(`/api/projects/${id}/handoff`, { mode: 'quick' })).body.text, /^🔁 Konteks dari OpenCode/);
  const claudeActive = (await snapshot()).statuses[id].activeModel;
  const backSmart = (await api(`/api/projects/${id}/handoff`, { mode: 'smart' })).body;
  assert.match(backSmart.text, /Handoff palsu dari Claude/, 'the ACTIVE engine (Claude) writes it, not OpenCode');
  assert.ok(!claudeActive || backSmart.text.includes(claudeActive), `smart handoff uses the chat's active Claude model (${claudeActive}): ${backSmart.text}`);
  await useEngine('opencode');
});

test('OpenCode provider logins: list, API key, OAuth, logout (through `opencode api`)', async () => {
  let list = (await api('/api/opencode/providers')).body;
  assert.deepEqual(list.connected.map((p) => [p.id, p.connections[0].type]), [['google', 'env']], 'an environment variable counts as connected');
  assert.deepEqual(list.available.map((p) => p.id), ['opencode-go', 'github-copilot', 'google']);
  assert.ok(list.usage?.today, 'the provider response carries local OpenCode usage');
  assert.ok(list.usage.today.total > 0, 'web turns are counted in the local usage');
  assert.ok(list.usage.week.total >= list.usage.today.total);
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
  // A logout needs the typed confirmation, even on the laptop; without it nothing is dropped.
  assert.equal((await api('/api/opencode/logout', { credentialID: go.connections[0].id })).status, 400);
  assert.ok((await api('/api/opencode/providers')).body.connected.some((p) => p.id === 'opencode-go'), 'still logged in');
  assert.equal((await api('/api/opencode/logout', { credentialID: go.connections[0].id, confirm: 'LOGOUT' })).status, 200);
  list = (await api('/api/opencode/providers')).body;
  assert.ok(!list.connected.some((p) => p.id === 'opencode-go'), 'logged out');
});

test('⏪ Rewind OpenCode: prompts from session.message.list, preview from the snapshots, revert + commit, chat greyed, 409 while busy', async (t) => {
  if (!hasGit) return t.skip('git tidak terpasang');
  const id = await projectId();
  // ⏪↩ a git repository: a code rewind captures the uncommitted worktree before it overwrites it.
  const repoDir = path.join(TMP, 'projects', 'toko');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repoDir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'awal');
  await useEngine('opencode');
  await api(`/api/projects/${id}/reset`);
  await api(`/api/projects/${id}/settings`, { mode: 'auto' }); // "tulis" writes without an approval card
  const catatan = path.join(TMP, 'projects', 'toko', 'catatan.md');
  rmSync(catatan, { force: true });
  const send = async (text) => {
    mark = seen.length;
    await api(`/api/projects/${id}/prompt`, { text });
    assert.equal((await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result')).ok, true, text);
    await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);
  };
  const from = seen.length;
  await send('pertama');
  await send('tulis catatan');
  assert.ok(existsSync(catatan), 'the fake really wrote the file');
  await send('ketiga');

  const points = (await api(`/api/projects/${id}/rewind-points`)).body.points;
  assert.deepEqual(points.map((p) => p.text), ['ketiga', 'tulis catatan', 'pertama'], 'newest first');
  assert.ok(points.every((p) => /^msg_[\w-]+$/.test(p.uuid)), 'OpenCode message ids');
  const target = points[1].uuid;
  const pv = (await api(`/api/projects/${id}/rewind-preview`, { uuid: target })).body;
  assert.deepEqual(pv.filesChanged, ['catatan.md'], 'the files of the later turns');
  assert.equal(pv.codeOnly, false, 'OpenCode reverts files only with the conversation');
  assert.match(pv.note, /dihapus dari sesi OpenCode/);
  assert.deepEqual((await api(`/api/projects/${id}/rewind-preview`, { uuid: points[0].uuid })).body.filesChanged, [], 'nothing changed after the last prompt');

  assert.equal((await api(`/api/projects/${id}/rewind-preview`, { uuid: 'msg_../../x' })).status, 400, 'message ids are checked');
  assert.equal((await api(`/api/projects/${id}/rewind`, { uuid: target, code: true })).status, 400, 'no "code only"');
  assert.equal((await api(`/api/projects/${id}/rewind`, { uuid: 'msg_bukan_di_sini', code: true, conversation: true })).status, 400, 'only prompts of this conversation');

  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'tugas lama' });
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.streaming === true);
  assert.equal((await api(`/api/projects/${id}/rewind`, { uuid: target, conversation: true })).status, 409, 'refused while a turn runs');
  await api(`/api/projects/${id}/stop`);
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);

  mark = seen.length;
  const done = await api(`/api/projects/${id}/rewind`, { uuid: target, code: true, conversation: true });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.text, 'tulis catatan', 'the prompt comes back to edit');
  assert.deepEqual(done.body.filesRestored, ['catatan.md']);
  assert.match(done.body.redo.id, /^rd_[a-z0-9]{8,40}$/, 'the undo bundle of the code rewind');
  assert.equal(done.body.redo.files, 1, 'catatan.md is the change the rewind overwrote');
  assert.ok(!existsSync(catatan), 'the file is as before the prompt (it did not exist)');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'divider' && /Kode & percakapan \(1 file\)/.test(o.text));
  assert.deepEqual((await api(`/api/projects/${id}/rewind-points`)).body.points.map((p) => p.text), ['pertama'], 'deleted from the OpenCode session');

  // the chat: "tulis catatan" and everything after it greyed out, "pertama" untouched
  const users = seen.slice(from).filter((s) => s.type === 'chat' && s.obj.project === id && s.obj.kind === 'user');
  const chatId = (text) => users.find((s) => s.obj.text === text).obj.id;
  const rewound = new Set(seen.filter((s) => s.type === 'chat_update' && s.obj.project === id && s.obj.patch.rewound === true).map((s) => s.obj.id));
  assert.ok(rewound.has(chatId('tulis catatan')) && rewound.has(chatId('ketiga')) && rewound.has(chatId('tugas lama')));
  assert.ok(!rewound.has(chatId('pertama')));

  // the next prompt continues the shortened session (a fresh process loads it)
  await send('lanjut');
  assert.deepEqual((await api(`/api/projects/${id}/rewind-points`)).body.points.map((p) => p.text), ['lanjut', 'pertama']);
  // conversation only: the file stays
  await send('tulis lagi');
  assert.ok(existsSync(catatan));
  const again = (await api(`/api/projects/${id}/rewind-points`)).body.points[0].uuid;
  assert.equal((await api(`/api/projects/${id}/rewind`, { uuid: again, conversation: true })).status, 200);
  assert.ok(existsSync(catatan), '💬 Percakapan saja keeps the files');
  await api(`/api/projects/${id}/settings`, { mode: 'manual' });
});

test('⏪ Rewind OpenCode, review regressions: duplicate prompts, prompt / shell / queue / 2nd rewind while rewinding, a failing commit', async () => {
  const id = await projectId();
  await useEngine('opencode');
  await api(`/api/projects/${id}/reset`);
  const send = async (text) => {
    mark = seen.length;
    await api(`/api/projects/${id}/prompt`, { text });
    assert.equal((await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result')).ok, true, text);
    await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);
  };
  const from = seen.length;
  await send('awal');
  await send('lanjut');
  await send('tengah');
  await send('lanjut');
  const points = (await api(`/api/projects/${id}/rewind-points`)).body.points;
  assert.deepEqual(points.map((p) => p.text), ['lanjut', 'tengah', 'lanjut', 'awal']);
  const users = seen.slice(from).filter((s) => s.type === 'chat' && s.obj.project === id && s.obj.kind === 'user').map((s) => s.obj);
  const [, firstLanjut, tengah, lastLanjut] = users;

  // the OLDER "lanjut" (same text twice): its own chat entry and everything after it, not the newer one only
  writeFileSync(path.join(TMP, 'revert-slow'), '1500');
  mark = seen.length;
  const rewinding = api(`/api/projects/${id}/rewind`, { uuid: points[2].uuid, conversation: true });
  await waitFor((t, o) => t === 'status' && o.project === id && o.rewinding === true);
  const prompt = await api(`/api/projects/${id}/prompt`, { text: 'menyela' });
  assert.equal(prompt.status, 409, 'no prompt while rewinding');
  assert.match(prompt.body.error, /Rewind sedang berjalan/);
  assert.equal((await api(`/api/projects/${id}/shell`, { command: 'echo x' })).status, 409, 'no ! shell either');
  assert.equal((await api(`/api/projects/${id}/rewind`, { uuid: points[0].uuid, conversation: true })).status, 409, 'a second rewind is refused');
  assert.equal((await api(`/api/projects/${id}/queue-add`, { text: 'dari antrean' })).status, 200);
  const done = await rewinding;
  rmSync(path.join(TMP, 'revert-slow'), { force: true });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.text, 'lanjut');
  const releasedAt = seen.length;
  await waitFor((t, o) => t === 'status' && o.project === id && o.rewinding === false);
  // the 📋 queue waited for the rewind: its item starts only now, on the shortened session
  const queued = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'user' && o.text === 'dari antrean');
  assert.ok(seen.findIndex((s) => s.obj === queued) > releasedAt, 'dispatched after the rewind');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);
  const rewound = new Set(seen.filter((s) => s.type === 'chat_update' && s.obj.project === id && s.obj.patch.rewound === true).map((s) => s.obj.id));
  assert.ok(rewound.has(firstLanjut.id) && rewound.has(tengah.id) && rewound.has(lastLanjut.id), 'from the older "lanjut" on');
  assert.ok(!rewound.has(users[0].id), '"awal" stays');
  assert.ok(!seen.slice(from).some((s) => s.type === 'chat' && s.obj.project === id && s.obj.kind === 'user' && s.obj.text === 'menyela'), 'the refused prompt never reached the chat');
  assert.deepEqual((await api(`/api/projects/${id}/rewind-points`)).body.points.map((p) => p.text), ['dari antrean', 'awal']);

  // a commit that keeps failing: tried twice, cleared again, an error; nothing greyed out, the conversation intact
  await send('dua');
  const before = (await api(`/api/projects/${id}/rewind-points`)).body.points;
  writeFileSync(path.join(TMP, 'commit-fail'), '1');
  mark = seen.length;
  const failed = await api(`/api/projects/${id}/rewind`, { uuid: before[0].uuid, conversation: true });
  rmSync(path.join(TMP, 'commit-fail'), { force: true });
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /commit gagal.*revert dibatalkan/s);
  assert.equal(readFileSync(path.join(TMP, 'commit-fail.log'), 'utf8').split('\n').filter(Boolean).length, 2, 'commit tried once more');
  assert.ok(readFileSync(path.join(TMP, 'revert-clear.log'), 'utf8').includes((await snapshot()).statuses[id].sessionId), 'session.revert.clear');
  await sleep(200);
  assert.ok(!seen.slice(mark).some((s) => s.type === 'chat_update' && s.obj.project === id && s.obj.patch.rewound === true), 'nothing greyed out');
  assert.deepEqual((await api(`/api/projects/${id}/rewind-points`)).body.points.map((p) => p.text), ['dua', 'dari antrean', 'awal'], 'nothing deleted');
  await send('masih jalan');
});

test('OpenCode admin: update, restart service, import a session JSON; import is OpenCode-only', async () => {
  const id = await projectId();
  await useEngine('opencode');
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false, 20_000).catch(() => {});
  const cli = () => {
    try {
      return readFileSync(path.join(TMP, 'acp-cli.log'), 'utf8');
    } catch {
      return '';
    }
  };

  let r = await api('/api/opencode-check/update');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.match(cli(), /(^|\n)upgrade(\t|$)/m);

  r = await api('/api/opencode-check/restart-service');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.match(cli(), /(^|\n)service restart\t/m);

  const data = { info: { id: 'ses_imported', title: 'Sesi impor' }, messages: [{ role: 'user', text: 'halo' }] };
  r = await api(`/api/projects/${id}/session-import-json`, { data });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sessionId, 'ses_imported');
  assert.match(cli(), /(^|\n)session import .*--directory /m);

  await useEngine('claude');
  r = await api(`/api/projects/${id}/session-import-json`, { data });
  assert.equal(r.status, 409, 'Claude Code does not import OpenCode JSON');
});

test('Global search includes OpenCode session messages (Claude + OpenCode)', async () => {
  const id = await projectId();
  await useEngine('opencode');
  const store = path.join(TMP, 'acp-store', 'ses_fakeold.json');
  writeFileSync(store, JSON.stringify({
    dir: path.join(TMP, 'projects', 'toko'),
    messages: [
      { id: 'msg_search_user', type: 'user', text: 'cari kata ajaib di sesi lama', time: { created: 1000 } },
      { id: 'msg_search_asst', type: 'assistant', content: [{ type: 'text', text: 'kata ajaib ditemukan di checkout' }], time: { created: 1001 } },
    ],
  }));
  try {
    const r = await api(`/api/projects/${id}/search`, { q: 'ajaib', all: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.results.length, 2);
    assert.deepEqual(r.body.results.map((x) => [x.engine, x.source, x.sessionId, x.role]), [
      ['opencode', 'opencode', 'ses_fakeold', 'assistant'],
      ['opencode', 'opencode', 'ses_fakeold', 'user'],
    ]);
    assert.match(r.body.results[0].title, /Sesi lama OpenCode/);
    assert.ok(r.body.sessions >= 1);
  } finally {
    rmSync(store, { force: true });
  }
});

test('OpenCode plugin manager: list, add, remove, update, and check through its CLI', async () => {
  await useEngine('opencode');
  const cli = () => readFileSync(path.join(TMP, 'acp-cli.log'), 'utf8');
  let r = await api('/api/opencode-plugins/list');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.plugins.map((p) => [p.id, p.version, p.source]), [
    ['superpowers', '5bf4e78', 'superpowers@git+https://github.com/obra/superpowers.git'],
  ]);
  assert.match(cli(), /(^|\n)plugin list\t/m);

  r = await api('/api/opencode-plugins/add', { spec: 'foo@1.2.3' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(cli(), /(^|\n)plugin add foo@1\.2\.3\t/m);

  r = await api('/api/opencode-plugins/remove', { spec: 'foo@1.2.3' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(cli(), /(^|\n)plugin remove foo@1\.2\.3\t/m);

  r = await api('/api/opencode-plugins/update', { spec: 'foo@1.2.3' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(cli(), /(^|\n)plugin update foo@1\.2\.3\t/m);

  r = await api('/api/opencode-plugins/check');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(cli(), /(^|\n)plugin check\t/m);

  assert.equal((await api('/api/opencode-plugins/add', { spec: '--bad' })).status, 400);
  assert.equal((await api('/api/opencode-plugins/add', { spec: 'nama dengan spasi' })).status, 400);
});

test('OpenCode config editor: global/project read + save, JSON comments kept, backup, invalid and busy refused', async () => {
  const id = await projectId();
  const projectFile = path.join(TMP, 'projects', 'toko', 'opencode.json');
  const globalFile = path.join(TMP, 'xdg', 'opencode', 'opencode.jsonc');
  rmSync(projectFile, { force: true });
  rmSync(globalFile, { force: true });

  let r = await api('/api/opencode-config', { scope: 'project', projectId: id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.exists, false);
  assert.equal(r.body.path, projectFile);
  assert.equal(r.body.hash, null, 'a missing file has no hash: baseHash null is the lock to send');
  assert.equal(r.body.consolidatable, false, 'nothing to merge yet');

  r = await api('/api/opencode-config/save', {
    scope: 'project',
    projectId: id,
    mode: 'form',
    baseHash: r.body.hash, // null: the file does not exist yet
    form: {
      model: 'anthropic/claude-opus-4',
      smallModel: '',
      agents: [{ name: 'reviewer', mode: 'subagent', model: 'openai/gpt-5', description: 'Review', prompt: 'Be strict' }],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.config.model, 'anthropic/claude-opus-4');
  assert.deepEqual(r.body.agents, [{ name: 'reviewer', mode: 'subagent', model: 'openai/gpt-5', description: 'Review', prompt: 'Be strict' }]);
  assert.ok(r.body.backup === null, 'a new file has no backup');
  assert.equal(JSON.parse(readFileSync(projectFile, 'utf8')).agent.reviewer.system, 'Be strict');

  mkdirSync(path.dirname(globalFile), { recursive: true });
  writeFileSync(globalFile, '{\n  // komentar global\n  "model": "lama",\n}\n');
  r = await api('/api/opencode-config', { scope: 'global' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.path, globalFile);
  r = await api('/api/opencode-config', { scope: 'global' });
  assert.equal(r.body.format, 'jsonc');
  assert.equal(r.body.config.model, 'lama');
  assert.equal(r.body.consolidatable, false, 'consolidation is a project-only action');
  r = await api('/api/opencode-config/save', { scope: 'global', mode: 'json', baseHash: r.body.hash, text: '{\n  // komentar global\n  "model": "baru",\n}\n' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(readFileSync(globalFile, 'utf8'), /komentar global/);
  assert.match(r.body.backup, /opencode-config-backups[\\/]+global[\\/]+.+opencode\.jsonc$/);
  assert.ok(existsSync(r.body.backup), 'the backup is in the app data folder, not next to the config');

  // Every write needs the hash the editor read: read it again for the next save (the form save above changed the file).
  let view = (await api('/api/opencode-config', { scope: 'project', projectId: id })).body;
  const before = readFileSync(projectFile, 'utf8');
  assert.equal((await api('/api/opencode-config/save', { scope: 'project', projectId: id, mode: 'json', text: '{broken', baseHash: view.hash })).status, 400, 'the lock matches, so the JSON error is reported');
  assert.equal(readFileSync(projectFile, 'utf8'), before, 'a refused save changes nothing');
  assert.equal((await api('/api/opencode-config', { scope: 'nope' })).status, 400);
  assert.equal((await api('/api/opencode-config', { scope: 'project', projectId: 'nope' })).status, 404);

  // The lock is mandatory and checked before anything else: absent (not even the property) → 409, file untouched.
  const unlocked = await api('/api/opencode-config/save', { scope: 'project', projectId: id, mode: 'form', form: { model: 'tanpa-lock' } });
  assert.equal(unlocked.status, 409);
  assert.equal(unlocked.body.code, 'lock-missing', 'a 409 names the reason for the editor');
  assert.equal(readFileSync(projectFile, 'utf8'), before, 'a save without baseHash changes nothing');

  await useEngine('opencode');
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'lama sekali' });
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.streaming === true);
  const busySave = await api('/api/opencode-config/save', { scope: 'project', projectId: id, mode: 'form', form: { model: 'x' } });
  assert.equal(busySave.status, 409, 'a running turn wins over the lock');
  assert.equal(busySave.body.code, 'busy');
  await api(`/api/projects/${id}/stop`);
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  view = (await api('/api/opencode-config', { scope: 'project', projectId: id })).body;
  const restarted = await api('/api/opencode-config/save', { scope: 'project', projectId: id, mode: 'form', baseHash: view.hash, form: { model: 'anthropic/claude-opus-4' } });
  assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
  assert.equal(restarted.body.restarted, 1, 'the idle OpenCode process is let go for the next turn');
  rmSync(projectFile, { force: true });
  rmSync(globalFile, { force: true });
});

test('OpenCode config editor: two live sources, backups + restore, consolidate, stale baseHash and a running turn', async () => {
  const id = await projectId();
  const projectDir = path.join(TMP, 'projects', 'toko');
  const rootFile = path.join(projectDir, 'opencode.json');
  const dotFile = path.join(projectDir, '.opencode', 'opencode.json');
  const backupDir = path.join(TMP, 'data', 'opencode-config-backups', id);
  // This test owns its own state: no leftover file from the tests above, no leftover backup to count.
  rmSync(rootFile, { force: true });
  rmSync(path.join(projectDir, '.opencode'), { recursive: true, force: true });
  rmSync(backupDir, { recursive: true, force: true });

  // 1. A root file AND a .opencode file: OpenCode reads both (the later one wins per key), the editor edits the root.
  writeFileSync(rootFile, `${JSON.stringify({ model: 'root-model', instructions: ['root.md'], permission: { bash: 'ask' } }, null, 2)}\n`);
  mkdirSync(path.dirname(dotFile), { recursive: true });
  const dotText = `${JSON.stringify({ model: 'dot-model', instructions: ['dot.md'], small_model: 'dot-small' }, null, 2)}\n`;
  writeFileSync(dotFile, dotText);

  let r = await api('/api/opencode-config', { scope: 'project', projectId: id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.path, rootFile, 'the edited file is the project root');
  assert.match(r.body.hash, /^[0-9a-f]{64}$/, 'the read carries the optimistic-lock hash');
  assert.deepEqual(
    r.body.sources.map((s) => [s.kind, s.format, s.exists]),
    [
      ['project', 'json', true],
      ['project', 'jsonc', false],
      ['dot-opencode', 'json', true],
      ['dot-opencode', 'jsonc', false],
    ],
    'sources in precedence order (root before .opencode)',
  );
  assert.deepEqual(r.body.sources.map((s) => s.path), [
    rootFile,
    path.join(projectDir, 'opencode.jsonc'),
    dotFile,
    path.join(projectDir, '.opencode', 'opencode.jsonc'),
  ]);
  assert.equal(r.body.conflict.effective, dotFile, 'the .opencode file is the effective one');
  assert.equal(r.body.conflict.sameFolder, false);
  assert.deepEqual(r.body.conflict.others, [dotFile]);
  assert.match(r.body.conflict.message, /menang per kunci/);
  assert.equal(r.body.consolidatable, true, 'root + .opencode can be merged right now');

  const readHash = r.body.hash;
  r = await api('/api/opencode-config/save', { scope: 'project', projectId: id, mode: 'form', form: { model: 'anthropic/claude-opus-4' }, baseHash: readHash });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.path, rootFile, 'the save still lands on the root file');
  const rootAfterForm = JSON.parse(readFileSync(rootFile, 'utf8'));
  assert.equal(rootAfterForm.model, 'anthropic/claude-opus-4');
  assert.deepEqual(rootAfterForm.instructions, ['root.md'], "the root's other keys stay");
  assert.equal(readFileSync(dotFile, 'utf8'), dotText, 'the .opencode file is never written');

  // 2. Two saves → two backups newest first; preview is byte exact; restoring the older one is byte exact and
  //    leaves a backup of what it replaced. Every write carries the hash just read.
  const before = (await api('/api/opencode-config/backups', { scope: 'project', projectId: id })).body.backups;
  assert.equal(before.length, 1, 'the form save above backed up the file it replaced');
  const textA = '{\n  "model": "versi-a"\n}\n';
  const textB = '{\n  "model": "versi-b"\n}\n';
  const savedA = await api('/api/opencode-config/save', { scope: 'project', projectId: id, mode: 'json', text: textA, baseHash: r.body.hash });
  assert.equal(savedA.status, 200, JSON.stringify(savedA.body));
  await sleep(30); // distinct mtimes, so "newest first" is not a tie-break
  const savedB = await api('/api/opencode-config/save', { scope: 'project', projectId: id, mode: 'json', text: textB, baseHash: savedA.body.hash });
  assert.equal(savedB.status, 200, JSON.stringify(savedB.body));
  assert.equal(readFileSync(rootFile, 'utf8'), textB);

  const list = (await api('/api/opencode-config/backups', { scope: 'project', projectId: id })).body.backups;
  assert.equal(list.length, before.length + 2, 'one backup per save');
  for (const entry of list) {
    assert.equal(entry.valid, true, `${entry.id} parses`);
    assert.ok(entry.bytes > 0, `${entry.id} has bytes`);
  }
  assert.ok(list[0].at >= list[1].at, 'as an ISO timestamp: newest first');
  const newest = (await api('/api/opencode-config/backup', { scope: 'project', projectId: id, id: list[0].id })).body;
  assert.equal(newest.text, textA, 'the newest backup is the file before the last save');
  assert.equal(newest.bytes, Buffer.byteLength(textA));
  assert.equal((await api('/api/opencode-config/backup', { scope: 'project', projectId: id, id: list[1].id })).body.text, `${JSON.stringify(rootAfterForm, null, 2)}\n`);

  const older = (await api('/api/opencode-config/backup', { scope: 'project', projectId: id, id: list[1].id })).body;
  const restored = await api('/api/opencode-config/restore', { scope: 'project', projectId: id, id: list[1].id, baseHash: savedB.body.hash });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.restored, true);
  assert.equal(readFileSync(rootFile, 'utf8'), older.text, 'restored byte for byte');
  assert.equal(restored.body.text, older.text);
  assert.ok(restored.body.backup && existsSync(restored.body.backup), 'the replaced file is backed up first');
  assert.equal(readFileSync(restored.body.backup, 'utf8'), textB);
  const afterRestore = (await api('/api/opencode-config/backups', { scope: 'project', projectId: id })).body.backups;
  assert.equal(afterRestore.length, list.length + 1);
  assert.equal((await api('/api/opencode-config/backup', { scope: 'project', projectId: id, id: afterRestore[0].id })).body.text, textB, 'an undo point for the restore');
  const secondRestore = await api('/api/opencode-config/restore', { scope: 'project', projectId: id, id: list[0].id, baseHash: savedB.body.hash });
  assert.equal(secondRestore.status, 409, 'the hash from before the restore is stale now');
  assert.equal(secondRestore.body.code, 'stale', 'the editor can tell a stale lock from other 409s');
  assert.equal(readFileSync(rootFile, 'utf8'), older.text, 'a refused restore changes nothing');

  // 3. Consolidate: deep merge into the root (.opencode wins the shared key), the .opencode file is moved away
  //    as a `dot--` manual copy that never shows up in the root's restorable history.
  const dotBefore = readFileSync(dotFile, 'utf8');
  const consolidated = await api('/api/opencode-config/consolidate', { projectId: id, baseHash: restored.body.hash });
  assert.equal(consolidated.status, 200, JSON.stringify(consolidated.body));
  assert.equal(consolidated.body.consolidated, true);
  const merged = JSON.parse(readFileSync(rootFile, 'utf8'));
  assert.equal(merged.model, 'dot-model', 'the .opencode value wins the shared key');
  assert.deepEqual(merged.instructions, ['dot.md'], 'a later array replaces the earlier one');
  assert.deepEqual(merged.permission, { bash: 'ask' }, "the root's other keys stay");
  assert.equal(merged.small_model, 'dot-small');
  assert.equal(existsSync(dotFile), false, 'the .opencode file is moved into the backups');
  assert.ok(Array.isArray(consolidated.body.movedBackups), 'movedBackups is an array');
  assert.equal(consolidated.body.movedBackups.length, 1, 'one .opencode file was moved');
  assert.equal(consolidated.body.movedBackup, consolidated.body.movedBackups[0], 'movedBackup is the first of them');
  assert.match(path.basename(consolidated.body.movedBackup), /^dot--/, 'the moved copy is marked dot--');
  assert.ok(consolidated.body.movedBackup.startsWith(path.join(TMP, 'data', 'opencode-config-backups')), consolidated.body.movedBackup);
  assert.ok(existsSync(consolidated.body.movedBackup));
  assert.equal(readFileSync(consolidated.body.movedBackup, 'utf8'), dotBefore, 'the moved copy is byte identical');
  const afterConsolidate = (await api('/api/opencode-config', { scope: 'project', projectId: id })).body;
  assert.equal(afterConsolidate.conflict, null, 'one source left: no conflict');
  assert.equal(afterConsolidate.consolidatable, false, 'nothing left to merge');
  assert.equal(afterConsolidate.sources.filter((s) => s.exists).length, 1);
  const afterConsolidateList = (await api('/api/opencode-config/backups', { scope: 'project', projectId: id })).body.backups;
  assert.equal(afterConsolidateList.length, afterRestore.length + 1, 'only the root file before the merge is a new backup');
  assert.ok(!afterConsolidateList.some((b) => b.name.startsWith('dot--')), 'the moved .opencode copy is not in the root history');
  assert.ok(!afterConsolidateList.some((b) => b.id === path.basename(consolidated.body.movedBackup)), 'its id is not restorable as the root');

  // 4. The lock is mandatory and checked first: absent → 409; null on an existing file → 409; stale → 409; the file
  //    is never touched.
  const stale = afterConsolidate.hash;
  const outside = '{\n  "model": "diubah-di-luar"\n}\n';
  writeFileSync(rootFile, outside);
  r = await api('/api/opencode-config/save', { scope: 'project', projectId: id, mode: 'json', text: '{"model":"tanpa-lock"}\n' });
  assert.equal(r.status, 409, 'no baseHash property at all');
  assert.equal(r.body.code, 'lock-missing');
  assert.match(r.body.error, /Muat ulang config/);
  r = await api('/api/opencode-config/save', { scope: 'project', projectId: id, mode: 'json', text: '{"model":"lock-null"}\n', baseHash: null });
  assert.equal(r.status, 409, 'null is only for a file that does not exist');
  assert.equal(r.body.code, 'stale');
  r = await api('/api/opencode-config/save', { scope: 'project', projectId: id, mode: 'json', text: '{"model":"dari-aplikasi"}\n', baseHash: stale });
  assert.equal(r.status, 409, 'a stale hash');
  assert.equal(r.body.code, 'stale');
  assert.match(r.body.error, /berubah di luar aplikasi/);
  assert.equal(readFileSync(rootFile, 'utf8'), outside, 'a refused save changes nothing');
  const unlockedRestore = await api('/api/opencode-config/restore', { scope: 'project', projectId: id, id: list[0].id });
  assert.equal(unlockedRestore.status, 409, 'restore needs the lock too');
  assert.equal(unlockedRestore.body.code, 'lock-missing');
  mkdirSync(path.dirname(dotFile), { recursive: true });
  writeFileSync(dotFile, '{"small_model":"dot-lagi"}\n');
  r = await api('/api/opencode-config/consolidate', { projectId: id, baseHash: stale });
  assert.equal(r.status, 409, 'a stale hash for consolidate too');
  assert.equal(r.body.code, 'stale');
  assert.equal(readFileSync(rootFile, 'utf8'), outside, 'a refused consolidate changes nothing');
  assert.ok(existsSync(dotFile), 'nothing was moved');
  const unlockedConsolidate = await api('/api/opencode-config/consolidate', { projectId: id });
  assert.equal(unlockedConsolidate.status, 409, 'consolidate needs the lock too');
  assert.equal(unlockedConsolidate.body.code, 'lock-missing');
  rmSync(dotFile, { force: true });

  // 5. While a turn runs: both restore and consolidate are refused (409) before the lock, then the turn is stopped.
  await useEngine('opencode');
  mkdirSync(path.dirname(dotFile), { recursive: true });
  writeFileSync(dotFile, '{"small_model":"dot-sibuk"}\n');
  const busyView = (await api('/api/opencode-config', { scope: 'project', projectId: id })).body;
  const busyHash = busyView.hash;
  assert.equal(busyView.consolidatable, true, 'the two files are still mergeable when idle');
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'tugas lama' });
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.streaming === true);
  const busyList = (await api('/api/opencode-config/backups', { scope: 'project', projectId: id })).body.backups;
  const busyRestore = await api('/api/opencode-config/restore', { scope: 'project', projectId: id, id: busyList[0].id, baseHash: busyHash });
  assert.equal(busyRestore.status, 409, 'a restore is refused while a turn runs');
  assert.equal(busyRestore.body.code, 'busy', 'the reason is the running turn, not the lock');
  assert.match(busyRestore.body.error, /giliran/);
  const busyConsolidate = await api('/api/opencode-config/consolidate', { projectId: id, baseHash: busyHash });
  assert.equal(busyConsolidate.status, 409, 'a consolidate is refused while a turn runs');
  assert.equal(busyConsolidate.body.code, 'busy');
  assert.match(busyConsolidate.body.error, /giliran/);
  assert.ok(existsSync(dotFile) && readFileSync(rootFile, 'utf8') === outside, 'the refused writes changed nothing');
  await api(`/api/projects/${id}/stop`);
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);

  // The rest of the restore contract through the route: with a valid lock, an unknown id is 404 and an invalid
  // backup is 400 (the lock is checked first, so both need the current hash).
  const current = (await api('/api/opencode-config', { scope: 'project', projectId: id })).body;
  assert.equal((await api('/api/opencode-config/restore', { scope: 'project', projectId: id, id: 'tidak-ada', baseHash: current.hash })).status, 404);
  const legacyFile = path.join(projectDir, 'opencode.json.bak-20200101T000000000Z');
  writeFileSync(legacyFile, '{ rusak');
  const listed = (await api('/api/opencode-config/backups', { scope: 'project', projectId: id })).body.backups;
  const legacy = listed.find((b) => b.legacy);
  assert.ok(legacy, 'a legacy .bak-* file next to the config is listed');
  assert.equal(legacy.valid, false);
  assert.equal((await api('/api/opencode-config/restore', { scope: 'project', projectId: id, id: legacy.id, baseHash: current.hash })).status, 400, 'an invalid backup cannot be restored');
  rmSync(legacyFile, { force: true });

  // Consolidate needs two sources: with the .opencode file gone it is a 400, not a silent no-op.
  rmSync(dotFile, { force: true });
  assert.equal((await api('/api/opencode-config/consolidate', { projectId: id, baseHash: current.hash })).status, 400, 'one source: nothing to merge');

  // 6. Two `.opencode` files (a .json and a shadowed .jsonc): both are moved, `movedBackups` lists both, and only
  //    the .json was read (OpenCode takes the .json when both are in one folder).
  const dotJsonc = path.join(projectDir, '.opencode', 'opencode.jsonc');
  writeFileSync(rootFile, '{"model":"root-lagi"}\n');
  mkdirSync(path.dirname(dotFile), { recursive: true });
  writeFileSync(dotFile, '{"model":"dot-json"}\n');
  writeFileSync(dotJsonc, '{ // komentar\n  "small_model": "dot-jsonc"\n}\n');
  const twoSources = (await api('/api/opencode-config', { scope: 'project', projectId: id })).body;
  assert.equal(twoSources.conflict.sameFolder, true, 'the .jsonc next to the .json is shadowed');
  assert.equal(twoSources.consolidatable, true, 'the shadowed .jsonc still gets moved by a consolidation');
  const twice = await api('/api/opencode-config/consolidate', { projectId: id, baseHash: twoSources.hash });
  assert.equal(twice.status, 200, JSON.stringify(twice.body));
  assert.equal(twice.body.consolidatable, false, 'one file left after the merge');
  assert.equal(twice.body.movedBackups.length, 2, 'every .opencode config file is moved');
  assert.equal(twice.body.movedBackup, twice.body.movedBackups[0], 'movedBackup is the first');
  for (const moved of twice.body.movedBackups) {
    assert.match(path.basename(moved), /^dot--/, moved);
    assert.ok(existsSync(moved), moved);
  }
  assert.equal(existsSync(dotFile), false);
  assert.equal(existsSync(dotJsonc), false);
  const mergedTwice = JSON.parse(readFileSync(rootFile, 'utf8'));
  assert.equal(mergedTwice.model, 'dot-json', 'the shadowed .jsonc value is not merged');
  assert.equal(mergedTwice.small_model, undefined);
  const twiceList = (await api('/api/opencode-config/backups', { scope: 'project', projectId: id })).body.backups;
  assert.ok(!twiceList.some((b) => b.name.startsWith('dot--')), 'neither moved copy is in the root history');

  rmSync(rootFile, { force: true });
  rmSync(path.join(projectDir, '.opencode'), { recursive: true, force: true });
  rmSync(backupDir, { recursive: true, force: true });
});

test('Effort Auto: one classification per prompt, manual stays manual, queue items keep their level', async () => {
  const id = await projectId();
  await useEngine('opencode');
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false, 20_000).catch(() => {});

  assert.equal((await api(`/api/projects/${id}/settings`, { effortAuto: true })).status, 200);
  assert.equal((await snapshot()).statuses[id].effortAuto, true);
  mark = seen.length;
  assert.equal((await api(`/api/projects/${id}/prompt`, { text: 'perbaiki bug kecil' })).status, 200);
  const auto = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'user' && o.autoEffort?.level === 'high');
  assert.equal(auto.autoEffort.source, 'llm');
  assert.equal((await snapshot()).statuses[id].effort, 'high', 'the classified level is what the engine applies');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');

  assert.equal((await api(`/api/projects/${id}/settings`, { effort: 'low', effortAuto: false })).status, 200);
  mark = seen.length;
  assert.equal((await api(`/api/projects/${id}/prompt`, { text: 'halo manual' })).status, 200);
  const manual = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'user' && o.text === 'halo manual');
  assert.equal(manual.autoEffort, undefined, 'manual effort: no classifier badge');
  assert.equal((await snapshot()).statuses[id].effort, 'low');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');

  await api(`/api/projects/${id}/settings`, { effortAuto: true });
  await api(`/api/projects/${id}/queue-pause`, { paused: true });
  const q = await api(`/api/projects/${id}/queue-add`, { text: 'refactor beberapa file dan tambahkan test' });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.item.effort, 'high');
  assert.equal(q.body.item.effortSource, 'llm');
  await api(`/api/projects/${id}/queue-remove`, { itemId: q.body.item.id });
  await api(`/api/projects/${id}/queue-pause`, { paused: false });
});

test('✂ Ringkas konteks (OpenCode): only an advertised /compact runs; absent and busy are 409; focus is ignored', async () => {
  const id = await projectId();
  await useEngine('opencode');
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false, 20_000).catch(() => {});
  rmSync(path.join(TMP, 'acp-compact'), { force: true });

  // A session whose agent does not advertise /compact (the fake's default commands): nothing is sent.
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'halo' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);
  assert.ok(!((await snapshot()).statuses[id].commands ?? []).some((c) => c.name === 'compact'), 'not advertised');
  const absent = await api(`/api/projects/${id}/compact`, { focus: 'abaikan saja' });
  assert.equal(absent.status, 409);
  assert.equal(absent.body.error, 'Mesin OpenCode di sesi ini tidak menyediakan perintah /compact.');
  assert.ok(!seen.slice(mark).some((s) => s.type === 'chat' && s.obj.project === id && s.obj.kind === 'user' && s.obj.text === '/compact'), 'no prompt reached the chat');

  // A fresh session whose agent does advertise it (available_commands_update): /compact goes as a normal prompt.
  writeFileSync(path.join(TMP, 'acp-compact'), '1');
  assert.equal((await api(`/api/projects/${id}/reset`)).status, 200);
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'halo lagi' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);
  assert.ok((await snapshot()).statuses[id].commands.some((c) => c.name === 'compact'), 'advertised by the agent');

  mark = seen.length;
  const res = await api(`/api/projects/${id}/compact`, { focus: 'fokus hanya untuk Claude' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true, engine: 'opencode', command: '/compact', ignoredFocus: true });
  const bubble = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'user' && o.text === '/compact');
  assert.equal(bubble.kind, 'user', 'the slash command is a user bubble');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(lastText(id), 'Konteks diringkas.', 'the turn ran');

  // A running turn: 409, nothing sent, nothing stopped.
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'lama' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'user' && o.text === 'lama');
  const busy = await api(`/api/projects/${id}/compact`);
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /sedang bekerja/);
  assert.ok(!seen.slice(mark).some((s) => s.type === 'chat' && s.obj.project === id && s.obj.kind === 'user' && s.obj.text === '/compact'));
  assert.equal((await snapshot()).statuses[id].busy, true, 'the turn is still running (nothing was stopped)');
  await api(`/api/projects/${id}/stop`);
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);
  rmSync(path.join(TMP, 'acp-compact'), { force: true });
});

// ---------- Model Auto (task-based model selection) ----------
// OFFICE_EFFORT_FAKE=high: every prompt classifies as "high" → tier Kuat → opencode-go/kimi-k3.1-pro.

/** Idle again before the next prompt (polled: an engine switch broadcasts no status event of its own). */
async function settle(id) {
  for (let i = 0; i < 100; i++) {
    if (!(await snapshot()).statuses[id]?.busy) return;
    await sleep(100);
  }
}

test('Model Auto tiers: default per engine, xhigh/max share Maks, an unknown level is Seimbang', () => {
  assert.deepEqual(tierFor('low'), { key: 'hemat', label: 'Hemat', model: 'haiku', engine: 'claude' });
  assert.deepEqual(tierFor('medium'), { key: 'seimbang', label: 'Seimbang', model: 'sonnet', engine: 'claude' });
  assert.deepEqual(tierFor('high'), { key: 'kuat', label: 'Kuat', model: 'opus', engine: 'claude' });
  assert.deepEqual(tierFor('xhigh'), { key: 'maks', label: 'Maks', model: 'fable', engine: 'claude' });
  assert.deepEqual(tierFor('max'), tierFor('xhigh'), 'xhigh and max are the same tier');

  assert.equal(tierFor('low', 'opencode').model, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(tierFor('medium', 'opencode').model, 'opencode-go/glm-5.3');
  assert.equal(tierFor('high', 'opencode').model, 'opencode-go/kimi-k3.1-pro');
  assert.equal(tierFor('xhigh', 'opencode').model, 'opencode-go/kimi-k3');
  assert.equal(tierFor('max', 'opencode').model, 'opencode-go/kimi-k3');

  for (const level of ['', null, undefined, 'bogus', 'AUTO']) {
    const tier = tierFor(level, 'opencode');
    assert.equal(tier.key, 'seimbang', `unknown level ${String(level)} → Seimbang`);
    assert.equal(tier.model, 'opencode-go/glm-5.3');
  }
  assert.equal(autoModelFor('opencode', 'unknown'), 'opencode-go/glm-5.3');
  assert.equal(autoModelFor('claude', 'unknown'), 'sonnet', 'unknown level never picks a big model');
  assert.equal(autoModelFor('mesin-lain', 'high'), 'opus', 'an unknown engine falls back to Claude model aliases');
  assert.equal(shortModelLabel('opencode-go/kimi-k3.1-pro'), 'kimi-k3.1-pro');
  assert.equal(shortModelLabel('opus'), 'opus');
  assert.ok(shortModelLabel('x'.repeat(80)).length <= 40);
});

test('Model Auto: the classified tier becomes the applied model; a manual pick ends Auto', async () => {
  const id = await projectId();
  await useEngine('opencode');
  await settle(id);
  // Start from a manual model so the first Auto turn really has to switch.
  assert.equal((await api(`/api/projects/${id}/settings`, { effortAuto: false, effort: '', model: 'opencode-go/beam-free' })).status, 200);
  assert.equal((await snapshot()).statuses[id].modelAuto, false, 'a manual model pick keeps Auto off');
  assert.equal((await api(`/api/projects/${id}/settings`, { modelAuto: true })).status, 200);
  let st = (await snapshot()).statuses[id];
  assert.equal(st.modelAuto, true);
  assert.equal(st.model, 'opencode-go/beam-free', 'turning Auto on does not switch the model by itself');

  const from = seen.length;
  const res = await api(`/api/projects/${id}/prompt`, { text: 'perbaiki bug kecil' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.autoEffort, null, 'Effort Auto is off: no level applied');
  assert.equal(res.body.autoModel.tier, 'kuat');
  assert.equal(res.body.autoModel.model, 'opencode-go/kimi-k3.1-pro');
  assert.ok(res.body.autoModel.reason, 'the classifier reason rides along');
  const note = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'info' && o.modelAuto === true);
  assert.match(note.text, /^🤖 Model Auto: Kuat → kimi-k3\.1-pro/);
  st = (await snapshot()).statuses[id];
  assert.equal(st.model, 'opencode-go/kimi-k3.1-pro', 'the tier model is what the session applies');
  assert.equal(st.modelAuto, true, 'Auto stays on after its own switch');
  assert.equal(st.effort, '', 'Model Auto never touches the effort');
  await settle(id); // the turn is over

  // The same tier again: nothing changes, so no second chat note.
  const fromAgain = seen.length;
  const again = await api(`/api/projects/${id}/prompt`, { text: 'perbaiki bug lain' });
  assert.equal(again.body.autoModel, null, 'same model: nothing to switch or announce');
  await settle(id);
  assert.ok(!seen.slice(fromAgain).some((s) => s.type === 'chat' && s.obj.modelAuto === true), 'no note without a switch');
  assert.ok(seen.slice(from).some((s) => s.type === 'chat' && s.obj.modelAuto === true), 'the first switch was announced');

  // A manual model pick is a manual choice: Auto ends (the bug-fix handler never runs the classifier again).
  assert.equal((await api(`/api/projects/${id}/settings`, { model: 'opencode-go/beam-free' })).status, 200);
  st = (await snapshot()).statuses[id];
  assert.equal(st.modelAuto, false, 'picking a model by hand clears Model Auto');
  assert.equal(st.model, 'opencode-go/beam-free');
  mark = seen.length;
  const manual = await api(`/api/projects/${id}/prompt`, { text: 'halo manual' });
  assert.equal(manual.body.autoModel, null);
  assert.equal(manual.body.autoEffort, null, 'no classifier ran');
  await settle(id);
  st = (await snapshot()).statuses[id];
  assert.equal(st.model, 'opencode-go/beam-free', 'manual model stays what the user picked');
  assert.equal(st.modelAuto, false);
  // Default ('' ) is a manual choice too, and 'auto' is never stored as a model.
  assert.equal((await api(`/api/projects/${id}/settings`, { modelAuto: true, model: 'auto' })).status, 200);
  st = (await snapshot()).statuses[id];
  assert.notEqual(st.model, 'auto');
  assert.equal(st.model, 'opencode-go/beam-free', 'an invalid model value is ignored');
  assert.equal((await api(`/api/projects/${id}/settings`, { model: '', modelAuto: true })).status, 200);
  st = (await snapshot()).statuses[id];
  assert.equal(st.model, '', 'Default clears the model');
  assert.equal(st.modelAuto, true, 'but an explicit modelAuto: true in the same request keeps Auto on');
  await api(`/api/projects/${id}/settings`, { model: 'opencode-go/beam-free', modelAuto: false });
});

test('Model Auto: a custom ladder replaces a tier, an invalid model is dropped, clearing the slot returns the default', async () => {
  const id = await projectId();
  await useEngine('opencode');
  await settle(id);
  await api(`/api/projects/${id}/settings`, { effortAuto: false, effort: '', model: 'opencode-go/beam-free', modelAuto: true, modelTiers: { opencode: { kuat: 'opencode-go/kimi-k3' } } });
  let st = (await snapshot()).statuses[id];
  assert.deepEqual(st.modelTiers, { opencode: { kuat: 'opencode-go/kimi-k3' } }, 'the ladder is part of the status');
  assert.equal(st.model, 'opencode-go/beam-free', 'storing a ladder never switches the model by itself');

  // An invalid model is dropped; the valid slot in the same patch is stored.
  await api(`/api/projects/${id}/settings`, { modelTiers: { opencode: { kuat: 'tanpa-provider', hemat: 'opencode-go/mimo-v2.6-flash' } } });
  st = (await snapshot()).statuses[id];
  assert.deepEqual(st.modelTiers, { opencode: { kuat: 'opencode-go/kimi-k3', hemat: 'opencode-go/mimo-v2.6-flash' } }, 'the previous kuat survives an invalid value');

  const res = await api(`/api/projects/${id}/prompt`, { text: 'perbaiki bug kecil' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.autoModel.tier, 'kuat');
  assert.equal(res.body.autoModel.model, 'opencode-go/kimi-k3', 'the classified tier uses the custom model');
  assert.equal((await snapshot()).statuses[id].model, 'opencode-go/kimi-k3', 'the custom model is what the session applies');
  await settle(id);

  // '' clears the slot: the default model of that tier comes back on the next prompt.
  await api(`/api/projects/${id}/settings`, { modelTiers: { opencode: { kuat: '' } } });
  const back = await api(`/api/projects/${id}/prompt`, { text: 'perbaiki bug lain' });
  assert.equal(back.body.autoModel.tier, 'kuat');
  assert.equal(back.body.autoModel.model, 'opencode-go/kimi-k3.1-pro', 'cleared slot → the default');
  await settle(id);
  assert.equal((await snapshot()).statuses[id].model, 'opencode-go/kimi-k3.1-pro');

  await api(`/api/projects/${id}/settings`, { model: 'opencode-go/beam-free', modelAuto: false, modelTiers: { opencode: { hemat: '' } } });
  assert.deepEqual((await snapshot()).statuses[id].modelTiers, {}, 'an empty ladder leaves no key in the status');
});

test('Model Auto: a slow model switch finishes before the prompt is sent (no stuck turn)', async () => {
  const id = await projectId();
  await useEngine('opencode');
  await settle(id);
  // A warm session on a manual model, so the Auto switch really has to change it.
  await api(`/api/projects/${id}/settings`, { effortAuto: false, effort: '', model: 'opencode-go/beam-free', modelAuto: false });
  await api(`/api/projects/${id}/prompt`, { text: 'halo hangat' });
  await settle(id);
  await api(`/api/projects/${id}/settings`, { modelAuto: true });
  mark = seen.length;
  writeFileSync(path.join(TMP, 'slow-model'), '1'); // the fake takes 1.2 s to change the model
  try {
    const started = Date.now();
    assert.equal((await api(`/api/projects/${id}/prompt`, { text: 'model?' })).status, 200);
    const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result', 15_000);
    assert.equal(result.ok, true, 'the turn finishes instead of hanging');
    assert.equal(lastText(id), 'model=opencode-go/kimi-k3.1-pro', 'the prompt ran after the model switch, not during it');
    assert.ok(Date.now() - started < 15_000);
  } finally {
    rmSync(path.join(TMP, 'slow-model'), { force: true });
    await api(`/api/projects/${id}/settings`, { model: 'opencode-go/beam-free', modelAuto: false });
  }
  await settle(id);
});

test('Model Auto: a prompt sent mid-turn keeps the model of the running turn (no switch under it)', async (t) => {
  const id = await projectId();
  t.after(() => api(`/api/projects/${id}/stop`).catch(() => {})); // a failed assertion must not leave the long turn running
  await useEngine('opencode');
  await settle(id);
  await api(`/api/projects/${id}/settings`, { effortAuto: false, modelAuto: true, model: 'opencode-go/beam-free' });
  mark = seen.length;
  const first = await api(`/api/projects/${id}/prompt`, { text: 'tugas lama' });
  assert.equal(first.body.autoModel.tier, 'kuat');
  assert.equal(first.body.autoModel.model, 'opencode-go/kimi-k3.1-pro', JSON.stringify(first.body));
  const note = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'info' && o.modelAuto === true);
  assert.match(note.text, /^🤖 Model Auto: Kuat → kimi-k3\.1-pro/);
  assert.equal((await snapshot()).statuses[id].busy, true, 'the turn is still running');

  const before = seen.filter((s) => s.type === 'chat' && s.obj.modelAuto === true).length;
  mark = seen.length;
  const mid = await api(`/api/projects/${id}/prompt`, { text: 'pesan susulan' });
  assert.equal(mid.status, 200);
  assert.deepEqual(mid.body.autoModel, { skipped: 'busy', reason: 'Mengikuti model turn yang sedang berjalan' });
  assert.equal(mid.body.autoEffort, null);
  const st = (await snapshot()).statuses[id];
  assert.equal(st.model, 'opencode-go/kimi-k3.1-pro', 'the running turn keeps its model');
  assert.equal(st.modelAuto, true);
  assert.equal(seen.filter((s) => s.type === 'chat' && s.obj.modelAuto === true).length, before, 'no switch, no extra note');
  await api(`/api/projects/${id}/stop`);
  await settle(id);
  assert.equal((await snapshot()).statuses[id].busy, false, 'Stop ended the turn');
  await api(`/api/projects/${id}/settings`, { modelAuto: false, model: 'opencode-go/beam-free' });
});

test('Model Auto on a queue item: classified at enqueue, tier applied at dispatch, Effort Auto untouched', async () => {
  const id = await projectId();
  await useEngine('opencode');
  await settle(id);
  await api(`/api/projects/${id}/settings`, { effortAuto: false, effort: '', modelAuto: true, model: 'opencode-go/beam-free' });
  await api(`/api/projects/${id}/queue-pause`, { paused: true });
  const added = await api(`/api/projects/${id}/queue-add`, { text: 'refactor beberapa file dan tambahkan test' });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.item.effort, 'high', 'the level is classified even though only Model Auto is on');
  assert.equal(added.body.item.effortSource, 'llm');
  assert.equal((await snapshot()).statuses[id].model, 'opencode-go/beam-free', 'nothing changes while the queue is paused');

  mark = seen.length;
  assert.equal((await api(`/api/projects/${id}/queue-pause`, { paused: false })).status, 200);
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'user' && o.queueItem === added.body.item.id);
  // The item's own record says when its turn is over (no event ordering to rely on).
  let item = null;
  for (let i = 0; i < 100; i++) {
    item = (await api(`/api/projects/${id}/queue`)).body.queue.items.find((x) => x.id === added.body.item.id) ?? null;
    if (item && item.status !== 'waiting' && item.status !== 'running') break;
    await sleep(100);
  }
  assert.equal(item?.status, 'done', JSON.stringify(item));
  const st = (await snapshot()).statuses[id];
  assert.equal(st.model, 'opencode-go/kimi-k3.1-pro', 'dispatch applied the tier for the item\'s level');
  assert.equal(st.modelAuto, true);
  assert.equal(st.effort, '', 'the level never becomes an effort while Effort Auto is off');
  assert.equal((await api(`/api/projects/${id}/settings`, { modelAuto: false, model: 'opencode-go/beam-free' })).status, 200);
});

// ---------- safe provider switching (👤 Akun): confirmation, no silent model replacement, queue paused ----------

test('OpenCode logout needs LOGOUT; the model of the logged-out provider is refused (409) until another is picked', async () => {
  const id = await projectId();
  await useEngine('opencode');
  await settle(id);
  await api(`/api/projects/${id}/settings`, { modelAuto: false, effortAuto: false, model: 'opencode-go/beam-free' });
  // A turn on that provider's model: the status then carries it as the active model.
  mark = seen.length;
  assert.equal((await api(`/api/projects/${id}/prompt`, { text: 'halo provider' })).status, 200);
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);
  assert.equal((await snapshot()).statuses[id].activeModel, 'opencode-go/beam-free');

  // A stored credential for opencode-go, and a queue with one item (paused, so nothing runs during the switch).
  assert.equal((await api('/api/opencode/login/key', { provider: 'opencode-go', key: 'sk-benar' })).status, 200);
  const providers = (await api('/api/opencode/providers')).body;
  const go = providers.connected.find((p) => p.id === 'opencode-go');
  const cred = go?.connections.find((c) => c.type === 'credential')?.id;
  assert.ok(cred, 'a credential to log out');
  await api(`/api/projects/${id}/queue-pause`, { paused: true });
  const added = await api(`/api/projects/${id}/queue-add`, { text: 'tugas setelah ganti provider' });
  assert.equal(added.status, 200, JSON.stringify(added.body));

  // Without the typed confirmation nothing is dropped (the laptop is held to it too).
  const refused = await api('/api/opencode/logout', { credentialID: cred });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'Ketik LOGOUT untuk konfirmasi logout provider dari HP.');
  assert.ok((await api('/api/opencode/providers')).body.connected.some((p) => p.id === 'opencode-go'), 'nothing logged out');

  // Confirmed: the provider goes, the active model is marked stale (never replaced), every queue pauses.
  mark = seen.length;
  assert.equal((await api('/api/opencode/logout', { credentialID: cred, confirm: 'LOGOUT' })).status, 200);
  const left = (await api('/api/opencode/providers')).body.connected.map((p) => [p.id, p.connections.map((c) => c.id ?? c.type)]);
  assert.ok(!left.some(([id]) => id === 'opencode-go'), `logged out: ${JSON.stringify(left)}`);
  const warning = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'info' && o.modelStale === true);
  assert.equal(warning.text, '⚠ Model aktif (opencode-go/beam-free) berasal dari provider opencode-go yang baru logout. Pilih model lain atau Default.');
  const status = (await snapshot()).statuses[id];
  assert.equal(status.modelStale, true);
  assert.equal(status.model, 'opencode-go/beam-free', 'the model is not changed behind the user');
  assert.equal(status.taskQueue.paused, true);
  assert.equal(status.taskQueue.reason, 'account');

  // The next prompt is refused until the user picks another model (or Default).
  const blocked = await api(`/api/projects/${id}/prompt`, { text: 'pakai model yang sudah logout' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'Model aktif tidak tersedia (provider sudah logout). Pilih model lain atau Default dulu.');

  // Picking a model clears the warning; the next prompt works again.
  assert.equal((await api(`/api/projects/${id}/settings`, { model: 'google/gemini-2.5-flash' })).status, 200);
  assert.equal((await snapshot()).statuses[id].modelStale, false);
  mark = seen.length;
  assert.equal((await api(`/api/projects/${id}/prompt`, { text: 'pakai model lain' })).status, 200);
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);

  // Cleanup for the other tests: no leftover queue item, Default model back.
  await api(`/api/projects/${id}/queue-remove`, { itemId: added.body.item.id });
  await api(`/api/projects/${id}/queue-pause`, { paused: false });
  await api(`/api/projects/${id}/settings`, { model: '' });
});
