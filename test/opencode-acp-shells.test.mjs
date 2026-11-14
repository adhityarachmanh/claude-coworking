// OpenCode as an ACP engine (test-support/fake-acp.mjs): the shells of ACP-hosted sessions (the service cannot see
// them) and the mid-turn prompt queue (a follow-up must never interrupt a running tool). No network, no tokens, no
// access to your real OpenCode or your real processes: the guarded stop is exercised only up to the fail-closed 409
// (nothing matches), and the kill matcher itself is unit-tested with a fake process table (test/opencode-shells.test.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-acp-shells-'));
const PORT = 4820 + Math.floor(Math.random() * 50);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHELL_DIR = path.join(TMP, 'shell'); // OpenCode's shell/ folder under its data dir
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
      FAKE_ACP_AUTH_FILE: path.join(TMP, 'acp-auth.json'),
      FAKE_ACP_STORE: path.join(TMP, 'acp-store'), // the sessions' messages (⏪ + the prompt-queue test)
      FAKE_ACP_SHELL_OUT_DIR: SHELL_DIR, // the fake writes its shells' .out files here
      OFFICE_OPENCODE_SHELL_DIR: SHELL_DIR, // the app reads them there
      OFFICE_SHELL_WATCH_MS: '300', // the stuck chip's file watcher runs fast in tests
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPENCODE_CONFIG_HOME: path.join(TMP, 'xdg'),
      OFFICE_OPEN_DRY_RUN: '1',
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale'),
      OFFICE_CLAUDE_CHECK_DELAY_MS: '0',
      OFFICE_EFFORT_FAKE: 'high',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-4000); if (String(d).trim()) console.error('[server-err]', String(d).trim().slice(0, 500)); });
  server.stdout.on('data', (d) => { if (String(d).includes('berjalan di')) return; if (String(d).trim()) console.error('[server]', String(d).trim().slice(0, 400)); });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && (console.error('[boot] listening seen'), resolve()));
    server.on('exit', (code) => { console.error(`[boot] server exited ${code}:\n${stderr.trim()}`); reject(new Error(`server exited ${code}:\n${stderr.trim()}`)); });
  });
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  console.error('[boot] token ok');
  stream = listen();
  id = (await snapshot()).projects.find((p) => p.name === 'toko').id;
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

function waitFor(pred, ms = 15000) {
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

let id;
const tasks = () => (snapshot().then((s) => s.statuses[id].tasks ?? []));
const task = (tid) => tasks().then((l) => l.find((t) => t.id === tid) ?? null);

test('⧗ a shell call tagged with metadata becomes a task with the live output of its .out file', async () => {
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'shellberkas' });
  let started;
  started = await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc:sh_fake1' && x.status === 'running'));
  const t = started.tasks.find((x) => x.id === 'oc:sh_fake1');
  assert.deepEqual([t.kind, t.background, t.command], ['shell', false, 'echo shell-berkas']);
  assert.equal(t.source, 'acp');
  // the chat row carries the task id: live output in the row
  let row = null;
  for (let i = 0; i < 40 && !row; i++) {
    await sleep(200);
    row = ((await snapshot()).chats?.[id] ?? []).find((c) => c.taskId === 'oc:sh_fake1');
  }
  assert.ok(row, 'the chat row carries the task id');
  // the output comes from the file OpenCode wrote, not from the (blind) service
  const out = await api(`/api/projects/${id}/task-output`, { taskId: 'oc:sh_fake1' });
  assert.equal(out.status, 200);
  assert.equal(out.body.output, 'berkas: mulai\n');
  assert.equal(out.body.truncated, false);
  // the file's mtime feeds the stuck chip (written back-dated: lastActivityAt must follow the file, not the clock)
  const outFile = path.join(SHELL_DIR, 'projek-palsu', 'sh_fake1.out');
  const past = Date.now() - 4 * 60_000;
  utimesSync(outFile, new Date(past), new Date(past));
  await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc:sh_fake1' && Math.abs((x.lastActivityAt ?? 0) - past) < 5000), 8000);
  // the call completes: the task ends with it (its outcome), and the turn ends normally
  const done = await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc:sh_fake1' && x.status !== 'running'));
  assert.equal(done.tasks.find((x) => x.id === 'oc:sh_fake1').status, 'completed');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok === true);
  // the file is stale now: it must never resurrect the finished task
  utimesSync(outFile, new Date(), new Date());
  await sleep(1200); // one watcher tick (300 ms) would have re-emitted if the state came from the file
  assert.equal((await task('oc:sh_fake1')).status, 'completed');
});

