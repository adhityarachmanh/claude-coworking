// Effort/Model Auto for a prompt queued at the global turn limit: it is classified once, at dispatch (never while
// it waits, and never for an item that cannot start), and a broken classifier never blocks the item.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hub } from '../src/hub.js';
import { TaskQueue } from '../src/queue.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-queue-deferred-'));
let n = 0;

after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

/** One project with a session that only records the prompt (nothing is ever spawned). */
function setup({ classifier = async () => null, settings = { effortAuto: true, modelAuto: false }, delayMs = 60_000 } = {}) {
  n += 1;
  const dataDir = path.join(TMP, `data-${n}`);
  const dir = path.join(TMP, `proj-${n}`);
  mkdirSync(dir, { recursive: true });
  const hub = new Hub({ dataDir });
  const project = hub.upsertProject(dir, 'custom');
  hub.updateSettings(project.id, { engine: 'claude', ...settings });
  hub.persisted.maxConcurrent = 0; // this unit test is not about the global limit
  const calls = [];
  const prompts = [];
  const session = {
    busy: false,
    syncSettings() {},
    prompt(text, files, extra = {}) {
      const { queueChatId, ...fields } = extra;
      prompts.push({ text, files, extra: fields });
      this.busy = true;
      hub.setStatus(project.id, { busy: true });
      return { chatId: hub.chat(project.id, { kind: 'user', text, source: 'web', ...fields }) };
    },
  };
  const sessions = { get: () => session, stopping: false };
  const tq = new TaskQueue({
    hub,
    sessions,
    delayMs, // the timers must never fire during most tests: dispatch() is called by hand
    classify: (...args) => {
      calls.push(args);
      return classifier(...args);
    },
  });
  return { hub, project, tq, calls, prompts, session };
}

const cleanup = (hub) => {
  clearTimeout(hub?.saveTimer);
};

/** Two projects in one hub, each with a session that only records its prompt (nothing is ever spawned). */
function setupTwo({ classifier = async () => null, delayMs = 60_000 } = {}) {
  n += 1;
  const dataDir = path.join(TMP, `data-${n}`);
  const hub = new Hub({ dataDir });
  const projects = [];
  const sessions = { stopping: false };
  const byProject = new Map();
  const prompts = [];
  const overlap = []; // prompts sent while another project's fake session was still busy
  for (const name of ['satu', 'dua']) {
    const dir = path.join(TMP, `proj-${n}-${name}`);
    mkdirSync(dir, { recursive: true });
    const project = hub.upsertProject(dir, 'custom');
    hub.updateSettings(project.id, { engine: 'claude', effortAuto: true, modelAuto: false });
    const session = {
      busy: false,
      syncSettings() {},
      prompt(text, files, extra = {}) {
        for (const [id, other] of byProject) if (id !== project.id && other.busy) overlap.push({ project: project.id, other: id });
        const { queueChatId, ...fields } = extra;
        prompts.push({ project: project.id, text, files, extra: fields });
        this.busy = true;
        hub.setStatus(project.id, { busy: true });
        return { chatId: hub.chat(project.id, { kind: 'user', text, source: 'web', ...fields }) };
      },
    };
    byProject.set(project.id, session);
    projects.push(project);
  }
  sessions.get = (project) => byProject.get(project.id);
  hub.persisted.maxConcurrent = 1; // the race this test is about: one slot, two projects
  const calls = [];
  const tq = new TaskQueue({
    hub,
    sessions,
    delayMs, // the timers must never fire during most tests: dispatch() is called by hand
    classify: (...args) => {
      calls.push(args.slice(0, 2));
      return classifier(...args);
    },
  });
  return { hub, tq, calls, prompts, overlap, projects, sessions };
}

