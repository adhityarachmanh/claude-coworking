// Office scene logic (no canvas needed): who counts as "working" while the chat is still loading;
// office themes (registry, costume painters).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CAST, ROLE_ORDER, VISITOR } from '../public/js/office/cast.js';
import { COSTUMES } from '../public/js/office/costumes.js';
import { Scene } from '../public/js/office/scene.js';
import { spriteLift } from '../public/js/office/sprites.js';
import { THEMES, THEME_IDS, activeTheme, isTheme, theme, themedLook } from '../public/js/office/themes.js';
import { fitLabels, labelVariants, sharedPrefix } from '../public/js/office/tags.js';
import { H, W, WINDOWS } from '../public/js/office/world.js';

/** Every theme that dresses the team up (all but the plain office). */
const COSTUMED = THEME_IDS.filter((id) => id !== 'kantor');

/** Runs `fn` with performance.now() frozen at `ms`, so busy timers can be checked deterministically. */
function at(ms, fn) {
  const real = performance.now;
  performance.now = () => ms;
  try {
    return fn();
  } finally {
    performance.now = real;
  }
}

test('a long-running tool keeps its role busy until it ends, not just for 9 s', () => {
  const scene = at(0, () => new Scene());
  const qa = scene.people.qa;
  at(1_000, () => scene.handle({ kind: 'tool_start', role: 'qa', label: 'npm test', tool: 'Bash' }));
  assert.ok(qa.isBusy(5_000), 'busy right after starting');
  assert.ok(qa.isBusy(60_000), 'still busy a minute later: the tool has not finished');
  at(60_000, () => scene.handle({ kind: 'tool_end', role: 'qa', label: 'npm test', tool: 'Bash' }));
  assert.ok(qa.isBusy(62_000), 'short wind-down after the tool ends');
  assert.ok(!qa.isBusy(70_000), 'idle again once done');
});

test('parallel tools: busy until the last one ends; a failed tool counts as ended', () => {
  const scene = at(0, () => new Scene());
  const be = scene.people.backend;
  at(0, () => {
    scene.handle({ kind: 'tool_start', role: 'backend', label: 'a', tool: 'Bash' });
    scene.handle({ kind: 'tool_start', role: 'backend', label: 'b', tool: 'Bash' });
  });
  at(30_000, () => scene.handle({ kind: 'tool_fail', role: 'backend', label: 'a', tool: 'Bash' }));
  assert.ok(be.isBusy(50_000), 'one tool still running');
  at(50_000, () => scene.handle({ kind: 'tool_end', role: 'backend', label: 'b', tool: 'Bash' }));
  assert.ok(!be.isBusy(60_000));
  at(60_000, () => scene.handle({ kind: 'tool_end', role: 'backend', label: 'extra', tool: 'Bash' }));
  assert.equal(be.openTools, 0, 'an unmatched end never goes negative');
});

test('end of turn / stop clears tools that never reported back', () => {
  const scene = at(0, () => new Scene());
  at(0, () => scene.handle({ kind: 'tool_start', role: 'devops', label: 'build', tool: 'Bash' }));
  at(20_000, () => scene.handle({ kind: 'stop', role: 'claude', label: 'Selesai', activeRoles: [] }));
  assert.ok(!scene.people.devops.isBusy(40_000));
  at(40_000, () => scene.handle({ kind: 'tool_start', role: 'devops', label: 'build', tool: 'Bash' }));
  at(41_000, () => scene.handle({ kind: 'halt', role: 'claude' }));
  assert.ok(!scene.people.devops.isBusy(50_000));
});

test('replayed history (not live) does not leave anyone typing forever', () => {
  const scene = at(0, () => new Scene());
  at(0, () => scene.handle({ kind: 'tool_start', role: 'qa', label: 'npm test', tool: 'Bash' }, false));
  assert.ok(!scene.people.qa.isBusy(30_000));
});

test('thinking keeps the role at work and sends it back to its desk', () => {
  const scene = at(0, () => new Scene());
  const lead = scene.people.claude;
  at(0, () => lead.go([{ type: 'walk', x: lead.seat.x + 40, y: lead.seat.y + 40 }]));
  at(1_000, () => scene.handle({ kind: 'think', role: 'claude' }));
  assert.ok(lead.isBusy(3_000));
  assert.ok(lead.headingHome() || lead.seated, 'walks back to the desk');
});

