// A stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// Speaks the same protocol the real CLI does, so server tests run without a network or tokens.
//
// Behaviour per prompt text:
//   contains "izin"  → asks permission for a Write (control_request can_use_tool), then reports allow/deny
//   contains "lama"  → streams slowly so the test can interrupt it
//   "status?"        → replies with the live mode/model/effort, its pid and its launch flags
//   contains "Lanjutkan" → replies with the session it runs in and the --resume it was started with
//   contains "tugas latar" → starts a background subagent (qa) and a background shell; the subagent's transcript
//                      is written under CLAUDE_PROJECTS_DIR and grows a step every 300 ms until it is stopped
//   contains "selesaikan latar" → the background subagent hands its report back and its task completes
//   contains "perintah panjang" → a foreground Bash command (task_started, not backgrounded) whose output grows a
//                      line every 300 ms for ~5 s (readable live with get_task_output), then its tool_result
//   contains "sebut file" → a Read of src/checkout.ts (absolute path, offset 2), then a reply naming project files
//                      (`src/checkout.ts:2`, src/app.js:3, a URL and a missing file) for the file viewer's links
//   contains "gagal sengaja" → the turn ends with an error result
//   contains "kuota habis" → a rate_limit_event with status "rejected", then an error result
//   anything else    → streams a short text reply
// Control requests (initialize, set_permission_mode, set_model, apply_flag_settings, rewind_files,
// mcp_status, …) answer like the real CLI; every prompt reports command_lifecycle events.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const live = { mode: flag('--permission-mode') ?? 'default', model: flag('--model') ?? 'default', effort: flag('--effort') ?? 'auto' };
const waiting = new Set(); // prompt uuids queued but not started (cancel_async_message)

/** Control requests the web app sends, answered the way Claude Code answers them. */
function control(req) {
  switch (req.subtype) {
    case 'initialize':
      return {
        commands: [
          { name: 'fake-skill', description: 'Skill palsu untuk tes', argumentHint: '' },
          { name: 'context', description: 'Show context usage', argumentHint: '' },
        ],
        models: [
          { value: 'default', displayName: 'Default (recommended)', description: 'Fake Opus · default', supportedEffortLevels: ['low', 'high'] },
          { value: 'fable', displayName: 'Fable 5.1', description: 'Most capable', supportedEffortLevels: ['low', 'high', 'max'] },
          { value: 'old-model', displayName: 'Old', description: 'No effort', supportedEffortLevels: [] },
        ],
        claude_code_version: '9.9.9-fake',
      };
    case 'set_permission_mode':
      live.mode = req.mode;
      send({ type: 'system', subtype: 'status', status: null, permissionMode: req.mode, session_id: sessionId });
      return { mode: req.mode };
    case 'set_model':
      if (/tidak-ada/.test(req.model)) throw new Error(`Model '${req.model}' not found`);
      live.model = req.model;
      return { model: `claude-${req.model}` };
    case 'apply_flag_settings':
      if (req.settings?.effortLevel) live.effort = req.settings.effortLevel;
      return {};
    case 'get_context_usage':
      return { totalTokens: 21000, maxTokens: 1_000_000, percentage: 2, autoCompactThreshold: 967000, isAutoCompactEnabled: true };
    case 'rewind_files':
      return req.dry_run ? { canRewind: true, filesChanged: ['catatan.txt'], insertions: 1, deletions: 1 } : { canRewind: true };
    case 'mcp_status':
      return { mcpServers: [{ name: 'fake-mcp', status: 'connected', scope: 'user', tools: [{ name: 'a' }, { name: 'b' }] }, { name: 'auth-mcp', status: 'needs-auth', scope: 'user' }] };
    case 'mcp_authenticate':
      return { authUrl: 'https://example.com/oauth', requiresUserAction: true, callbackExpected: true, redirectScheme: 'localhost' };
    case 'mcp_reconnect':
    case 'mcp_toggle':
    case 'stop_task':
      stopBackground(req.task_id);
      return {};
    case 'background_tasks':
    case 'rename_session':
    case 'mcp_oauth_callback_url':
      return {};
    case 'get_task_output':
      if (bg.shell && req.task_id === bg.shell.id) return { output: bg.shell.output };
      if (fg.has(req.task_id)) return { output: fg.get(req.task_id).output };
      return { output: 'server jalan di :3000\n' };
    case 'cancel_async_message':
      return { cancelled: waiting.delete(req.message_uuid) };
    default:
      throw new Error(`Unsupported: ${req.subtype}`);
  }
}

// ---------- background tasks ("tugas latar") ----------

const bg = { agent: null, shell: null };
const fg = new Map(); // foreground shell task id -> { output }

