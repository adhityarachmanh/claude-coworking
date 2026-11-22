// Folder tambahan (Claude --add-dir): pure rules. A path is stored absolutely, must exist as a folder, is never a
// network/UNC path, and the list is capped; junk from a hand-edited state.json is dropped instead of thrown.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ADD_DIR_LIMIT, ADD_DIR_MAX_LENGTH, addDirViews, addDirectory, cleanAddDirs, expandHome, removeDirectory } from '../src/add-dirs.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'office-dirs-'));

test('addDirectory: absolut, ada, bukan jaringan; ~ dikembangkan', () => {
  const home = tmp();
  const lib = path.join(home, 'pustaka');
  mkdirSync(lib);
  assert.deepEqual(addDirectory({ list: [], value: lib, home }), [lib]);
  assert.deepEqual(addDirectory({ list: [], value: '~/pustaka', home }), [lib]);
  assert.throws(() => addDirectory({ list: [], value: 'pustaka', home }), /absolut/);
  assert.throws(() => addDirectory({ list: [], value: '\\\\server\\share', home }), /jaringan/);
  assert.throws(() => addDirectory({ list: [], value: '//server/share', home }), /jaringan/);
  assert.throws(() => addDirectory({ list: [], value: path.join(home, 'hilang'), home }), /tidak ditemukan/);
});

test('addDirectory: duplikat (tanpa beda huruf di Windows), maksimal 10', () => {
  const home = tmp();
  const dirs = Array.from({ length: ADD_DIR_LIMIT }, (_, i) => {
    const dir = path.join(home, `d${i}`);
    mkdirSync(dir);
    return dir;
  });
  const full = dirs.reduce((list, dir) => addDirectory({ list, value: dir, home }), []);
  assert.equal(full.length, ADD_DIR_LIMIT);
  const extra = path.join(home, 'satu-lagi');
  mkdirSync(extra);
  assert.throws(() => addDirectory({ list: full, value: extra, home }), /Maksimal/);
  const duplicate = process.platform === 'win32' ? dirs[0].toUpperCase() : dirs[0];
  assert.throws(() => addDirectory({ list: full, value: duplicate, home }), /sudah ada/);
});

test('cleanAddDirs: junk state.json dibuang, tidak melempar, berhenti di batas', () => {
  const home = tmp();
  const real = path.join(home, 'real');
  mkdirSync(real);
  assert.deepEqual(cleanAddDirs(null), []);
  assert.deepEqual(cleanAddDirs([42, '', 'relatif', '\\\\srv\\share', real, real, 'x'.repeat(ADD_DIR_MAX_LENGTH + 1)]), [real]);
});

test('removeDirectory melepas path yang foldernya sudah tidak ada', () => {
  const home = tmp();
  const gone = path.join(home, 'sudah-hilang');
  assert.deepEqual(removeDirectory({ list: [gone], value: gone, home }), []);
  assert.throws(() => removeDirectory({ list: [], value: gone, home }), /tidak ada di daftar/);
});

test('addDirViews menandai folder yang hilang', () => {
  const home = tmp();
  const real = path.join(home, 'ada');
  mkdirSync(real);
  assert.deepEqual(addDirViews([real, path.join(home, 'tidak-ada')]), [
    { path: real, exists: true },
    { path: path.join(home, 'tidak-ada'), exists: false },
  ]);
  assert.equal(expandHome('~', home), home);
});
