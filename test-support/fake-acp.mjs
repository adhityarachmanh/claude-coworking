#!/usr/bin/env node
// A fake `opencode acp` for tests (OPENCODE_BIN): speaks the Agent Client Protocol (JSON-RPC, one JSON per line)
// with the shapes the real OpenCode 2.x sends (see docs/design-opencode.md). Scenarios by prompt text:
//   "izin" — runs a shell command; asks first when the permission config says "ask" (allow → done, reject → cancelled)
//   "lama" — streams, then waits until session/cancel                       anything else — text, a read, a plan
// It honours OPENCODE_CONFIG_CONTENT like the real one (permission.bash: ask | allow | deny).
if (process.argv[2] === 'models') {
  console.log('opencode-go/beam-free\nopencode-go/kimi-k3\ngoogle/gemini-2.5-flash');
  process.exit(0);
}
if (process.argv[2] !== 'acp') {
  console.log('opencode 2.0.0-fake');
  process.exit(0);
}

// FAKE_ACP_FAIL_ONCE=<file>: the very first `acp` process dies at initialize (a cold start), later ones work.
import { existsSync, writeFileSync } from 'node:fs';
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
const sessions = new Set(['ses_fakeold']);
let options = { model: 'opencode-go/beam-free', mode: 'build' };
let cost = 0;
let seq = 0;
let cancelTurn = null;
const waiting = new Map(); // our request id -> resolve

const send = (obj) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: options.model, options: [{ value: 'opencode-go/beam-free', name: 'beam free' }, { value: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' }] },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: options.mode, options: [{ value: 'build', name: 'build' }, { value: 'plan', name: 'plan' }] },
];
const ask = (params) =>
  new Promise((resolve) => {
    const id = `perm-${++seq}`;
    waiting.set(id, resolve);
    send({ id, method: 'session/request_permission', params });
  });

async function turn(sessionId, text) {
  const say = async (msgId, ...parts) => {
    for (const p of parts) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', messageId: msgId, content: { type: 'text', text: p } });
      await sleep(20);
    }
  };
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
  switch (method) {
    case 'initialize':
      if (coldStart) process.exit(3);
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } }, authMethods: [], agentInfo: { name: 'OpenCode', version: '2.0.0-fake' } });
    case 'session/new': {
      const sessionId = `ses_fake${++seq}`;
      sessions.add(sessionId);
      update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init', description: 'AGENTS.md' }] });
      return reply({ sessionId, configOptions: configOptions() });
    }
    case 'session/load':
      if (!sessions.has(params.sessionId)) return send({ id, error: { code: -32002, message: 'Session not found' } });
      // The real agent replays the old conversation: the office must not show it again.
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'msg_old', content: { type: 'text', text: 'jawaban lama' } });
      return reply({ configOptions: configOptions() });
    case 'session/set_config_option':
      options = { ...options, [params.configId]: params.value };
      return reply({ configOptions: configOptions() });
    case 'session/prompt': {
      const text = (params.prompt ?? []).map((b) => b.text ?? '').join(' ');
      return reply(await turn(params.sessionId, text));
    }
    case 'session/cancel':
      cancelTurn?.();
      cancelTurn = null;
      return;
    default:
      if (id != null) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}
