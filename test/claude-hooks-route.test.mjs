// Claude hooks routes: save/delete a command hook in the project settings, Claude-only, user scope from the laptop.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';
import { buildRouter } from '../src/routes/index.js';

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'hooks-route-home-'));

const mkCtx = ({ local = true, engine = 'claude' } = {}) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'hooks-route-data-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'hooks-route-proj-'));
  const hub = new Hub({ dataDir });
  const project = hub.upsertProject(dir, 'custom');
  hub.engineOf = () => engine;
  const session = { reloadSettings: () => 'none', turnActive: () => false };
  const sessions = { sessions: new Map([[project.id, session]]), get: () => session };
  return { ctx: { hub, sessions, isLocal: () => local, isReadOnly: () => false, dataDir }, project, dir };
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

test('route hooks: simpan project, hapus, user scope dari Tailscale ditolak', async () => {
  router = buildRouter();
  const { ctx, dir } = mkCtx();
  const saved = await call(ctx, '/api/projects/:id/hooks/save', { scope: 'project', event: 'PreToolUse', matcher: 'Edit', command: 'npm run lint', timeout: 30 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const file = path.join(dir, '.claude', 'settings.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse[0].hooks[0].command, 'npm run lint');
  const listed = await call(ctx, '/api/projects/:id/hooks');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.hooks.some((h) => h.event === 'PreToolUse'));

  const del = await call(ctx, '/api/projects/:id/hooks/delete', { scope: 'project', event: 'PreToolUse', matcher: 'Edit', command: 'npm run lint' });
  assert.equal(del.status, 200);

  const tail = mkCtx({ local: false });
  assert.equal((await call(tail.ctx, '/api/projects/:id/hooks/save', { scope: 'user', event: 'PreToolUse', command: 'x' })).status, 403);
  const claudeOff = mkCtx({ engine: 'opencode' });
  assert.equal((await call(claudeOff.ctx, '/api/projects/:id/hooks/save', { scope: 'project', event: 'PreToolUse', command: 'x' })).status, 409);
});
