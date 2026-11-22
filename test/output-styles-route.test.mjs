// Output style routes (src/routes/output-styles.js): read on laptop/Tailscale, select/save/delete with the
// laptop/engine/turn gates, and the session restart that makes the next prompt use the new style.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';
import { buildRouter } from '../src/routes/index.js';

const mkCtx = ({ local = true, readOnly = false } = {}) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'osr-data-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'osr-proj-'));
  const hub = new Hub({ dataDir });
  const project = hub.upsertProject(dir, 'custom');
  const session = { reloadSettings: () => 'restarted', turnActive: () => false };
  const sessions = { sessions: new Map([[project.id, session]]), get: () => session };
  return { ctx: { hub, sessions, isLocal: () => local, isReadOnly: () => readOnly, dataDir }, project, dir, session };
};

let router;
const call = async (ctx, pattern, body = {}) => {
  const route = router.routes.find((r) => r.pattern === pattern);
  assert.ok(route, pattern);
  let status = 0;
  let text = '';
  const res = { writeHead: (s) => (status = s), end: (t) => (text = t ?? '') };
  await route.handler(ctx, { local: true, headers: {} }, res, { id: [...ctx.hub.projects.keys()].at(-1) }, body);
  return { status, body: text ? JSON.parse(text) : null };
};

test('route output style: baca, pilih, simpan kustom; gating laptop/Tailscale dan 409 saat giliran berjalan', async () => {
  router = buildRouter();
  const { ctx, dir, session } = mkCtx();
  let reloads = 0;
  session.reloadSettings = () => {
    reloads += 1;
    return 'restarted';
  };
  const read = await call(ctx, '/api/projects/:id/output-styles');
  assert.equal(read.status, 200);
  assert.equal(read.body.current.name, 'default');
  assert.equal(read.body.styles.filter((s) => s.builtin).length, 5);
  assert.equal(Object.hasOwn(read.body.styles.find((s) => s.builtin), 'file'), false, 'path absolut tidak dikirim');

  const sel = await call(ctx, '/api/projects/:id/output-styles/select', { name: 'Concise' });
  assert.equal(sel.status, 200);
  assert.equal(sel.body.applied, 'restarted');
  assert.equal(reloads, 1);
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).outputStyle, 'Concise');

  const saved = await call(ctx, '/api/projects/:id/output-styles/save', { scope: 'project', name: 'Diagram dulu', description: '', keepCodingInstructions: false, body: 'x\n' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.style.slug, 'diagram-dulu');
  const bad = await call(ctx, '/api/projects/:id/output-styles/save', { scope: 'project', name: 'a/b', description: '', keepCodingInstructions: false, body: 'x' });
  assert.equal(bad.status, 400);

  // HP WiFi biasa: baca ditolak; gaya user hanya dari laptop.
  assert.equal((await call(mkCtx({ readOnly: true }).ctx, '/api/projects/:id/output-styles')).status, 403);
  const tail = mkCtx({ local: false });
  assert.equal((await call(tail.ctx, '/api/projects/:id/output-styles/save', { scope: 'user', name: 'Global', description: '', keepCodingInstructions: false, body: 'x' })).status, 403);
  assert.equal((await call(tail.ctx, '/api/projects/:id/output-styles/save', { scope: 'project', name: 'Dari HP', description: '', keepCodingInstructions: false, body: 'x' })).status, 200);

  // Giliran berjalan: pilih/simpan ditolak.
  session.turnActive = () => true;
  assert.equal((await call(ctx, '/api/projects/:id/output-styles/select', { name: 'Concise' })).status, 409);
  assert.equal((await call(ctx, '/api/projects/:id/output-styles/save', { scope: 'project', name: 'Dua', description: '', keepCodingInstructions: false, body: 'x' })).status, 409);
});

test('route output style: hapus gaya yang sedang dipakai ditolak 409', async () => {
  router = buildRouter();
  const { ctx } = mkCtx();
  const saved = await call(ctx, '/api/projects/:id/output-styles/save', { scope: 'project', name: 'Aktif', description: '', keepCodingInstructions: false, body: 'x' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const selected = await call(ctx, '/api/projects/:id/output-styles/select', { name: 'Aktif' });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const del = await call(ctx, '/api/projects/:id/output-styles/delete', { scope: 'project', slug: 'aktif' });
  assert.equal(del.status, 409);
  assert.match(del.body.error, /Ganti|aktif/i);
});
