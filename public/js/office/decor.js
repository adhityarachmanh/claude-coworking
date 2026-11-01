// Theme scenery painted on top of the office (pure drawing, no state). Halloween:
//   paintStatic – once into the cached background: cobwebs in the corners, bunting on the wall
//   furniture   – depth-sorted live items: glowing jack-o'-lanterns and flickering candles
//   overlay     – every frame, over the scene: bats flying slowly across, a dangling spider
//   lights      – warm glow points for drawLighting (flicker with the flames)
const W = 544;
const H = 288;

const rect = (g) => (x, y, w, h, c) => {
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), w, h);
};

function hash(n) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

// ---------- static (background cache) ----------

/** Cobweb in a corner: spokes fanning over a quarter circle, three sagging rings. dx/dy = direction away from the corner. */
function cobweb(r, x0, y0, dx, dy, size) {
  const seen = new Set();
  const dot = (x, y) => {
    const px = Math.round(x0 + dx * x);
    const py = Math.round(y0 + dy * y);
    const key = px * 1000 + py;
    if (seen.has(key) || px < 0 || py < 0 || px >= W || py >= H) return;
    seen.add(key);
    r(px, py, 1, 1, 'rgba(226,220,242,.55)');
  };
  const SPOKES = 5;
  const angle = (i) => (i / (SPOKES - 1)) * (Math.PI / 2);
  for (let i = 0; i < SPOKES; i++) {
    for (let d = 0; d <= size; d += 0.5) dot(Math.cos(angle(i)) * d, Math.sin(angle(i)) * d);
  }
  for (const k of [0.38, 0.68, 0.97]) {
    const rad = size * k;
    for (let i = 0; i < SPOKES - 1; i++) {
      const a = angle(i);
      const b = angle(i + 1);
      for (let s = 0; s <= 1; s += 0.08) {
        const sag = 1 - Math.sin(s * Math.PI) * 0.18; // threads droop toward the corner between spokes
        const ang = a + (b - a) * s;
        dot(Math.cos(ang) * rad * sag, Math.sin(ang) * rad * sag);
      }
    }
  }
}

/** Halloween bunting between x0 and x1 along the top of the wall. */
function bunting(r, x0, x1) {
  const colors = ['#f08a24', '#a066d3', '#8cc63f'];
  const sagAt = (x) => 5 + Math.round(Math.sin((Math.PI * (x - x0)) / (x1 - x0)) * 3);
  for (let x = x0; x <= x1; x++) r(x, sagAt(x), 1, 1, '#2a1f2a');
  let i = 0;
  for (let x = x0 + 2; x + 5 <= x1; x += 7, i++) {
    const y = sagAt(x + 2) + 1;
    const c = colors[i % colors.length];
    r(x, y, 5, 1, c);
    r(x + 1, y + 1, 3, 1, c);
    r(x + 1, y + 2, 3, 1, c);
    r(x + 2, y + 3, 1, 1, c);
  }
}

function paintStatic(g) {
  const r = rect(g);
  cobweb(r, 0, 4, 1, 1, 15);
  cobweb(r, 303, 4, -1, 1, 13);
  cobweb(r, 429, 4, -1, 1, 12);
  cobweb(r, 543, 4, -1, 1, 15);
  cobweb(r, 0, 287, 1, -1, 16);
  cobweb(r, 543, 287, -1, -1, 14);
  bunting(r, 36, 96);
  bunting(r, 224, 300);
}

// ---------- live items ----------

const PUMPKINS = [
  [14, 168],
  [262, 238],
  [428, 216],
  [446, 238],
  [28, 284],
  [536, 94],
];
const CANDLES = [
  [8, 111, 157],
  [12, 111, 157],
  [16, 111, 157],
  [497, 43, 64],
  [502, 43, 64],
  [480, 141, 160],
];

