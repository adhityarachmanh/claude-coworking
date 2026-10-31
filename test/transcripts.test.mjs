// CLI mirror + session history, against fake transcripts in a throwaway ~/.claude/projects.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const ROOT = mkdtempSync(path.join(tmpdir(), 'claude-projects-'));
process.env.CLAUDE_PROJECTS_DIR = ROOT; // must be set before the modules load
const { TranscriptMirror } = await import('../src/mirror.js');
const { listSessions, sessionHistory, transcriptDir } = await import('../src/transcripts.js');

const PROJECT = path.join(tmpdir(), 'shop-app');
const SESSION = '11111111-2222-3333-4444-555555555555';
const dir = transcriptDir(PROJECT);
const file = path.join(dir, `${SESSION}.jsonl`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = { sessionId: SESSION, cwd: PROJECT, entrypoint: 'cli', timestamp: new Date().toISOString() };
const line = (e) => `${JSON.stringify({ ...base, ...e })}\n`;
const typed = (text) => line({ type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { role: 'user', content: text } });
const assistant = (id, content, stop = 'tool_use') => line({ type: 'assistant', message: { id, role: 'assistant', content, stop_reason: stop } });
const toolResult = (id, content) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, toolUseResult: {} });

/** Minimal hub that records what the mirror sends. */
function fakeHub() {
  const calls = { office: [], chatLog: [], status: [], projects: [] };
  return {
    calls,
    upsertProject: (dir) => (calls.projects.push(dir), { id: 'p1' }),
    office: (pid, evt) => calls.office.push(evt),
    chat: (pid, msg) => (calls.chatLog.push(msg), `c${calls.chatLog.length}`),
    updateChat: (pid, id, patch) => Object.assign(calls.chatLog[Number(id.slice(1)) - 1], patch),
    setStatus: (pid, s) => calls.status.push(s),
  };
}

async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(100);
  }
  return false;
}

let hub;
let mirror;
before(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, typed('pesan lama sebelum server start')); // history must not replay
  hub = fakeHub();
  mirror = new TranscriptMirror(hub);
  assert.equal(mirror.start(), true);
});
after(() => {
  mirror.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test('mirror shows a live CLI turn: prompt, tools, subagent, reply, finish', async () => {
  const calls = hub.calls;
  appendFileSync(file, typed('Perbaiki validasi email'));
  appendFileSync(file, assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/auth.ts', old_string: 'a', new_string: 'b' } }]));
  appendFileSync(file, toolResult('t1', 'ok'));
  appendFileSync(file, assistant('m2', [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'qa', description: 'Uji ulang' } }]));
  // the subagent writes its own transcript + meta
  const subDir = path.join(dir, SESSION, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(path.join(subDir, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'qa', toolUseId: 'a1' }));
  appendFileSync(path.join(subDir, 'agent-x1.jsonl'), line({ type: 'assistant', isSidechain: true, message: { id: 's1', content: [{ type: 'tool_use', id: 'q1', name: 'Bash', input: { command: 'ls' } }] } }));
  // a web (sdk-cli) entry in the same folder must be ignored
  appendFileSync(file, line({ type: 'user', entrypoint: 'sdk-cli', promptSource: 'sdk', message: { content: 'dari web' } }));

  assert.ok(await waitFor(() => calls.office.some((e) => e.kind === 'tool_start' && e.tool === 'Bash')), 'subagent tool seen');
  appendFileSync(file, toolResult('a1', 'Semua test lulus'));
  appendFileSync(file, assistant('m3', [{ type: 'text', text: 'Sudah diperbaiki.' }], 'end_turn'));
  appendFileSync(file, line({ type: 'system', subtype: 'turn_duration', durationMs: 4200 }));
  assert.ok(await waitFor(() => calls.chatLog.some((m) => m.kind === 'result')), 'turn finished');

  const users = calls.chatLog.filter((m) => m.kind === 'user').map((m) => m.text);
  assert.deepEqual(users, ['Perbaiki validasi email']); // no replayed history, no web prompt
  assert.ok(calls.chatLog.every((m) => m.source === 'cli'));
  assert.equal(calls.office.find((e) => e.tool === 'Bash').role, 'qa');
  assert.equal(calls.office.find((e) => e.tool === 'Edit').role, 'backend');
  assert.equal(calls.chatLog.find((m) => m.kind === 'delegate').output, 'Semua test lulus');
  assert.equal(calls.chatLog.find((m) => m.kind === 'result').meta.durationMs, 4200);
  assert.ok(calls.status.some((s) => s.cliBusy === true));
  assert.equal(calls.status.at(-1).cliBusy, false);
});

test('session list and history for resuming from the web', () => {
  const sessions = listSessions(PROJECT);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, SESSION);
  assert.equal(sessions[0].source, 'cli');
  assert.equal(sessions[0].title, 'pesan lama sebelum server start');
  const history = sessionHistory(PROJECT, SESSION);
  assert.deepEqual(history.map((m) => m.kind), ['user', 'user', 'user', 'assistant']);
  assert.equal(history.at(-1).text, 'Sudah diperbaiki.');
  assert.deepEqual(sessionHistory(PROJECT, '../../etc/passwd'), []);
});

test('rewind points follow the current chain: an abandoned branch drops out', async () => {
  const { promptChain } = await import('../src/transcripts.js');
  const sid = '99999999-2222-3333-4444-555555555555';
  const e = (type, uuid, parentUuid, content, extra = {}) =>
    JSON.stringify({ type, uuid, parentUuid, sessionId: sid, timestamp: new Date().toISOString(), message: { role: type, content }, ...extra });
  writeFileSync(
    path.join(dir, `${sid}.jsonl`),
    `${[
      e('user', 'u1', null, 'satu'),
      e('assistant', 'a1', 'u1', [{ type: 'text', text: 'ok' }]),
      e('user', 'u2', 'a1', 'dua (nanti di-rewind)'),
      e('assistant', 'a2', 'u2', [{ type: 'text', text: 'ok' }]),
      // resumed at a1 after a rewind; the web app sent `!ls` output ahead of the prompt
      e('user', 'u3', 'a1', '<bash-input>ls</bash-input>\n<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>\n\ntiga, setelah rewind'),
      e('user', 'm1', 'u3', 'catatan sistem', { isMeta: true }),
      e('assistant', 'a3', 'm1', [{ type: 'text', text: 'ok' }]),
    ].join('\n')}\n`,
  );
  const chain = promptChain(PROJECT, sid);
  assert.deepEqual(chain.map((p) => [p.uuid, p.parentUuid, p.text]), [['u1', null, 'satu'], ['u3', 'a1', 'tiga, setelah rewind']]);
  assert.deepEqual(promptChain(PROJECT, sid, { leaf: 'a2' }).map((p) => p.uuid), ['u1', 'u2'], 'from an explicit leaf');
  assert.deepEqual(promptChain(PROJECT, '../x'), []);
});
