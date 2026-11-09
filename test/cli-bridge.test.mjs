// 🌉 CLI bridge: payload clipping, project matching, hook output, settings file, and the ask route (allow/deny/timeout).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hookDecision, projectForCwd, sanitizeToolInput } from '../src/cli-bridge.js';
import { register } from '../src/routes/cli-bridge.js';
import { buildSettings, HOOK_MATCHER, HOOK_TIMEOUT_SECONDS } from '../tools/cli-bridge/settings.mjs';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'office-cli-bridge-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

test('sanitizeToolInput clips strings, arrays, depth and total size', () => {
  const out = sanitizeToolInput({
    command: 'x'.repeat(5000),
    file_path: 'C:\\project\\a.txt',
    nested: { a: { b: { c: { d: 'too deep' } } } },
    edits: Array.from({ length: 50 }, (_, i) => ({ old_string: `old-${i}`, new_string: 'y'.repeat(2000) })),
    __proto__: { polluted: true },
  });
  assert.equal(out.command.startsWith('x'.repeat(800)), true);
  assert.match(out.command, /… \(dipotong, 5000 karakter\)/);
  assert.equal(out.file_path, 'C:\\project\\a.txt');
  assert.equal(out.edits.length, 21, '20 items plus an explicit marker');
  assert.match(out.edits.at(-1), /item lagi/);
  assert.equal(out.nested.a.b.c, '… (terlalu dalam)');
  assert.equal(JSON.stringify(out).length < 20_000, true, 'total budget respected');
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(sanitizeToolInput(null).constructor, Object);
});

test('projectForCwd picks the deepest project, rejects outside/virtual folders', () => {
  const projects = [
    { id: 'outside', path: path.join(TMP, 'other') },
    { id: 'root', path: TMP },
    { id: 'nested', path: path.join(TMP, 'apps', 'toko') },
    { id: 'virtual', path: path.join(TMP, 'virtual'), virtual: true },
  ];
  assert.equal(projectForCwd(projects, path.join(TMP, 'apps', 'toko', 'src')).id, 'nested');
  assert.equal(projectForCwd(projects, path.join(TMP, 'docs')).id, 'root');
  assert.equal(projectForCwd(projects, path.join(TMP, 'virtual', 'x')).id, 'root', 'a virtual project is skipped, its real parent still matches');
  assert.equal(projectForCwd(projects, path.join(TMP, '..', 'elsewhere')), null);
  assert.equal(projectForCwd(projects, ''), null);
});

