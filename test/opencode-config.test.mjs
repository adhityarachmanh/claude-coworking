// OpenCode config/agent editor: safe file IO under a throwaway home/project/data folder. No OpenCode process and no network.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  backupRoot,
  configFile,
  configSources,
  consolidateProjectConfig,
  listBackups,
  mergeForm,
  openCodeConfigRoot,
  readBackup,
  readOpenCodeConfig,
  restoreBackup,
  saveOpenCodeConfig,
  writeBackup,
} from '../src/opencode-config.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-opencode-config-'));
const HOME = path.join(TMP, 'xdg');
const PROJECT = path.join(TMP, 'projects', 'toko');
const DATA = path.join(TMP, 'data');
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
// baseHash is mandatory: these helpers send the hash of the file as it is right now (null when it does not exist).
const hashOf = (where) => readOpenCodeConfig(where).hash;
const save = (where, extra = {}) => saveOpenCodeConfig({ ...where, dataDir: DATA, baseHash: hashOf(where), ...extra });
const restore = (where, id, extra = {}) => restoreBackup(where, DATA, id, { baseHash: hashOf({ scope: where.scope, projectPath: where.projectPath, home: where.home }), ...extra });
const consolidate = (where, extra = {}) =>
  consolidateProjectConfig({ ...where, dataDir: DATA, baseHash: hashOf({ scope: 'project', projectPath: where.projectPath }), ...extra });
const noBak = (dir) => readdirSync(dir).filter((name) => name.includes('.bak-'));

test('configFile: global under XDG, project root before .opencode, JSONC kept', () => {
  assert.equal(openCodeConfigRoot({ OFFICE_OPENCODE_CONFIG_HOME: HOME }), path.join(HOME, 'opencode'));
  assert.equal(configFile({ scope: 'global', home: HOME }).path, path.join(HOME, 'opencode', 'opencode.json'));
  const projectJson = path.join(PROJECT, 'opencode.json');
  assert.equal(configFile({ scope: 'project', projectPath: PROJECT, home: HOME }).path, projectJson);
  write(path.join(PROJECT, '.opencode', 'opencode.jsonc'), '{}');
  assert.equal(configFile({ scope: 'project', projectPath: PROJECT, home: HOME }).path, path.join(PROJECT, '.opencode', 'opencode.jsonc'), 'an existing .opencode file is used');
  write(projectJson, '{}');
  assert.equal(configFile({ scope: 'project', projectPath: PROJECT, home: HOME }).path, projectJson, 'the project root wins when both exist');
});

test('readOpenCodeConfig: agents expose name/mode/model/prompt, missing file is empty', () => {
  const file = path.join(HOME, 'opencode', 'opencode.jsonc');
  write(file, `{
    // a comment survives a raw JSON save
    "model": "anthropic/claude-sonnet-4",
    "small_model": "anthropic/claude-haiku",
    "agent": {
      "reviewer": { "mode": "subagent", "model": "openai/gpt-5", "description": "Review changes", "system": "Be strict" },
      "helper": { "prompt": "Help" }
    }
  }`);
  const view = readOpenCodeConfig({ scope: 'global', home: HOME });
  assert.equal(view.exists, true);
  assert.equal(view.format, 'jsonc');
  assert.equal(view.config.model, 'anthropic/claude-sonnet-4');
  assert.deepEqual(view.agents, [
    { name: 'helper', mode: '', model: '', description: '', prompt: 'Help' },
    { name: 'reviewer', mode: 'subagent', model: 'openai/gpt-5', description: 'Review changes', prompt: 'Be strict' },
  ]);
  assert.match(view.text, /a comment survives/);
  assert.equal(view.consolidatable, false, 'global is never consolidatable');
  const missing = readOpenCodeConfig({ scope: 'project', projectPath: path.join(TMP, 'empty'), home: HOME });
  assert.deepEqual({ exists: missing.exists, config: missing.config, agents: missing.agents }, { exists: false, config: {}, agents: [] });
  assert.equal(missing.hash, null, 'a missing file has no hash');
  assert.equal(missing.conflict, null);
  assert.equal(missing.consolidatable, false, 'nothing to merge');
});

