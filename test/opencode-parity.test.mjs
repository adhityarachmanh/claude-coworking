// OpenCode parity: the comfort features built for Claude Code — 🔔 Web Push (turn done / error / permission with
// its single-use action token, lock-screen Izinkan for safe file tools only, fail-closed), the ⚠ stuck detector,
// 📋 Antrian with its budget, the plain-WiFi redaction and the never-hang COMMAND_RULES — also hold when the engine
// is OpenCode. In process: the real Hub, SessionManager/AcpSession, TaskQueue and PushService against a fake
// `opencode acp` (test-support/fake-acp.mjs) and a fake push service. No server, no network, no real OpenCode.
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STUCK, toolChipText, toolStuck } from '../public/js/core/stuck-rules.js';
import { OPENCODE_ACCOUNT, permissionConfig } from '../src/acp-session.js';
import { accountPrivacyView } from '../src/account.js';
import { Hub } from '../src/hub.js';
import { PushService, wifiApproval } from '../src/push.js';
import { TaskQueue } from '../src/queue.js';
import { RemoteAccess, wifiAllows } from '../src/remote.js';
import { COMMAND_RULES, DEFAULT_ENABLED, activeAgents, teamPrompt } from '../src/role-catalog.js';
import { loadAgentDefinitions } from '../src/roles.js';
import { wifiAccountAlert } from '../src/routes/account.js';
import { SessionManager } from '../src/session.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_ACP = path.join(APP, 'test-support', 'fake-acp.mjs');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-oc-parity-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u = (buf) => Buffer.from(buf).toString('base64url');

/** Bounded wait for a condition (every wait here has a deadline). */
async function until(fn, what, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await sleep(25);
  }
}

// ---------- the fake push service + a browser that can decrypt (as in test/push.test.mjs) ----------

function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from(Array.from({ length: 16 }, (_, i) => i * 5));
  const endpoint = `https://fcm.googleapis.com/fcm/send/${u(ecdh.getPublicKey()).slice(0, 24)}`;
  return { ecdh, auth, subscription: { endpoint, keys: { p256dh: u(ecdh.getPublicKey()), auth: u(auth) } } };
}

function decrypt(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  let end = record.length - 1;
  while (record[end] === 0) end--;
  return JSON.parse(record.subarray(0, end).toString('utf8'));
}

const SETTINGS = Object.freeze({ events: { ask: { popup: true, sound: true }, done: { popup: true, sound: true }, error: { popup: true, sound: false } }, quiet: { enabled: false, from: '22:00', to: '07:00', allowAsk: true }, favoritesOnly: false, tzOffsetMin: 420 });

// ---------- the app, in process ----------

let hub;
let sessions;
let queue;
let push;
let project;
const sent = []; // every request to the push service
const events = []; // every hub broadcast { type, data }
const phones = {};

before(() => {
  const dir = path.join(TMP, 'projects', 'toko');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), '# Toko\n');
  process.env.FAKE_ACP_SHELL_FILE = path.join(TMP, 'fake-shell.json'); // the "macet" shell the linker finds
  hub = new Hub({ dataDir: path.join(TMP, 'data') });
  project = hub.upsertProject(dir, 'folder');
  hub.ready = true;
  hub.observers.add((type, data) => events.push({ type, data: structuredClone(data) }));
  sessions = new SessionManager({ hub, claude: null, opencode: { command: process.execPath, args: [FAKE_ACP] }, agents: {}, teamPrompt: '' });
  hub.updateSettings(project.id, { engine: 'opencode' }); // Stage 1: the project's own engine, not the app-wide one
  assert.equal(hub.engineOf(project.id), 'opencode');
  queue = new TaskQueue({ hub, sessions, delayMs: 50 });
  const remote = new RemoteAccess(hub);
  remote.state.enabled = true;
  const fetch = async (endpoint, { headers, body }) => {
    sent.push({ endpoint, headers, body });
    return { status: 201, headers: new Headers(), body: null };
  };
  push = new PushService({ hub, remote, fetch, queueSummary: (id) => queue.summary(id), log: () => {}, warn: () => {} });
  hub.observers.add((type, data) => push.observe(type, data));
  hub.redactors.set('approval', wifiApproval); // as server.js registers it
  // "allow": opted in to Izinkan from the lock screen; "closed": its settings never said so (fail-closed).
  for (const [name, extra] of [['allow', { lockscreenAllow: true }], ['closed', {}]]) {
    const device = { id: `dev-${name}`, hash: `h-${name}`, name: `HP ${name}`, created: Date.now(), lastSeen: Date.now(), transport: 'https' };
    remote.state.devices.push(device);
    const b = browser();
    push.subscribe(device, { subscription: b.subscription, settings: { ...SETTINGS, ...extra } });
    phones[name] = { device, browser: b };
  }
});

