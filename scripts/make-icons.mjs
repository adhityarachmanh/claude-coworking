// Generates the Adhit Office app icons (pixel-art office building) without dependencies:
//   node scripts/make-icons.mjs   → public/icons/*.png + icon.svg
// test/icons.test.mjs checks the committed files match this generator.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

// 16×16 sprite. '.' = transparent (rounded corners), o = brand orange, w = wall, y = lit window,
// d = dark window, b = door, g = ground.
export const SPRITE = [
  '..oooooooooooo..',
  '.oooooooooooooo.',
  'oooooooooooooooo',
  'oooowwwwwwwwoooo',
  'oooowyywwddwoooo',
  'oooowyywwddwoooo',
  'oooowwwwwwwwoooo',
  'oooowddwwyywoooo',
  'oooowddwwyywoooo',
  'oooowwwwwwwwoooo',
  'oooowwwbbwwwoooo',
  'oooowwwbbwwwoooo',
  'oooowwwbbwwwoooo',
  'ooggggggggggggoo',
  '.oooooooooooooo.',
  '..oooooooooooo..',
];
const COLORS = {
  o: [0xd9, 0x77, 0x57],
  w: [0xff, 0xf3, 0xe8],
  y: [0xff, 0xd3, 0x8a],
  d: [0x5a, 0x3b, 0x2d],
  b: [0x5a, 0x3b, 0x2d],
  g: [0xb8, 0x5f, 0x42],
};

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
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param size   output width/height in px
 * @param opaque fill the whole square (iOS home screen, maskable): no transparent corners
 * @param art    fraction of the square the 16×16 sprite covers (maskable icons keep a safe zone)
 */
export function iconPng(size, { opaque = false, art = 1 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = Math.floor((size * art) / 16);
  const offset = Math.floor((size - scale * 16) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x - offset) / scale);
      const sy = Math.floor((y - offset) / scale);
      const inside = sx >= 0 && sy >= 0 && sx < 16 && sy < 16;
      let key = inside ? SPRITE[sy][sx] : opaque ? 'o' : '.';
      if (key === '.' && opaque) key = 'o';
      if (key === '.') continue; // transparent
      const i = (y * size + x) * 4;
      [rgba[i], rgba[i + 1], rgba[i + 2]] = COLORS[key];
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, rgba);
}

/** Same sprite as crisp SVG rects (favicon, header logo). */
export function iconSvg() {
  const hex = (key) => `#${COLORS[key].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const rects = [];
  SPRITE.forEach((row, y) => {
    // Merge horizontal runs of one colour to keep the file small.
    for (let x = 0; x < 16; ) {
      const key = row[x];
      let end = x;
      while (end < 16 && row[end] === key) end++;
      if (key !== '.') rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${hex(key)}"/>`);
      x = end;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects.join('')}</svg>\n`;
}

export const ICONS = {
  'icon-192.png': () => iconPng(192),
  'icon-512.png': () => iconPng(512),
  'icon-maskable-512.png': () => iconPng(512, { opaque: true, art: 0.7 }),
  'apple-touch-icon.png': () => iconPng(180, { opaque: true, art: 0.8 }),
  'icon.svg': () => iconSvg(),
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
  mkdirSync(dir, { recursive: true });
  for (const [name, make] of Object.entries(ICONS)) {
    writeFileSync(path.join(dir, name), make());
    console.log(`public/icons/${name}`);
  }
}
