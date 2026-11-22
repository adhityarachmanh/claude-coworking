// When a turn stops with an authentication error (a provider without stored credentials), the stop line must
// point the user at the login path instead of a bare "Authentication required" (src/acp-session.js endTurn).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authRequiredNote, lateStreamChunkNote } from '../src/acp-session.js';

test('an authentication-required stop gets a hint where to log the provider in', () => {
  const note = authRequiredNote('Authentication required: provider authentication required');
  assert.match(note, /Akun/i, 'menyebut tab Akun');
  assert.match(note, /OpenCode/i, 'menyebut tab OpenCode');
  assert.match(note, /login/i, 'menyebut login');
  assert.match(note, /Authentication required/, 'pesan asli tetap ada');
  // Unknown credential state: never claim the key is missing.
  assert.doesNotMatch(note, /belum punya API key/);
  assert.match(note, /belum bisa dipastikan/, 'netral: minta periksa status login');
});

test('a stored key that is still refused is explained honestly (403/credit/network), not as "no key"', () => {
  const note = authRequiredNote('Authentication required: provider authentication required', { provider: 'wally', connected: true });
  assert.doesNotMatch(note, /belum punya API key/, 'key ADA: jangan mengklaim sebaliknya');
  assert.match(note, /wally/, 'provider disebut');
  assert.match(note, /403/);
  assert.match(note, /tidak berhak|kredit/);
  assert.match(note, /jaringan|region|proxy/i);
  assert.match(note, /Login ulang/);
  assert.match(note, /Ganti model/);
});

test('no stored credential keeps the old message; a known status adds a precise hint', () => {
  const missing = authRequiredNote('Authentication required', { provider: 'wally', connected: false });
  assert.match(missing, /belum punya API key/);
  assert.match(missing, /wally/);
  assert.match(authRequiredNote('Authentication required', { connected: true, status: 401 }), /kedaluwarsa|tidak dikenal/);
  assert.match(authRequiredNote('Authentication required', { connected: true, status: 403 }), /tidak berhak/);
  assert.match(authRequiredNote('Authentication required', { connected: true, status: 429 }), /sibuk|kuota/);
  // The status also counts when it only appears in the provider's own text.
  assert.match(authRequiredNote('Authentication required (HTTP 429)'), /sibuk|kuota/);
});

test('unrelated stop errors and empty text pass through untouched', () => {
  assert.equal(authRequiredNote('Model menolak permintaan ini.'), 'Model menolak permintaan ini.');
  assert.equal(authRequiredNote(''), '');
  // Case-insensitive match, but only once: the note is appended, never duplicated on a second pass.
  const once = authRequiredNote('provider authentication required');
  assert.equal(once.match(/Akun/gu).length, 1);
  assert.equal(authRequiredNote(once), once, 'idempotent: tidak menumpuk saat dipanggil lagi');
  assert.equal(authRequiredNote(authRequiredNote('Authentication required', { connected: true }), { connected: false }), authRequiredNote('Authentication required', { connected: true }), 'idempotent juga untuk konteks berbeda');
});

// ---------- late stream chunk (OpenCode parser bug #56455) ----------

test('lateStreamChunkNote explains the OpenCode parser bug and suggests a retry', () => {
  const raw = 'Internal error: OpenAI Chat received content after the finish reason';
  const note = lateStreamChunkNote(raw);
  assert.match(note, /received content after the finish reason/, 'pesan asli tetap ada');
  assert.match(note, /56455/, 'menyebut issue upstream');
  assert.match(note, /OpenCode/, 'menyebut bahwa ini bug OpenCode, bukan user');
  assert.match(note, /kirim ulang/i, 'menyarankan coba ulang');
  assert.match(note, /satu per satu|satu-satu/, 'menyarankan tool satu per satu');
});

test('lateStreamChunkNote leaves unrelated errors untouched', () => {
  assert.equal(lateStreamChunkNote('Model menolak permintaan ini.'), 'Model menolak permintaan ini.');
  assert.equal(lateStreamChunkNote(''), '');
  // idempotent: a second pass does not stack the note
  const once = lateStreamChunkNote('OpenAI Chat received content after the finish reason');
  assert.equal(lateStreamChunkNote(once), once);
  assert.equal(once.match(/#56455/g).length, 1);
});
