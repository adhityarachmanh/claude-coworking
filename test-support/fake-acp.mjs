#!/usr/bin/env node
// A fake `opencode acp` for tests (OPENCODE_BIN): speaks the Agent Client Protocol (JSON-RPC, one JSON per line)
// with the shapes the real OpenCode 2.x sends (see docs/design-opencode.md). Scenarios by prompt text:
//   "izin" — runs a shell command; asks first when the permission config says "ask" (allow → done, reject → cancelled)
//   "lama" — streams, then waits until session/cancel                       anything else — text, a read, a plan
//   "tulis" — writes a file; asks first when permission.edit is "ask" (the edit permission's shape, kind "edit")
//   "macet" — a shell command that never ends (`tail -f`), no output, until session/cancel (the stuck detector)
//   "tanya" — the `question` tool: elicitation/create (form) like OpenCode 2.2.5 when the client offered
//             elicitation.form at initialize, else the "couldn't be shown" fallback; says what came back
//   "rencana" in the plan agent — a plan as the last answer; "disetujui" — says which agent works on it
// It honours OPENCODE_CONFIG_CONTENT like the real one (permission.bash / permission.edit: ask | allow | deny).
// ⏪ Rewind switch files (on while the file exists, so a running server's fake can be steered): FAKE_ACP_COMMIT_FAIL
// (every commit fails, tries counted in <file>.log), FAKE_ACP_STAGE_FAIL (staged, then the answer is lost),
// FAKE_ACP_REVERT_SLOW (the stage takes <file content> ms). FAKE_ACP_CLEAR_LOG=<file>: each session.revert.clear.
// Contract check (src/opencode-contract.js): FAKE_ACP_VERSION = what --version / agentInfo claim; FAKE_ACP_BREAK =
// comma list of parts to break: version-hang, initialize (never answers), acp-exit, load-session, session-new,
// mode, commands, load, models, session-list. FAKE_ACP_RPC_LOG=<file>: every incoming request's method, one per line.
const BREAK = new Set((process.env.FAKE_ACP_BREAK ?? '').split(',').filter(Boolean));
// FAKE_ACP_VERSION_FILE: the version read from a file at every start (an "update" while the server runs).
const versionFromFile = () => {
  try {
    return process.env.FAKE_ACP_VERSION_FILE ? readFileSync(process.env.FAKE_ACP_VERSION_FILE, 'utf8').trim() : '';
  } catch {
    return '';
  }
};
const FAKE_VERSION = versionFromFile() || process.env.FAKE_ACP_VERSION || '2.0.0-fake';
// FAKE_ACP_STORE=<dir>: the sessions' messages as OpenCode 2.x projects them (session.message.list), one JSON per
// session { dir, messages }, written by the acp processes and read/cut by `api session.revert.*` (⏪ Rewind).
// An assistant message keeps `before` (file -> content before the turn, null = absent): its "snapshot".
const STORE = process.env.FAKE_ACP_STORE;
const storePath = (sid) => `${STORE}/${String(sid).replace(/[^\w-]/g, '')}.json`;
function loadStore(sid) {
  try {
    return STORE ? JSON.parse(readFileSync(storePath(sid), 'utf8')) : null;
  } catch {
    return null;
  }
}
function saveStore(sid, s) {
  if (STORE) writeFileSync(storePath(sid), JSON.stringify(s));
}
// FAKE_ACP_CLI_LOG=<file>: every non-acp invocation as "<args>	<cwd>" (where the CLI runs were started).
if (process.env.FAKE_ACP_CLI_LOG && process.argv[2] !== 'acp') appendFileSync(process.env.FAKE_ACP_CLI_LOG, `${process.argv.slice(2).join(' ')}\t${process.cwd()}\n`);
if (process.argv[2] === 'models') {
  if (BREAK.has('models')) process.exit(1);
  console.log('opencode-go/beam-free\nopencode-go/kimi-k3\ngoogle/gemini-2.5-flash');
  process.exit(0);
}
// `opencode api <operation> [--param k=v] [--data json]`: provider logins (src/opencode-auth.js). State in
// FAKE_ACP_AUTH_FILE, so a login shows up in the next list; secrets are only checked, never echoed back.
if (process.argv[2] === 'api') {
  const { existsSync: has, readFileSync, writeFileSync: write } = await import('node:fs');
  const [, , , op, ...rest] = process.argv;
  const params = {};
  let body = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === '--param') {
      const [k, ...v] = rest[i + 1].split('=');
      params[k] = v.join('=');
    } else if (rest[i] === '--data') body = JSON.parse(rest[i + 1]);
  }
  const file = process.env.FAKE_ACP_AUTH_FILE;
  const creds = file && has(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const save = () => file && write(file, JSON.stringify(creds));
  const out = (data) => (console.log(JSON.stringify({ location: { directory: process.cwd() }, data })), process.exit(0));
  // switch files (a test turns them on and off while the server runs): FAKE_ACP_<X>=<file>, on while the file exists
  const flag = (name) => (process.env[name] && has(process.env[name]) ? readFileSync(process.env[name], 'utf8').trim() || '1' : '');
  const sessionNotFound = (id) => (console.log(JSON.stringify({ _tag: 'SessionNotFoundError', sessionID: id, message: `Session not found: ${id}` })), console.error('HTTP 404 Not Found'), process.exit(1));
  const fail = (msg) => (console.error(`UnknownError: An error occurred\n    at x (B:/~BUN/root/c.js:1:1) {\n  [cause]: Error: ${msg}\n}`), process.exit(1));
  const integrations = [
    { id: 'opencode-go', name: 'OpenCode Go', methods: [{ type: 'key' }, { type: 'env', names: ['OPENCODE_API_KEY'] }] },
    { id: 'github-copilot', name: 'GitHub Copilot', methods: [{ type: 'env', names: ['GITHUB_TOKEN'] }, { id: 'device', type: 'oauth', label: 'Login with GitHub Copilot', form: [{ key: 'deploymentType', title: 'Type', required: true, type: 'string', options: [{ value: 'github.com', label: 'GitHub.com' }] }] }] },
    { id: 'google', name: 'Google', methods: [{ type: 'key' }, { type: 'env', names: ['GEMINI_API_KEY'] }] },
  ];
  switch (op) {
    case 'integration.list':
      out(integrations.map((i) => ({ ...i, connections: [...creds.filter((c) => c.integrationID === i.id).map(({ id, label, method }) => ({ type: 'credential', id, label, method })), ...(i.id === 'google' ? [{ type: 'env', name: 'GEMINI_API_KEY' }] : [])] })));
      break;
    case 'integration.connect.key':
      if (!integrations.some((i) => i.id === params.integrationID)) fail(`Integration not found: ${params.integrationID}`);
      if (body.key !== 'sk-benar') fail('Authentication failed');
      creds.push({ id: `cred_${creds.length + 1}`, integrationID: params.integrationID, label: 'Default', method: 'key' });
      save();
      out(null);
      break;
    // /mcp (src/opencode-mcp.js): live servers; connect / disconnect are recorded in FAKE_ACP_MCP_LOG
    case 'mcp.list':
      out([
        { name: 'docs', status: { status: 'connected' } },
        { name: 'notion', status: { status: 'needs_auth', error: 'Unauthorized' }, integrationID: 'mcp-notion' },
        { name: 'broken', status: { status: 'failed', error: 'spawn ENOENT' } },
      ]);
      break;
    case 'experimental.mcp.connect':
    case 'experimental.mcp.disconnect':
      if (process.env.FAKE_ACP_MCP_LOG) appendFileSync(process.env.FAKE_ACP_MCP_LOG, `${op.split('.').pop()} ${params.server} ${params['location[directory]'] ?? ''}\n`);
      out(null);
      break;
    case 'integration.get':
      out({ id: params.integrationID, methods: params.integrationID === 'mcp-notion' ? [{ id: 'oauth', type: 'oauth', label: 'Login' }] : [] });
      break;
    case 'integration.oauth.complete':
      if (process.env.FAKE_ACP_MCP_LOG) appendFileSync(process.env.FAKE_ACP_MCP_LOG, `complete ${params.integrationID} ${body.code}\n`);
      out(null);
      break;
    case 'integration.oauth.connect':
      out({ attemptID: 'con_fake1', url: 'https://example.test/login', instructions: 'Masukkan kode ABCD-1234', mode: 'auto', time: { created: 0, expires: 1 } });
      break;
    case 'integration.oauth.status':
      creds.push({ id: `cred_${creds.length + 1}`, integrationID: params.integrationID, label: 'Default', method: 'oauth' });
      save();
      out({ status: 'complete', time: { created: 0, expires: 1 } });
      break;
    case 'session.remove':
      if (!/^ses_/.test(params.sessionID)) fail('Session not found');
      write(`${file}.removed`, params.sessionID);
      out(null);
      break;
    case 'session.fork':
      out({ id: `ses_fork_${params.sessionID.slice(4)}`, title: 'Fork' });
      break;
    case 'session.update':
      write(`${file}.title`, `${params.sessionID}=${body.title}`);
      out({ id: params.sessionID, title: body.title });
      break;
    // ⏪ Rewind (FAKE_ACP_STORE): the messages the acp processes recorded, OpenCode 2.x's shapes and paging
    case 'session.message.list': {
      const s = loadStore(params.sessionID);
      if (!s) sessionNotFound(params.sessionID);
      let list = s.messages.filter((m) => !params.type || m.type === params.type);
      let start = 0;
      let order = params.order ?? 'desc';
      if (params.cursor) ({ start, order } = JSON.parse(Buffer.from(params.cursor, 'base64url').toString()));
      if (order === 'desc') list = list.reverse();
      const limit = Number(params.limit) || 50;
      const page = list.slice(start, start + limit);
      const next = Buffer.from(JSON.stringify({ start: start + limit, order })).toString('base64url');
      console.log(JSON.stringify({ data: page.map(({ before, ...m }) => m), cursor: { previous: null, next } }));
      process.exit(0);
      break;
    }
    case 'session.revert.stage': {
      const s = loadStore(params.sessionID);
      const at = s ? s.messages.findIndex((m) => m.id === body.messageID) : -1;
      if (at < 0) (console.log(JSON.stringify({ _tag: 'MessageNotFoundError', message: `Message not found: ${body.messageID}` })), console.error('HTTP 404 Not Found'), process.exit(1));
      if (process.env.FAKE_ACP_REVERT_BUSY) (console.log(JSON.stringify({ _tag: 'BusyError' })), console.error('HTTP 409 Conflict'), process.exit(1));
      if (flag('FAKE_ACP_REVERT_SLOW')) await new Promise((r) => setTimeout(r, Number(flag('FAKE_ACP_REVERT_SLOW')) || 1000)); // file content = ms
      const undo = {}; // what clear puts back: the files as they are now
      const restore = new Map(); // file -> content before the earliest later turn (null = did not exist)
      if (body.files !== false) for (const m of s.messages.slice(at + 1)) for (const [f, c] of Object.entries(m.before ?? {})) if (!restore.has(f)) restore.set(f, c);
      for (const [f, c] of restore) {
        const abs = `${s.dir}/${f}`;
        undo[f] = has(abs) ? readFileSync(abs, 'utf8') : null;
        if (c === null) (await import('node:fs')).rmSync(abs, { force: true });
        else write(abs, c);
      }
      s.revert = { messageID: body.messageID, undo };
      saveStore(params.sessionID, s);
      // FAKE_ACP_STAGE_FAIL: staged, then the call fails anyway (a lost answer / timeout): the app must clear it
      if (flag('FAKE_ACP_STAGE_FAIL')) (console.error('UnknownError: stage answer lost'), process.exit(1));
      out({ messageID: body.messageID, snapshot: 'snap0', files: [...restore.keys()].map((file) => ({ file, patch: '', additions: 1, deletions: 1, status: 'modified' })) });
      break;
    }
    case 'session.revert.commit': {
      const s = loadStore(params.sessionID);
      if (!s) sessionNotFound(params.sessionID);
      // FAKE_ACP_COMMIT_FAIL (switch file): every commit fails, each try counted in <file>.log
      if (flag('FAKE_ACP_COMMIT_FAIL')) (appendFileSync(`${process.env.FAKE_ACP_COMMIT_FAIL}.log`, 'commit\n'), console.error('UnknownError: database is locked'), process.exit(1));
      if (s.revert) s.messages = s.messages.slice(0, s.messages.findIndex((m) => m.id === s.revert.messageID));
      delete s.revert;
      saveStore(params.sessionID, s);
      out(null);
      break;
    }
    case 'session.revert.clear': {
      const s = loadStore(params.sessionID);
      if (!s) sessionNotFound(params.sessionID);
      for (const [f, c] of Object.entries(s.revert?.undo ?? {})) {
        const abs = `${s.dir}/${f}`;
        if (c === null) (await import('node:fs')).rmSync(abs, { force: true });
        else write(abs, c);
      }
      delete s.revert;
      saveStore(params.sessionID, s);
      if (process.env.FAKE_ACP_CLEAR_LOG) appendFileSync(process.env.FAKE_ACP_CLEAR_LOG, `${params.sessionID}\n`);
      out(null);
      break;
    }
    case 'credential.remove': {
      const i = creds.findIndex((c) => c.id === params.credentialID);
      if (i < 0) fail('Credential not found');
      creds.splice(i, 1);
      save();
      out(null);
      break;
    }
    default:
      fail(`Operation not found: ${op}`);
  }
}
// 🔁 handoff "Pintar": opencode run --session <id> --fork --agent plan <prompt>
if (process.argv[2] === 'run') {
  const a = process.argv.slice(3);
  if (!a.includes('--fork') || a[a.indexOf('--agent') + 1] !== 'plan') process.exit(9);
  console.log(`## Tujuan\nHandoff palsu dari OpenCode (sesi ${a[a.indexOf('--session') + 1]})`);
  process.exit(0);
}
if (process.argv[2] === 'mcp' && process.argv[3] === 'add') {
  const { appendFileSync } = await import('node:fs');
  if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, `${JSON.stringify(['opencode', ...process.argv.slice(4)])}\n`);
  console.log('MCP server added');
  process.exit(0);
}
if (process.argv[2] === 'session' && process.argv[3] === 'export') {
  console.log(JSON.stringify({ info: { id: process.argv[4], title: 'Sesi lama OpenCode' }, messages: [{ role: 'user', text: 'halo' }] }));
  process.exit(0);
}
if (process.argv[2] === 'session' && process.argv[3] === 'list') {
  if (BREAK.has('session-list')) (console.log('Error: database locked'), process.exit(0));
  console.log(JSON.stringify([{ id: 'ses_fakeold', title: 'Sesi lama OpenCode', updated: 1700000000000, created: 1700000000000, directory: process.cwd() }]));
  process.exit(0);
}
if (process.argv[2] !== 'acp') {
  if (BREAK.has('version-hang')) {
    setInterval(() => {}, 60_000);
    await new Promise(() => {}); // never answers (killed by the caller's timeout)
  } else {
    console.log(`opencode v${FAKE_VERSION}`);
    process.exit(0);
  }
}

