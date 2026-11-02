// 👥 Kelola tim: the built-in role catalog, team validation, role mapping per active team (with fallbacks),
// the subagents / Lead prompt per team, and the fixed office floor plan (desks per department, reachability).
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Scene } from '../public/js/office/scene.js';
import { CAST } from '../public/js/office/cast.js';
import { CLASSIC_TEAM as CLIENT_CLASSIC, DEFAULT_TEAM, defaultTeam, resolveRole as clientResolve, roster, setRoster, teamOrder } from '../public/js/office/roster.js';
import { CAT_SPOTS, DESKS, DOOR, H, SIGNS, SLOTS, SOFA_SEATS, SPOTS, W, findPath, isWalkable, layoutDesks, room } from '../public/js/office/world.js';
import {
  CATALOG_IDS, CLASSIC_TEAM, COMMAND_RULES, DEFAULT_ENABLED, MAX_ACTIVE_ROLES, ROLE_CATALOG, TeamConfigError, activeAgents, normalizeEnabled, publicCatalog, resolveRole, storedEnabled, teamPrompt,
} from '../src/role-catalog.js';
import { activeRoles, agentRole, inferRole, loadAgentDefinitions, screenFor, setActiveRoles, toRole } from '../src/roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = [...CATALOG_IDS];
const NEW = ['mobile', 'data', 'support', 'reviewer', 'compliance'];

afterEach(() => setActiveRoles(DEFAULT_ENABLED));

// ---------- catalog & validation ----------

test('catalog: the 12 existing roles + 5 optional ones, fixed ids; the default team is all 17', () => {
  assert.deepEqual(ALL, ['pm', 'ba', 'architect', 'ui-ux', 'frontend', 'backend', 'dba', 'qa', 'security', 'devops', 'writer', 'freelancer', 'mobile', 'data', 'support', 'reviewer', 'compliance']);
  assert.equal(MAX_ACTIVE_ROLES, 17);
  assert.deepEqual([...DEFAULT_ENABLED], ALL, 'default: every catalog role on, Compliance included');
  assert.deepEqual(publicCatalog().filter((r) => r.defaultOff).map((r) => r.id), [], 'no opt-in roles today');
  assert.deepEqual([...CLASSIC_TEAM], ALL.slice(0, 12), 'the classic team (before the catalog)');
  assert.deepEqual([...CLIENT_CLASSIC], [...CLASSIC_TEAM]);
  assert.deepEqual([...DEFAULT_TEAM].sort(), [...DEFAULT_ENABLED].sort(), 'the browser starts with the same default');
  assert.deepEqual([...DEFAULT_TEAM], [...DEFAULT_ENABLED], 'same order as the catalog');
  for (const role of ROLE_CATALOG) {
    assert.ok(role.name && role.title && role.description.length > 20, role.id);
    for (const next of role.fallback) assert.ok(CATALOG_IDS.includes(next), `${role.id} → ${next}`);
    assert.equal(role.agentFile, role.id === 'freelancer' ? null : `${role.id}.md`);
  }
  for (const id of NEW) assert.ok(ROLE_CATALOG.find((r) => r.id === id).signals.agent, `${id} has agent signals`);
  const pub = publicCatalog();
  assert.equal(JSON.stringify(pub).includes('signals'), false, 'no RegExps go to the browser');
  assert.deepEqual(pub.filter((r) => r.locked).map((r) => r.id), ['freelancer']);
});

test('validation: catalog ids only, no Lead, at most 16; duplicates dropped, freelancer always on', () => {
  assert.deepEqual(normalizeEnabled(['qa', 'pm', 'qa', ' mobile ']), ['pm', 'qa', 'freelancer', 'mobile'], 'catalog order');
  assert.deepEqual(normalizeEnabled([]), ['freelancer']);
  assert.deepEqual(normalizeEnabled(ALL), ALL, 'all 16 fit');
  for (const bad of [null, 'pm', { pm: true }, ['claude'], ['pm', 'hacker'], ['__proto__'], [42]]) assert.throws(() => normalizeEnabled(bad), TeamConfigError, JSON.stringify(bad));
  assert.equal(new TeamConfigError('x').status, 400);
  assert.deepEqual(storedEnabled(undefined), [...DEFAULT_ENABLED], 'never saved: the default team (all 16)');
  assert.deepEqual(storedEnabled({ enabled: ['nope'] }), [...DEFAULT_ENABLED], 'a corrupt stored team falls back to the default');
  assert.deepEqual(storedEnabled({ enabled: ['pm', 'data'] }), ['pm', 'freelancer', 'data']);
});

