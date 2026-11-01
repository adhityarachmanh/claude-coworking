// Office floor plan (logical pixels), static background, furniture, monitor screens and walk grid.
// Colours, extra scenery, window sky and lighting follow the active theme (themes.js).
//
// ---------- floor plan ----------
// One fixed floor for the whole team (17 roles + the Lead), laid out like a real office floor: glass-walled private
// offices along the top wall for the senior roles, the rest in department pods with low cubicle partitions, a glass
// meeting room, a pantry and a lounge. Every role has its own desk in its department; a role switched off
// (👥 Kelola tim) leaves its desk empty — nothing moves and the room never changes size.
//
//  x 0    56              216   304       392       480 496  520              640
//  y 0 ┌────┬──────────────────────┬─────────┬─────────┬───────────────────────┐
//      │door│ win  [ papan ]  🕒 win │  PM     │ TechLead│ ▤ poster    win  ✿    │  top wall (0–48)
//   48 │    ·  ┌ Produk & Desain ┐  │ ▢    ✿  │ ▢     ≡ │ flag    ▣ Lead        │
//      │ ▥  │  │ ba  ui-ux writer│ ✿│         │         │      ⌂     ⌂          │  glass partitions
//  144 │ ▥     └─────────────────┘  └───··────┴────··───┴··─────────────────────┘  (·· = door gaps)
//      │    main aisle
//  168 │ ┌ Engineering ──────────────────┐   ┌ Kualitas & Keamanan ───┐  🛋 lounge
//      │ │ frontend mobile backend dba data│   │ qa reviewer security compl.│  (sofa, coffee table)
//      │ └───────────────────────────────┘   └────────────────────────┘
//  256 │▣┌ Ops & Support ───┐  ┌─ Ruang Rapat ··──┐ ┌ Pantry ───────────────────┐
//      │▣│devops support free│  │ TV    ( meja )   │ │ counter ☕   fridge  water │
//      │ └──────────────────┘  │                  │ │                  cafe ○   │
//  344 └───────────────────────┴──────────────────┴─┴───────────────────────────┘
//
//  area                 rect (x, y, w, h)        contents
//  entrance             door x 4–32 in the wall   DOOR spot (18, 54), bookshelf on the left wall (shelf spot)
//  Produk & Desain pod  desks y 88, x 56–216      ba, ui-ux, writer (whiteboard + windows behind, board spot)
//  PM office            304, 48, 88, 96           desk (320, 72), plant, door gap x 360–384
//  Tech Lead office     392, 48, 88, 96           desk (408, 72), bookcase, door gap x 448–472
//  Lead corner office   480, 48, 160, 96          executive desk (528, 92), guest chairs, window, door gap x 496–520
//  Engineering pod      desks y 192, x 24–296     frontend, mobile, backend, dba, data
//  Kualitas & Keamanan  desks y 192, x 336–552    qa, reviewer, security, compliance
//  lounge               560, 144, 80, 112         sofa (3 seats), coffee table
//  Ops & Support pod    desks y 280, x 40–200     devops (next to the server rack), support, freelancer (hot desk)
//  meeting room         224, 256, 160, 88         round table (meet1–4 around it), activity TV, door gap x 288–320
//  pantry               392, 256, 248, 88         counter + coffee machine, fridge, water cooler, cafe table
//  aisles               rows y 128–168 (main), y 232–256, x 304–328 and x 208–224 between the pods
//
// Cubicles: a pod is a row of desks (step 56) behind one back panel, with a low divider between desks and at both
// ends; everyone faces the back panel (monitors up), the walkway is behind the chairs.
import { activeTheme } from './themes.js';

export const W = 640;
/** Height of the floor (fixed: a smaller team leaves desks empty). `room.h` is the same number. */
export const H = 344;
export const WALL_H = 48;
const CELL = 8;
export const room = { w: W, h: H };
/** x of the three windows in the top wall (the last one is in the Lead's corner office). */
export const WINDOWS = [40, 252, 584];

/** Desk roles in catalog order (DESKS keeps this order). */
const DESK_ORDER = [
  'pm', 'ba', 'architect', 'ui-ux', 'frontend', 'backend', 'dba', 'freelancer', 'qa', 'security', 'writer', 'devops',
  'mobile', 'data', 'support', 'reviewer', 'compliance',
];
/** Desk roles not in the default team (catalog defaultOff; must match roster.js DEFAULT_TEAM). None today. */
const DEFAULT_OFF = new Set([]);
const PROPS = {
  pm: 'notes', ba: 'papers', architect: 'blueprint', 'ui-ux': 'tablet', frontend: 'phone', backend: 'duck', dba: 'dbcan', qa: 'bug', security: 'lock', writer: 'books', devops: 'cactus', freelancer: 'lamp',
  mobile: 'phonestand', data: 'chart', support: 'headset', reviewer: 'magnifier', compliance: 'stamp',
};
const DUAL = new Set(['frontend', 'backend', 'devops', 'data']);

// Department pods: desks side by side, POD_STEP apart (48 desk + 8 divider).
const POD_STEP = 56;
const PODS = [
  { label: 'Produk & Desain', x: 56, y: 88, roles: ['ba', 'ui-ux', 'writer'] },
  { label: 'Engineering', x: 24, y: 192, roles: ['frontend', 'mobile', 'backend', 'dba', 'data'] },
  { label: 'Kualitas & Keamanan', x: 336, y: 192, roles: ['qa', 'reviewer', 'security', 'compliance'] },
  { label: 'Ops & Support', x: 40, y: 280, roles: ['devops', 'support', 'freelancer'] },
];
const podRight = (pod) => pod.x + pod.roles.length * POD_STEP - 8;

// Private offices along the top wall: glass on the left and bottom, a 24 px door gap in the bottom wall.
const OFFICE_BOTTOM = 144;
const DOOR_GAP = 24;
const OFFICES = [
  { role: 'pm', label: 'PM', x: 304, w: 88, door: 360, desk: { x: 320, y: 72 } },
  { role: 'architect', label: 'Tech Lead', x: 392, w: 88, door: 448, desk: { x: 408, y: 72 } },
  { role: 'claude', label: 'Lead', x: 480, w: 160, door: 496 },
];
// The boss sits alone in the corner office, behind an executive desk, facing the door.
const BOSS_DESK = { x: 528, y: 92, w: 64, cx: 560, boss: true, seat: { x: 560, y: 88, facing: 'down' }, ask: { x: 584, y: 84 }, visit: { x: 560, y: 124 } };

// Meeting room (glass, door gap in the top wall) and pantry, side by side at the bottom.
const MEET = { x: 224, y: 256, w: 160, door: 288 };
const TABLE = { x: 304, y: 300 };

function deskAt(role, x, y) {
  return { x, y, w: 48, cx: x + 24, dual: DUAL.has(role), prop: PROPS[role], seat: { x: x + 24, y: y + 34 } };
}

/** Every role's desk at its fixed department position, whether the role is on the team or not. */
export const SLOTS = (() => {
  const at = {};
  for (const o of OFFICES) if (o.desk) at[o.role] = deskAt(o.role, o.desk.x, o.desk.y);
  for (const pod of PODS) pod.roles.forEach((role, i) => (at[role] = deskAt(role, pod.x + i * POD_STEP, pod.y)));
  return Object.fromEntries(DESK_ORDER.map((role) => [role, at[role]]));
})();

/** The active team's desks (+ the Lead). */
export const DESKS = {};

/**
 * Seats the active roles at their own desks (any order; unknown ids are ignored). Desks never move: an off role's
 * desk stays in place, empty. Mutates DESKS in place; callers rebuild their scenes and the stage afterwards.
 */
export function layoutDesks(roles) {
  const on = new Set(roles);
  for (const key of Object.keys(DESKS)) delete DESKS[key];
  for (const role of DESK_ORDER) if (on.has(role)) DESKS[role] = structuredClone(SLOTS[role]);
  DESKS.claude = structuredClone(BOSS_DESK);
}

