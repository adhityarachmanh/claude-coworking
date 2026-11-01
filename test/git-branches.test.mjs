// ⎇ branches & remotes (Perubahan tab): a temporary repo with a local bare "remote" (git init --bare).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { GitError, checkBranchName, compactOutput, gitAction, gitBranches, gitStatus } from '../src/git.js';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}
const skip = !hasGit && 'git not installed';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-git-br-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function newRepo(name) {
  const dir = path.join(TMP, name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}
function commit(dir, file, text, message = `ubah ${file}`) {
  writeFileSync(path.join(dir, file), text);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', message);
}
const refused = (code) => (err) => err instanceof GitError && err.code === code;

test('branch names: options, "..", spaces and other tricks are refused before git runs them', { skip }, async () => {
  const repo = newRepo('names');
  for (const bad of ['--upload-pack=touch pwned', '-b', 'a..b', 'fitur baru', 'tab\tname', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', '@{-1}', 'HEAD', '@', 'x.lock', 'end/', '/start', 'a//b', '.hidden', 'x'.repeat(201), '']) {
    await assert.rejects(checkBranchName(repo, bad), (err) => err instanceof GitError && err.status === 400, JSON.stringify(bad));
  }
  for (const ok of ['fitur/login', 'fix-123', 'release_1.2', 'adhit/ui+git']) assert.equal(await checkBranchName(repo, ok), ok);
  assert.ok(!existsSync(path.join(repo, 'pwned')));
  await assert.rejects(gitAction(repo, { action: 'create', name: '--upload-pack=touch pwned' }), refused('invalid'));
  await assert.rejects(gitAction(repo, { action: 'rebase' }), refused('invalid'));
});

test('list, create, switch (dirty tree asks first), ahead/behind, push sets upstream, pull --ff-only', { skip }, async () => {
  const remote = path.join(TMP, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const repo = newRepo('work');
  commit(repo, 'a.txt', 'satu\n', 'init');
  sh(repo, 'remote', 'add', 'origin', remote);

  let info = await gitBranches(repo);
  assert.equal(info.repo, true);
  assert.equal(info.branch, 'main');
  assert.equal(info.upstream, null);
  assert.deepEqual(info.remotes, ['origin']);
  assert.equal(info.dirty, 0);
  assert.deepEqual(info.branches.map((b) => [b.name, b.current]), [['main', true]]);

  // push without an upstream: --set-upstream to origin
  const pushed = await gitAction(repo, { action: 'push' });
  assert.equal(pushed.upstream, 'origin/main');
  info = await gitBranches(repo);
  assert.equal(info.upstream, 'origin/main');
  assert.equal(sh(remote, 'rev-parse', 'main'), sh(repo, 'rev-parse', 'HEAD'));

  // ahead
  commit(repo, 'a.txt', 'satu\ndua\n');
  info = await gitBranches(repo);
  assert.deepEqual([info.ahead, info.behind], [1, 0]);
  assert.deepEqual([(await gitStatus(repo)).ahead, (await gitStatus(repo)).upstream], [1, 'origin/main'], 'the changes list knows it too');
  await gitAction(repo, { action: 'push' });
  assert.equal((await gitBranches(repo)).ahead, 0);

  // behind: another clone pushes, fetch sees it, pull fast-forwards
  const other = path.join(TMP, 'other');
  execFileSync('git', ['clone', '-q', remote, other]);
  sh(other, 'config', 'user.email', 'o@example.com');
  sh(other, 'config', 'user.name', 'other');
  commit(other, 'b.txt', 'dari clone lain\n');
  sh(other, 'push', '-q');
  assert.equal((await gitBranches(repo)).behind, 0, 'not fetched yet');
  await gitAction(repo, { action: 'fetch' });
  info = await gitBranches(repo);
  assert.deepEqual([info.ahead, info.behind], [0, 1]);
  const pulled = await gitAction(repo, { action: 'pull' });
  assert.equal(pulled.ok, true);
  assert.ok(existsSync(path.join(repo, 'b.txt')));
  assert.equal((await gitBranches(repo)).behind, 0);

  // diverged: pull --ff-only refuses (no merge commit), push is rejected (never forced)
  commit(other, 'b.txt', 'lagi\n');
  sh(other, 'push', '-q');
  commit(repo, 'c.txt', 'lokal\n');
  await assert.rejects(gitAction(repo, { action: 'push' }), (err) => refused('non-ff')(err) && /Pull dulu/.test(err.message) && /rejected/.test(err.output));
  await assert.rejects(gitAction(repo, { action: 'pull' }), (err) => refused('non-ff')(err) && /bercabang/.test(err.message));
  assert.equal(sh(repo, 'rev-list', '--merges', '--count', 'HEAD'), '0', 'no merge commit was made');

  // create + switch
  const created = await gitAction(repo, { action: 'create', name: 'fitur/x' });
  assert.equal(created.branch, 'fitur/x');
  assert.equal((await gitBranches(repo)).branch, 'fitur/x');
  await assert.rejects(gitAction(repo, { action: 'create', name: 'main' }), refused('exists'));
  await assert.rejects(gitAction(repo, { action: 'switch', name: 'tidak-ada' }), refused('not-found'));
  writeFileSync(path.join(repo, 'wip.txt'), 'belum di-commit\n');
  await assert.rejects(gitAction(repo, { action: 'switch', name: 'main' }), (err) => refused('dirty')(err) && /1 file belum di-commit/.test(err.message));
  assert.equal((await gitBranches(repo)).branch, 'fitur/x', 'stayed put');
  const carried = await gitAction(repo, { action: 'switch', name: 'main', carry: true });
  assert.equal(carried.branch, 'main');
  assert.ok(existsSync(path.join(repo, 'wip.txt')), 'the change came along');

  // a new branch pushes with --set-upstream too
  rmSync(path.join(repo, 'wip.txt'));
  await gitAction(repo, { action: 'switch', name: 'fitur/x' });
  assert.equal((await gitAction(repo, { action: 'push' })).upstream, 'origin/fitur/x');
  assert.equal(sh(remote, 'rev-parse', 'fitur/x'), sh(repo, 'rev-parse', 'HEAD'));
});

test('no remote / no upstream / detached HEAD are explained, not attempted', { skip }, async () => {
  const repo = newRepo('lonely');
  commit(repo, 'a.txt', 'x\n', 'init');
  await assert.rejects(gitAction(repo, { action: 'fetch' }), refused('no-remote'));
  await assert.rejects(gitAction(repo, { action: 'push' }), refused('no-remote'));
  await assert.rejects(gitAction(repo, { action: 'pull' }), refused('no-upstream'));
  sh(repo, 'checkout', '-q', '--detach');
  const info = await gitBranches(repo);
  assert.equal(info.detached, true);
  await assert.rejects(gitAction(repo, { action: 'push' }), refused('detached'));
  const plain = mkdtempSync(path.join(TMP, 'nogit-'));
  assert.equal((await gitBranches(plain)).repo, false);
});

test('a remote that needs a login fails fast with a hint, never a prompt; tokens in URLs are hidden', { skip }, async () => {
  const repo = newRepo('auth');
  commit(repo, 'a.txt', 'x\n', 'init');
  // An http remote nobody listens on: git must not wait for a username.
  sh(repo, 'remote', 'add', 'origin', 'http://user:sup3rsecret@127.0.0.1:9/repo.git');
  const started = Date.now();
  const err = await gitAction(repo, { action: 'fetch' }).catch((e) => e);
  assert.ok(err instanceof GitError, String(err));
  assert.ok(Date.now() - started < 60000);
  assert.doesNotMatch(`${err.message}\n${err.output}`, /sup3rsecret/);

  // A remote that asks for a login (HTTP 401): no prompt (GIT_TERMINAL_PROMPT=0), code 'auth' with the hint.
  const server = http.createServer((req, res) => res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    sh(repo, 'remote', 'set-url', 'origin', `http://127.0.0.1:${server.address().port}/repo.git`);
    sh(repo, 'config', 'credential.helper', ''); // no Git Credential Manager window from a test
    const login = await gitAction(repo, { action: 'fetch' }).catch((e) => e);
    assert.ok(refused('auth')(login), `${login.code}: ${login.message}`);
    assert.match(login.message, /butuh login/);
    assert.match(login.message, /tidak pernah meminta atau menyimpan password/);
  } finally {
    server.close();
  }
  assert.equal(compactOutput('fatal: unable to access \'https://ghp_TOKEN@github.com/x.git/\': 403'), "fatal: unable to access 'https://***@github.com/x.git/': 403");
  assert.equal(compactOutput('Receiving objects:  10%\rReceiving objects: 100%, done.\n\u001b[31merror\u001b[0m'), 'Receiving objects: 100%, done.\nerror');
});