test('fallback chains: one place, recursive, ending at the freelancer then the Lead', () => {
  const on = (...ids) => new Set(ids);
  assert.equal(resolveRole('reviewer', on('architect', 'freelancer')), 'architect');
  assert.equal(resolveRole('reviewer', on('backend', 'freelancer')), 'backend', 'reviewer → architect → backend');
  assert.equal(resolveRole('data', on('dba', 'freelancer')), 'dba', 'data → backend (off) → … → dba');
  assert.equal(resolveRole('mobile', on('frontend')), 'frontend');
  assert.equal(resolveRole('support', on('qa', 'ba')), 'qa');
  assert.equal(resolveRole('support', on('ba')), 'ba');
  assert.equal(resolveRole('dba', on('freelancer')), 'freelancer');
  assert.equal(resolveRole('dba', on()), 'claude', 'nothing else on: the Lead');
  assert.equal(resolveRole('claude', on()), 'claude');
  assert.equal(resolveRole('qa', on('qa')), 'qa');
  // every role's chain ends at an active role for every single-role-off team
  for (const off of ALL.filter((id) => id !== 'freelancer')) {
    const active = new Set(ALL.filter((id) => id !== off));
    assert.ok(active.has(resolveRole(off, active)), off);
  }
});

// ---------- role mapping per active team ----------

// The mappings of test/roles.test.mjs (default team), which must not move while the new roles are off.
const OLD_AGENTS = {
  pm: 'pm', Explore: 'ba', Plan: 'architect', 'general-purpose': 'freelancer', fork: 'freelancer', 'claude-code-guide': 'writer', 'statusline-setup': 'devops',
  'code-reviewer': 'architect', 'frontend-developer': 'frontend', 'backend-developer': 'backend', 'test-runner': 'qa', 'db-migrator': 'dba',
  'security-auditor': 'security', 'api-docs-writer': 'writer', 'ui-designer': 'ui-ux', 'mobile-dev': 'frontend', 'data-engineer': 'dba', 'flutter-dev': 'backend', 'pr-reviewer': 'architect', 'triage-bot': null,
};
const OLD_FILES = { 'lib/main.dart': 'backend', 'android/app/build.gradle': 'backend', 'ios/Runner/AppDelegate.swift': 'backend', 'notebooks/eda.ipynb': 'backend', 'dbt/models/orders.sql': 'dba', 'src/components/Button.tsx': 'frontend' };
const OLD_COMMANDS = { 'flutter build apk': 'devops', 'dbt run': 'backend', 'gh pr review 12': 'architect', 'jupyter nbconvert x.ipynb': 'backend', 'npm test': 'qa' };

test('new roles off (the classic 12-role team): every old mapping stays exactly as it was', () => {
  setActiveRoles(CLASSIC_TEAM);
  for (const [agent, role] of Object.entries(OLD_AGENTS)) assert.equal(toRole(agent), role, agent);
  for (const [file, role] of Object.entries(OLD_FILES)) assert.equal(inferRole('Edit', { file_path: file }), role, file);
  for (const [command, role] of Object.entries(OLD_COMMANDS)) assert.equal(inferRole('Bash', { command }), role, command);
  assert.equal(inferRole('mcp__zendesk__ticket', {}), 'claude');
  assert.equal(agentRole('mobile'), 'frontend', 'an agent named after an off role goes to its fallback');
  assert.equal(agentRole('reviewer'), 'architect');
  assert.equal(agentRole(undefined), 'freelancer');
});