test('after a page refresh the server status (working) puts mid-task characters back to work', () => {
  const scene = at(0, () => new Scene());
  // replayed history is not live: on its own it would leave everyone idle
  at(0, () => scene.handle({ kind: 'tool_start', role: 'qa', label: 'npm test', tool: 'Bash' }, false));
  at(0, () => scene.setStatus({ busy: true, working: { qa: { tools: 1, agents: 0, label: 'npm test' }, frontend: { tools: 0, agents: 1, label: 'Pecah app.js' } }, cliWorking: {} }));
  assert.ok(scene.people.qa.isBusy(60_000), 'qa keeps typing while its tool runs');
  assert.ok(scene.people.frontend.isBusy(60_000), 'a running subagent keeps its role busy');
  assert.equal(scene.people.qa.task, 'npm test', 'task label restored for the team card');
  assert.ok(!scene.people.backend.isBusy(60_000));
  // the server says the tool ended → idle (no stale count left behind)
  at(60_000, () => scene.setStatus({ busy: false, working: {}, cliWorking: {} }));
  assert.ok(!scene.people.qa.isBusy(70_000));
  // terminal (CLI mirror) work counts too
  at(70_000, () => scene.setStatus({ busy: false, working: {}, cliWorking: { devops: { tools: 1, agents: 0, label: 'build' } } }));
  assert.ok(scene.people.devops.isBusy(80_000));
});

// ---------- themes (registry and costume painters; sprites themselves are checked in the browser: ui.test.mjs) ----------

/** Runs `fn` with `theme.current = id`, restoring the default afterwards. */
function withTheme(id, fn) {
  const before = theme.current;
  theme.current = id;
  try {
    return fn();
  } finally {
    theme.current = before;
  }
}

test('theme registry: kantor is the default and leaves every look untouched', () => {
  assert.equal(theme.current, 'kantor');
  assert.deepEqual(THEME_IDS, ['kantor', 'halloween', 'natal', 'lebaran', 'agustus']);
  assert.ok(THEME_IDS.every(isTheme) && !isTheme('toString') && !isTheme('nope'));
  for (const id of ROLE_ORDER) assert.equal(themedLook(CAST[id].look), CAST[id].look, `${id}: same object, so sprites are identical`);
  assert.equal(themedLook(VISITOR.look), VISITOR.look);
  for (const t of Object.values(THEMES)) for (const key of ['id', 'label', 'icon', 'looks', 'cat']) assert.ok(key in t, `${t.id}.${key}`);
});

for (const id of COSTUMED) {
  test(`${id}: every role has its own costume and keeps its role colour as an accent`, () => {
    withTheme(id, () => {
    assert.equal(activeTheme().id, id);
    const ids = new Set();
    for (const role of ROLE_ORDER) {
      const look = themedLook(CAST[role].look);
      assert.ok(look.costume, `${role} has a costume`);
      assert.ok(COSTUMES[look.costume], `${role}: costume "${look.costume}" has a painter`);
      assert.equal(look.id, `${role}@${id}`, 'own sprite cache key');
      assert.ok(Object.values(look).includes(CAST[role].color), `${role}: role colour ${CAST[role].color} used in the costume`);
      assert.equal(themedLook(CAST[role].look), look, 'memoised');
      ids.add(look.id);
    }
    assert.equal(ids.size, ROLE_ORDER.length);
    });
  });
}

