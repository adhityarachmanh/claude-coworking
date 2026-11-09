// ⬆ Adhitron's own update (src/app-update.js) against throwaway git repos: a bare "GitHub", the installed copy
// and a second clone that pushes a new commit. No network, nothing outside the temp folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { AppUpdater } from '../src/app-update.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-update-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const ident = (cwd) => (git(cwd, 'config', 'user.email', 't@example.com'), git(cwd, 'config', 'user.name', 'Tester'));

after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

test('check finds the new commits, update pulls them fast-forward; local changes and running turns are refused', async () => {
  const origin = path.join(TMP, 'origin.git');
  const app = path.join(TMP, 'app');
  const dev = path.join(TMP, 'dev');
  git(TMP, 'init', '--bare', '-b', 'main', origin);
  git(TMP, 'clone', origin, app);
  ident(app);
  writeFileSync(path.join(app, 'README.md'), 'v1\n');
  git(app, 'add', '.');
  git(app, 'commit', '-m', 'versi 1');
  git(app, 'push', '-u', 'origin', 'main');
  git(TMP, 'clone', origin, dev);
  ident(dev);
  writeFileSync(path.join(dev, 'README.md'), 'v2\n');
  git(dev, 'commit', '-am', 'Fitur baru: mode otak');
  git(dev, 'push');

  let busy = false;
  const views = [];
  const u = new AppUpdater({ appDir: app, firstCheckMs: -1, busy: () => busy, onChange: (v) => views.push(v) });
  const v = await u.check();
  assert.equal(v.behind, 1);
  assert.equal(v.commits[0].subject, 'Fitur baru: mode otak');
  assert.equal(v.upstream, 'origin/main');
  assert.ok(views.length >= 2, 'every change is published (config → banner)');

  busy = true;
  assert.match((await u.update({ restart: false })).error, /giliran/);
  busy = false;
  writeFileSync(path.join(app, 'README.md'), 'diubah lokal\n');
  assert.match((await u.update({ restart: false })).error, /perubahan lokal/);
  assert.equal(readFileSync(path.join(app, 'README.md'), 'utf8'), 'diubah lokal\n', 'local changes untouched');
  git(app, 'checkout', '--', 'README.md');

  const r = await u.update({ restart: false });
  assert.deepEqual(r, { ok: true, pulled: 1 });
  assert.equal(readFileSync(path.join(app, 'README.md'), 'utf8').trim(), 'v2'); // autocrlf on Windows: \r\n
  assert.equal((await u.check()).behind, 0);
  assert.match((await u.update({ restart: false })).error, /terbaru/);
  u.stop();
});
