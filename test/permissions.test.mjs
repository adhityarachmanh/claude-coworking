import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { PermissionError, cleanRule, editPermission, readPermissions } from '../src/permissions.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-perms-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
/** A fresh project folder + user config folder per test. */
function setup() {
  const project = path.join(TMP, `p${++n}`);
  const userDir = path.join(TMP, `u${n}`);
  mkdirSync(project, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  return { project, userDir, opts: { userDir }, local: path.join(project, '.claude', 'settings.local.json'), user: path.join(userDir, 'settings.json') };
}
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('reads every source; a missing file is an empty source, not an error', async () => {
  const { project, opts, local } = setup();
  mkdirSync(path.dirname(local), { recursive: true });
  // the format Claude Code writes for "always allow" (seen on disk)
  writeFileSync(local, '{\n  "permissions": {\n    "allow": [\n      "Bash(node *)"\n    ]\n  }\n}\n');
  const { scopes } = await readPermissions(project, opts);
  assert.deepEqual(scopes.map((s) => s.scope), ['local', 'project', 'user']);
  assert.deepEqual(scopes[0].rules, { allow: ['Bash(node *)'], deny: [], ask: [] });
  assert.equal(scopes[0].exists, true);
  assert.equal(scopes[0].file, '.claude/settings.local.json');
  assert.equal(scopes[1].exists, false);
  assert.ok(scopes.every((s) => s.label && s.hint));
});

test('add / move / remove keep every other key of the file (and its order)', async () => {
  const { project, opts, local } = setup();
  mkdirSync(path.dirname(local), { recursive: true });
  const original = {
    model: 'opus',
    permissions: { defaultMode: 'acceptEdits', allow: ['Bash(node *)'], additionalDirectories: ['../shared'] },
    env: { FOO: '1' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
  };
  writeFileSync(local, JSON.stringify(original, null, 2));

  await editPermission(project, { scope: 'local', action: 'add', list: 'allow', rule: '  Bash(npm run test:*) ' }, opts);
  let data = readJson(local);
  assert.deepEqual(data.permissions.allow, ['Bash(node *)', 'Bash(npm run test:*)'], 'trimmed, appended');
  assert.deepEqual(Object.keys(data), ['model', 'permissions', 'env', 'hooks']);
  assert.deepEqual(Object.keys(data.permissions), ['defaultMode', 'allow', 'additionalDirectories']);

  const moved = await editPermission(project, { scope: 'local', action: 'move', list: 'allow', rule: 'Bash(node *)', to: 'deny' }, opts);
  assert.deepEqual(moved.rules, { allow: ['Bash(npm run test:*)'], deny: ['Bash(node *)'], ask: [] });
  await editPermission(project, { scope: 'local', action: 'remove', list: 'allow', rule: 'Bash(npm run test:*)' }, opts);
  data = readJson(local);
  assert.deepEqual(data.permissions, { defaultMode: 'acceptEdits', allow: [], additionalDirectories: ['../shared'], deny: ['Bash(node *)'] });
  assert.deepEqual(data.env, original.env);
  assert.deepEqual(data.hooks, original.hooks);
  assert.equal(data.model, 'opus');
  assert.deepEqual(readdirSync(path.dirname(local)), ['settings.local.json'], 'no temp file left behind (atomic write)');
});

test('a missing file (and its .claude folder) is created on the first rule', async () => {
  const { project, opts, user } = setup();
  await editPermission(project, { scope: 'project', action: 'add', list: 'ask', rule: 'WebFetch(domain:example.com)' }, opts);
  assert.deepEqual(readJson(path.join(project, '.claude', 'settings.json')), { permissions: { ask: ['WebFetch(domain:example.com)'] } });
  await editPermission(project, { scope: 'user', action: 'add', list: 'deny', rule: 'Read(./.env)' }, opts);
  assert.deepEqual(readJson(user), { permissions: { deny: ['Read(./.env)'] } });
  assert.match(readFileSync(user, 'utf8'), /^\{\n {2}"permissions"/, 'pretty, 2 spaces');
});

test('broken JSON: reported on its source, never overwritten', async () => {
  const { project, opts, local } = setup();
  mkdirSync(path.dirname(local), { recursive: true });
  const broken = '{ "permissions": { "allow": ["Bash(ls)", }';
  writeFileSync(local, broken);
  const { scopes } = await readPermissions(project, opts);
  assert.match(scopes[0].error, /bukan JSON yang valid/);
  assert.deepEqual(scopes[2].rules.allow, [], 'the other sources still read');
  await assert.rejects(editPermission(project, { scope: 'local', action: 'add', list: 'allow', rule: 'Read' }, opts), (err) => err instanceof PermissionError && err.status === 409 && /tidak akan menimpanya/.test(err.message));
  assert.equal(readFileSync(local, 'utf8'), broken, 'the file is untouched');
  // a wrong shape is refused the same way
  writeFileSync(local, '{"permissions":{"allow":"Bash"}}');
  await assert.rejects(editPermission(project, { scope: 'local', action: 'add', list: 'allow', rule: 'Read' }, opts), /bukan array/);
  writeFileSync(local, '[1,2]');
  await assert.rejects(editPermission(project, { scope: 'local', action: 'add', list: 'allow', rule: 'Read' }, opts), /objek JSON/);
});

test('validation: rule format, list, scope, duplicates, unknown rules', async () => {
  for (const ok of ['Bash', 'Bash(npm run test:*)', 'Read(//c/Users/**)', 'mcp__github', 'mcp__github__create_issue', 'WebFetch(domain:example.com)', 'Edit(src/**/*.ts)']) assert.equal(cleanRule(ok), ok);
  for (const bad of ['', '   ', 'Bash(', 'Bash()', '(ls)', '1Bash', 'Bash ls', 'Bash(ls)x', 'Bash(a\nb)', 'x'.repeat(501)]) assert.throws(() => cleanRule(bad), PermissionError, JSON.stringify(bad));
  const { project, opts } = setup();
  const edit = (e) => editPermission(project, e, opts);
  await assert.rejects(edit({ scope: 'global', action: 'add', list: 'allow', rule: 'Read' }), /Sumber/);
  await assert.rejects(edit({ scope: 'local', action: 'add', list: 'trust', rule: 'Read' }), /allow, deny, atau ask/);
  await assert.rejects(edit({ scope: 'local', action: 'wipe', list: 'allow', rule: 'Read' }), /Aksi/);
  await assert.rejects(edit({ scope: 'local', action: 'move', list: 'allow', rule: 'Read', to: 'allow' }), /berbeda/);
  await edit({ scope: 'local', action: 'add', list: 'allow', rule: 'Read' });
  await assert.rejects(edit({ scope: 'local', action: 'add', list: 'allow', rule: 'Read' }), (err) => err.status === 409);
  await assert.rejects(edit({ scope: 'local', action: 'remove', list: 'deny', rule: 'Read' }), (err) => err.status === 404);
  await assert.rejects(edit({ scope: 'local', action: 'remove', list: 'allow', rule: 'Write' }), (err) => err.status === 404);
});

test('quick edits in a row are serialized (none is lost)', async () => {
  const { project, opts, local } = setup();
  await Promise.all(['A', 'B', 'C', 'D', 'E'].map((t) => editPermission(project, { scope: 'local', action: 'add', list: 'allow', rule: t }, opts)));
  assert.deepEqual(readJson(local).permissions.allow.sort(), ['A', 'B', 'C', 'D', 'E']);
});
