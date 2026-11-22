// ⎇ Worktree routes: the app itself runs git worktree add/list/remove, and the engine's cwd follows the active
// worktree. A worktree is an attribute of the project — it never shows up as a project of its own.
// Full server against the fakes (no network, no real Claude Code/OpenCode).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-wt-route-'));
const DATA = path.join(TMP, 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** A git repo with one commit, so `worktree add -b` has a HEAD to branch from. */
function gitRepo(dir) {
  const run = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 't@t');
  run('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  run('add', '-A');
  run('commit', '-qm', 'init');
  return dir;
}

before(async () => {
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'repo'), { recursive: true });
  gitRepo(path.join(projects, 'repo'));
  mkdirSync(path.join(projects, 'plain'), { recursive: true });
  writeFileSync(path.join(projects, 'plain', 'README.md'), '# plain\n');
  mkdirSync(path.join(TMP, 'claude-projects'));
  mkdirSync(path.join(TMP, 'acp-store'));
  BASE = `http://localhost:${await freePort()}`;
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENCODE_')));
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...cleanEnv,
      OFFICE_PORT: new URL(BASE).port,
      OFFICE_DATA_DIR: DATA,
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      FAKE_ACP_STORE: path.join(TMP, 'acp-store'),
      FAKE_ACP_AUTH_FILE: path.join(TMP, 'acp-auth.json'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPENCODE_CONFIG_HOME: path.join(TMP, 'xdg'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale'),
      OFFICE_CLAUDE_CHECK_DELAY_MS: '0',
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

const projectId = async (name) => (await snapshot()).projects.find((p) => p.name === name)?.id;

/** A project's live status; a project nobody touched yet gets its runtime from a settings read/write. */
async function statusOf(id) {
  let status = (await snapshot()).statuses[id];
  if (!status) {
    await api(`/api/projects/${id}/settings`, {});
    status = (await snapshot()).statuses[id];
  }
  return status;
}

test('worktrees: daftar worktree sebuah repo git (main selalu ada)', async () => {
  const id = await projectId('repo');
  const res = await api(`/api/projects/${id}/worktrees`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.worktrees), 'worktrees berupa array');
  assert.ok(res.body.worktrees.some((w) => w.isMain), 'repo utama ada di daftar');
  assert.equal(res.body.active, null, 'belum ada worktree aktif');
  assert.equal(res.body.workspace, (await snapshot()).projects.find((p) => p.id === id).path, 'workspace awal = folder project');
});

test('worktree-create: membuat folder di .claude/worktrees, dan folder itu BUKAN project', async () => {
  const id = await projectId('repo');
  const project = (await snapshot()).projects.find((p) => p.id === id);
  const res = await api(`/api/projects/${id}/worktree-create`, { name: 'login' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.worktree.name, 'login');
  assert.equal(res.body.worktree.branch, 'worktree-login');
  const wtPath = path.join(project.path, '.claude', 'worktrees', 'login');
  assert.equal(path.resolve(res.body.worktree.path), path.resolve(wtPath), 'path sesuai konvensi');
  assert.ok(existsSync(wtPath), 'folder worktree dibuat');

  // The mirror/discovery must never publish a worktree folder as a project of its own.
  const names = (await snapshot()).projects.map((p) => (typeof p.path === 'string' ? path.resolve(p.path) : null)).filter(Boolean);
  assert.ok(!names.includes(path.resolve(wtPath)), 'worktree tidak muncul sebagai project');

  // Creating the same one twice: a clear 409 with a code, not a raw git failure.
  const again = await api(`/api/projects/${id}/worktree-create`, { name: 'login' });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, 'exists');
});

test('worktree-enter / worktree-exit: workspace mengikuti, status membawa workspacePath', async () => {
  const id = await projectId('repo');
  const project = (await snapshot()).projects.find((p) => p.id === id);
  const wtPath = path.join(project.path, '.claude', 'worktrees', 'login');

  const enter = await api(`/api/projects/${id}/worktree-enter`, { name: 'login' });
  assert.equal(enter.status, 200, JSON.stringify(enter.body));
  assert.equal(path.resolve(enter.body.workspace), path.resolve(wtPath));
  assert.equal(path.resolve((await statusOf(id)).workspacePath), path.resolve(wtPath), 'status project menunjuk workspace worktree');
  assert.equal((await statusOf(id)).worktree.name, 'login');

  const list = await api(`/api/projects/${id}/worktrees`);
  assert.equal(list.body.active, 'login', 'daftar menandai worktree aktif');

  const exit = await api(`/api/projects/${id}/worktree-exit`);
  assert.equal(exit.status, 200, JSON.stringify(exit.body));
  assert.equal(path.resolve(exit.body.workspace), path.resolve(project.path), 'kembali ke folder project');
  assert.equal(path.resolve((await statusOf(id)).workspacePath), path.resolve(project.path));
  assert.equal((await statusOf(id)).worktree ?? null, null, 'atribut worktree dibersihkan');
});

test('worktree-remove: menghapus folder; worktree aktif keluar dulu', async () => {
  const id = await projectId('repo');
  const project = (await snapshot()).projects.find((p) => p.id === id);
  const wtPath = path.join(project.path, '.claude', 'worktrees', 'login');

  await api(`/api/projects/${id}/worktree-enter`, { name: 'login' });
  const res = await api(`/api/projects/${id}/worktree-remove`, { name: 'login' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(!existsSync(wtPath), 'folder worktree hilang');
  assert.equal(path.resolve((await statusOf(id)).workspacePath), path.resolve(project.path), 'keluar otomatis saat worktree aktif dihapus');
  const list = await api(`/api/projects/${id}/worktrees`);
  assert.ok(!list.body.worktrees.some((w) => w.branch === 'worktree-login'), 'sudah tidak terdaftar');
});

test('project non-git: worktree-create ditolak dengan code no-repo', async () => {
  const id = await projectId('plain');
  const res = await api(`/api/projects/${id}/worktree-create`, { name: 'login' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'no-repo');
});

test('nama tak sah ditolak sebagai invalid-name, bukan lewat git', async () => {
  const id = await projectId('repo');
  const res = await api(`/api/projects/${id}/worktree-create`, { name: '../evil' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'invalid-name');
});

test('worktree-enter: repo utama dan nama di luar slug ditolak, bukan sukses palsu', async () => {
  const id = await projectId('repo');
  const project = (await snapshot()).projects.find((p) => p.id === id);
  const mainName = (await api(`/api/projects/${id}/worktrees`)).body.worktrees.find((w) => w.isMain).name;
  const main = await api(`/api/projects/${id}/worktree-enter`, { name: mainName });
  assert.equal(main.status, 400, JSON.stringify(main.body));
  assert.equal(main.body.code, 'invalid');
  assert.equal((await statusOf(id)).worktree ?? null, null, 'repo utama tidak mengaktifkan atribut worktree');

  // A worktree made outside the app (claude -w / git worktree add): its folder name is not a valid slug.
  const external = path.join(project.path, '.claude', 'worktrees', 'My_Feature');
  execFileSync('git', ['worktree', 'add', external, '-b', 'feature-1'], { cwd: project.path, stdio: 'ignore' });
  const bad = await api(`/api/projects/${id}/worktree-enter`, { name: 'My_Feature' });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal(bad.body.code, 'invalid-name');
  assert.equal(path.resolve((await statusOf(id)).workspacePath ?? project.path), path.resolve(project.path), 'sesi tetap di folder project, tidak ada klaim palsu');
  execFileSync('git', ['worktree', 'remove', '--force', external], { cwd: project.path, stdio: 'ignore' });
});

test('worktree-remove: hapus ditolak (dirty) mengembalikan worktree aktif sebelumnya', async () => {
  const id = await projectId('repo');
  const project = (await snapshot()).projects.find((p) => p.id === id);
  await api(`/api/projects/${id}/worktree-create`, { name: 'keepme' });
  await api(`/api/projects/${id}/worktree-enter`, { name: 'keepme' });
  const wtPath = path.join(project.path, '.claude', 'worktrees', 'keepme');
  writeFileSync(path.join(wtPath, 'dirty.txt'), 'x');
  const res = await api(`/api/projects/${id}/worktree-remove`, { name: 'keepme' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'dirty');
  assert.equal((await statusOf(id)).worktree?.name, 'keepme', 'worktree aktif tetap aktif setelah hapus gagal');
  assert.equal(path.resolve((await statusOf(id)).workspacePath), path.resolve(wtPath), 'sesi tetap di worktree');
  await api(`/api/projects/${id}/worktree-remove`, { name: 'keepme', force: true });
  assert.equal((await statusOf(id)).worktree ?? null, null, 'hapus paksa tetap keluar dari worktree');
});

test('state.json menyimpan worktree sebagai atribut settings project induk', async () => {
  const id = await projectId('repo');
  await api(`/api/projects/${id}/worktree-create`, { name: 'stored' });
  await api(`/api/projects/${id}/worktree-enter`, { name: 'stored' });
  // state.json writes are debounced (800 ms): wait (bounded) for the attribute to land on disk.
  const stateFile = path.join(DATA, 'state.json');
  const until = Date.now() + 5000;
  let stored = null;
  while (Date.now() < until) {
    try {
      stored = JSON.parse(readFileSync(stateFile, 'utf8')).settings?.[id]?.worktree ?? null;
    } catch {
      stored = null;
    }
    if (stored?.name === 'stored') break;
    await sleep(100);
  }
  assert.equal(stored?.name, 'stored', 'atribut worktree tersimpan di settings project');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(state.settings[id].workspacePath, undefined, 'workspacePath turunan tidak ikut tersimpan');
  await api(`/api/projects/${id}/worktree-exit`);
  await api(`/api/projects/${id}/worktree-remove`, { name: 'stored' });
});
