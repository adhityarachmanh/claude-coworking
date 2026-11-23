// 🤖 "Tolak izin tak terjawab" (Claude Code 2.1.319+ `permissions.denyInsteadOfPrompting`): when the phone is asleep
// or the link drops, an unanswered permission request is denied and the turn continues instead of hanging forever.
// The rule is pure (tested here without spawning anything); `--settings` is one generated file per switch combination.
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

test('claudeSettingsFile: deny-unanswered (dan fast mode) masuk ke satu file --settings di folder data', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-deny-'));
  try {
    const manager = Object.create(SessionManager.prototype);
    manager.hub = { dataDir: dir };
    const file = manager.claudeSettingsFile({ denyUnanswered: true, mode: 'build' });
    assert.ok(file.startsWith(dir), 'berada di folder data, bukan folder user');
    assert.ok(existsSync(file));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { permissions: { denyInsteadOfPrompting: true } });
    assert.equal(manager.claudeSettingsFile({ denyUnanswered: true, mode: 'build' }), file, 'idempoten: file yang sama dipakai lagi');
    assert.equal(manager.claudeSettingsFile({ denyUnanswered: false, mode: 'build' }), null, 'tanpa saklar: tidak ada flag');
    const both = JSON.parse(readFileSync(manager.claudeSettingsFile({ denyUnanswered: true, mode: 'build', claudeFastMode: true }), 'utf8'));
    assert.deepEqual(both, { permissions: { denyInsteadOfPrompting: true }, fastMode: true }, 'dua saklar berbagi satu file');
    assert.equal(manager.claudeSettingsFile({ denyUnanswered: true, mode: 'plan', claudeFastMode: true }) !== null, true, 'Plan tetap butuh fast mode');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
