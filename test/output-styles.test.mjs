// Output styles (Claude Code): built-in names, custom Markdown files, and the style the project actually uses.
// No Claude process and no network: this only reads the user's own files. Writes live in the same module below.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OutputStyleError, currentOutputStyle, deleteStyle, listOutputStyles, parseStyleFile, readStyle, saveSelection, saveStyle } from '../src/output-styles.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

test('parseStyleFile: frontmatter name/description/keep-coding-instructions, body terpisah', () => {
  const parsed = parseStyleFile('---\nname: "Diagrams first"\ndescription: "Mulai dengan diagram"\nkeep-coding-instructions: true\n---\n\nPakai diagram.\n');
  assert.deepEqual(parsed, {
    name: 'Diagrams first',
    description: 'Mulai dengan diagram',
    keepCodingInstructions: true,
    body: 'Pakai diagram.\n',
  });
  const broken = parseStyleFile('tanpa frontmatter');
  assert.equal(broken.name, '');
  assert.equal(broken.body, 'tanpa frontmatter');
});

test('listOutputStyles: bawaan selalu ada, file .md project/user terbaca, project menang atas user', () => {
  const project = tmp('os-p-');
  const userDir = tmp('os-u-');
  write(path.join(project, '.claude', 'output-styles', 'ringkas.md'), '---\nname: "Ringkas"\ndescription: "Pendek"\n---\n\nx\n');
  write(path.join(project, '.claude', 'output-styles', 'rusak.md'), 'tanpa frontmatter\n');
  write(path.join(userDir, 'output-styles', 'ringkas.md'), '---\nname: "Ringkas"\ndescription: "versi user"\n---\n\ny\n');
  write(path.join(userDir, 'output-styles', 'catatan.txt'), 'bukan gaya');
  const styles = listOutputStyles({ projectPath: project, userDir });
  assert.deepEqual(styles.filter((s) => s.builtin).map((s) => s.name), ['default', 'Proactive', 'Concise', 'Explanatory', 'Learning']);
  const ringkas = styles.filter((s) => s.name === 'Ringkas');
  assert.equal(ringkas.length, 1);
  assert.equal(ringkas[0].scope, 'project');
  assert.equal(ringkas[0].description, 'Pendek');
  assert.ok(styles.some((s) => s.name === 'rusak' && s.scope === 'project'), 'nama fallback = nama file');
  assert.ok(!styles.some((s) => s.name === 'catatan'), 'hanya .md');
});

test('currentOutputStyle: local > project > user, nilai tak dikenal dilaporkan (case-sensitive)', () => {
  const project = tmp('os-c-');
  const userDir = tmp('os-cu-');
  assert.deepEqual(currentOutputStyle({ projectPath: project, userDir }), { name: 'default', source: 'default', unknown: null });
  write(path.join(userDir, 'settings.json'), JSON.stringify({ outputStyle: 'Explanatory' }));
  assert.deepEqual(currentOutputStyle({ projectPath: project, userDir }), { name: 'Explanatory', source: 'user', unknown: null });
  write(path.join(project, '.claude', 'settings.json'), JSON.stringify({ outputStyle: 'Concise' }));
  assert.equal(currentOutputStyle({ projectPath: project, userDir }).name, 'Concise');
  write(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ outputStyle: 'concise' }));
  assert.deepEqual(currentOutputStyle({ projectPath: project, userDir }), { name: 'default', source: 'local', unknown: 'concise' });
  write(path.join(project, '.claude', 'settings.local.json'), '{rusak');
  assert.throws(() => currentOutputStyle({ projectPath: project, userDir }), (e) => e.status === 409);
});

