// Office layout (logical pixels), static background, furniture, monitor screens and walk grid.
// Colours, extra scenery, window sky and lighting follow the active theme (themes.js).
import { activeTheme } from './themes.js';

export const W = 544;
/** Height of the default office (up to 12 desks); `room.h` is the live height. */
export const H = 288;
export const WALL_H = 48;
const CELL = 8;
// The office as it is now: taller than H when the team needs a 4th / 5th row of desks (👥 Kelola tim, layoutDesks).
export const room = { w: W, h: H };

// Workstations: a grid of 4 columns, one desk per active role, filled row by row in DESK_ORDER (the default
// team of 12 gives the original 3 × 4 layout). seat = where the worker's feet are when seated.
const COLS_X = [24, 88, 152, 216];
const FIRST_ROW_Y = 76;
const ROW_STEP = 72;
const MIN_ROWS = 3; // a smaller team keeps the room size (empty floor where desks would be)
const MAX_DESKS = COLS_X.length * 5; // 17 catalog roles: up to 5 rows
const DESK_ORDER = [
  'pm', 'ba', 'architect', 'ui-ux',
  'frontend', 'backend', 'dba', 'freelancer', // freelancer: hot desk for generalist subagents
  'qa', 'security', 'writer', 'devops',
  'mobile', 'data', 'support', 'reviewer',
  'compliance', // the 17th role: opens a 5th row
];
/** Desk roles not in the default team (catalog defaultOff; must match roster.js DEFAULT_TEAM). None today. */
const DEFAULT_OFF = new Set([]);
const PROPS = {
  pm: 'notes', ba: 'papers', architect: 'blueprint', 'ui-ux': 'tablet', frontend: 'phone', backend: 'duck', dba: 'dbcan', qa: 'bug', security: 'lock', writer: 'books', devops: 'cactus', freelancer: 'lamp',
  mobile: 'phonestand', data: 'chart', support: 'headset', reviewer: 'magnifier', compliance: 'stamp',
};
const DUAL = new Set(['frontend', 'backend', 'devops', 'data']);
// The boss sits alone in the glass office, behind an executive desk, facing the door.
const BOSS_DESK = { x: 340, y: 100, w: 64, cx: 372, boss: true, seat: { x: 372, y: 96, facing: 'down' }, ask: { x: 396, y: 92 }, visit: { x: 372, y: 132 } };

export const DESKS = {};

/**
 * Lays the desks out for the active roles (any order; unknown ids are ignored) and sizes the room and the
 * walk grid to match. Mutates DESKS / room in place: callers rebuild their scenes and the stage afterwards.
 */
export function layoutDesks(roles) {
  const on = new Set(roles);
  const order = DESK_ORDER.filter((id) => on.has(id)).slice(0, MAX_DESKS);
  for (const key of Object.keys(DESKS)) delete DESKS[key];
  order.forEach((role, i) => {
    const x = COLS_X[i % COLS_X.length];
    const y = FIRST_ROW_Y + Math.floor(i / COLS_X.length) * ROW_STEP;
    DESKS[role] = { x, y, w: 48, cx: x + 24, dual: DUAL.has(role), prop: PROPS[role], seat: { x: x + 24, y: y + 34 } };
  });
  DESKS.claude = structuredClone(BOSS_DESK);
  const rows = Math.max(MIN_ROWS, Math.ceil(order.length / COLS_X.length));
  room.h = H + (rows - MIN_ROWS) * ROW_STEP;
  buildWalkGrid();
}