/** Bounded wait for a condition (10 ms steps); fails instead of hanging. */
async function until(pred, what, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const cleanupQueue = (hub, tq) => {
  clearTimeout(hub?.saveTimer);
  if (tq?.fairTimer) clearTimeout(tq.fairTimer);
};

test('deferred Auto: classified exactly once at dispatch, then the effort/model reach the turn', async () => {
  const { hub, project, tq, calls, prompts } = setup({
    classifier: async () => ({ level: 'high', reason: 'banyak file', source: 'llm', model: 'model-klasifikasi' }),
  });
  try {
    const item = tq.add(project.id, 'kerjakan fitur', null, [], { autoDeferred: true });
    assert.equal(item.autoDeferred, true);
    assert.equal(calls.length, 0, 'no classifier call while the prompt waits');

    await tq.dispatch(project.id);
    assert.equal(calls.length, 1, 'one classification at dispatch');
    assert.deepEqual(calls[0].slice(0, 2), [project.id, 'kerjakan fitur']);
    assert.equal(item.status, 'running');
    assert.equal(item.effort, 'high');
    assert.equal(item.effortReason, 'banyak file');
    assert.equal(item.effortSource, 'llm');
    assert.equal(item.effortModel, 'model-klasifikasi');
    assert.equal(item.autoDeferred, false);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].extra.autoEffort.level, 'high', 'the effort rides with the turn');
    assert.equal(hub.settingsFor(project.id).effort, 'high', 'Effort Auto applied before the prompt');

    await tq.dispatch(project.id); // already running: never a second classifier call
    assert.equal(calls.length, 1);
  } finally {
    cleanup(hub);
  }
});

test('deferred Auto: a classifier that fails logs and never blocks the item (project settings stay)', async () => {
  const { hub, project, tq, calls, prompts } = setup({
    classifier: async () => {
      throw new Error('model klasifikasi tidak tersedia');
    },
  });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const item = tq.add(project.id, 'lanjutkan', null, [], { autoDeferred: true });
    await tq.dispatch(project.id);
    assert.equal(calls.length, 1);
    assert.equal(item.status, 'running', 'the item runs anyway');
    assert.equal(item.effort, null);
    assert.equal(item.autoDeferred, false);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].extra.autoEffort, undefined);
    assert.equal(errors.some((line) => /Klasifikasi Auto/.test(line)), true, 'the failure is logged, not swallowed');
  } finally {
    console.error = original;
    cleanup(hub);
  }
});

test('deferred Auto: nothing is classified while every slot is taken; it is classified when one frees', async () => {
  const { hub, project, tq, calls } = setup({
    classifier: async () => ({ level: 'low', reason: 'kecil', source: 'fallback', model: null }),
  });
  try {
    hub.persisted.maxConcurrent = 1;
    hub.runtime.set('lain', { status: { project: 'lain', busy: true } }); // another project holds the only slot
    const item = tq.add(project.id, 'nanti saja', null, [], { autoDeferred: true });
    await tq.dispatch(project.id);
    assert.equal(calls.length, 0, 'no model call while there is no slot');
    assert.equal(item.status, 'waiting');
    assert.equal(item.autoDeferred, true);

    hub.runtime.get('lain').status.busy = false; // the slot frees
    await tq.dispatch(project.id);
    assert.equal(calls.length, 1);
    assert.equal(item.status, 'running');
    assert.equal(item.effort, 'low');
  } finally {
    cleanup(hub);
  }
});

