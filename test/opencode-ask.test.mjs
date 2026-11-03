// OpenCode's interactive cards: its `question` tool (ACP form elicitation, OpenCode 2.2.5) on the same question
// card as Claude's AskUserQuestion, and the 📋 plan card after a plan-agent turn (Setujui → build + lanjut,
// Minta revisi → stays in plan). Pure mapping first, then the full server against test-support/fake-acp.mjs.
// No network, no tokens, no access to your real OpenCode.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLIENT_CAPABILITIES, elicitationContent, elicitationFields, mapTool, PLAN_APPROVED_PROMPT } from '../src/acp-session.js';
import { CLIENT_INIT } from '../src/opencode-contract.js';

// ---------- pure: schema ↔ card ----------

/** requestedSchema as OpenCode 2.2.5 builds it for its question tool (one choice + several choices). */
const SCHEMA = {
  type: 'object',
  properties: {
    q0: { type: 'string', title: 'Database', description: 'Pakai database apa?', oneOf: [{ const: 'PostgreSQL', title: 'PostgreSQL', description: 'Relasional' }, { const: 'SQLite', title: 'SQLite' }] },
    q0_custom: { type: 'string', title: 'Database (other)', description: 'Type your own answer' },
    q1: { type: 'array', title: 'Fitur', description: 'Fitur mana saja?', items: { anyOf: [{ const: 'Login', title: 'Login' }, { const: 'Ekspor, PDF', title: 'Ekspor, PDF' }] } },
    q1_custom: { type: 'string', title: 'Fitur (other)', description: 'Add your own answer' },
  },
  required: [],
};

test('elicitationFields: one card question per field, the "_custom" companion folded into its question', () => {
  const fields = elicitationFields(SCHEMA);
  assert.deepEqual(fields.map((f) => [f.key, f.custom, f.question, f.header, f.multiSelect]), [
    ['q0', 'q0_custom', 'Pakai database apa?', 'Database', false],
    ['q1', 'q1_custom', 'Fitur mana saja?', 'Fitur', true],
  ]);
  assert.deepEqual(fields[0].options, [{ value: 'PostgreSQL', label: 'PostgreSQL', description: 'Relasional' }, { value: 'SQLite', label: 'SQLite', description: undefined }]);
  // other MCP-style shapes: enum + enumNames, boolean, number, free text; junk and unknown types left out
  const other = elicitationFields({ type: 'object', properties: { a: { type: 'string', enum: ['x', 'y'], enumNames: ['Eks', 'Ye'] }, b: { type: 'boolean', title: 'Lanjut?' }, c: { type: 'integer', title: 'Berapa?' }, d: { type: 'string', title: 'Nama' }, e: { type: 'object' }, 'f g': { type: 'string' }, h: { type: 'array', items: {} } } });
  assert.deepEqual(other.map((f) => f.key), ['a', 'b', 'c', 'd']);
  assert.deepEqual(other[0].options.map((o) => o.label), ['Eks', 'Ye']);
  assert.deepEqual(other[1].options.map((o) => o.value), [true, false]);
  for (const bad of [null, {}, { type: 'object' }, { type: 'array', properties: {} }, 'x']) assert.deepEqual(elicitationFields(bad), [], JSON.stringify(bad));
});

test('elicitationContent: labels back to values, typed answers into "_custom", labels with ", " survive', () => {
  const fields = elicitationFields(SCHEMA);
  assert.deepEqual(elicitationContent(fields, { 'Pakai database apa?': 'SQLite', 'Fitur mana saja?': 'Login, Ekspor, PDF' }), { q0: 'SQLite', q1: ['Login', 'Ekspor, PDF'] });
  // the card puts a typed answer first: "own, picks"
  assert.deepEqual(elicitationContent(fields, { 'Pakai database apa?': 'MongoDB', 'Fitur mana saja?': 'Notifikasi, Login' }), { q0_custom: 'MongoDB', q1: ['Login'], q1_custom: 'Notifikasi' });
  assert.deepEqual(elicitationContent(fields, {}), {}, 'unanswered = left out');
  assert.deepEqual(elicitationContent(fields, { 'Pakai database apa?': 42, __proto__: { x: 1 } }), {}, 'only strings count');
  const other = elicitationFields({ type: 'object', properties: { b: { type: 'boolean', title: 'Lanjut?' }, c: { type: 'integer', title: 'Berapa?' }, d: { type: 'string', title: 'Nama' }, e: { type: 'string', title: 'Pilih', enum: ['a'] } } });
  assert.deepEqual(elicitationContent(other, { 'Lanjut?': 'Tidak', 'Berapa?': '3', Nama: 'Toko', Pilih: 'z' }), { b: false, c: 3, d: 'Toko' }, 'no "_custom" to put "z" in');
  assert.deepEqual(elicitationContent(other, { 'Berapa?': '2.5' }), {}, 'an integer stays an integer');
});