test('halloween ghosts float (gentle bob), everyone else stays on the floor', () => {
  for (const role of ROLE_ORDER) assert.equal(spriteLift(CAST[role].look, 1234), 0, `kantor: ${role} on the floor`);
  withTheme('halloween', () => {
    for (const role of ROLE_ORDER) {
      const floats = Boolean(themedLook(CAST[role].look).float);
      const lifts = new Set(Array.from({ length: 40 }, (_, i) => spriteLift(CAST[role].look, i * 97)));
      if (floats) {
        assert.ok(lifts.size > 1, `${role}: bobs`);
        for (const v of lifts) assert.ok(v >= -1 && v <= 3, `${role}: small lift (${v})`);
      } else assert.deepEqual([...lifts], [0], `${role}: no lift`);
    }
    assert.ok(['ui-ux', 'qa', 'writer'].every((r) => themedLook(CAST[r].look).float), 'the ghosts float');
  });
  for (const id of COSTUMED.filter((t) => t !== 'halloween')) {
    withTheme(id, () => {
      for (const role of ROLE_ORDER) assert.equal(spriteLift(CAST[role].look, 1234), 0, `${id}: ${role} on the floor`);
    });
  }
});

for (const id of COSTUMED) {
  test(`${id} costume painters: every role × view × pose × arms paints inside the 20×32 sprite`, () => {
    withTheme(id, () => {
    const noItem = () => {};
    for (const role of ROLE_ORDER) {
      const look = themedLook(CAST[role].look);
      const cos = COSTUMES[look.costume];
      for (const view of ['down', 'up', 'left']) {
        for (const pose of ['stand', 'walk', 'sit', 'sofa']) {
          for (const arms of ['down', 'type', 'cheer', 'raise', 'hold', 'scratch']) {
            for (const f of [0, 1, 2]) {
              const seated = pose === 'sit' || pose === 'sofa';
              const headY = seated ? 6 : 3;
              const s = { view, pose, arms, frame: f, blink: f === 2, talk: f === 1, mood: ['', 'happy', 'worried'][f], item: arms === 'hold' ? 'cup' : '' };
              const ctx = { view, s, headY, torsoY: headY + 12, torsoH: seated ? 6 : 7, seated, arms, f, sleeve: look.top, paintItem: noItem };
              let pixels = 0;
              // Sprite canvas is 32 tall with a 2px top pad: painter y runs from -2 to 29.
              const p = (x, y, w, h, color) => {
                if (!color || w <= 0 || h <= 0) return;
                pixels++;
                const where = `${role} ${view}/${pose}/${arms}/${f}: rect ${x},${y} ${w}×${h}`;
                assert.ok(x >= 0 && x + w <= 20 && y >= -2 && y + h <= 30, `outside the sprite — ${where}`);
              };
              if (cos.ghost) cos.paint(p, look, ctx);
              else for (const hook of ['back', 'body', 'head', 'front', 'arms', 'after']) cos[hook]?.(p, look, ctx);
              assert.ok(pixels > 0 || !cos.ghost, `${role}: ghost painted something`);
            }
          }
        }
      }
    }
    });
  });
}

/** Canvas stand-in that checks every fillRect lands inside a box (decor painters use g.fillRect via rect()). */
function boxGraphics(box, label) {
  let pixels = 0;
  return {
    get pixels() {
      return pixels;
    },
    fillStyle: '',
    fillRect(x, y, w, h) {
      if (w <= 0 || h <= 0) return;
      pixels++;
      assert.ok(x >= box.x && y >= box.y && x + w <= box.x + box.w && y + h <= box.y + box.h, `${label}: rect ${x},${y} ${w}×${h} outside ${JSON.stringify(box)}`);
    },
  };
}

