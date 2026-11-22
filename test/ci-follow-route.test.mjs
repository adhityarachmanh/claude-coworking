// 🐙 Pantau CI per project, end to end against the real server: `POST /settings { ciFollow }` stops or starts the
// GitHub check for that repo (no polling, no chip when off), and saving an unrelated setting never restarts a
// finished watch. Fake gh (OFFICE_GH_BIN) never touches the network.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-ci-route-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA = path.join(TMP, 'data');

let server;
let token;
let BASE;

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

before(async () => {
  const projects = path.join(TMP, 'projects');
  const toko = path.join(projects, 'toko');
  mkdirSync(toko, { recursive: true });
  writeFileSync(path.join(toko, 'README.md'), '# toko\n');
  // A real repo with one commit: the watcher asks git for HEAD and its branch, and the fake gh reports a run for it.
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t.local', '-c', 'user.name=t', ...args], { cwd: toko });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'awal');
  mkdirSync(path.join(TMP, 'claude-projects'));
  // A fake `gh` that reports ONE completed, successful run for the repo's current commit: the watch ends at
  // 'success' and stays there (the regression this guards: a later settings save must not restart it).
  writeFileSync(
    path.join(TMP, 'fake-gh.mjs'),
    "import { execSync } from 'node:child_process';\n" +
      "if (process.argv[2] === 'run') {\n" +
      "  const sha = execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();\n" +
      "  process.stdout.write(JSON.stringify([{ databaseId: 1, name: 'ci', workflowName: 'ci', status: 'completed', conclusion: 'success', headSha: sha, url: 'https://github.com/o/r/actions/runs/1' }]));\n" +
      '}\n',
  );
  BASE = `http://localhost:${await freePort()}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: new URL(BASE).port,
      OFFICE_DATA_DIR: DATA,
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_GH_BIN: path.join(TMP, 'fake-gh.mjs'),
      OFFICE_CI_FIRST_MS: '50',
      OFFICE_CI_POLL_MS: '50',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let stderr = '';
    server.stderr.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}${stderr.trim() ? `:\n${stderr.trim()}` : ''}`)));
  });
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
});

after(async () => {
  server?.kill();
  await sleep(400);
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

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

const until = async (fn, what, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
};

test('ciFollow: mematikan menghentikan pemantauan dan membersihkan chip, menyalakan memantau lagi', async () => {
  const id = (await snapshot()).projects.find((p) => p.name === 'toko').id;
  await api(`/api/projects/${id}/settings`, {}); // a project nobody touched yet gets its runtime from a settings write
  // On by default: it reports itself as following (the status carries the setting).
  assert.equal((await until(async () => (await snapshot()).statuses[id], 'status awal'))?.ciFollow, true, 'nyala secara bawaan');

  // Off: the chip is cleared and no watch is left behind.
  assert.equal((await api(`/api/projects/${id}/settings`, { ciFollow: false })).status, 200);
  await until(async () => (await snapshot()).statuses[id]?.ciFollow === false, 'setelan tersimpan');
  assert.equal((await snapshot()).statuses[id].ci, null, 'chip dibersihkan');

  // On: it follows the commit and reaches the fake run's terminal 'success'.
  assert.equal((await api(`/api/projects/${id}/settings`, { ciFollow: true })).status, 200);
  await until(async () => (await snapshot()).statuses[id]?.ci?.state === 'success', 'pemantauan kembali lalu selesai');
});

test('simpan setelan lain tidak me-restart pemantauan yang sudah selesai (tanpa baris CI ganda)', async () => {
  const id = (await snapshot()).projects.find((p) => p.name === 'toko').id;
  // The previous test left the watch finished at 'success' with one chat line.
  await until(async () => (await snapshot()).statuses[id]?.ci?.state === 'success', 'sudah selesai');
  const before = await snapshot();
  const doneState = before.statuses[id].ci;
  const chatsBefore = (before.chats[id] ?? []).filter((m) => /CI GitHub/.test(m.text ?? '')).length;
  assert.equal(chatsBefore, 1, 'satu baris hasil CI');

  // Saving an unrelated setting (effort) carries the default ciFollow: true (the composer always sends the
  // checkbox); it must NOT start a new watch.
  assert.equal((await api(`/api/projects/${id}/settings`, { effort: 'high', ciFollow: true })).status, 200);
  await sleep(400); // several poll cycles at 50 ms would have run and rewritten the status by now
  const after = await snapshot();
  assert.deepEqual(after.statuses[id].ci, doneState, 'status CI tidak di-reset ke pending');
  assert.equal((after.chats[id] ?? []).filter((m) => /CI GitHub/.test(m.text ?? '')).length, 1, 'tidak ada baris CI ganda');
});

test('mematikan di tengah jalan lalu menyalakan mengikuti commit lagi', async () => {
  const id = (await snapshot()).projects.find((p) => p.name === 'toko').id;
  assert.equal((await api(`/api/projects/${id}/settings`, { ciFollow: false })).status, 200);
  await until(async () => (await snapshot()).statuses[id]?.ciFollow === false, 'mati');
  assert.equal((await api(`/api/projects/${id}/settings`, { ciFollow: true })).status, 200);
  await until(async () => {
    const ci = (await snapshot()).statuses[id]?.ci;
    return ci && ci.state !== 'none';
  }, 'menyalakan lagi memantau (bukan sekadar pending selamanya)');
  // Restore the default so the file leaves nothing behind.
  await api(`/api/projects/${id}/settings`, { ciFollow: true });
});