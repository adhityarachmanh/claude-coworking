// The protocol contract between this app and Claude Code: every assumption the app makes about the CLI's
// stream-json protocol, as checks against the REAL binary. Two profiles share them:
//   - "light" (src/claude-check.js, after a Claude Code update): token-free checks only — `--version`, the app's
//     launch flags (--permission-prompt-tool stdio, --agents file, --append-system-prompt-file), the `initialize`
//     answer and the live control requests — plus at most ONE tiny Haiku turn (opt-out: allowModel = false);
//   - "full" (`npm run test:claude`): the token-free checks plus a real protocol run (a few Haiku requests:
//     streaming, permission allow/deny, interrupt, transcript format).
// Every wait is bounded (per step and a total deadline); the CLI process is always closed or killed.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptDir } from './transcripts.js';

/** Default bounds (ms). `total` caps the whole run; each step also has its own limit. */
export const DEFAULT_TIMEOUTS = Object.freeze({ version: 15_000, start: 45_000, control: 15_000, turn: 90_000, exit: 3_000, total: 180_000 });
// The full profile's protocol run makes several model calls (a 3000-word story is interrupted): more room.
const FULL_TIMEOUTS = Object.freeze({ turn: 120_000, total: 600_000 });

/** Check names (stable: they are stored in data/claude-check.json and shown in the UI). */
export const CHECKS = Object.freeze({
  version: 'versi (claude --version)',
  launch: 'flag peluncuran app diterima',
  catalog: 'initialize: commands + models',
  agents: 'initialize: --agents dari file',
  versionMatch: 'initialize: versi sama dengan --version',
  mode: 'kontrol: set_permission_mode',
  model: 'kontrol: set_model',
  context: 'kontrol: get_context_usage',
  // the one light Haiku turn
  init: 'init: session_id, model, slash_commands',
  initAgents: 'init: --agents terpasang',
  delta: 'stream_event text_delta',
  assistant: 'assistant: id + blok text',
  result: 'result: success + usage',
});

// Without these the app cannot run Claude Code at all: the check is "failed", not just a "warning".
const CRITICAL = new Set([CHECKS.version, CHECKS.launch, CHECKS.catalog]);

/** ok = every check passed; failed = a critical one failed; warning = only non-critical ones failed. */
export function classify(checks, critical = CRITICAL) {
  const failing = checks.filter((c) => !c.ok);
  if (!failing.length) return 'ok';
  return failing.some((c) => critical.has(c.name)) ? 'failed' : 'warning';
}

const HOME = os.homedir();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Text from the CLI (stderr, errors) made safe for logs and the UI: no home path (user name), e-mail addresses,
 * API keys / OAuth tokens or long secrets-looking strings, no control characters; at most `max` characters.
 */
export function sanitize(text, max = 200) {
  let s = String(text ?? '');
  if (HOME && HOME.length > 3) s = s.replace(new RegExp(escapeRe(HOME), 'gi'), '~');
  s = s
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/\bsk-[\w-]{8,}/g, '<token>')
    .replace(/\b(Bearer|token|key|secret|password)([=:\s]+)\S+/gi, '$1$2<redacted>')
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '<redacted>')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "2.1.316 (Claude Code)" → "2.1.316"; null when the output is not Claude Code's. */
export function parseVersion(output) {
  const text = String(output ?? '');
  if (!/claude code/i.test(text)) return null;
  const m = text.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,30})?)\b/);
  return m ? m[1] : null;
}

/**
 * `claude --version`, cheaply: execFile (no shell), hidden window, bounded. Never throws.
 * @returns {Promise<{ version: string|null, error: string|null }>}
 */
export function readClaudeVersion(claude, { timeoutMs = DEFAULT_TIMEOUTS.version, env = process.env, execFileImpl = execFile } = {}) {
  if (!claude) return Promise.resolve({ version: null, error: 'Claude Code tidak ditemukan' });
  return new Promise((resolve) => {
    try {
      execFileImpl(claude.command, [...claude.args, '--version'], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024, env, shell: false }, (err, stdout) => {
        if (err) return resolve({ version: null, error: err.killed || err.signal ? `timeout setelah ${timeoutMs} ms` : sanitize(err.code ?? err.message) });
        const version = parseVersion(stdout);
        resolve(version ? { version, error: null } : { version: null, error: `output tak dikenal: ${sanitize(stdout, 80)}` });
      });
    } catch (err) {
      resolve({ version: null, error: sanitize(err.message) });
    }
  });
}

