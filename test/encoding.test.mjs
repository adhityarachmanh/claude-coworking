// 🔤 Encoding guard: no shipped text file may carry mojibake.
//
// v1.0.29 shipped public/index.html with its UTF-8 double-encoded: a PowerShell `Get-Content -Raw` +
// `Set-Content -Encoding UTF8` round-trip read the file as Windows-1252 and wrote the (already UTF-8) bytes back
// as UTF-8 again, so every emoji rendered as its Latin-1 reading — 🛡️ became the six code points below. The
// browser suite that would have caught it was skipped, and the fast suite never looks at markup at all.
//
// This is the permanent guard: it walks the repo's shipped text files, rejects both directions of corruption
// (mojibake digraphs, and invalid UTF-8 that decodes to U+FFFD), and pins the emoji public/index.html must still
// contain — so a "fix" that deletes the emoji instead of restoring them fails too. The detector is proven to fire
// on the exact v1.0.29 bytes, because a guard that cannot fail is not a guard.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join('public', 'index.html');
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

// Shipped text: markup, styles, artwork titles, the web manifest, source, docs, config and installer scripts.
const EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md', '.iss', '.cmd', '.ps1', '.yml', '.yaml', '.svg', '.webmanifest', '.txt']);
// What .gitignore drops (build output, runtime data, secrets, dependencies) plus .git itself: never shipped text.
const SKIP_DIRS = new Set(['node_modules', '.git', '.netlify', 'dist', 'release', '.build', 'data', 'runtime', '.keys']);

// Each entry is a UTF-8 sequence that was read as Windows-1252 and re-encoded; none of them ever appears
// legitimately in this repo's Indonesian/English text. Written as code points on purpose — spelling the digraphs
// out here would corrupt this very file, which is itself scanned.
const SIGNATURES = [
  { name: 'U+00C3 · a UTF-8 lead byte read as Latin-1', codepoints: [0x00c3] },
  { name: 'U+00C2 · a UTF-8 lead byte read as Latin-1', codepoints: [0x00c2] },
  { name: 'U+00F0 U+0178 · an emoji read as Latin-1', codepoints: [0x00f0, 0x0178] },
  { name: 'U+00E2 U+20AC · UTF-8 punctuation read as Latin-1', codepoints: [0x00e2, 0x20ac] },
  { name: 'U+00EF U+00B8 · a variation selector read as Latin-1', codepoints: [0x00ef, 0x00b8] },
  { name: 'U+FFFD · an undecodable byte', codepoints: [0xfffd] },
];
const NEEDLES = SIGNATURES.map(({ name, codepoints }) => ({ name, needle: String.fromCodePoint(...codepoints) }));
const REPLACEMENT = Buffer.from(String.fromCodePoint(0xfffd), 'utf8'); // EF BF BD, i.e. an invalid byte pair

/** The emoji-bearing strings the rebuilt UI must carry: the panels that rendered as mojibake in v1.0.29. */
const MARKERS = [
  '⚙ Pengaturan', // the settings dialog head
  '🗂 Semua project', // the dashboard dialog head ("📊 Laporan..." is the separate report modal)
  '⚡ Remote power', // the remote power panel title
  '📦 Paket', // the 🛡️ Aturan izin preset button ("📦 Paket &amp; test")
  '🛡️ Aturan izin', // the permissions modal head and the project button
  '🔀 Buat PR', // the PR button
  '📊 Laporan penggunaan token', // the usage report modal head
  '📱 Buka dari HP', // the phone modal head
  'Pengaturan giliran', // the turn-settings dialog (its emoji lives on the chip that opens it)
];

/** Every mojibake signature in `text`, with its line and a one-line snippet for the report. */
function mojibakeHits(text) {
  const hits = [];
  for (const { name, needle } of NEEDLES) {
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      hits.push({ name, line: text.slice(0, at).split('\n').length, snippet: snippetAt(text, at) });
    }
  }
  return hits;
}

function snippetAt(text, at) {
  return text.slice(Math.max(0, at - 30), at + 30).replace(/\s+/g, ' ').trim();
}

/** The single assertion the repo scan uses; it names the file, the line and the offending snippet. */
function assertNoMojibake(text, label) {
  const hits = mojibakeHits(text);
  if (hits.length === 0) return;
  const where = hits.slice(0, 3).map((h) => `line ${h.line}: ${h.name} — "${h.snippet}"`).join('; ');
  assert.fail(`${label}: mojibake (UTF-8 double-encoded) — ${where}${hits.length > 3 ? ` (+${hits.length - 3} more)` : ''}`);
}

/** Walks the shipped text files (see SKIP_DIRS for what is never shipped). */
function shippedFiles(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) shippedFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

test('🔤 no shipped text file carries mojibake or undecodable bytes', () => {
  const files = shippedFiles();
  // A broken walk (wrong root, a skip list that swallowed everything) must not be able to pass silently.
  assert.ok(files.length > 100, `walked ${files.length} files — the scan is not looking at the repo`);
  assert.ok(files.map(rel).includes(rel(path.join(ROOT, INDEX))), `${INDEX} is part of the scan`);

  for (const file of files) {
    const label = rel(file);
    const bytes = readFileSync(file);
    const text = bytes.toString('utf8');
    assertNoMojibake(text, label);

    // The other direction: bytes that are not valid UTF-8 decode to U+FFFD, and re-encoding cannot return them.
    const roundTrip = Buffer.from(text, 'utf8');
    assert.ok(!roundTrip.includes(REPLACEMENT), `${label}: not valid UTF-8 (decoded with U+FFFD)`);
    assert.ok(roundTrip.equals(bytes), `${label}: re-encoding the decoded text does not reproduce the file bytes`);
  }
});

test('🖼 public/index.html still contains the emoji the UI is built around', () => {
  const html = readFileSync(path.join(ROOT, INDEX), 'utf8');
  for (const marker of MARKERS) {
    assert.ok(html.includes(marker), `${INDEX} is missing the marker ${JSON.stringify(marker)}`);
  }
  // Stripping every emoji would satisfy the scan above while breaking the UI just as badly.
  assert.ok([...html].filter((c) => c.codePointAt(0) > 0x2000).length > 100, `${INDEX} carries the app's iconography`);
});

test('🧪 the detector fires on the real v1.0.29 corruption (red proof)', () => {
  // Exactly the six code points v1.0.29 shipped where 🛡️ belongs (U+00F0 U+0178 U+203A U+00A1 U+00EF U+00B8).
  const corrupt = `${String.fromCodePoint(0xf0, 0x178, 0x203a, 0xa1, 0xef, 0xb8)} Aturan izin`;
  const hits = mojibakeHits(corrupt);
  assert.ok(hits.length >= 2, `the corrupted sample is flagged (got ${hits.length} hits)`);
  // The scan's own assertion must reject it — otherwise the guard would pass on a broken file.
  assert.throws(() => assertNoMojibake(corrupt, 'fixture'), (error) => {
    assert.match(error.message, /fixture: mojibake/, 'the failure names the file');
    assert.match(error.message, /line 1/, 'the failure names the line');
    assert.match(error.message, /Aturan izin/, 'the failure shows the offending snippet');
    return true;
  });

  // Every signature is live: a typo in a code point would make one of these pass.
  for (const { name, needle } of NEEDLES) {
    assert.ok(mojibakeHits(`x ${needle} y`).length > 0, `${name} is detected`);
  }
  // And the healthy forms are not false positives: this is not a blanket "non-ASCII" rule.
  for (const marker of MARKERS) assert.equal(mojibakeHits(marker).length, 0, `${JSON.stringify(marker)} is clean`);
});
