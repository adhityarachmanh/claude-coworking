// Background OpenCode, the REAL shape (OpenCode 2.2.5/2.3.0): a shell released with "Command moved to the background
// (shell ID: …, PID: …)" in its OUTPUT text and no shellID metadata. The app must still register the ⧗ task, close it
// from OpenCode's late frame, tell the user, and show the model's own continuation (OpenCode resumes the session
// without a prompt). No network, no tokens, no access to the real OpenCode.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-bg-real-'));
const SHELL_DIR = path.join(TMP, 'shell');
const PORT = 4930 + Math.floor(Math.random() * 50);
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
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'aset'), { recursive: true });
  writeFileSync(path.join(projects, 'aset', 'README.md'), '# Aset\n');
  mkdirSync(path.join(TMP, 'claude-projects'));
  // Delegation children as `session.list` sees them: the heavy build's child stays busy (its task must keep the
  // resume window alive), the lost-report one is idle (its task is reaped, then OpenCode never continues).
  writeFileSync(path.join(TMP, 'agents.json'), JSON.stringify([
    { id: 'ses_anak_lambat', time: { busy: 2, idle: 1 } },
    { id: 'ses_anak_hilang', time: { busy: 1, idle: 2 } },
    // Busy forever: the reaper must NOT be the one to close its task — only OpenCode's official child status may.
    { id: 'ses_anak_cdup', time: { busy: 2, idle: 1 } },
  ]));
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
      FAKE_ACP_SHELL_OUT_DIR: SHELL_DIR,
      OFFICE_OPENCODE_SHELL_DIR: SHELL_DIR,
      OFFICE_SHELL_WATCH_MS: '300',
      OFFICE_SHELL_LIVENESS_MS: '800',
      OFFICE_SHELL_GRACE_MS: '300',
      OFFICE_RESUME_POLL_MS: '150',
      OFFICE_RESUME_QUIET_MS: '300',
      // A short window stands in for the real 10 minutes: a heavy job's continuation arrives AFTER it would have
      // closed without the keep-alive, so a regression is visible here.
      OFFICE_RESUME_WINDOW_MS: '700',
      OFFICE_RESUME_MISS_MS: '1200',
      OFFICE_AGENT_QUIET_MS: '300',
      // The stalled-turn watchdog: a turn with no frame at all is cancelled, then closed a moment later.
      OFFICE_TURN_STALL_MS: '500',
      OFFICE_TURN_STALL_KILL_MS: '400',
      FAKE_ACP_RESUME_DELAY_MS: '1800',
      FAKE_ACP_AGENT_STATE: path.join(TMP, 'agents.json'),
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
  id = (await snapshot()).projects.find((p) => p.name === 'aset').id;
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

test('a real background shell is tracked from its output text, closes, and its continuation is shown', async () => {
  mark = seen.length;
  const sent = await api(`/api/projects/${id}/prompt`, { text: 'latarasli' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));

  // Registered from "shell ID: sh_…" in the release text (there is no shellID metadata in the fake).
  const started = await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc:sh_fakeasli'), 20000, 'task terdaftar');
  const task = started.tasks.find((x) => x.id === 'oc:sh_fakeasli');
  assert.equal(task.kind, 'shell');
  assert.equal(task.background, true);
  assert.equal(task.command, 'echo asli');
  assert.ok(Number.isInteger(task.pid) && task.pid > 0, 'the PID OpenCode printed is kept');
  // The parent turn ends while the shell works. Changing the mode then must defer the process restart.
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok === true, 15000, 'result shell');
  const change = await api(`/api/projects/${id}/settings`, { mode: 'plan' });
  assert.equal(change.status, 200, JSON.stringify(change.body));
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'info' && /berlaku setelah tugas latar/.test(o.text ?? ''), 8000, 'info tunda restart');

  // The late frame closes it, and the user is told (toast/push path). The chat row comes before the status broadcast.
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'info' && /Tugas latar selesai/.test(o.text ?? ''), 20000, 'kabar tugas selesai');
  await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc:sh_fakeasli' && x.status === 'completed'), 20000, 'task selesai');

  // OpenCode resumes the session by itself: the text arrives with no prompt of ours, then a result closes that turn.
  await waitFor(
    (t, o) =>
      (t === 'chat' && o.kind === 'assistant' && /Lanjutan otomatis/.test(o.text ?? '')) ||
      (t === 'chat_update' && /Lanjutan otomatis/.test(o.patch?.text ?? '')),
    20000,
    'teks lanjutan',
  );
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.meta?.durationMs >= 0 && o.ok === true, 20000, 'result lanjutan');
  const st = await snapshot();
  assert.equal(st.statuses[id].busy, false, 'the unsolicited turn is closed, not left spinning');
  // The deferred restart is applied once the shell and the resumed turn are over.
  await waitFor((t, o) => t === 'status' && o.project === id && o.alive === false, 8000, 'restart tertunda diterapkan');

  // The ⧗ output comes from the shell's own .out file.
  const out = await api(`/api/projects/${id}/task-output`, { taskId: 'oc:sh_fakeasli' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(out.body.output, /asli: selesai/);
});

