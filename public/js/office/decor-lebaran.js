// Lebaran scenery (pure drawing, same contract as decor.js):
//   paintStatic – ketupat and little gold stars hanging from strings on the walls, a crescent-and-star ornament
//   furniture   – lentera (floor lanterns) and pelita oil lamps with flickering flames, jars of kue kering on the
//                 pantry tables, a beduk on its stand
//   overlay     – none (the windows carry the movement)
//   lights      – warm golden glows from the lanterns and lamps
//   sky         – takbiran night: crescent moon and star, a mosque silhouette, small fireworks now and then
import { hash, rect } from './decor.js';

const GOLD = '#e0b84a';
const GOLD_LIGHT = '#ffd98a';
const LEAF = '#3f9b4f';
const LEAF_DARK = '#2c7a3b';
const WEAVE = '#d9c45a';

const LANTERNS = [
  [14, 168],
  [296, 132],
  [388, 250], // between the meeting room and the pantry
  [24, 338],
  [596, 134], // Lead office
];
const PELITA = [
  [10, 111, 157],
  [16, 111, 157],
  [461, 265, 285], // pantry counter
  [467, 265, 285],
];
// jars of kue kering: [x, tabletop y, sort y, cookie colour]
const JARS = [
  [607, 304, 318, '#e9a23b'], // cafe table
  [613, 304, 318, '#c98a4a'],
  [597, 212, 223, '#e9a23b'], // lounge coffee table (left of the ♪ radio)
  [452, 265, 285, '#c98a4a'], // pantry counter
];
const BEDUK = { x: 620, y: 132 }; // in the Lead's corner office

/** Woven ketupat (5×5 diamond) hanging from (x, y) by a short string. */
function ketupat(r, x, y, len) {
  r(x, y, 1, len, '#8a6a3c');
  const top = y + len;
  [1, 3, 5, 3, 1].forEach((w, i) => r(x - (w - 1) / 2, top + i, w, 1, i % 2 ? LEAF_DARK : LEAF));
  r(x, top + 1, 1, 3, WEAVE);
  r(x - 1, top + 2, 3, 1, WEAVE);
  r(x - 1, top + 5, 1, 2, LEAF);
  r(x + 1, top + 5, 1, 2, LEAF_DARK);
}

function star(r, x, y, c) {
  r(x, y - 1, 1, 3, c);
  r(x - 1, y, 3, 1, c);
}

function garland(r, x0, x1) {
  const sagAt = (x) => 5 + Math.round(Math.sin((Math.PI * (x - x0)) / (x1 - x0)) * 3);
  for (let x = x0; x <= x1; x++) r(x, sagAt(x), 1, 1, '#8a6a3c');
  let i = 0;
  for (let x = x0 + 4; x < x1 - 2; x += 8, i++) {
    if (i % 2) star(r, x, sagAt(x) + 4, GOLD);
    else ketupat(r, x, sagAt(x) + 1, 3 + (i % 4 ? 0 : 2));
  }
}

function paintStatic(g) {
  const r = rect(g);
  garland(r, 36, 96);
  garland(r, 224, 300);
  garland(r, 400, 472);
  // crescent and star ornament between the left window and the whiteboard
  [3, 5, 6, 6, 6, 5, 3].forEach((w, i) => r(94 - (w - 1) / 2, 12 + i, w, 1, GOLD));
  [3, 5, 5, 5, 5, 3].forEach((w, i) => r(96 - (w - 1) / 2, 12 + i, w, 1, '#efe5d4'));
  star(r, 97, 15, GOLD_LIGHT);
}

// ---------- live items ----------

/** Lentera: gold frame, glass with a flame, a ring on top. (x, y) = foot. */
function drawLantern(g, t, x, y, i) {
  const r = rect(g);
  const k = hash(Math.floor(t / 110) + i * 13);
  r(x - 3, y, 7, 1, 'rgba(0,0,0,.25)');
  r(x - 3, y - 1, 7, 1, GOLD);
  r(x - 2, y - 8, 5, 7, 'rgba(255,236,170,.55)');
  r(x - 3, y - 8, 1, 7, GOLD);
  r(x + 3, y - 8, 1, 7, GOLD);
  r(x - 3, y - 9, 7, 1, GOLD);
  r(x - 2, y - 10, 5, 1, '#b8902f');
  r(x - 1, y - 11, 3, 1, GOLD);
  r(x, y - 12, 1, 1, GOLD);
  r(x, y - 5 - (k > 0.4 ? 1 : 0), 1, 2 + (k > 0.4 ? 1 : 0), k > 0.6 ? '#ffd166' : '#ff9f43');
}

/** Pelita: small clay oil lamp with a flame. */
function drawPelita(g, t, x, y, i) {
  const r = rect(g);
  r(x - 1, y - 2, 4, 2, '#a5623a');
  r(x - 1, y - 2, 4, 1, '#c27a4c');
  r(x + 3, y - 3, 1, 1, '#a5623a');
  const k = hash(Math.floor(t / 90) + i * 7);
  r(x + 3 + (k > 0.8 ? 1 : 0) - 1, y - 4 - (k > 0.35 ? 1 : 0), 1, k > 0.35 ? 2 : 1, k > 0.5 ? '#ffd166' : '#ff9f43');
}