test('new roles on: their agents, files, commands and MCP servers go to them', () => {
  setActiveRoles(ALL);
  const agents = {
    mobile: 'mobile', 'mobile-dev': 'mobile', 'flutter-dev': 'mobile', 'react-native-expert': 'mobile', 'ios-engineer': 'mobile', 'kotlin-android': 'mobile',
    'data-engineer': 'data', 'ml-engineer': 'data', 'llm-integrator': 'data', 'embedding-builder': 'data', analytics: 'data',
    support: 'support', helpdesk: 'support', 'incident-responder': 'support', 'triage-bot': 'support',
    'code-reviewer': 'reviewer', reviewer: 'reviewer', 'pr-reviewer': 'reviewer', review: 'reviewer',
    // the specialists that come first keep their names
    'security-reviewer': 'security', 'db-migrator': 'dba', 'test-runner': 'qa', 'ui-designer': 'ui-ux', 'frontend-developer': 'frontend', Plan: 'architect',
  };
  for (const [agent, role] of Object.entries(agents)) assert.equal(toRole(agent), role, agent);
  const files = { 'lib/main.dart': 'mobile', 'android/app/build.gradle': 'mobile', 'ios/Runner/AppDelegate.swift': 'mobile', 'notebooks/eda.ipynb': 'data', 'dbt/models/orders.sql': 'data', 'data/x.parquet': 'data', 'test/widget_test.dart': 'qa', 'README.md': 'writer' };
  for (const [file, role] of Object.entries(files)) assert.equal(inferRole('Edit', { file_path: file }), role, file);
  const commands = { 'flutter build apk': 'mobile', './gradlew assembleDebug': 'mobile', 'dbt run': 'data', 'gh pr review 12': 'reviewer', 'git diff': 'architect', 'flutter test': 'qa' };
  for (const [command, role] of Object.entries(commands)) assert.equal(inferRole('Bash', { command }), role, command);
  assert.equal(inferRole('mcp__zendesk__ticket', {}), 'support');
  assert.equal(screenFor('Bash', { command: 'gh pr review 12' }), 'review');
});

test('some roles off: work goes along the fallback chain; an off role is never handed out', () => {
  // writer and dba off, reviewer + data on
  const team = normalizeEnabled(CLASSIC_TEAM.filter((r) => r !== 'writer' && r !== 'dba').concat('reviewer', 'data'));
  setActiveRoles(team);
  assert.deepEqual(activeRoles(), team);
  assert.equal(inferRole('Edit', { file_path: 'README.md' }), 'ba', 'writer → ba');
  assert.equal(inferRole('Edit', { file_path: 'db/migrations/1.sql' }), 'backend', 'dba → backend');
  assert.equal(toRole('db-migrator'), 'backend');
  assert.equal(toRole('data-engineer'), 'data');
  assert.equal(toRole('api-docs-writer'), 'ba');
  // whatever the team, nothing outside it (or the Lead) is ever returned
  const samples = [
    ...Object.keys(OLD_AGENTS).map((a) => () => agentRole(a)),
    ...Object.keys(OLD_FILES).map((f) => () => inferRole('Write', { file_path: f })),
    ...Object.keys(OLD_COMMANDS).map((c) => () => inferRole('Bash', { command: c })),
    () => inferRole('Read', { file_path: 'docs/x.md' }),
    () => inferRole('TodoWrite', {}),
  ];
  for (const t of [['freelancer'], ['qa', 'freelancer'], team, ALL]) {
    setActiveRoles(t);
    for (const run of samples) {
      const role = run();
      assert.ok(role === 'claude' || t.includes(role), `${role} not in ${t}`);
    }
  }
});

// ---------- subagents and the Lead prompt ----------