export const DOOR = { x: 18, y: 54 };
export const BOARD = { x: 102, y: 8, w: 118, h: 31 };
export const SPOTS = {
  coffee: { x: 454, y: 70, face: 'up' },
  fridge: { x: 526, y: 72, face: 'up' },
  water: { x: 516, y: 120, face: 'right' },
  cafe1: { x: 458, y: 156, face: 'right' },
  cafe2: { x: 494, y: 156, face: 'left' },
  pantry1: { x: 478, y: 104, face: 'down' },
  window: { x: 64, y: 56, face: 'up' },
  window2: { x: 276, y: 56, face: 'up' },
  board: { x: 160, y: 56, face: 'up' },
  shelf: { x: 28, y: 132, face: 'left' },
  rack: { x: 292, y: 222, face: 'left' },
  // standing huddle on the open floor below the boss office (planning, syncs)
  meet1: { x: 352, y: 238, face: 'right' },
  meet2: { x: 380, y: 238, face: 'left' },
  meet3: { x: 366, y: 254, face: 'up' },
  meet4: { x: 366, y: 222, face: 'down' },
};
export const SOFA_SEATS = [
  { x: 474, y: 250 },
  { x: 490, y: 250 },
  { x: 506, y: 250 },
];
export const CAT_SPOTS = [
  { x: 368, y: 182, sleep: true },
  { x: 300, y: 272, sleep: true },
  { x: 120, y: 270 },
  { x: 476, y: 200 },
  { x: 200, y: 128 },
  { x: 520, y: 270, sleep: true },
];

const FIXED_BLOCKERS = [
  [270, 204, 14, 32], // server rack
  [4, 116, 16, 40], // bookshelf
  [304, 48, 8, 64], // meeting room glass: left wall (door gap y 112–139)
  [304, 140, 8, 64],
  [304, 200, 128, 8], // bottom wall
  [430, 48, 8, 156], // right wall
  [442, 44, 66, 20], // counter
  [516, 12, 22, 52], // fridge
  [526, 100, 12, 28], // water cooler
  [467, 141, 18, 18], // cafe table
  [452, 222, 76, 20], // sofa
  [470, 258, 40, 10], // coffee table
  [284, 52, 12, 14], // plants
  [6, 268, 12, 14],
  [290, 270, 12, 14],
  [414, 184, 12, 14],
  [530, 190, 12, 14],
];

// ---------- walk grid + A* ----------

const COLS = W / CELL;
const grid = { rows: H / CELL, blocked: new Uint8Array(0) };

/** Marks the cells covered by walls, furniture and the current desks (after every layoutDesks). */
function buildWalkGrid() {
  const blockers = [...Object.values(DESKS).map((d) => (d.boss ? [d.x, d.y - 2, d.w, 22] : [d.x, d.y - 12, d.w, 30])), ...FIXED_BLOCKERS];
  const rows = room.h / CELL;
  const blocked = new Uint8Array(COLS * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * CELL + 4;
      const y = r * CELL + 4;
      if (y < WALL_H) blocked[r * COLS + c] = 1;
      for (const [bx, by, bw, bh] of blockers) if (x >= bx && x < bx + bw && y >= by && y < by + bh) blocked[r * COLS + c] = 1;
    }
  }
  grid.rows = rows;
  grid.blocked = blocked;
}

layoutDesks(DESK_ORDER.filter((id) => !DEFAULT_OFF.has(id))); // the default team until the server says otherwise — must match roster.js DEFAULT_TEAM

const cellOf = (p) => [Math.max(0, Math.min(COLS - 1, Math.floor(p.x / CELL))), Math.max(0, Math.min(grid.rows - 1, Math.floor(p.y / CELL)))];
const free = (c, r) => c >= 0 && r >= 0 && c < COLS && r < grid.rows && !grid.blocked[r * COLS + c];

function nearestFree([c, r]) {
  if (free(c, r)) return [c, r];
  for (let d = 1; d < 6; d++) {
    for (let dr = -d; dr <= d; dr++) for (let dc = -d; dc <= d; dc++) if (free(c + dc, r + dr)) return [c + dc, r + dr];
  }
  return [c, r];
}