/** Ends a process and everything it started (MCP servers, shells): taskkill /T on Windows. Best effort. */
function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => {});
    } catch {}
  } else {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

/**
 * A stream-json Claude Code process with bounded waits. `next(pred, ms)` resolves with the first message (from
 * now on) matching `pred`, and rejects on its timeout, the run's deadline, or the process exiting first.
 */
function openCli(claude, args, { cwd, env, deadline, signal }) {
  const child = spawn(claude.command, [...claude.args, ...args], { cwd, env: { ...env, OFFICE_MANAGED: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  // Server shutdown (src/claude-check.js stop()): the whole tree goes at once; every wait then ends with the exit.
  const onAbort = () => killTree(child);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  child.once('exit', () => signal?.removeEventListener('abort', onAbort));
  const messages = [];
  const listeners = new Set();
  let stderr = '';
  let exit = null;
  let buf = '';
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exit ??= { code, signal };
      resolve();
      for (const l of [...listeners]) l(null);
    });
    child.on('error', (err) => {
      exit ??= { error: err.message };
      resolve();
      for (const l of [...listeners]) l(null);
    });
  });
  child.stdin.on('error', () => {}); // the process may be gone already: reported through `exit`
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not protocol output
      }
      messages.push(msg);
      for (const l of [...listeners]) l(msg);
    }
  });

  const exitText = () => {
    const tail = sanitize(stderr.trim().split('\n').slice(-3).join(' '), 160);
    const how = exit?.error ? `gagal dijalankan (${sanitize(exit.error, 80)})` : `proses keluar (kode ${exit?.code ?? exit?.signal})`;
    return tail ? `${how}: ${tail}` : how;
  };

  const next = (pred, ms) =>
    new Promise((resolve, reject) => {
      const limit = Math.max(1, Math.min(ms, deadline - Date.now()));
      const done = (fn, value) => {
        clearTimeout(timer);
        listeners.delete(listener);
        fn(value);
      };
      const listener = (msg) => {
        if (msg === null) return done(reject, new Error(exitText()));
        if (pred(msg)) done(resolve, msg);
      };
      const timer = setTimeout(() => done(reject, new Error(`timeout setelah ${limit} ms`)), limit);
      if (exit) return done(reject, new Error(exitText()));
      listeners.add(listener);
    });

  const write = (obj) => {
    if (!exit && child.stdin.writable) child.stdin.write(`${JSON.stringify(obj)}\n`);
  };
  let seq = 0;
  /** A control request; resolves with the CLI's `response` object (subtype success|error). */
  const request = async (subtype, extra, ms) => {
    const id = `office-contract-${++seq}`;
    const reply = next((m) => m.type === 'control_response' && m.response?.request_id === id, ms);
    write({ type: 'control_request', request_id: id, request: { subtype, ...extra } });
    return (await reply).response;
  };
  const prompt = (text) => write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
  /** stdin closed → the CLI exits on its own; killed (whole tree) if it is still there after `ms`. */
  const close = async (ms) => {
    try {
      child.stdin.end();
    } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, ms).unref?.())]);
    if (!exit) {
      killTree(child);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000).unref?.())]);
    }
  };
  return { child, messages, next, write, request, prompt, close, exited };
}

/** The checks that cost no tokens: the app's own launch flags, `initialize` and the live control requests. */
async function tokenFree(cli, check, { version, t }) {
  let init;
  try {
    init = await cli.request('initialize', {}, t.start);
  } catch (err) {
    check(CHECKS.launch, false, err.message);
    return false;
  }
  check(CHECKS.launch, init?.subtype === 'success', init?.subtype === 'success' ? '' : init?.error);
  if (init?.subtype !== 'success') return false;
  const r = init.response ?? {};
  const models = Array.isArray(r.models) ? r.models : null;
  const commands = Array.isArray(r.commands) ? r.commands : null;
  check(CHECKS.catalog, Boolean(models && commands && models.every((m) => typeof m?.value === 'string') && commands.every((c) => typeof c?.name === 'string')), models && commands ? `${models.length} model, ${commands.length} command` : 'bentuk berubah');
  check(CHECKS.agents, Array.isArray(r.agents) && r.agents.some((a) => (typeof a === 'string' ? a : a?.name) === 'qa'), Array.isArray(r.agents) ? `${r.agents.length} agen` : 'tidak ada daftar agents');
  check(CHECKS.versionMatch, r.claude_code_version === version, sanitize(r.claude_code_version ?? 'tidak ada', 40));

  const control = async (name, steps) => {
    try {
      for (const [subtype, extra, ok] of steps) {
        const res = await cli.request(subtype, extra, t.control);
        if (res?.subtype !== 'success' || !ok(res.response ?? {})) return check(name, false, res?.error ?? `${subtype}: jawaban berubah`);
      }
      check(name, true);
    } catch (err) {
      check(name, false, err.message);
    }
  };
  await control(CHECKS.mode, [
    ['set_permission_mode', { mode: 'plan' }, (r) => !r.mode || r.mode === 'plan'],
    ['set_permission_mode', { mode: 'default' }, () => true],
  ]);
  await control(CHECKS.model, [['set_model', { model: 'haiku' }, () => true]]);
  await control(CHECKS.context, [['get_context_usage', {}, (r) => typeof r.totalTokens === 'number']]);
  return true;
}

