// 📋 Antrian against the real server and the fake Claude Code (test-support/fake-claude.mjs): editing the queue,
// items sent one by one when the session is idle, pausing on a failure or the usage limit, staying paused after a
// restart, and the WiFi gate (reading is allowed, every change is refused).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lanAddresses, wifiAllows } from '../src/remote.js';
import { BUDGET_LIMITS, PAUSE_REASONS, QUEUE_LIMITS, QueueError, TaskQueue } from '../src/queue.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-queue-'));
const DATA = path.join(TMP, 'data');
const PORT = 5300 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let current = null; // { proc, token, exited }
let id;

async function start() {
  const proc = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_DATA_DIR: DATA,
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale'), // phone access on: never ask the real Tailscale for a certificate
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
  proc.stderr.resume();
  const token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  current = { proc, token, exited };
  return current;
}

async function cleanStop() {
  assert.equal((await api('/api/shutdown')).status, 200);
  assert.equal(await current.exited, 0, 'clean exit');
  current = null;
}

function api(p, body = {}) {
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': current.token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

async function snapshot() {
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

async function until(fn, what, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}

const q = (op = '', body = {}) => api(`/api/projects/${id}/queue${op ? `-${op}` : ''}`, body);
const queue = async () => (await q()).body.queue;
const texts = (items, status) => items.filter((i) => !status || i.status === status).map((i) => i.text);

before(async () => {
  mkdirSync(path.join(TMP, 'projects', 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  await start();
  id = (await snapshot()).projects.find((p) => p.name === 'toko').id;
});

after(async () => {
  current?.proc?.kill();
  await sleep(500);
  rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

test('queue: add, edit, reorder, remove while paused; validated; nothing runs while paused', async () => {
  const empty = await queue();
  assert.deepEqual({ paused: empty.paused, items: empty.items }, { paused: false, items: [] });
  assert.equal((await q('pause', { paused: true })).status, 200);
  for (const text of ['satu', 'dua', 'tiga']) assert.equal((await q('add', { text })).status, 200);
  let list = await queue();
  assert.equal(list.paused, true);
  assert.equal(list.reason, 'user');
  assert.deepEqual(texts(list.items), ['satu', 'dua', 'tiga']);
  assert.ok(list.items.every((i) => i.status === 'waiting' && /^q_[a-f0-9]{12}$/.test(i.id)));
  const [a, b, c] = list.items.map((i) => i.id);

  // edit, reorder (the full waiting order), remove
  assert.equal((await q('update', { itemId: b, text: '  dua diubah \u0007 ' })).status, 200);
  assert.equal((await q('reorder', { order: [c, a, b] })).status, 200);
  assert.deepEqual(texts((await queue()).items), ['tiga', 'satu', 'dua diubah']);
  assert.equal((await q('reorder', { order: [a, b] })).status, 409, 'an order that misses an item is stale');
  assert.equal((await q('reorder', { order: [a, a, b] })).status, 409);
  assert.equal((await q('remove', { itemId: c })).status, 200);
  assert.deepEqual(texts((await queue()).items), ['satu', 'dua diubah']);

  // validation: empty, too long, unknown ids, item limit
  assert.equal((await q('add', { text: '   ' })).status, 400);
  assert.match((await q('add', { text: 'x'.repeat(QUEUE_LIMITS.text + 1) })).body.error, /maksimal/);
  assert.equal((await q('update', { itemId: 'q_000000000000', text: 'x' })).status, 404);
  assert.equal((await q('remove', { itemId: 'nope' })).status, 404);
  assert.equal((await api('/api/projects/nope/queue-add', { text: 'x' })).status, 404);
  assert.equal((await api('/api/projects/demo/queue')).status, 404, 'the demo has no queue');
  // 📎 attachments go to data/queue-files: metadata in state.json, bytes on disk, cleaned with the item
  const LOG = { name: 'error.log', mediaType: 'text/plain', data: Buffer.from('boom\n').toString('base64') };
  const withFile = await q('add', { text: 'lihat log', attachments: [LOG] });
  assert.equal(withFile.status, 200, JSON.stringify(withFile.body));
  assert.deepEqual(withFile.body.item.attachments.map((x) => [x.kind, x.name, x.size]), [['text', 'error.log', 5]]);
  assert.ok(existsSync(path.join(DATA, 'queue-files', id, withFile.body.item.id, 'a-0')), 'attachment bytes on disk');
  assert.equal((await q('add', { text: 'gambar lama', images: [{ mediaType: 'image/png', data: 'eA==' }] })).status, 400, 'invalid legacy image still refused');
  assert.equal((await q('update', { itemId: a, text: 'satu', attachments: [LOG] })).status, 400, 'files cannot be swapped by a text edit');
  assert.deepEqual(texts((await queue()).items), ['satu', 'dua diubah', 'lihat log'], 'attachment item is queued');
  assert.ok(!readFileSync(path.join(DATA, 'state.json'), 'utf8').includes(LOG.data), 'no file contents in state.json');
  const fileItem = withFile.body.item.id;
  assert.equal((await q('update', { itemId: fileItem, text: 'lihat log lagi' })).status, 200, 'text edit keeps the attachments');
  const edited = (await queue()).items.find((i) => i.id === fileItem);
  assert.deepEqual(edited.attachments.map((x) => x.name), ['error.log']);
  assert.ok(existsSync(path.join(DATA, 'queue-files', id, fileItem, 'a-0')), 'bytes survive a text edit');
  assert.equal((await q('remove', { itemId: fileItem })).status, 200);
  assert.equal(existsSync(path.join(DATA, 'queue-files', id, fileItem)), false, 'removing an item removes its files');
  for (let i = (await queue()).items.length; i < QUEUE_LIMITS.items; i++) assert.equal((await q('add', { text: `isi ${i}` })).status, 200);
  const full = await q('add', { text: 'satu lagi' });
  assert.equal(full.status, 400);
  assert.match(full.body.error, new RegExp(`maksimal ${QUEUE_LIMITS.items}`));
  for (const item of (await queue()).items.slice(2)) await q('remove', { itemId: item.id });

  // stored in state.json; the session bar's numbers ride in the project status
  const stored = JSON.parse(readFileSync(path.join(DATA, 'state.json'), 'utf8')).queues[id];
  assert.deepEqual(texts(stored.items), ['satu', 'dua diubah']);
  const st = (await snapshot()).statuses[id];
  assert.equal(st.taskQueue.waiting, 2);
  assert.equal(st.taskQueue.paused, true);
  await sleep(1200);
  assert.deepEqual(texts((await queue()).items, 'waiting'), ['satu', 'dua diubah'], 'paused: nothing was sent');
  assert.equal((await snapshot()).statuses[id].busy, false);
});

test('queue: resumed, items run one at a time in order, each after the previous result', async () => {
  assert.equal((await q('pause', { paused: false })).status, 200);
  const done = await until(async () => {
    const list = await queue();
    return list.items.length === 2 && list.items.every((i) => i.status === 'done') && list;
  }, 'both items done');
  const [first, second] = done.items;
  assert.deepEqual(texts(done.items), ['satu', 'dua diubah']);
  assert.ok(second.startedAt >= first.endedAt, `second started (${second.startedAt}) after the first ended (${first.endedAt})`);
  for (const item of done.items) {
    assert.match(item.chatId, /^m\d+$/, 'link to the prompt bubble');
    assert.match(item.resultChatId, /^m\d+$/, 'link to the result');
    assert.equal(item.error, null);
  }
  // the chat shows prompt → result → prompt → result (never two prompts in one turn)
  const chat = (await snapshot()).chats[id].filter((m) => (m.kind === 'user' && m.queueItem) || m.kind === 'result');
  const tail = chat.slice(-4).map((m) => (m.kind === 'user' ? `user:${m.text}` : `result:${m.ok}`));
  assert.deepEqual(tail, ['user:satu', 'result:true', 'user:dua diubah', 'result:true']);
  assert.equal(chat.at(-2).id, second.chatId);
  assert.equal(chat.at(-1).id, second.resultChatId);
  assert.equal((await snapshot()).statuses[id].taskQueue.waiting, 0);

  // finished items can be cleared
  assert.equal((await q('clear')).status, 200);
  assert.deepEqual((await queue()).items, []);
});

test('queue: an item runs with its attachment (bytes from data/queue-files, not state.json)', async () => {
  await q('pause', { paused: false });
  const LOG = { name: 'queue.log', mediaType: 'text/plain', data: Buffer.from('boom\n').toString('base64') };
  const added = await q('add', { text: 'lampiran?', attachments: [LOG] });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const itemId = added.body.item.id;
  const dir = path.join(DATA, 'queue-files', id, itemId);
  assert.deepEqual(added.body.item.attachments.map((a) => [a.kind, a.name, a.size]), [['text', 'queue.log', 5]]);
  assert.ok(existsSync(path.join(dir, 'a-0')), 'bytes on disk before the item runs');
  const done = await until(async () => {
    const list = await queue();
    return list.items.length === 1 && list.items[0].status === 'done' && list;
  }, 'attachment item done');
  const chat = (await snapshot()).chats[id];
  const promptAt = chat.findIndex((m) => m.id === done.items[0].chatId);
  const reply = chat.slice(promptAt).find((m) => m.kind === 'assistant');
  assert.match(reply.text, /^blocks=text,text /, 'prompt + attachment text block');
  assert.match(reply.text, /boom/, 'the actual file content reached Claude');
  assert.equal((await q('clear')).status, 200);
  assert.equal(existsSync(dir), false, 'clearing finished items removes their files');
});

test('queue: a failed item pauses the queue (the rest waits) and tells the user; retry puts it back in front', async () => {
  await q('add', { text: 'gagal sengaja' });
  await q('add', { text: 'setelah gagal' });
  const paused = await until(async () => {
    const list = await queue();
    return list.paused && list;
  }, 'queue paused after the failure');
  assert.equal(paused.reason, 'failed');
  assert.equal(paused.items[0].status, 'failed');
  assert.match(paused.items[0].error, /Error palsu/);
  assert.equal(paused.items[1].status, 'waiting');
  await sleep(800);
  assert.equal((await queue()).items[1].status, 'waiting', 'nothing more was sent');
  const notice = (await snapshot()).chats[id].findLast((m) => m.queue);
  assert.match(notice.text, /Antrian dijeda: item gagal\. 1 item masih menunggu/);

  assert.equal((await q('update', { itemId: paused.items[0].id, text: 'x' })).status, 409, 'only waiting items can be edited');
  assert.equal((await q('retry', { itemId: paused.items[1].id })).status, 409, 'only failed items can be retried');
  assert.equal((await q('retry', { itemId: paused.items[0].id })).status, 200);
  const retried = await queue();
  assert.deepEqual(retried.items.map((i) => [i.text, i.status]), [['gagal sengaja', 'waiting'], ['setelah gagal', 'waiting']]);
  assert.equal(retried.paused, true, 'retry does not resume by itself');
  for (const item of retried.items) await q('remove', { itemId: item.id });
});

test('queue: retry-once runs the failed item again once, then pauses', async () => {
  await q('pause', { paused: false });
  assert.equal((await api(`/api/projects/${id}/queue-retry-once`, { on: true })).status, 200);
  assert.equal((await queue()).retryOnce, true);
  await q('add', { text: 'gagal sengaja' });
  const paused = await until(async () => {
    const list = await queue();
    return list.paused && list;
  }, 'queue paused after the automatic retry');
  assert.equal(paused.reason, 'failed');
  assert.equal(paused.items[0].status, 'failed');
  assert.equal(paused.items[0].retried, true, 'the item was retried once');
  assert.ok((await snapshot()).chats[id].some((m) => /dicoba ulang sekali/.test(m.text ?? '')), 'the automatic retry is announced');
  for (const item of paused.items) await q('remove', { itemId: item.id });
  await api(`/api/projects/${id}/queue-retry-once`, { on: false });
});

test('queue: the account hitting its usage limit (rate_limit_event rejected) pauses it', async () => {
  await q('pause', { paused: false });
  await q('add', { text: 'kuota habis' });
  await q('add', { text: 'nanti saja' });
  const paused = await until(async () => {
    const list = await queue();
    return list.paused && list.items[0].status !== 'running' && list;
  }, 'paused by the usage limit');
  assert.equal(paused.reason, 'rate_limit');
  assert.equal(paused.items[1].status, 'waiting');
  assert.match((await snapshot()).chats[id].findLast((m) => m.queue).text, /batas pemakaian/);
  await q('clear');
  for (const item of (await queue()).items) await q('remove', { itemId: item.id });
});

test('queue: after a restart it stays paused ("restart") until the user resumes; the cut-off item is marked failed', async () => {
  await q('pause', { paused: false });
  await q('add', { text: 'tugas lama sekali' });
  await q('add', { text: 'sesudah restart' });
  await until(async () => (await queue()).items[0].status === 'running' && (await snapshot()).statuses[id].busy, 'first item running');
  await cleanStop();

  await start();
  let list = await queue();
  assert.equal(list.paused, true);
  assert.equal(list.reason, 'restart');
  assert.equal(list.items[0].status, 'failed');
  assert.match(list.items[0].error, /Server berhenti/);
  assert.equal(list.items[1].status, 'waiting');
  assert.equal((await snapshot()).statuses[id].taskQueue.reason, 'restart', 'the reason reaches the session bar');
  await sleep(1200);
  assert.equal((await queue()).items[1].status, 'waiting', 'not sent on its own after the restart');

  // The cut-short turn's notice holds the queue too (the session is not idle until it is dealt with).
  await q('pause', { paused: false });
  await sleep(1000);
  assert.equal((await queue()).items[1].status, 'waiting', 'waits while the "Lanjutkan" notice is open');
  assert.equal((await api(`/api/projects/${id}/continue`, { dismiss: true })).status, 200);
  list = await until(async () => {
    const l = await queue();
    return l.items[1].status === 'done' && l;
  }, 'second item ran after resume');
  assert.equal(list.paused, false);
});

test('queue-budget: set, validated, in the view, the session bar and state.json; both null clears it', async () => {
  const none = await queue();
  assert.deepEqual(none.budget, { tokensOut: null, costUsd: null, spentTokensOut: 0, spentCostUsd: 0, since: null }, 'always present');
  for (const body of [{ tokensOut: 999 }, { tokensOut: 1500.5 }, { tokensOut: '5000' }, { costUsd: 0 }, { costUsd: 10001 }, { costUsd: 'x' }]) {
    const res = await q('budget', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, /^Batas /);
  }
  const set = await q('budget', { tokensOut: 20000, costUsd: 1.234 });
  assert.equal(set.status, 200);
  const { since, ...rest } = set.body.queue.budget;
  assert.deepEqual(rest, { tokensOut: 20000, costUsd: 1.23, spentTokensOut: 0, spentCostUsd: 0 });
  assert.ok(Number.isFinite(since));
  assert.deepEqual((await snapshot()).statuses[id].taskQueue.budget, { tokensOut: 20000, costUsd: 1.23, spentTokensOut: 0, spentCostUsd: 0 });
  assert.equal(JSON.parse(readFileSync(path.join(DATA, 'state.json'), 'utf8')).queues[id].budget.tokensOut, 20000);
  assert.equal((await api('/api/projects/nope/queue-budget', { tokensOut: 5000 })).status, 404);

  const cleared = await q('budget', { tokensOut: null, costUsd: null });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.queue.budget, none.budget);
});

test('queue over plain WiFi: reading is allowed, every change is refused (default deny)', async (t) => {
  assert.ok(wifiAllows(`/api/projects/${id}/queue`));
  const changes = ['add', 'update', 'remove', 'reorder', 'pause', 'retry', 'clear', 'budget'].map((op) => `/api/projects/${id}/queue-${op}`);
  for (const p of changes) assert.ok(!wifiAllows(p), p);
  for (const p of ['/api/backup/schedule', '/api/backup/schedule/save', '/api/backup/schedule/run']) assert.ok(!wifiAllows(p), p);

  const ip = lanAddresses()[0];
  if (!ip) return t.skip('no LAN address on this machine');
  const LAN = `http://${ip}:${PORT}`;
  assert.equal((await api('/api/remote', { enabled: true })).status, 200);
  try {
    await sleep(300);
    const { code } = (await api('/api/remote/pairing')).body;
    const paired = await fetch(`${LAN}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie').split(';')[0];
    const phoneToken = (await (await fetch(`${LAN}/`, { headers: { Cookie: cookie } })).text()).match(/office-token" content="([^"]+)"/)[1];
    const phone = (p, body = {}) => fetch(LAN + p, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Office-Token': phoneToken }, body: JSON.stringify(body) });
    const before = await queue();
    const read = await phone(`/api/projects/${id}/queue`);
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()).queue.items, before.items);
    for (const p of changes) {
      const res = await phone(p, { text: 'rm -rf /', itemId: before.items[0]?.id, paused: true, order: [] });
      assert.equal(res.status, 403, p);
      assert.equal((await res.json()).readOnly, true, p);
    }
    for (const p of ['/api/backup/schedule', '/api/backup/schedule/save', '/api/backup/schedule/run']) assert.equal((await phone(p, { enabled: true, folder: 'C:\\' })).status, 403, `${p} is laptop only`);
    assert.deepEqual((await queue()).items, before.items, 'nothing changed');
  } finally {
    await api('/api/remote', { enabled: false });
  }
});

// ---------- budget: TaskQueue on its own (a fake hub, no server, nothing is ever sent) ----------

function fakeQueue(stored) {
  const chats = [];
  const hub = {
    persisted: { queues: stored },
    observers: new Set(),
    projects: new Map(),
    runtime: new Map(),
    save() {},
    setStatus() {},
    broadcast() {},
    chat: (project, msg) => chats.push({ project, ...msg }),
  };
  let clock = 1000;
  const tq = new TaskQueue({ hub, sessions: { get: () => null, stopping: false }, delayMs: 60_000, now: () => clock });
  return { tq, chats, tick: (ms) => (clock += ms) };
}

/** Marks the first waiting item running and ends it with a result carrying these numbers. */
function runOne(tq, project, { ok = true, tokensOut, costUsd } = {}) {
  const item = tq.queues[project].items.find((i) => i.status === 'waiting');
  item.status = 'running';
  tq.onResult(project, { kind: 'result', ok, id: 'm1', text: ok ? '' : 'Error palsu', meta: { durationMs: 10, turns: 1, tokensOut, costUsd } });
  return item;
}

test('budget unit: validation of the limits (tokens 1000..1e8 integer, cost 0.01..10000 to cents, null = none)', () => {
  const { tq } = fakeQueue();
  assert.ok(PAUSE_REASONS.includes('budget'));
  const bad = [
    { tokensOut: BUDGET_LIMITS.tokensOut.min - 1 },
    { tokensOut: BUDGET_LIMITS.tokensOut.max + 1 },
    { tokensOut: 1000.5 },
    { tokensOut: '2000' },
    { tokensOut: Number.NaN },
    { costUsd: 0.009 },
    { costUsd: 10000.01 },
    { costUsd: Infinity },
    { costUsd: '5' },
    { costUsd: true },
  ];
  for (const body of bad) {
    assert.throws(() => tq.setBudget('p', body), (e) => e instanceof QueueError && e.status === 400 && /^Batas /.test(e.message), JSON.stringify(body));
  }
  assert.equal(tq.queues.p, undefined, 'a refused budget creates nothing');
  tq.setBudget('p', { tokensOut: 1000, costUsd: 9999.999 });
  assert.deepEqual(tq.view('p').budget, { tokensOut: 1000, costUsd: 10000, spentTokensOut: 0, spentCostUsd: 0, since: 1000 });
  tq.setBudget('p', { tokensOut: null, costUsd: 0.014 });
  assert.equal(tq.view('p').budget.costUsd, 0.01);
  assert.deepEqual(tq.view('nothing').budget, { tokensOut: null, costUsd: null, spentTokensOut: 0, spentCostUsd: 0, since: null }, 'view always has a budget');
});

test('budget unit: spending accumulates from results (done and failed); tokensOut is kept in item.meta', () => {
  const { tq } = fakeQueue();
  tq.add('p', 'tanpa budget');
  const free = runOne(tq, 'p', { tokensOut: 700, costUsd: 0.2 });
  assert.equal(free.meta.tokensOut, 700, 'kept even without a budget');
  assert.equal(tq.view('p').budget.spentTokensOut, 0, 'nothing counted without a limit');

  tq.setBudget('p', { tokensOut: 100000 });
  for (const t of ['a', 'b', 'c']) tq.add('p', t);
  runOne(tq, 'p', { tokensOut: 1200, costUsd: 0.1 });
  runOne(tq, 'p', { tokensOut: undefined, costUsd: undefined });
  runOne(tq, 'p', { ok: false, tokensOut: 300, costUsd: 0.2 });
  const b = tq.view('p').budget;
  assert.equal(b.spentTokensOut, 1500);
  assert.equal(b.spentCostUsd, 0.3, 'no float dust');
  assert.deepEqual(tq.summary('p').budget, { tokensOut: 100000, costUsd: null, spentTokensOut: 1500, spentCostUsd: 0.3 });
});

test('budget unit: the token limit pauses the queue between items and warns in the chat; resume starts a new window', () => {
  const { tq, chats, tick } = fakeQueue();
  tq.setBudget('p', { tokensOut: 10000 });
  for (const t of ['satu', 'dua', 'tiga']) tq.add('p', t);
  runOne(tq, 'p', { tokensOut: 6000 });
  assert.equal(tq.view('p').paused, false, 'under the limit');
  runOne(tq, 'p', { tokensOut: 6345 });
  const v = tq.view('p');
  assert.equal(v.paused, true);
  assert.equal(v.reason, 'budget');
  assert.equal(tq.summary('p').reason, 'budget');
  assert.equal(v.items[2].status, 'waiting');
  assert.equal(chats.length, 1);
  assert.match(chats[0].text, /Antrian dijeda: batas token antrian tercapai \(12\.345 \/ 10\.000 token output\)\. 1 item masih menunggu/);
  assert.equal(chats[0].queue, true);

  tick(5000);
  tq.setPaused('p', false);
  const b = tq.view('p').budget;
  assert.deepEqual([b.spentTokensOut, b.spentCostUsd, b.since, b.tokensOut], [0, 0, 6000, 10000], 'exceeded: reset on resume');
});

test('budget unit: the cost limit; no pause when nothing waits; a failure pauses once (no double warning)', () => {
  const { tq, chats } = fakeQueue();
  tq.setBudget('p', { costUsd: 5 });
  tq.add('p', 'mahal');
  tq.add('p', 'berikutnya');
  runOne(tq, 'p', { costUsd: 5.123 });
  assert.equal(tq.view('p').reason, 'budget');
  assert.match(chats.at(-1).text, /batas biaya antrian tercapai \(\$5\.12 \/ \$5\.00\)/);

  // The last item: nothing waits, so no pause and no warning.
  const second = fakeQueue();
  second.tq.setBudget('p', { costUsd: 1 });
  second.tq.add('p', 'satu-satunya');
  runOne(second.tq, 'p', { costUsd: 2 });
  assert.equal(second.tq.view('p').paused, false);
  assert.equal(second.chats.length, 0);

  // A failed item over the budget: the failure pause fires, the budget does not pause (or warn) again.
  const third = fakeQueue();
  third.tq.setBudget('p', { tokensOut: 1000 });
  third.tq.add('p', 'gagal');
  third.tq.add('p', 'nanti');
  runOne(third.tq, 'p', { ok: false, tokensOut: 5000 });
  assert.equal(third.tq.view('p').reason, 'failed');
  assert.equal(third.chats.length, 1);
});

test('budget unit: resuming under the limit keeps the spending', () => {
  const { tq } = fakeQueue();
  tq.setBudget('p', { tokensOut: 10000 });
  tq.add('p', 'a');
  tq.add('p', 'b');
  runOne(tq, 'p', { tokensOut: 2000 });
  tq.setPaused('p', true);
  tq.setPaused('p', false);
  assert.equal(tq.view('p').budget.spentTokensOut, 2000);
  assert.equal(tq.view('p').budget.since, 1000);
});

test('budget unit: an empty, unpaused queue with a budget is kept; without one it is dropped', () => {
  const { tq } = fakeQueue();
  tq.setBudget('p', { tokensOut: 5000 });
  tq.add('p', 'x');
  runOne(tq, 'p', { tokensOut: 100 });
  tq.clearFinished('p');
  assert.ok(tq.queues.p, 'kept: it holds the budget');
  assert.equal(tq.view('p').budget.spentTokensOut, 100);
  assert.equal(tq.summary('p').budget.tokensOut, 5000);
  tq.setBudget('p', { tokensOut: null, costUsd: null });
  assert.equal(tq.queues.p, undefined, 'no budget, no items: gone');
  assert.equal(tq.summary('p'), null);
});

test('budget unit: restore keeps a good budget, a bad or missing one falls back to no limit', () => {
  const item = { id: 'q_0123456789ab', text: 'lama', status: 'done', createdAt: 1, updatedAt: 1 };
  const { tq } = fakeQueue({
    good: { paused: false, items: [], budget: { tokensOut: 5000, costUsd: 2.5, spentTokensOut: 4000, spentCostUsd: 1, since: 77 } },
    old: { paused: false, items: [item] }, // a state.json from before budgets
    bad: { paused: false, items: [item], budget: { tokensOut: 'banyak', costUsd: -3, spentTokensOut: -1, spentCostUsd: 'x', since: 'kemarin' } },
    half: { paused: false, items: [], budget: { tokensOut: 99, costUsd: 3, spentTokensOut: Number.NaN, spentCostUsd: 0.5, since: null } },
    junk: { paused: false, items: [], budget: 'tak terbatas' },
    stored: { paused: true, reason: 'budget', items: [item] },
  });
  const empty = { tokensOut: null, costUsd: null, spentTokensOut: 0, spentCostUsd: 0, since: null };
  assert.deepEqual(tq.view('good').budget, { tokensOut: 5000, costUsd: 2.5, spentTokensOut: 4000, spentCostUsd: 1, since: 77 });
  assert.ok(tq.queues.good, 'an empty queue with a budget survives a restart');
  assert.deepEqual(tq.view('old').budget, empty);
  assert.deepEqual(tq.view('bad').budget, empty);
  assert.deepEqual(tq.view('half').budget, { tokensOut: null, costUsd: 3, spentTokensOut: 0, spentCostUsd: 0.5, since: null });
  assert.equal(tq.queues.junk, undefined, 'empty, no budget: not kept');
  assert.equal(tq.view('stored').reason, 'budget', 'budget is a valid stored pause reason');
});

test('budget unit: a used-up budget is not bypassed by adding an item to an empty queue (review #2)', () => {
  const { tq, chats } = fakeQueue();
  tq.setBudget('p', { tokensOut: 1000 });
  tq.add('p', 'terakhir');
  runOne(tq, 'p', { tokensOut: 4000 }); // the last item goes over: nothing waits, so no pause yet
  assert.equal(tq.view('p').paused, false);
  tq.add('p', 'baru');
  tq.dispatch('p');
  const v = tq.view('p');
  assert.equal(v.paused, true);
  assert.equal(v.reason, 'budget');
  assert.equal(v.items.at(-1).status, 'waiting', 'nothing was sent');
  assert.match(chats.at(-1).text, /batas token antrian tercapai \(4\.000 \/ 1\.000 token output\)/);
});

test('budget unit: resuming a failure pause never resets a used-up budget silently (review #3)', () => {
  const { tq, chats } = fakeQueue();
  tq.setBudget('p', { tokensOut: 1000 });
  tq.add('p', 'gagal');
  tq.add('p', 'nanti');
  runOne(tq, 'p', { ok: false, tokensOut: 5000 });
  assert.equal(tq.view('p').reason, 'failed');
  tq.setPaused('p', false);
  assert.equal(tq.view('p').budget.spentTokensOut, 5000, 'kept');
  tq.dispatch('p');
  assert.equal(tq.view('p').reason, 'budget', 'paused again, now for the budget');
  assert.match(chats.at(-1).text, /batas token antrian tercapai/);
  tq.setPaused('p', false); // a budget pause: this resume starts a new window
  assert.equal(tq.view('p').budget.spentTokensOut, 0);
});

test('budget unit: a new budget while paused by the budget keeps it paused, labelled as a user pause (review #4)', () => {
  const { tq } = fakeQueue();
  tq.setBudget('p', { tokensOut: 1000 });
  for (const t of ['a', 'b']) tq.add('p', t);
  runOne(tq, 'p', { tokensOut: 2000 });
  assert.equal(tq.view('p').reason, 'budget');
  tq.setBudget('p', { tokensOut: 50000 });
  const v = tq.view('p');
  assert.deepEqual([v.paused, v.reason, v.budget.spentTokensOut], [true, 'user', 0]);
});
