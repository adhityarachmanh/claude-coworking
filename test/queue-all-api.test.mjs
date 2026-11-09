// POST /api/queues (🌐 Semua antrian) against the real server and the fake Claude Code: every project's live queue
// in the fair dispatch order, the running item, the global positions, the paused queue (no position), only waiting +
// running rows (a done/failed item never leaks), an ETA that is either a number or null, and the WiFi gate (the read
// is allowed, every queue change stays refused).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lanAddresses, wifiAllows } from '../src/remote.js';
import { projectId } from '../src/util.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-queue-all-api-'));
const DATA = path.join(TMP, 'data');
const PROJECTS = path.join(TMP, 'projects');
const PORT = 7000 + Math.floor(Math.random() * 120);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A_DIR = path.join(PROJECTS, 'toko');
const B_DIR = path.join(PROJECTS, 'blog');
const C_DIR = path.join(PROJECTS, 'catatan');
const D_DIR = path.join(PROJECTS, 'arsip');
const A = projectId(A_DIR);
const B = projectId(B_DIR);
const C = projectId(C_DIR);
const D = projectId(D_DIR);

let current = null;

async function start() {
  for (const dir of [A_DIR, B_DIR, C_DIR, D_DIR]) mkdirSync(dir, { recursive: true });
  mkdirSync(DATA, { recursive: true });
  const now = Date.now();
  // C keeps one done and one failed item (the global view must hide both); D is a queue paused by the user with one
  // waiting item (it cannot start, so it must never take a global position). No item carries a duration: the ETA is
  // therefore unknown, never a made-up number.
  writeFileSync(
    path.join(DATA, 'state.json'),
    JSON.stringify({
      queues: {
        [C]: {
          paused: false,
          items: [
            { id: 'q_111111111111', text: 'selesai kemarin', status: 'done', createdAt: now - 60_000, endedAt: now - 50_000 },
            { id: 'q_222222222222', text: 'gagal kemarin', status: 'failed', createdAt: now - 40_000, endedAt: now - 30_000, error: 'gagal' },
          ],
        },
        [D]: { paused: true, reason: 'user', pausedAt: now - 10_000, items: [{ id: 'q_333333333333', text: 'arsip menunggu', status: 'waiting', createdAt: now - 9_000 }] },
      },
    }),
  );
  const proc = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_DATA_DIR: DATA,
      PROJECTS_ROOT: PROJECTS,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale'),
      OFFICE_UPDATE_CHECK: '0',
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000',
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
}