test('theme cats: accessories stay inside the 16×12 cat sprite; every new theme dresses the cat', () => {
  for (const id of THEME_IDS) {
    const { cat } = THEMES[id];
    for (const key of ['fur', 'stripe', 'eye', 'closed', 'nose', 'outline']) assert.match(cat[key], /^#[0-9a-f]{6}$/, `${id}.cat.${key}`);
    if (!cat.wear) continue;
    for (const state of ['sleep', 'sit', 'walk']) {
      const g = boxGraphics({ x: 0, y: 0, w: 16, h: 12 }, `${id} cat ${state}`);
      cat.wear((x, y, w, h, c) => {
        g.fillStyle = c;
        g.fillRect(x, y, w, h);
      }, state);
      assert.ok(g.pixels > 0, `${id}: cat wears something when ${state}`);
    }
  }
  assert.ok(['natal', 'lebaran', 'agustus'].every((id) => THEMES[id].cat.wear), 'Santa hat, peci, bandana');
  assert.equal(new Set(THEME_IDS.map((id) => THEMES[id].cat.fur)).size, THEME_IDS.length, 'a different cat per theme');
});

test('theme decor: window views stay inside the glass, scenery stays inside the office, at any moment', () => {
  // Halloween's bats fly in from outside the office on purpose; the newer themes keep everything inside.
  for (const id of COSTUMED.filter((t) => t !== 'halloween')) {
    const { decor, sky, light } = THEMES[id];
    assert.ok(sky && light && decor, `${id}: sky, light and decor`);
    for (const t of [0, 450, 1300, 2600, 4100, 5000, 9999, 123456]) {
      if (decor.sky) {
        for (const wx of WINDOWS) {
          const g = boxGraphics({ x: wx + 2, y: 11, w: 44, h: 22 }, `${id} sky @${t}`);
          decor.sky((x, y, w, h) => g.fillRect(x, y, w, h), sky, wx, t);
          assert.ok(g.pixels > 0);
        }
      }
      const office = boxGraphics({ x: 0, y: 0, w: W, h: H }, `${id} decor @${t}`);
      decor.overlay(office, t);
      for (const item of decor.furniture()) {
        assert.ok(Number.isFinite(item.y), `${id}: furniture has a sort depth`);
        item.draw(office, t);
      }
      for (const l of decor.lights(t)) assert.ok(l.radius > 0 && l.color.startsWith('rgba('), `${id}: glow`);
    }
    const bg = boxGraphics({ x: 0, y: 0, w: W, h: H }, `${id} static`);
    decor.paintStatic(bg);
    assert.ok(bg.pixels > 0, `${id}: static scenery`);
  }
});

test('a turn cut short by a server restart: the lead shows the waiting sign until it is continued', () => {
  const scene = at(0, () => new Scene());
  const lead = scene.people.claude;
  at(1_000, () => scene.setStatus({ busy: false, interrupted: { reason: 'shutdown', sessionId: 's1' } }));
  assert.equal(lead.icon?.name, 'ask');
  assert.match(lead.bubble?.text ?? '', /terputus/);
  at(2_000, () => scene.setStatus({ busy: true, interrupted: null }));
  assert.equal(lead.icon, null, 'sign gone once the turn continues');
});

// ---------- the four roles added later (mobile, data, support, reviewer) ----------

const NEW_ROLES = ['mobile', 'data', 'support', 'reviewer'];
// …and the optional 17th (off by default): same rules for colour, costumes and sprites.
const LATER_ROLES = [...NEW_ROLES, 'compliance'];
const ORIGINAL_ROLES = ['claude', 'pm', 'ba', 'architect', 'ui-ux', 'frontend', 'backend', 'dba', 'qa', 'security', 'devops', 'writer', 'freelancer'];

/** "Redmean" RGB distance: cheap perceptual colour difference (the original 13 role colours are ≥ 62 apart). */
function colourDistance(a, b) {
  const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16));
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const rm = (r1 + r2) / 2;
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}

