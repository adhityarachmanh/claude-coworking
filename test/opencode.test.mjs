// OpenCode as the app's engine: the full server against a fake `opencode acp` (test-support/fake-acp.mjs) —
// the engine switch (each engine its own workspace), streaming, tools in the office, the to-do board, approvals
// (allow / reject), auto mode, stop, token + cost into the result line, provider logins (`opencode api`).
// No network, no tokens, no access to your real OpenCode.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-opencode-'));
// 4900–5049: stays clear of 5060/5061, which fetch() refuses as "bad port".
const PORT = 4900 + Math.floor(Math.random() * 150);
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
  mkdirSync(path.join(TMP, 'acp-store'));
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
      FAKE_ACP_STORE: path.join(TMP, 'acp-store'), // the sessions' messages (⏪ Rewind)
      // ⏪ switch files, off until a test creates them
      FAKE_ACP_COMMIT_FAIL: path.join(TMP, 'commit-fail'),
      FAKE_ACP_REVERT_SLOW: path.join(TMP, 'revert-slow'),
      FAKE_ACP_CLEAR_LOG: path.join(TMP, 'revert-clear.log'),
      FAKE_MCP_LOG: path.join(TMP, 'mcp-add.log'),
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
  assert.equal(snap.config.engines.opencode.caps.rewind, true, 'rewind through the session revert of OpenCode');
  assert.equal(snap.config.engines.opencode.caps.team, true);
  assert.equal(snap.config.engines.opencode.caps.effort, true);
  assert.equal(snap.config.engines.opencode.caps.permissions, false, 'Claude permission files are Claude-only');
  assert.equal(snap.config.engines.opencode.caps.extensions, false, 'Claude plugins/agents/hooks are Claude-only');
  assert.equal(snap.config.engines.opencode.caps.search, false, 'conversation search reads Claude transcripts');
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

test('🔁 Lanjutkan dari mesin lain: Cepat (from the stored chat) and Pintar (the other engine\'s read-only fork), both ways', async () => {
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
  const smart = (await api(`/api/projects/${id}/handoff`, { mode: 'smart' })).body;
  assert.match(smart.text, /Handoff palsu dari Claude \(sesi [0-9a-f-]{36}\)/, 'Claude wrote it on its own session (fork, plan)');

  await useEngine('claude');
  const back = (await api(`/api/projects/${id}/handoff/info`)).body;
  assert.equal(back.from, 'opencode');
  assert.match((await api(`/api/projects/${id}/handoff`, { mode: 'quick' })).body.text, /^🔁 Konteks dari OpenCode/);
  assert.match((await api(`/api/projects/${id}/handoff`, { mode: 'smart' })).body.text, /Handoff palsu dari OpenCode \(sesi ses_/);
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
  assert.equal((await api('/api/opencode/logout', { credentialID: go.connections[0].id })).status, 200);
  list = (await api('/api/opencode/providers')).body;
  assert.ok(!list.connected.some((p) => p.id === 'opencode-go'), 'logged out');
});

test('⏪ Rewind OpenCode: prompts from session.message.list, preview from the snapshots, revert + commit, chat greyed, 409 while busy', async () => {
  const id = await projectId();
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
