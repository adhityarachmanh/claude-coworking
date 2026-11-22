// OpenCode command routes: list/read on laptop/Tailscale, project writes over Tailscale, global writes on the
// laptop only, and no route while the project's engine is Claude.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';
import { buildRouter } from '../src/routes/index.js';

process.env.OFFICE_OPENCODE_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'occ-home-'));

const mkCtx = ({ local = true, readOnly = false, engine = 'opencode' } = {}) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'occ-data-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'occ-proj-'));
  const hub = new Hub({ dataDir });
  const project = hub.upsertProject(dir, 'custom');
  hub.engineOf = () => engine;
  return { ctx: { hub, isLocal: () => local, isReadOnly: () => readOnly, dataDir }, project, dir };
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

test('route command: daftar, simpan project dari Tailscale, baca dari WiFi ditolak', async () => {
  router = buildRouter();
  const { ctx, dir } = mkCtx({ local: false });
  const empty = await call(ctx, '/api/projects/:id/opencode-commands');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.commands, []);
  assert.ok(empty.body.roots.some((root) => root.scope === 'project'));

  const saved = await call(ctx, '/api/projects/:id/opencode-commands/save', { scope: 'project', source: '.opencode/commands (project)', id: 'review', description: 'Review', agent: '', model: '', subagent: false, template: 'Review $ARGUMENTS\n' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.match(readFileSync(path.join(dir, '.opencode', 'commands', 'review.md'), 'utf8'), /Review \$ARGUMENTS/);

  const read = await call(ctx, '/api/projects/:id/opencode-commands/read', { scope: 'project', source: '.opencode/commands (project)', id: 'review' });
  assert.equal(read.status, 200);
  assert.equal(read.body.command.template, 'Review $ARGUMENTS\n');

  const wifi = ctx.isReadOnly;
  ctx.isReadOnly = () => true;
  assert.equal((await call(ctx, '/api/projects/:id/opencode-commands')).status, 403);
  assert.equal((await call(ctx, '/api/projects/:id/opencode-commands/read', { scope: 'project', source: '.opencode/commands (project)', id: 'review' })).status, 403);
  ctx.isReadOnly = wifi;
});

test('route command: global hanya dari laptop, id tak sah 400, mesin Claude 409', async () => {
  router = buildRouter();
  const tail = mkCtx({ local: false });
  assert.equal((await call(tail.ctx, '/api/projects/:id/opencode-commands/save', { scope: 'user', id: 'global', description: '', agent: '', model: '', subagent: false, template: 'x' })).status, 403);
  const laptop = mkCtx();
  assert.equal((await call(laptop.ctx, '/api/projects/:id/opencode-commands/save', { scope: 'user', id: 'global', description: '', agent: '', model: '', subagent: false, template: 'x' })).status, 200);
  assert.equal((await call(laptop.ctx, '/api/projects/:id/opencode-commands/save', { scope: 'project', id: '../evil', description: '', agent: '', model: '', subagent: false, template: 'x' })).status, 400);
  assert.equal((await call(laptop.ctx, '/api/projects/:id/opencode-commands/delete', { scope: 'user', id: 'global' })).status, 200);

  const claude = mkCtx({ engine: 'claude' });
  assert.equal((await call(claude.ctx, '/api/projects/:id/opencode-commands')).status, 409);
});
