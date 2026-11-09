// 📦 OpenCode session backup helpers: list/export through the CLI and import without duplicates.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectOpenCodeSessions, importOpenCodeSessions } from '../src/opencode-backup.js';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'office-oc-backup-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const project = path.join(TMP, 'project');
mkdirSync(project, { recursive: true });
const script = path.join(TMP, 'fake-opencode.mjs');
writeFileSync(script, `
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const list = () => JSON.parse(process.env.FAKE_OC_LIST || '[]');
if (args[0] === 'session' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(list().map((id) => ({ id, title: 'uji', updated: 1 }))));
} else if (args[0] === 'session' && args[1] === 'export') {
  process.stdout.write(JSON.stringify({ info: { id: args[2], location: { directory: process.cwd() } }, messages: [] }));
} else if (args[0] === 'session' && args[1] === 'import') {
  const i = args.indexOf('--directory');
  appendFileSync(process.env.FAKE_OC_IMPORTS, args[2] + '|' + (i >= 0 ? args[i + 1] : '') + '\\n');
} else {
  process.exit(1);
}
`);
const bin = { command: process.execPath, args: [script] };
const withEnv = async (env, fn) => {
  const before = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, before);
  }
};

test('collectOpenCodeSessions: lists/export only valid sessions, with a size bound', async () => {
  await withEnv({ FAKE_OC_LIST: JSON.stringify(['ses_one', 'ses_two']) }, async () => {
    const result = await collectOpenCodeSessions(bin, [{ id: 'p1', path: project }]);
    assert.equal(result.sessions.length, 2);
    assert.deepEqual(result.sessions.map((s) => s.sessionId), ['ses_one', 'ses_two']);
    assert.match(result.sessions[0].data.toString('utf8'), /"id":"ses_one"/);
    assert.equal(result.sessions[0].projectId, 'p1');
  });
});

test('importOpenCodeSessions: imports new ids and skips ones already in OpenCode', async () => {
  const imports = path.join(TMP, 'imports.log');
  const sessions = [
    { projectId: 'p1', sessionId: 'ses_new', data: Buffer.from('{}') },
    { projectId: 'p1', sessionId: 'ses_old', data: Buffer.from('{}') },
  ];
  await withEnv({ FAKE_OC_LIST: JSON.stringify(['ses_old']), FAKE_OC_IMPORTS: imports }, async () => {
    const result = await importOpenCodeSessions(bin, {
      sessions,
      resolveProject: () => project,
      tempDir: TMP,
    });
    assert.deepEqual(result.added, [{ projectId: 'p1', sessionId: 'ses_new' }]);
    assert.deepEqual(result.skipped, ['p1/ses_old']);
    const log = readFileSync(imports, 'utf8').trim().split('\n');
    assert.equal(log.length, 1);
    assert.match(log[0], new RegExp(`\\|${project.replace(/\\/g, '\\\\')}$`));
  });
});