// FAKE_ACP_FAIL_ONCE=<file>: the very first `acp` process dies at initialize (a cold start), later ones work.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const failOnce = process.env.FAKE_ACP_FAIL_ONCE;
const coldStart = Boolean(failOnce) && !existsSync(failOnce);
if (coldStart) writeFileSync(failOnce, 'started');

const config = (() => {
  try {
    return JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');
  } catch {
    return {};
  }
})();
const bash = config.permission?.bash ?? 'allow';
const edit = config.permission?.edit ?? 'allow';
// Mode tim: OPENCODE_CONFIG points at the app's team file (agents + the Lead's instructions), like the real one.
const team = (() => {
  try {
    return process.env.OPENCODE_CONFIG ? JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8')) : null;
  } catch {
    return null;
  }
})();
const sessions = new Set(['ses_fakeold']);
let options = { model: 'opencode-go/beam-free', mode: 'build', effort: 'default' };
let cost = 0;
let seq = 0;
let cancelTurn = null;
let formElicitation = false; // initialize: clientCapabilities.elicitation.form
const waiting = new Map(); // our request id -> resolve

const send = (obj) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: options.model, options: [{ value: 'opencode-go/beam-free', name: 'beam free' }, { value: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }] },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: options.mode, options: [{ value: 'build', name: 'build' }, { value: 'plan', name: 'plan' }, { value: 'docs', name: 'docs', description: 'Penulis dokumentasi' }] },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: options.effort, options: ['low', 'high', 'max', 'default'].map((value) => ({ value, name: value })) },
];
const ask = (params) =>
  new Promise((resolve) => {
    const id = `perm-${++seq}`;
    waiting.set(id, resolve);
    send({ id, method: 'session/request_permission', params });
  });

