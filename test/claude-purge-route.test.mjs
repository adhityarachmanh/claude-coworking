// 🧹 Purge routes: the dry-run plan first, and the destructive call only with the project path typed back, laptop only,
// never during a turn. The CLI is faked with a node one-liner so no real `claude purge` ever runs in a test.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';
import { buildRouter } from '../src/routes/index.js';

const fakeClaude = { command: process.execPath, args: ['-e', 'console.log(process.argv.slice(1).join(" "))'] };

const mkCtx = ({ local = true, engine = 'claude', busy = false, active = false } = {}) => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'purge-data-')) });
  const dir = mkdtempSync(path.join(tmpdir(), 'purge-proj-'));
  const project = hub.upsertProject(dir, 'custom');
  hub.engineOf = () => engine;
  const calls = { closed: 0 };
  const session = { turnActive: () => busy, busy: false, inflight: new Set(), closeChild: () => calls.closed++ };
  const sessions = { sessions: new Map(active ? [[project.id, session]] : []), get: () => session };
  return { ctx: { hub, sessions, claude: fakeClaude, isLocal: () => local, isReadOnly: () => false }, project, dir, calls, hub };
};

let router;
const call = async (ctx, pattern, body = {}, id) => {
  const route = router.routes.find((r) => r.pattern === pattern);
  assert.ok(route, pattern);
  let status = 0;
  let text = '';
  const res = { writeHead: (s) => (status = s), end: (t) => (text = t ?? '') };
  await route.handler(ctx, { local: true, headers: {} }, res, { id }, body);
  return { status, body: text ? JSON.parse(text) : null };
};

test('purge: pratinjau dry-run, konfirmasi path, dan state sesi dibersihkan', async () => {
  router = buildRouter();
  const { ctx, project, calls, hub } = mkCtx({ active: true });
  hub.setSessionId(project.id, 'sesi-lama');
  hub.persisted.interrupted[project.id] = { prompt: 'x' };
  const plan = await call(ctx, '/api/projects/:id/claude-purge/plan', {}, project.id);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.match(plan.body.output, /--dry-run/);
  assert.equal(calls.closed, 0, 'pratinjau tidak menyentuh proses');

  assert.equal((await call(ctx, '/api/projects/:id/claude-purge', { confirm: 'salah' }, project.id)).status, 400);
  assert.equal(calls.closed, 0, 'konfirmasi salah tidak menutup proses');
  const done = await call(ctx, '/api/projects/:id/claude-purge', { confirm: project.path }, project.id);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(done.body.output, /--yes/);
  assert.equal(calls.closed, 1);
  assert.equal(hub.sessionIdFor(project.id), null, 'sesi yang transcript-nya dihapus tidak dilanjutkan');
  assert.equal(hub.persisted.interrupted[project.id], undefined);
});

test('purge: menolak giliran berjalan, engine OpenCode, dan klien non-laptop', async () => {
  router = buildRouter();
  const busy = mkCtx({ busy: true });
  const refused = await call(busy.ctx, '/api/projects/:id/claude-purge/plan', {}, busy.project.id);
  assert.equal(refused.status, 409);
  const openCode = mkCtx({ engine: 'opencode' });
  assert.equal((await call(openCode.ctx, '/api/projects/:id/claude-purge/plan', {}, openCode.project.id)).status, 409);
  const tail = mkCtx({ local: false });
  assert.equal((await call(tail.ctx, '/api/projects/:id/claude-purge/plan', {}, tail.project.id)).status, 403);
});

test('purge: project tanpa data Claude bukan kegagalan, dan worktree aktif jadi sasaran', async () => {
  router = buildRouter();
  const empty = mkCtx();
  empty.ctx.claude = { command: process.execPath, args: ['-e', 'console.error("No Claude Code project data found for x"); process.exit(1)'] };
  const plan = await call(empty.ctx, '/api/projects/:id/claude-purge/plan', {}, empty.project.id);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(plan.body.output, '', 'pratinjau kosong, bukan error');

  const withTree = mkCtx();
  const wt = mkdtempSync(path.join(tmpdir(), 'purge-wt-'));
  withTree.hub.setWorktree(withTree.project.id, { name: 'feature', path: wt, branch: 'feature' });
  const treePlan = await call(withTree.ctx, '/api/projects/:id/claude-purge/plan', {}, withTree.project.id);
  assert.equal(treePlan.body.path, wt, 'yang dibersihkan folder kerja yang sedang dipakai');
  const refused = await call(withTree.ctx, '/api/projects/:id/claude-purge', { confirm: withTree.project.path }, withTree.project.id);
  assert.equal(refused.status, 400, 'path project induk tidak sah saat worktree aktif');
});
