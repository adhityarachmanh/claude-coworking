// Natal scenery (pure drawing, same contract as decor.js):
//   paintStatic – light-string wires on the walls, a garland over the whiteboard, snow on the window sills,
//                 stockings under the left window, a wreath on the pantry wall
//   furniture   – a twinkling Christmas tree with presents underneath, red candles with holly
//   overlay     – the wall light-strings blink in turns
//   lights      – warm glows: tree, candles, light-strings
//   sky         – snowy evening in the windows: pine trees, snow on the ground, falling flakes
import { hash, rect } from './decor.js';

const BULBS = ['#ff5a5f', '#ffd23f', '#5ad1ff', '#7bd88f', '#ff9f43'];
const WIRES = [
  [36, 96],
  [224, 300],
  [444, 512],
];
const TREE = { x: 418, y: 274 };
const GIFTS = [
  [404, 280, 7, 5, '#c8102e', '#ffd23f'],
  [425, 281, 8, 6, '#2e6fbf', '#f4f1ea'],
  [413, 284, 9, 5, '#2e8b57', '#e5383b'],
];
const CANDLES = [
  [10, 111, 157],
  [15, 111, 157],
  [500, 43, 64],
  [477, 141, 160],
];

const sagAt = (x0, x1, x) => 5 + Math.round(Math.sin((Math.PI * (x - x0)) / (x1 - x0)) * 3);

/** Positions of the bulbs on every wire (shared by the static wire and the blinking overlay). */
const BULB_SPOTS = WIRES.flatMap(([x0, x1]) => {
  const out = [];
  for (let x = x0 + 3; x < x1 - 1; x += 6) out.push([x, sagAt(x0, x1, x) + 1]);
  return out;
});

function paintStatic(g) {
  const r = rect(g);
  // light-string wires (bulbs are drawn live by the overlay)
  for (const [x0, x1] of WIRES) for (let x = x0; x <= x1; x++) r(x, sagAt(x0, x1, x), 1, 1, '#24352a');
  // garland with berries along the top of the whiteboard frame
  r(100, 5, 122, 2, '#2e7d4f');
  for (let x = 101; x < 222; x += 4) r(x, 4 + (x % 8 === 1 ? 0 : 3), 2, 1, '#3f9b62');
  for (let x = 104; x < 222; x += 9) r(x, 6, 1, 1, '#e5383b');
  // snow on the window sills
  for (const wx of [40, 252]) {
    r(wx - 2, 34, 52, 1, '#f4f8ff');
    r(wx + 4, 33, 6, 1, '#f4f8ff');
    r(wx + 30, 33, 9, 1, '#f4f8ff');
  }
  // stockings hanging under the left window
  [[46, '#c8102e'], [58, '#2e8b57'], [70, '#c8102e']].forEach(([x, c]) => {
    r(x + 1, 37, 1, 1, '#6b4a2e');
    r(x, 38, 5, 2, '#f4f1ea');
    r(x, 40, 4, 3, c);
    r(x - 2, 42, 5, 2, c);
  });
  // wreath on the pantry wall between the cabinets and the fridge
  const wreath = [[2, 0, 4], [1, 1, 6], [0, 2, 2], [6, 2, 2], [0, 3, 2], [6, 3, 2], [0, 4, 2], [6, 4, 2], [1, 5, 6], [2, 6, 4]];
  for (const [dx, dy, w] of wreath) r(504 + dx, 22 + dy, w, 1, '#2e7d4f');
  for (const [dx, dy] of [[2, 0], [6, 3], [1, 5], [5, 6]]) r(504 + dx, 22 + dy, 1, 1, '#e5383b');
  r(506, 28, 4, 2, '#c8102e');
  r(507, 30, 1, 2, '#c8102e');
  r(509, 30, 1, 2, '#c8102e');
}

// ---------- live items ----------

/** Christmas tree: three tiers, trunk, red pot, twinkling lights, a glowing star. */
function drawTree(g, t) {
  const r = rect(g);
  const { x, y } = TREE;
  r(x - 9, y - 1, 19, 2, 'rgba(0,0,0,.22)');
  r(x - 4, y - 6, 9, 6, '#a3222f');
  r(x - 4, y - 6, 9, 1, '#c8243a');
  r(x - 1, y - 9, 3, 3, '#6b4a2e');
  // tiers overlap (each upper tier's wide base covers the narrow tip of the one below); lights sit inside them
  const tiers = [
    [y - 10, 12, 7],
    [y - 15, 9, 7],
    [y - 20, 6, 6],
  ];
  const spots = [];
  for (const [base, half, h] of tiers) {
    for (let i = 0; i < h; i++) {
      const w = Math.max(1, Math.round(((i + 1) / h) * half));
      const row = base - h + i + 1;
      r(x - w, row, w * 2 + 1, 1, '#1f6b3a');
      r(x + w - 1, row, 2, 1, '#17552e');
      if (i >= 2 && i % 2 === 0) for (let dx = -w + 1 + (i % 4 ? 1 : 2); dx < w; dx += 4) spots.push([x + dx, row]);
    }
    r(x - half + 1, base, half * 2 - 1, 1, '#2e8b57');
  }
  spots.forEach(([sx, sy], i) => {
    const on = hash(Math.floor(t / 400) + i * 5) > 0.3;
    r(sx, sy, 1, 1, on ? BULBS[i % BULBS.length] : '#3a4a3a');
  });
  // star on top
  const bright = Math.floor(t / 600) % 2 ? '#fff1a8' : '#ffd23f';
  r(x, y - 29, 1, 1, bright);
  r(x - 1, y - 28, 3, 1, bright);
  r(x - 2, y - 27, 5, 1, bright);
  r(x - 1, y - 26, 3, 1, bright);
}

