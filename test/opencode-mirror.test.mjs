// 🖥 OpenCode sessions from a terminal (src/opencode-mirror.js), with a stubbed `opencode api`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeTool, OpenCodeMirror } from '../src/opencode-mirror.js';

function fakeHub() {
  const ev = { office: [], chat: [], status: [] };
  let n = 0;
  return {
    ev,
    engine: 'opencode',
    persisted: { sessions: {} },
    upsertProject: (dir) => ({ id: `p-${dir.split(/[\/]/).pop()}` }),
    office: (pid, e) => ev.office.push({ pid, ...e }),
    chat: (pid, m) => (ev.chat.push({ pid, ...m }), `c${++n}`),
    updateChat() {},
    setStatus: (pid, s) => ev.status.push({ pid, ...s }),
  };
}

test('OpenCode tools map onto the tools the office knows', () => {
  assert.deepEqual(nativeTool('bash', { command: 'npm test', description: 'Tes' }), { name: 'Bash', input: { command: 'npm test', description: 'Tes' } });
  assert.deepEqual(nativeTool('read', { filePath: 'a.js' }), { name: 'Read', input: { file_path: 'a.js' } });
  assert.equal(nativeTool('edit', { filePath: 'a.css' }).name, 'Edit');
  assert.deepEqual(nativeTool('subagent', { agent: 'qa', description: 'Tes' }).input.subagent_type, 'qa');
  assert.equal(nativeTool('mcp_x', { a: 1 }).name, 'mcp_x');
});

test('a running terminal session is shown (prompt, tools with roles, answer, end); the app\'s own and internal ones are not', async () => {
  const hub = fakeHub();
  const store = {
    active: { ses_term: { type: 'running' }, ses_app: { type: 'running' }, ses_child: { type: 'running' }, ses_data: { type: 'running' } },
    info: { ses_term: { location: { directory: 'C:/p/toko' } }, ses_child: { parentID: 'ses_term', location: { directory: 'C:/p/toko' } }, ses_data: { location: { directory: 'C:/app/data/role-ai' } } },
    msgs: {
      ses_term: [
        { id: 'msg_old', type: 'user', text: 'pertanyaan lama' },
        { id: 'msg_1', type: 'user', text: 'jalankan test' },
        { id: 'msg_2', type: 'assistant', time: { created: 1 }, content: [{ type: 'tool', id: 'tool_1', name: 'bash', state: { status: 'running', input: { command: 'npm test' } }, time: { created: 1 } }] },
      ],
    },
  };
  const calls = [];
  const api = async (bin, op, { params = {} } = {}) => {
    calls.push(op);
    if (op === 'session.active') return store.active;
    if (op === 'session.get') return store.info[params.sessionID] ?? null;
    if (op === 'session.message.list') return [...(store.msgs[params.sessionID] ?? [])].reverse(); // newest first
    throw new Error(op);
  };
  const m = new OpenCodeMirror(hub, { bin: {}, api, ownSessions: () => new Set(['ses_app']), skipDir: (d) => d.split(String.fromCharCode(92)).join('/').toLowerCase().includes('/app/data') });
  await m.tick();
  assert.deepEqual([...m.sessions.keys()], ['ses_term']);
  assert.ok(m.ignored.has('ses_child') && m.ignored.has('ses_data') && !m.ignored.has('ses_app'));
  assert.deepEqual(hub.ev.chat.filter((c) => c.kind === 'user').map((c) => c.text), ['jalankan test'], 'older history not replayed');
  const start = hub.ev.office.find((e) => e.kind === 'tool_start');
  assert.equal(start.role, 'qa');
  assert.equal(start.source, 'cli');
  assert.ok(hub.ev.status.some((s) => s.cliBusy === true && s.cliSession === 'ses_term'));
  // the tool finishes and the answer completes; then the session goes idle
  store.msgs.ses_term[2].content[0].state = { status: 'completed', input: { command: 'npm test' }, content: [{ type: 'text', text: '3 lulus' }] };
  store.msgs.ses_term.push({ id: 'msg_3', type: 'assistant', time: { created: 2, completed: 3 }, content: [{ type: 'text', text: 'Semua test lulus.' }] });
  await m.tick();
  assert.equal(hub.ev.office.filter((e) => e.kind === 'tool_start').length, 1, 'a tool starts once');
  delete store.active.ses_term;
  await m.tick();
  assert.ok(hub.ev.chat.some((c) => c.kind === 'assistant' && /Semua test lulus/.test(c.text ?? '')) || hub.ev.office.some((e) => e.kind === 'say'));
  assert.equal(hub.ev.status.at(-1).cliBusy, false);
  // not while the project runs on Claude Code (Stage 1: the OpenCode mirror skips it)
  hub.engineOf = () => 'claude';
  const before = hub.ev.chat.length;
  await m.tick();
  assert.equal(hub.ev.chat.length, before);
});

test('⏳ provider refusals OpenCode retries read as a usage limit (429) or a provider problem', async () => {
  const { retryNote } = await import('../src/opencode-mirror.js');
  assert.match(retryNote({ attempt: 2, at: 1, error: { type: 'APIError', message: 'Too Many Requests', status: 429 } }), /Batas pemakaian provider tercapai \(HTTP 429\): Too Many Requests\. OpenCode mencoba lagi otomatis \(percobaan 2\)/);
  assert.match(retryNote({ attempt: 1, at: 1, error: { type: 'rate_limit', message: 'slow down' } }), /Batas pemakaian/);
  assert.match(retryNote({ attempt: 1, at: 1, error: { type: 'APIError', message: 'Bad gateway', status: 502 } }), /Provider sedang bermasalah \(HTTP 502\)/);
  assert.equal(retryNote(undefined), null);
});

test('a terminal session in a home folder or a drive root is never shown as a project', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const hub = fakeHub();
  const dirs = { ses_home: os.homedir(), ses_root: path.parse(process.cwd()).root };
  const api = async (bin, op, { params = {} } = {}) => {
    if (op === 'session.active') return { ses_home: { type: 'running' }, ses_root: { type: 'running' } };
    if (op === 'session.get') return { location: { directory: dirs[params.sessionID] } };
    return [];
  };
  const m = new OpenCodeMirror(hub, { bin: {}, api, ownSessions: () => new Set() });
  await m.tick();
  assert.equal(m.sessions.size, 0);
  assert.ok(m.ignored.has('ses_home') && m.ignored.has('ses_root'));
});
