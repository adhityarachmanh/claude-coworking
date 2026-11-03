// The protocol contract between this app and OpenCode (`opencode acp`, the Agent Client Protocol over stdio): every
// assumption src/acp-session.js and src/opencode-bin.js make about the CLI, as checks against the REAL binary.
// Two profiles share them:
//   - "light" (src/opencode-check.js, after an OpenCode update): token-free only — `--version`, `initialize` with the
//     app's client capabilities, `session/new` (+ configOptions model/mode, slash commands), `set_config_option`,
//     `session/load`, `opencode models` and `opencode session list`. NEVER a prompt: no model call, no tokens;
//   - "full" (`npm run test:opencode`): the light checks plus a real protocol run with a free model (streaming,
//     usage, the `session/request_permission` shape + reject, `session/cancel`).
// Every wait is bounded (per step and a total deadline); every process is spawned without a shell (argv array,
// windowsHide) and stopped with killTree (src/proc.js). The throwaway session is removed from OpenCode's store again.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync as rmSyncDefault } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify as classifyWith, sanitize } from './claude-contract.js';
import { CLIENT_CAPABILITIES, permissionConfig } from './acp-session.js';
import { execFileTree, killTree } from './proc.js';

export { sanitize };

/** Default bounds (ms). `total` caps the whole run; each step also has its own limit. */
export const DEFAULT_TIMEOUTS = Object.freeze({ version: 15_000, start: 60_000, rpc: 30_000, notify: 5_000, cli: 60_000, exit: 3_000, total: 180_000 });
// The full profile's protocol run makes model calls (a free model): more room.
const FULL_TIMEOUTS = Object.freeze({ turn: 120_000, total: 600_000 });

/** Check names (stable: stored in data/opencode-check.json and shown in the UI). */
export const CHECKS = Object.freeze({
  version: 'versi (opencode --version)',
  launch: 'acp: initialize',
  loadSession: 'initialize: loadSession',
  promptCaps: 'initialize: promptCapabilities (image, embeddedContext)',
  sessionNew: 'session/new: sessionId ses_…',
  model: 'configOptions: model',
  mode: 'configOptions: mode (build, plan)',
  commands: 'available_commands_update',
  setOption: 'session/set_config_option (mode)',
  load: 'session/load',
  models: 'opencode models',
  sessionList: 'opencode session list --format json',
  // full profile only (a free model)
  turn: 'prompt: agent_message_chunk + end_turn + usage',
  permission: 'session/request_permission: toolCall + opsi allow/reject',
  reject: 'tolak izin → giliran berhenti',
  cancel: 'session/cancel → cancelled',
});

// Without these the app cannot run OpenCode at all: "failed", not just a "warning".
const CRITICAL = new Set([CHECKS.version, CHECKS.launch, CHECKS.sessionNew]);

/** ok = every check passed; failed = a critical one failed; warning = only non-critical ones failed. */
export const classify = (checks) => classifyWith(checks, CRITICAL);

const SESSION_ID = /^ses_[\w-]{1,100}$/;
/** What src/acp-session.js sends (it never offers fs/* or terminal/*; form elicitation = the question card). */
export const CLIENT_INIT = Object.freeze({ protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES });

/** "opencode v2.2.5" / "2.0.18" → "2.2.5"; null when there is no version in the output. */
export function parseOpenCodeVersion(output) {
  // "v2.2.5": the "v" is glued to the number (no \b between them)
  const m = String(output ?? '').match(/(?<![\w.])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,30})?)(?![\w.])/);
  return m ? m[1] : null;
}

/**
 * `opencode --version`, cheaply: execFileTree (no shell, the whole tree killed on timeout), hidden window. Never throws.
 * @returns {Promise<{ version: string|null, error: string|null }>}
 */
export function readOpenCodeVersion(bin, { timeoutMs = DEFAULT_TIMEOUTS.version, env = process.env, execFileImpl = execFileTree, track = null } = {}) {
  if (!bin) return Promise.resolve({ version: null, error: 'OpenCode tidak ditemukan' });
  if (track?.aborted()) return Promise.resolve({ version: null, error: ABORTED });
  return new Promise((resolve) => {
    try {
      const child = execFileImpl(bin.command, [...bin.args, '--version'], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024, env: { ...env, OPENCODE_DISABLE_AUTOUPDATE: '1' } }, (err, stdout) => {
        if (err) return resolve({ version: null, error: err.killed || err.signal ? `timeout setelah ${timeoutMs} ms` : sanitize(err.code ?? err.message) });
        const version = parseOpenCodeVersion(stdout);
        resolve(version ? { version, error: null } : { version: null, error: `output tak dikenal: ${sanitize(stdout, 80)}` });
      });
      track?.add(child);
    } catch (err) {
      resolve({ version: null, error: sanitize(err.message) });
    }
  });
}

