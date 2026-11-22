// 🐙 Pantau CI per project (settings.ciFollow): on by default, only `false` turns it off.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';

test('pantau CI: nyala secara bawaan, hanya false yang mematikan', () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'office-ci-')) });
  hub.projects.set('p1', { id: 'p1', path: 'C:/p', name: 'p1' });
  assert.equal(hub.ciFollowFor('p1'), true, 'absen = nyala');
  // Junk (a hand-edited state.json) must not flip it either way.
  assert.equal(hub.cleanSettings({ ciFollow: true }, { ciFollow: 'no' }).ciFollow, true, 'junk tidak mematikan');
  assert.equal(hub.cleanSettings({ ciFollow: false }, { ciFollow: 0 }).ciFollow, false, 'junk tidak menyalakan');
  hub.updateSettings('p1', { ciFollow: false });
  assert.equal(hub.ciFollowFor('p1'), false);
  hub.updateSettings('p1', { ciFollow: true });
  assert.equal(hub.ciFollowFor('p1'), true);
});