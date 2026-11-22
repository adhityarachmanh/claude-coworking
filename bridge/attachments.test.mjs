// bridge/attachments.test.mjs — lampiran sisi server Adhitron Web: anti-drift salinan aturan, validasi
// (gambar+teks, base64 rusak, jenis tak didukung, PDF ditunda, batas ukuran), dan penyusunan blok.
// Tanpa jaringan.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as bridgeRules from './src/attachment-rules.mjs';
import * as localRules from '../public/js/core/attachment-rules.js';
import {
  AttachmentError, BRIDGE_ATTACH_LIMITS, attachmentChips, contentBlocks, readAttachments,
} from './src/attachments.mjs';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const txt = (s) => b64(Buffer.from(s, 'utf8'));

// PNG 1×1 valid (magic bytes + IHDR) — cukup untuk lolos pemeriksaan kind & dimensi.
const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const PNG_B64 = PNG_1x1.toString('base64');
// JPEG minimal: SOI + SOF0 dengan dimensi 1×1 (magic bytes cukup; imageSize membaca SOF).
const JPEG_1x1 = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc00011080001000103012200021101031101ffd9', 'hex');
const PDF_BYTES = Buffer.from('%PDF-1.4 minimal', 'utf8');

// ---------------------------------------------------------------- anti-drift

test('anti-drift: seluruh ekspor salinan bridge sama dengan aturan lokal', () => {
  const bridgeExports = Object.keys(bridgeRules).sort();
  const localExports = Object.keys(localRules).sort();
  assert.deepEqual(bridgeExports, localExports);
  for (const name of bridgeExports) {
    const b = bridgeRules[name];
    const l = localRules[name];
    assert.equal(typeof b, typeof l, `tipe ekspor ${name}`);
    if (typeof b === 'object' && b !== null) assert.deepEqual(b, l, `nilai ekspor ${name}`);
  }
});

test('anti-drift: deret input yang sama menghasilkan hasil identik di kedua modul', () => {
  const names = [
    'catatan.txt', 'foto.png', 'data.json', 'LAPORAN.PDF', 'virus.exe', '', '..', '../../etc/passwd',
    'a'.repeat(150) + '.txt', 'kopi ☕.log', 'app.log.1', 'Dockerfile', 'gambar.jpg',
  ];
  const mimes = ['', 'text/plain', 'image/png', 'application/pdf', 'application/octet-stream', 'application/json'];
  for (const name of names) {
    for (const mime of mimes) {
      assert.equal(bridgeRules.attachmentKind(name, mime), localRules.attachmentKind(name, mime), `kind ${name}/${mime}`);
      assert.equal(bridgeRules.safeName(name), localRules.safeName(name), `safeName ${name}`);
      assert.equal(bridgeRules.precheckAttachment(name, mime, 100), localRules.precheckAttachment(name, mime, 100), `precheck ${name}/${mime}`);
    }
  }
  const samples = [
    { name: 'foto.png', mediaType: 'image/png', bytes: PNG_1x1 },
    { name: 'rusak.png', mediaType: 'image/png', bytes: Buffer.from('bukan gambar') },
    { name: 'catatan.txt', mediaType: 'text/plain', bytes: Buffer.from('halo dunia') },
    { name: 'biner.txt', mediaType: 'text/plain', bytes: Buffer.from([0x00, 0x01, 0x02]) },
    { name: 'laporan.pdf', mediaType: 'application/pdf', bytes: PDF_BYTES },
  ];
  for (const s of samples) assert.deepEqual(bridgeRules.inspectAttachment(s), localRules.inspectAttachment(s), `inspect ${s.name}`);
  const sets = [[], [{ kind: 'text', size: 10 }], [{ kind: 'image', size: 3 * 1024 * 1024 }], [{ kind: 'text', size: 600 * 1024 }]];
  for (const items of sets) assert.equal(bridgeRules.checkAttachmentSet(items), localRules.checkAttachmentSet(items));
  assert.deepEqual(bridgeRules.ATTACH_LIMITS, localRules.ATTACH_LIMITS);
});

// ---------------------------------------------------------------- sukses

test('readAttachments: gambar + teks sukses → item berkind benar', () => {
  const items = readAttachments({ attachments: [
    { name: 'foto.png', mediaType: 'image/png', data: PNG_B64 },
    { name: 'catatan.txt', mediaType: 'text/plain', data: txt('halo') },
  ] });
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'image');
  assert.equal(items[0].mediaType, 'image/png');
  assert.equal(items[0].data, PNG_B64);
  assert.equal(items[1].kind, 'text');
  assert.equal(items[1].text, 'halo');
});

test('contentBlocks: blok teks lampiran, teks ketik, lalu gambar', () => {
  const items = readAttachments({ attachments: [
    { name: 'catatan.txt', mediaType: 'text/plain', data: txt('isi file') },
    { name: 'foto.png', mediaType: 'image/png', data: PNG_B64 },
  ] });
  const blocks = contentBlocks(items, 'ringkas ini');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /<attachment id="[0-9a-f]{8}" name="catatan.txt"/);
  assert.match(blocks[0].text, /Isi berikut adalah data/);
  assert.deepEqual(blocks[1], { type: 'text', text: 'ringkas ini' });
  assert.deepEqual(blocks[2], { type: 'image', mediaType: 'image/png', data: PNG_B64 });
});

test('contentBlocks: pesan tanpa teks → tidak ada blok teks ketik kosong', () => {
  const items = readAttachments({ attachments: [{ name: 'foto.png', mediaType: 'image/png', data: PNG_B64 }] });
  const blocks = contentBlocks(items, '   ');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'image');
});