/**
 * Every process of one contract run, so a stop (server shutdown: AbortSignal) kills them all (whole tree). A process
 * started after the abort is killed at once; callers check aborted() before starting the next step.
 */
export function processTracker(signal) {
  const live = new Set();
  const killAll = () => {
    for (const pid of live) killTree(pid);
  };
  signal?.addEventListener('abort', killAll, { once: true });
  return {
    add(child) {
      if (!child?.pid) return;
      live.add(child.pid);
      child.once?.('exit', () => live.delete(child.pid));
      if (signal?.aborted) killTree(child.pid);
    },
    aborted: () => Boolean(signal?.aborted),
    live,
  };
}
const ABORTED = 'dibatalkan (server berhenti)';

/** A short `opencode <args>` run (bounded, whole tree killed on timeout or abort). Never throws. */
function runCli(bin, args, { cwd, env, timeoutMs, track }) {
  if (track?.aborted()) return Promise.resolve({ ok: false, timedOut: false, out: '', err: ABORTED, code: null });
  return new Promise((resolve) => {
    try {
      const child = execFileTree(bin.command, [...bin.args, ...args], { cwd, env, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
        resolve({ ok: !err, timedOut: Boolean(err?.killed), out: String(out ?? ''), err: String(errOut ?? ''), code: err?.code ?? 0 });
      });
      track?.add(child);
    } catch (err) {
      resolve({ ok: false, timedOut: false, out: '', err: err.message, code: null });
    }
  });
}

/**
 * An `opencode acp` process with bounded waits. `rpc` resolves with a JSON-RPC result (rejects on an error answer,
 * its timeout, the deadline or the process exiting first); `next(pred, ms)` waits for an incoming message (from now
 * on, or already received when `seen` is given) matching `pred`.
 */
function openAcp(bin, { cwd, env, deadline, track }) {
  const child = spawn(bin.command, [...bin.args, 'acp'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  track?.add(child);
  const messages = [];
  const listeners = new Set();
  let stderr = '';
  let exit = null;
  let buf = '';
  const gone = (info) => {
    exit ??= info;
    for (const l of [...listeners]) l(null);
  };
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => (gone({ code, signal }), resolve()));
    child.on('error', (err) => (gone({ error: err.message }), resolve()));
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
        continue; // not protocol output (a log line)
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

  const next = (pred, ms, { seen = false } = {}) =>
    new Promise((resolve, reject) => {
      if (seen) {
        const hit = messages.find(pred);
        if (hit) return resolve(hit);
      }
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

  const send = (obj) => {
    if (!exit && child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
  };
  let seq = 0;
  const rpc = async (method, params, ms) => {
    const id = `office-contract-${++seq}`;
    const reply = next((m) => m.id === id && !m.method, ms);
    send({ id, method, params });
    const msg = await reply;
    if (msg.error) throw new Error(`${method}: ${sanitize(msg.error.message ?? msg.error.code ?? 'error', 120)}`);
    return msg.result;
  };
  /** stdin closed → `opencode acp` ends on its own; the whole tree is killed if it is still there after `ms`. */
  const close = async (ms) => {
    try {
      child.stdin.end();
    } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, ms).unref?.())]);
    if (!exit) {
      killTree(child.pid);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000).unref?.())]);
    }
  };
  return { child, messages, next, send, rpc, close, exited, hasExited: () => Boolean(exit) };
}

const selectValues = (opt) => (Array.isArray(opt?.options) ? opt.options.map((o) => o?.value) : []);