/** A long foreground command: its output can be read live while the tool call is still open. */
async function longCommand() {
  const toolUseId = `toolu_${randomUUID()}`;
  const taskId = `f${randomUUID().slice(0, 8)}`;
  const command = 'npm run build -- --verbose';
  send({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command, description: 'Build lengkap' } }] } });
  send({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, description: 'Build lengkap', is_backgrounded: false, session_id: sessionId });
  const task = { output: '> build\n' };
  fg.set(taskId, task);
  for (let i = 1; i <= 16 && !interrupted; i++) {
    await sleep(300);
    task.output += `[${String(i).padStart(2, '0')}/16] compile modul-${i}.js ok\n`;
    send({ type: 'tool_progress', tool_use_id: toolUseId, tool_name: 'Bash', elapsed_time_seconds: Math.floor((i * 300) / 1000), session_id: sessionId });
  }
  task.output += 'Build selesai.\n';
  send({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId, status: 'completed', session_id: sessionId });
  send({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: task.output }] } });
}

function agentLine(file, type, content) {
  appendFileSync(file, `${JSON.stringify({ type, isSidechain: true, agentId: bg.agent.id, sessionId, timestamp: new Date().toISOString(), uuid: randomUUID(), message: { role: type, content } })}\n`);
}

function startBackground() {
  const agentId = `a${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const agentToolUse = `toolu_${randomUUID()}`;
  const shellToolUse = `toolu_${randomUUID()}`;
  const description = 'Uji regresi checkout';
  send({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, content: [{ type: 'tool_use', id: agentToolUse, name: 'Agent', input: { subagent_type: 'qa', description, prompt: 'Jalankan tes checkout dan laporkan hasilnya.', run_in_background: true } }] } });
  send({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: agentToolUse, content: `Async agent launched successfully. agentId: ${agentId}` }] } });
  send({ type: 'system', subtype: 'task_started', task_id: agentId, tool_use_id: agentToolUse, description, subagent_type: 'qa', is_backgrounded: true, session_id: sessionId });
  const command = 'npm run dev -- --port 3000';
  send({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, content: [{ type: 'tool_use', id: shellToolUse, name: 'Bash', input: { command, description: 'Dev server', run_in_background: true } }] } });
  const shellId = `b${randomUUID().slice(0, 8)}`;
  send({ type: 'system', subtype: 'task_started', task_id: shellId, tool_use_id: shellToolUse, description: 'Dev server', is_backgrounded: true, session_id: sessionId });
  send({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: shellToolUse, content: `Command running in background with ID: ${shellId}` }] } });

  bg.shell = { id: shellId, output: '> dev\nserver jalan di :3000\n', timer: null };
  bg.shell.timer = setInterval(() => (bg.shell.output += `GET /checkout 200 ${Date.now() % 1000}ms\n`), 300);
  bg.agent = { id: agentId, toolUseId: agentToolUse, file: null, timer: null, n: 0 };
  const root = process.env.CLAUDE_PROJECTS_DIR;
  if (!root) return;
  const dir = path.join(root, path.resolve(process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'), sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  bg.agent.file = file;
  writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'qa', description, toolUseId: agentToolUse }));
  agentLine(file, 'user', 'Jalankan tes checkout dan laporkan hasilnya.');
  agentLine(file, 'assistant', [{ type: 'text', text: 'Saya mulai dengan membaca kode checkout.' }]);
  // One step every 300 ms: a Read, a Bash and an Edit in turn, each with its result (the first Bash fails).
  const tools = [
    { name: 'Read', input: { file_path: 'src/checkout.ts' } },
    { name: 'Bash', input: { command: 'npm test -- checkout' } },
    { name: 'Edit', input: { file_path: 'src/checkout.ts', old_string: 'a', new_string: 'b' } },
  ];
  bg.agent.timer = setInterval(() => {
    const t = tools[bg.agent.n++ % tools.length];
    const id = `toolu_${randomUUID()}`;
    agentLine(file, 'assistant', [{ type: 'tool_use', id, name: t.name, input: t.input }]);
    agentLine(file, 'user', [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: bg.agent.n === 2 }]);
    send({ type: 'system', subtype: 'task_progress', task_id: agentId, description, last_tool_name: t.name, usage: { total_tokens: 1200 * bg.agent.n, tool_uses: bg.agent.n }, session_id: sessionId });
    if (bg.agent.n >= 400) clearInterval(bg.agent.timer);
  }, 300);
}

function finishAgent(status, report) {
  if (!bg.agent) return;
  clearInterval(bg.agent.timer);
  if (bg.agent.file && report) agentLine(bg.agent.file, 'assistant', [{ type: 'tool_use', id: `toolu_${randomUUID()}`, name: 'SubagentHandback', input: { message: report } }]);
  send({ type: 'system', subtype: 'task_notification', task_id: bg.agent.id, tool_use_id: bg.agent.toolUseId, status, summary: report ? 'Semua tes checkout lulus' : undefined, session_id: sessionId });
  bg.agent = null;
}

function stopBackground(taskId) {
  if (bg.agent && taskId === bg.agent.id) finishAgent('stopped');
  if (bg.shell && taskId === bg.shell.id) {
    clearInterval(bg.shell.timer);
    send({ type: 'system', subtype: 'task_notification', task_id: bg.shell.id, status: 'stopped', session_id: sessionId });
  }
}

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
  if (/rencana/i.test(text)) {
    // Plan mode: ExitPlanMode asks for approval; an approval with a setMode update switches the mode.
    const toolUseId = `toolu_${randomUUID()}`;
    const input = { plan: '1. Ubah validasi\n2. Tambah tes' };
    send({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, content: [{ type: 'tool_use', id: toolUseId, name: 'ExitPlanMode', input }] } });
    const decision = await new Promise((resolve) => {
      pendingPermission = resolve;
      send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input, tool_use_id: toolUseId } });
    });
    const setMode = decision.updatedPermissions?.find((p) => p.type === 'setMode');
    if (decision.behavior === 'allow') {
      live.mode = setMode?.mode ?? 'default';
      send({ type: 'system', subtype: 'status', status: null, permissionMode: live.mode, session_id: sessionId });
    }
    send({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: decision.behavior === 'allow' ? 'Plan approved' : decision.message, is_error: decision.behavior !== 'allow' }] } });
    await streamText(decision.behavior === 'allow' ? 'Rencana disetujui.' : 'Rencana direvisi.');
    return result();
  }
  if (/tugas latar/i.test(text)) {
    startBackground();
    await streamText('Agent QA dan dev server berjalan di latar belakang.', 5);
    return result();
  }
  if (/sebut file/i.test(text)) {
    const toolUseId = `toolu_${randomUUID()}`;
    send({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: path.join(process.cwd(), 'src', 'checkout.ts'), offset: 2, limit: 10 } }] } });
    send({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '1\texport {};' }] } });
    await streamText('Cek `src/checkout.ts:2` dan juga src/app.js:3 lalu https://example.com/a/b.js serta src/hilang.ts untuk detail.', 5);
    return result();
  }
  if (/perintah panjang/i.test(text)) {
    await longCommand();
    await streamText('Build selesai.', 5);
    return result();
  }
  if (/selesaikan latar/i.test(text)) {
    finishAgent('completed', '## Hasil\nSemua **12 tes** checkout lulus.');
    await streamText('Agent QA selesai.', 5);
    return result();
  }
  // 📋 Antrian tests: a turn that ends in an error, and one that hits the account's usage limit.
  if (/gagal sengaja/i.test(text)) {
    await streamText('Ada yang rusak.', 5);
    return result({ subtype: 'error_during_execution', is_error: true, result: 'Error palsu untuk tes' });
  }
  if (/kuota habis/i.test(text)) {
    send({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 }, session_id: sessionId });
    return result({ subtype: 'success', is_error: true, result: 'Claude AI usage limit reached' });
  }
  if (/Lanjutkan/.test(text)) {
    await streamText(`lanjut session=${sessionId} resume=${flag('--resume') ?? '-'}`, 5);
    return result();
  }
  if (/tim\?/.test(text)) {
    // 👥 Kelola tim: which subagents (--agents) and Lead prompt lines this process was started with.
    const agents = Object.keys(JSON.parse(flag('--agents') ?? '{}')).sort().join(',');
    const leadRoles = [...(flag('--append-system-prompt') ?? '').matchAll(/^- ([\w-]+): /gm)].map((m) => m[1]).sort().join(',');
    await streamText(`agents=${agents || '-'} lead=${leadRoles || '-'} pid=${process.pid}`, 5);
    return result();
  }
  if (/status\?/.test(text)) {
    await streamText(`mode=${live.mode} model=${live.model} effort=${live.effort} pid=${process.pid} resumeAt=${flag('--resume-session-at') ?? '-'}`, 5);
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
  } else if (msg.type === 'control_request') {
    try {
      send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: control(msg.request) } });
    } catch (err) {
      send({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: err.message } });
    }
  } else if (msg.type === 'user') {
    const content = msg.message.content;
    const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    const uuid = msg.uuid ?? randomUUID();
    const lifecycle = (state) => send({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: randomUUID() });
    lifecycle('queued');
    waiting.add(uuid);
    queue = queue.then(async () => {
      if (!waiting.delete(uuid)) return; // cancelled while queued
      lifecycle('started');
      if (args.includes('--replay-user-messages')) send({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid, isReplay: true });
      await handlePrompt(text);
      lifecycle('completed');
    });
  }
});
rl.on('close', () => queue.then(() => process.exit(0)));