/** The light profile's one tiny model call: init message, streaming, assistant message, result. */
async function oneTurn(cli, check, { t }) {
  const start = cli.messages.length;
  cli.prompt('Balas hanya dengan satu kata: ok');
  try {
    const init = await cli.next((m) => m.type === 'system' && m.subtype === 'init', t.turn);
    check(CHECKS.init, Boolean(init.session_id && init.model && Array.isArray(init.slash_commands)), sanitize(init.model ?? '', 60));
    check(CHECKS.initAgents, Array.isArray(init.agents) && init.agents.includes('qa'));
    const result = await cli.next((m) => m.type === 'result', t.turn);
    const turn = cli.messages.slice(start);
    check(CHECKS.delta, turn.some((m) => m.type === 'stream_event' && m.event?.delta?.type === 'text_delta'));
    check(CHECKS.assistant, turn.some((m) => m.type === 'assistant' && m.message?.id && m.message.content?.some((b) => b.type === 'text')));
    check(CHECKS.result, result.subtype === 'success' && typeof result.usage?.output_tokens === 'number', sanitize(result.subtype, 40));
    return init.session_id ?? null;
  } catch (err) {
    check('request kecil (Haiku) selesai', false, err.message);
    return null;
  }
}

/** The full protocol run of `npm run test:claude` (several Haiku requests). Check names as they always were. */
async function protocolRun(claude, check, { cwd, env, t, deadline }) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'manual', '--model', 'haiku',
    '--agents', JSON.stringify({ qa: { description: 'QA tester', prompt: 'You are QA.' } }),
  ];
  const cli = openCli(claude, args, { cwd, env, deadline });
  const { messages, next, prompt, write } = cli;
  const respond = (req, response) => write({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response } });
  try {
    // 1. init + streaming
    let start = messages.length;
    prompt('Balas dengan satu kalimat pendek tentang kopi.');
    const init = await next((m) => m.type === 'system' && m.subtype === 'init', t.turn);
    check('init: session_id, model, slash_commands', Boolean(init.session_id && init.model && Array.isArray(init.slash_commands)), init.model);
    check('init: --agents injected', init.agents?.includes('qa'));
    let result = await next((m) => m.type === 'result', t.turn);
    const turn = messages.slice(start);
    check('stream_event text_delta', turn.some((m) => m.type === 'stream_event' && m.event?.delta?.type === 'text_delta'));
    check('assistant message carries id + text block', turn.some((m) => m.type === 'assistant' && m.message?.id && m.message.content?.some((b) => b.type === 'text')));
    check('result: success + usage', result.subtype === 'success' && typeof result.usage?.output_tokens === 'number');

    // 2. permission prompt → allow
    start = messages.length;
    prompt('Buat file izin.txt berisi teks ok memakai tool Write. Balas singkat.');
    let req = await next((m) => m.type === 'control_request', t.turn);
    check('control_request can_use_tool (Write)', req.request?.subtype === 'can_use_tool' && req.request.tool_name === 'Write' && Boolean(req.request.tool_use_id), req.request?.tool_name);
    check('permission_suggestions offered', Array.isArray(req.request?.permission_suggestions));
    respond(req, { behavior: 'allow', updatedInput: req.request.input });
    result = await next((m) => m.type === 'result', t.turn);
    check('allow → tool ran', existsSync(path.join(cwd, 'izin.txt')));
    check('tool_result linked by tool_use_id', messages.slice(start).some((m) => m.type === 'user' && m.message?.content?.some?.((b) => b.type === 'tool_result' && b.tool_use_id === req.request.tool_use_id)));

    // 3. permission prompt → deny
    prompt('Hapus file izin.txt memakai perintah shell. Kalau ditolak, balas: batal.');
    req = await next((m) => m.type === 'control_request', t.turn);
    respond(req, { behavior: 'deny', message: 'Ditolak oleh tes kontrak' });
    result = await next((m) => m.type === 'result', t.turn);
    check('deny → reported in permission_denials', result.permission_denials?.length >= 1 && existsSync(path.join(cwd, 'izin.txt')));

    // 4. interrupt
    prompt('Tulis cerita 3000 kata tentang kantor. Jangan pakai tool.');
    await next((m) => m.type === 'stream_event', t.turn);
    const t0 = Date.now();
    write({ type: 'control_request', request_id: 'contract-interrupt', request: { subtype: 'interrupt' } });
    result = await next((m) => m.type === 'result', 20_000);
    check('interrupt ends the turn quickly', Date.now() - t0 < 10_000, `${Date.now() - t0} ms`);

    // 5. transcript format the CLI mirror and session history rely on
    await cli.close(t.exit + 10_000);
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
  } finally {
    await cli.close(t.exit);
  }
}