// OpenCode 2.2.5's question tool as a form (src: the ACP agent's FormAsk → elicitation/create)
const elicit = (params) =>
  new Promise((resolve) => {
    const id = `elicit-${++seq}`;
    waiting.set(id, resolve);
    send({ id, method: 'elicitation/create', params });
  });
const QUESTIONS = [
  { header: 'Database', question: 'Pakai database apa?', options: [{ label: 'PostgreSQL', description: 'Relasional' }, { label: 'SQLite', description: 'File lokal' }], multiple: false },
  { header: 'Fitur', question: 'Fitur mana saja?', options: [{ label: 'Login', description: '' }, { label: 'Ekspor, PDF', description: 'Label dengan koma' }], multiple: true },
];
const questionSchema = () => {
  const properties = {};
  QUESTIONS.forEach((q, i) => {
    const choices = q.options.map((o) => ({ const: o.label, title: o.label, description: o.description }));
    properties[`q${i}`] = q.multiple ? { type: 'array', title: q.header, description: q.question, items: { anyOf: choices } } : { type: 'string', title: q.header, description: q.question, oneOf: choices };
    properties[`q${i}_custom`] = { type: 'string', title: `${q.header} (other)`, description: q.multiple ? 'Add your own answer' : 'Type your own answer' };
  });
  return { type: 'object', properties, required: [] };
};