/** Small signs drawn as crisp HTML over the canvas: pod names on the back panels, nameplates by the doors. */
export const SIGNS = [
  ...PODS.map((pod) => ({ x: (pod.x + podRight(pod)) / 2, y: pod.y - 19, text: pod.label })),
  ...OFFICES.map((o) => ({ x: o.role === 'claude' ? 552 : (o.x + o.door) / 2, y: 141, text: o.label, plate: true })),
  { x: (MEET.x + MEET.door) / 2, y: 257, text: 'Ruang Rapat', plate: true },
  { x: 462, y: 257, text: 'Pantry', plate: true },
];

export const DOOR = { x: 18, y: 54 };
export const BOARD = { x: 102, y: 8, w: 118, h: 31 };
/** Where the coffee machine's steam rises. */
export const COFFEE_MACHINE = { x: 412, y: 252 };
export const SPOTS = {
  coffee: { x: 412, y: 292, face: 'up' },
  fridge: { x: 540, y: 304, face: 'up' },
  water: { x: 566, y: 300, face: 'up' },
  cafe1: { x: 591, y: 314, face: 'right' },
  cafe2: { x: 627, y: 314, face: 'left' },
  pantry1: { x: 470, y: 320, face: 'down' },
  window: { x: 64, y: 56, face: 'up' },
  window2: { x: 276, y: 56, face: 'up' },
  window3: { x: 608, y: 56, face: 'up' }, // the Lead's own window
  board: { x: 160, y: 56, face: 'up' },
  shelf: { x: 28, y: 132, face: 'left' },
  rack: { x: 20, y: 316, face: 'up' },
  // around the round table in the meeting room (planning, syncs)
  meet1: { x: TABLE.x - 28, y: TABLE.y, face: 'right' },
  meet2: { x: TABLE.x + 28, y: TABLE.y, face: 'left' },
  meet3: { x: TABLE.x, y: TABLE.y + 22, face: 'up' },
  meet4: { x: TABLE.x, y: TABLE.y - 20, face: 'down' },
};
export const SOFA_SEATS = [
  { x: 584, y: 204 },
  { x: 600, y: 204 },
  { x: 616, y: 204 },
];
export const CAT_SPOTS = [
  { x: 264, y: 112, sleep: true },
  { x: 316, y: 244 },
  { x: 120, y: 148 },
  { x: 600, y: 236 },
  { x: 304, y: 336, sleep: true },
  { x: 470, y: 330, sleep: true },
  { x: 440, y: 120 },
];
const PLANTS = [
  [296, 84],
  [382, 68], // PM office
  [628, 70], // Lead office
  [370, 340], // meeting room
  [10, 340],
  [628, 162], // lounge
  [628, 340],
];

/** Glass walls of the offices and the meeting room, cubicle partitions, then the furniture. */
const FIXED_BLOCKERS = [
  ...OFFICES.flatMap((o) => [
    [o.x, WALL_H, CELL, OFFICE_BOTTOM - WALL_H], // left glass wall
    [o.x, OFFICE_BOTTOM - CELL, o.door - o.x, CELL], // bottom wall, left of the door
    [o.door + DOOR_GAP, OFFICE_BOTTOM - CELL, o.x + o.w - o.door - DOOR_GAP, CELL], // …and right of it
  ]),
  ...PODS.flatMap((pod) => [
    [pod.x - 8, pod.y - 20, podRight(pod) - pod.x + 16, 8], // back panel
    ...pod.roles.map((_, i) => [pod.x - 8 + i * POD_STEP, pod.y - 20, 8, 38]), // left end + dividers
    [podRight(pod), pod.y - 20, 8, 38], // right end
  ]),
  [MEET.x, MEET.y, MEET.door - MEET.x, CELL], // meeting room: top wall left of the door
  [MEET.door + 32, MEET.y, MEET.x + MEET.w - MEET.door - 32, CELL],
  [MEET.x, MEET.y, CELL, H - MEET.y], // left wall
  [MEET.x + MEET.w - CELL, MEET.y, CELL, H - MEET.y], // right wall
  [TABLE.x - 16, TABLE.y - 8, 32, 16], // round table
  [232, 264, 48, 28], // TV cabinet
  [4, 116, 16, 40], // bookshelf
  [8, 264, 24, 36], // server rack
  [460, 56, 16, 32], // Tech Lead's bookcase
  [400, 256, 120, 28], // pantry counter
  [528, 256, 24, 40], // fridge
  [560, 260, 12, 28], // water cooler
  [600, 299, 18, 18], // cafe table
  [568, 176, 64, 20], // sofa
  [580, 212, 40, 10], // coffee table
  ...PLANTS.map(([x, y]) => [x - 6, y - 14, 12, 14]),
];

// ---------- walk grid + A* ----------

const COLS = W / CELL;
const ROWS = H / CELL;
const grid = { rows: ROWS, blocked: new Uint8Array(0) };

/** Marks the cells covered by walls, partitions, furniture and every desk (occupied or not): built once. */
function buildWalkGrid() {
  const desks = [...Object.values(SLOTS).map((d) => [d.x, d.y - 12, d.w, 30]), [BOSS_DESK.x, BOSS_DESK.y - 2, BOSS_DESK.w, 22]];
  const blockers = [...desks, ...FIXED_BLOCKERS];
  const blocked = new Uint8Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * CELL + 4;
      const y = r * CELL + 4;
      if (y < WALL_H) blocked[r * COLS + c] = 1;
      for (const [bx, by, bw, bh] of blockers) if (x >= bx && x < bx + bw && y >= by && y < by + bh) blocked[r * COLS + c] = 1;
    }
  }
  grid.blocked = blocked;
}

buildWalkGrid();
layoutDesks(DESK_ORDER.filter((id) => !DEFAULT_OFF.has(id))); // the default team until the server says otherwise — must match roster.js DEFAULT_TEAM

const cellOf = (p) => [Math.max(0, Math.min(COLS - 1, Math.floor(p.x / CELL))), Math.max(0, Math.min(grid.rows - 1, Math.floor(p.y / CELL)))];
const free = (c, r) => c >= 0 && r >= 0 && c < COLS && r < grid.rows && !grid.blocked[r * COLS + c];

/** True when a point is on open floor (not a wall, partition, desk or piece of furniture). */
export const isWalkable = (p) => free(...cellOf(p));

function nearestFree([c, r]) {
  if (free(c, r)) return [c, r];
  for (let d = 1; d < 6; d++) {
    for (let dr = -d; dr <= d; dr++) for (let dc = -d; dc <= d; dc++) if (free(c + dc, r + dr)) return [c + dc, r + dr];
  }
  return [c, r];
}

/**
 * True when the straight line a → b only touches open cells (its own two end cells excepted: a seat may be tucked
 * under its desk). Walks every cell the line crosses (grid traversal), so a shortcut never clips the corner of a
 * partition or a glass wall; through an exact cell corner both side cells must be open.
 */
function lineFree(a, b) {
  const [c0, r0] = cellOf(a);
  const [c1, r1] = cellOf(b);
  const ok = (c, r) => (c === c0 && r === r0) || (c === c1 && r === r1) || free(c, r);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sc = Math.sign(dx);
  const sr = Math.sign(dy);
  // distance along the line (as a fraction of it) to the next vertical / horizontal cell border, and per cell
  const stepX = dx ? CELL / Math.abs(dx) : Infinity;
  const stepY = dy ? CELL / Math.abs(dy) : Infinity;
  let c = c0;
  let r = r0;
  let tx = dx ? (sc > 0 ? (c + 1) * CELL - a.x : a.x - c * CELL) / Math.abs(dx) : Infinity;
  let ty = dy ? (sr > 0 ? (r + 1) * CELL - a.y : a.y - r * CELL) / Math.abs(dy) : Infinity;
  for (let guard = 0; guard < COLS + ROWS && (c !== c1 || r !== r1); guard++) {
    if (Math.abs(tx - ty) < 1e-9) {
      if (!ok(c + sc, r) || !ok(c, r + sr)) return false;
      c += sc;
      r += sr;
      tx += stepX;
      ty += stepY;
    } else if (tx < ty) {
      c += sc;
      tx += stepX;
    } else {
      r += sr;
      ty += stepY;
    }
    if (!ok(c, r)) return false;
  }
  return true;
}

