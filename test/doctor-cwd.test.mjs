// 🩺 `claude doctor` reads the settings files of its CURRENT DIRECTORY (its own --help). The route therefore runs it
// inside the project the user is looking at, so a broken .claude/settings.json, agent file or hook matcher in THAT
// project is what gets reported — not the app folder's (which has no Claude config of the user).
// Exercised without a real CLI: the fake records the working directory it was started in.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileTree } from '../src/proc.js';

const FAKE = path.join(process.cwd(), 'test-support', 'fake-claude.mjs');

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-doctor-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const run = (cwd) =>
  new Promise((resolve, reject) => {
    execFileTree(process.execPath, [FAKE, 'doctor'], { cwd, encoding: 'utf8', timeout: 30_000, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out))));
  });

test('execFileTree: cwd menentukan folder kerja proses anak (dasar `claude doctor` per project)', async () => {
  const box = sandbox();
  try {
    const out = await run(box.dir);
    // The fake prints its cwd for doctor, so the test proves the option reached the child.
    assert.match(out, /cwd:/);
    assert.ok(out.includes(box.dir.replace(/\\/g, '\\')) || out.includes(box.dir), 'doctor dijalankan DI folder project');
  } finally {
    box.done();
  }
});

test('fake-claude doctor: melaporkan folder kerjanya agar pemanggil bisa membuktikan cwd-nya', async () => {
  const box = sandbox();
  try {
    const out = await run(box.dir);
    const line = out.split('\n').find((l) => l.startsWith('cwd:'));
    assert.equal(line?.slice(4).trim().replace(/\\/g, '/'), box.dir.replace(/\\/g, '/'));
    assert.ok(existsSync(FAKE));
  } finally {
    box.done();
  }
});