test('save JSON keeps comments and makes a backup in the app data folder', () => {
  const file = path.join(HOME, 'opencode', 'opencode.jsonc');
  write(file, '{\n  // keep me\n  "model": "lama",\n}\n');
  const text = '{\n  // keep me\n  "model": "baru",\n}\n';
  const saved = save({ scope: 'global', home: HOME }, { mode: 'json', text });
  assert.equal(readFileSync(file, 'utf8'), text, 'raw text is written as typed (comments stay)');
  assert.ok(saved.backup, 'a previous file is backed up');
  assert.ok(saved.backup.startsWith(path.join(backupRoot(DATA), 'global')), `backup: ${saved.backup}`);
  assert.ok(path.basename(saved.backup).endsWith('-opencode.jsonc'), 'the original file name is part of the backup');
  assert.match(readFileSync(saved.backup, 'utf8'), /lama/);
  assert.equal(saved.config.model, 'baru');
  assert.deepEqual(noBak(path.dirname(file)), [], 'nothing is written next to the config');
  assert.deepEqual(readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp-')), [], 'no temp file is left behind');
});

test('save form merges model/small model and agents, preserving unknown fields', () => {
  const file = path.join(PROJECT, 'opencode.json');
  write(file, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: 'lama',
    agent: {
      keep: { mode: 'primary', tools: { bash: false }, system: 'old prompt' },
      gone: { mode: 'subagent' },
    },
  }));
  const saved = save({ scope: 'project', projectPath: PROJECT }, {
    mode: 'form',
    form: {
      model: 'anthropic/claude-opus-4',
      smallModel: '',
      agents: [{ name: 'keep', mode: 'primary', model: 'openai/gpt-5', description: '', prompt: 'new prompt' }],
    },
  });
  assert.equal(saved.config.$schema, 'https://opencode.ai/config.json');
  assert.equal(saved.config.model, 'anthropic/claude-opus-4');
  assert.equal(saved.config.small_model, undefined, 'blank small model removes the key');
  assert.deepEqual(Object.keys(saved.config.agent), ['keep']);
  assert.deepEqual(saved.config.agent.keep, {
    mode: 'primary',
    tools: { bash: false },
    system: 'new prompt',
    model: 'openai/gpt-5',
  });
  assert.deepEqual(saved.agents, [{ name: 'keep', mode: 'primary', model: 'openai/gpt-5', description: '', prompt: 'new prompt' }]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), saved.config);
});

test('a broken config is still readable (so the JSON tab can fix it); a form save refuses', () => {
  const file = path.join(PROJECT, 'opencode.json');
  write(file, '{ broken\n');
  const view = readOpenCodeConfig({ scope: 'project', projectPath: PROJECT, home: HOME });
  assert.equal(view.exists, true);
  assert.equal(view.text, '{ broken\n');
  assert.deepEqual(view.config, {});
  assert.match(view.parseError, /JSON\/JSONC/);
  assert.throws(() => save({ scope: 'project', projectPath: PROJECT }, { mode: 'form', form: { model: 'x' } }), /tab JSON/);
  const fixed = save({ scope: 'project', projectPath: PROJECT }, { mode: 'json', text: '{"model":"x"}\n' });
  assert.equal(fixed.parseError, null);
  assert.equal(fixed.config.model, 'x');
});

test('a form save refuses a malformed agent section instead of deleting it', () => {
  const file = path.join(PROJECT, 'opencode.json');
  write(file, '{"agent":["bukan objek"]}\n');
  const view = readOpenCodeConfig({ scope: 'project', projectPath: PROJECT, home: HOME });
  assert.throws(() => mergeForm(view.config, { agents: [] }), /"agent" bukan objek/i);
  write(file, '{"agent":{"rusak":"bukan objek"}}\n');
  const view2 = readOpenCodeConfig({ scope: 'project', projectPath: PROJECT, home: HOME });
  assert.throws(() => mergeForm(view2.config, { agents: [] }), /Agent "rusak" bukan objek/i);
});

test('invalid JSON, non-objects and bad agent names are refused without changing the file', () => {
  const file = path.join(PROJECT, 'opencode.json');
  write(file, '{"model":"aman"}\n');
  const where = { scope: 'project', projectPath: PROJECT };
  assert.throws(() => save(where, { mode: 'json', text: '{"model":' }), /JSON/);
  assert.throws(() => save(where, { mode: 'json', text: '[]' }), /objek JSON/);
  assert.throws(() => mergeForm({}, { agents: [{ name: 'bad name' }] }), /nama agent/i);
  assert.throws(() => mergeForm({}, { agents: [{ name: 'a' }, { name: 'a' }] }), /ganda/i);
  assert.equal(readFileSync(file, 'utf8'), '{"model":"aman"}\n');
});

test('configSources: every file OpenCode reads, in precedence order; the global legacy config.json is marked', () => {
  const home = path.join(TMP, 'xdg-sources');
  assert.deepEqual(
    configSources({ scope: 'global', home }).map((s) => [s.kind, s.format, s.exists, s.valid, path.basename(s.path)]),
    [
      ['global', 'json', false, false, 'opencode.json'],
      ['global', 'jsonc', false, false, 'opencode.jsonc'],
      ['legacy', 'json', false, false, 'config.json'],
    ],
  );
  write(path.join(home, 'opencode', 'config.json'), '{"model":"lama"}');
  const withLegacy = configSources({ scope: 'global', home });
  assert.deepEqual(withLegacy[2], { path: path.join(home, 'opencode', 'config.json'), kind: 'legacy', exists: true, format: 'json', valid: true });
  assert.equal(readOpenCodeConfig({ scope: 'global', home }).conflict, null, 'a legacy file alone is no conflict');

  const project = path.join(TMP, 'projects', 'sources');
  write(path.join(project, '.opencode', 'opencode.json'), '{"small_model":"dot"}');
  assert.deepEqual(
    configSources({ scope: 'project', projectPath: project }).map((s) => [s.kind, s.format, s.exists, path.relative(project, s.path)]),
    [
      ['project', 'json', false, 'opencode.json'],
      ['project', 'jsonc', false, 'opencode.jsonc'],
      ['dot-opencode', 'json', true, path.join('.opencode', 'opencode.json')],
      ['dot-opencode', 'jsonc', false, path.join('.opencode', 'opencode.jsonc')],
    ],
  );
  assert.throws(() => configSources({ scope: 'nope' }), /global atau project/);
  assert.throws(() => configSources({ scope: 'project' }), /Project tidak valid/);
});

