// 🧭 Learned role mappings (src/role-memory.js) and their hook in src/roles.js.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLASSIC_TEAM } from '../src/role-catalog.js';
import { classifyPrompt, engineClassifier, parseAnswer, PROJECT_FILE, RoleMemory } from '../src/role-memory.js';
import { agentRole, inferRole, setActiveRoles, setRoleMemory } from '../src/roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
setActiveRoles(CLASSIC_TEAM);

function setup({ classify = null, persisted = {} } = {}) {
  const saves = { n: 0 };
  const events = [];
  const hub = { persisted, scheduleSave: () => saves.n++, broadcast: (type, data) => events.push({ type, data }) };
  const m = new RoleMemory({ hub, classify, aiDelayMs: 5 });
  setRoleMemory({ lookup: (k, p) => m.lookup(k, p), unknown: (k, h, p) => m.noteUnknown(k, h, p) });
  return { m, hub, saves, events };
}
const project = () => mkdtempSync(path.join(tmpdir(), 'rolemap-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('names the rules do not know are listed; known ones are not', (t) => {
  t.after(() => setRoleMemory());
  const { m } = setup();
  assert.equal(inferRole('mcp__hubspot__create_deal', {}), 'claude');
  assert.equal(inferRole('Skill', { skill: 'zorkify' }), 'claude');
  assert.equal(inferRole('Bash', { command: 'node tools/sync-erp.mjs' }), 'backend');
  assert.equal(inferRole('Bash', { command: 'frobnicate --all' }), 'backend');
  assert.equal(agentRole('growth-hacker'), 'freelancer');
  // known by the rules: not listed
  inferRole('mcp__github__create_issue', {});
  inferRole('Bash', { command: 'npm test' });
  inferRole('Bash', { command: 'git commit -m x' });
  agentRole('general-purpose');
  inferRole('Bash', { command: 'node -e "1"', description: 'Verifikasi hasil' });
  const keys = m.list(null).unknown.map((u) => u.key).sort();
  assert.deepEqual(keys, ['agent:growth-hacker', 'cmd:frobnicate', 'mcp:hubspot', 'script:sync-erp.mjs', 'skill:zorkify']);
  assert.equal(m.list(null).unknown.find((u) => u.key === 'mcp:hubspot').hint, 'create_deal');
});

test('a manual mapping wins over the rules, a project file wins over the laptop', (t) => {
  t.after(() => setRoleMemory());
  const { m } = setup();
  const dir = project();
  inferRole('mcp__hubspot__x', {}, { projectPath: dir });
  m.set('mcp:hubspot', 'pm');
  assert.equal(inferRole('mcp__hubspot__x', {}, { projectPath: dir }), 'pm');
  assert.equal(m.list(dir).unknown.length, 0);
  // even a name the rules know can be corrected
  m.set('mcp:github', 'devops');
  assert.equal(inferRole('mcp__github__get_file_contents', {}), 'devops');
  // the project's own file
  m.set('mcp:hubspot', 'ba', { scope: 'project', projectPath: dir });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, PROJECT_FILE), 'utf8')), { 'mcp:hubspot': 'ba' });
  assert.equal(inferRole('mcp__hubspot__x', {}, { projectPath: dir }), 'ba');
  assert.equal(inferRole('mcp__hubspot__x', {}, { projectPath: project() }), 'claude', 'another project: not mapped');
  // a file edited by hand (a teammate's commit) is read again
  writeFileSync(path.join(dir, PROJECT_FILE), JSON.stringify({ 'agent:growth-hacker': 'pm', 'mcp:bad': 'ceo', 'not a key': 'pm' }));
  m.projects.clear();
  assert.equal(agentRole('growth-hacker', { projectPath: dir }), 'pm');
  assert.equal(inferRole('mcp__bad__x', {}, { projectPath: dir }), 'claude', 'unknown role ignored');
  // an inactive role goes along its fallback chain
  m.set('skill:privacy-check', 'compliance');
  assert.equal(inferRole('Skill', { skill: 'privacy-check' }), 'security');
});

test('bad input is refused', () => {
  const { m } = setup();
  assert.throws(() => m.set('hubspot', 'pm'), /Nama tidak valid/);
  assert.throws(() => m.set('mcp:hubspot', 'ceo'), /Role tidak dikenal/);
  assert.throws(() => m.set('mcp:hubspot', 'pm', { scope: 'project' }), /Pilih project/);
});

test('stored state is cleaned on load', () => {
  const { m } = setup({ persisted: { roleMap: { ai: 'yes', entries: { 'mcp:a': { role: 'pm', by: 'ai' }, 'mcp:b': { role: 'ceo' }, junk: { role: 'pm' } }, unknown: { 'cmd:x': { count: 2, lastAt: '2026-01-01T00:00:00.000Z' }, y: {} } } } });
  assert.equal(m.state.ai, false);
  assert.deepEqual(Object.keys(m.state.entries), ['mcp:a']);
  assert.deepEqual(Object.keys(m.state.unknown), ['cmd:x']);
});

