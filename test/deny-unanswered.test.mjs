// 🤖 "Tolak izin tak terjawab" (Claude Code 2.1.319+ `permissions.denyInsteadOfPrompting`): when the phone is asleep
// or the link drops, an unanswered permission request is denied and the turn continues instead of hanging forever.
// The rule is pure (tested here without spawning anything); the `--settings` file is a constant written once.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionManager, shouldPassDenySettings } from '../src/session.js';

test('shouldPassDenySettings: hanya saat dinyalakan dan bukan Plan', () => {
  assert.equal(shouldPassDenySettings({ denyUnanswered: true, mode: 'build' }), true);
  assert.equal(shouldPassDenySettings({ denyUnanswered: true, mode: 'plan' }), false, 'Plan sudah menolak semuanya');
  assert.equal(shouldPassDenySettings({ denyUnanswered: false, mode: 'build' }), false);
  assert.equal(shouldPassDenySettings({ mode: 'build' }), false, 'default mati: tab lama tidak menyalakannya');
  assert.equal(shouldPassDenySettings(null), false);
});

test('denySettingsFile: menulis setelan yang dibaca Claude Code, sekali, di folder data aplikasi', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-deny-'));
  try {
    const manager = Object.create(SessionManager.prototype);
    manager.hub = { dataDir: dir };
    const file = manager.denySettingsFile();
    assert.ok(file.startsWith(dir), 'berada di folder data, bukan folder user');
    assert.ok(existsSync(file));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { permissions: { denyInsteadOfPrompting: true } });
    assert.equal(manager.denySettingsFile(), file, 'idempoten: file yang sama dipakai lagi');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
