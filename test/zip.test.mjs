// ZIP writer/reader without dependencies (src/zip.js): round trips, ZIP64, CRC checks, unsafe names,
// and — on Windows — that PowerShell's Expand-Archive (.NET ZipArchive, same as Explorer) opens the result.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import zlib from 'node:zlib';
import { ZipError, ZipReader, ZipWriter, crc32, crc32Table, unsafeEntryName } from '../src/zip.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-zip-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

/** Writes `entries` ([name, Buffer|{stream,size}, options]) to a new zip file and returns its path. */
async function makeZip(entries, options) {
  const file = path.join(TMP, `t${n++}.zip`);
  const out = createWriteStream(file);
  const zip = new ZipWriter(out, options);
  for (const [name, data, opts] of entries) await zip.add(name, data, opts);
  await zip.finish();
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  return file;
}

async function readAll(file) {
  const zip = await ZipReader.open(file);
  try {
    const out = {};
    for (const e of zip.entries) out[e.name] = await zip.read(e);
    return { files: out, entries: zip.entries };
  } finally {
    await zip.close();
  }
}

const SAMPLE = () => [
  ['kecil.txt', Buffer.from('halo dunia\n')],
  ['kosong.txt', Buffer.alloc(0)],
  ['folder/ünïcödé — 日本語 🎉.jsonl', Buffer.from('{"a":1}\n'.repeat(50))],
  ['folder/acak.bin', randomBytes(64 * 1024)], // incompressible
  ['besar.jsonl', Buffer.from(`${'{"type":"assistant","message":"lorem ipsum"}\n'.repeat(120_000)}`)], // ~5 MB
];