test('a root and a .opencode file both exist: conflict names the effective file, the editor still edits the root', () => {
  const project = path.join(TMP, 'projects', 'sources');
  write(path.join(project, 'opencode.json'), '{"model":"root"}');
  const view = readOpenCodeConfig({ scope: 'project', projectPath: project });
  assert.equal(view.path, path.join(project, 'opencode.json'), 'the edited path does not change');
  assert.match(view.hash, /^[0-9a-f]{64}$/);
  assert.ok(view.conflict, 'a second source is reported');
  assert.deepEqual(view.conflict.others, [path.join(project, '.opencode', 'opencode.json')]);
  assert.equal(view.conflict.effective, path.join(project, '.opencode', 'opencode.json'));
  assert.equal(view.conflict.sameFolder, false);
  assert.match(view.conflict.message, /menang per kunci/, 'the later file wins per key');
  assert.match(view.conflict.message, /\.opencode\/opencode\.json/, 'the effective file is named');
  assert.match(view.conflict.message, /opencode\.json/, 'the edited file is named');
  assert.equal(view.sources.filter((s) => s.exists).length, 2);
  assert.equal(view.sources.find((s) => s.kind === 'dot-opencode').valid, true);
});

test('opencode.json + opencode.jsonc in one folder: only .json is read, the message says so', () => {
  const project = path.join(TMP, 'projects', 'same-folder');
  write(path.join(project, 'opencode.json'), '{"model":"json"}');
  write(path.join(project, 'opencode.jsonc'), '{ "model": "jsonc" }');
  const view = readOpenCodeConfig({ scope: 'project', projectPath: project });
  assert.equal(view.conflict.sameFolder, true);
  assert.equal(view.conflict.effective, path.join(project, 'opencode.json'));
  assert.deepEqual(view.conflict.others, [path.join(project, 'opencode.jsonc')]);
  assert.match(view.conflict.message, /hanya opencode\.json yang dibaca/);
  assert.match(view.conflict.message, /opencode\.jsonc diabaikan/);
});

test('consolidatable: project scope, a .opencode file, and two sources consolidation would really merge', () => {
  const project = path.join(TMP, 'projects', 'consolidatable');
  assert.equal(readOpenCodeConfig({ scope: 'project', projectPath: project }).consolidatable, false, 'nothing yet');
  write(path.join(project, 'opencode.json'), '{"model":"root"}');
  assert.equal(readOpenCodeConfig({ scope: 'project', projectPath: project }).consolidatable, false, 'root only');
  write(path.join(project, '.opencode', 'opencode.json'), '{"small_model":"dot"}');
  assert.equal(readOpenCodeConfig({ scope: 'project', projectPath: project }).consolidatable, true, 'root + .opencode');

  // The mixed case the UI used to hide: root .json + root .jsonc (ignored) + .opencode/.json.
  write(path.join(project, 'opencode.jsonc'), '{"model":"rootc"}');
  const mixed = readOpenCodeConfig({ scope: 'project', projectPath: project });
  assert.equal(mixed.conflict.sameFolder, true, 'the warning still mentions the ignored .jsonc');
  assert.equal(mixed.consolidatable, true, 'a root file and a .opencode file are still merged');

  // Two files only in .opencode: the .jsonc is shadowed, so consolidation has nothing to merge.
  const dotOnly = path.join(TMP, 'projects', 'consolidatable-dot');
  write(path.join(dotOnly, '.opencode', 'opencode.json'), '{"a":1}');
  write(path.join(dotOnly, '.opencode', 'opencode.jsonc'), '{"b":2}');
  const only = readOpenCodeConfig({ scope: 'project', projectPath: dotOnly });
  assert.equal(only.path, path.join(dotOnly, '.opencode', 'opencode.json'));
  assert.equal(only.consolidatable, false, 'one readable file, nothing to merge');
});

test('save: baseHash is mandatory and an optimistic lock (409 with a code)', async () => {
  const project = path.join(TMP, 'projects', 'lock');
  const file = path.join(project, 'opencode.json');
  write(file, '{"model":"a"}\n');
  const where = { scope: 'project', projectPath: project };
  const read = readOpenCodeConfig(where);
  const lockError = (pattern, code) => (err) => err.status === 409 && err.code === code && pattern.test(err.message);
  // no baseHash at all: the caller never read the file
  assert.throws(() => saveOpenCodeConfig({ ...where, dataDir: DATA, mode: 'json', text: '{"model":"b"}\n' }), lockError(/Muat ulang config lalu coba lagi/, 'lock-missing'));
  // null is only right for a file that does not exist yet
  assert.throws(() => saveOpenCodeConfig({ ...where, dataDir: DATA, mode: 'json', text: '{"model":"b"}\n', baseHash: null }), lockError(/berubah di luar aplikasi/, 'stale'));
  assert.equal(readFileSync(file, 'utf8'), '{"model":"a"}\n', 'a refused save changes nothing');

  const saved = save(where, { mode: 'json', text: '{"model":"b"}\n' });
  assert.equal(saved.config.model, 'b');
  assert.notEqual(saved.hash, read.hash);
  await tick();
  assert.throws(() => saveOpenCodeConfig({ ...where, dataDir: DATA, mode: 'json', text: '{"model":"c"}\n', baseHash: read.hash }), lockError(/Muat ulang lalu simpan lagi/, 'stale'));
  assert.throws(() => saveOpenCodeConfig({ ...where, dataDir: DATA, mode: 'json', text: '{"model":"c"}\n', baseHash: '' }), lockError(/Muat ulang lalu simpan lagi/, 'stale'), 'an empty string is not a hash');
  assert.equal(readFileSync(file, 'utf8'), '{"model":"b"}\n', 'a refused save changes nothing');

  // a new file: null is the hash of "nothing there yet"
  const fresh = path.join(TMP, 'projects', 'lock-new');
  const created = saveOpenCodeConfig({ scope: 'project', projectPath: fresh, dataDir: DATA, mode: 'json', text: '{"model":"n"}\n', baseHash: null });
  assert.equal(created.config.model, 'n');
  assert.throws(() => saveOpenCodeConfig({ scope: 'project', projectPath: fresh, dataDir: DATA, mode: 'json', text: '{"model":"m"}\n', baseHash: null }), lockError(/berubah di luar aplikasi/, 'stale'));
});

