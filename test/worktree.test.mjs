// Git worktrees for a project (src/worktree.js): the app runs git itself, then points the engine's cwd there.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import path from 'node:path';
import {
  createWorktree,
  isGitRepo,
  isWorktreeDir,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
  validWorktreeName,
  WorktreeError,
  worktreeBranch,
  worktreePath,
} from '../src/worktree.js';

test('validWorktreeName: pola lowercase kebab, 1–64 char', () => {
  assert.equal(validWorktreeName('login'), true);
  assert.equal(validWorktreeName('a'.repeat(64)), true);
  assert.equal(validWorktreeName('a'.repeat(65)), false);
  assert.equal(validWorktreeName('Login'), false);
  assert.equal(validWorktreeName('../evil'), false);
  assert.equal(validWorktreeName('a/b'), false);
  assert.equal(validWorktreeName('-x'), false);
  assert.equal(validWorktreeName(''), false);
});

test('worktreePath & worktreeBranch', () => {
  assert.equal(worktreePath('C:/p', 'login'), path.join('C:/p', '.claude', 'worktrees', 'login'));
  assert.equal(worktreeBranch('login'), 'worktree-login');
});

test('isWorktreeDir: hanya di bawah .claude/worktrees', () => {
  assert.equal(isWorktreeDir(path.join('.claude', 'worktrees', 'x')), true);
  assert.equal(isWorktreeDir('src'), false);
  assert.equal(isWorktreeDir('.claude/worktrees-other/x'), false);
});

test('parseWorktreeList: blok porcelain → path/branch/head + isMain pertama', () => {
  const text = [
    'worktree C:/p',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree C:/p/.claude/worktrees/login',
    'HEAD def456',
    'branch refs/heads/worktree-login',
    '',
  ].join('\n');
  const list = parseWorktreeList(text);
  assert.equal(list.length, 2);
  assert.equal(list[0].isMain, true);
  assert.equal(list[0].branch, 'main');
  assert.equal(list[1].path, 'C:/p/.claude/worktrees/login');
  assert.equal(list[1].branch, 'worktree-login');
  assert.equal(list[1].isMain, false);
});

function freshRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wt-'));
  const run = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'a.txt'), 'hi');
  run('add', '-A'); run('commit', '-qm', 'init');
  return dir;
}

test('isGitRepo: true di repo, false di folder biasa', async () => {
  const repo = freshRepo();
  const plain = mkdtempSync(path.join(tmpdir(), 'plain-'));
  try {
    assert.equal(await isGitRepo(repo), true);
    assert.equal(await isGitRepo(plain), false);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); }
});

test('create/list/remove worktree', async () => {
  const repo = freshRepo();
  try {
    const wt = await createWorktree(repo, 'login');
    assert.equal(wt.branch, 'worktree-login');
    const list = await listWorktrees(repo);
    assert.ok(list.some((w) => w.branch === 'worktree-login'));
    await removeWorktree(repo, wt.path, { force: false });
    assert.ok(!(await listWorktrees(repo)).some((w) => w.branch === 'worktree-login'));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('createWorktree: nama tak sah & non-git ditolak tanpa memanggil git', async () => {
  const plain = mkdtempSync(path.join(tmpdir(), 'plain-'));
  try {
    await assert.rejects(() => createWorktree(plain, 'login'), (e) => e instanceof WorktreeError && e.code === 'no-repo');
    await assert.rejects(() => createWorktree(plain, '../x'), (e) => e instanceof WorktreeError && e.code === 'invalid-name');
  } finally { rmSync(plain, { recursive: true, force: true }); }
});

test('removeWorktree: worktree dengan perubahan ditolak tanpa force', async () => {
  const repo = freshRepo();
  try {
    const wt = await createWorktree(repo, 'wip');
    writeFileSync(path.join(wt.path, 'dirty.txt'), 'x');
    await assert.rejects(() => removeWorktree(repo, wt.path, { force: false }), (e) => e instanceof WorktreeError && e.code === 'dirty');
    await removeWorktree(repo, wt.path, { force: true });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('createWorktree: nama yang sama bisa dibuat ulang setelah remove (branch lama dipakai)', async () => {
  const repo = freshRepo();
  try {
    const first = await createWorktree(repo, 'login');
    await removeWorktree(repo, first.path, { force: false });
    // Removing a worktree leaves its branch behind; re-creating must reattach it, not fail with "exists".
    const again = await createWorktree(repo, 'login');
    assert.equal(again.branch, 'worktree-login');
    assert.ok((await listWorktrees(repo)).some((w) => w.branch === 'worktree-login'));
    await removeWorktree(repo, again.path, { force: false });
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('removeWorktree: folder yang dihapus manual dibersihkan lewat prune (bukan error)', async () => {
  const repo = freshRepo();
  try {
    const wt = await createWorktree(repo, 'gone');
    rmSync(wt.path, { recursive: true, force: true });
    // git refuses a stale registration ("is not a working tree"); the row must still be clearable.
    await removeWorktree(repo, wt.path, { force: true });
    assert.ok(!(await listWorktrees(repo)).some((w) => w.branch === 'worktree-gone'), 'registrasi ikut dibersihkan');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});