test('⧗ stop on a task of this kind fails closed (409) when no unique process matches', async () => {
  const res = await api(`/api/projects/${id}/task-stop`, { taskId: 'oc:sh_fake1' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(String(res.body.error), /tidak ditemukan secara unik/);
});

test('⧗ a background shell (metadata.background) keeps its task running past the turn', async () => {
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'shelllatar' });
  await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc:sh_fake2' && x.status === 'running' && x.background === true));
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok === true);
  await sleep(300);
  assert.equal((await task('oc:sh_fake2')).status, 'running', 'the shell carries on; the turn did not close it');
  const out = await api(`/api/projects/${id}/task-output`, { taskId: 'oc:sh_fake2' });
  assert.equal(out.body.output, 'latar: mulai\nlatar: selesai\n');
  const stop = await api(`/api/projects/${id}/task-stop`, { taskId: 'oc:sh_fake2' });
  assert.equal(stop.status, 409, 'no unique process matches here (no real kill in tests)');
});

test('⧗ a turn ends with its still-open shell call: the task is closed, never by a stale file', async () => {
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'shellgantung' });
  await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc:sh_fake3' && x.status === 'running'));
  const res = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok === true);
  assert.ok(res, 'the turn ended while the call was still open');
  const closed = await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc:sh_fake3' && x.status !== 'running'));
  assert.equal(closed.tasks.find((x) => x.id === 'oc:sh_fake3').status, 'completed');
});

test('a delegated step whose final update never arrives is closed by a synthetic result at turn end', async () => {
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'langkahgantung' });
  // the step's row exists as a running tool while the turn runs…
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'assistant' && (o.message?.content ?? []).some((c) => c.type === 'tool_use' && c.id === 'call-step-hang'));
  // …and the turn ends without any final update for it.
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok === true);
  // the app must close the row itself: a synthetic tool_result, before the turn's line, never an endless spinner
  await waitFor((t, o) => {
    if (t !== 'chat' || o.project !== id || o.kind !== 'user') return false;
    return (o.message?.content ?? []).some((c) => c.type === 'tool_result' && c.tool_use_id === 'call-step-hang' && /Giliran selesai/.test(c.content ?? ''));
  }, 8000);
  // and nothing stays "working" afterwards: the office is honest about being idle
  const s = await snapshot();
  assert.deepEqual(s.statuses[id].working ?? {}, {}, 'no role is left working by a lost step');
});

test('a delegation that outlives its turn closes its step rows as the late results arrive', async () => {
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'delegasilatar' });
  // the turn's answer resolves while the delegation is still open…
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok === true);
  // …and its steps keep streaming afterwards: each row must close with its REAL result (never a synthetic
  // "Giliran selesai" note, never an endless spinner until the whole delegation happens to finish).
  const read = await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch?.status === 'ok' && /# Toko/.test(o.patch.output ?? ''), 10000);
  assert.ok(read, 'the first step closed with its real result after the turn ended');
  const grep = await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch?.status === 'ok' && /README\.md: api/.test(o.patch.output ?? ''), 10000);
  assert.ok(grep, 'a step that STARTED after the turn also streamed, ran and closed');
  // the delegation itself reports back: its row finishes and the office releases the role
  await waitFor((t, o) => t === 'office' && o.project === id && o.kind === 'agent_stop' && o.role === 'backend' && /Cek API latar/.test(o.label ?? ''), 10000);
  await sleep(300);
  const chats = (await snapshot()).chats?.[id] ?? [];
  const delegate = chats.find((c) => c.kind === 'delegate' && /Cek API latar/.test(c.text ?? ''));
  assert.equal(delegate?.status, 'ok', 'the delegation row finished with its report');
  const hanging = chats.filter((c) => c.kind === 'tool' && /Cek API latar/.test(c.text ?? '') && c.status === 'running');
  assert.deepEqual(hanging, [], 'no step row is left spinning');
  const s = await snapshot();
  assert.deepEqual(s.statuses[id].working ?? {}, {}, 'no role is left working after the delegation reports');
});