/** Returns waypoints from `from` to `to` avoiding furniture (8-dir A* + line-of-sight smoothing). */
export function findPath(from, to) {
  const start = nearestFree(cellOf(from));
  const goal = nearestFree(cellOf(to));
  const key = (c, r) => r * COLS + c;
  const open = new Map([[key(...start), { c: start[0], r: start[1], g: 0, f: 0, parent: null }]]);
  const closed = new Set();
  const h = (c, r) => Math.hypot(c - goal[0], r - goal[1]);
  let found = null;
  while (open.size) {
    let best = null;
    for (const node of open.values()) if (!best || node.f < best.f) best = node;
    open.delete(key(best.c, best.r));
    closed.add(key(best.c, best.r));
    if (best.c === goal[0] && best.r === goal[1]) {
      found = best;
      break;
    }
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dc && !dr) continue;
        const c = best.c + dc;
        const r = best.r + dr;
        if (!free(c, r) || closed.has(key(c, r))) continue;
        if (dc && dr && (!free(best.c + dc, best.r) || !free(best.c, best.r + dr))) continue; // no corner cutting
        const g = best.g + (dc && dr ? 1.414 : 1);
        const existing = open.get(key(c, r));
        if (!existing || g < existing.g) open.set(key(c, r), { c, r, g, f: g + h(c, r), parent: best });
      }
    }
  }
  if (!found) return [{ x: to.x, y: to.y }];
  const cells = [];
  for (let n = found; n; n = n.parent) cells.unshift({ x: n.c * CELL + 4, y: n.r * CELL + 4 });
  cells[0] = { x: from.x, y: from.y };
  cells.push({ x: to.x, y: to.y });
  const smooth = [cells[0]];
  let i = 0;
  while (i < cells.length - 1) {
    let j = cells.length - 1;
    while (j > i + 1 && !lineFree(cells[i], cells[j])) j--;
    smooth.push(cells[j]);
    i = j;
  }
  return smooth.slice(1);
}

// ---------- drawing helpers ----------

export function rectFn(g) {
  return (x, y, w, h, c) => {
    g.fillStyle = c;
    g.fillRect(Math.round(x), Math.round(y), w, h);
  };
}

/** rectFn with the active theme's palette remap (the plain office has none: identical to rectFn). */
function paintFn(g) {
  const r = rectFn(g);
  const map = activeTheme().colors;
  return map ? (x, y, w, h, c) => r(x, y, w, h, map[c] ?? c) : r;
}

function hash(n) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/** Static background (walls, floors, wall decor) rendered once. */
export function renderBackground() {
  const h = room.h;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = h;
  const g = c.getContext('2d');
  const r = paintFn(g);

  // wood floor everywhere; the rooms lay their own floor on top
  for (let y = WALL_H; y < h; y += 6) {
    const row = (y - WALL_H) / 6;
    for (let x = -((row * 13) % 32); x < W; x += 32) {
      r(x, y, 32, 6, hash(row * 31 + x) > 0.5 ? '#c9a57a' : '#c39e72');
      r(x, y + 5, 32, 1, '#b48e64');
      r(x + 31, y, 1, 6, '#b48e64');
    }
  }
  // PM and Tech Lead offices: light carpet
  for (const o of OFFICES.slice(0, 2)) {
    r(o.x + 2, WALL_H, o.w - 2, OFFICE_BOTTOM - WALL_H - 2, '#e2d3b9');
    for (let y = WALL_H + 3; y < OFFICE_BOTTOM - 2; y += 4) r(o.x + 2, y, o.w - 2, 1, '#d2bf9f');
  }
  // Lead's corner office: burgundy carpet with a gold-trimmed rug under the desk
  r(482, WALL_H, 158, OFFICE_BOTTOM - WALL_H - 2, '#5a2f33');
  for (let y = WALL_H + 2; y < OFFICE_BOTTOM - 2; y += 4) r(482, y, 158, 1, '#52292d');
  r(514, 68, 92, 64, '#c9a227');
  r(516, 70, 88, 60, '#7a2e35');
  r(520, 74, 80, 52, '#86343b');
  // meeting room carpet
  r(MEET.x + 2, MEET.y + 2, MEET.w - 4, h - MEET.y - 2, '#6a8fb8');
  for (let y = MEET.y + 4; y < h; y += 4) r(MEET.x + 2, y, MEET.w - 4, 1, '#5e83ad');
  // pantry tiles
  for (let y = 256; y < h; y += 8) for (let x = 392; x < W; x += 8) r(x, y, 8, 8, ((x + y) / 8) % 2 ? '#e7e0d3' : '#dad1c1');
  r(391, 256, 1, h - 256, '#a98a64');
  r(391, 255, W - 391, 1, '#a98a64');
  // rugs: entrance mat, lounge rug
  r(6, 48, 24, 7, '#8b3a3a');
  r(8, 50, 20, 3, '#a24848');
  r(566, 206, 72, 22, '#c98b6b');
  r(568, 208, 68, 18, '#d69b7b');

  // wall: open plan, PM and Tech Lead (plaster), the Lead's office (wood wainscot)
  r(0, 0, W, 4, '#5e4a3a');
  r(0, 4, 480, 40, '#efe5d4');
  for (let x = 0; x < 480; x += 32) r(x, 4, 1, 26, '#e6d9c3');
  r(0, 30, 480, 14, '#e2d3b9');
  r(0, 30, 480, 1, '#d2bf9f');
  r(480, 4, 160, 40, '#e8ddd0');
  r(480, 26, 160, 18, '#8a5a3b');
  r(480, 26, 160, 1, '#a87648');
  for (let x = 488; x < W; x += 16) r(x, 28, 1, 15, '#7a4e33');
  for (const o of OFFICES) r(o.x, 4, 2, 40, '#d2bf9f'); // where the partitions meet the wall
  r(0, 44, W, 4, '#97806a');
  // PM: cork board with sticky notes; Tech Lead: framed blueprint
  r(318, 10, 44, 20, '#a7835f');
  r(320, 12, 40, 16, '#c19b75');
  for (const [x, y, col] of [[323, 14, '#ffd166'], [331, 15, '#ef8fb0'], [339, 14, '#8ecae6'], [347, 15, '#ffd166'], [326, 21, '#8ecae6'], [342, 21, '#ef8fb0']]) r(x, y, 6, 5, col);
  r(406, 10, 44, 20, '#7a6248');
  r(408, 12, 40, 16, '#2f6fb0');
  for (let x = 412; x < 446; x += 6) r(x, 13, 1, 14, '#4a86c4');
  r(410, 18, 36, 1, '#cfe3f7');
  r(420, 14, 1, 12, '#cfe3f7');
  r(432, 15, 10, 8, '#cfe3f7');
  r(433, 16, 8, 6, '#2f6fb0');
  // Lead: bookshelf and the Claude poster
  r(488, 8, 20, 18, '#6e4b30');
  for (let i = 0; i < 3; i++) for (let b = 0; b < 5; b++) r(490 + b * 3.5, 10 + i * 5, 2, 4, ['#c9a227', '#7a2e35', '#3d85c6', '#2b9a66', '#e9e4dc'][(b + i) % 5]);
  r(514, 10, 22, 24, '#3a2f2a');
  r(516, 12, 18, 20, '#d97757');
  for (const [dx, dy] of [[0, -5], [0, 5], [-5, 0], [5, 0], [-3, -3], [3, 3], [-3, 3], [3, -3]]) r(524 + dx, 21 + dy, 2, 2, '#fff3e8');
  r(523, 20, 4, 4, '#fff3e8');

  // windows (glass painted live), whiteboard frame (text is an HTML overlay)
  for (const wx of WINDOWS) {
    r(wx, 9, 48, 26, '#7a6248');
    r(wx - 2, 35, 52, 2, '#bfa88a');
  }
  r(100, 6, 122, 35, '#a3aab4');
  r(BOARD.x, BOARD.y, BOARD.w, BOARD.h, '#fbfbf8');
  r(112, 41, 96, 2, '#8a9099');
  r(116, 40, 4, 1, '#e5534b');
  r(122, 40, 4, 1, '#3d85c6');
  r(128, 40, 4, 1, '#2b9a66');
  // door frame + exit sign
  r(4, 12, 28, 36, '#5e4a3a');
  r(10, 5, 16, 5, '#2f9e62');
  r(12, 7, 12, 1, '#e8fff1');
  // meeting room: TV on a low cabinet (content painted live)
  r(236, 262, 44, 22, '#1b1d24');
  r(256, 284, 4, 3, '#1b1d24');
  r(232, 286, 52, 6, '#94673f');
  r(232, 286, 52, 1, '#a87648');
  // pantry: tiled backsplash behind the counter
  r(400, 252, 120, 14, '#dfe9ec');
  for (let y = 252; y < 266; y += 5) r(400, y, 120, 1, '#ccdade');
  for (let x = 400; x < 520; x += 8) r(x, 252, 1, 14, '#ccdade');
  activeTheme().decor?.paintStatic(g);
  return c;
}