function lineFree(a, b) {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 3);
  for (let i = 1; i < steps; i++) {
    const [c, r] = cellOf({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps });
    if (!free(c, r)) return false;
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
  const h = room.h; // taller with a 4th / 5th row of desks
  const c = document.createElement('canvas');
  c.width = W;
  c.height = h;
  const g = c.getContext('2d');
  const r = paintFn(g);

  // wood floor (work area, corridor, under meeting room)
  for (let y = WALL_H; y < h; y += 6) {
    const row = (y - WALL_H) / 6;
    for (let x = -((row * 13) % 32); x < 440; x += 32) {
      r(x, y, 32, 6, hash(row * 31 + x) > 0.5 ? '#c9a57a' : '#c39e72');
      r(x, y + 5, 32, 1, '#b48e64');
      r(x + 31, y, 1, 6, '#b48e64');
    }
  }
  // pantry tiles
  for (let y = WALL_H; y < h; y += 8) for (let x = 440; x < W; x += 8) r(x, y, 8, 8, ((x + y) / 8) % 2 ? '#e7e0d3' : '#dad1c1');
  r(439, WALL_H, 1, h - WALL_H, '#a98a64');
  // boss office: burgundy carpet with a gold-trimmed rug under the desk
  r(306, 48, 124, 152, '#5a2f33');
  for (let y = 50; y < 198; y += 4) r(306, y, 124, 1, '#52292d');
  r(326, 78, 92, 76, '#c9a227');
  r(328, 80, 88, 72, '#7a2e35');
  r(332, 84, 80, 64, '#86343b');
  // rugs
  r(6, 48, 24, 7, '#8b3a3a');
  r(8, 50, 20, 3, '#a24848');
  r(456, 252, 72, 22, '#c98b6b');
  r(458, 254, 68, 18, '#d69b7b');

  // wall
  r(0, 0, W, 4, '#5e4a3a');
  r(0, 4, 440, 40, '#efe5d4');
  for (let x = 0; x < 304; x += 32) r(x, 4, 1, 26, '#e6d9c3');
  r(0, 30, 440, 14, '#e2d3b9');
  r(0, 30, 440, 1, '#d2bf9f');
  r(306, 4, 124, 40, '#e8ddd0'); // boss office wall: wood wainscot
  r(306, 26, 124, 18, '#8a5a3b');
  r(306, 26, 124, 1, '#a87648');
  for (let x = 314; x < 430; x += 16) r(x, 28, 1, 15, '#7a4e33');
  // bookshelf behind the boss's chair
  r(310, 8, 20, 18, '#6e4b30');
  for (let i = 0; i < 3; i++) for (let b = 0; b < 5; b++) r(312 + b * 3.5, 10 + i * 5, 2, 4, ['#c9a227', '#7a2e35', '#3d85c6', '#2b9a66', '#e9e4dc'][(b + i) % 5]);
  r(0, 44, W, 4, '#97806a');
  r(440, 4, 104, 40, '#dfe9ec'); // pantry backsplash
  for (let y = 4; y < 44; y += 6) r(440, y, 104, 1, '#ccdade');
  for (let x = 440; x < W; x += 8) r(x, 4, 1, 40, '#ccdade');

  // windows (glass painted live), whiteboard frame (text is an HTML overlay)
  for (const wx of [40, 252]) {
    r(wx, 9, 48, 26, '#7a6248');
    r(wx - 2, 35, 52, 2, '#bfa88a');
  }
  r(100, 6, 122, 35, '#a3aab4');
  r(BOARD.x, BOARD.y, BOARD.w, BOARD.h, '#fbfbf8');
  r(112, 41, 96, 2, '#8a9099');
  r(116, 40, 4, 1, '#e5534b');
  r(122, 40, 4, 1, '#3d85c6');
  r(128, 40, 4, 1, '#2b9a66');
  // TV frame in the meeting room (content painted live)
  r(332, 8, 68, 30, '#1b1d24');
  r(364, 38, 4, 3, '#1b1d24');
  // Claude poster
  r(406, 10, 22, 24, '#3a2f2a');
  r(408, 12, 18, 20, '#d97757');
  for (const [dx, dy] of [[0, -5], [0, 5], [-5, 0], [5, 0], [-3, -3], [3, 3], [-3, 3], [3, -3]]) r(416 + dx, 21 + dy, 2, 2, '#fff3e8');
  r(415, 20, 4, 4, '#fff3e8');
  // door frame + exit sign
  r(4, 12, 28, 36, '#5e4a3a');
  r(10, 5, 16, 5, '#2f9e62');
  r(12, 7, 12, 1, '#e8fff1');
  // pantry upper cabinets
  r(444, 6, 56, 13, '#c4ad92');
  for (const x of [444, 458, 472, 486]) {
    r(x, 6, 1, 13, '#a99278');
    r(x + 10, 11, 1, 3, '#7b6650');
  }
  r(444, 19, 56, 1, '#a99278');
  activeTheme().decor?.paintStatic(g);
  return c;
}

