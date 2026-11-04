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
//   contains "latar lalu lanjut" → background tasks start, the turn ends, then Claude Code starts a turn by itself
//     (as when a background task's notification arrives): no prompt of ours, it streams until interrupted
//   contains "perintah panjang" → a foreground Bash command (task_started, not backgrounded) whose output grows a
//                      line every 300 ms for ~5 s (readable live with get_task_output), then its tool_result
//   contains "sebut file" → a Read of src/checkout.ts (absolute path, offset 2), then a reply naming project files
//                      (`src/checkout.ts:2`, src/app.js:3, a URL and a missing file) for the file viewer's links
//   contains "gagal sengaja" → the turn ends with an error result
//   contains "kuota habis" → a rate_limit_event with status "rejected", then an error result
//   contains "lampiran?" → replies with the content block types it received (📎 attachments: image/document/text)
//   anything else    → streams a short text reply
// Control requests (initialize, set_permission_mode, set_model, apply_flag_settings, rewind_files,
// mcp_status, …) answer like the real CLI; every prompt reports command_lifecycle events.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
// `claude doctor` / `claude update` (⚙ Kompatibilitas): plain text, then exit, like the real CLI without a terminal
// `claude mcp add …`: the argv is appended to FAKE_MCP_LOG (one JSON line) so a test can check what the app sent
if (args[0] === 'mcp' && args[1] === 'add') {
  if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, `${JSON.stringify(['claude', ...args.slice(2)])}\n`);
  console.log(`Added MCP server ${args.find((a, i) => i > 1 && !a.startsWith('-') && args[i - 1] !== '-s' && args[i - 1] !== '-e' && args[i - 1] !== '--transport')}`);
  process.exit(0);
}
// `claude plugin …` (🧩 Ekstensi): a tiny marketplace; installs are kept in FAKE_PLUGIN_STATE (JSON list of ids)
if (args[0] === 'plugin') {
  const file = process.env.FAKE_PLUGIN_STATE;
  let installed = [];
  try {
    installed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  const save = () => file && writeFileSync(file, JSON.stringify(installed));
  const id = args[2];
  if (args[1] === 'list') {
    const mine = installed.map((p) => ({ id: p.id, version: '1.0.0', scope: 'user', enabled: p.enabled }));
    const catalog = [
      { pluginId: 'reviewer@official', name: 'reviewer', description: 'Review kode otomatis' },
      { pluginId: 'risky@community', name: 'risky', description: 'Butuh perintah marketplace' },
    ];
    console.log(JSON.stringify(args.includes('--available') ? { installed: mine, available: catalog } : mine));
  } else if (args[1] === 'install') {
    const accepted = args.includes('--accept-command');
    if (id === 'risky@community' && !accepted) {
      console.log(JSON.stringify({ ok: false, shownCommand: { command: 'npx risky-setup', sha256: 'a'.repeat(64) } }));
      process.exit(1);
    }
    installed.push({ id, enabled: true });
    save();
    console.log(JSON.stringify({ ok: true, message: `Installed ${id}` }));
  } else if (args[1] === 'uninstall') {
    installed = installed.filter((p) => p.id !== id);
    save();
    console.log(JSON.stringify({ ok: true, message: `Uninstalled ${id}` }));
  } else if (args[1] === 'enable' || args[1] === 'disable') {
    for (const p of installed) if (p.id === id) p.enabled = args[1] === 'enable';
    save();
    console.log(JSON.stringify({ ok: true, message: `${args[1]}d ${id}` }));
  }
  process.exit(0);
}
// 🧭 role-map AI (src/role-memory.js): claude -p "OFFICE-ROLE-MAP: …" --model haiku → a JSON object of the names
// listed ("- mcp:x"): names with "crm" → pm, "nothing" → no answer for it, the rest → backend. Read-only is required.
if (args.includes('-p') && String(args[args.indexOf('-p') + 1] ?? '').startsWith('OFFICE-ROLE-MAP')) {
  if (args[args.indexOf('--permission-mode') + 1] !== 'plan' || args[args.indexOf('--model') + 1] !== 'haiku') process.exit(9);
  const names = [...String(args[args.indexOf('-p') + 1]).matchAll(/^- ([a-z]+:[^\s]+)/gm)].map((m) => m[1]);
  const out = {};
  for (const n of names) if (!n.includes('nothing')) out[n] = n.includes('crm') ? 'pm' : 'backend';
  console.log(`Berikut pemetaannya:\n\`\`\`json\n${JSON.stringify(out)}\n\`\`\``);
  process.exit(0);
}
// 🔁 handoff "Pintar": claude -p <prompt> --resume <id> --fork-session --output-format text (one answer, then exit)
if (args.includes('-p') && !args.includes('--fork-session') && args.some((a) => /CATATAN HANDOFF/.test(a))) {
  console.log('## Tujuan\nHandoff palsu dari Claude');
  process.exit(0);
}
if (args.includes('-p') && args.includes('--fork-session') && args[args.indexOf('--output-format') + 1] === 'text') {
  if (args.includes('--permission-mode') && args[args.indexOf('--permission-mode') + 1] !== 'plan') process.exit(9); // must be read-only
  console.log(`## Tujuan\nHandoff palsu dari Claude (sesi ${args[args.indexOf('--resume') + 1]})`);
  process.exit(0);
}
if (args[0] === 'doctor' || args[0] === 'update') {
  console.log(args[0] === 'doctor' ? 'Claude Code doctor\n\nNo installation issues found.' : 'Claude Code is up to date (9.9.9-fake)');
  process.exit(0);
}

// The Claude Code update detector (src/claude-check.js, src/claude-contract.js): which version this fake claims to be
// and which parts of the protocol it "broke", read per process so a test can change them while a server runs:
//   FAKE_CLAUDE_CONTRACT=<file.json> {"version": "2.0.0", "break": ["agents", ...]}  (wins over the env vars)
//   FAKE_CLAUDE_VERSION=2.0.0  FAKE_CLAUDE_BREAK=agents,set_model
// break: version (unparseable --version) · version-hang · hang (never answers initialize) · exit (dies on start like an
// unknown flag) · catalog · agents · set_model · context · init (init message without session_id)
const contract = (() => {
  let file = {};
  try {
    if (process.env.FAKE_CLAUDE_CONTRACT) file = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_CONTRACT, 'utf8'));
  } catch {}
  const env = (process.env.FAKE_CLAUDE_BREAK ?? '').split(',').filter(Boolean);
  return { version: file.version ?? process.env.FAKE_CLAUDE_VERSION ?? '9.9.9-fake', broken: new Set(file.break ?? env) };
})();
const broken = (part) => contract.broken.has(part);