/** Furniture pieces drawn in depth order with the characters. */
export function buildFurniture() {
  const items = [];
  const add = (sortY, draw) => items.push({ y: sortY, draw });
  const glass = 'rgba(190,225,245,.38)';
  const shine = 'rgba(255,255,255,.35)';
  const frame = '#8fa3b5';

  // private offices: glass on the left and in front, a door gap with darker posts
  add(OFFICE_BOTTOM, (g) => {
    const r = paintFn(g);
    for (const o of OFFICES) {
      r(o.x, WALL_H, 2, OFFICE_BOTTOM - WALL_H, glass);
      r(o.x + 1, WALL_H, 1, OFFICE_BOTTOM - WALL_H, shine);
      for (let y = WALL_H; y < OFFICE_BOTTOM; y += 32) r(o.x, y, 2, 2, frame);
      r(o.x, OFFICE_BOTTOM - 3, o.door - o.x, 3, glass);
      r(o.door + DOOR_GAP, OFFICE_BOTTOM - 3, o.x + o.w - o.door - DOOR_GAP, 3, glass);
      r(o.x, OFFICE_BOTTOM - 3, o.door - o.x, 1, shine);
      r(o.door + DOOR_GAP, OFFICE_BOTTOM - 3, o.x + o.w - o.door - DOOR_GAP, 1, shine);
      for (let x = o.x; x < o.x + o.w; x += 32) if (x < o.door - 4 || x > o.door + DOOR_GAP + 2) r(x, OFFICE_BOTTOM - 3, 2, 3, frame);
      r(o.door - 2, OFFICE_BOTTOM - 8, 2, 8, frame);
      r(o.door + DOOR_GAP, OFFICE_BOTTOM - 8, 2, 8, frame);
    }
  });

  // cubicle pods: one back panel behind the monitors, low dividers between the desks and at both ends
  for (const pod of PODS) {
    const x0 = pod.x - 6;
    const span = podRight(pod) - pod.x + 12;
    const y = pod.y;
    add(y - 10, (g) => {
      const r = paintFn(g);
      r(x0, y - 24, span, 14, '#c4ad92');
      r(x0, y - 24, span, 2, '#bf9c82');
      r(x0, y - 11, span, 1, '#a99278');
      for (let x = x0 + 8; x < x0 + span - 4; x += 8) r(x, y - 21, 1, 9, '#bba48a'); // fabric seams
    });
    add(y + 18, (g) => {
      const r = paintFn(g);
      for (let i = 0; i <= pod.roles.length; i++) {
        const x = x0 + i * POD_STEP;
        r(x + 4, y - 20, 1, 38, 'rgba(0,0,0,.08)');
        r(x, y - 24, 4, 42, '#c4ad92');
        r(x, y - 24, 4, 2, '#bf9c82');
        r(x + 3, y - 22, 1, 40, '#a99278');
        r(x, y + 16, 4, 2, '#a3826a');
      }
    });
  }

  // meeting room glass: the top wall (with the door), then the side walls
  add(MEET.y + 2, (g) => {
    const r = paintFn(g);
    const right = MEET.x + MEET.w;
    r(MEET.x, MEET.y, MEET.door - MEET.x, 3, glass);
    r(MEET.door + 32, MEET.y, right - MEET.door - 32, 3, glass);
    r(MEET.x, MEET.y, MEET.door - MEET.x, 1, shine);
    r(MEET.door + 32, MEET.y, right - MEET.door - 32, 1, shine);
    for (let x = MEET.x; x < right; x += 32) if (x < MEET.door - 4 || x > MEET.door + 34) r(x, MEET.y, 2, 3, frame);
    r(MEET.door - 2, MEET.y, 2, 8, frame);
    r(MEET.door + 32, MEET.y, 2, 8, frame);
  });
  add(H, (g) => {
    const r = paintFn(g);
    for (const x of [MEET.x, MEET.x + MEET.w - 2]) {
      r(x, MEET.y, 2, H - MEET.y, glass);
      for (let y = MEET.y; y < H; y += 32) r(x, y, 2, 2, frame);
    }
  });
  // round meeting table with a laptop and papers
  add(TABLE.y + 6, (g) => {
    const r = paintFn(g);
    const { x, y } = TABLE;
    r(x - 8, y + 7, 16, 2, 'rgba(0,0,0,.15)');
    r(x - 2, y + 2, 4, 6, '#6e4b30');
    [20, 26, 30, 32, 32, 32, 30, 26, 20].forEach((w, i) => r(x - w / 2, y - 8 + i, w, 1, i === 0 ? '#d8ab78' : '#c4935f'));
    [26, 20].forEach((w, i) => r(x - w / 2, y + 1 + i, w, 1, '#94673f'));
    r(x - 10, y - 5, 8, 4, '#3a3f4b');
    r(x - 9, y - 4, 6, 1, '#66d9e8');
    r(x + 4, y - 6, 7, 5, '#f4f1ea');
    r(x + 5, y - 4, 5, 1, '#9aa3ad');
  });

  // pantry counter with coffee machine, fruit bowl and sink
  add(285, (g, t, ctx) => {
    const r = paintFn(g);
    r(400, 266, 120, 6, '#a3826a');
    r(400, 266, 120, 1, '#bf9c82');
    r(400, 272, 120, 12, '#c4ad92');
    for (let x = 400; x < 520; x += 16) {
      r(x, 272, 1, 12, '#a99278');
      r(x + 10, 277, 1, 3, '#7b6650');
    }
    r(406, 253, 12, 14, '#2d2f36');
    r(408, 256, 8, 4, '#4a4e5a');
    r(415, 255, 1, 1, ctx.coffeeBusy ? '#ffb347' : '#d97757');
    r(409, 263, 6, 3, '#f4f1ea');
    r(424, 261, 5, 5, '#f4f1ea');
    r(438, 262, 12, 4, '#e8a33d');
    r(440, 260, 3, 2, '#e5534b');
    r(445, 260, 3, 2, '#8fc93a');
    r(476, 267, 20, 4, '#b8c2ca');
    r(477, 268, 18, 2, '#9aa5ae');
    r(485, 261, 2, 6, '#9aa5ae');
  });
  // fridge
  add(296, (g) => {
    const r = paintFn(g);
    r(528, 248, 22, 48, '#e3e9ee');
    r(528, 248, 22, 1, '#f5f8fa');
    r(528, 264, 22, 1, '#b8c2ca');
    r(531, 254, 1, 7, '#9aa5ae');
    r(531, 268, 1, 12, '#9aa5ae');
    r(528, 295, 22, 1, '#9aa5ae');
  });
  // water cooler
  add(288, (g) => {
    const r = paintFn(g);
    r(560, 268, 12, 20, '#e3e9ee');
    r(560, 268, 12, 1, '#f5f8fa');
    r(562, 256, 8, 12, '#8fd0f0');
    r(563, 257, 2, 10, '#c4ecff');
    r(564, 274, 4, 2, '#3d85c6');
  });
  // cafe table with two stools
  add(317, (g) => {
    const r = paintFn(g);
    for (const x of [591, 627]) {
      r(x - 4, 308, 9, 5, '#a7835f');
      r(x - 4, 308, 9, 1, '#c19b75');
    }
    r(600, 300, 18, 12, '#f2efe8');
    r(600, 300, 18, 1, '#ffffff');
    r(600, 312, 18, 2, '#d6d0c4');
    r(608, 314, 2, 3, '#8a8478');
    r(604, 303, 3, 3, '#7a4a2a');
  });

  // lounge: sofa and coffee table
  add(201, (g) => {
    const r = paintFn(g);
    r(568, 176, 64, 12, '#4f7299');
    r(568, 176, 64, 2, '#6a8fb8');
    r(568, 188, 64, 8, '#5e83ad');
    r(568, 188, 64, 1, '#7aa0c9');
    r(568, 196, 64, 4, '#45678c');
    r(563, 180, 6, 20, '#45678c');
    r(631, 180, 6, 20, '#45678c');
    r(563, 180, 6, 2, '#5e83ad');
    r(631, 180, 6, 2, '#5e83ad');
    r(586, 179, 10, 7, '#f2c14e');
  });
  add(222, (g) => {
    const r = paintFn(g);
    r(580, 212, 40, 7, '#a7835f');
    r(580, 212, 40, 1, '#c19b75');
    r(580, 219, 40, 2, '#86643f');
    r(588, 209, 4, 3, '#f4f1ea');
    r(604, 210, 8, 2, '#3d85c6');
  });

  // server rack beside DevOps (LEDs blink faster while commands run)
  add(299, (g, t, ctx) => {
    const r = paintFn(g);
    r(12, 262, 14, 36, '#23252e');
    r(12, 262, 14, 1, '#3a3d4a');
    for (let i = 0; i < 7; i++) {
      r(14, 265 + i * 4, 10, 3, '#30333f');
      const speed = ctx.rackBusy ? 110 : 600;
      r(15, 266 + i * 4, 1, 1, hash(i * 7 + Math.floor(t / speed)) > 0.4 ? '#3fb950' : '#1d3a24');
      r(17, 266 + i * 4, 1, 1, hash(i * 3 + Math.floor(t / (speed * 1.7))) > 0.6 ? '#f5a524' : '#3a2d14');
    }
  });

  // bookshelf by the entrance
  add(156, (g) => {
    const r = paintFn(g);
    r(4, 112, 16, 44, '#7a5636');
    r(4, 112, 16, 2, '#95704c');
    const colors = ['#e07a5f', '#3d85c6', '#f2cc8f', '#81b29a', '#9b5de5', '#e5534b'];
    for (let shelf = 0; shelf < 4; shelf++) {
      const y = 116 + shelf * 10;
      r(5, y + 8, 14, 1, '#5c3f26');
      for (let b = 0; b < 4; b++) r(6 + b * 3, y + (b % 2), 2, 8 - (b % 2), colors[(b + shelf * 2) % colors.length]);
    }
  });
  // Tech Lead's bookcase
  add(88, (g) => {
    const r = paintFn(g);
    r(462, 54, 14, 34, '#7a5636');
    r(462, 54, 14, 2, '#95704c');
    const colors = ['#2f6fb0', '#e9e4dc', '#5c5fd6', '#81b29a'];
    for (let shelf = 0; shelf < 3; shelf++) {
      const y = 58 + shelf * 10;
      r(463, y + 8, 12, 1, '#5c3f26');
      for (let b = 0; b < 3; b++) r(464 + b * 3, y + (b % 2), 2, 8 - (b % 2), colors[(b + shelf) % colors.length]);
    }
  });
  // Lead's office: two leather guest chairs facing the executive desk
  add(138, (g) => {
    const r = paintFn(g);
    for (const x of [538, 582]) {
      r(x - 6, 126, 12, 4, '#6b3a2e');
      r(x - 6, 130, 12, 8, '#7d4636');
      r(x - 6, 130, 12, 1, '#94573f');
      r(x - 7, 128, 2, 10, '#5a2f25');
      r(x + 5, 128, 2, 10, '#5a2f25');
    }
  });

  // plants (sway gently)
  for (const [x, y] of PLANTS) {
    add(y, (g, t) => {
      const r = paintFn(g);
      const sway = Math.sin(t / 900 + x) > 0.6 ? 1 : 0;
      r(x - 4, y - 6, 9, 7, '#b5653b');
      r(x - 4, y - 6, 9, 1, '#cf7a4c');
      r(x - 6 + sway, y - 16, 5, 9, '#3d8b5a');
      r(x + 1 + sway, y - 18, 5, 11, '#4caf72');
      r(x - 2 + sway, y - 21, 4, 14, '#5cc282');
      r(x - 8 + sway, y - 12, 4, 5, '#3d8b5a');
      r(x + 5 + sway, y - 13, 4, 6, '#3d8b5a');
    });
  }
  items.push(...(activeTheme().decor?.furniture() ?? []));
  return items;
}

