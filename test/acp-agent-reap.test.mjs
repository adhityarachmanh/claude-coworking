// Regression for the refina-smi bug: a delegation whose final frame never came kept its ⧗ task "running" for days.
// Because `hasRunningTasks()` counted it, the reconciler left the project alone and every model/mode change waited
// forever (the session kept its old Plan agent). The session class is exercised on its own prototype: no process, no
// server, no real OpenCode — only the two rules under test (the age cap and the restart deadline).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpAdapter, acpSessionClass } from '../src/acp-session.js';
import { StreamTranslator } from '../src/translator.js';

const Acp = acpSessionClass(class ClaudeSession {}, { previewInput: null });
const AGENT_MAX_MS = 30 * 60_000;

/** A translator with one ACP delegation task (source "acp", kind "agent") that started `ageMs` ago. */
function translatorWithAgent(ageMs, id = 'oc-agent-call-1') {
  const translator = new StreamTranslator({ office() {}, chat() {}, updateChat() {}, status() {} }, { projectPath: process.cwd() });
  translator.bgTasks.set(id, { id, status: 'running', kind: 'agent', source: 'acp', toolUseId: 'call-1', description: 'Fix wave', startedAt: Date.now() - ageMs });
  return translator;
}

/** The session fields reapAgentTasks/applyPendingRestart touch, without a constructor (no manager, no process). */
function fakeSession({ translator, restartPending = false, restartPendingAt = 0, busy = false }) {
  const seen = { chats: [], closed: 0 };
  const session = Object.assign(Object.create(Acp.prototype), {
    translator,
    // No adapter record: exactly the state of a task whose bounded `agents` entry was already dropped.
    adapter: new AcpAdapter(() => {}),
    agentReaping: false,
    lastAgentReapAt: 0,
    restartPending,
    restartPendingAt,
    busy,
    hub: { chat: (projectId, message) => seen.chats.push({ projectId, ...message }) },
    closeChild() {
      seen.closed++;
    },
  });
  return { session, seen };
}

test('a delegation past its age cap is closed even when its adapter record is gone (hasRunningTasks turns false)', async () => {
  const translator = translatorWithAgent(AGENT_MAX_MS + 60_000);
  const { session } = fakeSession({ translator });
  assert.equal(translator.hasRunningTasks(), true, 'masih dihitung bekerja sebelum reaper');
  await session.reapAgentTasks();
  assert.equal(translator.bgTasks.get('oc-agent-call-1').status, 'completed', 'task basi ditutup, bukan berputar selamanya');
  assert.equal(translator.hasRunningTasks(), false, 'tidak ada kerja nyata yang tersisa');
});

test('a delegation younger than the cap is left alone (real work is never cut)', async () => {
  const translator = translatorWithAgent(5 * 60_000);
  const { session } = fakeSession({ translator });
  await session.reapAgentTasks();
  assert.equal(translator.bgTasks.get('oc-agent-call-1').status, 'running', 'umur di bawah batas: jangan disentuh');
  assert.equal(translator.hasRunningTasks(), true);
});

test('a restart held past its deadline is applied with one honest line in the chat', () => {
  const translator = translatorWithAgent(5 * 60_000); // still "running": a ghost task that never reports
  const { session, seen } = fakeSession({ translator, restartPending: true, restartPendingAt: Date.now() - 11 * 60_000 });
  session.applyPendingRestart();
  assert.equal(session.restartPending, false, 'restart akhirnya diterapkan');
  assert.equal(seen.closed, 1, 'proses lama ditutup supaya model/mode baru berlaku');
  assert.equal(seen.chats.length, 1, 'satu baris info, bukan diam-diam');
  assert.match(seen.chats[0].text, /terlalu lama tidak melapor/);
});

test('a restart that is still inside the deadline keeps waiting; without running work it applies at once', () => {
  const held = fakeSession({ translator: translatorWithAgent(5 * 60_000), restartPending: true, restartPendingAt: Date.now() - 60_000 });
  held.session.applyPendingRestart();
  assert.equal(held.session.restartPending, true, 'tugas latar masih diberi waktu');
  assert.equal(held.seen.closed, 0);
  assert.deepEqual(held.seen.chats, []);

  const idle = translatorWithAgent(5 * 60_000);
  idle.bgTasks.get('oc-agent-call-1').status = 'completed';
  const free = fakeSession({ translator: idle, restartPending: true, restartPendingAt: Date.now() - 60_000 });
  free.session.applyPendingRestart();
  assert.equal(free.session.restartPending, false);
  assert.equal(free.seen.closed, 1);
  assert.deepEqual(free.seen.chats, [], 'tidak ada tugas latar: tidak perlu baris peringatan');
});

test('a running turn keeps its restart: the deadline never cuts a turn', () => {
  const { session, seen } = fakeSession({ translator: translatorWithAgent(5 * 60_000), restartPending: true, restartPendingAt: Date.now() - 60 * 60_000, busy: true });
  session.applyPendingRestart();
  assert.equal(session.restartPending, true);
  assert.equal(seen.closed, 0);
});
