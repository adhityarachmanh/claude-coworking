// Worktree as a project attribute (src/hub.js): workspace path, stored worktree, and exclusion from discovery.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';

test('worktree = atribut project; workspacePathFor mengikuti', () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'office-wt-')) });
  const dir = mkdtempSync(path.join(tmpdir(), 'proj-'));
  const project = hub.upsertProject(dir, 'custom');
  assert.equal(hub.worktreeOf(project.id), null);
  assert.equal(hub.workspacePathFor(project.id), project.path, 'tanpa worktree = folder project');

  const wtPath = path.join(project.path, '.claude', 'worktrees', 'login');
  mkdirSync(wtPath, { recursive: true });
  hub.setWorktree(project.id, { name: 'login', path: wtPath, branch: 'worktree-login' });
  assert.deepEqual(hub.worktreeOf(project.id), { name: 'login', path: wtPath, branch: 'worktree-login' });
  assert.equal(hub.workspacePathFor(project.id), wtPath);
  assert.equal(hub.projects.get(project.id).path, project.path, 'path project induk tidak berubah');

  hub.setWorktree(project.id, null);
  assert.equal(hub.workspacePathFor(project.id), project.path);
});

test('cleanSettings: worktree divalidasi, junk diabaikan', () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'office-wtc-')) });
  hub.projects.set('p1', { id: 'p1', path: 'C:/p', name: 'p1', sources: ['custom'] });
  const base = hub.settingsFor('p1');
  assert.equal(hub.cleanSettings(base, { worktree: 'junk' }).worktree, undefined, 'junk tidak tersimpan');
  const ok = hub.cleanSettings(base, { worktree: { name: 'x', path: 'C:/p/.claude/worktrees/x', branch: 'worktree-x' } });
  assert.deepEqual(ok.worktree, { name: 'x', path: 'C:/p/.claude/worktrees/x', branch: 'worktree-x' });
  assert.equal(hub.cleanSettings(base, { worktree: null }).worktree, null, 'null menghapus');
});

test('discoverProjects melewati folder di bawah .claude/worktrees', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'root-'));
  const proj = path.join(root, 'app'); mkdirSync(proj);
  const wt = path.join(proj, '.claude', 'worktrees', 'login'); mkdirSync(wt, { recursive: true });
  const { discoverProjects } = await import('../src/projects.js');
  const found = discoverProjects({ roots: [root], extra: [] }).map(([d]) => d);
  assert.ok(found.includes(proj));
  assert.ok(!found.includes(wt), 'worktree bukan project');
});

test('discoverProjects: folder worktree yang dicatat ~/.claude.json tetap bukan project', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'wtcfg-'));
  const root = path.join(base, 'projects');
  const proj = path.join(root, 'app');
  const wt = path.join(proj, '.claude', 'worktrees', 'login');
  const config = path.join(base, 'claude.json');
  const before = process.env.CLAUDE_CONFIG_FILE;
  try {
    mkdirSync(wt, { recursive: true });
    // Claude Code records the worktree's cwd as if it were a project folder; the mirror/discovery must ignore it.
    writeFileSync(config, JSON.stringify({ projects: { [proj]: {}, [wt]: {} } }));
    process.env.CLAUDE_CONFIG_FILE = config;
    const { discoverProjects } = await import('../src/projects.js');
    const found = discoverProjects({ roots: [root], extra: [] }).map(([d]) => path.resolve(d));
    assert.ok(found.includes(path.resolve(proj)), 'project induk tetap ada');
    assert.ok(!found.includes(path.resolve(wt)), 'worktree dari ~/.claude.json tetap bukan project');
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_FILE;
    else process.env.CLAUDE_CONFIG_FILE = before;
    rmSync(base, { recursive: true, force: true });
  }
});