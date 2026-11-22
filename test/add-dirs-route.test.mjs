// Folder tambahan routes: list (laptop/Tailscale), add/remove (laptop only). The route validates the path through
// src/add-dirs.js and stores the cleaned list in the project's settings; a change reaches the next Claude process.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hub } from '../src/hub.js';
import { buildRouter } from '../src/routes/index.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-dirs-route-'));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const router = buildRouter();
const hub = new Hub({ dataDir: path.join(TMP, 'data') });
const project = hub.upsertProject(mkdtempSync(path.join(TMP, 'project-')), 'custom');
const sessions = { sessions: new Map() };
const ctx = { hub, sessions, isLocal: (req) => req.local !== false };

/** Calls a registered route like server.js does (after its own gates); resolves { status, body }. */
async function callRoute(pattern, req = { local: true }, body = {}) {
  const route = router.routes.find((r) => r.pattern === pattern);
  assert.ok(route, pattern);
  let status = 0;
  let text = '';
  const res = { writeHead: (s) => (status = s), end: (t) => (text = t ?? '') };
  await route.handler(ctx, req, res, { id: project.id }, body);
  return { status, body: text ? JSON.parse(text) : null };
}

const call = (pattern, body = {}, req = { local: true }) => callRoute(pattern, req, body);
const extraDir = () => mkdtempSync(path.join(TMP, 'extra-'));

test('daftar kosong, tambah dari laptop, bertahan di settings, lalu hapus', async () => {
  const extra = extraDir();
  assert.deepEqual((await call('/api/projects/:id/dirs')).body, { dirs: [], max: 10 });
  const added = (await call('/api/projects/:id/dirs-add', { path: extra })).body;
  assert.deepEqual(added, { dirs: [{ path: extra, exists: true }], max: 10 });
  assert.deepEqual(hub.settingsFor(project.id).additionalDirectories, [extra]);
  assert.deepEqual((await call('/api/projects/:id/dirs-remove', { path: extra })).body, { dirs: [], max: 10 });
  assert.deepEqual(hub.settingsFor(project.id).additionalDirectories, []);
});

test('path relatif 400, duplikat 409, dan bukan dari laptop 403', async () => {
  assert.equal((await call('/api/projects/:id/dirs-add', { path: 'relatif' })).status, 400);
  const extra = extraDir();
  assert.equal((await call('/api/projects/:id/dirs-add', { path: extra })).status, 200);
  assert.equal((await call('/api/projects/:id/dirs-add', { path: extra })).status, 409);
  assert.equal((await call('/api/projects/:id/dirs-add', { path: extra }, { local: false })).status, 403);
  assert.equal((await call('/api/projects/:id/dirs-remove', { path: extra }, { local: false })).status, 403);
  await call('/api/projects/:id/dirs-remove', { path: extra });
});

test('giliran berjalan menolak 409 dan engine OpenCode menolak 409', async () => {
  sessions.sessions.set(project.id, { turnActive: () => true });
  assert.equal((await call('/api/projects/:id/dirs-add', { path: extraDir() })).status, 409);
  assert.equal((await call('/api/projects/:id/dirs-remove', { path: extraDir() })).status, 409);
  assert.equal((await call('/api/projects/:id/dirs')).status, 200, 'daftar tetap boleh dibaca saat giliran berjalan');
  sessions.sessions.clear();
  hub.updateSettings(project.id, { engine: 'opencode', model: 'opencode/big-pickle' });
  assert.equal((await call('/api/projects/:id/dirs')).status, 409);
  assert.equal((await call('/api/projects/:id/dirs-add', { path: extraDir() })).status, 409);
  hub.updateSettings(project.id, { engine: 'claude' });
});

test('menambah folder memberi tahu sesi yang hidup dan menulis baris chat', async () => {
  const extra = extraDir();
  let synced = 0;
  sessions.sessions.set(project.id, { turnActive: () => false, syncSettings: () => synced++ });
  assert.equal((await call('/api/projects/:id/dirs-add', { path: extra })).status, 200);
  assert.equal(synced, 1, 'sesi diminta menyesuaikan diri (proses berikutnya)');
  const line = hub.chatOf(project.id).at(-1);
  assert.match(line.text, /Folder tambahan ditambahkan/);
  sessions.sessions.clear();
});