function drawGift(g, [x, y, w, h, c, ribbon]) {
  const r = rect(g);
  r(x, y - h, w, h, c);
  r(x, y - h, w, 1, 'rgba(255,255,255,.25)');
  r(x + Math.floor(w / 2), y - h, 1, h, ribbon);
  r(x, y - h + 2, w, 1, ribbon);
  r(x + Math.floor(w / 2) - 1, y - h - 1, 1, 1, ribbon);
  r(x + Math.floor(w / 2) + 1, y - h - 1, 1, 1, ribbon);
}

function drawCandle(g, t, x, y, i) {
  const r = rect(g);
  r(x, y - 4, 2, 4, '#c8102e');
  r(x, y - 4, 1, 4, '#e5383b');
  r(x - 1, y, 4, 1, '#2e7d4f');
  const k = hash(Math.floor(t / 90) + i * 7);
  const tall = k > 0.35 ? 2 : 1;
  r(x + (k > 0.8 ? 1 : 0), y - 4 - tall, 1, tall, k > 0.5 ? '#ffd166' : '#ff9f43');
}

function furniture() {
  const items = [{ y: TREE.y, draw: (g, t) => drawTree(g, t) }];
  GIFTS.forEach((gift) => items.push({ y: gift[1], draw: (g) => drawGift(g, gift) }));
  CANDLES.forEach(([x, y, sortY], i) => items.push({ y: sortY, draw: (g, t) => drawCandle(g, t, x, y, i) }));
  return items;
}

function lights(t) {
  const out = [{ x: TREE.x, y: TREE.y - 18, radius: 34 + hash(Math.floor(t / 400)) * 4, color: 'rgba(255,200,120,.26)' }];
  CANDLES.forEach(([x, y], i) => out.push({ x: x + 1, y: y - 5, radius: 15 + hash(Math.floor(t / 90) + i * 7) * 4, color: 'rgba(255,190,90,.28)' }));
  for (const [x0, x1] of WIRES) out.push({ x: (x0 + x1) / 2, y: 10, radius: 30, color: 'rgba(255,210,140,.14)' });
  return out;
}

// ---------- overlay: blinking light-strings ----------

function overlay(g, t) {
  const r = rect(g);
  const phase = Math.floor(t / 500);
  BULB_SPOTS.forEach(([x, y], i) => {
    const on = (i + phase) % 3 !== 0;
    r(x, y, 2, 2, on ? BULBS[i % BULBS.length] : '#4a4a52');
    if (on) r(x, y, 1, 1, 'rgba(255,255,255,.55)');
  });
}

// ---------- window view ----------

function sky(r, s, wx, t) {
  r(wx + 2, 11, 44, 11, s.top);
  r(wx + 2, 22, 44, 11, s.bottom);
  for (let i = 0; i < 5; i++) if (hash(i + wx + Math.floor(t / 1300)) > 0.4) r(wx + 5 + i * 8, 12 + ((i * 3) % 5), 1, 1, s.star);
  if (wx === 40) [2, 4, 4, 2].forEach((w, i) => r(wx + 36 - w / 2, 13 + i, w, 1, s.moon));
  // pines on a snowy ground
  for (const px of wx === 40 ? [8, 30] : [12, 36]) {
    for (let i = 0; i < 7; i++) r(wx + px - Math.floor(i / 2), 23 + i, Math.floor(i / 2) * 2 + 1, 1, '#16352a');
    r(wx + px, 23, 1, 1, s.ground);
  }
  r(wx + 2, 30, 44, 3, s.ground);
  // falling snow
  for (let i = 0; i < 12; i++) {
    const y = 11 + Math.floor((t / 90 + i * 53) % 21);
    const x = wx + 3 + ((i * 17) % 41) + Math.round(Math.sin(t / 700 + i) * 1.5);
    r(Math.max(wx + 2, Math.min(wx + 45, x)), y, 1, 1, s.snow);
  }
}

export const NATAL_DECOR = { paintStatic, furniture, overlay, lights, sky };
