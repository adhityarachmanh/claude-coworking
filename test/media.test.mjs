// 🖼 Project media discovery (src/media.js): images/videos, bounded, skipping noise folders.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findMedia, mediaKind } from '../src/media.js';

test('mediaKind: gambar/video dikenal, file lain tidak', () => {
  assert.equal(mediaKind('a.PNG'), 'image');
  assert.equal(mediaKind('clip.mp4'), 'video');
  assert.equal(mediaKind('notes.md'), null);
});

test('findMedia: rekursif, tanpa folder noise/hidden, dibatasi', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'media-'));
  mkdirSync(path.join(project, 'assets', 'img'), { recursive: true });
  mkdirSync(path.join(project, 'node_modules', 'x'), { recursive: true });
  mkdirSync(path.join(project, '.git'), { recursive: true });
  writeFileSync(path.join(project, 'assets', 'img', 'shot.png'), 'x');
  writeFileSync(path.join(project, 'assets', 'clip.mp4'), 'x');
  writeFileSync(path.join(project, 'node_modules', 'x', 'noise.png'), 'x');
  writeFileSync(path.join(project, '.git', 'hidden.png'), 'x');
  writeFileSync(path.join(project, 'notes.txt'), 'x');

  const all = findMedia(project);
  assert.deepEqual(all.map((m) => m.path).sort(), ['assets/clip.mp4', 'assets/img/shot.png']);
  assert.equal(all.find((m) => m.path.endsWith('shot.png')).kind, 'image');
  assert.equal(findMedia(project, { limit: 1 }).length, 1);
});
