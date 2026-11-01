// Office scene logic (no canvas needed): who counts as "working" while the chat is still loading;
// office themes (registry, costume painters).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CAST, ROLE_ORDER, VISITOR } from '../public/js/office/cast.js';
import { COSTUMES } from '../public/js/office/costumes.js';
import { Scene } from '../public/js/office/scene.js';
import { spriteLift } from '../public/js/office/sprites.js';
import { THEMES, activeTheme, isTheme, theme, themedLook } from '../public/js/office/themes.js';

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
  assert.ok(isTheme('kantor') && isTheme('halloween') && !isTheme('toString') && !isTheme('nope'));
  for (const id of ROLE_ORDER) assert.equal(themedLook(CAST[id].look), CAST[id].look, `${id}: same object, so sprites are identical`);
  assert.equal(themedLook(VISITOR.look), VISITOR.look);
  for (const t of Object.values(THEMES)) for (const key of ['id', 'label', 'icon', 'looks', 'cat']) assert.ok(key in t, `${t.id}.${key}`);
});

test('halloween: every role has its own costume and keeps its role colour as an accent', () => {
  withTheme('halloween', () => {
    assert.equal(activeTheme().id, 'halloween');
    const ids = new Set();
    for (const role of ROLE_ORDER) {
      const look = themedLook(CAST[role].look);
      assert.ok(look.costume, `${role} has a costume`);
      assert.ok(COSTUMES[look.costume], `${role}: costume "${look.costume}" has a painter`);
      assert.equal(look.id, `${role}@halloween`, 'own sprite cache key');
      assert.ok(Object.values(look).includes(CAST[role].color), `${role}: role colour ${CAST[role].color} used in the costume`);
      assert.equal(themedLook(CAST[role].look), look, 'memoised');
      ids.add(look.id);
    }
    assert.equal(ids.size, ROLE_ORDER.length);
  });
});

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
});

test('costume painters: every role × view × pose × arms paints inside the 20×32 sprite', () => {
  withTheme('halloween', () => {
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

test('a turn cut short by a server restart: the lead shows the waiting sign until it is continued', () => {
  const scene = at(0, () => new Scene());
  const lead = scene.people.claude;
  at(1_000, () => scene.setStatus({ busy: false, interrupted: { reason: 'shutdown', sessionId: 's1' } }));
  assert.equal(lead.icon?.name, 'ask');
  assert.match(lead.bubble?.text ?? '', /terputus/);
  at(2_000, () => scene.setStatus({ busy: true, interrupted: null }));
  assert.equal(lead.icon, null, 'sign gone once the turn continues');
});
