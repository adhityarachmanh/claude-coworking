// Retention that runs by itself when the server starts: state.json's persisted.retention is applied once at boot
// (server.js runRetention) before the port answers. Old chat messages/ledger rows go, everything without a usable
// timestamp and every torn line stays, the run is audited, and 0/0 means "keep forever" (nothing is deleted).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-retention-start-'));
const DAY = 86_400_000;
const NOW = Date.now();
const OLD = NOW - 40 * DAY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
const jsonLines = (file) => lines(file).map((line) => JSON.parse(line));
/** JSON rows of a file, skipping a torn/hand-edited line (which retention keeps). */
const parsedLines = (file) =>
  lines(file).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
const usageRow = (ts) => ({ ts, account: { id: 'akun-a' }, project: 'toko', projectId: 'p1', input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });

const running = new Set();

/** A server on its own data dir; resolves once /health answers (retention already ran before listen). */
async function start(dataDir, port) {
  const proc = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: dataDir,
      PROJECTS_ROOT: path.join(TMP, 'projects'),
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
  running.add(proc);
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
  const base = `http://localhost:${port}`;
  const token = (await (await fetch(base)).text()).match(/office-token" content="([^"]+)"/)[1];
  const health = await until(async () => {
    const res = await fetch(`${base}/health`).catch(() => null);
    return res?.ok ? res : null;
  }, 'health');
  assert.equal(health.status, 200);
  const api = (p, body = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const stop = async () => {
    try {
      await api('/api/shutdown');
      await exited;
    } catch {
      // best effort: the test's assertions already ran
    }
    proc.kill();
    running.delete(proc);
  };
  return { proc, api, stop, base };
}

async function until(pred, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await pred();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}

after(() => {
  for (const proc of running) proc.kill();
  rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('start: an old chat message and ledger row are pruned, the new/no-ts/torn ones stay, and the run is audited', { timeout: 60000 }, async () => {
  const dataDir = path.join(TMP, 'data-30');
  const chats = path.join(dataDir, 'chats');
  const opencodeChats = path.join(dataDir, 'chats-opencode');
  mkdirSync(chats, { recursive: true });
  mkdirSync(opencodeChats, { recursive: true });
  writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ retention: { chatsDays: 30, usageDays: 30 } }));
  const chatFile = path.join(chats, 'lama.jsonl');
  writeFileSync(
    chatFile,
    [
      { id: 'm-old', ts: OLD, project: 'lama', kind: 'assistant', text: 'pesan lama' },
      { id: 'm-new', ts: NOW, project: 'lama', kind: 'assistant', text: 'pesan baru' },
      { id: 'm-no-ts', project: 'lama', kind: 'info', text: 'tanpa waktu' },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n') + '\n',
  );
  const opencodeFile = path.join(opencodeChats, 'oc.jsonl');
  writeFileSync(
    opencodeFile,
    [
      { id: 'o-old', ts: OLD, project: 'oc', kind: 'assistant', text: 'lama' },
      { id: 'o-new', ts: NOW, project: 'oc', kind: 'assistant', text: 'baru' },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n') + '\n',
  );
  const usageFile = path.join(dataDir, 'usage.jsonl');
  writeFileSync(usageFile, [JSON.stringify(usageRow(OLD)), JSON.stringify(usageRow(NOW)), JSON.stringify({ account: { id: 'akun-a' } }), 'bukan-json'].join('\n') + '\n');

  const server = await start(dataDir, 6850 + Math.floor(Math.random() * 50));
  try {
    // The run happens before the listener opens; poll anyway so a future async change cannot make this flaky.
    await until(() => !lines(chatFile).some((line) => line.includes('m-old')), 'chat lama terhapus');
    await until(() => !lines(usageFile).some((line) => line.includes(`"ts":${OLD}`)), 'baris ledger lama terhapus');

    assert.deepEqual(jsonLines(chatFile).map((m) => m.id), ['m-new', 'm-no-ts'], 'new and timestamp-less messages stay');
    assert.deepEqual(jsonLines(opencodeFile).map((m) => m.id), ['o-new'], 'the other engine is pruned too');
    const usageLeft = lines(usageFile);
    assert.equal(usageLeft.some((line) => line.includes(`"ts":${OLD}`)), false, 'old ledger row gone');
    assert.equal(usageLeft.some((line) => line.includes(`"ts":${NOW}`)), true, 'new ledger row stays');
    assert.equal(usageLeft.includes('bukan-json'), true, 'a torn line is never deleted');
    assert.equal(parsedLines(usageFile).some((r) => r.ts === undefined), true, 'a row without ts stays');
    assert.equal(readdirSync(dataDir).some((name) => /^usage\.jsonl\.bak-retention-\d{8}$/.test(name)), true, 'a daily safety copy was made');
    assert.equal(existsSync(chatFile), true);

    const audit = await server.api('/api/data', { auditAction: 'retention-run' });
    assert.equal(audit.status, 200);
    const entry = audit.body.audit.find((e) => e.action === 'retention-run');
    assert.ok(entry, 'the automatic run is audited');
    assert.match(entry.detail, /otomatis/i);
    assert.match(entry.detail, /chat 2 pesan \(2 project\)/);
    assert.match(entry.detail, /ledger 1 baris \(1 file\)/);
  } finally {
    await server.stop();
  }
});

test('start: retention 0/0 (keep forever) deletes nothing and records no run', { timeout: 60000 }, async () => {
  const dataDir = path.join(TMP, 'data-0');
  const chats = path.join(dataDir, 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ retention: { chatsDays: 0, usageDays: 0 } }));
  const chatFile = path.join(chats, 'tetap.jsonl');
  writeFileSync(chatFile, `${JSON.stringify({ id: 'm-old', ts: OLD, project: 'tetap', kind: 'assistant', text: 'sangat lama' })}\n`);
  const usageFile = path.join(dataDir, 'usage.jsonl');
  writeFileSync(usageFile, `${JSON.stringify(usageRow(OLD))}\n`);
  const chatBefore = readFileSync(chatFile, 'utf8');
  const usageBefore = readFileSync(usageFile, 'utf8');

  const server = await start(dataDir, 6900 + Math.floor(Math.random() * 50));
  try {
    assert.equal(readFileSync(chatFile, 'utf8'), chatBefore, '0 = keep forever: the chat file is untouched');
    assert.equal(readFileSync(usageFile, 'utf8'), usageBefore, '0 = keep forever: the ledger is untouched');
    assert.equal(readdirSync(dataDir).some((name) => name.includes('.bak-retention-')), false, 'no safety copy without a deletion');

    const audit = await server.api('/api/data', { auditAction: 'retention-run' });
    assert.equal(audit.status, 200);
    assert.equal(audit.body.audit.some((e) => e.action === 'retention-run'), false, 'no run is recorded when nothing is due');
  } finally {
    await server.stop();
  }
});