/** The app's own launch flags (src/session.js spawn), with a throwaway team as files. */
function appArgs(dir) {
  const agentsFile = path.join(dir, 'agents.json');
  const promptFile = path.join(dir, 'lead.md');
  writeFileSync(agentsFile, JSON.stringify({ qa: { description: 'QA tester', prompt: 'You are QA.' } }), 'utf8');
  writeFileSync(promptFile, 'Kamu Lead dalam tes kontrak Adhitron. Jawab sesingkat mungkin.', 'utf8');
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default',
    '--model', 'haiku', '--agents', agentsFile, '--append-system-prompt-file', promptFile,
  ];
}

/**
 * Runs the contract against `claude` ({ command, args } from findClaude()).
 * @param {{ claude: {command: string, args: string[]}|null, profile?: 'light'|'full', allowModel?: boolean, env?: object,
 *   timeouts?: Partial<typeof DEFAULT_TIMEOUTS>, onCheck?: (c: {name: string, ok: boolean, detail: string}) => void,
 *   execFileImpl?: Function }} options
 * @returns {Promise<{ profile: string, version: string|null, checks: {name: string, ok: boolean, detail: string}[],
 *   failing: string[], result: 'ok'|'warning'|'failed', usedModel: boolean, durationMs: number }>}
 */
export async function runContract({ claude, profile = 'light', allowModel = true, env = process.env, timeouts = {}, onCheck = () => {}, execFileImpl, signal } = {}) {
  const t = { ...DEFAULT_TIMEOUTS, ...(profile === 'full' ? FULL_TIMEOUTS : {}), ...timeouts };
  const started = Date.now();
  const deadline = started + t.total;
  const checks = [];
  let usedModel = false;
  const check = (name, ok, detail = '') => {
    const c = { name, ok: Boolean(ok), detail: sanitize(detail ?? '') };
    checks.push(c);
    onCheck(c);
  };
  const report = (version) => ({ profile, version, checks, failing: checks.filter((c) => !c.ok).map((c) => c.name), result: classify(checks), usedModel, durationMs: Date.now() - started });

  const v = await readClaudeVersion(claude, { timeoutMs: t.version, env, execFileImpl });
  check(CHECKS.version, Boolean(v.version), v.version ?? v.error);
  if (!v.version) return report(null); // not Claude Code (or not answering): nothing else can be trusted
  if (signal?.aborted) return report(v.version); // server stopping: no new process

  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-contract-'));
  try {
    const cli = openCli(claude, appArgs(dir), { cwd: dir, env, deadline, signal });
    try {
      const ready = await tokenFree(cli, check, { version: v.version, t });
      if (ready && profile === 'light' && allowModel && !signal?.aborted) {
        usedModel = true;
        await oneTurn(cli, check, { t });
      }
    } finally {
      await cli.close(t.exit);
    }
    if (profile === 'full' && Date.now() < deadline && !signal?.aborted) {
      usedModel = true;
      await protocolRun(claude, check, { cwd: dir, env, t, deadline });
    }
  } finally {
    // What Claude Code keeps for this throwaway folder (the test turns' transcripts, an empty memory/ folder) is not
    // history anyone wants: removed again (after the full run has read it). Only this run's own folder, named after
    // its unique temp dir.
    try {
      rmSync(transcriptDir(dir), { recursive: true, force: true });
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Windows EBUSY/EPERM: a temp folder left behind never changes the result
    }
  }
  return report(v.version);
}
