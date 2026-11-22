// Session workspace: restartKey includes workspacePath, spawn uses it as cwd, and a new workspace gets no --resume.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';
import { SessionManager } from '../src/session.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits (bounded) for the fake CLI to write its record, then returns it. */
async function waitRecord(file, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        // still being written
      }
    }
    await sleep(25);
  }
  throw new Error(`fake CLI tidak menulis record dalam ${deadlineMs} ms`);
}

/** A fake claude CLI: records its cwd + argv to a file, then exits without a turn. */
function fakeClaude(recordFile) {
  const script = path.join(path.dirname(recordFile), 'fake-claude.cjs');
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\n`);
  return { command: process.execPath, args: [script] };
}

function freshHubAndProject(prefix) {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), `${prefix}-data-`)) });
  const dir = mkdtempSync(path.join(tmpdir(), `${prefix}-proj-`));
  const project = hub.upsertProject(dir, 'custom');
  return { hub, dir, project };
}

test('settingsFor membawa workspacePath: path project, lalu path worktree setelah masuk', () => {
  const { hub, dir, project } = freshHubAndProject('sk');
  try {
    const s = hub.settingsFor(project.id);
    assert.equal(s.workspacePath, project.path, 'tanpa worktree, workspacePath = path project');

    const wtPath = path.join(project.path, '.claude', 'worktrees', 'login');
    mkdirSync(wtPath, { recursive: true });
    hub.setWorktree(project.id, { name: 'login', path: wtPath, branch: 'worktree-login' });

    const s2 = hub.settingsFor(project.id);
    assert.equal(s2.workspacePath, wtPath, 'dengan worktree, workspacePath = path worktree');
    assert.notEqual(s.workspacePath, s2.workspacePath, 'workspacePath berubah setelah setWorktree');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn: cwd = workspacePathFor dan tanpa --resume di workspace baru', async () => {
  const { hub, dir, project } = freshHubAndProject('spw');
  try {
    const record = path.join(dir, 'spawn-record.json');
    const manager = new SessionManager({ hub, claude: fakeClaude(record), opencode: null, agents: {}, teamPrompt: '', ledger: null, account: null });
    const session = manager.get(project);

    // 1) A spawn in the project folder: cwd is the project folder, no --resume (no conversation yet).
    session.spawn(hub.settingsFor(project.id));
    const first = await waitRecord(record);
    assert.equal(path.resolve(first.cwd), path.resolve(project.path), 'cwd awal = folder project');
    assert.ok(!first.argv.includes('--resume'), 'tanpa percakapan, tidak ada --resume');
    session.closeChild();

    // 2) Entering a worktree: the next spawn runs there and still passes no --resume (that workspace has no conversation).
    const wtPath = path.join(project.path, '.claude', 'worktrees', 'login');
    mkdirSync(wtPath, { recursive: true });
    rmSync(record, { force: true });
    hub.setWorktree(project.id, { name: 'login', path: wtPath, branch: 'worktree-login' });
    session.spawn(hub.settingsFor(project.id));
    const second = await waitRecord(record);
    assert.equal(path.resolve(second.cwd), path.resolve(wtPath), 'cwd setelah masuk worktree = folder worktree');
    assert.ok(!second.argv.includes('--resume'), 'workspace baru: tidak mewarisi --resume lintas cwd');
    session.closeChild();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('sessionIdFor: percakapan project folder tidak terbawa ke worktree', () => {
  const { hub, dir, project } = freshHubAndProject('sid');
  try {
    const id = '11111111-2222-3333-4444-555555555555';
    hub.setSessionId(project.id, id);
    assert.equal(hub.sessionIdFor(project.id), id, 'percakapan project folder tersimpan');

    const wtPath = path.join(project.path, '.claude', 'worktrees', 'login');
    mkdirSync(wtPath, { recursive: true });
    hub.setWorktree(project.id, { name: 'login', path: wtPath, branch: 'worktree-login' });
    assert.equal(hub.sessionIdFor(project.id), null, 'worktree baru belum punya percakapan sendiri');

    hub.setSessionId(project.id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    hub.setWorktree(project.id, null);
    assert.equal(hub.sessionIdFor(project.id), id, 'kembali ke folder project: percakapan lama utuh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});