/** initialize (one retry on a cold start, like src/acp-session.js), then session/new and what the app reads from it. */
async function handshake(acp, check, { t, cwd }) {
  let init;
  try {
    init = await acp.rpc('initialize', CLIENT_INIT, t.start);
  } catch (err) {
    return { error: err.message };
  }
  const caps = init?.agentCapabilities ?? {};
  check(CHECKS.launch, init && typeof init === 'object' && init.protocolVersion === 1, `protocolVersion ${sanitize(init?.protocolVersion ?? 'tidak ada', 20)}`);
  check(CHECKS.loadSession, caps.loadSession === true, 'dipakai untuk melanjutkan sesi (session/load)');
  check(CHECKS.promptCaps, caps.promptCapabilities?.image === true && caps.promptCapabilities?.embeddedContext === true, 'lampiran gambar dan @file');

  let res;
  const start = acp.messages.length;
  try {
    res = await acp.rpc('session/new', { cwd, mcpServers: [] }, t.rpc);
  } catch (err) {
    check(CHECKS.sessionNew, false, err.message);
    return { init };
  }
  const sessionId = typeof res?.sessionId === 'string' && SESSION_ID.test(res.sessionId) ? res.sessionId : null;
  check(CHECKS.sessionNew, Boolean(sessionId), sessionId ? '' : `bentuk berubah: ${sanitize(res?.sessionId ?? 'tidak ada', 40)}`);
  const options = Array.isArray(res?.configOptions) ? res.configOptions : [];
  const model = options.find((o) => o?.id === 'model');
  const modelValues = selectValues(model);
  check(CHECKS.model, modelValues.length > 0 && modelValues.every((v) => typeof v === 'string') && typeof model.currentValue === 'string', model ? `${modelValues.length} model` : 'tidak ada opsi model');
  const modeValues = selectValues(options.find((o) => o?.id === 'mode'));
  check(CHECKS.mode, modeValues.includes('build') && modeValues.includes('plan'), modeValues.length ? sanitize(modeValues.join(', '), 80) : 'tidak ada opsi mode');
  // Slash commands for the autocomplete: a notification, maybe sent before the reply (already received) or just after.
  try {
    const u = await acp.next((m, i) => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'available_commands_update' && (i === undefined || i >= start), t.notify, { seen: true });
    const list = u.params.update.availableCommands;
    check(CHECKS.commands, Array.isArray(list) && list.every((c) => typeof c?.name === 'string'), Array.isArray(list) ? `${list.length} command` : 'bentuk berubah');
  } catch (err) {
    check(CHECKS.commands, false, err.message);
  }
  return { init, sessionId, modeValues, modelValues };
}

/** The token-free session checks: set_config_option (mode) and session/load of the session just made. */
async function sessionChecks(acp, check, { t, cwd, sessionId, modeValues }) {
  if (modeValues.includes('plan')) {
    try {
      const r = await acp.rpc('session/set_config_option', { sessionId, configId: 'mode', value: 'plan' }, t.rpc);
      // The app copes without configOptions in the answer; when present, the mode must have changed.
      const opt = Array.isArray(r?.configOptions) ? r.configOptions.find((o) => o?.id === 'mode') : null;
      check(CHECKS.setOption, !opt || opt.currentValue === 'plan', opt ? `mode = ${sanitize(opt.currentValue, 30)}` : '');
      await acp.rpc('session/set_config_option', { sessionId, configId: 'mode', value: 'build' }, t.rpc).catch(() => {});
    } catch (err) {
      check(CHECKS.setOption, false, err.message);
    }
  } else check(CHECKS.setOption, false, 'tidak ada mode plan untuk dicoba');
  try {
    await acp.rpc('session/load', { sessionId, cwd, mcpServers: [] }, t.rpc);
    check(CHECKS.load, true);
  } catch (err) {
    check(CHECKS.load, false, err.message);
  }
}