let links = [];
async function turn(sessionId, text) {
  const say = async (msgId, ...parts) => {
    for (const p of parts) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: msgId, content: { type: 'text', text: p } });
      await sleep(20);
    }
  };
  // ✕ Tolak's follow-up (src/acp-session.js rejectedPrompt): carries on without the refused step
  if (/Saya menolak izin untuk/.test(text)) {
    await say('msg_rejected', 'Baik, saya lanjutkan tanpa langkah itu.');
    return { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 } };
  }
  if (/link\?/.test(text)) {
    await say('msg_link', `links=${links.join(',')}`);
    return { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
  }
  if (/agent\?/.test(text)) {
    await say('msg_agent', `agent=${options.mode} bash=${JSON.stringify(config.permission?.bash ?? null)}`);
    return { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
  }
  if (/tanya/.test(text)) {
    const call = 'call-question-1';
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: call, title: 'question', kind: 'other', status: 'pending', locations: [], rawInput: {} });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, title: 'question', kind: 'other', status: 'in_progress', rawInput: { questions: QUESTIONS } });
    if (!formElicitation) {
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: "The question couldn't be shown to the user in this client." } }] });
      await say('msg_noask', 'pertanyaan tidak bisa ditampilkan');
      return { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
    }
    const res = await elicit({ mode: 'form', sessionId, toolCallId: call, message: 'Questions', requestedSchema: questionSchema() });
    if (res?.action !== 'accept') {
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'The user dismissed this question' } }] });
      await say('msg_skip', `tanpa jawaban (${res?.action})`);
      return { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
    }
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'User has answered your questions' } }] });
    await say('msg_answers', `jawaban=${JSON.stringify(res.content ?? {})}`);
    return { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
  }
  if (/disetujui/.test(text)) {
    await say('msg_build', `Mengerjakan rencana (agent=${options.mode})`);
    return { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
  }
  if (/rencana|revisi/i.test(text) && options.mode === 'plan') {
    await say('msg_intro', 'Saya baca dulu.');
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-plan-read', title: 'read', kind: 'read', status: 'pending', locations: [], rawInput: {} });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-plan-read', status: 'in_progress', kind: 'read', title: 'read', rawInput: { path: 'README.md' } });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-plan-read', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '1: # Toko' } }] });
    await say('msg_plan', `## Rencana${/revisi/i.test(text) ? ' (revisi)' : ''}

1. Ubah judul README
2. Tambah bagian Instalasi`);
    return { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
  }
  if (/effort/.test(text)) {
    await say('msg_effort', `effort=${options.effort}`);
    return { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
  }
  if (/tim/.test(text)) {
    // OpenCode 2.x: the Lead calls `subagent`; the subagent's tools come titled "<description>: <tool>"
    const agents = Object.keys(team?.agents ?? {});
    if (!agents.includes('backend') || !team.instructions?.length) {
      await say('msg_noteam', 'tanpa tim');
      return { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
    }
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-sub-1', title: 'subagent', kind: 'think', status: 'pending', rawInput: {} });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-sub-1', title: 'subagent', kind: 'think', status: 'in_progress', rawInput: { agent: 'backend', description: 'Cek API login', prompt: 'periksa' } });
    await sleep(20);
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-sub-read', title: 'Cek API login: read', kind: 'read', status: 'pending', rawInput: {} });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-sub-read', title: 'Cek API login: read', kind: 'read', status: 'in_progress', rawInput: { path: 'README.md' } });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-sub-read', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '1: # Toko' } }] });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-sub-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'API aman' } }] });
    await say('msg_team', 'Tim selesai.');
    return { stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36 } };
  }
  if (/macet/.test(text)) {
    const call = 'call-hang-1';
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: call, title: 'bash', kind: 'execute', status: 'pending', locations: [], rawInput: {} });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'in_progress', kind: 'execute', title: 'tail -f app.log', rawInput: { command: 'tail -f app.log', description: 'Menunggu log' } });
    await new Promise((r) => (cancelTurn = r));
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Tool execution aborted' } }] });
    return { stopReason: 'cancelled', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
  }
  if (/tulis/.test(text)) {
    const call = 'call-write-1';
    const rawInput = { filePath: 'catatan.md', content: 'isi catatan' };
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: call, title: 'write', kind: 'edit', status: 'pending', locations: [], rawInput: {} });
    if (edit === 'ask') {
      // OpenCode's edit permission: kind from the permission type, the file in locations/metadata
      const res = await ask({
        sessionId,
        toolCall: { toolCallId: call, title: 'write', kind: 'edit', status: 'pending', locations: [{ path: 'catatan.md' }], rawInput },
        options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }],
      });
      if (!(res?.outcome?.outcome === 'selected' && res.outcome.optionId !== 'reject')) {
        update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'The user declined this tool call' } }] });
        return { stopReason: 'cancelled', usage: { inputTokens: 40, outputTokens: 4, totalTokens: 44 } };
      }
    }
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'in_progress', kind: 'edit', title: 'write', rawInput });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Wrote file successfully.' } }] });
    await say('msg_write', 'Catatan ditulis.');
    return { stopReason: 'end_turn', usage: { inputTokens: 60, outputTokens: 8, totalTokens: 68 } };
  }
  if (/lama/.test(text)) {
    await say('msg_long', 'Sedang ', 'bekerja lama…');
    await new Promise((r) => (cancelTurn = r));
    return { stopReason: 'cancelled', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
  }
  if (/izin/.test(text)) {
    const call = 'call-shell-1';
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: call, title: 'shell', kind: 'execute', status: 'pending', locations: [], rawInput: {} });
    if (bash === 'deny') {
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Denied by permission rule' } }] });
    } else {
      let allowed = true;
      if (bash === 'ask') {
        const res = await ask({
          sessionId,
          toolCall: { toolCallId: call, title: 'echo halo', kind: 'execute', status: 'pending', locations: [{ path: process.cwd() }], rawInput: { command: 'echo halo', cwd: process.cwd() } },
          options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }],
        });
        allowed = res?.outcome?.outcome === 'selected' && res.outcome.optionId !== 'reject';
      }
      if (!allowed) {
        update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'The user declined this tool call' } }] });
        return { stopReason: 'cancelled', usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 } };
      }
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'in_progress', kind: 'execute', title: 'echo halo', rawInput: { command: 'echo halo', cwd: process.cwd() } });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'halo\n' } }], rawOutput: { metadata: { exit: 0 } } });
    }
    await say('msg_after', 'Perintah selesai.');
    return { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 10, totalTokens: 90 } };
  }
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', messageId: 'msg_think', content: { type: 'text', text: 'berpikir' } });
  await say('msg_1', 'Halo dari ', 'OpenCode palsu.');
  update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'Baca README', priority: 'high', status: 'completed' }, { content: 'Jawab', priority: 'medium', status: 'in_progress' }] });
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-read-1', title: 'read', kind: 'read', status: 'pending', locations: [], rawInput: {} });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-read-1', status: 'in_progress', kind: 'read', title: 'read', locations: [{ path: 'README.md' }], rawInput: { path: 'README.md' } });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-read-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '1: # Toko' } }] });
  await say('msg_2', 'Selesai membaca.');
  cost += 0.0025;
  update(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: cost, currency: 'USD' } });
  return { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 220, thoughtTokens: 5, cachedReadTokens: 95 } };
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

