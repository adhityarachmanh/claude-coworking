import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qrMatrix, qrSvg } from '../public/js/qr.js';

// Format information for error correction level M, masks 0–7 (ISO/IEC 18004, Table C.1).
const FORMAT_M = [0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011, 0b100010111111001, 0b100000011001110, 0b100111110010111, 0b100101010100000];

function readFormatBits(m) {
  // Copy next to the top-left finder: bits 0–5 down column 8, then (8,7), (8,8), (7,8), bits 9–14 along row 8.
  const bits = [];
  for (let y = 0; y <= 5; y++) bits.push(m[y][8]);
  bits.push(m[7][8], m[8][8], m[8][7]);
  for (let x = 5; x >= 0; x--) bits.push(m[8][x]);
  return bits.reduce((acc, on, i) => acc | ((on ? 1 : 0) << i), 0);
}

test('format bits match the QR standard for every mask', () => {
  for (let mask = 0; mask < 8; mask++) {
    assert.equal(readFormatBits(qrMatrix('http://192.168.1.10:4317/pair?k=abc', { mask })), FORMAT_M[mask], `mask ${mask}`);
  }
});

test('size grows with content and finder patterns are in place', () => {
  assert.equal(qrMatrix('HELLO').length, 21); // version 1
  assert.equal(qrMatrix('x'.repeat(60)).length, 33); // version 4
  assert.equal(qrMatrix('x'.repeat(200)).length, 57); // version 10
  const m = qrMatrix('finder');
  const finder = [[1, 1, 1, 1, 1, 1, 1], [1, 0, 0, 0, 0, 0, 1], [1, 0, 1, 1, 1, 0, 1], [1, 0, 1, 1, 1, 0, 1], [1, 0, 1, 1, 1, 0, 1], [1, 0, 0, 0, 0, 0, 1], [1, 1, 1, 1, 1, 1, 1]];
  const at = (ox, oy) => finder.every((row, y) => row.every((v, x) => m[oy + y][ox + x] === Boolean(v)));
  assert.ok(at(0, 0) && at(m.length - 7, 0) && at(0, m.length - 7));
  assert.throws(() => qrMatrix('x'.repeat(300)), /terlalu panjang/);
});

test('svg output is deterministic and has a quiet zone', () => {
  const text = 'http://10.0.0.2:4317/pair?k=key';
  const a = qrSvg(text);
  assert.equal(a, qrSvg(text));
  const size = qrMatrix(text).length + 8; // 4-module quiet zone on each side
  assert.match(a, new RegExp(`viewBox="0 0 ${size} ${size}"`));
});
