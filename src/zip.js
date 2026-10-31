// Minimal ZIP (PKWARE APPNOTE 6.3) writer and reader for the history backup, without dependencies.
//
// Writer: streams every entry through zlib deflateRaw straight to the output (an HTTP response), so a
//   backup is never held in memory. Sizes and CRC-32 follow each entry in a data descriptor (flag bit 3);
//   names are UTF-8 (flag bit 11) with `/` separators; mtime is kept to the second in an extended
//   timestamp field (0x5455) next to the 2-second DOS time.
// ZIP64: written per entry when the file may exceed 4 GB (or always with { zip64: true }), and for the
//   archive when it has 65535+ entries or the central directory starts/ends past 4 GB. So a backup of any
//   size is valid, and Windows Explorer / Expand-Archive (.NET ZipArchive) open it.
// Reader: works on a file on disk (only the central directory is read into memory), supports stored and
//   deflate entries, ZIP64, and verifies every entry's size and CRC-32 while it streams.
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

/** A ZIP that is malformed, unsupported or unsafe; its message is meant for the user. */
export class ZipError extends Error {}

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
// Entries this large get ZIP64 sizes up front: deflate can add a little to incompressible data.
const ZIP64_ENTRY_THRESHOLD = 0xf0000000;
const FLAGS = 0x0008 | 0x0800; // data descriptor + UTF-8 names
const SIG = { local: 0x04034b50, descriptor: 0x08074b50, central: 0x02014b50, eocd: 0x06054b50, eocd64: 0x06064b50, locator64: 0x07064b50 };
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

