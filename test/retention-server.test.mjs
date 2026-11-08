// Data retention endpoints against the real server: POST /api/data exposes the setting, preview counts without
// writing, save validates, and run deletes only what the chosen setting asks for (0 = keep forever).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { wifiAllows } from '../src/remote.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-retention-server-'));
const DATA = path.join(TMP, 'data');
const PROJECTS = path.join(TMP, 'projects');
const PORT = 6300 + Math.floor(Math.random() * 150);
const BASE = `http://localhost:${PORT}`;
const DAY = 86_400_000;
const NOW = Date.now();
const OLD = NOW - 40 * DAY;

let current = null;

async function start() {
  mkdirSync(path.join(PROJECTS, 'toko'), { recursive: true });
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
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': current.token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

const chatFile = (id) => path.join(DATA, 'chats', `${id}.jsonl`);
const usageFile = () => path.join(DATA, 'usage.jsonl');
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
const jsonLines = (file) => lines(file).map((line) => JSON.parse(line));
/** JSON rows of a file, skipping a torn line (which retention keeps). */
const parsedLines = (file) =>
  lines(file).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const usageRow = (ts) => ({ ts, account: { id: 'akun-a' }, project: 'toko', projectId: 'p1', input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });

before(async () => {
  await start();
});

after(async () => {
  try {
    if (current) await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': current.token }, body: '{}' });
    await current?.exited;
  } catch {
    // best-effort teardown: the test itself already reported any real failure
  }
  current?.proc.kill();
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('retention endpoints: preview, save, run (and 0 never deletes)', { timeout: 60000 }, async () => {
  const initial = await api('/api/data');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body.retention, { chatsDays: 0, usageDays: 0 });

  assert.equal((await api('/api/data/retention/save', { chatsDays: 4000 })).status, 400, 'out of range refused');
  assert.equal((await api('/api/data/retention/save', { usageDays: '30' })).status, 400, 'a string is not a number of days');

  const saved = await api('/api/data/retention/save', { chatsDays: 30, usageDays: 30 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { retention: { chatsDays: 30, usageDays: 30 } });
  // Laptop-only: preview/save/run are on LOCAL_ONLY in server.js, so plain WiFi (read-only) never reaches them.
  for (const p of ['/api/data/retention/preview', '/api/data/retention/save', '/api/data/retention/run']) {
    assert.equal(wifiAllows(p), false, `${p} refused over sniffable WiFi`);
  }
  assert.deepEqual((await api('/api/data')).body.retention, { chatsDays: 30, usageDays: 30 }, '/api/data reports the setting');

  // Preview with an override: the body's valid values win, the stored one fills the rest.
  const overridden = await api('/api/data/retention/preview', { chatsDays: 90, usageDays: null });
  assert.equal(overridden.status, 200);
  assert.deepEqual(overridden.body.retention, { chatsDays: 90, usageDays: 30 });
  assert.ok(overridden.body.cutoff.chats > 0);
  assert.ok(overridden.body.cutoff.usage > 0);
  assert.deepEqual(overridden.body.chats, { messages: 0, projects: 0 }, 'nothing written yet');

  // Data written after the server start: Hub.pruneChatsBefore reads the file itself, so it is seen.
  mkdirSync(path.join(DATA, 'chats'), { recursive: true });
  writeFileSync(
    chatFile('puratan'),
    [
      { id: 'm1', ts: OLD, project: 'puratan', kind: 'assistant', text: 'lama' },
      { id: 'm2', ts: NOW, project: 'puratan', kind: 'assistant', text: 'baru' },
      { id: 'm3', project: 'puratan', kind: 'info', text: 'tanpa waktu' },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n') + '\n',
  );
  writeFileSync(usageFile(), [JSON.stringify(usageRow(OLD)), JSON.stringify(usageRow(NOW)), JSON.stringify({ account: { id: 'akun-a' } }), 'bukan-json'].join('\n') + '\n');

  const preview = await api('/api/data/retention/preview', {});
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.retention, { chatsDays: 30, usageDays: 30 }, 'no override: the stored setting');
  assert.deepEqual(preview.body.chats, { messages: 1, projects: 1 });
  assert.deepEqual(preview.body.usage, { rows: 1, files: 1 });
  assert.equal(lines(chatFile('puratan')).length, 3, 'preview wrote nothing');
  assert.equal(lines(usageFile()).length, 4, 'preview wrote nothing');

  const chatsRun = await api('/api/data/retention/run', { target: 'chats' });
  assert.equal(chatsRun.status, 200);
  assert.equal(chatsRun.body.target, 'chats');
  assert.deepEqual(chatsRun.body.chats, { removed: 1, projects: 1 });
  assert.deepEqual(chatsRun.body.usage, { removed: 0, files: 0 }, 'the ledger is not part of a chats run');
  assert.deepEqual(jsonLines(chatFile('puratan')).map((m) => m.id), ['m2', 'm3']);
  assert.equal(lines(usageFile()).length, 4, 'the ledger is untouched');

  const usageRun = await api('/api/data/retention/run', { target: 'usage' });
  assert.equal(usageRun.status, 200);
  assert.deepEqual(usageRun.body.usage, { removed: 1, files: 1 });
  assert.deepEqual(usageRun.body.chats, { removed: 0, projects: 0 });
  const usageLeft = lines(usageFile());
  assert.equal(usageLeft.length, 3);
  assert.equal(usageLeft.includes('bukan-json'), true);
  assert.equal(parsedLines(usageFile()).some((r) => r.ts === undefined), true);
  assert.deepEqual(jsonLines(chatFile('puratan')).map((m) => m.id), ['m2', 'm3'], 'the chat is untouched');

  assert.equal((await api('/api/data/retention/run', { target: 'nope' })).status, 400);
  const audit = await api('/api/data', { auditAction: 'retention-run' });
  assert.ok(audit.body.audit.some((e) => e.action === 'retention-run'), 'each run is audited');

  // 0 = keep forever: the old rows/messages that are still there must survive a run.
  assert.deepEqual((await api('/api/data/retention/save', { chatsDays: 0, usageDays: 0 })).body.retention, { chatsDays: 0, usageDays: 0 });
  writeFileSync(chatFile('tetap'), `${JSON.stringify({ id: 'm9', ts: OLD, project: 'tetap', kind: 'assistant', text: 'sangat lama' })}\n`);
  appendFileSync(usageFile(), `${JSON.stringify(usageRow(OLD))}\n`);
  const beforeChat = lines(chatFile('tetap')).length;
  const beforeUsage = lines(usageFile()).length;

  const zeroPreview = await api('/api/data/retention/preview', {});
  assert.deepEqual(zeroPreview.body.chats, { messages: 0, projects: 0 });
  assert.deepEqual(zeroPreview.body.usage, { rows: 0, files: 0 });
  assert.deepEqual(zeroPreview.body.cutoff, { chats: 0, usage: 0 });

  const zeroRun = await api('/api/data/retention/run', { target: 'all' });
  assert.deepEqual(zeroRun.body.chats, { removed: 0, projects: 0 });
  assert.deepEqual(zeroRun.body.usage, { removed: 0, files: 0 });
  assert.equal(lines(chatFile('tetap')).length, beforeChat);
  assert.equal(lines(usageFile()).length, beforeUsage);
});
