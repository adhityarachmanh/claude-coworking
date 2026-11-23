// Claude flags → spawn (src/session.js): the stored values reach the process as single argv elements.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';
import { SessionManager } from '../src/session.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitRecord(file, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        // still writing
      }
    }
    await sleep(25);
  }
  throw new Error('fake CLI tidak menulis record');
}

function fakeClaude(recordFile) {
  const script = path.join(path.dirname(recordFile), 'fake-claude.cjs');
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ argv: process.argv.slice(2) }));\n`);
  return { command: process.execPath, args: [script] };
}

function fresh() {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), 'cfs-data-')) });
  const dir = mkdtempSync(path.join(tmpdir(), 'cfs-proj-'));
  const project = hub.upsertProject(dir, 'custom');
  const manager = new SessionManager({ hub, claude: fakeClaude(path.join(dir, 'spawn.json')), opencode: null, agents: {}, teamPrompt: '', ledger: null, account: null });
  return { hub, dir, project, manager };
}

test('spawn meneruskan flag Claude per project', async () => {
  const { hub, dir, project, manager } = fresh();
  hub.updateSettings(project.id, {
    claudeFallbackModel: 'sonnet,haiku',
    claudeMaxTurns: 4,
    claudeMaxBudgetUsd: 7,
    claudeTools: 'Bash,Edit',
    claudeAllowedTools: ['Read', 'Bash(git log *)'],
    claudeDisallowedTools: ['Edit'],
    claudeSettingSources: 'user,project',
    claudeAdvisor: 'opus',
    claudeFastMode: true,
    claudePromptSuggestions: true,
  });
  const session = manager.get(project);
  session.spawn(hub.settingsFor(project.id));
  const { argv } = await waitRecord(path.join(dir, 'spawn.json'));
  const at = (flag) => argv.indexOf(flag);
  assert.ok(at('--fallback-model') >= 0);
  assert.equal(argv[at('--fallback-model') + 1], 'sonnet,haiku');
  assert.equal(argv[at('--max-turns') + 1], '4');
  assert.equal(argv[at('--max-budget-usd') + 1], '7');
  assert.equal(argv[at('--tools') + 1], 'Bash,Edit');
  assert.deepEqual(argv.slice(at('--allowedTools') + 1, at('--allowedTools') + 3), ['Read', 'Bash(git log *)']);
  assert.equal(argv[at('--disallowedTools') + 1], 'Edit');
  assert.equal(argv[at('--setting-sources') + 1], 'user,project');
  assert.equal(argv[at('--advisor') + 1], 'opus');
  assert.ok(argv.includes('--prompt-suggestions'), 'saran prompt ikut saat dinyalakan');
  const settingsFile = argv[at('--settings') + 1];
  assert.ok(settingsFile && readFileSync(settingsFile, 'utf8').includes('"fastMode":true'), 'fast mode lewat --settings');
  session.closeChild();
});

test('perubahan flag menutup proses idle (restartKey)', () => {
  const { hub, project, manager } = fresh();
  const session = manager.get(project);
  session.spawn(hub.settingsFor(project.id));
  assert.ok(session.child, 'proses berjalan');
  hub.updateSettings(project.id, { claudeMaxTurns: 5 });
  session.syncSettings();
  assert.equal(session.child, null, 'proses ditutup: flag berlaku pada proses berikutnya');
});