test('a heavy delegation keeps the resume window alive: the continuation past the fixed window is not dropped', async () => {
  mark = seen.length;
  const sent = await api(`/api/projects/${id}/prompt`, { text: 'delegasilambat' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  // The delegation is listed and the parent turn ends while the child still builds.
  await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc-agent-call-agent-lambat' && x.status === 'running'), 20000, 'task delegasi lambat');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok === true, 15000, 'result induk');
  // No child frame comes for FAKE_ACP_RESUME_DELAY_MS (1800 ms) — past the 700 ms window. Without the keep-alive the
  // continuation below would be dropped and the session would sit idle with no report. It must arrive.
  await waitFor(
    (t, o) =>
      (t === 'chat' && o.kind === 'assistant' && /Build berat selesai/.test(o.text ?? '')) ||
      (t === 'chat_update' && /Build berat selesai/.test(o.patch?.text ?? '')),
    15000,
    'lanjutan setelah build berat',
  );
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false, 10000, 'kembali idle');
});

test('a delegation whose continuation never comes is reported honestly, not left silent', async () => {
  mark = seen.length;
  const sent = await api(`/api/projects/${id}/prompt`, { text: 'delegasiresumahilang' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc-agent-call-agent-hilang' && x.status === 'running'), 20000, 'task delegasi hilang');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok === true, 15000, 'result induk');
  // The child goes idle, its task closes, and OpenCode never sends the promised continuation: the user is told once.
  await waitFor(
    (t, o) => t === 'chat' && o.project === id && o.kind === 'info' && /tidak melanjutkan sesi ini setelah tugas latar/.test(o.text ?? ''),
    20000,
    'kabar jujur laporan hilang',
  );
  // The delegation task is closed (not left spinning) — assert from the current snapshot, not the event history.
  const snap = await snapshot();
  const task = (snap.statuses[id].tasks ?? []).find((x) => x.id === 'oc-agent-call-agent-hilang');
  assert.ok(task, 'the delegation task is still listed');
  assert.notEqual(task.status, 'running', 'the delegation task is closed, not left running');
});

test("the official child-session status closes a delegation without the parent's own continuation", async () => {
  mark = seen.length;
  const from = mark;
  const sent = await api(`/api/projects/${id}/prompt`, { text: 'delegasichildupdate' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc-agent-call-agent-cdup' && x.status === 'running'), 20000, 'task delegasi child_update');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok === true, 15000, 'result induk');
  // The child's `opencode/session/child_update` status:"completed" arrives; the parent NEVER resumes (upstream #55760).
  // The task must close from that status alone, and the app must NOT then claim "OpenCode did not continue".
  await waitFor((t, o) => t === 'status' && o.project === id && (o.tasks ?? []).some((x) => x.id === 'oc-agent-call-agent-cdup' && x.status === 'completed'), 20000, 'task ditutup oleh child_update');
  await sleep(1600); // longer than OFFICE_RESUME_MISS_MS (1200): the honesty line must NOT appear
  assert.equal(
    seen.slice(from).some((s) => s.type === 'chat' && s.obj?.project === id && s.obj?.kind === 'info' && /tidak melanjutkan sesi ini setelah tugas latar/.test(s.obj?.text ?? '')),
    false,
    'a clean child status is not "OpenCode went silent"',
  );
  const st = await snapshot();
  assert.equal(st.statuses[id].busy, false, 'the session is idle, nothing spins');
});

test('a turn that sends no frame at all is cancelled and closed, never left "busy" forever', async () => {
  mark = seen.length;
  const sent = await api(`/api/projects/${id}/prompt`, { text: 'diam' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  // No frame ever arrives (upstream #26350): the watchdog announces the cancellation, then closes the turn.
  await waitFor(
    (t, o) => t === 'chat' && o.project === id && o.kind === 'info' && /belum mengirim kemajuan apa pun/.test(o.text ?? ''),
    15000,
    'kabar giliran macet',
  );
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok === false && /ditutup otomatis/.test(o.text ?? ''), 15000, 'result giliran ditutup');
  const st = await snapshot();
  assert.equal(st.statuses[id].busy, false, 'the stalled turn is not left spinning');
});
