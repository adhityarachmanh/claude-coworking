// 📝 Release notes: the GitHub Release body comes from the matching CHANGELOG section.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { notesFrom } from '../scripts/release-notes.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = `# Changelog

## Belum dirilis

- belum.

## 1.2.3

- **Fitur A.** Satu baris.
- **Fitur B.** Baris kedua.

## 1.2.2

- lama.
`;

test('notesFrom takes exactly the section of the requested version', () => {
  assert.equal(notesFrom(CHANGELOG, '1.2.3'), '- **Fitur A.** Satu baris.\n- **Fitur B.** Baris kedua.');
  assert.equal(notesFrom(CHANGELOG, 'v1.2.2'), '- lama.');
  assert.equal(notesFrom(CHANGELOG, '1.2.3').includes('lama'), false, 'the next section is not included');
});

test('notesFrom falls back to a short line for an unknown version', () => {
  assert.equal(notesFrom(CHANGELOG, '9.9.9'), 'Rilis v9.9.9');
  assert.equal(notesFrom(CHANGELOG, ''), '');
});

test('every release workflow publishes the changelog section, not a generic line', () => {
  for (const name of ['release.yml', 'build-macos.yml']) {
    const workflow = readFileSync(path.join(APP, '.github', 'workflows', name), 'utf8');
    assert.match(workflow, /release-notes\.mjs/, name);
    assert.match(workflow, /--notes-file/, name);
    assert.doesNotMatch(workflow, /--notes "Rilis/, name);
  }
});

test('the test workflow runs the fast suite on every push', () => {
  const workflow = readFileSync(path.join(APP, '.github', 'workflows', 'test.yml'), 'utf8');
  assert.match(workflow, /test:fast/);
  assert.match(workflow, /pull_request/);
  assert.doesNotMatch(workflow, /cdp|chrome/i, 'no browser job: that is the flaky half and runs locally');
});