/** Furniture pieces drawn in depth order with the characters. */
export function buildFurniture() {
  const items = [];
  const add = (sortY, draw) => items.push({ y: sortY, draw });

  // pantry counter with coffee machine, fridge
  add(63, (g, t, ctx) => {
    const r = paintFn(g);
    r(442, 44, 66, 6, '#a3826a');
    r(442, 44, 66, 1, '#bf9c82');
    r(442, 50, 66, 12, '#c4ad92');
    for (const x of [442, 458, 474, 490]) r(x, 50, 1, 12, '#a99278');
    r(448, 31, 12, 14, '#2d2f36');
    r(450, 34, 8, 4, '#4a4e5a');
    r(457, 33, 1, 1, ctx.coffeeBusy ? '#ffb347' : '#d97757');
    r(451, 41, 6, 3, '#f4f1ea');
    r(466, 39, 5, 5, '#f4f1ea');
    r(480, 40, 12, 4, '#e8a33d');
    r(482, 38, 3, 2, '#e5534b');
    r(487, 38, 3, 2, '#8fc93a');
    r(516, 12, 22, 52, '#e3e9ee');
    r(516, 12, 22, 1, '#f5f8fa');
    r(516, 32, 22, 1, '#b8c2ca');
    r(519, 20, 1, 8, '#9aa5ae');
    r(519, 36, 1, 12, '#9aa5ae');
    r(516, 63, 22, 1, '#9aa5ae');
  });

  // server rack beside DevOps (LEDs blink faster while commands run)
  add(236, (g, t, ctx) => {
    const r = paintFn(g);
    r(270, 200, 14, 36, '#23252e');
    r(270, 200, 14, 1, '#3a3d4a');
    for (let i = 0; i < 7; i++) {
      r(272, 203 + i * 4, 10, 3, '#30333f');
      const speed = ctx.rackBusy ? 110 : 600;
      r(273, 204 + i * 4, 1, 1, hash(i * 7 + Math.floor(t / speed)) > 0.4 ? '#3fb950' : '#1d3a24');
      r(275, 204 + i * 4, 1, 1, hash(i * 3 + Math.floor(t / (speed * 1.7))) > 0.6 ? '#f5a524' : '#3a2d14');
    }
  });

  // bookshelf
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

  // boss office: two leather guest chairs facing the executive desk
  add(146, (g) => {
    const r = paintFn(g);
    for (const x of [352, 392]) {
      r(x - 6, 134, 12, 4, '#6b3a2e');
      r(x - 6, 138, 12, 8, '#7d4636');
      r(x - 6, 138, 12, 1, '#94573f');
      r(x - 7, 136, 2, 10, '#5a2f25');
      r(x + 5, 136, 2, 10, '#5a2f25');
    }
  });
  add(203, (g) => {
    const glass = 'rgba(190,225,245,.35)';
    const frame = '#8fa3b5';
    const r = paintFn(g);
    r(304, 48, 2, 64, glass);
    r(304, 140, 2, 64, glass);
    r(304, 202, 128, 2, glass);
    r(430, 48, 2, 156, glass);
    for (const y of [48, 80, 111, 140, 172, 202]) r(304, y, 2, 2, frame);
    for (let x = 304; x <= 430; x += 32) r(x, 202, 2, 2, frame);
    for (const y of [48, 96, 144, 202]) r(430, y, 2, 2, frame);
  });

  // pantry: water cooler, cafe table, sofa, coffee table
  add(127, (g) => {
    const r = paintFn(g);
    r(526, 108, 12, 20, '#e3e9ee');
    r(526, 108, 12, 1, '#f5f8fa');
    r(528, 96, 8, 12, '#8fd0f0');
    r(529, 97, 2, 10, '#c4ecff');
    r(530, 114, 4, 2, '#3d85c6');
  });
  add(159, (g) => {
    const r = paintFn(g);
    for (const x of [458, 494]) {
      r(x - 4, 150, 9, 5, '#a7835f');
      r(x - 4, 150, 9, 1, '#c19b75');
    }
    r(467, 142, 18, 12, '#f2efe8');
    r(467, 142, 18, 1, '#ffffff');
    r(467, 154, 18, 2, '#d6d0c4');
    r(475, 156, 2, 3, '#8a8478');
    r(471, 145, 3, 3, '#7a4a2a');
  });
  add(247, (g) => {
    const r = paintFn(g);
    r(458, 222, 64, 12, '#4f7299');
    r(458, 222, 64, 2, '#6a8fb8');
    r(458, 234, 64, 8, '#5e83ad');
    r(458, 234, 64, 1, '#7aa0c9');
    r(458, 242, 64, 4, '#45678c');
    r(453, 226, 6, 20, '#45678c');
    r(521, 226, 6, 20, '#45678c');
    r(453, 226, 6, 2, '#5e83ad');
    r(521, 226, 6, 2, '#5e83ad');
    r(476, 225, 10, 7, '#f2c14e');
  });
  add(268, (g) => {
    const r = paintFn(g);
    r(470, 258, 40, 7, '#a7835f');
    r(470, 258, 40, 1, '#c19b75');
    r(470, 265, 40, 2, '#86643f');
    r(478, 255, 4, 3, '#f4f1ea');
    r(494, 256, 8, 2, '#3d85c6');
  });

  // plants (sway gently)
  for (const [x, y] of [[290, 66], [12, 282], [296, 284], [420, 198], [536, 204]]) {
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
  for (const wx of [40, 252]) {
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
  r(334, 10, 64, 26, '#0f1a2b');
  r(336, 12, 18, 2, '#d97757');
  if (activity.busy && Math.floor(t / 500) % 2) r(392, 12, 3, 3, '#f0524a');
  activity.bars.forEach((v, i) => {
    const bh = Math.max(1, Math.round(v * 16));
    r(337 + i * 5, 33 - bh, 4, bh, i === activity.bars.length - 1 ? '#66d9e8' : '#3d85c6');
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
  for (const [x, y] of [[80, 128], [200, 128], [80, 200], [200, 200], [368, 120], [490, 170], [140, 272], [490, 250]]) glow(x, y, 70, lamp);
  for (const { x, y, color } of glows) glow(x, y, 24, color);
  g.globalCompositeOperation = 'source-over';
}

/** Daylight falling through the two windows onto the floor. */
function sunBeams(g, color) {
  g.fillStyle = color;
  for (const wx of [40, 252]) {
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
  for (const [x, y] of [[80, 128], [200, 128], [80, 200], [200, 200], [368, 120], [490, 170]]) glow(x, y, 64, lamp);
  for (const l of themed.decor?.lights(t) ?? []) glow(l.x, l.y, l.radius, l.color);
  for (const { x, y, color } of glows) glow(x, y, 24, color);
  g.globalCompositeOperation = 'source-over';
}
