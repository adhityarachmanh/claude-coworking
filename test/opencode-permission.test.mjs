// OpenCode permission config (src/acp-session.js permissionConfig + src/opencode-bin.js readUserPermission): the
// app's mode is written as the LAST config layer (OPENCODE_CONFIG_CONTENT), so it must never loosen a user deny.
// Also the read-only env of the one-shot `opencode run --agent plan` (role and effort classifiers).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { permissionConfig } from '../src/acp-session.js';
import { mergePermission, readOnlyOpenCodeEnv, readUserPermission, childOpenCodeEnv } from '../src/opencode-bin.js';

const MODES = ['build', 'plan', 'dontAsk'];

test('permissionConfig without user rules: the mode alone', () => {
  assert.deepEqual(permissionConfig('build'), { edit: 'allow', bash: 'ask', webfetch: 'ask' });
  assert.deepEqual(permissionConfig('plan'), { edit: 'deny', bash: 'deny', webfetch: 'deny' });
  assert.deepEqual(permissionConfig('dontAsk'), { edit: 'deny', bash: 'deny', webfetch: 'deny' });
});

test('permissionConfig: a user catch-all deny ({ "*": "deny" }) stays deny in every mode, its allow patterns stay', () => {
  const user = { bash: { '*': 'deny', 'git status': 'allow' }, edit: { '*': 'deny' } };
  for (const mode of MODES) {
    const out = permissionConfig(mode, user);
    assert.equal(out.bash['*'], 'deny', `${mode}: bash "*" stays deny`);
    assert.equal(out.bash['git status'], mode === 'build' ? 'allow' : 'deny', `${mode}: the user's own allow pattern`);
    assert.deepEqual(Object.keys(out.bash), ['*', 'git status'], `${mode}: "*" first, patterns after it (last match wins)`);
    assert.equal(out.edit, 'deny', `${mode}: edit stays deny`);
  }
});

test('permissionConfig: a plain string deny ("bash": "deny") is never loosened', () => {
  for (const mode of MODES) {
    const out = permissionConfig(mode, { bash: 'deny' });
    assert.equal(out.bash, 'deny', mode);
    assert.equal(out.edit, permissionConfig(mode).edit, `${mode}: other tools follow the mode`);
  }
});

test('permissionConfig: a pattern deny stays deny; Build keeps shell/network asking; the stricter catch-all wins', () => {
  const user = { bash: { 'rm *': 'deny', 'git *': 'ask' }, webfetch: { '*': 'ask' } };
  assert.deepEqual(permissionConfig('build', user).bash, { '*': 'ask', 'rm *': 'deny', 'git *': 'ask' });
  assert.equal(permissionConfig('build', user).webfetch, 'ask', 'Build never turns a shell/network ask into allow');
  assert.deepEqual(permissionConfig('plan', user).bash, { '*': 'deny', 'rm *': 'deny', 'git *': 'deny' });
  assert.equal(permissionConfig('plan', user).webfetch, 'deny', 'Plan never opens the network');
  assert.deepEqual(permissionConfig('dontAsk', user).bash, { '*': 'deny', 'rm *': 'deny', 'git *': 'deny' });
  assert.equal(permissionConfig('build', { edit: { '*': 'ask' } }).edit, 'ask', 'the user asks for edits: stricter than the mode');
  assert.equal(permissionConfig('build', { bash: 'allow' }).bash, 'ask', 'a user allow does not loosen the mode either');
  assert.equal(permissionConfig('build', { bash: { '*': 'nonsense' } }).bash, 'ask', 'unknown actions are ignored');
});

test('permissionConfig: a global "permission": "deny" (key "*") denies every tool the app writes', () => {
  for (const mode of MODES) assert.deepEqual(permissionConfig(mode, { '*': { '*': 'deny' } }), { edit: 'deny', bash: 'deny', webfetch: 'deny' }, mode);
  assert.deepEqual(permissionConfig('build', { '*': 'deny', bash: { 'git status': 'allow' } }).bash, { '*': 'deny', 'git status': 'allow' });
});

