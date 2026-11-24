// 🖥 Claude background sessions (agent view): the list from `claude agents --json` is sanitized and the
// stop/respawn/rm/logs commands are built with a validated id, all against the fake CLI (no real session).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { backgroundAgentAction, backgroundAgentLogs, daemonStatus, listBackgroundAgents, startBackgroundAgent } from '../src/claude-admin.js';

const FAKE = path.join(process.cwd(), 'test-support', 'fake-claude.mjs');
const bin = { command: process.execPath, args: [FAKE] };

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-agents-'));
  const log = path.join(dir, 'agents.log');
  process.env.FAKE_AGENTS_LOG = log;
  return {
    dir,
    read: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    done: () => {
      delete process.env.FAKE_AGENTS_LOG;
      delete process.env.FAKE_AGENTS_JSON;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('listBackgroundAgents: bentuk entry dibersihkan, state asing menjadi null', async () => {
  const box = sandbox();
  try {
    const list = await listBackgroundAgents(bin);
    assert.equal(list.length, 4);
    assert.deepEqual(list[0], { id: 'bg-abc123', name: 'perbaiki checkout', kind: 'background', state: 'working', status: 'busy', waitingFor: null, cwd: 'C:/proj/toko', startedAt: 1760000000000, sessionId: 'ses-1', pid: 4242 });
    assert.equal(list[1].waitingFor, 'permission prompt');
    assert.equal(list[3].kind, 'interactive');
    assert.deepEqual(box.read().at(-1), ['agents', '--json', '--all'], 'tanpa --cwd: semua project');

    process.env.FAKE_AGENTS_JSON = JSON.stringify([{ id: 'bg-abc123', kind: 'background', state: 'meledak', status: 'aneh', cwd: 'x'.repeat(600), startedAt: 'kemarin' }]);
    const odd = await listBackgroundAgents(bin, { all: false, cwd: 'C:/proj/toko' });
    assert.equal(odd[0].state, null);
    assert.equal(odd[0].status, null);
    assert.equal(odd[0].cwd.length, 500);
    assert.equal(odd[0].startedAt, null);
    assert.deepEqual(box.read().at(-1), ['agents', '--json', '--cwd', 'C:/proj/toko'], 'all=false + cwd diteruskan');
  } finally {
    box.done();
  }
});

test('backgroundAgentAction: stop/respawn/rm, id divalidasi sebelum menjadi argumen', async () => {
  const box = sandbox();
  try {
    assert.equal((await backgroundAgentAction(bin, { action: 'stop', id: 'bg-abc123' })).ok, true);
    await backgroundAgentAction(bin, { action: 'respawn', id: 'bg-def456' });
    await backgroundAgentAction(bin, { action: 'rm', id: 'bg-ghi789' });
    assert.deepEqual(box.read().map((a) => a.slice(0, 2)), [['stop', 'bg-abc123'], ['respawn', 'bg-def456'], ['rm', 'bg-ghi789']]);
    await assert.rejects(backgroundAgentAction(bin, { action: 'stop', id: '--evil' }), (e) => e.status === 400);
    await assert.rejects(backgroundAgentAction(bin, { action: 'attach', id: 'bg-abc123' }), (e) => e.status === 400);
  } finally {
    box.done();
  }
});

test('backgroundAgentLogs: teks log dari CLI, referensi aneh ditolak', async () => {
  const box = sandbox();
  try {
    assert.equal((await backgroundAgentLogs(bin, 'bg-abc123')).text, 'output sesi terakhir');
    assert.deepEqual(box.read().at(-1), ['logs', 'bg-abc123']);
    await assert.rejects(backgroundAgentLogs(bin, '--evil'), (e) => e.status === 400);
  } finally {
    box.done();
  }
});

test('daemonStatus: teks dan running mengikuti CLI (exit 1 saat berhenti)', async () => {
  const box = sandbox();
  try {
    delete process.env.FAKE_DAEMON_RUNNING;
    const stopped = await daemonStatus(bin);
    assert.equal(stopped.running, false);
    assert.match(stopped.text, /not running/);
    process.env.FAKE_DAEMON_RUNNING = '1';
    const up = await daemonStatus(bin);
    assert.equal(up.running, true);
    assert.match(up.text, /pid: 4321/);
  } finally {
    box.done();
    delete process.env.FAKE_DAEMON_RUNNING;
  }
});

test('startBackgroundAgent: `claude --bg`, nama opsional, prompt divalidasi', async () => {
  const box = sandbox();
  try {
    const started = await startBackgroundAgent(bin, { prompt: 'periksa build', name: 'cek-build', cwd: box.dir });
    assert.equal(started.ok, true);
    assert.match(started.output, /bg-new123/);
    assert.deepEqual(box.read().at(-1), ['--bg', '--name', 'cek-build', 'periksa build']);
    await startBackgroundAgent(bin, { prompt: 'tanpa nama', cwd: box.dir });
    assert.deepEqual(box.read().at(-1), ['--bg', 'tanpa nama']);
    await assert.rejects(startBackgroundAgent(bin, { prompt: '', cwd: box.dir }), (e) => e.status === 400);
    await assert.rejects(startBackgroundAgent(bin, { prompt: 'x', name: '--evil', cwd: box.dir }), (e) => e.status === 400);
  } finally {
    box.done();
  }
});