// ---------- CRC-32 (IEEE 802.3, the one ZIP uses) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Table-driven CRC-32 (Node 20 has no zlib.crc32); `crc` continues a previous result. */
export function crc32Table(buf, crc = 0) {
  let c = ~crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// Node ≥ 22.2 has a native (much faster) one with the same results.
export const crc32 = typeof zlib.crc32 === 'function' ? (buf, crc = 0) => zlib.crc32(buf, crc) >>> 0 : crc32Table;

// ---------- entry names ----------

// Windows device names refuse to be files (and "nul.txt" opens the device), with or without extension.
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/i;

/**
 * Why `name` is not a safe relative path inside an archive, or null when it is. Refuses what could escape
 * the target folder or mean something else on Windows: `..`/`.` segments, absolute paths, drive letters
 * and ADS (`:`), backslashes, control characters, characters Windows forbids, device names, 8.3 short
 * names (`~1`), and segments ending in a dot or space (Windows silently strips those).
 */
export function unsafeEntryName(name) {
  if (typeof name !== 'string' || !name) return 'nama kosong';
  if (name.length > 1024) return 'nama terlalu panjang';
  if (name.startsWith('/')) return 'path absolut';
  if (/[\\]/.test(name)) return 'memakai backslash';
  if (/[:]/.test(name)) return 'memakai titik dua (drive letter / ADS)';
  if (/[\u0000-\u001f\u007f*?"<>|]/.test(name)) return 'memakai karakter yang tidak diizinkan';
  const parts = name.replace(/\/$/, '').split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return 'memakai segmen path kosong, "." atau ".."';
    if (DEVICE_NAME.test(part)) return `memakai nama device Windows (${part})`;
    if (/[. ]$/.test(part)) return 'segmen diakhiri titik atau spasi';
    // "PROGRA~1": a Windows 8.3 short name can alias another folder (e.g. one outside the intended path).
    if (/~\d/.test(part)) return 'memakai nama pendek 8.3 Windows (~N)';
  }
  return null;
}

// ---------- writer ----------

function dosDateTime(date) {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01, the earliest DOS date
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Extended timestamp extra field (0x5455): modification time, seconds since the epoch (UTC). */
function timestampExtra(unix) {
  const buf = Buffer.alloc(9);
  buf.writeUInt16LE(0x5455, 0);
  buf.writeUInt16LE(5, 2);
  buf.writeUInt8(1, 4); // flags: mtime present
  buf.writeUInt32LE(Math.max(0, Math.min(MAX32, unix)), 5);
  return buf;
}

export class ZipWriter {
  /**
   * @param {import('node:stream').Writable} out  where the archive goes (e.g. an HTTP response); not ended by finish()
   * @param {{ zip64?: boolean }} [options]  zip64: write ZIP64 records even when not needed (tests, very large sets)
   */
  constructor(out, { zip64 = false } = {}) {
    this.out = out;
    this.forceZip64 = zip64;
    this.offset = 0; // bytes written so far
    this.entries = [];
    this.finished = false;
  }

  /** Writes with backpressure; rejects once the output is gone (client aborted the download). */
  write(buf) {
    if (this.out.destroyed || this.out.writableEnded) return Promise.reject(new ZipError('Output ZIP sudah ditutup.'));
    this.offset += buf.length;
    if (this.out.write(buf)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (err) => {
        this.out.off('drain', onDrain);
        this.out.off('close', onClose);
        this.out.off('error', done);
        if (err) reject(err);
        else resolve();
      };
      const onDrain = () => done();
      const onClose = () => done(new ZipError('Output ZIP sudah ditutup.'));
      this.out.once('drain', onDrain);
      this.out.once('close', onClose);
      this.out.once('error', done);
    });
  }

  /**
   * Adds one file entry from a Buffer or a Readable.
   * @param {string} name   path inside the archive, `/`-separated
   * @param {Buffer|import('node:stream').Readable} source
   * @param {{ mtime?: Date|number, size?: number, mode?: number }} [options]
   *   size: expected byte count of a stream (decides ZIP64 before writing); mode: Unix mode bits (tests/symlinks)
   */
  async add(name, source, { mtime = new Date(), size, mode } = {}) {
    if (this.finished) throw new ZipError('ZIP sudah selesai ditulis.');
    const nameBuf = Buffer.from(String(name), 'utf8');
    if (!nameBuf.length || nameBuf.length > MAX16) throw new ZipError(`Nama entri tidak valid: ${name}`);
    const when = mtime instanceof Date ? mtime : new Date(mtime);
    const dos = dosDateTime(when);
    const unix = Math.floor(when.getTime() / 1000);
    const expected = Buffer.isBuffer(source) ? source.length : (size ?? 0);
    const zip64 = this.forceZip64 || expected >= ZIP64_ENTRY_THRESHOLD;
    const offset = this.offset;

    // Local header: CRC and sizes are not known yet (data descriptor follows the data).
    const extras = [timestampExtra(unix)];
    if (zip64) {
      const z = Buffer.alloc(20); // tag, size 16, then sizes 0 (the real ones are in the descriptor)
      z.writeUInt16LE(0x0001, 0);
      z.writeUInt16LE(16, 2);
      extras.push(z);
    }
    const extra = Buffer.concat(extras);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG.local, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4); // version needed
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(dos.time, 10);
    header.writeUInt16LE(dos.date, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(zip64 ? MAX32 : 0, 18);
    header.writeUInt32LE(zip64 ? MAX32 : 0, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(extra.length, 28);
    await this.write(Buffer.concat([header, nameBuf, extra]));

    let crc = 0;
    let usize = 0;
    let csize = 0;
    if (Buffer.isBuffer(source)) {
      const packed = zlib.deflateRawSync(source);
      crc = crc32(source);
      usize = source.length;
      csize = packed.length;
      await this.write(packed);
    } else {
      const tap = new Transform({
        transform(chunk, _enc, cb) {
          crc = crc32(chunk, crc);
          usize += chunk.length;
          cb(null, chunk);
        },
      });
      const sink = new Writable({
        write: (chunk, _enc, cb) => {
          csize += chunk.length;
          this.write(chunk).then(() => cb(), cb);
        },
      });
      await pipeline(source, tap, zlib.createDeflateRaw(), sink);
    }
    if (!zip64 && (usize >= MAX32 || csize >= MAX32)) throw new ZipError(`${name}: lebih besar dari yang dinyatakan (ZIP64 diperlukan).`);

    const descriptor = Buffer.alloc(zip64 ? 24 : 16);
    descriptor.writeUInt32LE(SIG.descriptor, 0);
    descriptor.writeUInt32LE(crc, 4);
    if (zip64) {
      descriptor.writeBigUInt64LE(BigInt(csize), 8);
      descriptor.writeBigUInt64LE(BigInt(usize), 16);
    } else {
      descriptor.writeUInt32LE(csize, 8);
      descriptor.writeUInt32LE(usize, 12);
    }
    await this.write(descriptor);
    this.entries.push({ nameBuf, crc, usize, csize, offset, zip64, dos, unix, mode });
  }

  /** Writes the central directory and end records. Returns the archive size in bytes. */
  async finish() {
    if (this.finished) return this.offset;
    this.finished = true;
    const cdStart = this.offset;
    for (const e of this.entries) {
      const zip64 = e.zip64 || e.offset >= MAX32;
      const extras = [timestampExtra(e.unix)];
      if (zip64) {
        // All three fields are 0xFFFFFFFF in the header, so all three appear here, in this order.
        const z = Buffer.alloc(28);
        z.writeUInt16LE(0x0001, 0);
        z.writeUInt16LE(24, 2);
        z.writeBigUInt64LE(BigInt(e.usize), 4);
        z.writeBigUInt64LE(BigInt(e.csize), 12);
        z.writeBigUInt64LE(BigInt(e.offset), 20);
        extras.push(z);
      }
      const extra = Buffer.concat(extras);
      const unixHost = e.mode != null;
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG.central, 0);
      h.writeUInt16LE((unixHost ? 3 << 8 : 0) | 45, 4); // made by: MS-DOS (or Unix when a mode is given), spec 4.5
      h.writeUInt16LE(zip64 ? 45 : 20, 6);
      h.writeUInt16LE(FLAGS, 8);
      h.writeUInt16LE(8, 10);
      h.writeUInt16LE(e.dos.time, 12);
      h.writeUInt16LE(e.dos.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(zip64 ? MAX32 : e.csize, 20);
      h.writeUInt32LE(zip64 ? MAX32 : e.usize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attributes
      h.writeUInt32LE(unixHost ? ((e.mode & MAX16) << 16) >>> 0 : 0, 38);
      h.writeUInt32LE(zip64 ? MAX32 : e.offset, 42);
      await this.write(Buffer.concat([h, e.nameBuf, extra]));
    }
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    const zip64 = this.forceZip64 || count >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32;
    if (zip64) {
      const at = this.offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(SIG.eocd64, 0);
      rec.writeBigUInt64LE(44n, 4); // size of the rest of this record
      rec.writeUInt16LE(45, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeUInt32LE(0, 16);
      rec.writeUInt32LE(0, 20);
      rec.writeBigUInt64LE(BigInt(count), 24);
      rec.writeBigUInt64LE(BigInt(count), 32);
      rec.writeBigUInt64LE(BigInt(cdSize), 40);
      rec.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(SIG.locator64, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(at), 8);
      loc.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([rec, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG.eocd, 0);
    end.writeUInt16LE(zip64 ? MAX16 : count, 8);
    end.writeUInt16LE(zip64 ? MAX16 : count, 10);
    end.writeUInt32LE(zip64 ? MAX32 : cdSize, 12);
    end.writeUInt32LE(zip64 ? MAX32 : cdStart, 16);
    await this.write(end);
    return this.offset;
  }
}

// ---------- reader ----------

// Bounds for an untrusted archive: a backup has a few thousand entries, its directory well under a MB.
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;
const MAX_ENTRIES = 200_000;

/** Reads a little-endian u64 as a Number (exact up to 2^53, far beyond any real archive). */
const u64 = (buf, at) => Number(buf.readBigUInt64LE(at));

export class ZipReader {
  /**
   * Opens an archive on disk and reads its central directory.
   * @param {string} file
   * @param {{ maxEntries?: number }} [options]
   * @returns {Promise<ZipReader>}
   */
  static async open(file, { maxEntries = MAX_ENTRIES } = {}) {
    const fh = await open(file, 'r');
    try {
      const reader = new ZipReader(file, fh, (await fh.stat()).size);
      await reader.readDirectory(maxEntries);
      return reader;
    } catch (err) {
      await fh.close();
      throw err;
    }
  }

  constructor(file, fh, size) {
    this.file = file;
    this.fh = fh;
    this.size = size;
    this.entries = [];
  }

  async close() {
    await this.fh.close().catch(() => {});
  }

  async readAt(position, length) {
    if (position < 0 || length < 0 || position + length > this.size) throw new ZipError('ZIP terpotong atau rusak (membaca di luar file).');
    const buf = Buffer.alloc(length);
    const { bytesRead } = await this.fh.read(buf, 0, length, position);
    if (bytesRead !== length) throw new ZipError('ZIP terpotong atau rusak.');
    return buf;
  }

  async readDirectory(maxEntries) {
    // End of central directory: 22 bytes + a comment of up to 64 KB, at the very end.
    const tailLen = Math.min(this.size, 22 + MAX16);
    if (tailLen < 22) throw new ZipError('Bukan file ZIP.');
    const tailStart = this.size - tailLen;
    const tail = await this.readAt(tailStart, tailLen);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG.eocd && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new ZipError('Bukan file ZIP (end of central directory tidak ditemukan).');
    let count = tail.readUInt16LE(at + 10);
    let cdSize = tail.readUInt32LE(at + 12);
    let cdStart = tail.readUInt32LE(at + 16);
    const eocdPos = tailStart + at;
    if (eocdPos >= 20) {
      const loc = await this.readAt(eocdPos - 20, 20);
      if (loc.readUInt32LE(0) === SIG.locator64) {
        const recPos = u64(loc, 8);
        const rec = await this.readAt(recPos, 56);
        if (rec.readUInt32LE(0) !== SIG.eocd64) throw new ZipError('ZIP64 end record rusak.');
        count = u64(rec, 32);
        cdSize = u64(rec, 40);
        cdStart = u64(rec, 48);
      }
    }
    if (count > maxEntries) throw new ZipError(`ZIP berisi terlalu banyak entri (${count}).`);
    if (cdSize > MAX_CENTRAL_DIRECTORY) throw new ZipError('Central directory ZIP terlalu besar.');
    if (cdStart + cdSize > this.size) throw new ZipError('Central directory ZIP rusak.');
    this.dataEnd = cdStart; // every entry's data lies before the central directory
    const cd = await this.readAt(cdStart, cdSize);
    const seen = new Set();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG.central) throw new ZipError('Central directory ZIP rusak.');
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const dosTime = cd.readUInt16LE(p + 12);
      const dosDate = cd.readUInt16LE(p + 14);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      let offset = cd.readUInt32LE(p + 42);
      const end = p + 46 + nameLen + extraLen + commentLen;
      if (end > cd.length) throw new ZipError('Central directory ZIP rusak.');
      const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
      const name = nameBytes.toString(flags & 0x0800 ? 'utf8' : 'latin1');
      let mtime = null;
      // Extra fields: ZIP64 sizes/offset and the extended timestamp.
      for (let x = p + 46 + nameLen; x + 4 <= p + 46 + nameLen + extraLen; ) {
        const tag = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        const body = cd.subarray(x + 4, Math.min(x + 4 + len, p + 46 + nameLen + extraLen));
        if (tag === 0x0001) {
          let q = 0;
          const next = () => {
            if (q + 8 > body.length) throw new ZipError('ZIP64 extra field rusak.');
            const v = u64(body, q);
            q += 8;
            return v;
          };
          if (usize === MAX32) usize = next();
          if (csize === MAX32) csize = next();
          if (offset === MAX32) offset = next();
        } else if (tag === 0x5455 && body.length >= 5 && body[0] & 1) {
          mtime = body.readUInt32LE(1) * 1000;
        }
        x += 4 + len;
      }
      p = end;

      const where = `"${name}"`;
      const host = madeBy >> 8;
      const mode = (external >>> 16) & S_IFMT;
      const isDir = name.endsWith('/') || (host === 3 && mode === S_IFDIR) || (host === 0 && external & 0x10);
      if (host === 3 && mode === S_IFLNK) throw new ZipError(`Entri ${where} adalah symlink: ditolak.`);
      if (flags & 0x0001) throw new ZipError(`Entri ${where} terenkripsi: tidak didukung.`);
      if (method !== 0 && method !== 8) throw new ZipError(`Entri ${where} memakai kompresi yang tidak didukung (${method}).`);
      const why = unsafeEntryName(name);
      if (why) throw new ZipError(`Entri ${where} ditolak: ${why}.`);
      const key = name.replace(/\/$/, '').toLowerCase(); // case-insensitive: one file on Windows
      if (seen.has(key)) throw new ZipError(`Entri ${where} muncul dua kali.`);
      seen.add(key);
      if (offset + 30 > this.dataEnd || offset + csize > this.dataEnd) throw new ZipError(`Entri ${where} menunjuk di luar data ZIP.`);
      if (mtime == null) {
        const d = new Date(1980 + (dosDate >> 9), ((dosDate >> 5) & 15) - 1, dosDate & 31, dosTime >> 11, (dosTime >> 5) & 63, (dosTime & 31) * 2);
        mtime = Number.isNaN(d.getTime()) ? null : d.getTime();
      }
      // The time is the archive's claim: never in the future (it would look like the newest/active file).
      if (!Number.isFinite(mtime) || mtime <= 0) mtime = null;
      else mtime = Math.min(mtime, Date.now());
      this.entries.push({ name, isDir, method, crc, csize, usize, offset, mtime });
    }
  }

  /** The verified uncompressed bytes of `entry`, as a stream into `sink` (CRC/size checked at the end). */
  async pipeTo(entry, sink) {
    const local = await this.readAt(entry.offset, 30);
    if (local.readUInt32LE(0) !== SIG.local) throw new ZipError(`Header lokal "${entry.name}" rusak.`);
    const dataStart = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (dataStart + entry.csize > this.dataEnd) throw new ZipError(`Data "${entry.name}" di luar ZIP.`);
    if (entry.method === 0 && entry.csize !== entry.usize) throw new ZipError(`Ukuran "${entry.name}" tidak cocok.`);
    const raw = entry.csize ? createReadStream(this.file, { start: dataStart, end: dataStart + entry.csize - 1 }) : Readable.from([]);
    let crc = 0;
    let size = 0;
    const check = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        // Never write more than the directory promised (zip bombs, lying headers).
        if (size > entry.usize) return cb(new ZipError(`Isi "${entry.name}" lebih besar dari yang tercatat.`));
        crc = crc32(chunk, crc);
        cb(null, chunk);
      },
      flush(cb) {
        if (size !== entry.usize) cb(new ZipError(`Ukuran "${entry.name}" tidak cocok.`));
        else if (crc !== entry.crc) cb(new ZipError(`CRC "${entry.name}" salah: file backup rusak.`));
        else cb();
      },
    });
    const stages = entry.method === 8 && entry.csize ? [raw, zlib.createInflateRaw(), check, sink] : [raw, check, sink];
    try {
      await pipeline(...stages);
    } catch (err) {
      if (err instanceof ZipError) throw err;
      // Only zlib's own errors mean corrupt data; file-system errors (EBUSY, ENOSPC…) go up unchanged.
      if (typeof err?.code === 'string' && err.code.startsWith('Z_')) throw new ZipError(`Data "${entry.name}" rusak (${err.message}).`);
      throw err;
    }
  }

  /** Extracts `entry` to the file `dest` (created/overwritten). */
  async extractTo(entry, dest) {
    await this.pipeTo(entry, createWriteStream(dest));
  }

  /** The entry's bytes in memory, for small entries only (refused above `max`). */
  async read(entry, max = 64 * 1024 * 1024) {
    if (entry.usize > max) throw new ZipError(`"${entry.name}" terlalu besar (${entry.usize} byte).`);
    const chunks = [];
    await this.pipeTo(
      entry,
      new Writable({
        write(chunk, _enc, cb) {
          chunks.push(chunk);
          cb();
        },
      }),
    );
    return Buffer.concat(chunks);
  }
}
