// Stage 1: one engine per project. The app-wide engine is only the DEFAULT for new projects; every project keeps
// its own engine, its own conversation id per engine and both engines' chat histories (never copied/migrated).
// Full server against the fakes (no network, no real Claude Code/OpenCode).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TaskQueue } from '../src/queue.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-engine-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA = path.join(TMP, 'data');

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
  for (const name of ['alfa', 'beta']) {
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

/** Waits for one named SSE event (the stream starts with a snapshot frame). */
async function nextEvent(type, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(`${BASE}/stream`, { signal: controller.signal });
    const reader = res.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      const match = new RegExp(`event: ${type}\\ndata: (.*)\\n`).exec(buf);
      if (match) {
        reader.cancel().catch(() => {});
        return JSON.parse(match[1]);
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return null;
}

async function until(fn, what, ms = 25_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}

const projectId = async (name) => (await snapshot()).projects.find((p) => p.name === name)?.id;

/** A project's live status; a project nobody touched yet gets its runtime from a settings read/write. */
async function statusOf(id) {
  let status = (await snapshot()).statuses[id];
  if (!status) {
    await api(`/api/projects/${id}/settings`, {});
    status = (await snapshot()).statuses[id];
  }
  return status;
}

/** Prompts `id` and waits for the turn's result row in its chat. */
async function prompt(id, text) {
  const before = (await snapshot()).chats[id]?.length ?? 0;
  assert.equal((await api(`/api/projects/${id}/prompt`, { text })).status, 200);
  await until(async () => ((await snapshot()).chats[id] ?? []).slice(before).some((m) => m.kind === 'result'), `result of "${text}"`);
}

/** Switches ONE project's engine over the API. */
async function switchProject(id, engine) {
  const res = await api(`/api/projects/${id}/engine`, { engine });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await statusOf(id)).engine, engine);
}

const state = () => JSON.parse(readFileSync(path.join(DATA, 'state.json'), 'utf8'));

test('the app-wide engine is only the default: new projects use it, existing ones keep their own', async () => {
  const alfa = await projectId('alfa');
  assert.equal((await statusOf(alfa)).engine, 'claude', 'a fresh install defaults to Claude Code');
  assert.equal((await snapshot()).config.engine, 'claude');

  assert.equal((await api(`/api/projects/${alfa}/engine`, { engine: 'opencode' })).status, 200);
  assert.equal((await statusOf(alfa)).engine, 'opencode');
  assert.equal(state().settings[alfa].engine, 'opencode', 'the project engine is stored with its settings');

  // The app-wide choice moves the default for projects seen from now on...
  assert.equal((await api('/api/engine', { engine: 'claude' })).status, 200);
  assert.equal((await snapshot()).config.engine, 'claude');
  assert.equal((await statusOf(alfa)).engine, 'opencode', 'the default change did NOT move an existing project');
  assert.equal((await api('/api/engine', { engine: 'opencode' })).status, 200);
  mkdirSync(path.join(TMP, 'projects', 'gamma'), { recursive: true });
  assert.equal((await api('/api/projects', { path: path.join(TMP, 'projects', 'gamma') })).status, 200);
  const gamma = await until(() => projectId('gamma'), 'gamma listed');
  assert.equal((await statusOf(gamma)).engine, 'opencode', 'a project seen for the first time starts on the default');
  assert.equal((await statusOf(alfa)).engine, 'opencode', 'still its own choice');
  await api('/api/engine', { engine: 'claude' }); // back to the Claude default for the rest of the suite
  assert.equal((await statusOf(gamma)).engine, 'opencode', 'an existing project stays where it was');
});

test('switching ONE project emits engine{project} so every open client reloads its history', async () => {
  const alfa = await projectId('alfa');
  await switchProject(alfa, 'claude');
  const pending = nextEvent('engine');
  await sleep(300); // let the stream deliver its snapshot before the switch
  await switchProject(alfa, 'opencode');
  const evt = await pending;
  assert.deepEqual(evt, { engine: 'opencode', project: alfa });
});

