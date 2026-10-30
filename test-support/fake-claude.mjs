// A stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// Speaks the same protocol the real CLI does, so server tests run without a network or tokens.
//
// Behaviour per prompt text:
//   contains "izin"  → asks permission for a Write (control_request can_use_tool), then reports allow/deny
//   contains "lama"  → streams slowly so the test can interrupt it
//   anything else    → streams a short text reply
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);

// Account commands: a fixed logged-in test account; `/usage` prints plan usage like the real CLI.
if (args[0] === 'auth') {
  if (args[1] === 'status') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'tester@example.com', orgId: 'org-test', orgName: 'Test Org', subscriptionType: 'team' }));
  else console.log(`auth ${args[1]} ok`);
  process.exit(0);
}
if (args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'json') {
  console.log(JSON.stringify({ type: 'result', result: 'Current session: 4% used · resets Oct 31, 10:40am (Asia/Jakarta)\nCurrent week (all models): 20% used · resets Nov 3, 9am (Asia/Jakarta)' }));
  process.exit(0);
}

const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : randomUUID();
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pendingPermission = null;
let interrupted = false;

function init() {
  send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', permissionMode: 'default', slash_commands: ['fake-skill', 'context'], agents: [] });
}

async function streamText(text, delay = 40) {
  const id = `msg_${randomUUID()}`;
  send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id } } });
  for (const word of text.split(' ')) {
    if (interrupted) return id;
    send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${word} ` } } });
    await sleep(delay);
  }
  send({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'text', text }] } });
  return id;
}

function result(extra = {}) {
  send({ type: 'result', subtype: 'success', is_error: false, result: 'done', duration_ms: 1234, num_turns: 1, session_id: sessionId, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, model_usage_since_last_result: { 'fake-model': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 90, cacheCreationInputTokens: 0, costUSD: 0.01 } }, permission_denials: [], ...extra });
}

async function handlePrompt(text) {
  init();
  interrupted = false;
  if (/izin/i.test(text)) {
    const toolUseId = `toolu_${randomUUID()}`;
    const input = { file_path: 'hasil.txt', content: 'halo' };
    send({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, content: [{ type: 'tool_use', id: toolUseId, name: 'Write', input }] } });
    const decision = await new Promise((resolve) => {
      pendingPermission = resolve;
      send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'can_use_tool', tool_name: 'Write', input, tool_use_id: toolUseId, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } });
    });
    const allowed = decision.behavior === 'allow';
    send({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: allowed ? 'File created successfully' : decision.message, is_error: !allowed }] } });
    await streamText(allowed ? 'File dibuat.' : 'Dibatalkan.');
    return result(allowed ? {} : { permission_denials: [{ tool_name: 'Write' }] });
  }
  if (/lama/i.test(text)) {
    await streamText(Array.from({ length: 400 }, (_, i) => `kata${i}`).join(' '), 25);
    return result();
  }
  await streamText('Halo dari Claude palsu yang sedang mengetik.');
  return result();
}

let queue = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'control_response') {
    pendingPermission?.(msg.response.response);
    pendingPermission = null;
  } else if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    interrupted = true;
    send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
  } else if (msg.type === 'user') {
    const content = msg.message.content;
    const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    queue = queue.then(() => handlePrompt(text));
  }
});
rl.on('close', () => queue.then(() => process.exit(0)));