test('saveStyle: membuat file berfrontmatter, menimpa dengan backup, dan menolak nama tak sah', () => {
  const project = tmp('os-s-');
  const userDir = tmp('os-su-');
  const dataDir = tmp('os-sd-');
  const saved = saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', name: 'Diagrams first', description: 'Mulai diagram', keepCodingInstructions: true, body: 'Pakai diagram.\n' });
  const file = path.join(project, '.claude', 'output-styles', 'diagrams-first.md');
  assert.equal(saved.style.name, 'Diagrams first');
  assert.equal(saved.backedUp, null);
  assert.match(readFileSync(file, 'utf8'), /^---\nname: "Diagrams first"\ndescription: "Mulai diagram"\nkeep-coding-instructions: true\n---\n\nPakai diagram\.\n$/m);
  const back = readStyle({ projectPath: project, userDir, scope: 'project', slug: 'diagrams-first' });
  assert.equal(back.name, 'Diagrams first');
  assert.equal(back.body, 'Pakai diagram.\n');
  assert.equal(back.keepCodingInstructions, true);
  const again = saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', slug: 'diagrams-first', name: 'Diagrams first', description: '', keepCodingInstructions: false, body: 'Versi dua.\n', mtime: back.mtime });
  assert.ok(again.backedUp, 'salinan lama dibuat');
  for (const bad of ['', 'a/b', 'a\\b', 'x'.repeat(61), 'Concise', 'default']) {
    assert.throws(() => saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', name: bad, description: '', keepCodingInstructions: false, body: 'x' }), (e) => e instanceof OutputStyleError && e.status === 400, bad);
  }
  assert.throws(() => saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', name: 'Nama baru', description: '', keepCodingInstructions: false, body: 'x'.repeat(70_000) }), (e) => e.status === 413);
  // Nama yang sama dengan file lain di scope yang sama ditolak.
  assert.throws(() => saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', name: 'Diagrams first', description: '', keepCodingInstructions: false, body: 'y' }), (e) => e.status === 409);
});

test('deleteStyle: menghapus file dengan backup; file di luar scope tidak tersentuh lewat symlink', (t) => {
  const project = tmp('os-d-');
  const userDir = tmp('os-du-');
  const dataDir = tmp('os-dd-');
  saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', name: 'Hapus aku', description: '', keepCodingInstructions: false, body: 'x\n' });
  const removed = deleteStyle({ projectPath: project, userDir, dataDir, scope: 'project', slug: 'hapus-aku' });
  assert.ok(removed.backedUp);
  assert.equal(existsSync(path.join(project, '.claude', 'output-styles', 'hapus-aku.md')), false);
  const linked = tmp('os-dl-');
  const outside = tmp('os-out-');
  write(path.join(outside, 'victim.md'), 'jangan dihapus');
  mkdirSync(path.join(linked, '.claude'), { recursive: true });
  try {
    symlinkSync(outside, path.join(linked, '.claude', 'output-styles'), 'junction');
  } catch {
    return t.skip('no privilege for symlinks here');
  }
  if (!existsSync(path.join(linked, '.claude', 'output-styles', 'victim.md'))) return t.skip('junction is not readable in this environment');
  assert.throws(() => deleteStyle({ projectPath: linked, userDir, dataDir, scope: 'project', slug: 'victim' }), (e) => e.status === 409);
  assert.ok(existsSync(path.join(outside, 'victim.md')));
});

test('saveSelection: hanya mengubah outputStyle, mempertahankan kunci/indentasi, dan default menghapus kunci', () => {
  const project = tmp('os-sel-');
  const userDir = tmp('os-selu-');
  const file = path.join(project, '.claude', 'settings.local.json');
  write(file, '{\n  "permissions": { "allow": ["Read"] },\n  "outputStyle": "Concise"\n}\n');
  const result = saveSelection({ projectPath: project, userDir, name: 'Explanatory' });
  assert.equal(result.file, file);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { permissions: { allow: ['Read'] }, outputStyle: 'Explanatory' });
  assert.match(readFileSync(file, 'utf8'), /^\{\n {2}"permissions"/, 'indentasi 2 spasi dipertahankan');
  saveSelection({ projectPath: project, userDir, name: 'default' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { permissions: { allow: ['Read'] }, outputStyle: 'default' });
  write(file, '{rusak');
  assert.throws(() => saveSelection({ projectPath: project, userDir, name: 'Concise' }), (e) => e.status === 409);
  assert.equal(readFileSync(file, 'utf8'), '{rusak', 'file rusak tidak ditimpa');
  const fresh = tmp('os-self-');
  saveSelection({ projectPath: fresh, userDir, name: 'Concise' });
  assert.deepEqual(JSON.parse(readFileSync(path.join(fresh, '.claude', 'settings.local.json'), 'utf8')), { outputStyle: 'Concise' });
});

test('Default menimpa setelan project/user, bukan hanya menghapus kunci lokal', () => {
  const project = tmp('os-def-');
  const userDir = tmp('os-defu-');
  write(path.join(project, '.claude', 'settings.json'), JSON.stringify({ outputStyle: 'Concise' }));
  write(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ outputStyle: 'Explanatory' }));
  assert.deepEqual(currentOutputStyle({ projectPath: project, userDir }), { name: 'Explanatory', source: 'local', unknown: null });
  saveSelection({ projectPath: project, userDir, name: 'default' });
  assert.deepEqual(currentOutputStyle({ projectPath: project, userDir }), { name: 'default', source: 'local', unknown: null });
});

test('parseStyleFile: BOM/baris kosong sebelum frontmatter dan kutip/backslash round-trip', () => {
  const parsed = parseStyleFile('\uFEFF\n---\nname: "Bom Style"\ndescription: "Pakai \\"verbatim\\" dan C:\\\\path"\n---\n\nhello\n');
  assert.equal(parsed.name, 'Bom Style');
  assert.equal(parsed.description, 'Pakai "verbatim" dan C:\\path');
  const project = tmp('os-q-');
  const userDir = tmp('os-qu-');
  const dataDir = tmp('os-qd-');
  saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', name: "Kutip's", description: parsed.description, keepCodingInstructions: false, body: 'x\n' });
  const back = readStyle({ projectPath: project, userDir, scope: 'project', slug: 'kutip-s' });
  assert.equal(back.description, 'Pakai "verbatim" dan C:\\path');
});

test('saveStyle: nama yang sama dengan file lain ber-slug berbeda ditolak 409', () => {
  const project = tmp('os-dup-');
  const userDir = tmp('os-dupu-');
  const dataDir = tmp('os-dupd-');
  write(path.join(project, '.claude', 'output-styles', 'manual.md'), '---\nname: "Diagram dulu"\n---\n\nx\n');
  assert.throws(() => saveStyle({ projectPath: project, userDir, dataDir, scope: 'project', name: 'Diagram dulu', description: '', keepCodingInstructions: false, body: 'y' }), (e) => e.status === 409);
});
