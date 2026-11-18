// Adhitron reads as ONE app (1.0.71): no "machine" wording in what the user sees, no per-message engine mark and no
// per-engine badge in the session bar. The source of a model is only named where a model is picked.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');

/** Every .js file under public/js (the UI source). */
function uiFiles(dir = path.join(ROOT, 'public', 'js')) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return uiFiles(full);
    return e.name.endsWith('.js') ? [full] : [];
  });
}

test('no user-visible "mesin" wording in the page or the UI scripts', () => {
  // HTML comments are for developers; the rendered text is what matters.
  const html = read('public', 'index.html').replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(html, /\bmesin\b/i, 'index.html still shows "mesin" to the user');
  for (const file of uiFiles()) {
    const src = readFileSync(file, 'utf8');
    // Only lines that are not comments; a code comment may still explain the concept in English/Indonesian.
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    assert.doesNotMatch(code, /['"`][^'"`]*\bmesin\b[^'"`]*['"`]/i, `${path.relative(ROOT, file)} still renders "mesin"`);
  }
});

test('no per-message engine mark and no session-bar engine badge are left in the UI', () => {
  for (const file of uiFiles()) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /engine-mark|engineMark/, `${path.relative(ROOT, file)} still draws a per-message mark`);
    assert.doesNotMatch(src, /engine-badge|engineBadge/, `${path.relative(ROOT, file)} still draws an engine badge`);
  }
  const css = read('public', 'css', 'app.css');
  assert.doesNotMatch(css, /\.engine-mark|\.engine-badge/, 'the badge/mark styles are gone with the markup');
  assert.doesNotMatch(read('public', 'index.html'), /id="sb-engine"/);
});

test('the model picker hides sources without credentials instead of labelling them "belum login"', () => {
  const picker = read('public', 'js', 'features', 'model-picker.js');
  assert.doesNotMatch(picker, /belum login/, 'an unusable source is left out, not greyed with a label');
  assert.match(picker, /Belum ada sumber model yang aktif/);
  const engine = read('public', 'js', 'features', 'engine.js');
  assert.doesNotMatch(engine, /belum login\)/, 'the hidden select must not offer unconnected providers either');
});