test('each engine keeps its own model and effort for a project (mode/team stay shared)', async () => {
  const alfa = await projectId('alfa');
  await switchProject(alfa, 'claude');
  assert.equal((await api(`/api/projects/${alfa}/settings`, { model: 'opus', effort: 'high', mode: 'auto' })).status, 200);
  let st = await statusOf(alfa);
  assert.equal(st.model, 'opus');
  assert.equal(st.effort, 'high');

  await switchProject(alfa, 'opencode');
  st = await statusOf(alfa);
  assert.equal(st.model, '', 'the Claude model does not follow the project into OpenCode');
  assert.equal(st.effort, '');
  assert.equal(st.mode, 'auto', 'mode is shared');
  assert.deepEqual(state().engineSettings[alfa].claude, { model: 'opus', effort: 'high', agent: '' });
  await api(`/api/projects/${alfa}/settings`, { model: 'opencode-go/beam-free', effort: 'low' });
  st = await statusOf(alfa);
  assert.equal(st.model, 'opencode-go/beam-free');

  await switchProject(alfa, 'claude');
  st = await statusOf(alfa);
  assert.equal(st.model, 'opus', 'the Claude model comes back exactly as it was');
  assert.equal(st.effort, 'high');
  await switchProject(alfa, 'opencode');
  st = await statusOf(alfa);
  assert.equal(st.model, 'opencode-go/beam-free');
  assert.equal(st.effort, 'low');
});

test('one conversation id per engine, restored when the project switches back', async () => {
  const alfa = await projectId('alfa');
  await switchProject(alfa, 'claude');
  await prompt(alfa, 'halo claude');
  const claudeId = (await statusOf(alfa)).sessionId;
  assert.match(claudeId, /^[0-9a-f-]{36}$/i, 'a Claude Code conversation id');

  await switchProject(alfa, 'opencode');
  await prompt(alfa, 'halo opencode');
  const opencodeId = (await statusOf(alfa)).sessionId;
  assert.match(opencodeId, /^ses_fake/, 'an OpenCode conversation id');
  assert.notEqual(opencodeId, claudeId);

  await switchProject(alfa, 'claude');
  assert.equal((await statusOf(alfa)).sessionId, claudeId, "Claude Code's conversation is resumed, not replaced");
  await switchProject(alfa, 'opencode');
  assert.equal((await statusOf(alfa)).sessionId, opencodeId, "OpenCode's conversation is resumed too");
});

test('chats live in the right folder and switching shows the other history WITHOUT copying it', async () => {
  const alfa = await projectId('alfa');
  // Make sure each engine has a message of its own.
  await switchProject(alfa, 'claude');
  await prompt(alfa, 'pesan claude');
  await switchProject(alfa, 'opencode');
  await prompt(alfa, 'pesan opencode');

  const claudeFile = path.join(DATA, 'chats', `${alfa}.jsonl`);
  const opencodeFile = path.join(DATA, 'chats-opencode', `${alfa}.jsonl`);
  assert.ok(existsSync(claudeFile) && existsSync(opencodeFile), 'one chat file per engine');
  assert.match(readFileSync(claudeFile, 'utf8'), /pesan claude/);
  assert.doesNotMatch(readFileSync(claudeFile, 'utf8'), /pesan opencode/, "OpenCode's messages never land in Claude's file");
  assert.match(readFileSync(opencodeFile, 'utf8'), /pesan opencode/);
  assert.doesNotMatch(readFileSync(opencodeFile, 'utf8'), /pesan claude/);

  const opencodeChat = (await snapshot()).chats[alfa];
  assert.ok(opencodeChat.some((m) => m.text === 'pesan opencode'));
  assert.ok(!opencodeChat.some((m) => m.text === 'pesan claude'), "Claude's history is not in the shown one");

  await switchProject(alfa, 'claude');
  const claudeChat = (await snapshot()).chats[alfa];
  assert.ok(claudeChat.some((m) => m.text === 'pesan claude'));
  assert.ok(!claudeChat.some((m) => m.text === 'pesan opencode'), 'the old engine history is not copied');
  assert.ok(
    claudeChat.some((m) => m.kind === 'divider' && /Mesin project diganti ke Claude Code; riwayat OpenCode tetap tersimpan\./.test(m.text ?? '')),
    'the new history says what happened',
  );
  // The old history is untouched: switching back still shows it, in its own order.
  await switchProject(alfa, 'opencode');
  const back = (await snapshot()).chats[alfa];
  assert.equal(back.filter((m) => m.text === 'pesan opencode').length, 1, 'no duplicate after switching back');
  assert.ok(!back.some((m) => m.text === 'pesan claude'));
});