export function drawDesk(g, desk) {
  const r = paintFn(g);
  const { x, y, w, cx } = desk;
  r(x + 2, y + 18, w - 4, 2, 'rgba(0,0,0,.12)');
  r(x, y, w, 10, '#c4935f');
  r(x, y, w, 1, '#d8ab78');
  r(x, y + 10, w, 4, '#94673f');
  r(x, y + 10, w, 1, '#a87648');
  r(x + 1, y + 14, 3, 4, '#6e4b30');
  r(x + w - 4, y + 14, 3, 4, '#6e4b30');
  r(cx - 7, y + 6, 14, 3, '#d5d9e0');
  r(cx - 6, y + 7, 12, 1, '#b8bdc6');
  r(cx + 9, y + 7, 2, 2, '#d5d9e0');
  r(x + 3, y + 4, 3, 3, '#f2efe8');
  r(x + 3, y + 4, 3, 1, '#6b4226');
  r(x + 6, y + 5, 1, 1, '#f2efe8');
  const px = x + w - 11;
  switch (desk.prop) {
    case 'papers':
      r(px - 1, y + 2, 8, 6, '#f7f5ef');
      r(px, y + 1, 8, 6, '#ece9e0');
      r(px + 1, y + 3, 5, 1, '#9aa3ad');
      break;
    case 'tablet':
      r(px - 1, y + 2, 9, 6, '#2d2f36');
      r(px, y + 3, 7, 4, '#f4a3c2');
      r(px + 8, y + 2, 1, 5, '#f2c14e');
      break;
    case 'duck':
      r(px + 2, y + 3, 5, 3, '#ffd23f');
      r(px + 3, y + 1, 3, 3, '#ffd23f');
      r(px + 2, y + 2, 1, 1, '#f28c28');
      break;
    case 'bug':
      r(px + 1, y + 1, 6, 7, '#cfe8ef');
      r(px + 3, y + 4, 2, 2, '#e5534b');
      break;
    case 'notes':
      r(px + 1, y + 2, 3, 3, '#ffd166');
      r(px + 5, y + 3, 3, 3, '#ef8fb0');
      r(px + 2, y + 6, 3, 3, '#8ecae6');
      break;
    case 'blueprint':
      r(px - 1, y + 2, 10, 6, '#2f6fb0');
      r(px, y + 3, 8, 1, '#cfe3f7');
      r(px + 3, y + 3, 1, 4, '#cfe3f7');
      r(px - 3, y + 6, 2, 3, '#e8e2d0');
      break;
    case 'phone':
      r(px + 2, y + 2, 4, 7, '#22252e');
      r(px + 3, y + 3, 2, 5, '#66d9e8');
      break;
    case 'dbcan':
      for (let i = 0; i < 3; i++) {
        r(px + 1, y + 1 + i * 3, 7, 2, '#7c8da6');
        r(px + 1, y + 1 + i * 3, 7, 1, '#a9b8cc');
      }
      break;
    case 'lock':
      r(px + 2, y + 1, 5, 3, '#b0b8c4');
      r(px + 3, y + 2, 3, 2, '#c4935f');
      r(px + 1, y + 4, 7, 5, '#e8b923');
      r(px + 4, y + 6, 1, 2, '#6b5414');
      break;
    case 'books':
      r(px, y + 5, 9, 2, '#e07a5f');
      r(px + 1, y + 3, 8, 2, '#3d85c6');
      r(px, y + 1, 7, 2, '#81b29a');
      break;
    case 'cactus':
      r(px + 2, y + 5, 5, 4, '#b5653b');
      r(px + 3, y - 1, 3, 6, '#4caf72');
      r(px + 1, y + 1, 2, 2, '#4caf72');
      r(px + 6, y, 2, 3, '#4caf72');
      break;
    case 'lamp':
      r(px + 6, y - 7, 1, 10, '#3a3a3a');
      r(px + 3, y - 8, 6, 2, '#d97757');
      r(px + 1, y + 3, 4, 3, '#b5653b');
      r(px, y - 1, 3, 4, '#4caf72');
      r(px + 3, y - 2, 2, 5, '#5cc282');
      break;
    // Props of the optional roles (👥 Kelola tim).
    case 'phonestand': // mobile: a phone upright on a stand, a second device lying flat
      r(px + 2, y + 6, 6, 2, '#3a3d46');
      r(px + 3, y - 2, 4, 8, '#22252e');
      r(px + 4, y - 1, 2, 6, '#9be3ff');
      r(px - 2, y + 4, 3, 5, '#22252e');
      r(px - 1, y + 5, 1, 3, '#e046d2');
      break;
    case 'chart': // data: a little bar chart on a stand
      r(px, y - 3, 9, 9, '#f4f1ea');
      r(px, y + 6, 9, 1, '#9aa3ad');
      r(px + 1, y + 2, 2, 4, '#2f9e94');
      r(px + 4, y, 2, 6, '#e9a23b');
      r(px + 7, y - 2, 1, 8, '#3d85c6');
      r(px + 4, y + 7, 1, 2, '#6e4b30');
      break;
    case 'headset': // support: a headset with its mic boom, on the desk
      r(px + 1, y + 1, 7, 1, '#3a3d46');
      r(px, y + 2, 1, 2, '#3a3d46');
      r(px + 8, y + 2, 1, 2, '#3a3d46');
      r(px - 1, y + 3, 3, 4, '#22252e');
      r(px + 7, y + 3, 3, 4, '#22252e');
      r(px + 1, y + 6, 4, 1, '#3a3d46');
      r(px + 4, y + 6, 2, 2, '#e5534b');
      break;
    case 'magnifier': // reviewer: a magnifying glass over a printed diff
      r(px - 1, y + 2, 8, 6, '#f7f5ef');
      r(px, y + 3, 4, 1, '#e5534b');
      r(px, y + 5, 5, 1, '#2b9a66');
      r(px + 4, y, 4, 1, '#8a6d3b');
      r(px + 3, y + 1, 1, 3, '#8a6d3b');
      r(px + 8, y + 1, 1, 3, '#8a6d3b');
      r(px + 4, y + 4, 4, 1, '#8a6d3b');
      r(px + 4, y + 1, 4, 3, 'rgba(190,225,255,.75)');
      r(px + 8, y + 5, 2, 2, '#5e4a3a');
      break;
    case 'stamp': // compliance: a policy document with a red seal, a small padlock clipped to it
      r(px - 1, y, 7, 9, '#f7f5ef');
      r(px, y + 1, 5, 1, '#9aa3ad');
      r(px, y + 3, 4, 1, '#9aa3ad');
      r(px + 1, y + 5, 3, 3, '#c92a2a');
      r(px + 2, y + 6, 1, 1, '#f08c8c');
      r(px + 7, y + 2, 3, 2, '#b0b8c4');
      r(px + 6, y + 4, 5, 4, '#b56a9e');
      r(px + 8, y + 5, 1, 2, '#3a2830');
      break;
  }
}

