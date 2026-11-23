// 💡 Prompt suggestions (status.suggestion): the composer's "Saran berikutnya" bar. Clearing the text when a prompt
// goes out must not broadcast a status event: an idle-looking update before the turn starts raced the server tests.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';

test('clearSuggestion: mengosongkan saran tanpa menyiarkan status, idempoten', () => {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'office-sugg-')) });
  const project = hub.upsertProject(mkdtempSync(path.join(tmpdir(), 'office-suggp-')), 'custom');
  hub.setStatus(project.id, { suggestion: { text: 'Jalankan test lagi', at: 1 } });
  const events = [];
  hub.broadcast = (type, data) => events.push([type, data]);
  hub.clearSuggestion(project.id);
  assert.equal(hub.statusFor(project.id).suggestion, null);
  assert.deepEqual(events, [], 'tidak ada status "menganggur" palsu sebelum giliran mulai');
  hub.clearSuggestion(project.id);
  assert.deepEqual(events, []);
});
