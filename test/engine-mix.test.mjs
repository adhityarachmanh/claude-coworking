// "Mesin mengikuti model": the engine is chosen by the model picked in the turn settings, both engines' chats are
// shown as ONE timeline, and switching carries the other engine's context over once (no divider, no model call,
// no queued switch). Full server against the fakes (no network, no real Claude Code/OpenCode).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bridgeNote } from '../src/handoff.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-engine-mix-'));
const DATA = path.join(TMP, 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let token;
let BASE;

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

before(async () => {
  const projects = path.join(TMP, 'projects');
  for (const name of ['alfa', 'beta', 'delta']) {
    mkdirSync(path.join(projects, name), { recursive: true });
    writeFileSync(path.join(projects, name, 'README.md'), `# ${name}\n`);
  }
  mkdirSync(path.join(TMP, 'claude-projects'));
  mkdirSync(path.join(TMP, 'acp-store'));
  BASE = `http://localhost:${await freePort()}`;
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENCODE_')));
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...cleanEnv,
      OFFICE_PORT: new URL(BASE).port,
      OFFICE_DATA_DIR: DATA,
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      FAKE_ACP_STORE: path.join(TMP, 'acp-store'),
      FAKE_ACP_AUTH_FILE: path.join(TMP, 'acp-auth.json'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPENCODE_CONFIG_HOME: path.join(TMP, 'xdg'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale'),
      OFFICE_CLAUDE_CHECK_DELAY_MS: '0',
      FAKE_CLAUDE_SAW: path.join(TMP, 'claude-saw.ndjson'),
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
    server.on('exit', (code) => reject(new Error(`server exited ${code}${stderr.trim() ? `:\n${stderr.trim()}` : ''}`)));
  });
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
});

after(async () => {
  server?.kill();
  await sleep(400);
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

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

async function until(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}

const projectId = async (name) => (await snapshot()).projects.find((p) => p.name === name)?.id;

async function statusOf(id) {
  let status = (await snapshot()).statuses[id];
  if (!status) {
    await api(`/api/projects/${id}/settings`, {});
    status = (await snapshot()).statuses[id];
  }
  return status;
}

/** Prompts `id` and waits for the turn's result row, then for the session to be idle again. */
async function prompt(id, text) {
  const before = (await snapshot()).chats[id]?.length ?? 0;
  assert.equal((await api(`/api/projects/${id}/prompt`, { text })).status, 200);
  await until(async () => ((await snapshot()).chats[id] ?? []).slice(before).some((m) => m.kind === 'result'), `result of "${text}"`);
  await until(async () => (await statusOf(id)).busy === false, `idle after "${text}"`);
}

const state = async () => {
  const file = path.join(DATA, 'state.json');
  await until(() => existsSync(file), 'state.json written');
  return JSON.parse(readFileSync(file, 'utf8'));
};

test('the bridge note masks recognised secrets before it leaves for the other provider', () => {
  const note = bridgeNote(
    [
      { kind: 'user', text: 'pakai token sk-abcdefgh12345678 dan API_KEY=supersecret123 lalu https://user:pass@example.com/x' },
      { kind: 'tool', text: 'curl -H "Authorization: Bearer abcdef123456" https://example.com' },
    ],
    'claude',
  );
  for (const secret of ['sk-abcdefgh12345678', 'supersecret123', 'user:pass@', 'abcdef123456']) {
    assert.ok(!note.includes(secret), `no ${secret} in the note`);
  }
  assert.match(note, /\*\*\*/);
  // The note itself still carries the conversation (only the secret values are gone).
  assert.match(note, /pakai token/);
});

test('a model picked for the other engine switches the engine and is kept as sent (not the old saved one)', async () => {
  const alfa = await projectId('alfa');
  assert.equal((await statusOf(alfa)).engine, 'claude');
  assert.equal((await api(`/api/projects/${alfa}/settings`, { model: 'opus' })).status, 200);
  assert.equal((await statusOf(alfa)).model, 'opus');

  // The same patch carries the engine AND the model: OpenCode keeps the model sent here, not the one it had saved.
  const res = await api(`/api/projects/${alfa}/settings`, { engine: 'opencode', model: 'opencode-go/kimi-k3' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.engine, 'opencode');
  const st = await statusOf(alfa);
  assert.equal(st.engine, 'opencode');
  assert.equal(st.model, 'opencode-go/kimi-k3', 'the model from the patch wins over the engine\'s saved value');
  assert.equal((await state()).settings[alfa].engine, 'opencode');
  assert.deepEqual((await state()).engineSettings[alfa].claude, { model: 'opus', effort: '', agent: '' }, 'Claude\'s own choice is remembered');

  // A patch without a model still loads the target engine's own saved model (back and forth remembers both).
  assert.equal((await api(`/api/projects/${alfa}/settings`, { engine: 'claude' })).status, 200);
  assert.equal((await statusOf(alfa)).model, 'opus');
  assert.equal((await api(`/api/projects/${alfa}/settings`, { engine: 'opencode' })).status, 200);
  assert.equal((await statusOf(alfa)).model, 'opencode-go/kimi-k3');
});

test('the chat is ONE timeline: both engines\' rows, tagged with their engine, oldest first', async () => {
  const alfa = await projectId('alfa');
  await api(`/api/projects/${alfa}/settings`, { engine: 'opencode' });
  await prompt(alfa, 'halo opencode');
  assert.equal((await api(`/api/projects/${alfa}/settings`, { engine: 'claude' })).status, 200);
  await prompt(alfa, 'halo claude');

  const chat = (await snapshot()).chats[alfa];
  assert.ok(chat.length <= 150, 'the snapshot stays bounded');
  const opencodeRow = chat.find((m) => m.text === 'halo opencode');
  const claudeRow = chat.find((m) => m.text === 'halo claude');
  assert.ok(opencodeRow && claudeRow, 'both histories are shown');
  assert.equal(opencodeRow.engine, 'opencode');
  assert.equal(claudeRow.engine, 'claude');
  assert.ok(chat.indexOf(opencodeRow) < chat.indexOf(claudeRow), 'ordered by time');
  for (let i = 1; i < chat.length; i++) assert.ok((chat[i - 1].ts ?? 0) <= (chat[i].ts ?? 0), 'timeline is sorted by ts');
  assert.ok(chat.every((m) => m.engine === 'claude' || m.engine === 'opencode'), 'every row says which engine it came from');
});

test('switching carries the other engine\'s context over ONCE (one info line, no divider, no repeat)', async () => {
  const beta = await projectId('beta');
  assert.equal((await statusOf(beta)).engine, 'claude');
  await prompt(beta, 'kerja claude dulu');
  const before = (await snapshot()).chats[beta];
  assert.ok(before.some((m) => m.text === 'kerja claude dulu'));
  assert.ok(!before.some((m) => m.kind === 'divider'));

  assert.equal((await api(`/api/projects/${beta}/settings`, { engine: 'opencode' })).status, 200);
  let st = await statusOf(beta);
  assert.equal(st.engine, 'opencode');
  assert.equal(st.handoffReady, true, 'the note waits for the next prompt');

  let chat = (await snapshot()).chats[beta];
  let bridges = chat.filter((m) => m.contextBridge);
  assert.equal(bridges.length, 1, 'exactly one context bridge');
  assert.deepEqual([bridges[0].contextBridge.from, bridges[0].contextBridge.to], ['claude', 'opencode']);
  assert.ok(bridges[0].contextBridge.messages >= 2, 'it counts the carried conversation');
  assert.equal(bridges[0].engine, 'opencode', 'the note belongs to the engine it came to');
  assert.ok(!chat.some((m) => m.kind === 'divider'), 'no divider is written any more');

  // Another settings change on the same engine (and more status reads) must not add a second note.
  assert.equal((await api(`/api/projects/${beta}/settings`, { effort: 'low' })).status, 200);
  await statusOf(beta);
  chat = (await snapshot()).chats[beta];
  assert.equal(chat.filter((m) => m.contextBridge).length, 1, 'the bridge is not repeated');

  // Going back without new work carries nothing: the note itself is not "something to carry".
  assert.equal((await api(`/api/projects/${beta}/settings`, { engine: 'claude' })).status, 200);
  chat = (await snapshot()).chats[beta];
  assert.equal(chat.filter((m) => m.contextBridge).length, 1, 'no second bridge on the way back');
  assert.ok(!chat.some((m) => m.kind === 'divider'));
  await switchProject(beta, 'opencode'); // restore for the tests below
});

/** Switches ONE project's engine through its turn settings (the model picks the engine now). */
async function switchProject(id, engine) {
  const res = await api(`/api/projects/${id}/settings`, { engine });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await statusOf(id)).engine, engine);
}

test('no conversation in the old engine: no context bridge at all', async () => {
  const delta = await projectId('delta');
  assert.equal((await api(`/api/projects/${delta}/settings`, { engine: 'opencode' })).status, 200);
  const st = await statusOf(delta);
  assert.equal(st.engine, 'opencode');
  assert.ok(!st.handoffReady, 'no note waits for the next prompt');
  assert.equal(((await snapshot()).chats[delta] ?? []).filter((m) => m.contextBridge).length, 0);
});

test('the old POST /api/projects/:id/engine route is gone', async () => {
  const alfa = await projectId('alfa');
  assert.equal((await api(`/api/projects/${alfa}/engine`, { engine: 'opencode' })).status, 404);
  assert.equal((await api(`/api/projects/${alfa}/engine`, { cancel: true })).status, 404);
});

test('the manual handoff routes are gone (auto-bridge only)', async () => {
  const alfa = await projectId('alfa');
  for (const route of ['handoff/info', 'handoff', 'handoff/apply', 'handoff/context']) {
    assert.equal((await api(`/api/projects/${alfa}/${route}`, { mode: 'quick', text: 'x', clear: true })).status, 404, route);
  }
});

test('the context note is really sent with the next prompt, then not again', async () => {
  const alfa = await projectId('alfa');
  await switchProject(alfa, 'opencode'); // its Claude chat has the conversation to carry
  assert.equal((await statusOf(alfa)).handoffReady, true, 'the note waits for the next prompt');
  await prompt(alfa, 'lanjut setelah pindah');
  // This prompt ran on OpenCode: the note is consumed there (no Claude prompt was sent for it).
  assert.equal((await statusOf(alfa)).handoffReady, false, 'the note is consumed by that prompt');
  await switchProject(alfa, 'claude'); // OpenCode's chat now has the new turn: a note is prepared again
  assert.equal((await statusOf(alfa)).handoffReady, true);
  await prompt(alfa, 'lanjut di claude');
  const after = readFileSync(path.join(TMP, 'claude-saw.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const carried = after.at(-1)?.text ?? '';
  assert.match(carried, /\[KONTEKS SESI/, 'the note rides with the prompt');
  assert.match(carried, /lanjut setelah pindah/, 'it carries the other engine\'s conversation');
  assert.equal((await statusOf(alfa)).handoffReady, false);
  // The following prompt on the same engine is not wrapped again.
  await prompt(alfa, 'tanpa konteks');
  const plain = readFileSync(path.join(TMP, 'claude-saw.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).at(-1)?.text ?? '';
  assert.doesNotMatch(plain, /\[KONTEKS SESI/);
});

test('POST /models lists BOTH engines and keeps the old fields for the running one', async () => {
  const alfa = await projectId('alfa');
  // Bring the Claude catalog in (a Claude session reports it once) before asking for the lists.
  const claude = await until(async () => {
    const body = (await api(`/api/projects/${alfa}/models`)).body;
    return body.engines.claude.models.length ? body : null;
  }, 'Claude models from the catalog');
  assert.equal(claude.engine, 'claude');
  assert.ok(Array.isArray(claude.models) && claude.models.length === 0, 'the old field stays: Claude models live in the app config');
  assert.equal(claude.current, (await statusOf(alfa)).model);
  assert.equal(claude.needsStart, false);
  assert.deepEqual(claude.engines.claude.models.find((m) => m.value === 'fable'), { value: 'fable', name: 'Fable 5.1', efforts: ['low', 'high', 'max'] });

  const oc = await until(async () => {
    const body = (await api(`/api/projects/${alfa}/models`)).body;
    return body.engines.opencode.models.length ? body : null;
  }, 'OpenCode models');
  assert.deepEqual(oc.engines.opencode.models.map((m) => m.value), ['opencode-go/beam-free', 'opencode-go/kimi-k3', 'google/gemini-2.5-flash']);
  assert.deepEqual(oc.engines.opencode.models.map((m) => m.efforts), [['low', 'high', 'max'], [], ['minimal', 'low']]);
  assert.equal(oc.engines.opencode.current, 'opencode-go/kimi-k3', 'the saved OpenCode model is shown while Claude runs');
  assert.equal(oc.engines.opencode.needsStart, false);
  // The old top-level shape is unchanged for the running engine.
  assert.equal(oc.models.length, 0);
  assert.equal(oc.needsStart, false);
});
