// 📋 Antrian against the real server and the fake Claude Code (test-support/fake-claude.mjs): editing the queue,
// items sent one by one when the session is idle, pausing on a failure or the usage limit, staying paused after a
// restart, and the WiFi gate (reading is allowed, every change is refused).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lanAddresses, wifiAllows } from '../src/remote.js';
import { QUEUE_LIMITS } from '../src/queue.js';

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

test('queue over plain WiFi: reading is allowed, every change is refused (default deny)', async (t) => {
  assert.ok(wifiAllows(`/api/projects/${id}/queue`));
  const changes = ['add', 'update', 'remove', 'reorder', 'pause', 'retry', 'clear'].map((op) => `/api/projects/${id}/queue-${op}`);
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