test('crc32: table version matches known values (and the native one when Node has it)', () => {
  assert.equal(crc32Table(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32Table(Buffer.alloc(0)), 0);
  const data = randomBytes(10_000);
  assert.equal(crc32Table(data.subarray(5000), crc32Table(data.subarray(0, 5000))), crc32Table(data), 'continues across chunks');
  assert.equal(crc32(data), crc32Table(data));
  if (typeof zlib.crc32 === 'function') assert.equal(zlib.crc32(data) >>> 0, crc32Table(data));
});

for (const zip64 of [false, true]) {
  test(`round trip${zip64 ? ' (ZIP64 forced)' : ''}: small, empty, UTF-8 names, incompressible, several MB`, async () => {
    const sample = SAMPLE();
    const mtime = new Date('2024-05-06T07:08:09Z');
    const file = await makeZip(sample.map(([name, data]) => [name, data, { mtime }]), { zip64 });
    const { files, entries } = await readAll(file);
    assert.deepEqual(Object.keys(files), sample.map(([name]) => name));
    for (const [name, data] of sample) assert.ok(files[name].equals(data), name);
    for (const e of entries) assert.equal(e.mtime, mtime.getTime(), 'mtime kept to the second (extended timestamp)');
    assert.ok(statSync(file).size < 1_000_000, 'the repetitive 5 MB file is deflated');
  });
}

test('streams in, many entries, sizes from a stream', async () => {
  const entries = [];
  for (let i = 0; i < 1500; i++) entries.push([`banyak/${String(i).padStart(4, '0')}.txt`, Buffer.from(`file ${i}\n`)]);
  const big = randomBytes(3 * 1024 * 1024);
  entries.push(['stream.bin', { stream: Readable.from([big.subarray(0, 1e6), big.subarray(1e6)]), size: big.length }]);
  const file = path.join(TMP, `t${n++}.zip`);
  const out = createWriteStream(file);
  const zip = new ZipWriter(out);
  for (const [name, data] of entries) await zip.add(name, data.stream ?? data, { size: data.size });
  await zip.finish();
  await new Promise((r) => out.end(r));
  const { files } = await readAll(file);
  assert.equal(Object.keys(files).length, 1501);
  assert.equal(files['banyak/1499.txt'].toString(), 'file 1499\n');
  assert.ok(files['stream.bin'].equals(big));
});

test('a wrong CRC (or corrupted data) is refused', async () => {
  const data = Buffer.from('isi yang akan dirusak '.repeat(100));
  const file = await makeZip([['a.txt', data]]);
  const buf = readFileSync(file);
  // The CRC in the central directory: flip it.
  const cd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt32LE((buf.readUInt32LE(cd + 16) ^ 0xdeadbeef) >>> 0, cd + 16);
  writeFileSync(file, buf);
  const zip = await ZipReader.open(file);
  await assert.rejects(zip.read(zip.entries[0]), (err) => err instanceof ZipError && /CRC/.test(err.message));
  await zip.close();

  // Damaged deflate data: refused as corrupt, never returned.
  const file2 = await makeZip([['b.txt', randomBytes(4096)]]);
  const buf2 = readFileSync(file2);
  for (let i = 60; i < 200; i++) buf2[i] ^= 0x55;
  writeFileSync(file2, buf2);
  const zip2 = await ZipReader.open(file2);
  await assert.rejects(zip2.read(zip2.entries[0]), ZipError);
  await zip2.close();
});

test('not a zip / truncated zip: a clear ZipError', async () => {
  const junk = path.join(TMP, 'junk.zip');
  writeFileSync(junk, 'bukan zip sama sekali');
  await assert.rejects(ZipReader.open(junk), ZipError);
  const good = readFileSync(await makeZip([['a.txt', Buffer.from('x')]]));
  writeFileSync(junk, good.subarray(0, good.length - 30));
  await assert.rejects(ZipReader.open(junk), ZipError);
});

test('unsafe entry names are refused by the reader (zip-slip, absolute, drive letters, backslashes, devices)', async () => {
  for (const name of ['PROGRA~1/x', 'claude/plans/DOCUME~2', '../x', 'a/../../x', '/abs', '/etc/passwd', 'C:\\x', 'C:/x', '..\\x', 'a\\b', 'a//b', './a', 'CON', 'dir/nul.txt', 'com1', 'file.', 'dir /x', 'a\u0000b', 'a:stream']) {
    assert.ok(unsafeEntryName(name), `${JSON.stringify(name)} must be unsafe`);
    const file = await makeZip([['ok.txt', Buffer.from('ok')], [name, Buffer.from('evil')]]);
    await assert.rejects(ZipReader.open(file), (err) => err instanceof ZipError && /ditolak/.test(err.message), name);
  }
  for (const name of ['claude/projects/C--Users-x/abc.jsonl', 'a/b/c.txt', 'dir/', 'console.log', 'nul-not.txt', 'é.md']) assert.equal(unsafeEntryName(name), null, name);
});

test('symlink entries and duplicate names are refused', async () => {
  const link = await makeZip([['link', Buffer.from('/etc/passwd'), { mode: 0o120777 }]]);
  await assert.rejects(ZipReader.open(link), /symlink/);
  const dup = await makeZip([['a.txt', Buffer.from('1')], ['A.TXT', Buffer.from('2')]]);
  await assert.rejects(ZipReader.open(dup), /dua kali/);
  const file = await makeZip([['ok.sh', Buffer.from('echo'), { mode: 0o100755 }]]);
  assert.equal((await readAll(file)).files['ok.sh'].toString(), 'echo', 'a regular Unix-mode file is fine');
});

test('the declared size is enforced while inflating (no zip bombs)', async () => {
  const file = await makeZip([['bom.txt', Buffer.alloc(1_000_000)]]);
  const zip = await ZipReader.open(file);
  zip.entries[0].usize = 1000; // directory lies: says 1000 bytes
  await assert.rejects(zip.read(zip.entries[0]), /lebih besar/);
  await zip.close();
});

// Windows Explorer and Expand-Archive both use .NET's ZipArchive rules.
const powershell = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;
for (const zip64 of [false, true]) {
  test(`PowerShell Expand-Archive opens the archive${zip64 ? ' (ZIP64)' : ''}`, { skip: !powershell && 'PowerShell tidak tersedia' }, async () => {
    const sample = SAMPLE().filter(([name]) => name !== 'besar.jsonl');
    const file = await makeZip(sample, { zip64 });
    const dest = path.join(TMP, `x${n++}`);
    mkdirSync(dest);
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${file}' -DestinationPath '${dest}' -Force`], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    for (const [name, data] of sample) assert.ok(readFileSync(path.join(dest, ...name.split('/'))).equals(data), name);
    assert.deepEqual(readdirSync(dest).sort(), ['folder', 'kecil.txt', 'kosong.txt']);
  });
}

test('untrusted archive metadata: a future mtime is clamped to now, entry count is bounded', async () => {
  const file = await makeZip([['a.txt', Buffer.from('a'), { mtime: new Date('2099-01-01T00:00:00Z') }], ['b.txt', Buffer.from('b')], ['c.txt', Buffer.from('c')]]);
  const before = Date.now();
  const zip = await ZipReader.open(file);
  assert.ok(zip.entries[0].mtime <= Date.now() && zip.entries[0].mtime >= before - 1000, 'never in the future');
  await zip.close();
  await assert.rejects(ZipReader.open(file, { maxEntries: 2 }), /terlalu banyak entri/);
});

test('file-system errors while extracting are not disguised as a corrupt archive', async () => {
  const file = await makeZip([['a.txt', Buffer.from('isi')]]);
  const zip = await ZipReader.open(file);
  const err = await zip.extractTo(zip.entries[0], path.join(TMP, 'no-such-dir', 'a.txt')).catch((e) => e);
  await zip.close();
  assert.ok(!(err instanceof ZipError), 'not a ZipError');
  assert.equal(err.code, 'ENOENT', 'the original code reaches the caller (EBUSY/EPERM handling relies on it)');
});