test('AI: off by default; when on, each unknown name is asked once, in a batch, and stored', async (t) => {
  t.after(() => setRoleMemory());
  const calls = [];
  const { m } = setup({ classify: async (items) => (calls.push(items), Object.fromEntries(items.filter((i) => i.key !== 'cmd:nothing').map((i) => [i.key, i.key.includes('crm') ? 'pm' : 'backend']))) });
  inferRole('mcp__crm__x', {});
  await wait(30);
  assert.equal(calls.length, 0, 'off: nothing sent');
  m.setAi(true);
  inferRole('Bash', { command: 'nothing --x' });
  await m.runAi();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map((i) => i.key).sort(), ['cmd:nothing', 'mcp:crm']);
  assert.deepEqual(m.state.entries['mcp:crm'], { role: 'pm', by: 'ai', at: m.state.entries['mcp:crm'].at });
  assert.equal(inferRole('mcp__crm__x', {}), 'pm');
  // no answer for it: kept in the list, not asked again for a day
  assert.ok(m.state.unknown['cmd:nothing'].aiTriedAt);
  inferRole('Bash', { command: 'nothing --x' });
  await m.runAi();
  assert.equal(calls.length, 1);
  // a manual choice is never overwritten by the AI
  m.set('mcp:crm', 'ba');
  assert.equal(m.state.entries['mcp:crm'].by, 'manual');
  m.stop();
});

test('AI prompt carries only names and hints; the answer is parsed leniently', () => {
  const prompt = classifyPrompt([{ key: 'mcp:hubspot', hint: 'create_deal' }, { key: 'script:sync.mjs', hint: 'sync.mjs' }]);
  assert.match(prompt, /^OFFICE-ROLE-MAP/);
  assert.match(prompt, /- mcp:hubspot \(contoh: create_deal\)/);
  assert.match(prompt, /- script:sync\.mjs$/m);
  assert.deepEqual(parseAnswer('Ini:\n```json\n{"mcp:hubspot": "PM", "x": "pm"}\n```'), { 'mcp:hubspot': 'pm' });
  assert.equal(parseAnswer('tidak tahu'), null);
});

test('engine classifier: Claude Code -p on Haiku, read-only, outside any project', async () => {
  const fake = path.join(ROOT, 'test-support', 'fake-claude.mjs');
  const classify = engineClassifier({ engine: () => 'claude', claude: { command: process.execPath, args: [fake] }, opencode: null, dataDir: project() });
  const answer = await classify([{ key: 'mcp:crm', hint: 'x' }, { key: 'cmd:tool', hint: 'tool' }, { key: 'cmd:nothing', hint: '' }]);
  assert.deepEqual(answer, { 'mcp:crm': 'pm', 'cmd:tool': 'backend' });
});

test('shared map (shipped with the app): below this laptop and the project, above the rules; 🌐 writes it', (t) => {
  t.after(() => setRoleMemory());
  const dir = project();
  const sharedFile = path.join(dir, 'role-map.shared.json');
  writeFileSync(sharedFile, JSON.stringify({ 'mcp:hubspot': 'pm', 'mcp:bad': 'ceo' }));
  const hub = { persisted: {}, scheduleSave() {}, broadcast() {} };
  const m = new RoleMemory({ hub, sharedFile });
  setRoleMemory({ lookup: (k, p) => m.lookup(k, p), unknown: (k, h, p) => m.noteUnknown(k, h, p) });
  assert.equal(inferRole('mcp__hubspot__x', {}), 'pm', 'everyone gets the shared mapping');
  assert.equal(m.list(null).unknown.length, 0, 'not listed as unknown');
  assert.deepEqual(m.list(null).entries.map((e) => [e.key, e.source]), [['mcp:hubspot', 'shared']]);
  m.set('mcp:hubspot', 'ba');
  assert.equal(inferRole('mcp__hubspot__x', {}), 'ba', 'this laptop overrides it');
  // the maintainer shares a mapping: written sorted, this laptop's copy dropped
  m.set('skill:zorkify', 'writer');
  m.share('skill:zorkify', 'writer');
  assert.deepEqual(JSON.parse(readFileSync(sharedFile, 'utf8')), { 'mcp:hubspot': 'pm', 'skill:zorkify': 'writer' });
  assert.equal(m.state.entries['skill:zorkify'], undefined);
  assert.equal(inferRole('Skill', { skill: 'zorkify' }), 'writer');
  assert.throws(() => m.share('skill:zorkify', 'ceo'), /tidak valid/);
});