test('readUserPermission: v1 `permission`, a global string, and OpenCode 2\'s ordered `permissions` list', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'oc-perm-home-'));
  const project = mkdtempSync(path.join(tmpdir(), 'oc-perm-proj-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
  mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), '{ // global\n "permission": { "bash": { "*": "deny", "git status": "allow" }, "edit": "ask", },\n}');
  writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({
    permissions: [
      { action: 'shell', resource: 'npm test', effect: 'allow' },
      { action: 'webfetch', resource: '*', effect: 'deny' },
      { action: 'subagent', resource: '*', effect: 'ask' },
      { action: 'edit', resource: '*', effect: 'bogus' },
    ],
  }));
  const user = readUserPermission(project, home);
  assert.deepEqual(user.bash, { '*': 'deny', 'git status': 'allow', 'npm test': 'allow' }, 'shell = bash, appended in order');
  assert.deepEqual(user.webfetch, { '*': 'deny' });
  assert.deepEqual(user.task, { '*': 'ask' }, 'subagent = task');
  assert.deepEqual(user.edit, { '*': 'ask' }, 'an unknown effect is ignored');
  // v2 deny kept against every mode (OPENCODE_CONFIG_CONTENT would otherwise override it)
  for (const mode of MODES) {
    assert.equal(permissionConfig(mode, user).webfetch, 'deny', mode);
    assert.equal(permissionConfig(mode, user).bash['*'], 'deny', mode);
  }

  // a later catch-all replaces the earlier rules of that tool; a global string covers every tool
  writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({ permission: 'deny', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] }));
  const again = readUserPermission(project, home);
  assert.deepEqual(again.bash, { '*': 'ask' });
  assert.deepEqual(again['*'], { '*': 'deny' });
  assert.deepEqual(permissionConfig('build', again), { edit: 'deny', bash: 'ask', webfetch: 'deny' }, 'global deny for the rest; the later shell rule is the user\'s own ask');
  assert.deepEqual(readUserPermission(path.join(project, 'missing'), path.join(home, 'none')), {});
});

test('permissionConfig: a tool rule the user wrote beats their own global catch-all; the mode never loosens it', () => {
  const user = { '*': 'deny', bash: 'allow' };
  assert.deepEqual(permissionConfig('build', user), { edit: 'deny', bash: 'ask', webfetch: 'deny' });
  assert.deepEqual(permissionConfig('plan', user), { edit: 'deny', bash: 'deny', webfetch: 'deny' });
  assert.deepEqual(permissionConfig('dontAsk', user), { edit: 'deny', bash: 'deny', webfetch: 'deny' });
  assert.equal(permissionConfig('build', { '*': 'allow', edit: { '*': 'ask' } }).edit, 'ask');
});

test('permissionConfig: patterns under the global tool "*" reach every tool (before the tool\'s own patterns)', () => {
  for (const mode of MODES) {
    const out = permissionConfig(mode, { '*': { '*': 'allow', 'rm *': 'deny' } });
    for (const tool of ['edit', 'bash', 'webfetch']) assert.equal(out[tool]['rm *'], 'deny', `${mode} ${tool}`);
  }
  assert.deepEqual(permissionConfig('build', { '*': { '*': 'allow', 'rm *': 'deny' } }).bash, { '*': 'ask', 'rm *': 'deny' });
  const both = permissionConfig('build', { '*': { 'rm *': 'deny', 'git *': 'deny' }, bash: { 'git *': 'allow', 'npm *': 'ask' } });
  assert.deepEqual(both.bash, { '*': 'ask', 'rm *': 'deny', 'git *': 'allow', 'npm *': 'ask' }, "the tool's own rule comes last and wins");
  assert.deepEqual(Object.keys(both.bash), ['*', 'rm *', 'git *', 'npm *']);
});

