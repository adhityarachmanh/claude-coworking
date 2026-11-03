// OpenCode update detector: the contract module (src/opencode-contract.js) against the fake `opencode`
// (test-support/fake-acp.mjs, which can claim a version and "break" parts of the protocol), and the background
// service (src/opencode-check.js): version change → light check, unchanged → nothing, failing names surface, every
// wait is bounded, the light check never sends a prompt (no model, no tokens), not installed → silent.
// No real OpenCode, no network.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
const rmSyncReal = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHECKS, classify, parseOpenCodeVersion, readOpenCodeVersion, runOpenCodeContract } from '../src/opencode-contract.js';
import { staleRunReply } from '../public/js/core/claude-check-rules.js';
import { OpenCodeCheckService } from '../src/opencode-check.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = { command: process.execPath, args: [path.join(APP, 'test-support', 'fake-acp.mjs')] };
const TMP = mkdtempSync(path.join(os.tmpdir(), 'office-opencode-check-'));
let n = 0;
const fileFor = (name = 'check') => path.join(TMP, `${name}-${++n}`);
/** The fake's env: a version, broken parts, and a log of every ACP request it received. */
function envFor(version, broken = []) {
  const rpcLog = fileFor('rpc.log');
  const cliLog = fileFor('cli.log');
  return { env: { ...process.env, FAKE_ACP_VERSION: version, FAKE_ACP_BREAK: broken.join(','), FAKE_ACP_RPC_LOG: rpcLog, FAKE_ACP_CLI_LOG: cliLog, FAKE_ACP_AUTH_FILE: fileFor('auth.json') }, rpcLog, cliLog };
}
/** The fake's non-acp runs: [args, cwd]. */
const cliRuns = (log) => methods(log).map((l) => l.split('\t'));
const methods = (log) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('opencode-contract: helpers', () => {
  test('parseOpenCodeVersion: "opencode v2.2.5", bare "2.0.18", pre-releases; nothing else', () => {
    assert.equal(parseOpenCodeVersion('opencode v2.2.5\n'), '2.2.5');
    assert.equal(parseOpenCodeVersion('2.0.18'), '2.0.18');
    assert.equal(parseOpenCodeVersion('opencode v2.0.0-fake'), '2.0.0-fake');
    assert.equal(parseOpenCodeVersion('1.2.3.4'), null);
    assert.equal(parseOpenCodeVersion('error: unknown'), null);
    assert.equal(parseOpenCodeVersion(null), null);
  });

  test('classify: critical = version, initialize, session/new', () => {
    assert.equal(classify([{ name: CHECKS.version, ok: true }]), 'ok');
    assert.equal(classify([{ name: CHECKS.mode, ok: false }]), 'warning');
    for (const name of [CHECKS.version, CHECKS.launch, CHECKS.sessionNew]) assert.equal(classify([{ name, ok: false }]), 'failed', name);
  });

  test('readOpenCodeVersion: not installed / a --version that hangs are answered (bounded), never thrown', async () => {
    assert.deepEqual(await readOpenCodeVersion(null), { version: null, error: 'OpenCode tidak ditemukan' });
    const { env } = envFor('9.9.9', ['version-hang']);
    const t0 = Date.now();
    const r = await readOpenCodeVersion(FAKE, { env, timeoutMs: 500 });
    assert.equal(r.version, null);
    assert.match(r.error, /timeout setelah 500 ms/);
    assert.ok(Date.now() - t0 < 8000, 'bounded');
  });
});