test('new roles: appended after the original 13 (order unchanged) with names, titles and distinct colours', () => {
  assert.deepEqual(ROLE_ORDER.slice(0, ORIGINAL_ROLES.length), ORIGINAL_ROLES, 'the original order is untouched');
  for (const id of NEW_ROLES) assert.ok(ROLE_ORDER.includes(id), `${id} in ROLE_ORDER`);
  assert.deepEqual(
    NEW_ROLES.map((id) => CAST[id].name),
    ['Adhitron - Mobile', 'Adhitron - Data/AI', 'Adhitron - Support', 'Adhitron - Reviewer'],
  );
  assert.equal(ROLE_ORDER.at(-1), 'compliance', 'the 17th role is appended last');
  assert.deepEqual([CAST.compliance.name, CAST.compliance.title], ['Adhitron - Compliance', 'Compliance / Privacy (DPO)']);
  const colours = ROLE_ORDER.map((id) => CAST[id].color);
  assert.equal(new Set(colours).size, colours.length, 'one colour per role');
  for (const id of LATER_ROLES) {
    const { color, title, look } = CAST[id];
    assert.match(color, /^#[0-9a-f]{6}$/);
    assert.ok(title && look.id === id, `${id}: title and look id`);
    for (const other of ROLE_ORDER.filter((r) => r !== id)) {
      const d = colourDistance(color, CAST[other].color);
      assert.ok(d >= 75, `${id} ${color} too close to ${other} ${CAST[other].color} (${d.toFixed(0)})`);
    }
    for (const key of ['skin', 'skinShade', 'hair', 'hairShade', 'top', 'topShade', 'pants', 'shoes']) assert.match(look[key], /^#[0-9a-f]{6}$/, `${id}.${key}`);
  }
  assert.ok(Object.values(CAST.data.look).includes(CAST.data.color) && CAST.mobile.look.top === CAST.mobile.color, 'role colour worn in the office');
});

test('new roles: a costume of their own in every theme (no copy of another role in the same theme)', () => {
  for (const id of COSTUMED) {
    withTheme(id, () => {
      const looks = ROLE_ORDER.map((role) => themedLook(CAST[role].look));
      for (const role of LATER_ROLES) {
        const look = themedLook(CAST[role].look);
        const { id: _id, ...mine } = look;
        for (const other of looks.filter((l) => l !== look)) {
          const { id: _o, ...theirs } = other;
          assert.notDeepEqual(mine, theirs, `${id}: ${role} looks exactly like ${other.id}`);
        }
      }
    });
  }
  // Each new Halloween costume is new (no second witch/mummy/ghost…); the props reflect the role.
  withTheme('halloween', () => assert.deepEqual(NEW_ROLES.map((r) => themedLook(CAST[r].look).costume), ['imp', 'bat', 'scarecrow', 'owl']));
  withTheme('agustus', () => assert.deepEqual(NEW_ROLES.map((r) => themedLook(CAST[r].look).prop ?? themedLook(CAST[r].look).costume), ['kerupuk', 'tambang', 'bakiak', 'juri']));
});

/**
 * Minimal canvas stand-in for sprites.js in Node: records every fillRect (with the current translation) so a
 * whole character — base painter, accessories, gadgets and costume hooks — can be checked against its canvas.
 */
function fakeDocument(onRect) {
  return {
    createElement() {
      const c = { width: 0, height: 0, ops: [] };
      let ty = 0;
      const g = {
        fillStyle: '',
        globalAlpha: 1,
        imageSmoothingEnabled: true,
        translate(_x, y) {
          ty += y;
        },
        setTransform() {
          ty = 0;
        },
        scale() {},
        clearRect() {},
        drawImage(src) {
          c.ops.push(`img:${src.ops?.length ?? 0}:${src.ops?.join(';') ?? ''}`);
        },
        fillRect(x, y, w, h) {
          c.ops.push(`${x},${y + ty},${w},${h},${g.fillStyle}`);
          onRect(c, x, y + ty, w, h);
        },
        getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      };
      c.getContext = () => g;
      c.toDataURL = () => `fake:${c.ops.join(';')}`;
      return c;
    },
  };
}

test('new roles: every theme × view × pose × arms paints inside the 20×32 sprite (base look, accessories, phone); avatars change per theme', async () => {
  const { characterSprite, avatarURL, clearSpriteCache } = await import('../public/js/office/sprites.js');
  const before = globalThis.document;
  let where = '';
  globalThis.document = fakeDocument((c, x, y, w, h) => {
    if (c.width !== 20 || c.height !== 32) return; // avatar canvas: drawImage only
    assert.ok(x >= 0 && y >= 0 && x + w <= 20 && y + h <= 32, `outside the sprite — ${where}: rect ${x},${y} ${w}×${h}`);
  });
  try {
    const avatars = {};
    for (const id of THEME_IDS) {
      withTheme(id, () => {
        clearSpriteCache();
        for (const role of LATER_ROLES) {
          const look = CAST[role].look;
          for (const view of ['down', 'up', 'left', 'right']) {
            for (const pose of ['stand', 'walk', 'sit', 'sofa']) {
              for (const arms of ['down', 'type', 'cheer', 'raise', 'hold', 'scratch']) {
                for (const frame of [0, 1, 2]) {
                  where = `${id} ${role} ${view}/${pose}/${arms}/${frame}`;
                  const sprite = characterSprite(look, { view, pose, arms, frame, item: arms === 'hold' ? 'cup' : '', blink: frame === 2, talk: frame === 1, mood: ['', 'happy', 'worried'][frame] });
                  assert.ok(sprite.ops.join(';').split(',').length > 40, `${where}: painted`); // mirrored sprites hold one drawImage of the painted one
                }
              }
            }
          }
          (avatars[role] ??= []).push(avatarURL(look));
        }
      });
    }
    for (const role of LATER_ROLES) assert.equal(new Set(avatars[role]).size, THEME_IDS.length, `${role}: a different avatar in every theme`);
    // The office phone (mobile) and headset (support) are really painted in the Kantor look.
    clearSpriteCache();
    const stand = { view: 'down', pose: 'stand' };
    const ops = (look) => characterSprite(look, stand).ops.join(';');
    assert.match(ops(CAST.mobile.look), /#8fd3ff/, 'phone screen');
    assert.match(ops(CAST.support.look), /#dfe3e8/, 'headset ear cups');
    assert.match(ops(CAST.data.look), /#f1e8d6/, 'shirt under the cardigan');
  } finally {
    clearSpriteCache();
    globalThis.document = before;
  }
});

test('name tags: the prefix the whole team shares is computed from the current names, not hardcoded', () => {
  assert.equal(sharedPrefix(ROLE_ORDER.map((id) => CAST[id].name)), 'Adhitron - ', 'default names');
  assert.equal(sharedPrefix(['Tim Rina - PM', 'Tim Rina - DBA', 'Tim Rina - Data']), 'Tim Rina - ', 'renamed team');
  assert.equal(sharedPrefix(['Adhitron - PM', 'Budi', 'Adhitron - QA']), '', 'one renamed person: no shared prefix');
  assert.equal(sharedPrefix(['Adhitron - Data', 'Adhitron - DBA']), 'Adhitron - ', 'cut back to the separator, not mid-word');
  assert.equal(sharedPrefix(['Dewi Ayu', 'Dewi Sari']), '', 'a common first word without a separator is part of the name');
  assert.equal(sharedPrefix(['Adhitron - PM', 'Adhitron - ']), '', 'nothing may be left empty');
  assert.equal(sharedPrefix(['Adhitron - PM']), '', 'a single name keeps its prefix');
  assert.deepEqual(labelVariants({ name: 'Adhitron - Frontend', short: 'FE', count: 2 }, 'Adhitron - '), ['Adhitron - Frontend ×2', 'Frontend ×2', 'FE ×2']);
  assert.deepEqual(labelVariants({ name: 'Budi', short: '' }, ''), ['Budi', 'Budi', 'Budi'], 'no short title: the name');
  for (const id of ROLE_ORDER) assert.ok(CAST[id].short && CAST[id].short.length <= 4, `${id}: a short title of at most 4 characters`);
  assert.equal(new Set(ROLE_ORDER.map((id) => CAST[id].short)).size, ROLE_ORDER.length, 'short titles are distinct');
});

test('name tags: full names while they fit, else the team drops its prefix, else the colliding tags go short', () => {
  const item = (x, widths) => ({ x, y: 0, h: 8, widths });
  assert.deepEqual(fitLabels([item(0, [40, 20, 10]), item(100, [40, 20, 10])]), [0, 0], 'room enough: full names');
  assert.deepEqual(fitLabels([item(0, [40, 20, 10]), item(36, [40, 20, 10]), item(200, [40, 20, 10])]), [1, 1, 1], 'one collision: the whole team drops the prefix');
  assert.deepEqual(fitLabels([item(0, [40, 30, 10]), item(26, [40, 20, 10]), item(200, [40, 20, 10])]), [2, 1, 1], 'still colliding: the wider tag goes short');
  assert.deepEqual(fitLabels([item(0, [9, 9, 9]), item(1, [9, 9, 9])]), [2, 2], 'nothing left to shrink: ends anyway');
  assert.deepEqual(fitLabels([item(0, [40, 20, 10]), { x: 0, y: 50, h: 8, widths: [40, 20, 10] }]), [0, 0], 'different rows never collide');
});