test('deferred Auto: dua project tidak memesan slot yang sama (satu klasifikasi, satu turn pada satu waktu)', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { hub, tq, calls, prompts, overlap, projects, sessions } = setupTwo({
    classifier: async () => {
      await gate;
      return { level: 'high', reason: 'banyak file', source: 'llm', model: null };
    },
  });
  const [p1, p2] = projects;
  try {
    const i1 = tq.add(p1.id, 'auto satu', null, [], { autoDeferred: true });
    const i2 = tq.add(p2.id, 'auto dua', null, [], { autoDeferred: true });
    // Both dispatches are asked at the same time while the only slot is free: one must reserve it, the other wait.
    const d1 = tq.dispatch(p1.id);
    const d2 = tq.dispatch(p2.id);
    await until(() => calls.length >= 1, 'klasifikasi pertama mulai');
    await Promise.resolve(); // let the second dispatch run its (synchronous) guards
    assert.equal(calls.length, 1, 'project kedua belum diklasifikasi: slot tunggal sudah dipesan');
    assert.equal(prompts.length, 0, 'belum ada turn yang dikirim saat klasifikasi berjalan');
    assert.equal(i2.status, 'waiting');
    assert.equal(i2.autoDeferred, true, 'item kedua tetap deferred, tanpa model call');

    release();
    await Promise.all([d1, d2]);
    assert.equal(calls.length, 1, 'klasifikasi kedua menunggu slot bebas');
    assert.equal(prompts.length, 1, 'tepat satu turn dimulai');
    assert.equal(i1.status, 'running');
    assert.equal(i2.status, 'waiting');
    assert.equal(prompts[0].project, p1.id);

    // The first turn ends: the freed slot lets the second project be classified then run, never side by side.
    sessions.get(p1).busy = false;
    hub.setStatus(p1.id, { busy: false });
    assert.equal(tq.hasRoom(p2.id), true, 'slot bebas setelah turn pertama selesai');
    await tq.dispatch(p2.id);
    assert.equal(calls.length, 2, 'project kedua diklasifikasi sekali saat gilirannya tiba');
    assert.equal(calls[1][0], p2.id);
    assert.equal(i2.status, 'running');
    assert.equal(i2.autoDeferred, false);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].project, p2.id);
    assert.deepEqual(overlap, [], 'tidak pernah dua session busy bersamaan');
  } finally {
    cleanupQueue(hub, tq);
  }
});

test('deferred Auto: a stored item keeps autoDeferred across a save/restore', () => {
  const { hub, project, tq } = setup();
  try {
    tq.add(project.id, 'simpan', null, [], { autoDeferred: true });
    const stored = JSON.parse(JSON.stringify(tq.queues)); // exactly what state.json would hold
    const again = new TaskQueue({ hub: { ...hub, persisted: { queues: stored }, observers: new Set(), projects: hub.projects, runtime: hub.runtime, save() {}, setStatus() {}, broadcast() {}, chat() {}, rt: (id) => hub.rt(id), updateChat() {} }, sessions: { get: () => null, stopping: false }, delayMs: 60_000 });
    assert.equal(again.queues[project.id].items[0].autoDeferred, true);
    if (again.fairTimer) clearTimeout(again.fairTimer);
  } finally {
    cleanup(hub);
  }
});

test('deferred Auto: an item cancelled while classifying is never sent', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { hub, project, tq, calls, prompts } = setup({
    classifier: async () => {
      await gate;
      return { level: 'low', reason: 'kecil', source: 'fallback', model: null };
    },
  });
  try {
    const item = tq.add(project.id, 'batalkan aku', null, [], { autoDeferred: true });
    tq.add(project.id, 'tetap menunggu', null, [], { autoDeferred: false });
    const run = tq.dispatch(project.id);
    await until(() => calls.length === 1, 'klasifikasi mulai');
    tq.remove(project.id, item.id); // ✕ Batal during the classifier call
    release();
    await run;
    assert.equal(prompts.length, 0, 'the cancelled prompt never becomes a turn');
    assert.equal(item.status, 'waiting', 'the removed item is not marked running');
    assert.equal(tq.queues[project.id].items.includes(item), false);
    assert.notEqual(tq.queues[project.id].paused, true, 'the queue is not paused by a cancelled item');
  } finally {
    cleanupQueue(hub, tq);
  }
});

