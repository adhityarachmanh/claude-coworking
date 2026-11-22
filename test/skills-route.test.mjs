// 🧩 Skills routes: list, read, save and delete SKILL.md from the app (server: src/routes/skills.js,
// src/skills.js). Skills are instruction files, not tools: adding one never grants a permission. A user-scope skill
// (~/.claude/skills, ~/.config/opencode/skills) steers every project, so writing it is laptop-only.
// Full server against the fakes (no network, no real Claude Code/OpenCode).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-skills-route-'));
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

before(async () => {
  const projects = path.join(TMP, 'projects');
  const app = path.join(projects, 'app');
  const dir = path.join(app, '.claude', 'skills', 'hello');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Hello\ndescription: Skill contoh\n---\n\nHalo\n');
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

test('skills: daftar memuat skill project dengan deskripsi', async () => {
  const id = await projectId('app');
  const res = await api(`/api/projects/${id}/skills`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const hello = res.body.skills.find((s) => s.id === 'hello');
  assert.ok(hello, 'skill hello terdaftar');
  assert.equal(hello.description, 'Skill contoh');
  assert.equal(hello.scope, 'project');
});

test('skills/save: menulis ulang SKILL.md; skills/read membacanya kembali', async () => {
  const id = await projectId('app');
  const app = (await snapshot()).projects.find((p) => p.id === id);
  const file = path.join(app.path, '.claude', 'skills', 'hello', 'SKILL.md');
  const before = (await api(`/api/projects/${id}/skills/read`, { scope: 'project', source: '.claude/skills (project)', id: 'hello' })).body.skill;
  const res = await api(`/api/projects/${id}/skills/save`, { scope: 'project', source: '.claude/skills (project)', id: 'hello', name: 'Hello', description: 'Diubah', content: 'Isi baru\n', mtime: before.mtime });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(readFileSync(file, 'utf8'), /Isi baru/);
  const after = (await api(`/api/projects/${id}/skills/read`, { scope: 'project', source: '.claude/skills (project)', id: 'hello' })).body.skill;
  assert.match(after.content, /Isi baru/);
  assert.equal(after.description, 'Diubah');
});

test('skills/save: id tak sah ditolak 400', async () => {
  const id = await projectId('app');
  const res = await api(`/api/projects/${id}/skills/save`, { scope: 'project', source: '.claude/skills (project)', id: '../evil', description: 'x', content: 'y' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('skills/save: ganti nama (previous) menulis id baru dan menghapus folder lama', async () => {
  const id = await projectId('app');
  const app = (await snapshot()).projects.find((p) => p.id === id);
  const base = { scope: 'project', source: '.claude/skills (project)' };
  await api(`/api/projects/${id}/skills/save`, { ...base, id: 'ren-src', name: 'Ren', description: 'x', content: 'isi\n' });
  const before = (await api(`/api/projects/${id}/skills/read`, { ...base, id: 'ren-src' })).body.skill;
  const res = await api(`/api/projects/${id}/skills/save`, { ...base, id: 'ren-dst', previous: 'ren-src', previousScope: 'project', previousSource: '.claude/skills (project)', name: 'Ren', description: 'x', content: before.content, mtime: before.mtime });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(existsSync(path.join(app.path, '.claude', 'skills', 'ren-dst', 'SKILL.md')), 'id baru tertulis');
  assert.ok(!existsSync(path.join(app.path, '.claude', 'skills', 'ren-src')), 'folder lama hilang');
});

test('skills/delete: menghapus direktori skill', async () => {
  const id = await projectId('app');
  const app = (await snapshot()).projects.find((p) => p.id === id);
  await api(`/api/projects/${id}/skills/save`, { scope: 'project', source: '.claude/skills (project)', id: 'temp', description: 'x', content: 'y' });
  const dir = path.join(app.path, '.claude', 'skills', 'temp');
  assert.ok(existsSync(dir));
  const res = await api(`/api/projects/${id}/skills/delete`, { scope: 'project', source: '.claude/skills (project)', id: 'temp' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(!existsSync(dir), 'folder skill hilang');
});

test('skills: project ber-OpenCode membaca root kompatibilitas + .opencode/skills (dua mesin)', async () => {
  const { listSkills } = await import('../src/skills.js');
  const app = (await snapshot()).projects.find((p) => p.name === 'app');
  const dir = path.join(app.path, '.opencode', 'skills', 'oc-only');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: OC Only\ndescription: hanya opencode\n---\n\nx\n');
  const oc = listSkills({ engine: 'opencode', projectPath: app.path, home: TMP });
  assert.ok(oc.some((s) => s.id === 'oc-only'), 'skill .opencode/skills terdaftar untuk OpenCode');
  assert.ok(oc.some((s) => s.id === 'hello'), 'root kompatibilitas .claude/skills juga dibaca');
  assert.ok(!listSkills({ engine: 'claude', projectPath: app.path, home: TMP }).some((s) => s.id === 'oc-only'), 'Claude tidak membaca .opencode/skills');
});

test('skills/read: path absolut laptop tidak dikirim ke klien (HP lewat Tailscale)', async () => {
  const id = await projectId('app');
  const res = await api(`/api/projects/${id}/skills/read`, { scope: 'project', source: '.claude/skills (project)', id: 'hello' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.skill.file, undefined, 'field file tidak boleh ikut');
  assert.ok(!JSON.stringify(res.body).includes('skills\\\\hello') && !JSON.stringify(res.body).includes('skills/hello'), 'tidak ada path laptop');
});

test('skills: isi SKILL.md dikenali sebagai rahasia oleh penampil file (tidak dibaca HP WiFi)', async () => {
  const { isSecretPath } = await import('../src/file-view.js');
  assert.equal(isSecretPath('.claude/skills/deploy/SKILL.md'), true);
  assert.equal(isSecretPath('.opencode/skills/x/SKILL.md'), true);
  assert.equal(isSecretPath('docs/notes.md'), false);
});