test('two projects can run on different engines at the same time', async () => {
  const alfa = await projectId('alfa');
  const beta = await projectId('beta');
  await switchProject(alfa, 'opencode');
  await switchProject(beta, 'claude');
  const snap = await snapshot();
  assert.equal(snap.statuses[alfa].engine, 'opencode');
  assert.equal(snap.statuses[beta].engine, 'claude');
  assert.equal(snap.config.engine, 'claude', 'the default is unrelated to what the projects run');
});

test('a project engine switch is refused (409) while busy, while 📋 Antrian waits, and while an approval is open', async () => {
  const alfa = await projectId('alfa');
  await switchProject(alfa, 'opencode');
  // Busy: the fake keeps this turn open until it is cancelled.
  await api(`/api/projects/${alfa}/prompt`, { text: 'macet dulu' });
  await until(async () => (await statusOf(alfa)).busy === true, 'the turn is running');
  const busy = await api(`/api/projects/${alfa}/engine`, { engine: 'claude' });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /bekerja/i);
  await api(`/api/projects/${alfa}/stop`);
  await until(async () => (await statusOf(alfa)).busy === false, 'the turn ended');

  // 📋 Antrian: a waiting item would run on the other engine.
  await api(`/api/projects/${alfa}/queue-pause`, { paused: true });
  const added = (await api(`/api/projects/${alfa}/queue-add`, { text: 'tugas antre' })).body;
  const queued = await api(`/api/projects/${alfa}/engine`, { engine: 'claude' });
  assert.equal(queued.status, 409);
  assert.match(queued.body.error, /Antrian/);
  await api(`/api/projects/${alfa}/queue-remove`, { itemId: added.item.id });
  await api(`/api/projects/${alfa}/queue-pause`, { paused: false });

  // An open permission card.
  await api(`/api/projects/${alfa}/settings`, { mode: 'manual' });
  await api(`/api/projects/${alfa}/prompt`, { text: 'minta izin' });
  // (The card itself is read through the snapshot's approvals list.)
  const card = await until(async () => (await snapshot()).approvals.find((a) => a.project === alfa && a.status === 'pending'), 'the approval card');
  const asking = await api(`/api/projects/${alfa}/engine`, { engine: 'claude' });
  assert.equal(asking.status, 409);
  assert.match(asking.body.error, /izin/i);
  const chatBefore = (await snapshot()).chats[alfa]?.length ?? 0;
  assert.equal((await api(`/api/approvals/${card.id}`, { allow: false, message: 'nanti' })).status, 200);
  // A rejection closes the card and the turn carries on (a follow-up prompt): wait for its result, then idle.
  await until(async () => ((await snapshot()).chats[alfa] ?? []).slice(chatBefore).some((m) => m.kind === 'result'), 'the refused turn result');
  await until(async () => (await statusOf(alfa)).busy === false, 'the refused turn ended');
  await api(`/api/projects/${alfa}/settings`, { mode: 'manual' });

  // Nothing was running/queued/asking: it goes through.
  await switchProject(alfa, 'claude');
  await switchProject(alfa, 'opencode');
});

