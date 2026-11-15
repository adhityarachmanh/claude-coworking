// The PATH a child CLI receives (src/child-env.js): junctions are resolved or dropped, never followed blindly.
// nvm-windows' `.nodejs` is a junction, and libuv answering EUNKNOWN for a path inside it is what broke the
// first prompt after an in-app update, so these rules are worth a real test rather than a comment.
import assert from 'node:assert/strict';
import test from 'node:test';
import { childEnv, sanitizePathEntries, sanitizePathValue, splitPath } from '../src/child-env.js';
import { execFileTree } from '../src/proc.js';
import path from 'node:path';

const dir = () => ({ isDirectory: () => true, isSymbolicLink: () => false });
const junction = () => ({ isDirectory: () => false, isSymbolicLink: () => true });
const file = () => ({ isDirectory: () => false, isSymbolicLink: () => false });

/** A fake filesystem: absolute path → stat, plus junction targets. */
function fakeFs(table) {
  const stat = (p) => {
    const entry = table[p.toLowerCase()];
    if (!entry) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return entry;
  };
  return {
    lstat: stat,
    realpath: (p) => {
      const entry = table[p.toLowerCase()];
      if (!entry || typeof entry.isSymbolicLink !== 'function') throw new Error('ENOENT');
      if (entry.isSymbolicLink()) {
        if (!entry.target) throw Object.assign(new Error('EUNKNOWN'), { code: 'EUNKNOWN' });
        return entry.target;
      }
      return p;
    },
  };
}

const win = (value, table) => sanitizePathEntries(value, { platform: 'win32', delimiter: ';', ...fakeFs(table) });

test('splitPath: empty entries and cmd quotes are removed', () => {
  assert.deepEqual(splitPath(';;"C:\\Program Files\\nodejs";', ';'), ['C:\\Program Files\\nodejs']);
});

test('sanitizePathEntries: a real folder is kept, a junction is replaced by its target', () => {
  const fs = {
    'c:\\windows': dir(),
    'c:\\nvm\\.nodejs': { ...junction(), target: 'C:\\nvm\\shim' },
    'c:\\nvm\\shim': dir(),
  };
  assert.deepEqual(win('C:\\Windows;C:\\nvm\\.nodejs', fs), ['C:\\Windows', 'C:\\nvm\\shim']);
});

test('sanitizePathEntries: a broken junction is dropped (the EUNKNOWN case)', () => {
  const fs = {
    'c:\\windows': dir(),
    'c:\\nvm\\.nodejs': junction(), // realpath throws: its target was removed by an nvm install
  };
  assert.deepEqual(win('C:\\Windows;C:\\nvm\\.nodejs;C:\\missing', fs), ['C:\\Windows']);
});

test('sanitizePathEntries: a junction that resolves to another junction is dropped', () => {
  const fs = {
    'c:\\nvm\\.nodejs': { ...junction(), target: 'C:\\nvm\\.link' },
    'c:\\nvm\\.link': junction(),
  };
  assert.deepEqual(win('C:\\nvm\\.nodejs', fs), []);
});

test('sanitizePathEntries: duplicates and plain files are dropped, order is kept', () => {
  const fs = { 'c:\\a': dir(), 'c:\\b': dir(), 'c:\\c.exe': file() };
  assert.deepEqual(win('C:\\A;C:\\b;c:\\a;C:\\c.exe', fs), ['C:\\A', 'C:\\b']);
});

test('sanitizePathEntries: non-Windows entries are not probed, only de-duplicated', () => {
  const value = '/usr/local/bin:/usr/bin::/usr/local/bin';
  assert.deepEqual(sanitizePathEntries(value, { platform: 'linux' }), ['/usr/local/bin', '/usr/bin']);
  assert.equal(sanitizePathValue(value, { platform: 'linux' }), '/usr/local/bin:/usr/bin');
});

test('childEnv: the node folder comes first, the junction is gone, extra variables win', () => {
  const original = { Path: 'C:\\nvm\\.nodejs;C:\\Windows', OFFICE_MANAGED: '0' };
  const table = {
    'c:\\nvm\\.nodejs': { ...junction(), target: 'C:\\nvm\\shim' },
    'c:\\nvm\\shim': dir(),
    'c:\\windows': dir(),
    'c:\\node': dir(),
  };
  const probes = fakeFs(table);
  const env = childEnv({ OFFICE_MANAGED: '1' }, original, {
    platform: 'win32', execPath: 'C:\\node\\node.exe', lstat: probes.lstat, realpath: probes.realpath,
  });
  assert.equal(env.PATH, 'C:\\node;C:\\nvm\\shim;C:\\Windows');
  assert.equal(env.Path, undefined, 'one PATH key only: a duplicate would reach the child twice');
  assert.equal(env.OFFICE_MANAGED, '1');
  assert.deepEqual(Object.keys(original), ['Path', 'OFFICE_MANAGED'], 'the caller environment is not mutated');
});

test('childEnv: a node.exe inside a junction is resolved, not re-added as a reparse point', () => {
  const table = {
    'c:\\nvm\\.nodejs': { ...junction(), target: 'C:\\nvm\\shim' },
    'c:\\nvm\\shim': dir(),
  };
  const probes = fakeFs(table);
  const env = childEnv({}, { PATH: 'C:\\nvm\\shim' }, {
    platform: 'win32', execPath: 'C:\\nvm\\.nodejs\\node.exe', lstat: probes.lstat, realpath: probes.realpath,
  });
  assert.equal(env.PATH, 'C:\\nvm\\shim', 'no duplicate entry for the same real folder');
});

test('childEnv: other platforms are passed through as-is', () => {
  const base = { PATH: '/a:/b', HOME: '/home/x' };
  const env = childEnv({ CI: '1' }, base, { platform: 'linux', execPath: '/usr/bin/node' });
  assert.deepEqual(env, { PATH: '/a:/b', HOME: '/home/x', CI: '1' });
});

test('execFileTree: a CLI spawned without an explicit env still gets the cleaned PATH', async () => {
  // The central default (src/proc.js) is what every OpenCode/admin wrapper relies on: a wrapper added later must
  // not have to remember childEnv itself, or nvm's `.nodejs` junction reaches it again after an update.
  const dirty = `${process.env.PATH ?? ''}${path.delimiter}${process.env.PATH ?? ''}`;
  const saved = process.env.PATH;
  process.env.PATH = dirty;
  try {
    const out = await new Promise((resolve, reject) => {
      execFileTree(process.execPath, ['-e', 'process.stdout.write(process.env.PATH ?? "")'], { timeout: 20_000 }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout)));
    });
    // childEnv() is a pass-through outside Windows (src/child-env.js): POSIX has no junction to resolve, so the
    // PATH must arrive byte-for-byte. On Windows it arrives sanitized — the rule this test exists for.
    // src/proc.js puts the folder of the running node.exe first (the same step as childEnv): compare against the
    // real childEnv() output, not only sanitizePathValue(), or the node folder reads as an extra entry.
    const expected = process.platform === 'win32' ? childEnv().PATH : dirty;
    assert.equal(out, expected, 'the child env follows the same rule as childEnv()');
  } finally {
    process.env.PATH = saved;
  }
});