function drawPumpkin(g, t, x, y, i) {
  const r = rect(g);
  const lit = hash(Math.floor(t / 110) + i * 13) > 0.25;
  const glow = lit ? '#ffe14d' : '#ffb347';
  r(x - 4, y - 7, 9, 1, '#f08a24');
  r(x - 5, y - 6, 11, 5, '#f08a24');
  r(x - 4, y - 1, 9, 1, '#f08a24');
  r(x - 2, y - 7, 1, 7, '#c25e10');
  r(x + 2, y - 7, 1, 7, '#c25e10');
  r(x + 5, y - 6, 1, 5, '#c25e10');
  r(x, y - 9, 1, 2, '#4f7d2b');
  r(x + 1, y - 9, 2, 1, '#6aa84f');
  r(x - 3, y - 5, 2, 1, glow);
  r(x + 2, y - 5, 2, 1, glow);
  r(x - 3, y - 3, 7, 1, glow);
  r(x - 1, y - 3, 1, 1, '#f08a24');
  r(x + 2, y - 3, 1, 1, '#f08a24');
  r(x - 4, y, 9, 1, 'rgba(0,0,0,.25)');
}

function drawCandle(g, t, x, y, i) {
  const r = rect(g);
  r(x, y - 4, 2, 4, '#efe6cf');
  r(x, y - 4, 2, 1, '#fff8e6');
  const k = hash(Math.floor(t / 90) + i * 7);
  const tall = k > 0.35 ? 2 : 1;
  r(x + (k > 0.8 ? 1 : 0), y - 4 - tall, 1, tall, k > 0.5 ? '#ffd166' : '#ff9f43');
}

function furniture() {
  const items = [];
  PUMPKINS.forEach(([x, y], i) => items.push({ y, draw: (g, t) => drawPumpkin(g, t, x, y, i) }));
  CANDLES.forEach(([x, y, sortY], i) => items.push({ y: sortY, draw: (g, t) => drawCandle(g, t, x, y, i) }));
  return items;
}

function lights(t) {
  const out = [];
  PUMPKINS.forEach(([x, y], i) => out.push({ x, y: y - 4, radius: 26 + hash(Math.floor(t / 110) + i * 13) * 4, color: 'rgba(255,130,30,.30)' }));
  CANDLES.forEach(([x, y], i) => out.push({ x: x + 1, y: y - 5, radius: 16 + hash(Math.floor(t / 90) + i * 7) * 4, color: 'rgba(255,190,90,.30)' }));
  return out;
}

// ---------- overlay: bats + spider ----------

const BAT_UP = ['x.....x', 'xx.x.xx', '.xxxxx.', '...x...'];
const BAT_DOWN = ['...x...', '.xxxxx.', 'xx...xx', 'x.....x'];
const BATS = [
  { speed: 22, y: 64, amp: 7, phase: 0, dir: 1 },
  { speed: 16, y: 150, amp: 10, phase: 260, dir: -1 },
  { speed: 27, y: 104, amp: 6, phase: 430, dir: 1 }, // stays below the wall: the whiteboard stays readable
];

function overlay(g, t) {
  const r = rect(g);
  BATS.forEach((b, i) => {
    const run = ((t / 1000) * b.speed + b.phase) % (W + 60);
    const x = b.dir > 0 ? run - 30 : W + 30 - run;
    const y = b.y + Math.sin(t / 900 + i * 2) * b.amp;
    const rows = Math.floor(t / 150 + i) % 2 ? BAT_UP : BAT_DOWN;
    rows.forEach((row, dy) => [...row].forEach((ch, dx) => ch === 'x' && r(x + dx, y + dy, 1, 1, '#140d1a')));
  });
  // spider on a thread from the web above the boss office wall
  const len = 12 + Math.round(Math.sin(t / 1300) * 4);
  r(296, 4, 1, len, 'rgba(226,220,242,.55)');
  r(295, 4 + len, 3, 2, '#140d1a');
  r(294, 5 + len, 1, 1, '#140d1a');
  r(298, 5 + len, 1, 1, '#140d1a');
  r(294, 3 + len, 1, 1, '#140d1a');
  r(298, 3 + len, 1, 1, '#140d1a');
}

export const HALLOWEEN_DECOR = { paintStatic, furniture, overlay, lights };