test('Claude-only surfaces follow the PROJECT engine, not the app-wide default', async () => {
  const alfa = await projectId('alfa');
  const beta = await projectId('beta');
  await switchProject(alfa, 'opencode');
  await switchProject(beta, 'claude');
  const refused = await api(`/api/projects/${alfa}/export-session`, { sessionId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(refused.status, 409, 'an OpenCode project has no Claude transcript to export');
  assert.match(refused.body.error, /Claude Code/);
  const allowed = await api(`/api/projects/${beta}/export-session`, { sessionId: '00000000-0000-0000-0000-000000000000' });
  assert.notEqual(allowed.status, 409, 'a Claude project may use it (the unknown session is another error)');
});

test('purge removes the project from BOTH chat stores, its per-engine settings and sessions', async () => {
  const alfa = await projectId('alfa');
  await switchProject(alfa, 'claude');
  await prompt(alfa, 'terakhir di claude');
  await switchProject(alfa, 'opencode');
  await prompt(alfa, 'terakhir di opencode');
  assert.ok(existsSync(path.join(DATA, 'chats', `${alfa}.jsonl`)));
  assert.ok(existsSync(path.join(DATA, 'chats-opencode', `${alfa}.jsonl`)));

  assert.equal((await api(`/api/projects/${alfa}/purge`, { confirm: alfa })).status, 409, 'folder still there: purging a live project is refused');
  // Close the OpenCode child (it keeps the folder as its cwd), then the folder can go: the project is now an orphan.
  await switchProject(alfa, 'claude');
  await sleep(600);
  rmSync(path.join(TMP, 'projects', 'alfa'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  assert.equal((await api(`/api/projects/${alfa}/purge`, { confirm: alfa })).status, 200);
  assert.ok(!existsSync(path.join(DATA, 'chats', `${alfa}.jsonl`)), "Claude's chat file is gone");
  assert.ok(!existsSync(path.join(DATA, 'chats-opencode', `${alfa}.jsonl`)), "OpenCode's chat file is gone");
  const saved = state();
  assert.equal(saved.settings?.[alfa], undefined, 'its settings are gone');
  assert.equal(saved.engineSettings?.[alfa], undefined, 'its per-engine settings are gone');
  assert.equal(saved.sessionsByEngine?.[alfa], undefined, 'its per-engine session ids are gone');
  assert.equal(saved.sessions?.[alfa], undefined, 'the compatibility mirror is gone too');
  assert.equal((await projectId('alfa')), undefined, 'and it is no longer listed');
});

test('📋 Antrian uses the PROJECT engine (dispatch tier + item engine) and a rate limit pauses only that engine', () => {
  const updates = [];
  const sent = [];
  const project = (id) => ({ id, name: id, path: path.join(TMP, 'projects', id) });
  const hub = {
    dataDir: TMP,
    engine: 'claude', // the app-wide DEFAULT, deliberately not what the project runs on
    projects: new Map([['a', project('a')], ['b', project('b')]]),
    runtime: new Map(),
    persisted: {},
    settingsFor: () => ({ mode: 'manual', model: '', effort: '', modelAuto: true, effortAuto: false, modelTiers: { opencode: { kuat: 'opencode-go/kimi-k3' }, claude: { kuat: 'opus' } } }),
    engineOf: (id) => (id === 'a' ? 'opencode' : 'claude'),
    updateSettings: (id, patch) => updates.push({ id, patch }),
    setStatus() {},
    broadcast() {},
    chat() {},
    save() {},
  };
  const sessions = {
    get: (p) => {
      const session = purposes.get(p.id);
      return session;
    },
  };
  const purposes = new Map(
    ['a', 'b'].map((id) => [id, { project: project(id), busy: false, inflight: new Set(), syncSettings() {}, prompt: (text) => (sent.push({ id, text }), (purposes.get(id).busy = true), { chatId: `m-${id}` }) }]),
  );
  const queue = new TaskQueue({ hub, sessions, delayMs: 600_000, now: () => 1 }); // never dispatch by itself

  // Dispatch: an item for project `a` runs on OpenCode and Model Auto picks the OpenCode ladder, not Claude's.
  const item = queue.add('a', 'halo', { level: 'high', reason: 'tes', source: 'fallback' });
  queue.dispatch('a');
  assert.deepEqual(sent, [{ id: 'a', text: 'halo' }], 'the prompt went to the project\'s session');
  assert.equal(queue.queues.a.items[0].engine, 'opencode', 'the item remembers the engine it was sent to');
  assert.deepEqual(updates.at(-1), { id: 'a', patch: { model: 'opencode-go/kimi-k3', modelAuto: true } });
  assert.equal(queue.engineName(queue.queues.a.items[0], 'a'), 'OpenCode');
  assert.equal(item.id, queue.queues.a.items[0].id);

  // A Claude usage limit must not pause an OpenCode project's queue (and vice versa).
  const waiting = () => ({ id: 'q_wait', status: 'waiting', text: 'x', createdAt: 1, updatedAt: 1, attachments: [] });
  queue.queues = {
    a: { paused: false, reason: null, pausedAt: null, items: [waiting()], budget: { tokensOut: null, costUsd: null, spentTokensOut: 0, spentCostUsd: 0, since: null } },
    b: { paused: false, reason: null, pausedAt: null, items: [waiting()], budget: { tokensOut: null, costUsd: null, spentTokensOut: 0, spentCostUsd: 0, since: null } },
  };
  queue.onRateLimit('b', { status: 'rejected' }); // a Claude session hit its limit
  assert.equal(queue.queues.b.paused, true, "Claude's queue pauses");
  assert.equal(queue.queues.a.paused, false, "OpenCode's queue keeps going");
  assert.equal(queue.queues.b.reason, 'rate_limit');
  queue.onRateLimit('a', { status: 'rejected' }); // now an OpenCode provider limit
  assert.equal(queue.queues.a.paused, true);
  assert.equal(queue.queues.a.reason, 'rate_limit');
  if (queue.fairTimer) clearTimeout(queue.fairTimer);
});

test('a terminal Claude Code session only mirrors into a project that runs on Claude Code', async () => {
  const openDir = path.join(TMP, 'projects', 'mirror-open');
  const claudeDir = path.join(TMP, 'projects', 'mirror-claude');
  for (const dir of [openDir, claudeDir]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'README.md'), '# mirror\n');
  }
  assert.equal((await api('/api/projects', { path: openDir })).status, 200);
  assert.equal((await api('/api/projects', { path: claudeDir })).status, 200);
  const openId = await until(() => projectId('mirror-open'), 'mirror-open listed');
  const claudeId = await until(() => projectId('mirror-claude'), 'mirror-claude listed');
  await switchProject(openId, 'opencode');
  await switchProject(claudeId, 'claude');

  // Transcripts like the ones `claude` writes in a terminal: new files, read from their start.
  const writeTranscript = (sessionId, cwd, text) => {
    const dir = path.join(TMP, 'claude-projects', `mirror-${sessionId.slice(0, 4)}`);
    mkdirSync(dir, { recursive: true });
    const entry = { type: 'user', entrypoint: 'cli', sessionId, cwd, message: { role: 'user', content: text }, promptSource: 'typed', timestamp: new Date().toISOString() };
    writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(entry)}\n`);
  };
  const openText = 'terminal claude di project opencode';
  const claudeText = 'terminal claude di project claude';
  writeTranscript('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', openDir, openText);
  writeTranscript('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', claudeDir, claudeText);

  await until(async () => ((await snapshot()).chats[claudeId] ?? []).some((m) => m.text === claudeText), 'the Claude project mirrors its terminal session');
  await sleep(2500); // a sweep in the meantime would have read the other file too
  const snap = await snapshot();
  assert.ok(!(snap.chats[openId] ?? []).some((m) => m.text === openText), "the OpenCode project's chat does not show it");
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  assert.doesNotMatch(read(path.join(DATA, 'chats', `${openId}.jsonl`)), /terminal claude di project opencode/, "never written into the project's Claude store");
  assert.doesNotMatch(read(path.join(DATA, 'chats-opencode', `${openId}.jsonl`)), /terminal claude di project opencode/, 'nor into its OpenCode store');
  assert.match(read(path.join(DATA, 'chats', `${claudeId}.jsonl`)), /terminal claude di project claude/, 'the Claude project does keep its own');
});

test('listProjects marks a project whose folder is gone (safe purge offer)', async () => {
  const { Hub } = await import('../src/hub.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'office-hub-missing-'));
  try {
    const hub = new Hub({ dataDir: dir });
    const present = path.join(dir, 'present');
    mkdirSync(present, { recursive: true });
    const a = hub.upsertProject(present, 'custom');
    const b = hub.upsertProject(path.join(dir, 'gone-away'), 'custom');
    const list = hub.listProjects();
    assert.equal(list.find((p) => p.id === a.id).missing, false, 'an existing folder is not flagged');
    assert.equal(list.find((p) => p.id === b.id).missing, true, 'a missing folder is flagged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
