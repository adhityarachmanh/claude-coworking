// When a turn stops with an authentication error (a provider without stored credentials), the stop line must
// point the user at the login path instead of a bare "Authentication required" (src/acp-session.js endTurn).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authRequiredNote } from '../src/acp-session.js';

test('an authentication-required stop gets a hint where to log the provider in', () => {
  const note = authRequiredNote('Authentication required: provider authentication required');
  assert.match(note, /Akun/i, 'menyebut tab Akun');
  assert.match(note, /OpenCode/i, 'menyebut tab OpenCode');
  assert.match(note, /login/i, 'menyebut login');
  assert.match(note, /Authentication required/, 'pesan asli tetap ada');
});

test('unrelated stop errors and empty text pass through untouched', () => {
  assert.equal(authRequiredNote('Model menolak permintaan ini.'), 'Model menolak permintaan ini.');
  assert.equal(authRequiredNote(''), '');
  // Case-insensitive match, but only once: the note is appended, never duplicated on a second pass.
  const once = authRequiredNote('provider authentication required');
  assert.equal(once.match(/Akun/gu).length, 1);
  assert.equal(authRequiredNote(once), once, 'idempotent: tidak menumpuk saat dipanggil lagi');
});
