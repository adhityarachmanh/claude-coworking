// 📋 Pasting spreadsheet cells: tab-separated clipboard text becomes a Markdown table (bounded, escaped); a plain
// list or one column is left as normal text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeTable, tsvToMarkdown } from '../public/js/core/paste-table.js';

test('tsvToMarkdown: header, separator, rows', () => {
  const md = tsvToMarkdown('Nama\tQty\tHarga\nKopi\t12\t15000\nTeh\t5\t8000');
  assert.equal(md, ['| Nama | Qty | Harga |', '| --- | --- | --- |', '| Kopi | 12 | 15000 |', '| Teh | 5 | 8000 |'].join('\n'));
});

test('tsvToMarkdown: pipa di sel di-escape, baris kosong di ujung dibuang, kolom tak rata diisi', () => {
  const md = tsvToMarkdown('a|b\tc\n1\t2\t3\n\n');
  assert.equal(md, ['| a\\|b | c |  |', '| --- | --- | --- |', '| 1 | 2 | 3 |'].join('\n'));
});

test('tsvToMarkdown: bukan tabel (satu kolom / tanpa tab) tetap teks biasa', () => {
  assert.equal(tsvToMarkdown('satu\n dua\n tiga'), null);
  assert.equal(tsvToMarkdown('a\tb'), null, 'satu baris bukan tabel');
  assert.equal(looksLikeTable('a\tb\n1\t2'), true);
  assert.equal(looksLikeTable('a b\n1 2'), false);
});

test('tsvToMarkdown: dibatasi dan memberi catatan saat baris dipotong', () => {
  const rows = Array.from({ length: 5 }, (_, i) => `${i}\tbaris-${i}`).join('\n');
  const md = tsvToMarkdown(rows, { maxRows: 3 });
  assert.equal(md.split('\n').length, 5, 'header + separator + 2 body rows + catatan');
  assert.match(md, /2 baris lagi tidak disertakan/);
});
