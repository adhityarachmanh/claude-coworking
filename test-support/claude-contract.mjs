// Contract test against the REAL Claude Code CLI (uses a few cheap Haiku requests).
// Run after updating Claude Code:  npm run test:claude
// It checks every protocol assumption this app relies on, so a breaking CLI change shows up here first.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaude } from '../src/claude-bin.js';
import { transcriptDir } from '../src/transcripts.js';

const claude = findClaude();
if (!claude) {
  console.error('Claude Code tidak ditemukan.');
  process.exit(1);
}
const cwd = mkdtempSync(path.join(os.tmpdir(), 'office-contract-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const args = [
  ...claude.args, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'manual', '--model', 'haiku',
  '--agents', JSON.stringify({ qa: { description: 'QA tester', prompt: 'You are QA.' } }),
];
const child = spawn(claude.command, args, { cwd, windowsHide: true, env: { ...process.env, OFFICE_MANAGED: '1' } });
const messages = [];
const listeners = [];
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      messages.push(msg);
      for (const l of [...listeners]) l(msg);
    } catch {
      // ignore non-JSON
    }
  }
});
const write = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
const prompt = (text) => write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
const next = (pred, ms = 120000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    const l = (msg) => {
      if (!pred(msg)) return;
      clearTimeout(timer);
      listeners.splice(listeners.indexOf(l), 1);
      resolve(msg);
    };
    listeners.push(l);
  });
const respond = (req, response) => write({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response } });

try {
  // 1. init + streaming
  let start = messages.length;
  prompt('Balas dengan satu kalimat pendek tentang kopi.');
  const init = await next((m) => m.type === 'system' && m.subtype === 'init');
  check('init: session_id, model, slash_commands', Boolean(init.session_id && init.model && Array.isArray(init.slash_commands)), init.model);
  check('init: --agents injected', init.agents?.includes('qa'));
  let result = await next((m) => m.type === 'result');
  const turn = messages.slice(start);
  check('stream_event text_delta', turn.some((m) => m.type === 'stream_event' && m.event?.delta?.type === 'text_delta'));
  check('assistant message carries id + text block', turn.some((m) => m.type === 'assistant' && m.message?.id && m.message.content?.some((b) => b.type === 'text')));
  check('result: success + usage', result.subtype === 'success' && typeof result.usage?.output_tokens === 'number');

  // 2. permission prompt → allow
  start = messages.length;
  prompt('Buat file izin.txt berisi teks ok memakai tool Write. Balas singkat.');
  let req = await next((m) => m.type === 'control_request');
  check('control_request can_use_tool (Write)', req.request?.subtype === 'can_use_tool' && req.request.tool_name === 'Write' && Boolean(req.request.tool_use_id), req.request?.tool_name);
  check('permission_suggestions offered', Array.isArray(req.request?.permission_suggestions));
  respond(req, { behavior: 'allow', updatedInput: req.request.input });
  result = await next((m) => m.type === 'result');
  check('allow → tool ran', existsSync(path.join(cwd, 'izin.txt')));
  check('tool_result linked by tool_use_id', messages.slice(start).some((m) => m.type === 'user' && m.message?.content?.some?.((b) => b.type === 'tool_result' && b.tool_use_id === req.request.tool_use_id)));

  // 3. permission prompt → deny
  prompt('Hapus file izin.txt memakai perintah shell. Kalau ditolak, balas: batal.');
  req = await next((m) => m.type === 'control_request');
  respond(req, { behavior: 'deny', message: 'Ditolak oleh tes kontrak' });
  result = await next((m) => m.type === 'result');
  check('deny → reported in permission_denials', result.permission_denials?.length >= 1 && existsSync(path.join(cwd, 'izin.txt')));

  // 4. interrupt
  prompt('Tulis cerita 3000 kata tentang kantor. Jangan pakai tool.');
  await next((m) => m.type === 'stream_event');
  const t0 = Date.now();
  write({ type: 'control_request', request_id: 'contract-interrupt', request: { subtype: 'interrupt' } });
  result = await next((m) => m.type === 'result', 20000);
  check('interrupt ends the turn quickly', Date.now() - t0 < 10000, `${Date.now() - t0} ms`);

  // 5. transcript format the CLI mirror and session history rely on
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
  const dir = transcriptDir(cwd);
  const file = existsSync(dir) ? readdirSync(dir).find((f) => f === `${init.session_id}.jsonl`) : null;
  check('transcript written under ~/.claude/projects', Boolean(file), dir);
  if (file) {
    const entries = readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const user = entries.find((e) => e.type === 'user' && typeof e.message?.content === 'string');
    check('transcript: entrypoint + sessionId + cwd', user?.entrypoint === 'sdk-cli' && user?.sessionId === init.session_id && Boolean(user?.cwd), user?.entrypoint);
    check('transcript: promptSource on prompts', Boolean(user?.promptSource), user?.promptSource);
    check('transcript: assistant stop_reason', entries.some((e) => e.type === 'assistant' && e.message?.stop_reason));
  }
} catch (err) {
  check('protocol run completed', false, err.message);
  child.kill();
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} cek gagal — Claude Code mungkin mengubah protokolnya.` : `\nSemua ${results.length} cek lolos.`);
process.exit(failed ? 1 : 0);
