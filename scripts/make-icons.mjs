// Generates the Adhitron app icons from assets/adhitron-logo.png, without dependencies:
//   node scripts/make-icons.mjs   → public/icons/*.png + icon.svg, assets/icon.png + icon.ico
// test/icons.test.mjs checks the committed files match this generator.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Master artwork: 720×720, 8-bit RGBA, non-interlaced, fully opaque. */
export const SOURCE = path.join(ROOT, 'assets', 'adhitron-logo.png');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------- minimal PNG decoder (8-bit RGBA, non-interlaced, filters 0–4) ----------

/**
 * Decodes the master artwork. Only the format the source ships in is supported, so
 * anything else fails loudly instead of producing subtly wrong icons.
 * @returns {{ width: number, height: number, data: Buffer }} RGBA rows, no padding.
 */
export function decodePng(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('decodePng: not a PNG file');
  const chunks = [];
  for (let o = 8; o + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    chunks.push({ type, data: buf.subarray(o + 8, o + 8 + length) });
    o += 12 + length;
    if (type === 'IEND') break;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length !== 13) throw new Error('decodePng: missing IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const [depth, colourType, compression, filter, interlace] = ihdr.data.subarray(8, 13);
  if (depth !== 8 || colourType !== 6 || compression !== 0 || filter !== 0 || interlace !== 0) {
    throw new Error(
      `decodePng: unsupported PNG (depth ${depth}, colour type ${colourType}, interlace ${interlace}); ` +
        'expected 8-bit RGBA, non-interlaced',
    );
  }
  const idat = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  if (!idat.length) throw new Error('decodePng: no IDAT data');
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error('decodePng: truncated image data');

  const data = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const kind = raw[start];
    const line = raw.subarray(start + 1, start + 1 + stride);
    const row = data.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0; // left
      const b = prev[i]; // up
      const c = i >= bpp ? prev[i - bpp] : 0; // up-left
      let value = line[i];
      switch (kind) {
        case 0: // none
          break;
        case 1: // sub
          value += a;
          break;
        case 2: // up
          value += b;
          break;
        case 3: // average
          value += (a + b) >> 1;
          break;
        case 4: {
          // paeth
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`decodePng: unsupported filter ${kind} on row ${y}`);
      }
      row[i] = value & 0xff;
    }
    prev = row;
  }
  return { width, height, data };
}

// ---------- tiny PNG encoder (RGBA, no filtering) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- artwork → icon pixels ----------

let artwork = null;
function logo() {
  artwork ??= decodePng(readFileSync(SOURCE));
  return artwork;
}

/** Background colour, sampled from the artwork's top-left corner (#17181e). */
function background(src) {
  return [src.data[0], src.data[1], src.data[2]];
}

/**
 * Box-filter downscale: every output pixel is the area average of its source
 * rectangle, with fractional edge coverage so sizes like 720→180 stay exact.
 * The artwork is opaque, so plain (non-premultiplied) averaging is lossless here.
 */
export function resizeBox(src, size) {
  const { width: sw, height: sh, data } = src;
  const out = Buffer.alloc(size * size * 4);
  const scale = sw / size; // artwork is square
  for (let y = 0; y < size; y++) {
    const y0 = y * scale;
    const y1 = y0 + scale;
    const syEnd = Math.min(sh, Math.ceil(y1));
    for (let x = 0; x < size; x++) {
      const x0 = x * scale;
      const x1 = x0 + scale;
      const sxEnd = Math.min(sw, Math.ceil(x1));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let sy = Math.floor(y0); sy < syEnd; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < sxEnd; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (sy * sw + sx) * 4;
          r += data[i] * w;
          g += data[i + 1] * w;
          b += data[i + 2] * w;
          a += data[i + 3] * w;
          weight += w;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / weight);
      out[o + 1] = Math.round(g / weight);
      out[o + 2] = Math.round(b / weight);
      out[o + 3] = Math.round(a / weight);
    }
  }
  return out;
}

/**
 * @param size   output width/height in px
 * @param art    fraction of the square the artwork covers (maskable/apple safe zone)
 * @param opaque fill the margin with the artwork's background colour instead of transparency
 */