function api(p, body = {}) {
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': current.token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

async function snapshot() {
  const res = await fetch(`${BASE}/stream`, { signal: AbortSignal.timeout(10000) });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

/** Polls with a hard deadline (100 ms steps); never a blind sleep. */
async function until(pred, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await pred();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}

const queueOf = async (id) => (await api(`/api/projects/${id}/queue`)).body.queue;
const allQueues = async () => (await api('/api/queues')).body;

before(async () => {
  await start();
  const snap = await snapshot();
  for (const [id, label] of [[A, 'toko'], [B, 'blog'], [C, 'catatan'], [D, 'arsip']]) {
    assert.equal(snap.projects.find((p) => p.id === id)?.name, label, `project ${label}`);
  }
});

after(async () => {
  try {
    if (current) await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': current.token }, body: '{}' });
    await current?.exited;
  } catch {
    // best effort: the assertions already reported the real failure
  }
  current?.proc?.kill();
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('/api/queues: running first-class, global positions across projects, paused without one, finished items hidden', { timeout: 120000 }, async () => {
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 1 })).status, 200);
  try {
    // A holds the only slot with a permission prompt: the fake Claude waits for an answer, so the turn cannot end
    // mid-assertion. Its queue item is running for real.
    assert.equal((await api(`/api/projects/${A}/queue-add`, { text: 'izin pemegang slot' })).status, 200);
    await until(async () => (await queueOf(A)).items[0]?.status === 'running', 'item A berjalan');
    assert.equal((await api(`/api/projects/${B}/queue-add`, { text: 'halo B' })).status, 200);
    assert.equal((await api(`/api/projects/${C}/queue-add`, { text: 'halo C' })).status, 200);

    const body = await allQueues();
    assert.deepEqual(Object.keys(body).sort(), ['queues', 'running', 'waiting'], 'only the documented keys');
    assert.equal(body.running, 1, 'A berjalan');
    assert.equal(body.waiting, 3, 'B + C menunggu, D menunggu di antrian yang dijeda');
    assert.equal((await api('/api/queues')).status, 200);

    const byProject = new Map(body.queues.map((q) => [q.project, q]));
    const a = byProject.get(A);
    assert.equal(a?.name, 'toko');
    assert.equal(a.paused, false);
    assert.equal(a.items.length, 1);
    assert.equal(a.items[0].status, 'running', 'item yang berjalan tampil dengan status running');
    assert.equal(a.items[0].queuePosition, null, 'hanya item menunggu yang punya posisi');
    assert.equal(a.items[0].etaMs, null);

    const b = byProject.get(B);
    assert.equal(b.items.length, 1);
    assert.equal(b.items[0].status, 'waiting');
    assert.equal(b.items[0].queuePosition, 1, 'B adalah yang pertama menunggu (global)');
    assert.ok(b.items[0].etaMs === null || (Number.isFinite(b.items[0].etaMs) && b.items[0].etaMs >= 0), 'etaMs angka >= 0 atau null');
    assert.equal(b.items[0].etaMs, null, 'belum ada durasi: jangan memaksa angka');

    const c = byProject.get(C);
    assert.equal(c.items.length, 1, 'done/failed tidak dikirim');
    assert.equal(c.items[0].text, 'halo C');
    assert.equal(c.items[0].queuePosition, 2, 'C menunggu di belakang B (posisi global)');
    assert.equal(c.items[0].etaMs, null);
    assert.equal(c.items.some((i) => i.id === 'q_111111111111' || i.id === 'q_222222222222'), false, 'item selesai/gagal disembunyikan');

    const d = byProject.get(D);
    assert.equal(d.paused, true, 'antrian yang dijeda tetap dikirim');
    assert.equal(d.reason, 'user');
    assert.equal(d.items[0].status, 'waiting');
    assert.equal(d.items[0].queuePosition, null, 'item di antrian yang dijeda tidak punya posisi global');
    assert.equal(d.items[0].etaMs, null);

    for (const q of body.queues) {
      for (const row of q.items) assert.ok(['waiting', 'running'].includes(row.status), `hanya waiting/running: ${row.status}`);
      assert.equal(typeof q.project, 'string');
      assert.equal(typeof q.name, 'string');
    }

    // ⏸ Jeda semua / ▶ Lanjutkan semua: only queues the user paused come back; invalid body is a 400.
    assert.equal((await api('/api/queues/pause', {})).status, 400, 'paused wajib boolean');
    const pausedAll = await api('/api/queues/pause', { paused: true });
    assert.equal(pausedAll.status, 200);
    assert.equal(pausedAll.body.count, 3, 'A (berjalan) + B/C (menunggu); D sudah dijeda');
    const pausedView = await allQueues();
    for (const id of [A, B, C]) assert.equal(pausedView.queues.find((q) => q.project === id)?.paused, true, `${id} dijeda`);
    assert.equal(pausedView.queues.find((q) => q.project === D)?.paused, true, 'D tetap dijeda');
    const resumedAll = await api('/api/queues/pause', { paused: false });
    assert.equal(resumedAll.status, 200);
    assert.equal(resumedAll.body.count, 4, 'A, B, C, dan D semuanya dijeda user');
    const resumedView = await allQueues();
    for (const q of resumedView.queues) assert.equal(q.paused, false, `${q.project} dilanjutkan`);
    assert.equal(wifiAllows('/api/queues/pause'), false, 'jeda semua adalah aksi, bukan bacaan WiFi');
  } finally {
    await api(`/api/projects/${A}/stop`).catch(() => {});
    for (const id of [A, B, C, D]) {
      for (let i = 0; i < 30; i += 1) {
        const items = (await queueOf(id).catch(() => null))?.items ?? [];
        if (!items.length) break;
        for (const item of items) await api(`/api/projects/${id}/queue-remove`, { itemId: item.id }).catch(() => {});
        await sleep(100);
      }
    }
    await api(`/api/projects/${D}/queue-pause`, { paused: false }).catch(() => {});
    await api('/api/concurrency/save', { maxConcurrent: 3 }).catch(() => {});
  }
});

test('/api/queues is read-only over plain WiFi; queue-remove/queue-update stay refused', async (t) => {
  assert.equal(wifiAllows('/api/queues'), true, '🌐 Semua antrian boleh dibaca dari WiFi');
  assert.equal(wifiAllows(`/api/projects/${B}/queue`), true);
  assert.equal(wifiAllows(`/api/projects/${B}/queue-remove`), false, 'membatalkan item tetap aksi');
  assert.equal(wifiAllows(`/api/projects/${B}/queue-update`), false, 'mengubah prompt antrian tetap aksi');

  const ip = lanAddresses()[0];
  if (!ip) return t.skip('no LAN address on this machine');
  const LAN = `http://${ip}:${PORT}`;
  assert.equal((await api('/api/remote', { enabled: true })).status, 200);
  try {
    await sleep(300);
    const { code } = (await api('/api/remote/pairing')).body;
    const paired = await fetch(`${LAN}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(paired.status, 200, 'pairing lewat LAN');
    const cookie = paired.headers.get('set-cookie').split(';')[0];
    const phoneToken = (await (await fetch(`${LAN}/`, { headers: { Cookie: cookie } })).text()).match(/office-token" content="([^"]+)"/)[1];
    const phone = (p, body = {}) => fetch(LAN + p, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Office-Token': phoneToken }, body: JSON.stringify(body) });

    const read = await phone('/api/queues');
    assert.equal(read.status, 200, 'membaca semua antrian dari WiFi');
    const payload = await read.json();
    assert.ok(Array.isArray(payload.queues), 'payload queues');
    assert.equal(typeof payload.waiting, 'number');

    const refused = await phone(`/api/projects/${B}/queue-remove`, { itemId: 'q_aaaaaaaaaaaa' });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).readOnly, true);
    const edit = await phone(`/api/projects/${B}/queue-update`, { itemId: 'q_aaaaaaaaaaaa', text: 'ubah dari WiFi' });
    assert.equal(edit.status, 403);
    assert.equal((await edit.json()).readOnly, true);
  } finally {
    await api('/api/remote', { enabled: false }).catch(() => {});
  }
});
