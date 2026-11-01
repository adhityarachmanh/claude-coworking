// A server restart in the middle of Claude's turn (against the fake Claude Code in test-support/fake-claude.mjs):
// a clean stop records the turn as cut short and interrupts it, a forced kill is found at the next start, and
// "Lanjutkan" continues in the same session (--resume <same id>). A turn that finished normally leaves nothing.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-restart-'));
const DATA = path.join(TMP, 'data');
const PORT = 4900 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let current = null; // { proc, token, exited: Promise<number|null> }

before(() => {
  mkdirSync(path.join(TMP, 'projects', 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
});

after(async () => {
  current?.proc?.kill();
  await sleep(500);
  // Fake Claude processes orphaned by the forced kill may still hold the folder for a moment.
  rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

/** Starts the server on the shared data dir (same state.json every time) and waits until it answers. */
async function start() {
  const proc = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_DATA_DIR: DATA,
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  let out = '';
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      out += d;
      if (out.includes('berjalan di')) resolve();
    });
    exited.then((code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
  const token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  current = { proc, token, exited, out: () => out };
  return current;
}

function api(p, body = {}) {
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': current.token }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));
}

async function snapshot() {
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

async function until(fn, what, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}

const state = () => JSON.parse(readFileSync(path.join(DATA, 'state.json'), 'utf8'));
const projectId = async () => (await snapshot()).projects.find((p) => p.name === 'toko').id;
/** Clean stop, as scripts/restart.mjs and ⚙ → Matikan server do it. */
async function cleanStop() {
  assert.equal((await api('/api/shutdown')).status, 200);
  assert.equal(await current.exited, 0, 'clean exit');
  current = null;
}

/** Sends a long prompt and waits until the turn runs in a session whose id Claude Code reported. */
async function startLongTurn(id, text) {
  assert.equal((await api(`/api/projects/${id}/prompt`, { text })).status, 200);
  const st = await until(async () => {
    const s = (await snapshot()).statuses[id];
    return s?.busy && s.sessionId && s;
  }, 'turn running');
  // Wait until the reply streams, so the session id in the marker is the one Claude Code reported.
  await until(() => state().turns?.[id]?.sessionId === st.sessionId, 'turn marker on disk');
  return st.sessionId;
}

test('clean stop mid-turn: turn recorded as cut short, notice after the restart, "Lanjutkan" resumes the same session', async () => {
  await start();
  const id = await projectId();
  const sessionId = await startLongTurn(id, 'tugas lama sekali');
  const running = state().turns[id];
  assert.equal(running.prompt, 'tugas lama sekali');
  assert.match(running.uuid, /^[0-9a-f-]{36}$/);

  await cleanStop();
  const stored = state();
  assert.equal(stored.turns[id], undefined, 'no turn left marked as running');
  const cut = stored.interrupted[id];
  assert.equal(cut.reason, 'shutdown');
  assert.equal(cut.sessionId, sessionId);
  assert.equal(cut.prompt, 'tugas lama sekali');
  assert.equal(cut.uuid, running.uuid);
  assert.ok(cut.at >= cut.startedAt);
  // Claude Code was interrupted (not just killed): the turn's result says the server stopped it.
  assert.ok(stored.chats[id].some((m) => m.kind === 'result' && /Server dihentikan/.test(m.text ?? '')), 'interrupted turn closed with a result');

  await start();
  const snap = await snapshot();
  assert.equal(snap.statuses[id].interrupted.reason, 'shutdown');
  assert.equal(snap.statuses[id].interrupted.sessionId, sessionId);
  const notices = snap.chats[id].filter((m) => m.interruptedTurn);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /Server di-restart saat Claude sedang bekerja — giliran terputus/);

  const res = await api(`/api/projects/${id}/continue`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, sessionId, resent: false });
  const reply = await until(async () => (await snapshot()).chats[id].find((m) => m.kind === 'assistant' && /lanjut session=/.test(m.text ?? '')), 'reply of the continued turn');
  assert.equal(reply.text, `lanjut session=${sessionId} resume=${sessionId}`, 'continued with --resume of the same session');
  const after = await snapshot();
  assert.equal(after.statuses[id].interrupted, null);
  assert.equal(after.statuses[id].sessionId, sessionId);
  assert.ok(after.chats[id].some((m) => m.kind === 'user' && /^Lanjutkan pekerjaan yang terputus/.test(m.text)));
  assert.equal((await api(`/api/projects/${id}/continue`)).status, 404, 'nothing left to continue');

  await until(async () => (await snapshot()).statuses[id].busy === false, 'continued turn done');
  await cleanStop();
  assert.deepEqual(state().interrupted, {}, 'an idle stop records nothing');
});

test('forced kill mid-turn (Stop-Process -Force) is found at the next start; the notice can be dismissed', async () => {
  await start();
  const id = await projectId();
  assert.equal((await snapshot()).statuses[id]?.interrupted ?? null, null);
  const sessionId = await startLongTurn(id, 'tugas lama lagi');
  current.proc.kill('SIGKILL');
  await current.exited;
  current = null;
  assert.equal(state().turns[id].sessionId, sessionId, 'the running-turn marker survives the kill');

  await start();
  const snap = await snapshot();
  assert.equal(snap.statuses[id].interrupted.reason, 'crash');
  assert.equal(snap.statuses[id].interrupted.prompt, 'tugas lama lagi');
  assert.match(snap.chats[id].filter((m) => m.interruptedTurn).at(-1).text, /berhenti mendadak .* giliran terputus/);
  assert.equal(state().turns[id], undefined);

  assert.equal((await api(`/api/projects/${id}/continue`, { dismiss: true })).status, 200);
  assert.equal((await snapshot()).statuses[id].interrupted, null);
  assert.equal((await api(`/api/projects/${id}/continue`)).status, 404);
  await cleanStop();

  // Dismissed stays dismissed, and the notice is not repeated on the next start.
  await start();
  const again = await snapshot();
  assert.equal(again.statuses[id]?.interrupted ?? null, null);
  assert.equal(again.chats[id].filter((m) => m.interruptedTurn).length, 2, 'one notice per cut-short turn');
  await cleanStop();
});

test('a turn that finished normally leaves no marker and no notice', async () => {
  await start();
  const id = await projectId();
  const results = async () => (await snapshot()).chats[id].filter((m) => m.kind === 'result').length;
  const before = await results();
  assert.equal((await api(`/api/projects/${id}/prompt`, { text: 'halo' })).status, 200);
  await until(async () => (await results()) > before && (await snapshot()).statuses[id].busy === false, 'turn finished');
  await until(() => !state().turns?.[id], 'marker removed');
  await cleanStop();
  assert.deepEqual(state().turns, {});
  assert.deepEqual(state().interrupted, {});

  await start();
  const snap = await snapshot();
  assert.equal(snap.statuses[id]?.interrupted ?? null, null);
  assert.equal(snap.chats[id].filter((m) => m.interruptedTurn).length, 2, 'no new notice');
  await cleanStop();
});

test('scripts/restart.mjs: clean shutdown, waits for the port, starts again detached', async () => {
  await start();
  const id = await projectId();
  const sessionId = await startLongTurn(id, 'tugas lama via skrip');
  const oldPid = current.proc.pid;
  const env = {
    ...process.env,
    OFFICE_DATA_DIR: DATA,
    PROJECTS_ROOT: path.join(TMP, 'projects'),
    CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
    CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
    CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
  };
  // `--` with nothing after it: no --background (that would log into the app's own data folder).
  const script = spawn(process.execPath, [path.join(APP, 'scripts', 'restart.mjs'), '--port', String(PORT), '--'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  script.stdout.on('data', (d) => (out += d));
  script.stderr.on('data', (d) => (out += d));
  assert.equal(await new Promise((r) => script.on('exit', r)), 0, out);
  assert.equal(await current.exited, 0, 'the old server stopped cleanly');
  assert.match(out, /berjalan lagi/);

  const health = await (await fetch(`${BASE}/health`)).json();
  assert.notEqual(health.pid, oldPid, 'a new server process');
  const token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  current = { token };
  const st = (await snapshot()).statuses[id];
  assert.equal(st.interrupted.reason, 'shutdown');
  assert.equal(st.interrupted.sessionId, sessionId);
  assert.equal((await api(`/api/projects/${id}/continue`, { dismiss: true })).status, 200);
  // The detached server is not our child: stop it over the API and wait until the port is free.
  assert.equal((await api('/api/shutdown')).status, 200);
  await until(async () => !(await fetch(`${BASE}/health`).then(() => true, () => false)), 'detached server stopped');
  current = null;
});
