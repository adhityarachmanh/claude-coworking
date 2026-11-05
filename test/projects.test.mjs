import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverProjects, isDirectory, isMissing, isNetworkPath } from '../src/projects.js';

test('UNC and device paths are recognised (stat-ing them would leak an NTLM hash over SMB)', () => {
  const network = ['\\\\server\\share', '//server/share', '\\\\?\\C:\\Windows', '\\\\.\\PhysicalDrive0', '\\??\\UNC\\server\\share', '\\/server/share', '  \\\\server\\share'];
  for (const p of network) assert.ok(isNetworkPath(p), p);
  const local = ['C:\\Users\\adhit\\projects', 'C:/Users/adhit', '/home/adhit/projects', '\\Users\\adhit', 'relatif\\folder', '', undefined];
  for (const p of local) assert.ok(!isNetworkPath(p), String(p));
});

test('isDirectory refuses network paths without touching them; local folders still work', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-projects-'));
  try {
    assert.equal(isDirectory(dir), true);
    // 192.0.2.0/24 is TEST-NET: a real SMB attempt would hang for seconds, a refusal is instant.
    const started = Date.now();
    assert.equal(isDirectory('\\\\192.0.2.1\\share'), false);
    assert.equal(isDirectory('//192.0.2.1/share'), false);
    assert.ok(Date.now() - started < 200, 'no network round trip');
    assert.deepEqual(discoverProjects({ roots: ['\\\\192.0.2.1\\share'] }).filter(([, src]) => src === 'folder'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isMissing only counts ENOENT/ENOTDIR as gone: a file or an unreadable path is not an orphan', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-projects-missing-'));
  try {
    const file = path.join(dir, 'catatan.txt');
    writeFileSync(file, 'x');
    assert.equal(isMissing(dir), false, 'an existing folder is not missing');
    assert.equal(isMissing(file), false, 'a file is not a missing folder');
    assert.equal(isMissing(path.join(file, 'anak')), true, 'ENOTDIR from a path below a file');
    assert.equal(isMissing(path.join(dir, 'sudah-pindah')), true, 'ENOENT');
    assert.equal(isMissing('\\\\192.0.2.1\\share'), false, 'network paths are never probed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude Code folders outside the roots never join the project list (a temp folder is not a project)', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'office-discover-'));
  const root = path.join(base, 'projects');
  const inside = path.join(root, 'toko');
  const outside = path.join(base, 'oc-spike-proj');
  const config = path.join(base, 'claude.json');
  const before = process.env.CLAUDE_CONFIG_FILE;
  try {
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(config, JSON.stringify({ projects: { [inside]: {}, [outside]: {} } }));
    process.env.CLAUDE_CONFIG_FILE = config;
    const claude = (extra) => discoverProjects({ roots: [root], extra }).filter(([, src]) => src === 'claude').map(([dir]) => path.resolve(dir));
    assert.deepEqual(claude(), [path.resolve(inside)], 'only the folder under the root');
    assert.deepEqual(claude([outside]), [path.resolve(inside), path.resolve(outside)], 'an explicitly added folder is kept');
    assert.deepEqual(discoverProjects({ roots: [root] }).filter(([, src]) => src === 'folder').map(([dir]) => path.resolve(dir)), [path.resolve(inside)]);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_FILE;
    else process.env.CLAUDE_CONFIG_FILE = before;
    rmSync(base, { recursive: true, force: true });
  }
});
