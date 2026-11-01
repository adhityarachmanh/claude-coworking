// 17 Agustus (HUT RI) scenery (pure drawing, same contract as decor.js):
//   paintStatic – rows of small red-white flags on the walls, a red-white gapura around the door
//   furniture   – the Merah Putih on a stand in the lead's office (waving), umbul-umbul by the pantry,
//                 a kerupuk line for lomba makan kerupuk, a mini panjat pinang with prizes
//   overlay     – none
//   lights      – none (bright daytime: sun beams come from the theme's light settings)
//   sky         – sunny day: drifting clouds, a layangan (kite) swaying in the right window
import { rect } from './decor.js';

const RED = '#d7182a';
const RED_DARK = '#a8101f';
const WHITE = '#f6f3ee';
const WHITE_SHADE = '#d9d4cc';

const FLAG = { x: 318, y: 96 };
const UMBUL = [
  [436, 124],
  [436, 196],
];
const KERUPUK = { x0: 338, x1: 394, y: 208, base: 236 };
const PINANG = { x: 418, y: 280 };

/** A string of small rectangular red-white flags sagging between x0 and x1. */
function flagLine(r, x0, x1) {
  const sagAt = (x) => 5 + Math.round(Math.sin((Math.PI * (x - x0)) / (x1 - x0)) * 3);
  for (let x = x0; x <= x1; x++) r(x, sagAt(x), 1, 1, '#4a3a30');
  for (let x = x0 + 2; x + 4 <= x1; x += 6) {
    const y = sagAt(x + 2) + 1;
    r(x, y, 4, 2, RED);
    r(x, y + 2, 4, 2, WHITE);
  }
}

function paintStatic(g) {
  const r = rect(g);
  flagLine(r, 36, 96);
  flagLine(r, 224, 300);
  flagLine(r, 444, 512);
  // gapura: red-white striped pillars either side of the door and a beam across the top
  for (const px of [0, 32]) {
    for (let y = 4; y < 48; y += 4) r(px, y, 4, 4, (y / 4) % 2 ? RED : WHITE);
    r(px + 3, 4, 1, 44, 'rgba(0,0,0,.15)');
  }
  r(0, 0, 36, 4, RED);
  r(0, 2, 36, 1, WHITE);
  for (const px of [1, 33]) r(px, 0, 2, 1, '#ffd23f');
}

// ---------- live items ----------

/** The Merah Putih on a stand, waving: each column is offset by a slow sine. */
function drawFlag(g, t) {
  const r = rect(g);
  const { x, y } = FLAG;
  r(x - 4, y - 1, 9, 2, '#5e4a3a');
  r(x - 2, y - 3, 5, 2, '#7a6248');
  r(x, y - 44, 1, 41, '#c9cdd2');
  r(x, y - 46, 1, 2, '#ffd23f');
  for (let i = 0; i < 15; i++) {
    const dy = Math.round(Math.sin(t / 380 - i * 0.55) * 1.2);
    r(x + 1 + i, y - 44 + dy, 1, 5, i > 11 ? RED_DARK : RED);
    r(x + 1 + i, y - 39 + dy, 1, 5, i > 11 ? WHITE_SHADE : WHITE);
  }
}

/** Umbul-umbul: tall pole with a long, tapering red-white banner rippling down. */
function drawUmbul(g, t, x, y, i) {
  const r = rect(g);
  r(x, y - 52, 1, 52, '#c9b458');
  r(x - 1, y - 54, 3, 2, '#ffd23f');
  for (let k = 0; k < 40; k++) {
    const sway = Math.round(Math.sin(t / 450 - k * 0.25 + i) * (k / 20));
    const w = k < 24 ? 3 : k < 34 ? 2 : 1; // tapering tail
    r(x + 1 + sway, y - 51 + k, w, 1, RED);
    r(x + 1 + w + sway, y - 51 + k, w, 1, WHITE);
  }
}