if (args.includes('--version')) {
  if (broken('version-hang')) setInterval(() => {}, 1000);
  else {
    console.log(broken('version') ? 'something else 1.0' : `${contract.version} (Claude Code)`);
    process.exit(0);
  }
}
if (broken('exit') && args.includes('--input-format')) {
  console.error("error: unknown option '--permission-prompt-tool'");
  process.exit(1);
}

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

/** The subagents of --agents (inline JSON, or a file path with -p), like the real CLI lists them. */
function agentNames() {
  const arg = flag('--agents');
  if (!arg) return [];
  try {
    return Object.keys(JSON.parse(arg.trimStart().startsWith('{') ? arg : readFileSync(arg, 'utf8')));
  } catch {
    return [];
  }
}

/** Control requests the web app sends, answered the way Claude Code answers them. */
function control(req) {
  switch (req.subtype) {
    case 'initialize':
      if (broken('catalog')) return { commands: 'none', models: null, agents: agentNames().map((name) => ({ name })), claude_code_version: contract.version };
      return {
        agents: broken('agents') ? undefined : agentNames().map((name) => ({ name, description: `${name} (fake)` })),
        commands: [
          { name: 'fake-skill', description: 'Skill palsu untuk tes', argumentHint: '' },
          { name: 'context', description: 'Show context usage', argumentHint: '' },
        ],
        models: [
          { value: 'default', displayName: 'Default (recommended)', description: 'Fake Opus · default', supportedEffortLevels: ['low', 'high'] },
          { value: 'fable', displayName: 'Fable 5.1', description: 'Most capable', supportedEffortLevels: ['low', 'high', 'max'] },
          { value: 'old-model', displayName: 'Old', description: 'No effort', supportedEffortLevels: [] },
        ],
        claude_code_version: contract.version,
      };
    case 'set_permission_mode':
      live.mode = req.mode;
      send({ type: 'system', subtype: 'status', status: null, permissionMode: req.mode, session_id: sessionId });
      return { mode: req.mode };
    case 'set_model':
      if (broken('set_model')) throw new Error('set_model is not supported');
      if (/tidak-ada/.test(req.model)) throw new Error(`Model '${req.model}' not found`);
      live.model = req.model;
      return { model: `claude-${req.model}` };
    case 'apply_flag_settings':
      if (req.settings?.effortLevel) live.effort = req.settings.effortLevel;
      return {};
    case 'get_context_usage':
      if (broken('context')) return { tokens: 'n/a' };
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
  send({ type: 'system', subtype: 'init', session_id: broken('init') ? undefined : sessionId, model: 'fake-model', permissionMode: 'default', slash_commands: ['fake-skill', 'context'], agents: agentNames() });
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

async function handlePrompt(text, content) {
  init();
  interrupted = false;
  if (/lampiran\?/.test(text)) {
    // 📎 What arrived: the block types in order, document titles/media types, and the text attachments' first lines.
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    const docs = blocks.filter((b) => b.type === 'document').map((b) => `${b.title}:${b.source?.media_type}`);
    const images = blocks.filter((b) => b.type === 'image').map((b) => b.source?.media_type);
    const texts = blocks.filter((b) => b.type === 'text' && b.text.startsWith('<attachment ')).map((b) => b.text.split('\n').slice(0, 3).join(' / '));
    await streamText(`blocks=${blocks.map((b) => b.type).join(',')} docs=${docs.join('|') || '-'} images=${images.join('|') || '-'} texts=${texts.join('|') || '-'}`, 5);
    return result();
  }
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
  if (/latar lalu lanjut/i.test(text)) {
    startBackground();
    await streamText('Tugas latar berjalan.', 5);
    result();
    await sleep(200);
    interrupted = false;
    await streamText(Array.from({ length: 400 }, (_, i) => `lanjut${i}`).join(' '), 25); // the self-started turn
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
    // Like the real CLI: --agents is inline JSON or (with -p) a file path; the Lead prompt may come from a file.
    const agentsArg = flag('--agents') ?? '{}';
    const agents = Object.keys(JSON.parse(agentsArg.trimStart().startsWith('{') ? agentsArg : readFileSync(agentsArg, 'utf8'))).sort().join(',');
    const promptFile = flag('--append-system-prompt-file');
    const leadPrompt = promptFile ? readFileSync(promptFile, 'utf8') : (flag('--append-system-prompt') ?? '');
    const leadRoles = [...leadPrompt.matchAll(/^- ([\w-]+): /gm)].map((m) => m[1]).sort().join(',');
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
    if (broken('hang') && msg.request?.subtype === 'initialize') return; // never answers: the caller's timeout must end it
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
      await handlePrompt(text, content);
      lifecycle('completed');
    });
  }
});
rl.on('close', () => queue.then(() => process.exit(0)));