test('backups: newest first, valid flags, legacy .bak-* listed, preview, traversal refused', async () => {
  const project = path.join(TMP, 'projects', 'backups');
  const file = path.join(project, 'opencode.json');
  const target = { scope: 'project', projectPath: project, projectId: 'backups' };
  write(file, '{\n  // keep me\n  "model": "v1"\n}\n');
  for (const version of ['v2', 'v3', 'v4']) {
    await tick();
    save({ scope: 'project', projectPath: project }, { mode: 'json', text: `{"model":"${version}"}\n` });
  }
  assert.deepEqual(noBak(project), [], 'a save never writes .bak-* next to the file');

  const list = listBackups({ ...target, path: file }, DATA);
  assert.equal(list.length, 3, 'one backup per save');
  assert.deepEqual(list.map((b) => b.name.endsWith('-opencode.json')), [true, true, true]);
  assert.deepEqual(list.map((b) => b.legacy), [false, false, false]);
  assert.deepEqual(list.map((b) => b.valid), [true, true, true]);
  assert.deepEqual(list.map((b) => b.format), ['json', 'json', 'jsonc'], 'the commented file is a jsonc backup');
  assert.match(list[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(list[0].bytes > 0);

  const newest = readBackup({ ...target, path: file }, DATA, list[0].id);
  assert.equal(newest.text, '{"model":"v3"}\n', 'the newest backup is the file before the last save');
  assert.equal(newest.valid, true);
  assert.equal(newest.bytes, Buffer.byteLength(newest.text));

  write(path.join(project, 'opencode.json.bak-20200101T000000000Z'), '{ broken');
  const withLegacy = listBackups({ ...target, path: file }, DATA);
  const legacy = withLegacy.find((b) => b.legacy);
  assert.ok(legacy, 'a legacy .bak file next to the config is listed');
  assert.ok(legacy.id.startsWith('legacy:'));
  assert.equal(legacy.valid, false);
  assert.equal(readBackup({ ...target, path: file }, DATA, legacy.id).text, '{ broken');

  assert.throws(() => readBackup({ ...target, path: file }, DATA, 'tidak-ada'), (err) => err.status === 404);
  assert.throws(() => readBackup({ ...target, path: file }, DATA, '../../etc/passwd'), (err) => err.status === 404);
  assert.throws(() => readBackup({ ...target, path: file }, DATA, list[0].id.replace('-opencode.json', '-..\\x')), (err) => err.status === 404);
});

test('restore: needs the lock, is byte identical, refuses an invalid backup, backs the current file up first', async () => {
  const project = path.join(TMP, 'projects', 'restore');
  const file = path.join(project, 'opencode.json');
  const target = { scope: 'project', projectPath: project, projectId: 'restore' };
  const original = '{\n  // komentar hilang kalau disimpan lewat form\n  "model": "lama",\n}\n';
  write(file, original);
  await tick();
  save({ scope: 'project', projectPath: project }, { mode: 'json', text: '{"model":"baru"}\n' });
  const list = listBackups({ ...target, path: file }, DATA);
  assert.throws(() => restoreBackup({ ...target, path: file }, DATA, list[0].id), (err) => err.status === 409 && err.code === 'lock-missing' && /Muat ulang config lalu coba lagi/.test(err.message), 'restore needs baseHash too');
  assert.throws(() => restoreBackup({ ...target, path: file }, DATA, list[0].id, { baseHash: null }), (err) => err.status === 409 && err.code === 'stale' && /berubah di luar aplikasi/.test(err.message));
  const preview = readBackup({ ...target, path: file }, DATA, list[0].id);
  assert.equal(preview.text, original);
  const restored = restore({ ...target, path: file }, list[0].id);
  assert.equal(restored.restored, true);
  assert.equal(readFileSync(file, 'utf8'), original, 'restored byte for byte, comments included');
  assert.equal(restored.text, original);
  assert.ok(restored.backup, 'the replaced file is backed up first');
  assert.match(readFileSync(restored.backup, 'utf8'), /baru/);

  write(path.join(project, 'opencode.json.bak-20200101T000000000Z'), '{ broken');
  const broken = listBackups({ ...target, path: file }, DATA).find((b) => !b.valid);
  assert.ok(broken);
  assert.throws(() => restore({ ...target, path: file }, broken.id), (err) => err.status === 400 && /tidak bisa dipulihkan/.test(err.message));
  assert.equal(readFileSync(file, 'utf8'), original, 'a refused restore changes nothing');
});

test('listBackups prunes only inside its own folder, to keep and maxAgeDays, never another target', async () => {
  const project = path.join(TMP, 'projects', 'prune');
  const file = path.join(project, 'opencode.json');
  const target = { scope: 'project', projectPath: project, projectId: 'prune' };
  write(file, '{"n":0}\n');
  for (let n = 1; n <= 5; n++) {
    await tick();
    write(file, `{"n":${n}}\n`);
    writeBackup({ ...target, path: file }, DATA);
  }
  write(path.join(project, 'other.json'), '{}\n');
  write(path.join(project, 'other.json.bak-20200101T000000000Z'), '{}\n');

  const kept = listBackups({ ...target, path: file }, DATA, { keep: 2 });
  assert.equal(kept.length, 2, 'only the newest two stay');
  const folder = path.join(backupRoot(DATA), 'prune');
  assert.equal(readdirSync(folder).filter((name) => name.endsWith('-opencode.json')).length, 2);
  assert.ok(existsSync(path.join(project, 'other.json.bak-20200101T000000000Z')), "another target's legacy backup is untouched");

  const old = new Date(Date.now() - 120 * 86_400_000);
  for (const name of readdirSync(folder)) utimesSync(path.join(folder, name), old, old);
  const aged = listBackups({ ...target, path: file }, DATA, { keep: 10 });
  assert.equal(aged.length, 1, 'a backup older than maxAgeDays goes, the newest always stays');
});

test('legacy .bak-* files: at most the 20 newest are listed, never pruned, 512 KB read cap', () => {
  const project = path.join(TMP, 'projects', 'legacy');
  const file = path.join(project, 'opencode.json');
  write(file, '{"n":0}\n');
  for (let n = 1; n <= 25; n++) write(`${file}.bak-20200101T0000${String(n).padStart(2, '0')}Z`, '{"model":"old"}\n');
  write(file, '{"n":1}\n');
  writeBackup({ scope: 'project', projectPath: project, projectId: 'legacy', path: file }, DATA); // one of ours, to prune
  const medium = `${file}.bak-20200101T000098Z`;
  write(medium, `{"pad":"${'x'.repeat(300 * 1024)}"}`);
  const tooBig = `${file}.bak-20200101T000099Z`;
  write(tooBig, `{"pad":"${'x'.repeat(600 * 1024)}"}`);

  const where = { scope: 'project', projectPath: project, projectId: 'legacy', path: file };
  const list = listBackups(where, DATA, { keep: 0 });
  assert.equal(list.filter((entry) => !entry.legacy).length, 0, 'own backups still follow keep');
  assert.equal(list.filter((entry) => entry.legacy).length, 20, 'the legacy scan is bounded to the 20 newest');
  assert.equal(list[0].id, `legacy:${path.basename(tooBig)}`);
  assert.equal(list[0].valid, false, 'over 512 KB: listed without being read');
  assert.equal(list[0].bytes, statSync(tooBig).size, 'bytes come from stat');
  const ok = list.find((entry) => entry.id === `legacy:${path.basename(medium)}`);
  assert.equal(ok.valid, true, 'a 300 KB legacy backup is valid: the cap is 512 KB');
  assert.equal(ok.bytes, statSync(medium).size);
  assert.equal(readBackup(where, DATA, ok.id).text.length, statSync(medium).size);
  assert.equal(readdirSync(project).filter((name) => name.includes('.bak-')).length, 27, 'legacy files are never deleted');
});

test('a backup is validated like a save: prototype keys and non-objects are invalid and cannot be restored', () => {
  const project = path.join(TMP, 'projects', 'strict');
  const file = path.join(project, 'opencode.json');
  const where = { scope: 'project', projectPath: project, projectId: 'strict', path: file };
  write(file, '{"model":"aman"}\n');
  write(`${file}.bak-20200101T000001Z`, '{"__proto__":{"polluted":true}}');
  write(`${file}.bak-20200101T000002Z`, '{"constructor":{"prototype":{"polluted":true}}}');
  write(`${file}.bak-20200101T000003Z`, '[]');
  write(`${file}.bak-20200101T000004Z`, '{"model":"ok"}');
  const list = listBackups(where, DATA);
  const byId = (stamp) => list.find((entry) => entry.id === `legacy:${path.basename(file)}.bak-${stamp}`);
  const proto = byId('20200101T000001Z');
  const ctor = byId('20200101T000002Z');
  const array = byId('20200101T000003Z');
  const good = byId('20200101T000004Z');
  assert.equal(proto.valid, false, 'a __proto__ key is invalid');
  assert.equal(ctor.valid, false, 'a constructor key is invalid');
  assert.equal(array.valid, false, 'a non-object is invalid');
  assert.equal(good.valid, true);
  assert.throws(() => restore(where, proto.id), (err) => err.status === 400 && /tidak bisa dipulihkan/.test(err.message));
  assert.throws(() => restore(where, array.id), (err) => err.status === 400 && /tidak bisa dipulihkan/.test(err.message));
  assert.equal(readFileSync(file, 'utf8'), '{"model":"aman"}\n', 'a refused restore changes nothing');
  assert.equal({}.polluted, undefined, 'the prototype was never touched');
});

test('dot-- recovery copies are pruned on their own: newest 5, gone after 90 days', () => {
  const project = path.join(TMP, 'projects', 'moved');
  const file = path.join(project, 'opencode.json');
  write(file, '{"model":"root"}\n');
  const dir = path.join(backupRoot(DATA), 'moved');
  for (let n = 1; n <= 8; n++) write(path.join(dir, `dot--20200101T0000${String(n).padStart(2, '0')}Z-abc-opencode.json`), '{"m":"dot"}\n');
  const where = { scope: 'project', projectPath: project, projectId: 'moved', path: file };
  const left = () => readdirSync(dir).filter((name) => name.startsWith('dot--')).sort();
  listBackups(where, DATA);
  assert.equal(left().length, 5, 'the newest five recovery copies stay');
  assert.deepEqual(left(), [4, 5, 6, 7, 8].map((n) => `dot--20200101T0000${String(n).padStart(2, '0')}Z-abc-opencode.json`));
  assert.equal(listBackups(where, DATA, { keep: 10 }).length, 0, 'they never show up in the root history');

  const old = new Date(Date.now() - 120 * 86_400_000);
  for (const name of left()) utimesSync(path.join(dir, name), old, old);
  listBackups(where, DATA);
  assert.equal(left().length, 1, 'the newest copy always stays, the rest go after 90 days');
});

test('a project id can never point the backup folder outside the backup root', () => {
  const project = path.join(TMP, 'projects', 'folderid');
  const file = path.join(project, 'opencode.json');
  write(file, '{"a":1}\n');
  const safe = writeBackup({ scope: 'project', projectPath: project, projectId: 'folderid', path: file }, DATA);
  assert.equal(path.basename(path.dirname(safe.path)), 'folderid', 'a safe id keeps its own folder');
  for (const id of ['..', '.', 'a/b', 'a\\b', 'Global', 'with space', 'x'.repeat(60)]) {
    const backup = writeBackup({ scope: 'project', projectPath: project, projectId: id, path: file }, DATA);
    const root = `${path.resolve(backupRoot(DATA))}${path.sep}`;
    assert.ok(backup.path.startsWith(root), `inside the backup root for id ${JSON.stringify(id)}: ${backup.path}`);
    assert.ok(!path.relative(backupRoot(DATA), backup.path).split(path.sep).includes('..'));
  }
});

test('backups are private: 0700 folders, 0600 files, the config keeps its own mode', (t) => {
  if (process.platform === 'win32') return t.skip('Windows uses ACLs, not POSIX modes');
  const project = path.join(TMP, 'projects', 'perm');
  const file = path.join(project, 'opencode.json');
  write(file, '{"model":"a"}\n');
  chmodSync(file, 0o640);
  save({ scope: 'project', projectPath: project, projectId: 'perm' }, { mode: 'json', text: '{"model":"b"}\n' });
  assert.equal(statSync(file).mode & 0o777, 0o640, 'the config keeps the mode it had');
  const dir = path.join(path.resolve(backupRoot(DATA)), 'perm');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(path.resolve(backupRoot(DATA))).mode & 0o777, 0o700, 'the backup root is private too');
  const backup = readdirSync(dir)[0];
  assert.equal(statSync(path.join(dir, backup)).mode & 0o777, 0o600);
});

test('a symlinked config file is refused by save, restore and consolidate', (t) => {
  const project = path.join(TMP, 'projects', 'symlink');
  const real = path.join(project, 'real.json');
  write(real, '{"model":"real"}\n');
  const link = path.join(project, 'opencode.json');
  try {
    symlinkSync(real, link, 'file');
  } catch (err) {
    return t.skip(`symlink not allowed here (${err.code})`);
  }
  const where = { scope: 'project', projectPath: project, projectId: 'symlink' };
  const refused = (err) => err.status === 400 && /symlink|junction/i.test(err.message);
  assert.throws(() => save(where, { mode: 'json', text: '{"model":"x"}\n' }), refused);
  const backup = writeBackup({ ...where, path: link }, DATA);
  assert.ok(backup);
  assert.throws(() => restore({ ...where, path: link }, backup.id), refused);
  write(path.join(project, '.opencode', 'opencode.json'), '{"small_model":"y"}\n');
  assert.throws(() => consolidate(where), refused);
  assert.equal(readFileSync(real, 'utf8'), '{"model":"real"}\n', 'the real file behind the link was not touched');
});

test('a junction on .opencode cannot send save, restore or consolidate outside the project', (t) => {
  const project = path.join(TMP, 'projects', 'junction');
  const outside = path.join(TMP, 'outside-junction');
  mkdirSync(project, { recursive: true });
  write(path.join(outside, 'opencode.json'), '{"model":"luar"}\n');
  try {
    symlinkSync(outside, path.join(project, '.opencode'), 'junction'); // works on Windows without admin
  } catch (err) {
    assert.fail(`junction should be allowed here: ${err.code}`);
  }
  // Some Windows setups create the junction but Node cannot traverse it (EPERM/UNKNOWN on scandir). The guard
  // still matters where junctions do work, so skip instead of failing the suite on such a machine.
  if (!existsSync(path.join(project, '.opencode', 'opencode.json'))) return t.skip('junction is not readable in this environment');
  const where = { scope: 'project', projectPath: project, projectId: 'junction' };
  const view = readOpenCodeConfig({ scope: 'project', projectPath: project });
  assert.equal(view.path, path.join(project, '.opencode', 'opencode.json'), 'the editor sees the junctioned file');
  const refused = (err) => err.status === 400 && /symlink|junction/i.test(err.message);

  assert.throws(() => save(where, { mode: 'json', text: '{"model":"x"}\n' }), refused, 'save');
  const backup = writeBackup({ ...where, path: view.path }, DATA);
  assert.ok(backup);
  assert.throws(() => restore({ ...where, path: view.path }, backup.id), refused, 'restore');
  write(path.join(project, 'opencode.json'), '{"model":"root"}\n');
  assert.equal(readOpenCodeConfig({ scope: 'project', projectPath: project }).sources.filter((s) => s.exists).length, 2);
  assert.throws(() => consolidate(where), refused, 'consolidate');
  assert.equal(readFileSync(path.join(outside, 'opencode.json'), 'utf8'), '{"model":"luar"}\n', 'the file outside the project is untouched');
});

test('consolidate: deep merge with .opencode winning, root file written, .opencode file moved to the backups', async () => {
  const project = path.join(TMP, 'projects', 'consolidate');
  const root = path.join(project, 'opencode.json');
  const dot = path.join(project, '.opencode', 'opencode.json');
  const where = { scope: 'project', projectPath: project, projectId: 'consolidate' };
  const rootText = `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: 'root-model',
    instructions: ['root.md'],
    agent: { a: { mode: 'primary', model: 'openai/gpt-5' }, b: { mode: 'subagent', description: 'dari root' } },
  })}\n`;
  const dotText = `${JSON.stringify({
    model: 'dot-model',
    instructions: ['dot.md'],
    agent: { b: { model: 'anthropic/claude-opus-4' }, c: { mode: 'all' } },
    permission: { bash: 'ask' },
  })}\n`;
  write(root, rootText);
  write(dot, dotText);

  const tempFiles = () => readdirSync(project).filter((name) => name.includes('.tmp-'));
  const result = consolidate(where);
  assert.equal(result.consolidated, true);
  assert.equal(result.path, root);
  assert.equal(result.config.model, 'dot-model', '.opencode wins per key');
  assert.equal(result.config.$schema, 'https://opencode.ai/config.json', 'root-only keys stay');
  assert.deepEqual(result.config.instructions, ['dot.md'], 'arrays are replaced, not merged');
  assert.deepEqual(result.config.agent.a, { mode: 'primary', model: 'openai/gpt-5' }, 'objects merge recursively');
  assert.deepEqual(result.config.agent.b, { mode: 'subagent', description: 'dari root', model: 'anthropic/claude-opus-4' });
  assert.deepEqual(result.config.agent.c, { mode: 'all' });
  assert.deepEqual(result.config.permission, { bash: 'ask' });
  assert.equal(result.conflict, null, 'one source left');
  assert.equal(result.consolidatable, false, 'nothing left to merge');
  assert.equal(readFileSync(root, 'utf8'), `${JSON.stringify(result.config, null, 2)}\n`, 'pretty JSON on disk');
  assert.equal(existsSync(dot), false, 'the .opencode file is moved, not left behind');
  assert.deepEqual(tempFiles(), [], 'consolidate leaves no temp file behind');
  assert.ok(result.movedBackup && existsSync(result.movedBackup));
  assert.equal(readFileSync(result.movedBackup, 'utf8'), dotText, 'the moved copy is byte identical');
  assert.deepEqual(result.movedBackups, [result.movedBackup], 'the new array keeps the same path');
  assert.match(path.basename(result.movedBackup), /^dot--/, 'the moved copy is not named like this target\'s backup');
  const backups = listBackups({ ...where, path: root }, DATA);
  assert.ok(backups.every((entry) => !entry.name.startsWith('dot--')), 'the moved .opencode file is not a restorable root backup');
  assert.ok(backups.every((entry) => !String(entry.id).startsWith('dot--')));
  const rootBackup = backups.find((entry) => readBackup({ ...where, path: root }, DATA, entry.id).text === rootText);
  assert.ok(rootBackup, 'the root file before the merge was backed up');

  const again = () => consolidate(where);
  assert.throws(again, (err) => err.status === 400 && /satu file config/.test(err.message));
});

test('consolidate: refused without baseHash, and when a source does not parse nothing is moved', () => {
  const project = path.join(TMP, 'projects', 'consolidate-broken');
  const root = path.join(project, 'opencode.json');
  const dot = path.join(project, '.opencode', 'opencode.json');
  write(root, '{"model":"root"}\n');
  write(dot, '{ broken\n');
  assert.throws(
    () => consolidateProjectConfig({ scope: 'project', projectPath: project, dataDir: DATA }),
    (err) => err.status === 409 && err.code === 'lock-missing' && /Muat ulang config lalu coba lagi/.test(err.message),
  );
  assert.throws(() => consolidate({ scope: 'project', projectPath: project }), (err) => err.status === 400 && /bukan JSON\/JSONC yang valid/.test(err.message));
  assert.equal(readFileSync(root, 'utf8'), '{"model":"root"}\n');
  assert.equal(existsSync(dot), true);
});

test('consolidate writes the merged root before moving .opencode; a failed move keeps both', (t) => {
  if (process.platform === 'win32') return t.skip('Windows does not refuse the rename, so the failed-move branch cannot be reached here');
  const project = path.join(TMP, 'projects', 'order');
  const root = path.join(project, 'opencode.json');
  const dotDir = path.join(project, '.opencode');
  const dot = path.join(dotDir, 'opencode.json');
  write(root, '{"model":"root","keep":true}\n');
  write(dot, '{"model":"dot"}\n');
  const where = { scope: 'project', projectPath: project, projectId: 'order' };
  // A directory without write permission: the file can be read but not renamed out of it.
  chmodSync(dotDir, 0o500);
  let error = null;
  try {
    consolidate(where);
  } catch (err) {
    error = err;
  } finally {
    chmodSync(dotDir, 0o700);
  }

  const merged = JSON.parse(readFileSync(root, 'utf8'));
  assert.equal(merged.model, 'dot', 'the merged root is on disk even when the move failed');
  assert.equal(merged.keep, true);
  assert.deepEqual(readdirSync(project).filter((name) => name.includes('.tmp-')), [], 'no temp file is left behind');
  assert.ok(error, 'the failed move is reported');
  assert.equal(error.status, 500);
  assert.match(error.message, /tidak bisa dipindah/);
  assert.match(error.message, /opencode\.json/);
  assert.equal(existsSync(dot), true, 'the .opencode file stays: the effective config is unchanged');
});

test('save over a read-only config uses the replace fallback and leaves no temp file', (t) => {
  if (process.platform !== 'win32') return t.skip('only Windows refuses to replace a read-only file');
  const project = path.join(TMP, 'projects', 'readonly');
  const file = path.join(project, 'opencode.json');
  write(file, '{"model":"a"}\n');
  chmodSync(file, 0o444);
  const saved = save({ scope: 'project', projectPath: project }, { mode: 'json', text: '{"model":"b"}\n' });
  assert.equal(saved.config.model, 'b');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).model, 'b');
  assert.deepEqual(readdirSync(project).filter((name) => name.includes('.tmp-')), [], 'the temp file is gone');
  chmodSync(file, 0o666);
});