async function handle(msg) {
  if (msg.id != null && !msg.method) {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  const { id, method, params = {} } = msg;
  const reply = (result) => send({ id, result });
  if (process.env.FAKE_ACP_RPC_LOG) appendFileSync(process.env.FAKE_ACP_RPC_LOG, `${method}
`); // which requests came in
  switch (method) {
    case 'initialize':
      if (coldStart) process.exit(3);
      if (BREAK.has('acp-exit')) process.exit(4);
      if (BREAK.has('initialize')) return; // never answers
      formElicitation = params.clientCapabilities?.elicitation?.form != null;
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: !BREAK.has('load-session'), promptCapabilities: { image: true, embeddedContext: true } }, authMethods: [], agentInfo: { name: 'OpenCode', version: FAKE_VERSION } });
    case 'session/new': {
      if (BREAK.has('session-new')) return send({ id, error: { code: -32603, message: 'Internal error' } });
      // with a store, unique across processes (a later process must not pick up an older session's messages)
      const sessionId = STORE ? `ses_fake${Date.now().toString(36)}${process.pid.toString(36)}${++seq}` : `ses_fake${++seq}`;
      sessions.add(sessionId);
      if (!BREAK.has('commands')) update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init', description: 'AGENTS.md' }, { name: 'rilis', description: 'Command buatan sendiri', input: { hint: '<versi>' } }] });
      return reply({ sessionId, configOptions: BREAK.has('mode') ? configOptions().filter((o) => o.id !== 'mode') : configOptions() });
    }
    case 'session/load':
      if (BREAK.has('load')) return send({ id, error: { code: -32603, message: 'Internal error' } });
      if (!sessions.has(params.sessionId) && !params.sessionId.startsWith('ses_fork_') && !loadStore(params.sessionId)) return send({ id, error: { code: -32002, message: 'Session not found' } });
      // The real agent replays the old conversation: the office must not show it again.
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'msg_old', content: { type: 'text', text: 'jawaban lama' } });
      return reply({ configOptions: configOptions() });
    case 'session/set_config_option':
      options = { ...options, [params.configId]: params.value };
      return reply({ configOptions: configOptions() });
    case 'session/prompt': {
      const text = (params.prompt ?? []).map((b) => b.text ?? '').join(' ');
      links = (params.prompt ?? []).filter((b) => b.type === 'resource_link').map((b) => b.name);
      const s = STORE ? (loadStore(params.sessionId) ?? { dir: process.cwd(), messages: [] }) : null;
      const msgId = () => `msg_${Date.now().toString(36)}${process.pid.toString(36)}_${++seq}`;
      if (s) {
        if (s.revert) s.messages = s.messages.slice(0, s.messages.findIndex((m) => m.id === s.revert.messageID)); // a staged revert is committed first
        delete s.revert;
        s.messages.push({ id: msgId(), time: { created: Date.now() }, text, type: 'user' });
        saveStore(params.sessionId, s);
      }
      // "tulis" really writes catatan.md when the store is on, so a rewind has a file to put back
      const file = `${process.cwd()}/catatan.md`;
      const before = s && /tulis/.test(text) ? { 'catatan.md': existsSync(file) ? readFileSync(file, 'utf8') : null } : {};
      const result = await turn(params.sessionId, text);
      if (s) {
        if (Object.keys(before).length && result.stopReason === 'end_turn') writeFileSync(file, `isi catatan ${seq}\n`);
        const files = result.stopReason === 'end_turn' ? Object.keys(before) : [];
        s.messages.push({ id: msgId(), time: { created: Date.now() }, type: 'assistant', snapshot: { start: 'snap0', files }, before: result.stopReason === 'end_turn' ? before : {} });
        saveStore(params.sessionId, s);
      }
      return reply(result);
    }
    case 'session/cancel':
      cancelTurn?.();
      cancelTurn = null;
      return;
    default:
      if (id != null) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}