/** Executive desk seen from the front: the boss sits behind it, monitor back faces the room. */
export function drawBossDesk(g, desk, working, t) {
  const r = paintFn(g);
  const { x, y, w, cx } = desk;
  r(x + 2, y + 20, w - 4, 2, 'rgba(0,0,0,.18)');
  // monitor (back side) on the left, laptop on the right
  r(x + 4, y - 12, 20, 13, '#2c2f3a');
  r(x + 5, y - 11, 18, 1, '#3d414f');
  r(x + 12, y + 1, 4, 2, '#2c2f3a');
  if (working && Math.floor(t / 500) % 2) r(x + 13, y - 6, 2, 2, '#9fd3ff');
  r(x + w - 22, y - 7, 16, 9, '#3a3f4b');
  // desk top + carved front panel
  r(x, y, w, 10, '#6e3f2a');
  r(x, y, w, 1, '#8c5638');
  r(x, y + 10, w, 10, '#5a3322');
  r(x + 3, y + 12, w - 6, 6, '#663a27');
  r(x + 3, y + 12, w - 6, 1, '#7a4630');
  // gold nameplate, papers, pen, coffee
  r(cx - 9, y + 3, 18, 4, '#c9a227');
  r(cx - 8, y + 4, 16, 2, '#e3c25a');
  r(x + 28, y + 2, 8, 6, '#f4f1ea');
  r(x + 37, y + 3, 6, 1, '#1d1f2b');
  r(x + w - 10, y + 3, 3, 3, '#f2efe8');
  r(x + w - 10, y + 3, 3, 1, '#6b4226');
}

/** High-back leather chair behind the boss; drawn before the boss so they sit in it. */
export function drawBossChair(g, seat) {
  const r = paintFn(g);
  const { x, y } = seat;
  r(x - 9, y - 30, 18, 24, '#3b2622');
  r(x - 8, y - 29, 16, 1, '#5a3a33');
  r(x - 9, y - 30, 1, 24, '#2a1a17');
  r(x + 8, y - 30, 1, 24, '#2a1a17');
  r(x - 11, y - 14, 3, 8, '#3b2622');
  r(x + 8, y - 14, 3, 8, '#3b2622');
}

/** Chair seen from behind; drawn after a seated worker so the backrest overlaps them. */
export function drawChair(g, seat, occupied) {
  const r = paintFn(g);
  const { x, y } = seat;
  if (!occupied) r(x - 6, y - 11, 12, 2, '#59607d');
  r(x - 6, y - 9, 12, 7, '#3f4560');
  r(x - 5, y - 9, 10, 1, '#565d7d');
  r(x - 6, y - 3, 12, 1, '#353a52');
  r(x - 1, y - 2, 2, 2, '#4a4f60');
  r(x - 5, y, 11, 1, '#2b2f3d');
}

// ---------- monitors ----------

const CODE_COLORS = ['#c792ea', '#82aaff', '#c3e88d', '#f78c6c', '#89ddff', '#ffcb6b'];

export function drawMonitors(g, desk, mode, t, seed) {
  const r = paintFn(g);
  const screens = desk.dual ? [[desk.cx - 18, 16], [desk.cx + 2, 16]] : [[desk.cx - 10, 20]];
  screens.forEach(([mx, mw], i) => {
    const my = desk.y - 12;
    r(mx, my, mw, 12, '#2c2f3a');
    r(mx + Math.floor(mw / 2) - 1, my + 12, 2, 2, '#2c2f3a');
    r(mx + Math.floor(mw / 2) - 3, my + 14, 6, 1, '#2c2f3a');
    const second = i === 1 ? { code: 'terminal', design: 'browser', pipeline: 'terminal', tests: 'code', review: 'code' }[mode] : null;
    drawScreen(r, mx + 1, my + 1, mw - 2, 10, second ?? mode, t, seed + i * 17);
  });
}