const OLD_TEAM_PROMPT = `You are the Engineering Lead of an IT team that the user watches live in the "Adhit Office" pixel office.
Delegate focused work to the specialist subagents with the Agent tool, but only to the roles a task actually needs:
each delegation costs time and tokens, so do small or trivial work yourself.
- pm: scope, priorities, acceptance criteria, task breakdown
- ba: requirements, business rules, analysis of existing code and documents
- architect: technical design, architecture decisions, code review of diffs
- ui-ux: user flows, UI design, styling, accessibility
- frontend: UI implementation (components, pages, client state)
- backend: APIs, business logic, integrations, server-side fixes
- dba: schema, migrations, queries, data fixes, database performance
- qa: test plans, automated tests, bug reproduction, verification
- security: security review, vulnerabilities, secrets, dependency audit
- devops: build, CI/CD, Docker, deployment, environment and config issues
- writer: README, API docs, changelog, user guides
Typical flows:
- New feature: pm → ba → architect → ui-ux → frontend/backend/dba → qa → security (when auth, input or data is touched) → writer.
- Bug fix: qa reproduces it (ideally a failing test) → the owning frontend/backend/dba fixes the root cause → architect reviews the diff → qa verifies.
- Build/deploy/incident: devops first, then backend or dba as needed, qa verifies.
Run independent pieces in parallel when they do not touch the same files. Reply in the user's language.
${COMMAND_RULES}`;

test('agent templates: 16 role agents load; --agents carries only the active ones', () => {
  const all = loadAgentDefinitions(path.join(ROOT, '.claude', 'agents'));
  assert.deepEqual(Object.keys(all).sort(), ALL.filter((id) => id !== 'freelancer').sort());
  for (const id of NEW) {
    assert.ok(all[id].description.length > 40 && all[id].prompt.length > 300, id);
    assert.match(all[id].prompt, /Output ke Lead:/, `${id} follows the same structure`);
  }
  for (const [id, def] of Object.entries(all)) assert.ok(def.prompt.endsWith(`

${COMMAND_RULES}`), `${id} gets the never-hang command rules`);
  assert.deepEqual(all.reviewer.tools, ['Read', 'Grep', 'Glob', 'Bash'], 'the reviewer reads, never edits');
  assert.deepEqual(Object.keys(activeAgents(all, [...CLASSIC_TEAM])).sort(), Object.keys(all).filter((id) => !NEW.includes(id)).sort());
  assert.deepEqual(Object.keys(activeAgents(all, ['qa', 'freelancer', 'mobile'])), ['qa', 'mobile']);
});

test('Lead prompt: the classic 12-role team keeps its prompt (plus the command rules); lists exactly the active roles otherwise', () => {
  const agentNames = ALL.filter((id) => id !== 'freelancer');
  assert.equal(teamPrompt([...CLASSIC_TEAM], agentNames), OLD_TEAM_PROMPT);
  const custom = teamPrompt(normalizeEnabled(['pm', 'qa', 'backend', 'reviewer', 'support']), agentNames);
  const listed = [...custom.matchAll(/^- ([\w-]+): /gm)].map((m) => m[1]);
  assert.deepEqual(listed, ['pm', 'backend', 'qa', 'support', 'reviewer']);
  assert.match(custom, /reviewer reviews the diff/);
  assert.match(custom, /support triages it/);
  assert.match(custom, /not listed, give that step to the closest listed role/, 'missing default roles are explained');
  assert.doesNotMatch(custom, /^- mobile:/m);
  assert.ok(custom.endsWith(COMMAND_RULES), 'every team gets the command rules');
  assert.match(COMMAND_RULES, /Every wait has a deadline/);
  assert.match(COMMAND_RULES, /never poll for one specific line/);
});

// ---------- office layout ----------

const deskBox = (d) => [d.x, d.y - 12, d.w, 30];
const inside = (p, [x, y, w, h]) => p.x >= x && p.x < x + w && p.y >= y && p.y < y + h;
/** The fixed floor plan (world.js header): every role's desk, whatever the team. */
const FLOOR = {
  pm: [320, 72], architect: [408, 72], // private glass offices
  ba: [56, 88], 'ui-ux': [112, 88], writer: [168, 88], // Produk & Desain
  frontend: [24, 192], mobile: [80, 192], backend: [136, 192], dba: [192, 192], data: [248, 192], // Engineering
  qa: [336, 192], reviewer: [392, 192], security: [448, 192], compliance: [504, 192], // Kualitas & Keamanan
  devops: [40, 280], support: [96, 280], freelancer: [152, 280], // Ops & Support
};