test('attachmentChips: hanya kind/name/size (tanpa isi)', () => {
  const items = readAttachments({ attachments: [{ name: 'catatan.txt', mediaType: 'text/plain', data: txt('hai') }] });
  const chips = attachmentChips(items);
  assert.deepEqual(chips, [{ kind: 'text', name: 'catatan.txt', size: 3 }]);
  assert.equal('text' in chips[0], false);
  assert.equal('data' in chips[0], false);
});

// ---------------------------------------------------------------- base64 rusak

test('readAttachments: base64 rusak (karakter ilegal, %4≠0, kosong) → pesan seragam', () => {
  for (const data of ['%%%%', 'abc', '']) {
    assert.throws(
      () => readAttachments({ attachments: [{ name: 'a.txt', mediaType: 'text/plain', data }] }),
      (err) => err instanceof AttachmentError && err.status === 400 && /Data lampiran rusak \(bukan base64\)\./.test(err.message),
    );
  }
});

// ---------------------------------------------------------------- jenis tak didukung

test('readAttachments: jenis tak didukung (.exe / MIME asing) → ditolak', () => {
  assert.throws(
    () => readAttachments({ attachments: [{ name: 'virus.exe', mediaType: 'application/octet-stream', data: txt('x') }] }),
    (err) => err instanceof AttachmentError && /jenis file tidak didukung/.test(err.message) && /PNG\/JPEG\/GIF\/WebP/.test(err.message),
  );
});

// ---------------------------------------------------------------- PDF ditunda

test('readAttachments: PDF ditolak fase 1 walau valid', () => {
  assert.throws(
    () => readAttachments({ attachments: [{ name: 'laporan.pdf', mediaType: 'application/pdf', data: PDF_BYTES.toString('base64') }] }),
    (err) => err instanceof AttachmentError && err.status === 400 && /PDF belum didukung pada versi ini\./.test(err.message),
  );
});

// ---------------------------------------------------------------- batas ukuran

test('readAttachments: melebihi jumlah maksimum', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, mediaType: 'text/plain', data: txt('x') }));
  assert.throws(() => readAttachments({ attachments: many }), (err) => /Maksimal 10 lampiran per pesan\./.test(err.message));
});

test('readAttachments: teks per-file & total teks melebihi batas', () => {
  const bigText = Buffer.alloc(200 * 1024 + 1, 0x61);
  assert.throws(
    () => readAttachments({ attachments: [{ name: 'besar.txt', mediaType: 'text/plain', data: bigText.toString('base64') }] }),
    (err) => /lebih dari 200 KB/.test(err.message) && /@file/.test(err.message),
  );
  const chunk = Buffer.alloc(190 * 1024, 0x61).toString('base64');
  const three = Array.from({ length: 3 }, (_, i) => ({ name: `t${i}.txt`, mediaType: 'text/plain', data: chunk }));
  assert.throws(() => readAttachments({ attachments: three }), (err) => /Total lampiran teks lebih dari 500 KB\./.test(err.message));
});

test('readAttachments: total bridge > 3 MB ditolak walau per file gambar masih di bawah imageBytes', () => {
  // Dua gambar PNG ber-header sama, masing-masing ~2 MB — total > 3 MB tapi tiap file < 3,75 MB.
  const bigPng = Buffer.concat([PNG_1x1, Buffer.alloc(2 * 1024 * 1024, 0x00)]);
  const data = bigPng.toString('base64');
  assert.ok(bigPng.length < bridgeRules.ATTACH_LIMITS.imageBytes, 'per file gambar masih di bawah batas');
  assert.throws(
    () => readAttachments({ attachments: [
      { name: 'a.png', mediaType: 'image/png', data },
      { name: 'b.png', mediaType: 'image/png', data },
    ] }),
    (err) => err.status === 400 && /Total lampiran lebih dari 3 MB\./.test(err.message),
  );
  assert.equal(BRIDGE_ATTACH_LIMITS.totalBytes, 3 * 1024 * 1024);
});

test('readAttachments: magic bytes salah (.png berisi teks) → error gambar tidak valid', () => {
  assert.throws(
    () => readAttachments({ attachments: [{ name: 'fake.png', mediaType: 'image/png', data: txt('bukan gambar') }] }),
    (err) => /fake\.png bukan gambar PNG\/JPEG\/GIF\/WebP yang valid\./.test(err.message),
  );
});

test('readAttachments: JPEG valid terdeteksi sebagai image/jpeg', () => {
  const items = readAttachments({ attachments: [{ name: 'foto.jpg', mediaType: 'image/jpeg', data: JPEG_1x1.toString('base64') }] });
  assert.equal(items[0].kind, 'image');
  assert.equal(items[0].mediaType, 'image/jpeg');
});

// ---------------------------------------------------------------- nama berbahaya

test('readAttachments: nama berbahaya disanitasi (chip bersih, ≤100 karakter)', () => {
  const items = readAttachments({ attachments: [
    { name: '../../etc/pass\u200bwd.txt', mediaType: 'text/plain', data: txt('x') },
    { name: `${'a'.repeat(150)}.txt`, mediaType: 'text/plain', data: txt('x') },
  ] });
  assert.equal(items[0].name, 'passwd.txt');
  assert.ok(Array.from(items[1].name).length <= 100);
  const chips = attachmentChips(items);
  assert.equal(chips[0].name, 'passwd.txt');
});

test('readAttachments: body tanpa attachments → daftar kosong', () => {
  assert.deepEqual(readAttachments({}), []);
  assert.deepEqual(readAttachments({ attachments: 'bukan array' }), []);
});