export function iconPng(size, { art = 1, opaque = true } = {}) {
  const source = logo();
  const inner = Math.max(1, Math.min(size, Math.round(size * art)));
  const pixels = resizeBox(source, inner);
  const rgba = Buffer.alloc(size * size * 4);
  if (opaque) {
    const [r, g, b] = background(source);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  const offset = Math.floor((size - inner) / 2);
  for (let y = 0; y < inner; y++) {
    pixels.copy(rgba, ((offset + y) * size + offset) * 4, y * inner * 4, (y + 1) * inner * 4);
  }
  return encodePng(size, rgba);
}

/**
 * Hand-drawn vector approximation of the logo on a 64×64 grid (the 720 px artwork
 * ÷ 11.25), so it stays crisp from 16 px favicons to the 24 px header mark.
 * Colours reuse the design tokens: --accent #d97757, --accent-2 #f0a07f,
 * --accent-solid #b85a3c, --text #ece9e4, --surface-2 #20222b.
 */
export function iconSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    '<rect width="64" height="64" rx="14" fill="#17181e"/>',
    '<g fill="none" stroke="#d97757" stroke-width="1.5">',
    '<ellipse cx="32" cy="32" rx="18.7" ry="6.7"/>',
    '<ellipse cx="32" cy="32" rx="18.7" ry="6.7" transform="rotate(60 32 32)"/>',
    '<ellipse cx="32" cy="32" rx="18.7" ry="6.7" transform="rotate(-60 32 32)"/>',
    '</g>',
    '<circle cx="41.4" cy="15.8" r="2.9" fill="#f0a07f" opacity=".14"/>',
    '<circle cx="50.7" cy="32" r="3.2" fill="#f3e6dc" opacity=".14"/>',
    '<circle cx="41.4" cy="48.2" r="2.4" fill="#b85a3c" opacity=".16"/>',
    '<circle cx="41.4" cy="15.8" r="1.9" fill="#f0a07f"/>',
    '<circle cx="50.7" cy="32" r="1.9" fill="#f3e6dc"/>',
    '<circle cx="41.4" cy="48.2" r="1.4" fill="#b85a3c"/>',
    '<rect x="26.8" y="26.8" width="10.4" height="10.4" rx="2.4" fill="#20222b" stroke="#d97757" stroke-width="1"/>',
    '<path d="M29.2 29.3 32 32l-2.8 2.7" fill="none" stroke="#d97757" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>',
    '<rect x="32.4" y="34" width="3.1" height="0.9" rx="0.45" fill="#f3e6dc"/>',
    '</svg>',
    '',
  ].join('\n');
}

/** Windows icon entries; 0 in the directory means 256. */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

/** Multi-size .ico; every entry is PNG-compressed (supported since Windows Vista). */
export function iconIco() {
  const images = ICO_SIZES.map((size) => iconPng(size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4); // image count
  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;
  images.forEach((png, i) => {
    const at = i * 16;
    const size = ICO_SIZES[i];
    directory[at] = size >= 256 ? 0 : size;
    directory[at + 1] = size >= 256 ? 0 : size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images]);
}

export const ICONS = {
  'icon-192.png': () => iconPng(192),
  'icon-512.png': () => iconPng(512),
  'icon-maskable-512.png': () => iconPng(512, { art: 0.7 }),
  'apple-touch-icon.png': () => iconPng(180, { art: 0.8 }),
  'icon.svg': () => iconSvg(),
};

/** Desktop/installer icons, generated from the same artwork. */
export const ASSETS = {
  'icon.png': () => iconPng(512),
  'icon.ico': () => iconIco(),
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = [
    [path.join(ROOT, 'public', 'icons'), ICONS, 'public/icons'],
    [path.join(ROOT, 'assets'), ASSETS, 'assets'],
  ];
  for (const [dir, files, label] of targets) {
    mkdirSync(dir, { recursive: true });
    for (const [name, make] of Object.entries(files)) {
      const bytes = make();
      writeFileSync(path.join(dir, name), bytes);
      console.log(`${label}/${name}  ${bytes.length} bytes`);
    }
  }
}
