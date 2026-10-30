import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { gitCommit, gitDiff, gitStatus } from '../src/git.js';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

const repo = mkdtempSync(path.join(tmpdir(), 'office-git-'));
const plain = mkdtempSync(path.join(tmpdir(), 'office-nogit-'));
after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

test('changes panel: status, diffs, commit', { skip: !hasGit && 'git not installed' }, async () => {
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  writeFileSync(path.join(repo, 'a.txt'), 'satu\n');
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '.');
  git('commit', '-qm', 'init');
  writeFileSync(path.join(repo, 'a.txt'), 'satu\ndua\n');
  writeFileSync(path.join(repo, 'baru.txt'), 'isi baru\n');

  const status = await gitStatus(repo);
  assert.equal(status.repo, true);
  assert.deepEqual(status.files.map((f) => [f.path, f.status]), [['a.txt', 'diubah'], ['baru.txt', 'baru']]);

  assert.match((await gitDiff(repo, 'a.txt')).diff, /^\+dua$/m);
  assert.match((await gitDiff(repo, 'baru.txt')).diff, /^\+isi baru$/m);
  // only files git reports can be diffed — no reading arbitrary paths
  assert.equal((await gitDiff(repo, '../../etc/passwd')).diff, '');

  const commit = await gitCommit(repo, 'tes commit');
  assert.equal(commit.ok, true);
  assert.deepEqual((await gitStatus(repo)).files, []);
});

test('a folder without git is reported, not an error', async () => {
  assert.equal((await gitStatus(plain)).repo, false);
});