/** Toples kue kering: glass jar with a red lid and golden cookies. */
function drawJar(g, x, y, cookie) {
  const r = rect(g);
  r(x, y - 7, 5, 1, '#c8102e');
  r(x, y - 6, 5, 6, '#d8eef4');
  r(x + 4, y - 6, 1, 6, '#b5d3dc');
  r(x + 1, y - 4, 1, 1, cookie);
  r(x + 3, y - 4, 1, 1, cookie);
  r(x + 1, y - 2, 3, 2, cookie);
  r(x + 2, y - 3, 1, 1, cookie);
}

/** Beduk: big barrel drum lying on a wooden stand, drumhead facing the viewer. */
function drawBeduk(g) {
  const r = rect(g);
  const { x, y } = BEDUK;
  r(x - 12, y - 1, 25, 2, 'rgba(0,0,0,.22)');
  r(x - 11, y - 6, 2, 6, '#5e3a1e');
  r(x + 10, y - 6, 2, 6, '#5e3a1e');
  r(x - 12, y - 7, 25, 2, '#7a4e2b');
  // barrel
  r(x - 10, y - 20, 21, 13, '#8a5a32');
  r(x - 10, y - 20, 21, 2, '#a36c3e');
  r(x - 10, y - 9, 21, 2, '#6b4426');
  for (const dx of [-6, 0, 6]) r(x + dx, y - 20, 1, 13, '#6b4426');
  // drumhead
  r(x + 7, y - 19, 5, 11, '#e6d2a8');
  r(x + 11, y - 18, 1, 9, '#c8b285');
  for (const dy of [-18, -14, -10]) r(x + 6, y + dy, 1, 1, GOLD);
  // stick resting on top
  r(x - 4, y - 22, 9, 1, '#5e3a1e');
  r(x + 5, y - 23, 2, 2, '#e6d2a8');
}

function furniture() {
  const items = [];
  LANTERNS.forEach(([x, y], i) => items.push({ y, draw: (g, t) => drawLantern(g, t, x, y, i) }));
  PELITA.forEach(([x, y, sortY], i) => items.push({ y: sortY, draw: (g, t) => drawPelita(g, t, x, y, i) }));
  JARS.forEach(([x, y, sortY, c]) => items.push({ y: sortY, draw: (g) => drawJar(g, x, y, c) }));
  items.push({ y: BEDUK.y, draw: (g) => drawBeduk(g) });
  return items;
}

function lights(t) {
  const out = [];
  LANTERNS.forEach(([x, y], i) => out.push({ x, y: y - 5, radius: 26 + hash(Math.floor(t / 110) + i * 13) * 4, color: 'rgba(255,196,90,.30)' }));
  PELITA.forEach(([x, y], i) => out.push({ x: x + 2, y: y - 4, radius: 15 + hash(Math.floor(t / 90) + i * 7) * 4, color: 'rgba(255,190,90,.28)' }));
  return out;
}

function overlay() {}

// ---------- window view: takbiran night ----------

const FIREWORK = ['#ffd166', '#7bd88f', '#ff8fab', '#8fd3ff'];

function sky(r, s, wx, t) {
  r(wx + 2, 11, 44, 11, s.top);
  r(wx + 2, 22, 44, 11, s.bottom);
  for (let i = 0; i < 6; i++) if (hash(i + wx + Math.floor(t / 1100)) > 0.35) r(wx + 4 + i * 7, 13 + ((i * 5) % 9), 1, 1, s.star);
  if (wx === 40) {
    // crescent: a disc with an offset disc of sky cut out of it, plus a star
    [3, 5, 7, 7, 7, 5, 3].forEach((w, i) => r(wx + 33 - (w - 1) / 2, 12 + i, w, 1, s.moon));
    [3, 5, 7, 7, 7, 5].forEach((w, i) => r(wx + 35 - (w - 1) / 2, 11 + i, w, 1, s.top));
    star(r, wx + 41, 14, s.moon);
  } else {
    // mosque silhouette with lit windows
    const m = s.silhouette;
    [4, 8, 10, 12].forEach((w, i) => r(wx + 16 - w / 2, 20 + i, w, 1, m));
    r(wx + 16, 18, 1, 2, s.moon);
    r(wx + 7, 24, 18, 9, m);
    r(wx + 31, 17, 3, 16, m);
    r(wx + 32, 15, 1, 2, m);
    r(wx + 30, 20, 5, 1, m);
    for (const dx of [10, 15, 20]) r(wx + dx, 27, 1, 2, '#ffd166');
    r(wx + 2, 31, 44, 2, m);
  }
  // a small firework burst now and then (each window on its own rhythm)
  const period = wx === 40 ? 4200 : 5300;
  const cycle = Math.floor((t + wx * 37) / period);
  const age = ((t + wx * 37) % period) / 1200;
  if (age < 1) {
    const cx = wx + 8 + Math.floor(hash(cycle + wx) * 24);
    const cy = 14 + Math.floor(hash(cycle * 3 + wx) * 5);
    const rad = 1 + Math.round(age * 4);
    const color = FIREWORK[Math.floor(hash(cycle * 7 + wx) * FIREWORK.length)];
    for (let a = 0; a < 8; a++) {
      const px = cx + Math.round(Math.cos((a * Math.PI) / 4) * rad);
      const py = cy + Math.round(Math.sin((a * Math.PI) / 4) * rad);
      if (px >= wx + 2 && px <= wx + 45 && py >= 11 && py <= 32 && (age < 0.7 || a % 2)) r(px, py, 1, 1, color);
    }
    if (age < 0.3) r(cx, cy, 1, 1, '#ffffff');
  }
}

export const LEBARAN_DECOR = { paintStatic, furniture, overlay, lights, sky };
