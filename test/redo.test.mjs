// ⏪↩ Redo setelah code rewind (src/redo.js): perubahan worktree yang belum di-commit disimpan sebelum rewind,
// lalu dipulihkan byte-identik — termasuk konflik, file yang harus dihapus lagi, retensi, dan symlink.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { applyRedo, captureRedo, listRedo, previewRedo, sealRedo } from '../src/redo.js';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

const TMP = mkdtempSync(path.join(tmpdir(), 'office-redo-'));
const DATA = path.join(TMP, 'data');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

/** A fresh git repository with one commit; `files` are committed as they are. */
function repo(name, files) {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'awal');
  return { dir, git };
}

test('redo: a modified tracked file and a new untracked file come back byte-identical; a deleted one is deleted again', { skip: !hasGit && 'git tidak terpasang' }, async () => {
  const { dir, git } = repo('repo1', { 'a.txt': 'satu\n', 'hapus.txt': 'akan dihapus\n' });
  const projectId = 'toko-1';

  // The work the rewind will overwrite: one file changed, one new, one deleted.
  writeFileSync(path.join(dir, 'a.txt'), 'satu\ndua\n');
  writeFileSync(path.join(dir, 'baru.txt'), 'isi baru\n');
  unlinkSync(path.join(dir, 'hapus.txt'));

  const cap = await captureRedo({ projectPath: dir, dataDir: DATA, projectId, engine: 'claude' });
  assert.equal(cap.ok, true);
  assert.match(cap.id, /^rd_[a-z0-9]{8,40}$/);
  assert.equal(cap.files, 3);
  assert.deepEqual(cap.unsupported, []);

  // The rewind: HEAD back into the worktree, the untracked file gone (Claude/OpenCode both do this).
  git('checkout', '--', 'a.txt', 'hapus.txt');
  rmSync(path.join(dir, 'baru.txt'));

  const sealed = await sealRedo({ dataDir: DATA, projectId, id: cap.id, projectPath: dir });
  assert.deepEqual([sealed.id, sealed.files], [cap.id, 3]);

  const pv = await previewRedo({ dataDir: DATA, projectId, id: cap.id, projectPath: dir });
  assert.deepEqual(
    pv.files.map((f) => ({ path: f.path, action: f.action, conflict: f.conflict })).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: 'a.txt', action: 'restore', conflict: false },
      { path: 'baru.txt', action: 'restore', conflict: false },
      { path: 'hapus.txt', action: 'delete', conflict: false },
    ],
  );
  assert.equal(pv.conflicts, 0);
  assert.deepEqual(pv.unsupported, []);

  const applied = await applyRedo({ dataDir: DATA, projectId, id: cap.id, projectPath: dir });
  assert.deepEqual(applied, { restored: 2, skipped: 0, deleted: 1, conflicts: 0 });
  assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'satu\ndua\n', 'the tracked change is back');
  assert.equal(readFileSync(path.join(dir, 'baru.txt'), 'utf8'), 'isi baru\n', 'the untracked file is recreated');
  assert.equal(existsSync(path.join(dir, 'hapus.txt')), false, 'deleted before the rewind → deleted again');

  // Kept for the next redo, so it is listed.
  const { bundles } = await listRedo({ dataDir: DATA, projectId });
  assert.equal(bundles[0].id, cap.id);
  assert.equal(bundles[0].files, 3);
});

test('redo: a file changed after the rewind is a conflict — skipped without overwrite, restored (with a backup) with it', { skip: !hasGit && 'git tidak terpasang' }, async () => {
  const { dir, git } = repo('repo2', { 'a.txt': 'v1\n' });
  const projectId = 'toko-2';
  writeFileSync(path.join(dir, 'a.txt'), 'v2\n');

  const cap = await captureRedo({ projectPath: dir, dataDir: DATA, projectId, engine: 'opencode' });
  assert.equal(cap.ok, true);
  git('checkout', '--', 'a.txt'); // the rewind puts HEAD back
  await sealRedo({ dataDir: DATA, projectId, id: cap.id, projectPath: dir });

  writeFileSync(path.join(dir, 'a.txt'), 'diubah setelah rewind\n'); // the user's own edit, after the rewind
  const pv = await previewRedo({ dataDir: DATA, projectId, id: cap.id, projectPath: dir });
  assert.equal(pv.conflicts, 1);
  assert.equal(pv.files[0].conflict, true);

  const safe = await applyRedo({ dataDir: DATA, projectId, id: cap.id, projectPath: dir });
  assert.deepEqual(safe, { restored: 0, skipped: 1, deleted: 0, conflicts: 1 });
  assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'diubah setelah rewind\n', 'nothing overwritten without asking');
  assert.equal(existsSync(path.join(DATA, 'redo', projectId, cap.id, 'undo', 'a.txt')), false, 'no backup for a skipped file');

  const forced = await applyRedo({ dataDir: DATA, projectId, id: cap.id, projectPath: dir, overwrite: true });
  assert.deepEqual(forced, { restored: 1, skipped: 0, deleted: 0, conflicts: 1 });
  assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'v2\n', 'the pre-rewind content is back');
  assert.equal(readFileSync(path.join(DATA, 'redo', projectId, cap.id, 'undo', 'a.txt'), 'utf8'), 'diubah setelah rewind\n', 'the overwritten bytes are kept');
});