test('readUserPermission: "__proto__" / "constructor" keys from a user file never pollute Object.prototype', (t) => {
  const project = mkdtempSync(path.join(tmpdir(), 'oc-perm-proto-'));
  const home = mkdtempSync(path.join(tmpdir(), 'oc-perm-proto-home-'));
  t.after(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  // Written as text: JSON.parse keeps "__proto__" as an own key (an object literal would not).
  writeFileSync(path.join(project, 'opencode.json'), '{"permission":{"__proto__":{"shell":"deny"},"constructor":"deny","bash":{"__proto__":"deny","prototype":"deny","git *":"allow"}},"__proto__":{"x":1},"permissions":[{"action":"__proto__","resource":"*","effect":"deny"},{"action":"constructor","resource":"*","effect":"deny"},{"action":"edit","resource":"__proto__","effect":"deny"},{"action":"toString","resource":"*","effect":"ask"}]}');
  const user = readUserPermission(project, home);
  assert.equal({}.shell, undefined, 'Object.prototype is clean');
  assert.equal({}.x, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.deepEqual(Object.keys(user).sort(), ['bash', 'toString']);
  assert.deepEqual(user.bash, { 'git *': 'allow' });
  assert.deepEqual(user.toString, { '*': 'ask' }, 'an own key, not the inherited function');
  assert.equal(Object.getPrototypeOf(user), Object.prototype, 'plain objects come back');
  // the merge reads own keys only: inherited names are no rules
  assert.deepEqual(mergePermission({ constructor: 'ask', toString: 'allow' }, {}, 'manual'), { constructor: 'ask', toString: 'allow' });
  assert.deepEqual(permissionConfig('build', JSON.parse('{"__proto__":{"*":"allow"},"bash":{"__proto__":"allow"}}')), { edit: 'allow', bash: 'ask', webfetch: 'ask' });
  assert.equal({}['*'], undefined);
});

test('readOnlyOpenCodeEnv: "*" deny, only the reading tools, the user\'s read rules and .env closed', () => {
  const lock = (env, user) => JSON.parse(readOnlyOpenCodeEnv(env, user).OPENCODE_CONFIG_CONTENT);
  const fresh = readOnlyOpenCodeEnv({});
  assert.equal(fresh.OPENCODE_DISABLE_AUTOUPDATE, '1');
  const base = lock({});
  assert.deepEqual(base.permission, { '*': 'deny', read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' }, grep: 'allow', glob: 'allow', list: 'allow' });
  assert.deepEqual(Object.keys(base.permission)[0], '*', '"*" first: the tool rules after it win (last match)');

  // the user's own allows elsewhere don't matter (the "*" deny of this last layer wins); their read denies stay
  const user = { bash: { '*': 'allow' }, mcp_foo: { '*': 'allow' }, read: { 'secret/*': 'deny' }, grep: { '*': 'ask' } };
  const withUser = lock({}, user).permission;
  assert.equal(withUser.bash, undefined);
  assert.equal(withUser.read['secret/*'], 'deny');
  assert.equal(withUser.grep, 'deny', 'ask → deny: nobody answers a one-shot run');
  const global = lock({}, { '*': { '*': 'deny' } }).permission;
  assert.equal(global.glob, 'deny', 'a global user deny keeps reading closed too');

  const merged = lock({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'x/y', permission: { bash: 'allow', read: { 'private/*': 'deny' } } }) });
  assert.equal(merged.model, 'x/y', 'other settings of the variable are kept');
  assert.equal(merged.permission['*'], 'deny');
  assert.equal(merged.permission.bash, undefined, 'its bash allow is gone');
  assert.equal(merged.permission.read['private/*'], 'deny', 'its read deny stays');
  assert.deepEqual(lock({ OPENCODE_CONFIG_CONTENT: '{"permission":"deny"}' }).permission, { '*': 'deny', read: 'deny', grep: 'deny', glob: 'deny', list: 'deny' });
  assert.deepEqual(lock({ OPENCODE_CONFIG_CONTENT: 'not json' }), base);
  assert.deepEqual(Object.keys(readOnlyOpenCodeEnv({ PATH: 'x', OPENCODE_CONFIG_CONTENT: '{}' })).sort(), ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_AUTOUPDATE'], 'only these two: merged over process.env by the caller');
});

test('childOpenCodeEnv: a parent OpenCode session marker never reaches a child opencode', () => {
  const nested = {
    PATH: 'x',
    OPENCODE: '1',
    OPENCODE_CLIENT: 'acp',
    OPENCODE_SESSION_ID: 'ses_e56e18152ffe',
    OPENCODE_TERMINAL: '1',
    OPENCODE_CONFIG_CONTENT: '{}',
    OPENCODE_CONFIG: 'C:/app/data/team/opencode-0123456789abcdef.json',
  };
  assert.deepEqual(childOpenCodeEnv(nested), { PATH: 'x', OPENCODE_CONFIG_CONTENT: '{}' }, 'our Mode tim file is dropped too');
  // a config path the user set themselves stays: it is not one of our team files
  const own = 'C:/Users/me/opencode.json';
  assert.equal(childOpenCodeEnv({ OPENCODE_CONFIG: own }).OPENCODE_CONFIG, own);
  assert.equal(childOpenCodeEnv({ OPENCODE_CONFIG: 'D:/work/data/team/notes.json' }).OPENCODE_CONFIG, 'D:/work/data/team/notes.json');
});