/** The user texts OpenCode received since `since`, oldest first (FAKE_ACP_STORE: one file per session, all turns). */
let receivedSince = 0;
const receivedAll = () => {
  const dir = path.join(TMP, 'acp-store');
  const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.json')) : null;
  if (!file) return [];
  let data;
  try {
    data = JSON.parse(readFileSync(path.join(dir, file), 'utf8')); // the fake rewrites it mid-turn: a torn read is fine
  } catch {
    return null; // the caller polls: try again
  }
  return (data.messages ?? []).filter((m) => m.type === 'user').map((m) => m.text);
};
const received = () => (receivedAll() ?? []).slice(receivedSince);

test('a prompt sent mid-turn is queued (never sent to OpenCode while the tool runs), then delivered in order', async () => {
  mark = seen.length;
  receivedSince = receivedAll().length;
  await api(`/api/projects/${id}/prompt`, { text: 'tanya' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'approval' && o.status === 'pending' && o.kind !== 'plan');
  assert.deepEqual(received(), ['tanya'], 'OpenCode has exactly one prompt');
  // two follow-ups mid-turn, the second with an attachment: both wait, FIFO, one turn each
  const first = await api(`/api/projects/${id}/prompt`, { text: 'susulan 1' });
  assert.equal(first.status, 200);
  const att = Buffer.from('isi lampiran uji', 'utf8').toString('base64');
  const second = await api(`/api/projects/${id}/prompt`, { text: 'susulan 2', attachments: [{ name: 'catatan.txt', mediaType: 'text/plain', data: att }] });
  assert.equal(second.status, 200);
  const bubbles = (await snapshot()).chats?.[id] ?? [];
  const q1 = bubbles.filter((m) => m.kind === 'user' && m.text === 'susulan 1').at(-1);
  const q2 = bubbles.filter((m) => m.kind === 'user' && m.text === 'susulan 2').at(-1);
  assert.equal(q1?.queued, true, 'the bubble reads as queued, like Claude Code does');
  assert.equal(q2?.queued, true);
  assert.equal(q2?.attachments?.[0]?.name, 'catatan.txt');
  await sleep(800);
  assert.deepEqual(received(), ['tanya'], 'the running tool was not interrupted: still only one prompt');
  // answering the question ends the turn → susulan 1 runs as its own turn → then susulan 2
  const approval = (await snapshot()).approvals?.find((a) => a.approval?.project === id && a.approval?.kind === 'question' && a.status === 'pending') ?? null;
  const card = approval?.approval ?? (seen.filter((s) => s.type === 'chat' && s.obj.kind === 'approval' && s.obj.status === 'pending').at(-1)?.obj ?? null);
  assert.ok(card, 'the question card is open');
  const answered = await api(`/api/approvals/${card.approvalId ?? card.id}`, { allow: true, answers: { 'Pakai database apa?': 'SQLite', 'Fitur mana saja?': 'Login' } });
  assert.equal(answered.status, 200);
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && !o.ok === false && /jawaban/.test(o.text ?? '') === false, 15000).catch(() => {});
  await waitFor(() => (receivedAll()?.length ?? 0) - receivedSince >= 2, 15000);
  assert.deepEqual(received()[1], 'susulan 1', 'FIFO: the first follow-up runs first');
  await waitFor(() => (receivedAll()?.length ?? 0) - receivedSince >= 3, 20000);
  assert.match(received()[2], /susulan 2/);
  assert.match(received()[2], /<file name="catatan\.txt">/, 'the attachment rode along with the delivered prompt');
  assert.match(received()[2], /isi lampiran uji/);
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false, 15000);
  const done = (await snapshot()).statuses[id];
  assert.equal(done.busy, false, 'every queued prompt had its own turn, then idle');
});
