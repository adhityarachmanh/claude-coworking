import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverProjects, isDirectory, isNetworkPath } from '../src/projects.js';

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