test('the question tool row reads as AskUserQuestion; initialize offers form elicitation (app and contract alike)', () => {
  const { name, input } = mapTool({ kind: 'other', title: 'question', rawInput: { questions: [{ question: 'Pakai apa?', header: 'DB', options: [{ label: 'A', description: 'a' }], multiple: true }] } });
  assert.equal(name, 'AskUserQuestion');
  assert.deepEqual(input.questions, [{ question: 'Pakai apa?', header: 'DB', options: [{ label: 'A', description: 'a' }], multiSelect: true }]);
  assert.deepEqual(CLIENT_CAPABILITIES.elicitation, { form: {} });
  assert.equal(CLIENT_CAPABILITIES.terminal, false);
  assert.equal(CLIENT_INIT.clientCapabilities, CLIENT_CAPABILITIES, 'the contract checks what the app really sends');
});

// ---------- the full server ----------

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-oc-ask-'));
// 5070–5219: clear of opencode.test.mjs' range and of 5060/5061 (fetch's "bad port")
const PORT = 5070 + Math.floor(Math.random() * 150);
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
      FAKE_ACP_STORE: path.join(TMP, 'acp-store'), // sessions outlive a process (session/load after a restart)
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
    const timer = setTimeout(() => reject(new Error('server did not start in 30 s')), 30_000);
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && (clearTimeout(timer), resolve()));
    server.on('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}`))));
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

let id;
async function openCodeProject(mode) {
  id ??= (await snapshot()).projects.find((p) => p.name === 'toko').id;
  if ((await snapshot()).config.engine !== 'opencode') assert.equal((await api('/api/engine', { engine: 'opencode' })).status, 200);
  await api(`/api/projects/${id}/settings`, { mode });
  return id;
}
const pendingCard = () => waitFor((t, o) => t === 'approval' && o.project === id && o.status === 'pending');
const result = () => waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
const finalText = (re) => waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.streaming === false && re.test(o.patch.text ?? ''));

test('caps: OpenCode now offers the interactive question / plan cards', async () => {
  assert.equal((await snapshot()).config.engines.opencode.caps.askQuestion, true);
});

test('question: OpenCode\'s question tool → the question card; the answers go back as the form content', async () => {
  await openCodeProject('manual');
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'tanya dulu' });
  const card = await pendingCard();
  assert.equal(card.kind, 'question');
  assert.equal(card.tool, 'AskUserQuestion');
  assert.equal(card.label, 'Bertanya: Pakai database apa?');
  assert.equal(card.canAlways, false);
  assert.deepEqual(card.input.questions.map((q) => [q.question, q.multiSelect, q.options.map((o) => o.label)]), [
    ['Pakai database apa?', false, ['PostgreSQL', 'SQLite']],
    ['Fitur mana saja?', true, ['Login', 'Ekspor, PDF']],
  ]);
  assert.ok(seen.some((s) => s.type === 'office' && s.obj.project === id && s.obj.kind === 'ask' && s.obj.ask === 'question'), 'the office waits for you');
  assert.equal((await api(`/api/approvals/${card.id}`, { allow: true, answers: { 'Pakai database apa?': 'SQLite', 'Fitur mana saja?': 'Pakai Docker, Ekspor, PDF' } })).status, 200);
  await finalText(/^jawaban=/);
  const answered = seen.filter((s) => s.type === 'chat_update' && s.obj.project === id && /^jawaban=/.test(s.obj.patch.text ?? '')).at(-1).obj.patch.text;
  assert.deepEqual(JSON.parse(answered.slice('jawaban='.length)), { q0: 'SQLite', q1: ['Ekspor, PDF'], q1_custom: 'Pakai Docker' });
  assert.equal((await result()).ok, true);
});