test('redo: not a git repository → capture refuses (ok:false), nothing created', { skip: !hasGit && 'git tidak terpasang' }, async () => {
  const dir = path.join(TMP, 'bukan-repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  const cap = await captureRedo({ projectPath: dir, dataDir: DATA, projectId: 'toko-3', engine: 'claude' });
  assert.deepEqual(cap, { ok: false, reason: 'bukan repo git' });
  assert.equal(existsSync(path.join(DATA, 'redo', 'toko-3')), false);
});

test('redo: ids are checked before they reach a path (400), an unknown bundle is 404', { skip: !hasGit && 'git tidak terpasang' }, async () => {
  const { dir } = repo('repo4', { 'a.txt': 'x\n' });
  const projectId = 'toko-4';
  writeFileSync(path.join(dir, 'a.txt'), 'y\n');
  const cap = await captureRedo({ projectPath: dir, dataDir: DATA, projectId, engine: 'claude' });
  await sealRedo({ dataDir: DATA, projectId, id: cap.id, projectPath: dir });

  for (const id of ['', '../' + cap.id, 'rd_', 'rd_ABCDEFGH', 'rd_../x', 'x'.repeat(60)]) {
    for (const call of [previewRedo, applyRedo]) {
      await assert.rejects(call({ dataDir: DATA, projectId, id, projectPath: dir }), (err) => err.status === 400, `${call.name} ${id}`);
    }
  }
  await assert.rejects(previewRedo({ dataDir: DATA, projectId, id: 'rd_zzzzzzzz', projectPath: dir }), (err) => err.status === 404);
  await assert.rejects(applyRedo({ dataDir: DATA, projectId, id: 'rd_zzzzzzzz', projectPath: dir }), (err) => err.status === 404);
  await assert.rejects(previewRedo({ dataDir: DATA, projectId: 'x'.repeat(80), id: cap.id, projectPath: dir }), (err) => err.status === 400);
});

test('redo: retention keeps the 5 newest bundles, older ones are dropped', { skip: !hasGit && 'git tidak terpasang' }, async () => {
  const { dir } = repo('repo5', { 'b.txt': 'awal\n' });
  const projectId = 'toko-5';
  const ids = [];
  for (let i = 0; i < 6; i++) {
    await sleep(5); // createdAt must differ: the newest five are decided by it
    writeFileSync(path.join(dir, 'b.txt'), `v${i}\n`);
    const cap = await captureRedo({ projectPath: dir, dataDir: DATA, projectId, engine: 'claude' });
    assert.equal(cap.ok, true);
    await sealRedo({ dataDir: DATA, projectId, id: cap.id, projectPath: dir });
    ids.push(cap.id);
  }
  const { bundles } = await listRedo({ dataDir: DATA, projectId });
  assert.equal(bundles.length, 5);
  assert.deepEqual(bundles.map((b) => b.id), ids.slice(1).reverse(), 'newest first, the oldest dropped');
  assert.equal(existsSync(path.join(DATA, 'redo', projectId, ids[0])), false, 'the oldest bundle is gone from disk');
  assert.equal(readdirSync(path.join(DATA, 'redo', projectId)).length, 5);
});

test('redo: a symlink is never captured, and never written through', { skip: !hasGit && 'git tidak terpasang' }, async (t) => {
  const outside = path.join(TMP, 'rahasia.txt');
  writeFileSync(outside, 'RAHASIA-JANGAN-DITULIS\n');

  const one = repo('repo6', { 'a.txt': 'x\n' });
  try {
    symlinkSync(outside, path.join(one.dir, 'tautan.txt'), 'file');
  } catch {
    return t.skip('symlink tidak bisa dibuat di sini (Windows tanpa hak)');
  }
  const cap = await captureRedo({ projectPath: one.dir, dataDir: DATA, projectId: 'toko-6', engine: 'claude' });
  assert.equal(cap.ok, true);
  assert.equal(cap.files, 0, 'a link is not a file to restore');
  assert.deepEqual(cap.unsupported.map((u) => [u.path, u.reason]), [['tautan.txt', 'symlink']]);

  // After the seal, a captured path replaced by a symlink is refused too (the outside file stays untouched).
  const two = repo('repo7', { 'a.txt': 'asli\n' });
  writeFileSync(path.join(two.dir, 'a.txt'), 'ubah\n');
  const cap2 = await captureRedo({ projectPath: two.dir, dataDir: DATA, projectId: 'toko-7', engine: 'claude' });
  two.git('checkout', '--', 'a.txt');
  await sealRedo({ dataDir: DATA, projectId: 'toko-7', id: cap2.id, projectPath: two.dir });
  rmSync(path.join(two.dir, 'a.txt'));
  symlinkSync(outside, path.join(two.dir, 'a.txt'), 'file');
  const applied = await applyRedo({ dataDir: DATA, projectId: 'toko-7', id: cap2.id, projectPath: two.dir, overwrite: true });
  assert.deepEqual(applied, { restored: 0, skipped: 1, deleted: 0, conflicts: 1 });
  assert.equal(readFileSync(outside, 'utf8'), 'RAHASIA-JANGAN-DITULIS\n', 'never written through the link');
});