/** `opencode models` (the model picker) and `opencode session list --format json` (🕘 Riwayat sesi). */
async function cliChecks(bin, check, { t, cwd, env, track, budget }) {
  const run = async (name, args) => {
    const ms = budget(t.cli);
    if (!ms) return { skipped: true, detail: 'batas waktu total habis' };
    const r = await runCli(bin, args, { cwd, env, timeoutMs: ms, track });
    return { ...r, detail: r.ok ? '' : r.timedOut ? `timeout setelah ${ms} ms` : r.err === ABORTED ? ABORTED : `kode ${r.code}: ${sanitize(r.err, 100)}` };
  };
  const models = await run(CHECKS.models, ['models']);
  const lines = String(models.out ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  check(CHECKS.models, models.ok && lines.length > 0 && lines.every((l) => /^[\w.@-]+\/\S+$/.test(l)), models.ok ? `${lines.length} model` : models.detail);
  const list = await run(CHECKS.sessionList, ['session', 'list', '--format', 'json', '-n', '5']);
  let ok = Boolean(list.ok);
  let detail = list.detail;
  if (ok && list.out.trim()) {
    try {
      const parsed = JSON.parse(list.out);
      ok = Array.isArray(parsed) && parsed.every((x) => typeof x?.id === 'string');
      detail = ok ? `${parsed.length} sesi` : 'bukan daftar sesi';
    } catch {
      ok = false;
      detail = `bukan JSON: ${sanitize(list.out, 60)}`;
    }
  }
  check(CHECKS.sessionList, ok, detail);
}

/** The full profile's protocol run (a free model): text turn, permission request + reject, cancel. */
async function protocolRun(acp, check, { t, sessionId, model, modelValues = [] }) {
  const updates = (from) => acp.messages.slice(from).filter((m) => m.method === 'session/update').map((m) => m.params?.update ?? {});
  try {
    // The asked model when this OpenCode offers it; otherwise OpenCode's own default.
    if (model && modelValues.includes(model)) await acp.rpc('session/set_config_option', { sessionId, configId: 'model', value: model }, t.rpc).catch(() => {});
    // 1. text turn
    let from = acp.messages.length;
    let r = await acp.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Balas hanya dengan satu kata: ok. Jangan pakai tool.' }] }, t.turn);
    const chunks = updates(from).filter((u) => u.sessionUpdate === 'agent_message_chunk');
    check(CHECKS.turn, r?.stopReason === 'end_turn' && chunks.some((u) => u.content?.type === 'text') && typeof r?.usage?.inputTokens === 'number' && typeof r?.usage?.outputTokens === 'number', `${chunks.length} chunk, stopReason ${sanitize(r?.stopReason ?? '-', 20)}`);

    // 2. a shell command under permission "ask" → session/request_permission; rejected → the turn ends
    from = acp.messages.length;
    const turn = acp.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Jalankan perintah shell `echo izin` memakai tool shell/bash. Kalau ditolak, berhenti dan balas: batal.' }] }, t.turn);
    turn.catch(() => {});
    const req = await acp.next((m) => m.method === 'session/request_permission' && m.id != null, t.turn);
    const p = req.params ?? {};
    const kinds = (p.options ?? []).map((o) => o?.kind);
    check(CHECKS.permission, Boolean(p.toolCall?.toolCallId) && ['allow_once', 'reject_once'].every((k) => kinds.includes(k)) && (p.options ?? []).every((o) => typeof o?.optionId === 'string'), sanitize(kinds.join(', '), 80));
    const reject = (p.options ?? []).find((o) => o?.kind === 'reject_once');
    acp.send({ id: req.id, result: { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } } });
    r = await turn;
    const failed = updates(from).some((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === p.toolCall?.toolCallId && u.status === 'failed');
    check(CHECKS.reject, r?.stopReason === 'cancelled' || failed, `stopReason ${sanitize(r?.stopReason ?? '-', 20)}`);

    // 3. cancel while a turn runs
    const long = acp.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Tulis cerita 2000 kata tentang kantor (tugas lama). Jangan pakai tool.' }] }, t.turn);
    long.catch(() => {});
    await acp.next((m) => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk', t.turn);
    const t0 = Date.now();
    // A cancel that arrives between two steps of the agent may be missed: sent again every second (at most 5 times).
    let settled = false;
    long.finally(() => (settled = true)).catch(() => {});
    for (let i = 0; i < 5 && !settled; i++) {
      acp.send({ method: 'session/cancel', params: { sessionId } });
      await Promise.race([long.catch(() => {}), new Promise((res) => setTimeout(res, 1000).unref?.())]);
    }
    r = await long;
    check(CHECKS.cancel, r?.stopReason === 'cancelled' && Date.now() - t0 < 15_000, `${Date.now() - t0} ms, stopReason ${sanitize(r?.stopReason ?? '-', 20)}`);
  } catch (err) {
    check('protocol run selesai', false, err.message);
  }
}

/**
 * Runs the contract against `bin` ({ command, args } from findOpenCode()).
 * @param {{ bin: {command: string, args: string[]}|null, profile?: 'light'|'full', env?: object, model?: string,
 *   timeouts?: Partial<typeof DEFAULT_TIMEOUTS>, onCheck?: (c: {name: string, ok: boolean, detail: string}) => void,
 *   execFileImpl?: Function }} options
 * @returns {Promise<{ profile: string, version: string|null, checks: {name: string, ok: boolean, detail: string}[],
 *   failing: string[], result: 'ok'|'warning'|'failed', usedModel: boolean, durationMs: number }>}
 */
export async function runOpenCodeContract({ bin, profile = 'light', env = process.env, model = '', timeouts = {}, onCheck = () => {}, execFileImpl, signal, rmSync = rmSyncDefault } = {}) {
  const t = { ...DEFAULT_TIMEOUTS, ...(profile === 'full' ? FULL_TIMEOUTS : {}), ...timeouts };
  const started = Date.now();
  const deadline = started + t.total;
  /** A step's timeout within what is left of `total` (0 = nothing left); cleanup gets at least `min`. */
  const budget = (ms, min = 0) => {
    const left = deadline - Date.now();
    return left > 0 ? Math.min(ms, Math.max(left, min)) : min;
  };
  const track = processTracker(signal);
  const checks = [];
  let usedModel = false;
  const check = (name, ok, detail = '') => {
    const c = { name, ok: Boolean(ok), detail: sanitize(detail ?? '') };
    checks.push(c);
    onCheck(c);
  };
  const report = (version) => ({ profile, version, checks, failing: checks.filter((c) => !c.ok).map((c) => c.name), result: classify(checks), usedModel, durationMs: Date.now() - started, aborted: track.aborted() });

  const v = await readOpenCodeVersion(bin, { timeoutMs: t.version, env, execFileImpl, track });
  check(CHECKS.version, Boolean(v.version), v.version ?? v.error);
  if (!v.version || track.aborted()) return report(v.version ?? null); // not answering: nothing else can be trusted

  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-opencode-contract-'));
  // The CLI runs never use the throwaway folder as cwd: a lingering process there would block removing it.
  const cliCwd = os.tmpdir();
  // As src/acp-session.js runs it: no self-update, the app's permission layer (manual: "ask") per process only.
  const childEnv = { ...env, OFFICE_MANAGED: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: permissionConfig('manual') }) };
  let sessionId = null;
  try {
    let acp = openAcp(bin, { cwd: dir, env: childEnv, deadline, track });
    try {
      let hs = await handshake(acp, check, { t, cwd: dir });
      if (hs.error && acp.hasExited() && Date.now() < deadline && !track.aborted()) {
        // Cold start (the first `opencode` call brings up its background service): one fresh process.
        await acp.close(t.exit);
        acp = openAcp(bin, { cwd: dir, env: childEnv, deadline, track });
        hs = await handshake(acp, check, { t, cwd: dir });
      }
      if (hs.error) check(CHECKS.launch, false, track.aborted() ? ABORTED : hs.error);
      sessionId = hs.sessionId ?? null;
      if (sessionId && !track.aborted()) {
        await sessionChecks(acp, check, { t, cwd: dir, sessionId, modeValues: hs.modeValues ?? [] });
        if (profile === 'full' && Date.now() < deadline && !track.aborted()) {
          usedModel = true;
          await protocolRun(acp, check, { t, sessionId, model, modelValues: hs.modelValues ?? [] });
        }
      }
    } finally {
      await acp.close(t.exit);
    }
    if (launched(checks) && !track.aborted()) await cliChecks(bin, check, { t, cwd: cliCwd, env: childEnv, track, budget });
  } finally {
    // The throwaway session is not history anyone wants (best effort, short, never after a stop).
    if (sessionId && !track.aborted()) await runCli(bin, ['api', 'session.remove', '--param', `sessionID=${sessionId}`], { cwd: cliCwd, env: childEnv, timeoutMs: budget(Math.min(t.cli, 30_000), 5_000), track });
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Windows EBUSY/EPERM (a scanner or a lingering handle): an empty temp folder left behind never changes the result
    }
  }
  return report(v.version);
}

/** The CLI checks only make sense when OpenCode started at all (initialize answered). */
const launched = (checks) => checks.some((c) => c.name === CHECKS.launch && c.ok);
