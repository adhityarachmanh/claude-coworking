// Visual check of the pixel office: starts the real server (fake Claude Code, throwaway data) and a headless
// Chrome, then writes PNG screenshots per theme × viewport plus an enlarged sprite sheet.
//   node test-support/office-shots.mjs <outDir> [themes=kantor,halloween,natal,lebaran,agustus]
//   node test-support/office-shots.mjs --fingerprint    # prints render hashes (regression check for a theme)
//   node test-support/office-shots.mjs --fingerprint --per-role   # one character/avatar hash per role (+ visitor)
//   node test-support/office-shots.mjs <outDir> [themes] --sheets [--roles=mobile,data]   # sprite sheets only
// Output goes wherever <outDir> points — keep it outside the repo (e.g. %TEMP%).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer(tmp, port) {
  mkdirSync(path.join(tmp, 'projects', 'toko'), { recursive: true });
  mkdirSync(path.join(tmp, 'claude-projects'), { recursive: true });
  const server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(tmp, 'data'),
      PROJECTS_ROOT: path.join(tmp, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(tmp, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(tmp, 'no-such-claude.json'),
      OFFICE_OPEN_DRY_RUN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  server.stderr.resume();
  return server;
}

// ---------- in-page helpers (serialised into the page: self-contained) ----------

/** Hashes of everything the office paints from fixed inputs (background, sprites, furniture, lighting). */
async function fingerprint() {
  const sprites = await import('/js/office/sprites.js');
  const world = await import('/js/office/world.js');
  const { CAST, ROLE_ORDER, VISITOR } = await import('/js/office/cast.js');
  const hash = async (text) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const url = (c) => c.toDataURL();
  const out = {};
  out.background = await hash(url(world.renderBackground()));
  const looks = [...ROLE_ORDER.map((id) => CAST[id].look), VISITOR.look];
  const states = [];
  for (const view of ['down', 'up', 'left', 'right']) {
    for (const pose of ['stand', 'walk', 'sit', 'sofa']) {
      for (const arms of ['down', 'type', 'cheer', 'raise', 'hold', 'scratch']) {
        for (const frame of [0, 1, 2]) states.push({ view, pose, arms, frame, item: arms === 'hold' ? 'cup' : '', blink: frame === 2, talk: frame === 1, mood: ['', 'happy', 'worried'][frame] });
      }
    }
  }
  let all = '';
  for (const look of looks) for (const s of states) all += url(sprites.characterSprite(look, s));
  out.characters = await hash(all);
  out.avatars = await hash(looks.map((l) => sprites.avatarURL(l)).join());
  let cats = '';
  for (const st of ['sleep', 'sit', 'walk']) for (const f of [0, 1]) for (const flip of [false, true]) cats += url(sprites.catSprite(st, f, flip));
  out.cat = await hash(cats);
  const c = document.createElement('canvas');
  c.width = world.W;
  c.height = world.H;
  const g = c.getContext('2d');
  for (const item of world.buildFurniture()) item.draw(g, 1234, { rackBusy: true, coffeeBusy: false });
  for (const desk of Object.values(world.DESKS)) {
    if (desk.boss) {
      world.drawBossChair(g, desk.seat);
      world.drawBossDesk(g, desk, true, 1500);
    } else {
      world.drawDesk(g, desk);
      world.drawMonitors(g, desk, 'code', 1234, 7);
      world.drawChair(g, desk.seat, false);
    }
  }
  world.drawDoor(g, false);
  world.drawDoor(g, true);
  out.furniture = await hash(url(c));
  const day = new Date(2026, 5, 1, 12, 0);
  const night = new Date(2026, 5, 1, 22, 0);
  g.clearRect(0, 0, c.width, c.height);
  const l1 = world.drawWallLive(g, 1000, day, { busy: true, bars: [0.2, 0.5, 1] });
  world.drawLighting(g, l1, [{ x: 50, y: 60, color: 'rgba(130,170,255,.18)' }]);
  const l2 = world.drawWallLive(g, 1000, night, { busy: false, bars: [] });
  world.drawLighting(g, l2, [{ x: 50, y: 60, color: 'rgba(130,170,255,.18)' }]);
  out.wallAndLighting = await hash(url(c));
  return out;
}

/** Per-role hashes of every character sprite state + the avatar (adding a role must leave the others alone). */
async function fingerprintPerRole() {
  const sprites = await import('/js/office/sprites.js');
  const { CAST, ROLE_ORDER, VISITOR } = await import('/js/office/cast.js');
  const hash = async (text) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const states = [];
  for (const view of ['down', 'up', 'left', 'right']) {
    for (const pose of ['stand', 'walk', 'sit', 'sofa']) {
      for (const arms of ['down', 'type', 'cheer', 'raise', 'hold', 'scratch']) {
        for (const frame of [0, 1, 2]) states.push({ view, pose, arms, frame, item: arms === 'hold' ? 'cup' : '', blink: frame === 2, talk: frame === 1, mood: ['', 'happy', 'worried'][frame] });
      }
    }
  }
  const out = {};
  for (const [id, look] of [...ROLE_ORDER.map((r) => [r, CAST[r].look]), ['visitor', VISITOR.look]]) {
    let all = '';
    for (const s of states) all += sprites.characterSprite(look, s).toDataURL();
    out[id] = `${await hash(all)}/${await hash(sprites.avatarURL(look))}`;
  }
  return out;
}

/** Enlarged sheet: every role in the main poses (rows) — returns a PNG data URL. */
async function spriteSheet(scale, only = null) {
  const sprites = await import('/js/office/sprites.js');
  const { CAST, ROLE_ORDER, VISITOR } = await import('/js/office/cast.js');
  const states = [
    { view: 'down', pose: 'stand' },
    { view: 'down', pose: 'stand', mood: 'happy', talk: true },
    { view: 'down', pose: 'stand', blink: true },
    { view: 'down', pose: 'walk', frame: 1 },
    { view: 'left', pose: 'walk', frame: 1 },
    { view: 'right', pose: 'walk', frame: 2 },
    { view: 'up', pose: 'walk', frame: 1 },
    { view: 'up', pose: 'sit', arms: 'type', frame: 0 },
    { view: 'down', pose: 'sit', arms: 'type', frame: 1 },
    { view: 'down', pose: 'sofa', arms: 'hold', item: 'cup' },
    { view: 'down', pose: 'stand', arms: 'raise' },
    { view: 'down', pose: 'stand', arms: 'cheer', mood: 'happy' },
    { view: 'left', pose: 'stand', arms: 'hold', item: 'paper' },
    { view: 'down', pose: 'stand', mood: 'worried', arms: 'scratch' },
  ];
  const looks = only ? only.map((id) => CAST[id].look) : [...ROLE_ORDER.map((id) => CAST[id].look), VISITOR.look];
  const cw = 22;
  const ch = 34;
  const c = document.createElement('canvas');
  c.width = (states.length * cw + 2) * scale;
  c.height = (looks.length * ch + 2 + 14) * scale;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#6d6a75';
  g.fillRect(0, 0, c.width, c.height);
  looks.forEach((look, row) => {
    states.forEach((s, col) => {
      g.fillStyle = (row + col) % 2 ? '#7d7a86' : '#8a8794';
      g.fillRect((1 + col * cw) * scale, (1 + row * ch) * scale, cw * scale, ch * scale);
      const sp = sprites.characterSprite(look, s);
      g.drawImage(sp, (2 + col * cw) * scale, (2 + row * ch) * scale, sp.width * scale, sp.height * scale);
    });
  });
  // cats
  ['sleep', 'sit', 'walk'].forEach((st, i) => {
    const sp = sprites.catSprite(st, 0, false);
    g.drawImage(sp, (2 + i * 20) * scale, (2 + looks.length * ch) * scale, sp.width * scale, sp.height * scale);
  });
  return c.toDataURL('image/png');
}

/** Sends every role to its desk to type (live tool_start events) in the visible scene. */
async function everyoneTypes() {
  const { scenes } = await import('/js/core/scenes.js');
  const { state } = await import('/js/core/state.js');
  const { ROLE_ORDER } = await import('/js/office/cast.js');
  const scene = scenes.get(state.active);
  for (const role of ROLE_ORDER) scene.handle({ kind: 'tool_start', role, label: 'npm test', tool: 'Bash' });
  return state.active;
}

/** A few people walk across the floor. */
async function someoneWalks() {
  const { scenes } = await import('/js/core/scenes.js');
  const { state } = await import('/js/core/state.js');
  const scene = scenes.get(state.active);
  const targets = { 'ui-ux': [120, 260], frontend: [470, 190], backend: [250, 120], qa: [380, 250], security: [60, 190], writer: [520, 150] };
  for (const [role, [x, y]] of Object.entries(targets)) {
    const p = scene.people[role];
    p.openTools = 0;
    p.busyUntil = 0;
    p.go([{ type: 'walk', x, y }]);
  }
}

// ---------- main ----------

const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const fingerprintOnly = flags.includes('--fingerprint');
const perRole = flags.includes('--per-role');
const sheetsOnly = flags.includes('--sheets');
const onlyRoles = flags.find((f) => f.startsWith('--roles='))?.slice(8).split(',') ?? null;
const outDir = fingerprintOnly ? null : path.resolve(args[0] ?? path.join(tmpdir(), 'office-shots'));
const themes = (args[1] ?? 'kantor,halloween,natal,lebaran,agustus').split(',');
const tmp = mkdtempSync(path.join(tmpdir(), 'office-shots-data-'));
const port = await freePort();
const base = `http://localhost:${port}`;
const server = await startServer(tmp, port);
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  if (fingerprintOnly) {
    await page.setViewport(VIEWPORTS[0]);
    await page.goto(`${base}/`);
    await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000 });
    for (const theme of themes) {
      await page.eval((t) => localStorage.setItem('office.theme', t), theme);
      await page.goto(`${base}/`);
      await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000 });
      console.log(theme, JSON.stringify(await page.eval(perRole ? fingerprintPerRole : fingerprint)));
    }
  } else if (sheetsOnly) {
    // Just the enlarged sprite sheets (optionally a few roles): no waiting for people to walk to their desks.
    mkdirSync(outDir, { recursive: true });
    await page.setViewport(VIEWPORTS[0]);
    for (const theme of themes) {
      await page.goto(`${base}/`);
      await page.eval((t) => localStorage.setItem('office.theme', t), theme);
      await page.goto(`${base}/`);
      await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000 });
      const sheet = await page.eval(spriteSheet, 5, onlyRoles);
      writeFileSync(path.join(outDir, `${theme}-sprites${onlyRoles ? '-' + onlyRoles.join('_') : ''}.png`), Buffer.from(sheet.split(',')[1], 'base64'));
    }
    console.log(`PNG ditulis ke ${outDir}`);
  } else {
    mkdirSync(outDir, { recursive: true });
    for (const theme of themes) {
      for (const vp of VIEWPORTS) {
        const page = await browser.newPage(); // fresh tab per shot: no state carried over between viewports
        await page.setViewport(vp);
        await page.goto(`${base}/`);
        await page.eval((t) => localStorage.setItem('office.theme', t), theme);
        await page.goto(`${base}/`);
        await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000 });
        if (vp.mobile) await page.click('#mobile-nav button[data-view="office"]');
        await sleep(800);
        await page.eval(everyoneTypes);
        await sleep(9000); // everyone walks to their desk
        writeFileSync(path.join(outDir, `${theme}-${vp.name}-typing.png`), await page.screenshot());
        const box = await page.eval(() => {
          const r = document.querySelector('#stage canvas').getBoundingClientRect();
          return { x: r.left, y: r.top, width: r.width, height: r.height };
        });
        writeFileSync(path.join(outDir, `${theme}-${vp.name}-office-zoom.png`), (await page.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: vp.mobile ? 1 : 1.4 } }).then((r) => Buffer.from(r.data, 'base64'))));
        await page.eval(someoneWalks);
        await sleep(700);
        writeFileSync(path.join(outDir, `${theme}-${vp.name}-walking.png`), await page.screenshot({ clip: box }));
        if (!vp.mobile) {
          const sheet = await page.eval(spriteSheet, 5);
          writeFileSync(path.join(outDir, `${theme}-sprites.png`), Buffer.from(sheet.split(',')[1], 'base64'));
        }
        await page.close();
      }
    }
    console.log(`PNG ditulis ke ${outDir}`);
  }
  await page.close();
} finally {
  await browser.close().catch(() => {});
  server.kill();
  await sleep(300);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows may still hold a file for a moment; the OS temp cleaner gets it
  }
}
