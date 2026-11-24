// 📊 .xlsx attachments: a dependency-free ZIP/XML reader turns a workbook into the tab-separated text the model
// reads, and the prompt reader accepts it as a normal text attachment. The fixture is built here (stored ZIP entries).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAttachments } from '../src/attachments.js';
import { XlsxError, xlsxToText } from '../src/xlsx.js';
import { attachmentKind, inspectAttachment, precheckAttachment } from '../public/js/core/attachment-rules.js';

const u16 = (b, i, v) => {
  b[i] = v & 0xff;
  b[i + 1] = (v >>> 8) & 0xff;
};
const u32 = (b, i, v) => {
  b[i] = v & 0xff;
  b[i + 1] = (v >>> 8) & 0xff;
  b[i + 2] = (v >>> 16) & 0xff;
  b[i + 3] = (v >>> 24) & 0xff;
};

/** A minimal ZIP with stored (method 0) entries: enough for Excel's container, CRC left 0 (the reader ignores it). */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, 'utf8');
    const file = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    u32(local, 0, 0x04034b50);
    u16(local, 4, 20);
    u16(local, 8, 0);
    u32(local, 18, data.length);
    u32(local, 22, data.length);
    u16(local, 26, file.length);
    locals.push(local, file, data);
    const cd = Buffer.alloc(46);
    u32(cd, 0, 0x02014b50);
    u16(cd, 4, 20);
    u16(cd, 6, 20);
    u32(cd, 20, data.length);
    u32(cd, 24, data.length);
    u16(cd, 28, file.length);
    u32(cd, 42, offset);
    central.push(cd, file);
    offset += 30 + file.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  u32(end, 0, 0x06054b50);
  u16(end, 8, Object.keys(entries).length);
  u16(end, 10, Object.keys(entries).length);
  u32(end, 12, directory.length);
  u32(end, 16, offset);
  return Buffer.concat([...locals, directory, end]);
}

const WORKBOOK = zip({
  'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Nama</t></si><si><t>Qty</t></si><si><t>Kopi</t></si></sst>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12</v></c><c r="C2" t="inlineStr"><is><t>catatan</t></is></c></row></sheetData></worksheet>',
});

test('xlsxToText: nama sheet, teks bersama, angka, dan inline string', () => {
  const text = xlsxToText(WORKBOOK);
  assert.match(text, /### Sheet: Data/);
  assert.match(text, /Nama\tQty/);
  assert.match(text, /Kopi\t12\tcatatan/);
  assert.match(text, /tanggal\/jam bisa tampil sebagai angka serial/);
  assert.throws(() => xlsxToText(Buffer.from('bukan zip')), XlsxError);
});

test('lampiran .xlsx: dikenali, dicek sebagai ZIP, lalu menjadi teks di prompt', () => {
  assert.equal(attachmentKind('laporan.xlsx', ''), 'spreadsheet');
  assert.equal(attachmentKind('x', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'spreadsheet');
  assert.match(precheckAttachment('lama.xls', '', 100), /\.xls.*belum didukung/i);
  assert.equal(precheckAttachment('laporan.xlsx', '', WORKBOOK.length), null);
  assert.equal(inspectAttachment({ name: 'laporan.xlsx', mediaType: '', bytes: WORKBOOK }).item.kind, 'spreadsheet');
  assert.equal(inspectAttachment({ name: 'palsu.xlsx', mediaType: '', bytes: Buffer.from('PK?') }).ok, false);

  const items = readAttachments({ attachments: [{ name: 'laporan.xlsx', mediaType: '', data: WORKBOOK.toString('base64') }] });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'spreadsheet');
  assert.equal(items[0].name, 'laporan.xlsx');
  assert.equal(items[0].size, WORKBOOK.length);
  assert.match(items[0].text, /Kopi\t12\tcatatan/);
});

test('file Excel rusak ditolak dengan pesan yang jelas', () => {
  const broken = zip({ 'xl/workbook.xml': '<workbook><sheets></sheets></workbook>' });
  assert.throws(() => readAttachments({ attachments: [{ name: 'rusak.xlsx', mediaType: '', data: broken.toString('base64') }] }), /tidak ada worksheet|tidak bisa dibaca/);
});
