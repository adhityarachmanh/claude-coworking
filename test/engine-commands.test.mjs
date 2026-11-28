// 🔁 Engine commands the app may send as a prompt (never an arbitrary string): `/reload-plugins`, `/reload-skills`,
// `/init`. Pure, so the allowlist is tested without a session.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENGINE_COMMANDS, normalizeEngineCommand } from '../src/engine-commands.js';

test('normalizeEngineCommand: hanya command allowlist, tanpa argumen', () => {
  for (const command of Object.keys(ENGINE_COMMANDS)) assert.equal(normalizeEngineCommand(command), command);
  assert.equal(normalizeEngineCommand('  /reload-skills  '), '/reload-skills');
  assert.equal(normalizeEngineCommand('/reload-skills --force'), null);
  assert.equal(normalizeEngineCommand('/rm -rf'), null);
  assert.equal(normalizeEngineCommand(''), null);
  assert.equal(normalizeEngineCommand(null), null);
});

test('ENGINE_COMMANDS: label untuk UI', () => {
  assert.ok(ENGINE_COMMANDS['/init'].includes('CLAUDE.md'));
});
