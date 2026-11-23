// ACP prompt blocks: OpenCode attaches PDFs as `resource` blobs (docs: prompt content, "resource with blob"), not as
// the "(lampiran … tidak bisa dikirim)" placeholder it used to get. Images and text files keep their old shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptBlocks } from '../src/acp-session.js';

test('promptBlocks: PDF jadi resource blob, gambar tetap image, teks tetap inline', () => {
  const blocks = promptBlocks('lihat ini', [
    { kind: 'pdf', name: 'laporan akhir.pdf', mediaType: 'application/pdf', data: 'JVBERi0=' },
    { kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'iVBORw0=' },
    { kind: 'text', name: 'catatan.txt', text: 'isi catatan' },
  ]);
  assert.equal(blocks[0].type, 'text');
  const pdf = blocks.find((b) => b.type === 'resource');
  assert.deepEqual(pdf, { type: 'resource', resource: { uri: 'attachment://laporan%20akhir.pdf', mimeType: 'application/pdf', blob: 'JVBERi0=' } });
  assert.deepEqual(blocks.find((b) => b.type === 'image'), { type: 'image', mimeType: 'image/png', data: 'iVBORw0=' });
  assert.match(blocks[0].text, /<file name="catatan.txt">/);
  assert.doesNotMatch(blocks[0].text, /tidak bisa dikirim/);
});