describe('opencode-contract: light profile against the fake', () => {
  test('everything passes, token-free: no session/prompt is ever sent; the throwaway session is removed', async () => {
    const { env, rpcLog } = envFor('2.3.0');
    const seen = [];
    const r = await runOpenCodeContract({ bin: FAKE, env, onCheck: (c) => seen.push(c.name) });
    assert.equal(r.result, 'ok', JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.equal(r.version, '2.3.0');
    assert.equal(r.usedModel, false);
    assert.deepEqual(r.failing, []);
    assert.deepEqual(seen, r.checks.map((c) => c.name), 'onCheck streams every check');
    for (const name of [CHECKS.launch, CHECKS.loadSession, CHECKS.promptCaps, CHECKS.sessionNew, CHECKS.model, CHECKS.mode, CHECKS.commands, CHECKS.setOption, CHECKS.load, CHECKS.models, CHECKS.sessionList]) assert.ok(seen.includes(name), name);
    for (const name of [CHECKS.turn, CHECKS.permission, CHECKS.reject, CHECKS.cancel]) assert.ok(!seen.includes(name), `${name}: full profile only`);
    const got = methods(rpcLog);
    assert.ok(got.includes('initialize') && got.includes('session/new'), got.join(','));
    assert.ok(!got.includes('session/prompt'), 'no model call');
    assert.ok(existsSync(`${env.FAKE_ACP_AUTH_FILE}.removed`), 'opencode api session.remove ran');
    assert.match(readFileSync(`${env.FAKE_ACP_AUTH_FILE}.removed`, 'utf8'), /^ses_fake\d+$/);
  });

  test('broken parts surface by name: non-critical → warning, critical → failed', async () => {
    let r = await runOpenCodeContract({ bin: FAKE, env: envFor('2.3.1', ['mode', 'commands', 'load', 'load-session', 'models', 'session-list']).env, timeouts: { notify: 300 } });
    assert.equal(r.result, 'warning');
    assert.deepEqual(new Set(r.failing), new Set([CHECKS.mode, CHECKS.commands, CHECKS.load, CHECKS.loadSession, CHECKS.models, CHECKS.sessionList, CHECKS.setOption]));

    r = await runOpenCodeContract({ bin: FAKE, env: envFor('2.3.2', ['session-new']).env });
    assert.equal(r.result, 'failed');
    assert.ok(r.failing.includes(CHECKS.sessionNew));
    assert.ok(!r.checks.some((c) => c.name === CHECKS.load), 'nothing after a failed session/new');
  });

  test('an acp process that dies at initialize: retried once (cold start), then failed', async () => {
    const { env, rpcLog } = envFor('2.3.3', ['acp-exit']);
    const r = await runOpenCodeContract({ bin: FAKE, env });
    assert.equal(r.result, 'failed');
    assert.deepEqual(r.failing, [CHECKS.launch]);
    assert.match(r.checks.find((c) => c.name === CHECKS.launch).detail, /proses keluar \(kode 4\)/);
    assert.equal(methods(rpcLog).filter((m) => m === 'initialize').length, 2, 'one retry');
    assert.ok(!r.checks.some((c) => c.name === CHECKS.models), 'the CLI checks only after a working start');
  });

  test('timeouts are bounded: an initialize that never answers, a --version that hangs', async () => {
    let t0 = Date.now();
    let r = await runOpenCodeContract({ bin: FAKE, env: envFor('2.3.4', ['initialize']).env, timeouts: { start: 400, exit: 200 } });
    assert.equal(r.result, 'failed');
    assert.deepEqual(r.failing, [CHECKS.launch]);
    assert.match(r.checks.find((c) => c.name === CHECKS.launch).detail, /timeout setelah 400 ms/);
    assert.ok(Date.now() - t0 < 15_000, `bounded (${Date.now() - t0} ms)`);

    t0 = Date.now();
    r = await runOpenCodeContract({ bin: FAKE, env: envFor('2.3.5', ['version-hang']).env, timeouts: { version: 400 } });
    assert.equal(r.result, 'failed');
    assert.deepEqual(r.failing, [CHECKS.version]);
    assert.equal(r.version, null);
    assert.ok(Date.now() - t0 < 10_000);
  });

  test('not installed: one failed check, no spawn', async () => {
    const r = await runOpenCodeContract({ bin: null });
    assert.equal(r.result, 'failed');
    assert.deepEqual(r.failing, [CHECKS.version]);
  });
});

describe('opencode-contract: full profile against the fake (npm run test:opencode)', () => {
  test('text turn, permission request shape + reject, cancel', async () => {
    const { env, rpcLog } = envFor('2.4.0');
    const r = await runOpenCodeContract({ bin: FAKE, env, profile: 'full', model: 'google/gemini-2.5-flash', timeouts: { turn: 10_000, total: 60_000 } });
    assert.equal(r.result, 'ok', JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.equal(r.usedModel, true);
    for (const name of [CHECKS.turn, CHECKS.permission, CHECKS.reject, CHECKS.cancel]) assert.ok(r.checks.some((c) => c.name === name && c.ok), name);
    const got = methods(rpcLog);
    assert.ok(got.includes('session/prompt') && got.includes('session/cancel'));
    assert.ok(got.includes('session/set_config_option'), 'the asked model, since this OpenCode offers it');
  });
});

describe('opencode-contract: cleanup, abort, total deadline', () => {
  test('a temp folder that cannot be removed (Windows EBUSY) never fails a passing check; CLI runs never use that folder', async () => {
    const { env, cliLog } = envFor('2.9.0');
    let removed = null;
    const rmSync = (dir) => {
      removed = dir;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    };
    const r = await runOpenCodeContract({ bin: FAKE, env, rmSync });
    assert.equal(r.result, 'ok', JSON.stringify(r.checks.filter((c) => !c.ok)));
    assert.match(path.basename(removed), /^office-opencode-contract-/);
    const runs = cliRuns(cliLog).filter(([args]) => args !== '--version');
    assert.deepEqual(runs.map(([args]) => args.split(' ')[0]).sort(), ['api', 'models', 'session']);
    for (const [args, cwd] of runs) {
      assert.equal(path.resolve(cwd), path.resolve(os.tmpdir()), `${args}: cwd is the OS temp folder`);
      assert.notEqual(path.resolve(cwd), path.resolve(removed));
    }
    rmSyncReal(removed);
  });

  test('abort (server stopping): every process is killed, the run ends at once, no cleanup run afterwards', async () => {
    const { env, cliLog } = envFor('2.9.1', ['initialize']); // initialize never answers: the run would wait 60 s
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 400);
    const r = await runOpenCodeContract({ bin: FAKE, env, signal: ac.signal, timeouts: { start: 60_000 } });
    assert.ok(Date.now() - t0 < 8000, `ended quickly (${Date.now() - t0} ms)`);
    assert.equal(r.aborted, true);
    assert.match(r.checks.find((c) => c.name === CHECKS.launch).detail, /dibatalkan/);
    assert.deepEqual(cliRuns(cliLog).map(([args]) => args), ['--version'], 'nothing started after the abort');

    // aborted before it began: no process at all
    const early = new AbortController();
    early.abort();
    const { env: env2, cliLog: log2 } = envFor('2.9.2');
    const r2 = await runOpenCodeContract({ bin: FAKE, env: env2, signal: early.signal });
    assert.equal(r2.aborted, true);
    assert.deepEqual(cliRuns(log2), []);
  });

  test('total bounds the CLI checks too; the session cleanup still gets a short minimum', async () => {
    const { env, cliLog } = envFor('2.9.3', ['commands']); // waits for the commands notification…
    const t0 = Date.now();
    const r = await runOpenCodeContract({ bin: FAKE, env, timeouts: { notify: 5000, total: 1500 } }); // …past total
    assert.ok(Date.now() - t0 < 12_000, `bounded (${Date.now() - t0} ms)`);
    const models = r.checks.find((c) => c.name === CHECKS.models);
    assert.equal(models.ok, false);
    assert.equal(models.detail, 'batas waktu total habis');
    const args = cliRuns(cliLog).map(([a]) => a.split(' ')[0]);
    assert.ok(!args.includes('models') && !args.includes('session'), args.join(','));
    assert.ok(args.includes('api'), 'session.remove still ran');
  });
});

describe('opencode-check-rules: staleRunReply (▶ run answer after its own finish events)', () => {
  test('ignored only when the current view already finished a newer check', () => {
    const reply = { running: true, lastCheckedAt: 100 };
    assert.equal(staleRunReply({ running: false, lastCheckedAt: 200 }, reply), true);
    assert.equal(staleRunReply({ running: true, lastCheckedAt: 100 }, reply), false, 'still running');
    assert.equal(staleRunReply({ running: false, lastCheckedAt: 100 }, reply), false, 'nothing newer yet');
    assert.equal(staleRunReply({ running: false, lastCheckedAt: 5 }, { running: true, lastCheckedAt: null }), true, 'first check ever');
    assert.equal(staleRunReply(null, reply), false);
    assert.equal(staleRunReply({ running: false, lastCheckedAt: 200 }, { running: false, lastCheckedAt: 100 }), false);
  });
});

describe('opencode-check service', () => {
  const service = ({ version, broken = [], file = fileFor('state.json'), opencode = FAKE, busy = () => false } = {}) => {
    const views = [];
    const logs = [];
    const svc = new OpenCodeCheckService({ file, opencode, env: envFor(version, broken).env, isBusy: busy, onChange: (v) => views.push(v), log: (l) => logs.push(l), contractTimeouts: { notify: 300 } });
    return { svc, views, logs, file };
  };

  test('a new version runs the light check; unchanged does not; ok records the new last-known-good', async () => {
    const { svc, views, logs, file } = service({ version: '2.5.0' });
    await svc.tick();
    let view = svc.publicView();
    assert.equal(view.available, true);
    assert.equal(view.version, '2.5.0');
    assert.equal(view.result, 'ok');
    assert.equal(view.checkedVersion, '2.5.0');
    assert.equal(view.lastGoodVersion, '2.5.0');
    assert.equal(view.usedModel, false);
    assert.deepEqual(view.settings, { autoCheck: true }, 'no model setting for OpenCode');
    assert.ok(views.some((v) => v.running) && !views.at(-1).running);
    assert.ok(logs.some((l) => /^Cek kontrak OpenCode v2\.5\.0 \(auto, tanpa token\): ok/.test(l)), logs.join('\n'));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).lastGoodVersion, '2.5.0');

    const at = view.lastCheckedAt;
    await svc.tick();
    assert.equal(svc.publicView().lastCheckedAt, at, 'same version → no new check');

    // OpenCode updated to a version that breaks something: a warning with the names, previousVersion for the banner
    const next = service({ version: '2.6.0', broken: ['mode'], file });
    await next.svc.tick();
    view = next.svc.publicView();
    assert.equal(view.result, 'warning');
    assert.equal(view.previousVersion, '2.5.0');
    assert.deepEqual(view.failing.sort(), [CHECKS.mode, CHECKS.setOption].sort());
    assert.equal(view.lastGoodVersion, '2.5.0', 'a warning is not last-known-good');
    assert.ok(next.logs.some((l) => l.startsWith(`  GAGAL ${CHECKS.mode}`)));
    const at2 = view.lastCheckedAt;
    await next.svc.tick();
    assert.equal(next.svc.publicView().lastCheckedAt, at2, 'the same broken version is not re-checked on every tick');
  });

  test('not installed: silent — start() schedules nothing, the view says available: false, a manual run is 503', () => {
    const { svc, logs } = service({ version: '1.0.0', opencode: null });
    svc.start();
    assert.equal(svc.timers.size, 0);
    assert.equal(svc.interval, undefined);
    assert.equal(svc.publicView().available, false);
    assert.deepEqual(svc.runManual(), { started: false, status: 503, error: 'OpenCode tidak ditemukan.' });
    svc.stop();
    assert.deepEqual(logs, []);
  });

  test('manual run: refused while a turn is busy; otherwise runs in the background (trigger manual)', async () => {
    let busy = true;
    const { svc, views } = service({ version: '2.7.0', busy: () => busy });
    assert.equal(svc.runManual().status, 409);
    busy = false;
    assert.deepEqual(svc.runManual(), { started: true });
    assert.equal(svc.runManual().status, 409, 'one at a time');
    const end = Date.now() + 20_000;
    while (svc.running && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.equal(svc.running, false);
    assert.equal(svc.publicView().trigger, 'manual');
    assert.equal(svc.publicView().result, 'ok');
    assert.ok(views.length >= 2);
  });

  test('stop() during a running check (server shutdown): processes killed, resolves ≤ 3 s, nothing recorded, no more ticks', async () => {
    const { svc, file, logs } = service({ version: '3.0.0', broken: ['initialize'] });
    svc.contractTimeouts = { start: 60_000 };
    assert.deepEqual(svc.runManual(), { started: true });
    await new Promise((r) => setTimeout(r, 500)); // the acp process is up, waiting for initialize
    assert.equal(svc.running, true);
    const t0 = Date.now();
    await svc.stop();
    assert.ok(Date.now() - t0 <= 3500, `stop bounded (${Date.now() - t0} ms)`);
    const end = Date.now() + 5000;
    while (svc.running && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.equal(svc.running, false);
    assert.equal(svc.publicView().result, null, 'an aborted check is not a result');
    assert.ok(!existsSync(file) || JSON.parse(readFileSync(file, 'utf8')).check === null);
    assert.ok(logs.some((l) => /dibatalkan \(server berhenti\)/.test(l)), logs.join('\n'));
    await svc.tick();
    assert.equal(svc.publicView().version, null, 'no tick after stop');
    assert.equal(svc.runManual().started, false, 'no run after stop');
  });

  test('the auto check off: a new version is recorded as skipped, without spawning the contract', async () => {
    const { svc } = service({ version: '2.8.0' });
    svc.updateSettings({ autoCheck: false });
    await svc.tick();
    assert.equal(svc.publicView().result, 'skipped');
    assert.equal(svc.publicView().checkedVersion, '2.8.0');
  });
});
