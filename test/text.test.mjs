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