test('layout: one fixed 640×344 floor; every role at its own department desk, whatever the team', () => {
  assert.deepEqual([W, H, room.h], [640, 344, 344]);
  assert.deepEqual(Object.keys(SLOTS).sort(), Object.keys(FLOOR).sort(), 'a desk for every catalog role');
  for (const team of [ALL, [...CLIENT_CLASSIC], ['pm', 'qa', 'freelancer'], ALL.filter((r) => r !== 'compliance')]) {
    setRoster({ enabled: team, catalog: publicCatalog() });
    layoutDesks(team);
    assert.deepEqual(Object.keys(DESKS).sort(), [...team, 'claude'].sort(), `${team.length} roles: only the active ones sit`);
    for (const id of team) {
      const [x, y] = FLOOR[id];
      assert.deepEqual([DESKS[id].x, DESKS[id].y, DESKS[id].seat.x, DESKS[id].seat.y], [x, y, x + 24, y + 34], `${id} never moves`);
      assert.equal(DESKS[id].prop, SLOTS[id].prop);
    }
    assert.equal(room.h, 344, 'the floor never grows or shrinks');
    assert.deepEqual([DESKS.claude.x, DESKS.claude.y, DESKS.claude.seat.facing], [528, 92, 'down'], 'the Lead in the corner office');
  }
  // the desks are cloned: a scene changing one does not move the floor plan
  DESKS.qa.x = 0;
  assert.equal(SLOTS.qa.x, 336);
  layoutDesks(ALL);
  // no two desks (with their chairs) overlap
  const all = Object.values(SLOTS);
  for (const a of all) for (const b of all) if (a !== b) assert.ok(Math.abs(a.x - b.x) >= 56 || Math.abs(a.y - b.y) >= 56, `${a.x},${a.y} vs ${b.x},${b.y}`);
});

/** Every desk inside the room, each seat reachable from the door without walking through another desk. */
function assertReachable() {
  for (const [id, d] of Object.entries(DESKS)) {
    // empty desks are furniture too; the Lead's own desk is the one it walks around to reach its chair
    const boxes = Object.entries(SLOTS).filter(([other]) => other !== id).map(([, s]) => deskBox(s));
    assert.ok(d.x >= 0 && d.x + d.w <= W && d.seat.y < room.h - 8, `${id} inside the room`);
    const path = findPath(DOOR, d.seat);
    assert.deepEqual(path.at(-1), { x: d.seat.x, y: d.seat.y }, `${id}: reaches its seat`);
    assertOpenRoute(DOOR, path, id);
    // no straight leg crosses another desk
    let from = DOOR;
    for (const p of path) {
      for (let i = 1; i < 20; i++) {
        const q = { x: from.x + ((p.x - from.x) * i) / 20, y: from.y + ((p.y - from.y) * i) / 20 };
        assert.ok(!boxes.some((b) => inside(q, b)), `${id}: path crosses a desk at ${q.x},${q.y}`);
      }
      from = p;
    }
  }
}

/**
 * Every leg of a route runs over open floor (findPath falls back to one straight hop when there is no route, which
 * would cross a wall). The first and last few px may be inside a furniture cell: a seat tucked under its desk.
 */
function assertOpenRoute(from, path, label) {
  const end = path.at(-1);
  let a = from;
  for (const b of path) {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2);
    for (let i = 0; i <= steps; i++) {
      const q = { x: a.x + ((b.x - a.x) * i) / steps || a.x, y: a.y + ((b.y - a.y) * i) / steps || a.y };
      if (Math.hypot(q.x - from.x, q.y - from.y) < 12 || Math.hypot(q.x - end.x, q.y - end.y) < 12) continue;
      assert.ok(isWalkable(q), `${label}: crosses a wall or furniture at ${q.x.toFixed(0)},${q.y.toFixed(0)}`);
    }
    a = b;
  }
}

