import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../public/js/markdown.js';
import { clip, firstSentence, normalizePath, projectId, truncate } from '../src/util.js';

test('speech bubbles get the first plain sentence', () => {
  assert.equal(firstSentence('Fitur login selesai ✅\n\n| Bagian | Hasil |\n|---|---|\n| UI | x |'), 'Fitur login selesai ✅');
  assert.equal(firstSentence('Oke. Lalu **lanjut** ke tahap dua.'), 'Oke.');
  assert.equal(firstSentence('```js\ncode()\n```\nSelesai!'), 'Selesai!');
});

test('text helpers', () => {
  assert.equal(truncate('a   b\n c', 10), 'a b c');
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.equal(clip('abcdef', 3), 'abc\n…');
  assert.ok(!normalizePath('/tmp/a/').endsWith('/'));
  assert.equal(projectId('/tmp/a'), projectId('/tmp/a/'));
  // Windows paths are case-insensitive, so the same folder must get the same id.
  if (process.platform === 'win32') assert.equal(projectId('C:/Proj/X'), projectId(String.raw`c:\proj\x`));
});

test('markdown is escaped before formatting', () => {
  const html = renderMarkdown('<script>alert(1)</script> **tebal** `kode` [link](https://x.dev) [js](javascript:alert(1))');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<strong>tebal</strong>'));
  assert.ok(html.includes('<code>kode</code>'));
  assert.ok(html.includes('href="https://x.dev"'));
  assert.ok(!html.includes('href="javascript'));
});

test('markdown tables, lists and highlighted code', () => {
  assert.match(renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |'), /<table>.*<th>A<\/th>.*<td>2<\/td>/s);
  assert.match(renderMarkdown('- satu\n- dua'), /<ul><li>satu<\/li><li>dua<\/li><\/ul>/);
  const code = renderMarkdown('```js\nconst a = "x"; // c\nreturn 42;\n```');
  assert.match(code, /<span class="hl-k">const<\/span>/);
  assert.match(code, /<span class="hl-s">&#34;x&#34;<\/span>/);
  assert.match(code, /<span class="hl-c">\/\/ c<\/span>/);
  assert.match(code, /<span class="hl-n">42<\/span>/);
  assert.match(renderMarkdown('```sql\nselect 1 -- note\n```'), /hl-c">-- note/);
});

test('markdown blockquote holds paragraphs and lists (not a literal "> -")', () => {
  const html = renderMarkdown('> **Catatan** (beda):\n> - **D3/D4:** satu\n> - **D7:** dua\n\nsetelah');
  assert.equal(html, '<blockquote><p><strong>Catatan</strong> (beda):</p><ul><li><strong>D3/D4:</strong> satu</li><li><strong>D7:</strong> dua</li></ul></blockquote><p>setelah</p>');
  assert.equal(renderMarkdown('> satu\n>\n> dua'), '<blockquote><p>satu</p><p>dua</p></blockquote>');
  assert.equal(renderMarkdown('> <img src=x onerror=alert(1)>'), '<blockquote><p>&#60;img src=x onerror=alert(1)&#62;</p></blockquote>', 'isi kutipan tetap di-escape');
  // A crafted `>>>>…` line has a bounded depth (no runaway recursion); the rest stays text.
  const deep = renderMarkdown(`${'>'.repeat(5000)} x`);
  assert.equal(deep.match(/<blockquote>/g).length, 8);
  assert.ok(deep.includes('&#62;'));
});

test('markdown tables: \\| is a literal pipe (also in code), rows never get extra columns', () => {
  const html = renderMarkdown("| ID | Keputusan | Alasan |\n|---|---|---|\n| D1 | Setting **`engine: 'claude' \\| 'opencode'`**, default `'claude'` | a \\| b |\n| D2 | x | y | z | w |\n| D3 | kurang |");
  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[hd]>(.*?)<\/t[hd]>/g)].map((c) => c[1]));
  assert.equal(rows[1][1], 'Setting <strong><code>engine: &#39;claude&#39; | &#39;opencode&#39;</code></strong>, default <code>&#39;claude&#39;</code>');
  assert.equal(rows[1][2], 'a | b');
  assert.deepEqual(rows.map((r) => r.length), [3, 3, 3, 3], 'semua baris selebar header');
  assert.deepEqual(rows[2], ['D2', 'x', 'y']);
  assert.deepEqual(rows[3], ['D3', 'kurang', '']);
  assert.ok(!html.includes('**'));
});

test('markdown inline code stays literal and escaped', () => {
  assert.equal(renderMarkdown('a `**x** <b>` **b**'), '<p>a <code>**x** &#60;b&#62;</code> <strong>b</strong></p>');
});