/** Kerupuk line: two poles, a rope and three crackers swinging at head height. */
function drawKerupuk(g, t) {
  const r = rect(g);
  const { x0, x1, y, base } = KERUPUK;
  for (const x of [x0, x1]) {
    r(x, y - 2, 1, base - y + 2, '#c9b458');
    r(x - 2, base - 1, 5, 1, '#7a6248');
  }
  r(x0, y, x1 - x0, 1, '#e8dcc0');
  [352, 366, 380].forEach((cx, i) => {
    const swing = Math.round(Math.sin(t / 500 + i * 1.7) * 1);
    r(cx, y + 1, 1, 3, '#e8dcc0');
    const kx = cx + swing;
    [4, 6, 6, 6, 4].forEach((w, row) => r(kx - w / 2, y + 4 + row, w, 1, '#f3e2b3'));
    r(kx - 2, y + 5, 1, 1, '#e0a35a');
    r(kx + 1, y + 7, 1, 1, '#e0a35a');
    r(kx - 1, y + 8, 1, 1, '#e0a35a');
  });
}

/** Mini panjat pinang: greased pole, a prize ring on top with dangling gifts, a flag on the tip. */
function drawPinang(g, t) {
  const r = rect(g);
  const { x, y } = PINANG;
  r(x - 5, y - 1, 11, 2, 'rgba(0,0,0,.22)');
  r(x - 1, y - 52, 3, 52, '#9a6a3c');
  r(x, y - 52, 1, 52, '#c99a62');
  r(x - 3, y - 2, 7, 2, '#7a4e2b');
  // prize ring
  r(x - 9, y - 50, 19, 2, '#c8102e');
  r(x - 9, y - 49, 19, 1, WHITE);
  const prizes = [[-8, '#3d85c6', 4], [-3, '#ffd23f', 5], [3, '#2e8b57', 4], [7, '#e64980', 3]];
  prizes.forEach(([dx, c, len], i) => {
    const sway = Math.round(Math.sin(t / 600 + i) * 0.8);
    r(x + dx, y - 47, 1, len, '#e8dcc0');
    r(x + dx - 1 + sway, y - 47 + len, 3, 3, c);
  });
  // flag on the tip
  r(x, y - 58, 1, 6, '#c9cdd2');
  const wave = Math.floor(t / 400) % 2;
  r(x + 1, y - 58 + wave, 5, 2, RED);
  r(x + 1, y - 56 + wave, 5, 2, WHITE);
}

function furniture() {
  const items = [
    { y: FLAG.y, draw: (g, t) => drawFlag(g, t) },
    { y: KERUPUK.base, draw: (g, t) => drawKerupuk(g, t) },
    { y: PINANG.y, draw: (g, t) => drawPinang(g, t) },
  ];
  UMBUL.forEach(([x, y], i) => items.push({ y, draw: (g, t) => drawUmbul(g, t, x, y, i) }));
  return items;
}

const lights = () => [];
function overlay() {}

// ---------- window view: a sunny day ----------

function sky(r, s, wx, t) {
  r(wx + 2, 11, 44, 11, s.top);
  r(wx + 2, 22, 44, 11, s.bottom);
  if (wx === 40) {
    [3, 5, 5, 5, 3].forEach((w, i) => r(wx + 38 - (w - 1) / 2, 13 + i, w, 1, s.sun));
  }
  const drift = ((t / 260 + wx * 3) % 70) - 14;
  for (const [ox, oy, w] of [[0, 15, 12], [26, 25, 9]]) {
    const cx = wx + 2 + Math.round((drift + ox) % 58);
    const x = Math.max(wx + 2, cx);
    const right = Math.min(wx + 46, cx + w);
    if (right > x) r(x, oy, right - x, 3, s.cloud);
    if (right - 2 > x + 2) r(x + 2, oy - 1, right - x - 4, 1, s.cloud);
  }
  if (wx === 252) {
    // layangan: a red-white diamond kite with a tail, swaying on its string
    const sway = Math.round(Math.sin(t / 700) * 2);
    const kx = wx + 30 + sway;
    const ky = 14 + Math.round(Math.sin(t / 900) * 1);
    [1, 3, 5].forEach((w, i) => r(kx - (w - 1) / 2, ky + i, w, 1, '#d7182a'));
    [3, 1].forEach((w, i) => r(kx - (w - 1) / 2, ky + 3 + i, w, 1, '#f6f3ee'));
    for (let k = 0; k < 4; k++) r(kx + (k % 2), ky + 5 + k, 1, 1, '#ffd23f');
    for (let k = 1; k < 7; k++) r(kx - k * 2, ky + 4 + k * 2, 1, 1, '#e8e2d4'); // string down to the street
  }
}

export const AGUSTUS_DECOR = { paintStatic, furniture, overlay, lights, sky };