/** Every spot (errands, huddle, sofa, cat, visits, colleagues' desks) reachable from the door and from other seats. */
function assertSpotsReachable() {
  const targets = {
    ...SPOTS,
    ...Object.fromEntries(SOFA_SEATS.map((s, i) => [`sofa${i}`, s])),
    ...Object.fromEntries(CAT_SPOTS.map((s, i) => [`cat${i}`, s])),
    visit: DESKS.claude.visit,
    ask: DESKS.claude.ask,
    ...Object.fromEntries(Object.entries(DESKS).filter(([id]) => id !== 'claude').flatMap(([id, d]) => [
      [`${id}:errand`, { x: d.seat.x + 16, y: d.seat.y + 4 }], // delegation / chat / report spot
      [`${id}:ask`, { x: d.seat.x, y: d.seat.y + 8 }], // stands up to ask for approval
    ])),
  };
  for (const [name, spot] of Object.entries(targets)) {
    assert.ok(spot.x > 0 && spot.x < W && spot.y > 48 && spot.y < room.h, `${name} inside the floor`);
    for (const from of [DOOR, DESKS.claude.seat, DESKS.qa.seat, DESKS.devops.seat, DESKS.pm.seat]) {
      const path = findPath(from, spot);
      assert.deepEqual(path.at(-1), { x: spot.x, y: spot.y }, `${name} from ${from.x},${from.y}`);
      assertOpenRoute(from, path, `${name} from ${from.x},${from.y}`);
    }
  }
}

test('layout: the full team (17 desks + the Lead) — every desk and every spot reachable', () => {
  assert.equal(ALL.length, 17);
  setRoster({ enabled: ALL, catalog: publicCatalog() });
  layoutDesks(ALL);
  assert.equal(Object.keys(DESKS).length, 18);
  assert.deepEqual([DESKS.compliance.x, DESKS.compliance.y, DESKS.compliance.prop], [504, 192, 'stamp']);
  assertReachable();
  assertSpotsReachable();
});

test('layout: a smaller team leaves desks empty in place; the paths stay the same', () => {
  const sixteen = DEFAULT_TEAM.filter((id) => id !== 'compliance');
  layoutDesks(sixteen);
  assert.equal(DESKS.compliance, undefined, 'Compliance off: no desk of its own in DESKS…');
  assert.deepEqual([SLOTS.compliance.x, SLOTS.compliance.y], [504, 192], '…its empty desk stays in the pod');
  assertReachable();
  const before = findPath(DOOR, DESKS.reviewer.seat);
  layoutDesks(['pm', 'qa', 'freelancer']);
  assert.deepEqual(Object.keys(DESKS), ['pm', 'freelancer', 'qa', 'claude'], 'catalog order');
  assertReachable();
  layoutDesks(ALL);
  assert.deepEqual(findPath(DOOR, DESKS.reviewer.seat), before, 'the walk grid does not depend on the team');
});

test('layout: glass walls and cubicle partitions block, the door gaps let people through', () => {
  layoutDesks(ALL);
  const via = (path, x0, x1, y0, y1) => path.some((p, i) => {
    const prev = path[i - 1];
    if (!prev) return false;
    // some point of this leg passes through the gap
    for (let k = 0; k <= 10; k++) {
      const x = prev.x + ((p.x - prev.x) * k) / 10;
      const y = prev.y + ((p.y - prev.y) * k) / 10;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
    }
    return false;
  });
  // into the PM office from the aisle below: through its door, not through the glass
  const pm = [{ x: DESKS.pm.seat.x, y: 160 }, ...findPath({ x: DESKS.pm.seat.x, y: 160 }, DESKS.pm.seat)];
  assert.ok(via(pm, 360, 384, 136, 144), 'via the PM door gap (x 360–384)');
  // into the meeting room via its door in the top glass wall
  const meet = [{ x: 240, y: 244 }, ...findPath({ x: 240, y: 244 }, SPOTS.meet1)];
  assert.ok(via(meet, 288, 320, 256, 264), 'via the meeting-room door (x 288–320)');
  // the visitor walks from the entrance into the corner office
  const visit = [DOOR, ...findPath(DOOR, DESKS.claude.visit)];
  assert.ok(via(visit, 496, 520, 136, 144), 'into the corner office via its door (x 496–520)');
  for (const label of ['Produk & Desain', 'Engineering', 'Kualitas & Keamanan', 'Ops & Support', 'Ruang Rapat', 'Pantry']) assert.ok(SIGNS.some((x) => x.text === label && !x.vacant), label);
  // office door plates only for rooms whose role can be switched off (shown while empty); the Lead has none
  assert.deepEqual(SIGNS.filter((x) => x.vacant).map((x) => [x.text, x.vacant]), [['PM', 'pm'], ['Tech Lead', 'architect']]);
  assert.ok(!SIGNS.some((x) => x.text === 'Lead'), 'no plate under the Lead');
  for (const s of SIGNS) assert.ok(s.x > 0 && s.x < W && s.y > 0 && s.y < H, `${s.text} on the floor`);
});

