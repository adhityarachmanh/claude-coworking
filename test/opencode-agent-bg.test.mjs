// ⧗ Tugas latar for ACP DELEGATIONS (OpenCode subagents): a `subagent` launch is background work, not a normal tool.
// The real case: an agent runs `flutter build apk` in its own child session while the parent turn is over. The app
// must list it as an agent task, keep it alive while the child is busy, close it when the parent resumes, and show
// that continuation — no network, no tokens, no real OpenCode.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-agent-bg-'));
const AGENT_STATE = path.join(TMP, 'agents.json');
const PORT = 4990 + Math.floor(Math.random() * 50);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let token;
let id;
const seen = [];
const waiters = [];
let stream;
let mark = 0;

before(async () => {
  // The child session as `session.list` sees it while the build runs (time.busy > time.idle).
  writeFileSync(AGENT_STATE, JSON.stringify([{ id: 'ses_anak_apk', parentID: 'ses_induk', time: { busy: 1, idle: 0 } }]));
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'apk'), { recursive: true });
  writeFileSync(path.join(projects, 'apk', 'README.md'), '# APK\n');
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
      FAKE_ACP_AGENT_STATE: AGENT_STATE,
      FAKE_ACP_RPC_LOG: path.join(TMP, 'rpc.log'),
      OFFICE_SHELL_WATCH_MS: '300',
      OFFICE_SHELL_LIVENESS_MS: '500',
      OFFICE_AGENT_QUIET_MS: '300',
      OFFICE_ACP_SETTLE_MS: '300', // a child step would be settled early if the agent task did not keep it open
      OFFICE_RESUME_POLL_MS: '150',
      OFFICE_RESUME_QUIET_MS: '300',
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
  id = (await snapshot()).projects.find((p) => p.name === 'apk').id;
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

function waitFor(pred, ms = 20000, label = 'event') {
  return new Promise((resolve, reject) => {
    for (let i = mark; i < seen.length; i++) if (pred(seen[i].type, seen[i].obj)) return ((mark = i + 1), resolve(seen[i].obj));
    const recent = () => seen.slice(Math.max(mark, seen.length - 8)).map((s) => `${s.type}:${JSON.stringify(s.obj).slice(0, 160)}`).join('\n  ');
    const timer = setTimeout(() => reject(new Error(`${label} timeout; last:\n  ${recent()}`)), ms);
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

test('a delegation (subagent) is listed in ⧗ while it builds, then closed when the parent resumes', async () => {
  mark = seen.length;
  const sent = await api(`/api/projects/${id}/prompt`, { text: 'delegasiresume' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));

  const started = await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc-agent-call-agent-apk'), 20000, 'task delegasi');
  const task = started.tasks.find((x) => x.id === 'oc-agent-call-agent-apk');
  assert.equal(task.kind, 'agent');
  assert.equal(task.agent, 'devops');
  assert.equal(task.description, 'Build APK');
  assert.equal(task.background, true);
  assert.equal(task.status, 'running');
  // The delegated role shows as working in the office/team card while the child runs.
  await waitFor((t, o) => t === 'status' && o.project === id && (o.working?.devops?.agents ?? 0) >= 1, 8000, 'devops bekerja');
  // Changing the process settings (mode/team) while the delegation runs must NOT kill it: the restart waits.
  const change = await api(`/api/projects/${id}/settings`, { mode: 'plan' });
  assert.equal(change.status, 200, JSON.stringify(change.body));
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'info' && /berlaku setelah (giliran ini|tugas latar)/.test(o.text ?? ''), 8000, 'info tunda restart');
  await sleep(500);
  const alive = await snapshot();
  assert.equal(alive.statuses[id].tasks.find((x) => x.id === task.id)?.status, 'running', 'settings change did not kill the delegation');
  // It stays running while the child reports its step (not closed with the parent turn).
  const progress = await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === task.id && x.lastActivityAt), 8000, 'aktivitas delegasi');
  assert.ok(progress.tasks.find((x) => x.id === task.id).lastActivityAt > 0);
  // The child's long step is NOT settled by the 300 ms grace while the delegation task runs.
  await sleep(800);
  const openRows = (await snapshot()).chats?.[id] ?? [];
  const buildRow = openRows.find((c) => c.kind === 'tool' && /flutter build apk/.test(c.input?.command ?? ''));
  assert.equal(buildRow?.status, 'running', 'the build step stays open while its delegation runs');
  assert.ok(!/Tidak ada kabar/.test(buildRow?.output ?? ''), 'no premature stale note');

  // The parent resumes with the child's report: ⧗ closes the task first (its info row), then the answer lands.
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'info' && /Tugas latar selesai/.test(o.text ?? ''), 20000, 'kabar delegasi selesai');
  await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === task.id && x.status === 'completed'), 20000, 'task delegasi selesai');
  await waitFor(
    (t, o) =>
      (t === 'chat' && o.kind === 'assistant' && /APK berhasil/.test(o.text ?? '')) ||
      (t === 'chat_update' && /APK berhasil/.test(o.patch?.text ?? '')),
    20000,
    'lanjutan setelah delegasi',
  );
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false, 10000, 'kembali idle');
  const st = await snapshot();
  assert.equal(st.statuses[id].busy, false, 'the resumed turn is closed');

  // Detail: the child's own steps + last answer (no Claude transcript involved).
  const detail = await api(`/api/projects/${id}/task-detail`, { taskId: task.id });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.kind, 'agent');
  assert.equal(detail.body.found, true);
  assert.equal(detail.body.agentType, 'devops');
  assert.ok(detail.body.steps.some((s) => /flutter build apk/.test(s.text)), 'the build step is in the detail');
  assert.match(detail.body.result ?? '', /Build APK arm64 sedang berjalan/);
  assert.match(detail.body.note ?? '', /Langkah lengkap ada di chat/);
  // Closing the delegation closed its long step row with an honest note (no endless spinner).
  const closed = (await snapshot()).chats?.[id] ?? [];
  const doneRow = closed.find((c) => c.kind === 'tool' && /flutter build apk/.test(c.input?.command ?? ''));
  assert.equal(doneRow?.status, 'ok', 'the build step row is closed with the delegation');
  assert.match(doneRow?.output ?? '', /delegasi selesai/);
});

test('■ Stop ends a running delegation (task and child rows), not left spinning', async () => {
  mark = seen.length;
  const sent = await api(`/api/projects/${id}/prompt`, { text: 'delegasistop' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc-agent-call-agent-stop' && x.status === 'running'), 20000, 'task stop running');
  await waitFor((t, o) => t === 'chat' && o.kind === 'tool' && /adb install/.test(o.input?.command ?? ''), 10000, 'baris deploy');
  const stop = await api(`/api/projects/${id}/stop`);
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'info' && /Tugas latar dihentikan/.test(o.text ?? ''), 10000, 'kabar dihentikan');
  await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc-agent-call-agent-stop' && x.status === 'stopped'), 10000, 'task stop berhenti');
  const chats = (await snapshot()).chats?.[id] ?? [];
  const row = chats.find((c) => c.kind === 'tool' && /adb install/.test(c.input?.command ?? ''));
  assert.equal(row?.status, 'ok', 'the child step row is closed by Stop');
  assert.match(row?.output ?? '', /Dihentikan bersama giliran/);
  // The child session itself is told to cancel (a subagent is its own session in OpenCode).
  const rpc = readFileSync(path.join(TMP, 'rpc.log'), 'utf8');
  assert.match(rpc, /session\/cancel/, 'Stop also cancels the child session');
});