function drawScreen(r, x, y, w, h, mode, t, seed) {
  switch (mode) {
    case 'code': {
      r(x, y, w, h, '#1d1f2b');
      const scroll = Math.floor(t / 380);
      for (let i = 0; i < 5; i++) {
        const line = scroll + i;
        let cx = x + 1 + Math.floor(hash(seed + line) * 3) * 2;
        for (let s = 0; s < 3 && cx < x + w - 1; s++) {
          const len = 1 + Math.floor(hash(seed + line * 7 + s) * 5);
          r(cx, y + 1 + i * 2, Math.min(len, x + w - 1 - cx), 1, CODE_COLORS[Math.floor(hash(line * 3 + s + seed) * CODE_COLORS.length)]);
          cx += len + 1;
        }
      }
      break;
    }
    case 'terminal': {
      r(x, y, w, h, '#111317');
      const scroll = Math.floor(t / 500);
      for (let i = 0; i < 4; i++) {
        const len = 3 + Math.floor(hash(seed + scroll + i) * (w - 6));
        if (hash(seed * 3 + scroll + i) > 0.5) r(x + 1, y + 1 + i * 2, 1, 1, '#d97757');
        r(x + 3, y + 1 + i * 2, len, 1, '#c9ced8');
      }
      if (Math.floor(t / 400) % 2) r(x + 3, y + 9, 2, 1, '#f5f5f5');
      break;
    }
    case 'tests': {
      r(x, y, w, h, '#16191d');
      const step = Math.floor(t / 300);
      for (let i = 0; i < 4; i++) {
        r(x + 1, y + 1 + i * 2, 1, 1, hash(seed + step + i * 5) > 0.15 ? '#3fb950' : '#f0524a');
        r(x + 3, y + 1 + i * 2, 4 + Math.floor(hash(seed + i) * (w - 8)), 1, '#7d8590');
      }
      r(x + 1, y + h - 1, Math.floor(((t % 3000) / 3000) * (w - 2)), 1, '#3fb950');
      break;
    }
    case 'doc': {
      r(x, y, w, h, '#f4f6f8');
      r(x + 1, y + 1, w - 6, 1, '#3d85c6');
      const scroll = Math.floor(t / 900);
      for (let i = 0; i < 3; i++) r(x + 1, y + 3 + i * 2, 4 + Math.floor(hash(seed + scroll + i) * (w - 8)), 1, '#9aa3ad');
      r(x + w - 4, y + 6, 1, 3, '#e07a5f');
      r(x + w - 3, y + 5, 1, 4, '#81b29a');
      r(x + w - 2, y + 7, 1, 2, '#3d85c6');
      break;
    }
    case 'design': {
      r(x, y, w, h, '#fafafa');
      r(x, y, w, 2, '#9b5de5');
      r(x + 2, y + 3, 6, 4, '#f4a3c2');
      r(x + 9, y + 3, w - 11, 2, '#8ecae6');
      r(x + 9, y + 6, w - 13, 1, '#cfd4dc');
      r(x + 2, y + 8, w - 4, 1, '#ffd166');
      r(x + 2 + Math.floor((Math.sin(t / 600) * 0.5 + 0.5) * (w - 4)), y + 3 + Math.floor((Math.cos(t / 700) * 0.5 + 0.5) * 5), 1, 1, '#1d1f2b');
      break;
    }
    case 'search': {
      r(x, y, w, h, '#1d1f2b');
      r(x + 1, y + 1, w - 2, 2, '#3a3f52');
      r(x + 2, y + 1, 3 + (Math.floor(t / 200) % Math.max(1, w - 6)), 1, '#ffd166');
      for (let i = 0; i < 3; i++) {
        r(x + 1, y + 4 + i * 2, w - 4, 1, '#59607d');
        r(x + 2 + Math.floor(hash(seed + i + Math.floor(t / 700)) * (w - 6)), y + 4 + i * 2, 2, 1, '#ffd166');
      }
      break;
    }
    case 'browser': {
      r(x, y, w, h, '#ffffff');
      r(x, y, w, 2, '#dfe3ea');
      r(x + 1, y, 1, 1, '#f0524a');
      r(x + 3, y, 1, 1, '#f5a524');
      r(x + 2, y + 3, w - 4, 2, '#82aaff');
      r(x + 2, y + 6, w - 8, 1, '#9aa3ad');
      r(x + 2, y + 8, w - 6, 1, '#9aa3ad');
      break;
    }
    case 'kanban': {
      r(x, y, w, h, '#eef1f5');
      const colW = Math.floor((w - 2) / 3);
      const colors = ['#f5a524', '#82aaff', '#3fb950'];
      for (let col = 0; col < 3; col++) {
        const n = 1 + Math.floor(hash(seed + col + Math.floor(t / 1500)) * 3);
        for (let k = 0; k < n; k++) r(x + 1 + col * colW, y + 1 + k * 3, colW - 1, 2, colors[col]);
      }
      break;
    }
    case 'db': {
      r(x, y, w, h, '#f7f8fa');
      r(x, y, w, 2, '#c0703a');
      const active = Math.floor(t / 450) % 4;
      for (let row = 0; row < 4; row++) {
        r(x, y + 2 + row * 2, w, 1, row === active ? '#ffe8cc' : row % 2 ? '#eceff3' : '#f7f8fa');
        for (let col = 0; col < 3; col++) r(x + 1 + col * Math.floor(w / 3), y + 2 + row * 2, Math.floor(w / 3) - 2, 1, '#9aa3ad');
      }
      break;
    }
    case 'pipeline': {
      r(x, y, w, h, '#14171c');
      const stages = 4;
      const sw = Math.floor((w - 2) / stages);
      const progress = Math.floor(t / 700) % (stages + 2);
      for (let s = 0; s < stages; s++) {
        const color = s < progress ? '#3fb950' : s === progress ? (Math.floor(t / 200) % 2 ? '#f5a524' : '#8a5a14') : '#3a3f4a';
        r(x + 1 + s * sw, y + 4, sw - 1, 3, color);
      }
      r(x + 1, y + 1, Math.floor(w / 2), 1, '#7d8590');
      break;
    }
    case 'security': {
      r(x, y, w, h, '#101418');
      const sx = x + Math.floor(w / 2) - 2;
      r(sx, y + 2, 5, 4, '#2f9e62');
      r(sx + 1, y + 6, 3, 1, '#2f9e62');
      r(sx + 2, y + 7, 1, 1, '#2f9e62');
      const scan = y + 1 + (Math.floor(t / 120) % (h - 2));
      r(x, scan, w, 1, 'rgba(255,90,60,.65)');
      break;
    }
    case 'review': {
      r(x, y, w, h, '#1b1f27');
      const scroll = Math.floor(t / 600);
      for (let i = 0; i < 5; i++) {
        const kind = hash(seed + scroll + i);
        const color = kind > 0.7 ? '#3fb950' : kind < 0.25 ? '#f0524a' : '#7d8590';
        r(x + 1, y + 1 + i * 2, 1, 1, color);
        r(x + 3, y + 1 + i * 2, 3 + Math.floor(hash(seed * 2 + scroll + i) * (w - 6)), 1, color === '#7d8590' ? '#59607d' : color);
      }
      break;
    }
    case 'error': {
      r(x, y, w, h, Math.floor(t / 200) % 2 ? '#5a1d1d' : '#3a1414');
      const cx = x + Math.floor(w / 2);
      for (let i = -2; i <= 2; i++) {
        r(cx + i, y + 5 + i, 1, 1, '#f0524a');
        r(cx + i, y + 5 - i, 1, 1, '#f0524a');
      }
      break;
    }
    case 'idle': {
      r(x, y, w, h, '#1b1d26');
      r(x + 1 + Math.floor((Math.sin(t / 1300 + seed) * 0.5 + 0.5) * (w - 3)), y + 1 + Math.floor((Math.cos(t / 1700 + seed) * 0.5 + 0.5) * (h - 3)), 2, 2, '#d97757');
      break;
    }
    default:
      r(x, y, w, h, '#23252e');
      r(x + 1, y + 1, 3, 1, '#2f3240');
  }
}