test('routes: 409 bodies carry a code (lock-missing, stale, busy), other errors keep { error }', async () => {
  const { register } = await import('../src/routes/opencode-config.js');
  const handlers = new Map();
  register({ post: (pattern, handler) => handlers.set(pattern, handler) });
  const project = path.join(TMP, 'projects', 'routes');
  const file = path.join(project, 'opencode.json');
  write(file, '{"model":"a"}\n');
  const ctx = {
    opencode: {},
    hub: { dataDir: DATA, projects: new Map([['r1', { id: 'r1', path: project, virtual: false }]]) },
    sessions: { sessions: new Map(), openCodeConfigChanged: () => 0 },
  };
  const call = (route, body, context = ctx) => {
    let out = null;
    const res = { writeHead: (status) => { out = { status }; }, end: (text) => { out.body = JSON.parse(text); } };
    handlers.get(route)(context, {}, res, {}, body);
    return out;
  };
  const hash = readOpenCodeConfig({ scope: 'project', projectPath: project }).hash;

  let r = call('/api/opencode-config/save', { scope: 'project', projectId: 'r1', mode: 'json', text: '{"model":"b"}\n' });
  assert.deepEqual({ status: r.status, code: r.body.code }, { status: 409, code: 'lock-missing' });
  r = call('/api/opencode-config/save', { scope: 'project', projectId: 'r1', mode: 'json', text: '{"model":"b"}\n', baseHash: 'lama' });
  assert.deepEqual({ status: r.status, code: r.body.code }, { status: 409, code: 'stale' });
  r = call('/api/opencode-config/restore', { scope: 'project', projectId: 'r1', id: 'apa-saja' });
  assert.deepEqual({ status: r.status, code: r.body.code }, { status: 409, code: 'lock-missing' });
  r = call('/api/opencode-config/consolidate', { projectId: 'r1' });
  assert.deepEqual({ status: r.status, code: r.body.code }, { status: 409, code: 'lock-missing' });

  const busyCtx = { ...ctx, sessions: { sessions: new Map([['s1', { turnActive: () => true }]]), openCodeConfigChanged: () => 0 } };
  for (const [route, body] of [
    ['/api/opencode-config/save', { scope: 'project', projectId: 'r1', mode: 'json', text: '{"model":"b"}\n', baseHash: hash }],
    ['/api/opencode-config/restore', { scope: 'project', projectId: 'r1', id: 'apa-saja', baseHash: hash }],
    ['/api/opencode-config/consolidate', { projectId: 'r1', baseHash: hash }],
  ]) {
    r = call(route, body, busyCtx);
    assert.deepEqual({ status: r.status, code: r.body.code }, { status: 409, code: 'busy' }, route);
  }

  r = call('/api/opencode-config/save', { scope: 'project', projectId: 'r1', mode: 'json', text: '{"model":"b"}\n', baseHash: hash });
  assert.equal(r.status, 200);
  assert.equal(Object.hasOwn(r.body, 'code'), false, 'a success carries no code');
  r = call('/api/opencode-config/save', { scope: 'project', projectId: 'r1', mode: 'json', text: '{broken', baseHash: r.body.hash });
  assert.deepEqual({ status: r.status, code: r.body.code }, { status: 400, code: undefined }, 'a 400 keeps its old shape');
});
