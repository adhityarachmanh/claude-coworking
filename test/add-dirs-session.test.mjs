// Folder tambahan → Claude's --add-dir: the stored list reaches spawn, a change restarts an idle process, and a
// hand-edited state.json can never put junk into the arguments.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hub } from '../src/hub.js';
import { SessionManager } from '../src/session.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits (bounded) for the fake CLI to write its record, then returns it. */
async function waitRecord(file, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        // still being written
      }
    }
    await sleep(25);
  }
  throw new Error(`fake CLI tidak menulis record dalam ${deadlineMs} ms`);
}

/** A fake claude CLI: records its cwd + argv to a file, then exits without a turn. */
function fakeClaude(recordFile) {
  const script = path.join(path.dirname(recordFile), 'fake-claude.cjs');
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\n`);
  return { command: process.execPath, args: [script] };
}

function freshHubAndProject(prefix) {
  const hub = new Hub({ dataDir: mkdtempSync(path.join(tmpdir(), `${prefix}-data-`)) });
  const dir = mkdtempSync(path.join(tmpdir(), `${prefix}-proj-`));
  const project = hub.upsertProject(dir, 'custom');
  return { hub, dir, project };
}

const managerFor = (hub, dir) =>
  new SessionManager({ hub, claude: fakeClaude(path.join(dir, 'spawn.json')), opencode: null, agents: {}, teamPrompt: '', ledger: null, account: null });

test('spawn meneruskan --add-dir untuk setiap folder tambahan', async () => {
  const { hub, dir, project } = freshHubAndProject('ad');
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  mkdirSync(a);
  mkdirSync(b);
  hub.updateSettings(project.id, { additionalDirectories: [a, b] });
  const manager = managerFor(hub, dir);
  const session = manager.get(project);
  session.spawn(hub.settingsFor(project.id));
  const argv = (await waitRecord(path.join(dir, 'spawn.json'))).argv;
  const at = argv.indexOf('--add-dir');
  assert.ok(at >= 0, 'argumen --add-dir ada');
  assert.deepEqual(argv.slice(at + 1, at + 3), [a, b]);
  session.closeChild();
});

test('daftar folder baru menutup proses idle supaya pesan berikutnya memakai daftar itu', () => {
  const { hub, dir, project } = freshHubAndProject('ar');
  const a = path.join(dir, 'a');
  mkdirSync(a);
  const session = managerFor(hub, dir).get(project);
  session.spawn(hub.settingsFor(project.id));
  assert.ok(session.child, 'proses berjalan setelah spawn');
  hub.updateSettings(project.id, { additionalDirectories: [a] });
  session.syncSettings();
  assert.equal(session.child, null, 'proses ditutup: spawn berikutnya membawa --add-dir');
});

test('daftar folder baru tidak memotong tugas latar: proses ditutup setelah tugas selesai', () => {
  const { hub, dir, project } = freshHubAndProject('ab');
  const a = path.join(dir, 'a');
  mkdirSync(a);
  const session = managerFor(hub, dir).get(project);
  session.spawn(hub.settingsFor(project.id));
  assert.ok(session.child, 'proses berjalan setelah spawn');
  // A background shell/agent still runs inside that idle process: adding a folder must not end it.
  session.translator.hasRunningTasks = () => true;
  hub.updateSettings(project.id, { additionalDirectories: [a] });
  session.syncSettings();
  assert.ok(session.child, 'proses tetap hidup selama tugas latar berjalan');
  // Once the tasks finish, the idle shutdown closes it; the next process reads the new list.
  session.translator.hasRunningTasks = () => false;
  session.idleShutdown();
  assert.equal(session.child, null, 'proses ditutup setelah tugas latar selesai');
});

test('settingsFor membersihkan additionalDirectories dari state.json yang diedit tangan', () => {
  const { hub, dir, project } = freshHubAndProject('aj');
  hub.updateSettings(project.id, {}); // pastikan entri settings ada
  hub.persisted.settings[project.id].additionalDirectories = 'bukan array';
  assert.deepEqual(hub.settingsFor(project.id).additionalDirectories, []);
  hub.persisted.settings[project.id].additionalDirectories = [null, 'relatif'];
  assert.deepEqual(hub.settingsFor(project.id).additionalDirectories, []);
  hub.persisted.settings[project.id].additionalDirectories = [dir];
  assert.deepEqual(hub.settingsFor(project.id).additionalDirectories, [dir]);
});