test('hookDecision only ever allows or denies; anything else falls back to the terminal', () => {
  assert.equal(hookDecision('allow').hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(hookDecision('deny').hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(hookDecision('yes'), null);
  assert.equal(hookDecision(undefined), null);
});

test('settings file targets the dangerous tools, with a timeout below Claude Code\'s fallback', () => {
  const settings = buildSettings({ nodePath: 'C:\\Program Files\\node.exe', hookPath: 'C:\\app folder\\hook.mjs', tokenFile: 'C:\\Temp folder\\token' });
  const entry = settings.hooks.PreToolUse[0];
  assert.equal(entry.matcher, HOOK_MATCHER);
  assert.match(entry.matcher, /Write/);
  assert.match(entry.matcher, /mcp__/);
  assert.equal(entry.hooks[0].timeout, HOOK_TIMEOUT_SECONDS);
  assert.equal(entry.hooks[0].command, '"C:\\Program Files\\node.exe" "C:\\app folder\\hook.mjs" "C:\\Temp folder\\token"');
});

function harness({ project, timeoutMs } = {}) {
  const handlers = new Map();
  register({ post: (pattern, handler) => handlers.set(pattern, handler) });
  const approvals = new Map();
  const hub = {
    projects: new Map(project ? [[project.id, project]] : []),
    requestApproval(id, data, onResolve) {
      approvals.set(data.id, { approval: { ...data, status: 'pending' }, onResolve });
      approvals.get(data.id).approval.id = data.id;
      return data;
    },
    resolveApproval(id, decision) {
      const entry = approvals.get(id);
      if (!entry) return false;
      approvals.delete(id);
      entry.onResolve(decision);
      return true;
    },
  };
  const ctx = { hub, dataDir: TMP, cliBridgeTimeoutMs: timeoutMs ?? 200 };
  const call = (body) => {
    let out = null;
    const res = {
      writeHead(status) { out = { status }; },
      end(text) { out.body = JSON.parse(text); },
    };
    return Promise.resolve(handlers.get('/api/cli-bridge/ask')(ctx, {}, res, {}, body)).then(() => out);
  };
  return { approvals, call };
}

test('ask: allow/deny reach the hook, the card carries a clipped CLI payload, and the decision is audited', async () => {
  const project = { id: 'p1', name: 'toko', path: path.join(TMP, 'toko'), virtual: false };
  const { approvals, call } = harness({ project });
  const pending = call({ tool: 'Bash', cwd: path.join(TMP, 'toko', 'src'), input: { command: `echo ${'x'.repeat(2000)}`, description: 'uji' } });
  await new Promise((resolve) => setImmediate(resolve));
  const [id, entry] = [...approvals.entries()][0];
  assert.equal(entry.approval.source, 'cli');
  assert.equal(entry.approval.kind, 'tool');
  assert.equal(entry.approval.canAlways, false);
  assert.match(entry.approval.label, /Uji|Menjalankan|echo/);
  assert.equal(entry.approval.input.command.startsWith(`echo ${'x'.repeat(795)}`), true);
  assert.match(entry.approval.input.command, /dipotong/);
  approvals.get(id).onResolve({ allow: true });
  const result = await pending;
  assert.deepEqual(result, { status: 200, body: { decision: 'allow', reason: 'Disetujui dari Adhit Office' } });

  const denied = harness({ project });
  const deniedCall = denied.call({ tool: 'Write', cwd: path.join(TMP, 'toko'), input: { file_path: 'a.txt', content: 'ok' } });
  await new Promise((resolve) => setImmediate(resolve));
  [...denied.approvals.values()][0].onResolve({ allow: false });
  assert.deepEqual((await deniedCall).body.decision, 'deny');

  const audit = readFileSync(path.join(TMP, 'audit.log'), 'utf8');
  assert.match(audit, /cli-approval/);
  assert.match(audit, /Bash · toko · allow/);
  assert.equal(audit.includes('x'.repeat(50)), false, 'no command content in the audit');
});

test('ask: outside a project / bad tool / timeout is denied, never allowed', async () => {
  const project = { id: 'p1', name: 'toko', path: path.join(TMP, 'toko'), virtual: false };
  const outside = harness({ project });
  const r1 = await outside.call({ tool: 'Bash', cwd: path.join(TMP, 'elsewhere'), input: { command: 'dir' } });
  assert.equal(r1.status, 404);
  const r2 = await outside.call({ tool: 'Bash; rm -rf /', cwd: path.join(TMP, 'toko'), input: { command: 'x' } });
  assert.equal(r2.status, 400);

  const waiting = harness({ project, timeoutMs: 20 });
  const pending = waiting.call({ tool: 'Write', cwd: path.join(TMP, 'toko'), input: { file_path: 'a.txt' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(waiting.approvals.size, 1, 'the card is open while waiting');
  const r3 = await pending;
  assert.equal(r3.body.decision, 'fallback');
  assert.match(r3.body.reason, /batas waktu/);
  assert.equal(waiting.approvals.size, 0, 'a timeout closes the card');
});

const HOOK = path.resolve('tools/cli-bridge/hook.mjs');
let hookRuns = 0;

/** Runs the real hook with one stdin payload and a short-lived token file; returns stdout/exit code. */
function runHook(payload, { base, token = 'tok_test' } = {}) {
  const tokenFile = path.join(TMP, `hook-token-${++hookRuns}`);
  if (token) writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, tokenFile], { env: { ...process.env, OFFICE_CLI_BASE: base } });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (code) => {
      rmSync(tokenFile, { force: true });
      resolve({ code, stdout });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test('hook: posts a clipped payload, prints allow/deny, and stays silent on failure', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, token: req.headers['x-office-token'], body: JSON.parse(body) });
      if (req.url !== '/api/cli-bridge/ask') return res.writeHead(404).end('{}');
      if (seen.at(-1).body.tool === 'Write' && seen.at(-1).body.input.file_path === 'fail.txt') return res.writeHead(500).end('{}');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ decision: seen.at(-1).body.tool === 'Bash' ? 'allow' : 'deny' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const allow = await runHook(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `npm test ${'x'.repeat(1200)}` }, cwd: TMP },
    { base },
  );
  assert.equal(allow.code, 0);
  assert.equal(JSON.parse(allow.stdout).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(seen[0].url, '/api/cli-bridge/ask');
  assert.equal(seen[0].token, 'tok_test');
  assert.equal(seen[0].body.input.command.startsWith('npm test ' + 'x'.repeat(791)), true, 'the hook clips before sending');
  assert.match(seen[0].body.input.command, /dipotong/);

  const deny = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.txt' } }, { base });
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const failed = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'fail.txt' } }, { base });
  assert.deepEqual(failed, { code: 0, stdout: '' }, 'a server error leaves the decision to the terminal');

  const noToken = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'dir' } }, { base, token: '' });
  assert.deepEqual(noToken, { code: 0, stdout: '' }, 'no token: fail-closed without a request');
  assert.equal(seen.length, 3, 'the no-token run never reached the server');
});