test('deferred Auto: cancelling the only item while classifying wakes another project', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const { hub, tq, calls, prompts, projects } = setupTwo({
    delayMs: 20,
    classifier: async () => {
      await gate;
      return { level: 'low', reason: 'kecil', source: 'fallback', model: null };
    },
  });
  const [p1, p2] = projects;
  try {
    const item = tq.add(p1.id, 'batal', null, [], { autoDeferred: true });
    tq.add(p2.id, 'jalan nanti', null, [], { autoDeferred: true });
    const run = tq.dispatch(p1.id);
    await until(() => calls.length === 1, 'klasifikasi project pertama mulai');
    tq.remove(p1.id, item.id); // releases the only slot reservation when the classifier returns
    release();
    await run;
    await until(() => prompts.some((p) => p.project === p2.id), 'project kedua benar-benar jalan', 3000);
    assert.equal(prompts.some((p) => p.text === 'batal'), false);
  } finally {
    cleanupQueue(hub, tq);
  }
});

test('⏸ pauseAllForUser / ▶ resumeAllForUser touch only user pauses, never a failed/budget queue', () => {  const { hub, tq, projects } = setupTwo();
  const [p1, p2] = projects;
  try {
    tq.add(p1.id, 'satu', null, [], { autoDeferred: true });
    tq.add(p2.id, 'dua', null, [], { autoDeferred: true });

    // p2 is already paused by a failure: the global pause must not rewrite its reason, and resume must skip it.
    Object.assign(tq.queues[p2.id], { paused: true, reason: 'failed', pausedAt: Date.now() });
    assert.equal(tq.pauseAllForUser(), 1, 'hanya antrian yang masih aktif');
    assert.deepEqual([tq.queues[p1.id].paused, tq.queues[p1.id].reason], [true, 'user']);
    assert.deepEqual([tq.queues[p2.id].paused, tq.queues[p2.id].reason], [true, 'failed']);

    // A budget pause is equally untouchable.
    Object.assign(tq.queues[p1.id], { reason: 'budget' });
    assert.equal(tq.resumeAllForUser(), 0, 'tidak ada antrian yang dijeda user');
    assert.equal(tq.queues[p1.id].paused, true, 'jeda budget tetap');

    // Back to a user pause: resume brings p1 back, p2 stays failed.
    Object.assign(tq.queues[p1.id], { reason: 'user' });
    assert.equal(tq.resumeAllForUser(), 1);
    assert.equal(tq.queues[p1.id].paused, false);
    assert.equal(tq.queues[p2.id].paused, true, 'antrian gagal tidak dilanjutkan diam-diam');
  } finally {
    cleanupQueue(hub, tq);
  }
});

test('📌 pin: a pinned waiting item goes before an older one across projects; only waiting items can be pinned', () => {
  const { hub, tq, projects } = setupTwo();
  const [p1, p2] = projects;
  try {
    const older = tq.add(p1.id, 'biasa', null, [], { autoDeferred: true });
    const newer = tq.add(p2.id, 'penting', null, [], { autoDeferred: true });
    assert.equal(tq.orderedWaiting()[0].item.id, older.id, 'tanpa pin: yang paling tua dulu');
    assert.equal(tq.nextFair(), p1.id);

    tq.pin(p2.id, newer.id, true);
    assert.equal(tq.orderedWaiting()[0].item.id, newer.id, 'pin menang atas urutan umur');
    assert.equal(tq.nextFair(), p2.id, 'scheduler fair juga memilih pin');
    assert.equal(tq.queues[p2.id].items.find((i) => i.id === newer.id).pinned, true);

    tq.pin(p2.id, newer.id, false);
    assert.equal(tq.orderedWaiting()[0].item.id, older.id, 'lepas pin mengembalikan urutan umur');

    const running = tq.queues[p1.id].items.find((i) => i.id === older.id);
    running.status = 'running';
    assert.throws(() => tq.pin(p1.id, running.id, true), /Hanya item yang masih menunggu/);
  } finally {
    cleanupQueue(hub, tq);
  }
});