test('client defaults: DEFAULT_TEAM and "↺ Tim bawaan" are all 17 roles, Compliance included; max 17 desks', () => {
  assert.equal(DEFAULT_TEAM.length, 17);
  assert.ok(DEFAULT_TEAM.includes('compliance'));
  setRoster({ enabled: ALL, catalog: publicCatalog(), max: MAX_ACTIVE_ROLES });
  assert.equal(roster.max, 17);
  assert.deepEqual(defaultTeam().sort(), [...DEFAULT_ENABLED].sort(), 'same default as the server');
  assert.equal(CAST.compliance.name, 'Adhit - Compliance');
  assert.equal(clientResolve('compliance'), 'compliance');
  const noCompliance = DEFAULT_TEAM.filter((r) => r !== 'compliance');
  setRoster({ enabled: noCompliance, catalog: publicCatalog() });
  assert.equal(clientResolve('compliance'), 'security', 'off → Security covers it');
  // Security off too: its own chain comes first (security → reviewer), exactly like the server's resolveRole.
  const noSec = noCompliance.filter((r) => r !== 'security');
  setRoster({ enabled: noSec, catalog: publicCatalog() });
  assert.equal(clientResolve('compliance'), resolveRole('compliance', new Set(noSec)));
  setRoster({ enabled: ['pm', 'ba', 'freelancer'], catalog: publicCatalog() });
  assert.equal(clientResolve('compliance'), 'ba', 'no security chain left: the BA');
  setRoster({ enabled: [...CLIENT_CLASSIC], catalog: publicCatalog() });
});

test('office scene: a person per active role (+ the Lead); an off role\'s events reach whoever covers it', () => {
  setRoster({ enabled: ALL, catalog: publicCatalog() });
  layoutDesks(ALL);
  assert.deepEqual(Object.keys(new Scene().people).sort(), ['claude', ...ALL].sort());

  setRoster({ enabled: [...CLIENT_CLASSIC].filter((r) => r !== 'devops'), catalog: publicCatalog() });
  layoutDesks(roster.enabled);
  assert.deepEqual(teamOrder(), ['claude', ...CLIENT_CLASSIC.filter((r) => r !== 'devops')]);
  const scene = new Scene();
  assert.equal(scene.people.devops, undefined);
  assert.equal(clientResolve('devops'), 'backend');
  assert.equal(clientResolve('mobile'), 'frontend');
  assert.equal(scene.person('devops'), scene.people.backend);
  assert.equal(scene.person('reviewer'), scene.people.architect);
  scene.handle({ kind: 'tool_start', role: 'devops', label: 'build', tool: 'Bash' }, true);
  assert.equal(scene.people.backend.openTools, 1);
  scene.handle({ kind: 'huddle', role: 'pm', roles: ['pm', 'devops'], label: 'x' }, true); // a missing member is skipped
  assert.equal(setRoster({ enabled: roster.enabled }), false, 'same team: nothing to rebuild');

  setRoster({ enabled: [...CLIENT_CLASSIC], catalog: publicCatalog() });
  layoutDesks(CLIENT_CLASSIC);
});
