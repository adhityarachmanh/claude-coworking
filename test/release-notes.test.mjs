// 📜 Catatan rilis (`/release-notes`): the bundled CHANGELOG.md split into its `##` sections. Pure, so the parser is
// tested without the file system or the server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReleaseNotes } from '../src/release-notes.js';

const md = `# Changelog

Beberapa kalimat pembuka.

## Belum dirilis

- Fitur baru.

## 1.12.0

- Rilis terbaru.
- Baris kedua.

## 1.11.0

- Lama.
`;

test('parseReleaseNotes: heading, isi, urutan, dan batas', () => {
  const all = parseReleaseNotes(md);
  assert.deepEqual(all.map((s) => s.version), ['Belum dirilis', '1.12.0', '1.11.0']);
  assert.equal(all[1].body, '- Rilis terbaru.\n- Baris kedua.');
  assert.equal(all[2].body, '- Lama.');
  assert.deepEqual(parseReleaseNotes(md, { limit: 1 }).map((s) => s.version), ['Belum dirilis']);
});

test('parseReleaseNotes: input kosong/aneh aman dan emoji utuh', () => {
  assert.deepEqual(parseReleaseNotes(''), []);
  assert.deepEqual(parseReleaseNotes(null), []);
  assert.deepEqual(parseReleaseNotes('# Changelog\n\ntanpa bagian'), []);
  const one = parseReleaseNotes('## 1.0.0\n\n- 🦙 panel model lokal');
  assert.equal(one[0].body, '- 🦙 panel model lokal');
});