after(async () => {
  for (const s of sessions?.sessions.values() ?? []) {
    clearTimeout(s.idleTimer);
    clearTimeout(s.killTimer);
    s.closeChild();
  }
  if (queue?.fairTimer) clearTimeout(queue.fairTimer);
  hub?.save();
  clearTimeout(hub?.saveTimer);
  await sleep(300);
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The decrypted pushes one phone got, oldest first. */
const inbox = (name) => sent.filter((r) => r.endpoint === phones[name].browser.subscription.endpoint).map((r) => ({ payload: decrypt(r.body, phones[name].browser), headers: r.headers }));
const session = () => sessions.get(project);
const settle = async () => {
  await until(() => !session().busy, 'session idle');
  await push.idle();
};
const nextEvent = (from, pred, what) => until(() => events.slice(from).find((e) => pred(e.type, e.data))?.data, what);
const resultAfter = (from) => nextEvent(from, (t, d) => t === 'chat' && d.project === project.id && d.kind === 'result', 'turn result');

// ---------- 1. Web Push ----------

test('🔔 push: an OpenCode turn that ends sends "done" (minimal payload, no answer text) to the phones', async () => {
  hub.updateSettings(project.id, { mode: 'auto' });
  const from = events.length;
  const before = inbox('allow').length;
  session().prompt('halo');
  assert.equal((await resultAfter(from)).ok, true);
  await settle();
  const got = inbox('allow').slice(before);
  assert.deepEqual(got.map((m) => m.payload.type), ['done']);
  const p = got[0].payload;
  assert.equal(p.project, project.id);
  assert.equal(p.projectName, 'toko');
  assert.equal(p.role, 'Adhitron - Lead');
  assert.equal(got[0].headers.Urgency, 'normal');
  assert.ok(!JSON.stringify(p).includes('OpenCode palsu'), 'never the answer text');
});

test('🔔 push: an OpenCode turn that is stopped ends as "error" (no error text)', async () => {
  const from = events.length;
  const before = inbox('allow').length;
  session().prompt('tugas lama');
  await nextEvent(from, (t, d) => t === 'chat_update' && d.project === project.id && d.patch.streaming === true, 'streaming');
  session().stop();
  const result = await resultAfter(from);
  assert.equal(result.ok, false);
  await settle();
  const got = inbox('allow').slice(before);
  assert.deepEqual(got.map((m) => m.payload.type), ['error']);
  assert.ok(!JSON.stringify(got[0].payload).includes('Dihentikan'));
});

test('🔔 push: an OpenCode shell permission → "ask" with a single-use token; Izinkan refused (not a file tool), Tolak works; WiFi redacts the phone name', async () => {
  hub.updateSettings(project.id, { mode: 'manual' });
  const from = events.length;
  const before = { allow: inbox('allow').length, closed: inbox('closed').length };
  session().prompt('minta izin');
  const approval = await nextEvent(from, (t, d) => t === 'approval' && d.project === project.id && d.status === 'pending', 'approval');
  assert.equal(approval.tool, 'Bash');
  assert.equal(approval.kind, 'tool');
  await push.idle();
  const [ask] = inbox('allow').slice(before.allow);
  assert.equal(ask.payload.type, 'ask');
  assert.equal(ask.headers.Urgency, 'high');
  assert.equal(ask.payload.label, 'Bash', 'tool name only');
  assert.equal(ask.payload.approvalId, approval.id);
  assert.match(ask.payload.t, /^[\w-]{43}$/);
  assert.equal(ask.payload.allowAllowed, false, 'a shell command is never allowed from the lock screen');
  assert.ok(!JSON.stringify(ask.payload).includes('echo halo'), 'never the command');
  const [askClosed] = inbox('closed').slice(before.closed);
  assert.equal(askClosed.payload.allowAllowed, false);

  const refused = push.act({ device: phones.allow.device, t: ask.payload.t, a: 'allow', ip: '1' });
  assert.equal(refused.status, 403, 'act() enforces the allow-list too');
  assert.equal(hub.approvals.get(approval.id)?.approval.status, 'pending', 'still waiting');
  assert.equal(push.act({ device: phones.allow.device, t: ask.payload.t, a: 'deny', ip: '1' }).status, 410, 'single use: the token is spent');
  const denied = push.act({ device: phones.closed.device, t: askClosed.payload.t, a: 'deny', ip: '2' });
  assert.equal(denied.status, 200);
  // ✕ Tolak is not a stop (since the "Tolak" feature): OpenCode ends that turn and the app sends the note next,
  // exactly like Claude Code — so the turn result is not an error and its push is "done", not "error".
  const result = await resultAfter(from);
  assert.equal(result.ok, true, 'a rejection from the phone is not an error');
  assert.equal(result.text, '', 'a successful turn carries no error text');
  await nextEvent(from, (t, d) => t === 'chat' && d.project === project.id && d.kind === 'info' && /Izin ditolak/.test(d.text), 'rejection note');
  const follow = await nextEvent(from, (t, d) => t === 'chat' && d.project === project.id && d.kind === 'user' && /Saya menolak izin untuk/.test(d.text), 'follow-up prompt');
  const followAt = events.findIndex((e) => e.type === 'chat' && e.data === follow);
  const followResult = await nextEvent(followAt, (t, d) => t === 'chat' && d.project === project.id && d.kind === 'result', 'follow-up result');
  assert.equal(followResult.ok, true, 'the note turn finishes normally');

  const answered = events.slice(from).find((e) => e.type === 'approval' && e.data.id === approval.id && e.data.status === 'denied').data;
  assert.deepEqual(answered.answeredBy, { via: 'push', device: 'HP closed' }, 'the laptop sees who answered');
  assert.deepEqual(hub.viewFor('approval', answered, true).answeredBy, { via: 'push' }, 'plain WiFi: no phone name');
  await settle();
  // The other phone hears it was answered; then the continued turn ends as "done" (not "error"). Two turns run
  // (the rejected one, then the note's), so two "done" pushes arrive.
  assert.deepEqual(inbox('allow').slice(before.allow).map((m) => m.payload.type), ['ask', 'answered', 'done', 'done']);
  assert.deepEqual(inbox('closed').slice(before.closed).map((m) => m.payload.type), ['ask', 'done', 'done'], 'the phone that answered gets no "answered"');
});

test('🔔 push: an OpenCode file write permission → Izinkan from the lock screen only where opted in (fail-closed); allow runs the tool', async () => {
  hub.updateSettings(project.id, { mode: 'manual' });
  assert.equal(permissionConfig('manual').edit, 'ask');
  const from = events.length;
  const before = { allow: inbox('allow').length, closed: inbox('closed').length };
  session().prompt('tulis catatan');
  const approval = await nextEvent(from, (t, d) => t === 'approval' && d.project === project.id && d.status === 'pending', 'approval');
  assert.equal(approval.tool, 'Write', "OpenCode's edit permission is a file tool");
  assert.equal(approval.input.file_path, 'catatan.md');
  await push.idle();
  const [ask] = inbox('allow').slice(before.allow);
  const [askClosed] = inbox('closed').slice(before.closed);
  assert.equal(ask.payload.label, 'Write');
  assert.equal(ask.payload.allowAllowed, true, 'opted in: Izinkan from the lock screen');
  assert.equal(askClosed.payload.allowAllowed, false, 'lockscreenAllow never sent: fail-closed');
  assert.equal(push.act({ device: phones.closed.device, t: askClosed.payload.t, a: 'allow', ip: '3' }).status, 403);
  assert.equal(push.act({ device: phones.allow.device, t: ask.payload.t, a: 'allow', ip: '4' }).status, 200);
  await nextEvent(from, (t, d) => t === 'chat_update' && d.project === project.id && d.patch.status === 'ok', 'the write ran');
  assert.equal((await resultAfter(from)).ok, true);
  await settle();
});

// ---------- 2. stuck detector ----------

test('⚠ stuck: a never-ending OpenCode shell command is a running tool row the detector flags ("long" rule)', async () => {
  hub.updateSettings(project.id, { mode: 'auto' });
  const from = events.length;
  session().prompt('perintah macet');
  const start = await nextEvent(from, (t, d) => t === 'office' && d.project === project.id && d.kind === 'tool_start' && d.tool === 'Bash', 'tool_start');
  assert.equal(start.label, 'Menunggu log', 'the description shows in the office');
  const row = await until(() => hub.chatOf(project.id).findLast((m) => m.kind === 'tool' && m.tool === 'Bash' && m.status === 'running'), 'running Bash row');
  assert.equal(typeof row.ts, 'number', 'the detector times the row from its ts');
  assert.equal(hub.rt(project.id).status.busy, true, 'the project counts as alive');
  // What the browser's checkStuck does for this row (public/js/features/stuck.js evaluateTool): no readable output
  // → only the "running very long" rule applies.
  const verdict = (ms) => toolStuck({ startedAt: row.ts, elapsedMs: (row.elapsed ?? 0) * 1000, output: null, now: row.ts + ms });
  assert.equal(verdict(STUCK.TOOL_LONG_MS - 1000), null);
  const v = verdict(STUCK.TOOL_LONG_MS);
  assert.deepEqual(v, { reason: 'long', minutes: 10 });
  assert.equal(toolChipText(v), '⚠ Berjalan 10 mnt — mungkin macet');
  session().stop();
  assert.equal((await resultAfter(from)).ok, false);
  await settle();
});

test('⚠ stuck: an OpenCode shell row gets a readable output (taskId) so "no output for 3 min" can fire like for Claude', async () => {
  const from = events.length;
  session().prompt('perintah macet lagi');
  const row = await until(() => hub.chatOf(project.id).findLast((m) => m.kind === 'tool' && m.tool === 'Bash' && m.status === 'running'), 'running Bash row');
  try {
    // linkShells runs on its 15 s timer; the shell must have been running for 8 s before it is matched.
    const linked = await until(() => {
      const current = hub.chatOf(project.id).findLast((m) => m.id === row.id);
      return current?.taskId ? current : null;
    }, 'task id dari shell yang cocok', 25_000);
    assert.match(linked.taskId, /^oc:sh_/, 'a task id for /task-output');
    const out = await session().taskOutput(linked.taskId);
    assert.match(out.output, /menunggu log/, 'the linked shell has readable output');
  } finally {
    session().stop();
    await resultAfter(from);
    await settle();
  }
});

// ---------- 3. queue + budget ----------

test('📋 queue: OpenCode items run one by one; the cost budget counts OpenCode spending and pauses the queue (chat + push)', async () => {
  hub.updateSettings(project.id, { mode: 'auto' });
  queue.setPaused(project.id, true);
  for (let i = 1; i <= 5; i++) queue.add(project.id, `halo ${i}`);
  queue.setBudget(project.id, { costUsd: 0.01 }); // the fake costs $0.0025 per turn: used up after 4 items
  const from = events.length;
  const before = inbox('allow').length;
  queue.setPaused(project.id, false);
  const s = await until(() => {
    const x = queue.summary(project.id);
    return x.paused ? x : null;
  }, 'queue paused', 30000);
  assert.equal(s.reason, 'budget');
  assert.equal(s.done, 4);
  assert.equal(s.waiting, 1);
  assert.ok(Math.abs(s.budget.spentCostUsd - 0.01) < 1e-9, `OpenCode cost counted (${s.budget.spentCostUsd})`);
  assert.equal(s.budget.spentTokensOut, 100, 'output + thinking tokens of each OpenCode turn');
  const done = queue.view(project.id).items.filter((i) => i.status === 'done');
  assert.ok(done.every((i) => i.meta?.tokensOut === 25 && i.resultChatId), 'each item has its own OpenCode result');
  assert.ok(hub.chatOf(project.id).some((m) => m.kind === 'info' && m.queue && /batas biaya antrian tercapai/.test(m.text)));
  await settle();
  const got = inbox('allow').slice(before).map((m) => m.payload);
  assert.equal(got.filter((p) => p.type === 'done').length, 4);
  const paused = got.find((p) => p.type === 'queue');
  assert.ok(paused, 'the phone hears the queue paused');
  assert.equal(paused.label, 'Batas anggaran tercapai');
  assert.equal(events.slice(from).filter((e) => e.type === 'chat' && e.data.kind === 'user' && e.data.queueItem).length, 4, 'nothing sent past the budget');
  queue.forget(project.id);
});

test('📋 queue: a queue forgotten while its dispatch check was pending runs again when items come back (timer not leaked)', async () => {
  queue.setPaused(project.id, true);
  queue.add(project.id, 'halo dilupakan');
  queue.setPaused(project.id, false); // schedules a global dispatch check (delayMs later)…
  assert.equal(Boolean(queue.fairTimer), true);
  queue.forget(project.id); // …the project is removed before it fires (routes/projects.js)
  assert.equal(queue.queues[project.id], undefined, 'the forgotten queue is gone');
  const from = events.length;
  queue.add(project.id, 'halo kembali');
  await resultAfter(from); // a stale per-project entry could otherwise block schedule() until a restart
  await until(() => queue.summary(project.id)?.done === 1, 'item done');
  await settle();
  queue.forget(project.id);
});

test('📋 queue: an OpenCode item that cannot start pauses the queue naming OpenCode, not Claude Code', async () => {
  const bin = sessions.opencode;
  sessions.opencode = null; // OpenCode uninstalled meanwhile
  const from = events.length;
  try {
    queue.add(project.id, 'halo tanpa mesin');
    const s = await until(() => {
      const x = queue.summary(project.id);
      return x?.paused ? x : null;
    }, 'queue paused');
    assert.equal(s.reason, 'failed');
    const item = queue.view(project.id).items.find((i) => i.status === 'failed');
    assert.equal(item.error, 'OpenCode tidak bisa dijalankan.');
    const notes = events.slice(from).filter((e) => e.type === 'chat' && e.data.kind === 'info' && e.data.queue);
    assert.equal(notes.length, 0, 'nothing else waits: no pause note');
  } finally {
    sessions.opencode = bin;
    queue.forget(project.id);
  }
});

// ---------- 4. plain-WiFi redaction ----------

test('WiFi: OpenCode provider logins and the provider name stay off sniffable WiFi; the OpenCode ledger account is opaque', () => {
  for (const p of ['/api/opencode/providers', '/api/opencode/login/key', '/api/opencode/login/oauth', '/api/opencode/login/status', '/api/opencode/logout', '/api/engine']) {
    assert.equal(wifiAllows(p), false, p);
  }
  const alert = wifiAccountAlert({ action: 'login', device: 'HP Adhit', email: null, engine: 'opencode', provider: 'github-copilot', ts: 1 });
  assert.deepEqual(alert, { action: 'login', device: 'Perangkat lain', email: null, engine: 'opencode', ts: 1 }, 'no device name, no provider');
  const view = accountPrivacyView(Buffer.alloc(32, 7));
  const [acct] = view.accounts([{ ...OPENCODE_ACCOUNT, tokens: 220 }]);
  assert.equal(acct.email, null);
  assert.match(acct.id, /^acct-[0-9a-f]{16}$/);
  assert.equal(acct.tokens, 220);
});

// ---------- 5. COMMAND_RULES ----------

test('COMMAND_RULES: Mode tim on OpenCode gives the Lead (instructions) and every subagent (system) the never-hang rules', () => {
  const all = loadAgentDefinitions(path.join(APP, '.claude', 'agents'));
  const agents = activeAgents(all, DEFAULT_ENABLED);
  assert.ok(Object.keys(agents).length >= 5);
  const m = new SessionManager({ hub, claude: null, opencode: null, agents, teamPrompt: teamPrompt(DEFAULT_ENABLED, Object.keys(all)) });
  const config = JSON.parse(readFileSync(m.openCodeTeamConfig(), 'utf8'));
  const lead = readFileSync(config.instructions[0], 'utf8');
  assert.ok(lead.includes(COMMAND_RULES), "the Lead's instructions file");
  for (const [name, a] of Object.entries(config.agents)) {
    assert.equal(a.mode, 'subagent');
    assert.ok(a.system.includes(COMMAND_RULES), `${name}'s system prompt`);
  }
});