// ---------- live wall details ----------

export function drawWallLive(g, t, now, activity) {
  const r = paintFn(g);
  const hour = now.getHours() + now.getMinutes() / 60;
  const night = hour < 5.5 || hour >= 19;
  const dusk = (hour >= 17 && hour < 19) || (hour >= 5.5 && hour < 7);
  const sky = activeTheme().sky;
  for (const wx of WINDOWS) {
    if (sky) {
      // A theme may paint its own window view (decor.sky: snow, takbiran fireworks, a sunny day); the frame stays.
      const paintSky = activeTheme().decor?.sky;
      if (paintSky) {
        paintSky(r, sky, wx, t);
        r(wx + 23, 11, 2, 22, '#7a6248');
        r(wx + 2, 21, 44, 1, '#7a6248');
      } else paintThemedSky(r, sky, wx, t);
      continue;
    }
    r(wx + 2, 11, 44, 11, night ? '#141b3a' : dusk ? '#f39c6b' : '#7cc4f2');
    r(wx + 2, 22, 44, 11, night ? '#27325e' : dusk ? '#f7c59f' : '#b7e2fa');
    if (night) {
      r(wx + 34, 14, 4, 4, '#f4f1c9');
      r(wx + 35, 14, 3, 1, '#141b3a');
      for (let i = 0; i < 5; i++) if (hash(i + wx + Math.floor(t / 1500)) > 0.3) r(wx + 4 + i * 7, 13 + ((i * 5) % 9), 1, 1, '#ffffff');
    } else {
      const drift = Math.max(0, ((t / 300 + wx) % 60) - 12);
      r(wx + 2 + drift, 15, Math.min(12, 44 - drift), 3, '#ffffff');
      r(wx + 6 + drift, 13, Math.min(6, 40 - drift), 2, '#ffffff');
    }
    r(wx + 23, 11, 2, 22, '#7a6248');
    r(wx + 2, 21, 44, 1, '#7a6248');
  }

  // meeting-room TV: live activity bars
  r(238, 264, 40, 18, '#0f1a2b');
  r(240, 266, 12, 2, '#d97757');
  if (activity.busy && Math.floor(t / 500) % 2) r(273, 266, 3, 3, '#f0524a');
  activity.bars.forEach((v, i) => {
    const bh = Math.max(1, Math.round(v * 10));
    r(240 + i * 3, 280 - bh, 2, bh, i === activity.bars.length - 1 ? '#66d9e8' : '#3d85c6');
  });

  // clock
  g.fillStyle = '#fffdf6';
  g.strokeStyle = '#5b4636';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(236, 20, 7, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.lineWidth = 1;
  g.strokeStyle = '#2a1e2c';
  const hand = (angle, len) => {
    g.beginPath();
    g.moveTo(236.5, 20.5);
    g.lineTo(236.5 + Math.sin(angle) * len, 20.5 - Math.cos(angle) * len);
    g.stroke();
  };
  hand(((now.getHours() % 12) + now.getMinutes() / 60) * (Math.PI / 6), 3.5);
  hand(now.getMinutes() * (Math.PI / 30), 5.5);
  return { night, dusk };
}

/** A theme's fixed night sky in one window: gradient bands, a big moon, twinkling stars, frame bars. */
function paintThemedSky(r, sky, wx, t) {
  r(wx + 2, 11, 44, 11, sky.top);
  r(wx + 2, 22, 44, 11, sky.bottom);
  for (let i = 0; i < 6; i++) if (hash(i + wx + Math.floor(t / 1100)) > 0.35) r(wx + 4 + i * 7, 13 + ((i * 5) % 12), 1, 1, sky.star);
  if (wx === 40) {
    // round full moon (row widths of a pixel circle) with two craters
    [3, 5, 7, 7, 7, 5, 3].forEach((w, i) => r(wx + 33 - (w - 1) / 2, 12 + i, w, 1, sky.moon));
    r(wx + 31, 14, 2, 1, '#ddd3a0');
    r(wx + 34, 16, 1, 2, '#ddd3a0');
  }
  r(wx + 23, 11, 2, 22, '#7a6248');
  r(wx + 2, 21, 44, 1, '#7a6248');
}

/** Theme scenery drawn over the scene every frame (Halloween: bats, spider). */
export function drawThemeOverlay(g, t) {
  activeTheme().decor?.overlay(g, t);
}

export function drawDoor(g, open) {
  const r = paintFn(g);
  if (open) {
    r(7, 15, 22, 33, '#2c221c');
    r(7, 15, 4, 33, '#8a5a3b');
  } else {
    r(7, 15, 22, 33, '#8a5a3b');
    r(10, 18, 7, 12, '#7a4e33');
    r(19, 18, 7, 12, '#7a4e33');
    r(10, 33, 16, 11, '#7a4e33');
    r(25, 31, 2, 2, '#e7c66b');
  }
}

/** Ceiling lamps: one over every pod, office, the meeting room, the pantry and the lounge. */
const LAMPS = [[136, 108], [160, 216], [444, 216], [120, 304], [348, 96], [436, 96], [560, 100], [304, 300], [480, 304], [600, 210]];

/** Night darkening + lamp/monitor glow, drawn over the scene. */
export function drawLighting(g, { night, dusk }, glows, t = 0) {
  const themed = activeTheme();
  if (themed.light) return drawThemedLighting(g, themed, night, glows, t);
  if (!night && !dusk) {
    sunBeams(g, 'rgba(255,248,220,.07)');
    return;
  }
  g.fillStyle = night ? 'rgba(12,16,44,.48)' : 'rgba(80,40,60,.16)';
  g.fillRect(0, 0, W, room.h);
  g.globalCompositeOperation = 'lighter';
  const glow = (x, y, radius, color) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  };
  const lamp = night ? 'rgba(255,200,130,.20)' : 'rgba(255,190,120,.10)';
  for (const [x, y] of LAMPS) glow(x, y, 64, lamp);
  for (const { x, y, color } of glows) glow(x, y, 24, color);
  g.globalCompositeOperation = 'source-over';
}

/** Daylight falling through the windows onto the floor. */
function sunBeams(g, color) {
  g.fillStyle = color;
  for (const wx of WINDOWS) {
    g.beginPath();
    g.moveTo(wx, WALL_H);
    g.lineTo(wx + 48, WALL_H);
    g.lineTo(wx + 100, room.h);
    g.lineTo(wx + 44, room.h);
    g.closePath();
    g.fill();
  }
}

/**
 * Theme lighting: a tint at any hour (stronger at night), warm lamps, the decor's own glow points
 * (candles, lanterns, tree lights) and optional sun beams (`light.beams`: a bright daytime theme).
 */
function drawThemedLighting(g, themed, night, glows, t) {
  const light = themed.light;
  g.fillStyle = night ? light.nightTint : light.tint;
  g.fillRect(0, 0, W, room.h);
  if (light.beams) sunBeams(g, light.beams);
  // keep the whiteboard readable: undo most of the tint over it
  g.fillStyle = 'rgba(255,255,255,.22)';
  g.fillRect(BOARD.x, BOARD.y, BOARD.w, BOARD.h);
  g.globalCompositeOperation = 'lighter';
  const glow = (x, y, radius, color) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  };
  const lamp = night ? light.lampNight : light.lamp;
  for (const [x, y] of LAMPS) glow(x, y, 60, lamp);
  for (const l of themed.decor?.lights(t) ?? []) glow(l.x, l.y, l.radius, l.color);
  for (const { x, y, color } of glows) glow(x, y, 24, color);
  g.globalCompositeOperation = 'source-over';
}