test('question: Lewati = decline (OpenCode carries on), Stop = cancel; "Izinkan semua" never answers a question', async () => {
  await openCodeProject('manual');
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'tanya lagi' });
  let card = await pendingCard();
  await api(`/api/approvals/${card.id}`, { allow: false });
  await finalText(/tanpa jawaban \(decline\)/);
  assert.equal((await result()).ok, true, 'a skipped question does not stop the turn');

  // Izinkan semua on a tool card first: the question still waits for you
  await api(`/api/projects/${id}/prompt`, { text: 'minta izin' });
  card = await pendingCard();
  await api(`/api/approvals/${card.id}`, { allow: true, allowAll: true });
  await result();
  await api(`/api/projects/${id}/prompt`, { text: 'tanya sekali lagi' });
  card = await pendingCard();
  assert.equal(card.kind, 'question');
  await api(`/api/projects/${id}/stop`);
  const closed = await waitFor((t, o) => t === 'approval' && o.id === card.id && o.status !== 'pending');
  assert.equal(closed.status, 'cancelled');
  await result();
  await api(`/api/projects/${id}/settings`, { mode: 'acceptEdits' }); // a fresh process: autoApprove off again
  await api(`/api/projects/${id}/settings`, { mode: 'manual' });
});

test('📋 plan: the plan turn ends with the plan card; Minta revisi (with a note) stays in plan, Setujui switches to build and continues', async () => {
  await openCodeProject('plan');
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'buat rencana judul README' });
  assert.equal((await result()).ok, true);
  let card = await pendingCard();
  assert.equal(card.kind, 'plan');
  assert.equal(card.tool, 'ExitPlanMode');
  assert.equal(card.role, 'pm');
  assert.match(card.input.plan, /^## Rencana\n\n1\. Ubah judul README/, 'the last answer, not the "Saya baca dulu." before the read');
  assert.ok(seen.some((s) => s.type === 'office' && s.obj.project === id && s.obj.kind === 'ask' && s.obj.ask === 'plan'));

  // Minta revisi with a note: the note is the next prompt, still in plan → a new plan card
  await api(`/api/approvals/${card.id}`, { allow: false, message: 'tambahkan bagian lisensi' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'user' && o.text === 'Revisi rencananya: tambahkan bagian lisensi');
  await result();
  card = await pendingCard();
  assert.match(card.input.plan, /## Rencana \(revisi\)/);
  assert.equal((await snapshot()).statuses[id].mode, 'plan');

  // Setujui, tanya tiap edit: mode 🛡️, OpenCode leaves its plan agent before the continue prompt arrives
  await api(`/api/approvals/${card.id}`, { allow: true, mode: 'manual' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'user' && o.text === PLAN_APPROVED_PROMPT);
  await finalText(/^Mengerjakan rencana \(agent=build\)$/);
  await result();
  assert.equal((await snapshot()).statuses[id].mode, 'manual');
  await sleep(200);
  assert.equal(seen.slice(mark).filter((s) => s.type === 'approval' && s.obj.project === id && s.obj.status === 'pending').length, 0, 'no plan card outside plan mode');
});

test('📋 plan: Setujui, auto-edit restarts OpenCode with the new permission config and continues in the same session', async () => {
  await openCodeProject('plan');
  const sessionId = (await snapshot()).statuses[id].sessionId;
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'rencana lain' });
  const card = await pendingCard();
  await api(`/api/approvals/${card.id}`, { allow: true, mode: 'acceptEdits' });
  await finalText(/^Mengerjakan rencana \(agent=build\)$/);
  await result();
  const st = (await snapshot()).statuses[id];
  assert.equal(st.mode, 'acceptEdits');
  assert.equal(st.sessionId, sessionId, 'session/load: the same OpenCode conversation');
});

test('📋 plan: a new prompt instead of an answer closes the card; Tolak without a note just closes it', async () => {
  await openCodeProject('plan');
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'rencana A' });
  let card = await pendingCard();
  await api(`/api/projects/${id}/prompt`, { text: 'rencana B' });
  assert.equal((await waitFor((t, o) => t === 'approval' && o.id === card.id && o.status !== 'pending')).status, 'cancelled');
  card = await pendingCard();
  await api(`/api/approvals/${card.id}`, { allow: false });
  await sleep(300);
  assert.equal(seen.slice(mark).filter((s) => s.type === 'chat' && s.obj.project === id && s.obj.kind === 'user').length, 0, 'nothing sent');
  assert.equal((await snapshot()).statuses[id].mode, 'plan');
  await api(`/api/projects/${id}/settings`, { mode: 'manual' });
});
