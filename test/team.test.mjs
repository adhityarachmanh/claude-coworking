// 👥 Kelola tim: the built-in role catalog, team validation, role mapping per active team (with fallbacks),
// the subagents / Lead prompt per team, and the office layout for 12 (unchanged) and 16 desks.
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Scene } from '../public/js/office/scene.js';
import { CLASSIC_TEAM as CLIENT_CLASSIC, DEFAULT_TEAM, resolveRole as clientResolve, roster, setRoster, teamOrder } from '../public/js/office/roster.js';
import { DESKS, DOOR, H, W, findPath, layoutDesks, room } from '../public/js/office/world.js';
import {
  CATALOG_IDS, CLASSIC_TEAM, DEFAULT_ENABLED, MAX_ACTIVE_ROLES, ROLE_CATALOG, TeamConfigError, activeAgents, normalizeEnabled, publicCatalog, resolveRole, storedEnabled, teamPrompt,
} from '../src/role-catalog.js';
import { activeRoles, agentRole, inferRole, loadAgentDefinitions, screenFor, setActiveRoles, toRole } from '../src/roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = [...CATALOG_IDS];
const NEW = ['mobile', 'data', 'support', 'reviewer'];

afterEach(() => setActiveRoles(DEFAULT_ENABLED));

// ---------- catalog & validation ----------

test('catalog: the 12 existing roles + 4 new ones, fixed ids; the default team is all 16', () => {
  assert.deepEqual(ALL, ['pm', 'ba', 'architect', 'ui-ux', 'frontend', 'backend', 'dba', 'qa', 'security', 'devops', 'writer', 'freelancer', 'mobile', 'data', 'support', 'reviewer']);
  assert.equal(MAX_ACTIVE_ROLES, 16);
  assert.deepEqual([...DEFAULT_ENABLED], ALL, 'default: every catalog role on');
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
Run independent pieces in parallel when they do not touch the same files. Reply in the user's language.`;

test('agent templates: 15 role agents load; --agents carries only the active ones', () => {
  const all = loadAgentDefinitions(path.join(ROOT, '.claude', 'agents'));
  assert.deepEqual(Object.keys(all).sort(), ALL.filter((id) => id !== 'freelancer').sort());
  for (const id of NEW) {
    assert.ok(all[id].description.length > 40 && all[id].prompt.length > 300, id);
    assert.match(all[id].prompt, /Output ke Lead:/, `${id} follows the same structure`);
  }
  assert.deepEqual(all.reviewer.tools, ['Read', 'Grep', 'Glob', 'Bash'], 'the reviewer reads, never edits');
  assert.deepEqual(Object.keys(activeAgents(all, [...CLASSIC_TEAM])).sort(), Object.keys(all).filter((id) => !NEW.includes(id)).sort());
  assert.deepEqual(Object.keys(activeAgents(all, ['qa', 'freelancer', 'mobile'])), ['qa', 'mobile']);
});

test('Lead prompt: unchanged for the classic 12-role team; lists exactly the active roles otherwise', () => {
  const agentNames = ALL.filter((id) => id !== 'freelancer');
  assert.equal(teamPrompt([...CLASSIC_TEAM], agentNames), OLD_TEAM_PROMPT);
  const custom = teamPrompt(normalizeEnabled(['pm', 'qa', 'backend', 'reviewer', 'support']), agentNames);
  const listed = [...custom.matchAll(/^- ([\w-]+): /gm)].map((m) => m[1]);
  assert.deepEqual(listed, ['pm', 'backend', 'qa', 'support', 'reviewer']);
  assert.match(custom, /reviewer reviews the diff/);
  assert.match(custom, /support triages it/);
  assert.match(custom, /not listed, give that step to the closest listed role/, 'missing default roles are explained');
  assert.doesNotMatch(custom, /^- mobile:/m);
});

// ---------- office layout ----------

const deskBox = (d) => [d.x, d.y - 12, d.w, 30];
const inside = (p, [x, y, w, h]) => p.x >= x && p.x < x + w && p.y >= y && p.y < y + h;

test('layout: the classic 12 desks are exactly where they always were', () => {
  setRoster({ enabled: [...CLIENT_CLASSIC], catalog: publicCatalog() });
  layoutDesks(CLIENT_CLASSIC);
  const expected = {
    pm: [24, 76], ba: [88, 76], architect: [152, 76], 'ui-ux': [216, 76],
    frontend: [24, 148], backend: [88, 148], dba: [152, 148], freelancer: [216, 148],
    qa: [24, 220], security: [88, 220], writer: [152, 220], devops: [216, 220],
  };
  assert.deepEqual(Object.keys(DESKS), [...Object.keys(expected), 'claude'], 'same order too (drawing order)');
  for (const [id, [x, y]] of Object.entries(expected)) assert.deepEqual([DESKS[id].x, DESKS[id].y, DESKS[id].seat.x, DESKS[id].seat.y], [x, y, x + 24, y + 34], id);
  assert.deepEqual([W, room.h], [544, H]);
  assert.equal(H, 288);
});

test('layout: 16 desks → a 4th row, a taller room, every desk inside and reachable', () => {
  setRoster({ enabled: ALL, catalog: publicCatalog() });
  layoutDesks(ALL);
  assert.equal(room.h, 360);
  assert.equal(Object.keys(DESKS).length, 17);
  for (const id of NEW) assert.equal(DESKS[id].y, 292, `${id} in row 4`);
  const boxes = Object.entries(DESKS).filter(([id]) => id !== 'claude').map(([, d]) => deskBox(d));
  for (const [id, d] of Object.entries(DESKS)) {
    assert.ok(d.x >= 0 && d.x + d.w <= W && d.seat.y < room.h - 8, `${id} inside the room`);
    const path = findPath(DOOR, d.seat);
    assert.deepEqual(path.at(-1), { x: d.seat.x, y: d.seat.y }, `${id}: reaches its seat`);
    if (d.y === 292) assert.ok(path.length >= 2, `${id}: walks around the desks, not through them`);
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
  // a smaller team keeps the room size; 13 desks need the 4th row
  layoutDesks(['pm', 'qa', 'freelancer']);
  assert.equal(room.h, 288);
  assert.deepEqual(Object.keys(DESKS), ['pm', 'freelancer', 'qa', 'claude'], 'packed in desk order');
  layoutDesks([...CLIENT_CLASSIC, 'reviewer']);
  assert.equal(room.h, 360);
  assert.deepEqual([DESKS.reviewer.x, DESKS.reviewer.y], [24, 292]);
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
