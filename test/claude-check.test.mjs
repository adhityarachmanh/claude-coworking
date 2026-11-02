// Claude Code update detector: the shared contract module (src/claude-contract.js) against the fake CLI
// (test-support/fake-claude.mjs, which can claim a version and "break" parts of the protocol), and the background
// service (src/claude-check.js): version change → light check, unchanged → nothing, failing names surface,
// a busy office defers, every wait is bounded, the setting off → skipped. No real Claude Code, no tokens.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHECKS, classify, parseVersion, readClaudeVersion, runContract, sanitize } from '../src/claude-contract.js';
import { ClaudeCheckService } from '../src/claude-check.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = { command: process.execPath, args: [path.join(APP, 'test-support', 'fake-claude.mjs')] };
const TMP = mkdtempSync(path.join(os.tmpdir(), 'office-claude-check-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envFor = (version, broken = []) => ({ ...process.env, FAKE_CLAUDE_VERSION: version, FAKE_CLAUDE_BREAK: broken.join(','), CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects') });
let n = 0;
const fileFor = () => path.join(TMP, `check-${++n}.json`);

after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('claude-contract: helpers', () => {
  test('parseVersion: Claude Code output only', () => {
    assert.equal(parseVersion('2.1.316 (Claude Code)\n'), '2.1.316');
    assert.equal(parseVersion('9.9.9-fake (Claude Code)'), '9.9.9-fake');
    assert.equal(parseVersion('something else 1.0'), null);
    assert.equal(parseVersion('v20.1.0'), null, 'node --version is not Claude Code');
    assert.equal(parseVersion(''), null);
  });

  test('sanitize: no home path, e-mail, tokens or control characters; bounded', () => {
    const home = os.homedir();
    const out = sanitize(`gagal di ${home}${path.sep}x.json untuk a.b@example.com sk-ant-api03-abcdefghijk token=xyz Bearer abc \x1b[31m ${'A'.repeat(60)}`);
    assert.ok(!out.includes(home), out);
    assert.doesNotMatch(out, /example\.com|sk-ant|xyz|abc|\x1b|AAAAAAAAAA/);
    assert.match(out, /~/);
    assert.ok(sanitize('x'.repeat(500)).length <= 200);
  });

  test('classify: ok / warning (non-critical only) / failed (critical)', () => {
    assert.equal(classify([{ name: CHECKS.launch, ok: true }]), 'ok');
    assert.equal(classify([{ name: CHECKS.launch, ok: true }, { name: CHECKS.agents, ok: false }]), 'warning');
    assert.equal(classify([{ name: CHECKS.launch, ok: false }]), 'failed');
    assert.equal(classify([{ name: CHECKS.version, ok: false }]), 'failed');
  });
});

describe('claude-contract: light profile against the fake CLI', () => {
  test('everything passes; with the one Haiku turn the init/stream/result checks run too', async () => {
    const tokenFree = await runContract({ claude: FAKE, allowModel: false, env: envFor('2.0.0') });
    assert.equal(tokenFree.result, 'ok', JSON.stringify(tokenFree.checks));
    assert.equal(tokenFree.version, '2.0.0');
    assert.equal(tokenFree.usedModel, false);
    assert.deepEqual(tokenFree.checks.map((c) => c.name), [CHECKS.version, CHECKS.launch, CHECKS.catalog, CHECKS.agents, CHECKS.versionMatch, CHECKS.mode, CHECKS.model, CHECKS.context]);

    const withModel = await runContract({ claude: FAKE, allowModel: true, env: envFor('2.0.0') });
    assert.equal(withModel.result, 'ok', JSON.stringify(withModel.checks));
    assert.equal(withModel.usedModel, true);
    for (const name of [CHECKS.init, CHECKS.initAgents, CHECKS.delta, CHECKS.assistant, CHECKS.result]) assert.ok(withModel.checks.some((c) => c.name === name && c.ok), name);
  });

  test('broken parts surface by name: non-critical → warning, critical → failed', async () => {
    const r = await runContract({ claude: FAKE, allowModel: true, env: envFor('2.0.1', ['agents', 'set_model', 'init']) });
    assert.equal(r.result, 'warning');
    assert.deepEqual(r.failing, [CHECKS.agents, CHECKS.model, CHECKS.init]);

    const catalog = await runContract({ claude: FAKE, allowModel: false, env: envFor('2.0.1', ['catalog']) });
    assert.equal(catalog.result, 'failed');
    assert.deepEqual(catalog.failing, [CHECKS.catalog]);

    const exit = await runContract({ claude: FAKE, allowModel: true, env: envFor('2.0.1', ['exit']) });
    assert.equal(exit.result, 'failed');
    assert.deepEqual(exit.failing, [CHECKS.launch], 'nothing after a launch that failed');
    assert.match(exit.checks.find((c) => !c.ok).detail, /proses keluar \(kode 1\).*unknown option/);
    assert.equal(exit.usedModel, false);

    const version = await runContract({ claude: FAKE, env: envFor('2.0.1', ['version']) });
    assert.equal(version.result, 'failed');
    assert.equal(version.version, null);
    assert.deepEqual(version.failing, [CHECKS.version]);
  });

  test('no Claude Code: one failed check, no spawn', async () => {
    const r = await runContract({ claude: null });
    assert.equal(r.result, 'failed');
    assert.deepEqual(r.failing, [CHECKS.version]);
  });

  test('timeouts are bounded: a CLI that never answers initialize, a --version that hangs', async () => {
    let t0 = Date.now();
    const hang = await runContract({ claude: FAKE, env: envFor('2.0.2', ['hang']), timeouts: { start: 1000, exit: 500 } });
    assert.ok(Date.now() - t0 < 8000, `${Date.now() - t0} ms`);
    assert.equal(hang.result, 'failed');
    assert.deepEqual(hang.failing, [CHECKS.launch]);
    assert.match(hang.checks.find((c) => !c.ok).detail, /timeout/);

    t0 = Date.now();
    const v = await readClaudeVersion(FAKE, { timeoutMs: 800, env: envFor('2.0.2', ['version-hang']) });
    assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
    assert.equal(v.version, null);
    assert.match(v.error, /timeout/);

    t0 = Date.now();
    const total = await runContract({ claude: FAKE, env: envFor('2.0.2', ['hang']), timeouts: { start: 60_000, total: 1200, exit: 500 } });
    assert.ok(Date.now() - t0 < 8000, `the total deadline wins over a long step: ${Date.now() - t0} ms`);
    assert.equal(total.result, 'failed');
  });
});

/** A service on the fake CLI; runContract is the real one, counted. */
function service({ version = '2.0.0', broken = [], file = fileFor(), seed = null, isBusy = () => false, timing = {}, ...rest } = {}) {
  if (seed) writeFileSync(file, JSON.stringify(seed));
  const calls = [];
  const logs = [];
  const views = [];
  const env = envFor(version, broken);
  const svc = new ClaudeCheckService({
    file,
    claude: FAKE,
    env,
    isBusy,
    log: (line) => logs.push(line),
    onChange: (v) => views.push(v),
    runContract: async (opts) => {
      calls.push(opts);
      return runContract(opts);
    },
    timing: { idlePollMs: 20, idleWaitMs: 200, retryMs: 60_000, ...timing },
    ...rest,
  });
  return { svc, calls, logs, views, file, setVersion: (v, b = []) => (svc.env = envFor(v, b)) };
}

describe('claude-check service', () => {
  test('version change triggers the light check; unchanged does not; ok records the new last-known-good', async () => {
    const { svc, calls, file, views } = service({ version: '2.0.0', seed: { version: '1.0.0', lastGoodVersion: '1.0.0', check: { version: '1.0.0', at: 1, result: 'ok', failing: [] } } });
    await svc.tick();
    assert.equal(calls.length, 1, 'new version → one check');
    assert.equal(calls[0].profile, 'light');
    assert.equal(calls[0].allowModel, true);
    const view = svc.publicView();
    assert.equal(view.version, '2.0.0');
    assert.equal(view.result, 'ok');
    assert.equal(view.checkedVersion, '2.0.0');
    assert.equal(view.previousVersion, '1.0.0', 'the banner can say "diperbarui ke"');
    assert.equal(view.lastGoodVersion, '2.0.0');
    assert.equal(view.trigger, 'auto');
    assert.equal(view.usedModel, true);
    assert.ok(view.lastCheckedAt > 0);
    assert.ok(views.some((v) => v.running) && !views.at(-1).running, 'running is announced, then cleared');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.lastGoodVersion, '2.0.0');
    assert.equal(saved.check.result, 'ok');

    await svc.tick();
    assert.equal(calls.length, 1, 'same version → no new check');
    // a fresh start with the same file: still nothing to do
    const again = service({ version: '2.0.0', file });
    await again.svc.tick();
    assert.equal(again.calls.length, 0);
  });

  test('first start without a file checks once (baseline), without a "diperbarui" previous version', async () => {
    const { svc, calls } = service({ version: '3.0.0' });
    await svc.tick();
    assert.equal(calls.length, 1);
    assert.equal(svc.publicView().previousVersion, null);
  });

  test('failures surface the right names; the same broken version is not re-checked on every tick', async () => {
    const { svc, calls, logs } = service({ version: '2.1.0', broken: ['agents', 'context'], seed: { lastGoodVersion: '2.0.0' } });
    await svc.tick();
    const view = svc.publicView();
    assert.equal(view.result, 'warning');
    assert.deepEqual(view.failing, [CHECKS.agents, CHECKS.context]);
    assert.equal(view.lastGoodVersion, '2.0.0', 'a failed check never becomes last-known-good');
    assert.ok(logs.some((l) => /GAGAL initialize: --agents/.test(l)), logs.join('\n'));
    await svc.tick();
    assert.equal(calls.length, 1);
    // the view carries names only: no details
    assert.ok(!JSON.stringify(view).includes('tidak ada daftar agents'));
  });

  test('a busy office defers the check (bounded wait), and it runs once idle', async () => {
    let busy = true;
    const { svc, calls, logs } = service({ version: '4.0.0', isBusy: () => busy, timing: { idlePollMs: 20, idleWaitMs: 150, retryMs: 100 } });
    const t0 = Date.now();
    await svc.tick();
    assert.ok(Date.now() - t0 < 2000, 'the wait for idle is bounded');
    assert.equal(calls.length, 0, 'never runs while a turn is busy');
    assert.ok(logs.some((l) => /ditunda/.test(l)));
    assert.equal(svc.publicView().waiting, false);
    // still busy at the retry: deferred again; idle at the next one: runs
    busy = false;
    for (let i = 0; i < 100 && !calls.length; i++) await sleep(20);
    await svc.ticking;
    assert.equal(calls.length, 1, 'retried after RETRY_MS and ran');
    svc.stop();

    // idle part-way through the wait: runs in the same tick
    let polls = 0;
    const late = service({ version: '4.1.0', isBusy: () => polls++ < 3, timing: { idlePollMs: 20, idleWaitMs: 5000 } });
    await late.svc.tick();
    assert.equal(late.calls.length, 1);
  });

  test('the auto check off: a new version is recorded as skipped (no spawn of the contract); on again → it runs', async () => {
    const { svc, calls, views } = service({ version: '5.0.0', seed: { settings: { autoCheck: false, allowModel: true }, lastGoodVersion: '4.0.0' } });
    await svc.tick();
    assert.equal(calls.length, 0);
    const view = svc.publicView();
    assert.equal(view.result, 'skipped');
    assert.equal(view.checkedVersion, '5.0.0');
    assert.equal(view.reason, 'Cek otomatis dimatikan');
    await svc.tick();
    assert.equal(calls.length, 0);
    svc.updateSettings({ autoCheck: true }); // looks again at once (background)
    for (let i = 0; i < 100 && !(calls.length && !svc.running); i++) await sleep(20);
    await svc.ticking;
    assert.equal(calls.length, 1);
    assert.equal(svc.publicView().result, 'ok');
    assert.ok(views.length >= 3);
  });

  test('"Boleh pakai 1 request kecil" off: the light check makes no model call', async () => {
    const { svc, calls } = service({ version: '6.0.0', seed: { settings: { autoCheck: true, allowModel: false } } });
    await svc.tick();
    assert.equal(calls[0].allowModel, false);
    assert.equal(svc.publicView().usedModel, false);
    assert.equal(svc.publicView().result, 'ok');
  });

  test('manual run: refused while busy / running / without Claude Code; otherwise runs in the background', async () => {
    let busy = true;
    const { svc, calls } = service({ version: '7.0.0', isBusy: () => busy });
    assert.deepEqual(svc.runManual(), { started: false, status: 409, error: 'Ada giliran yang sedang berjalan — coba lagi setelah selesai.' });
    busy = false;
    assert.deepEqual(svc.runManual(), { started: true });
    assert.equal(svc.publicView().running, true);
    assert.equal(svc.runManual().status, 409, 'one at a time');
    for (let i = 0; i < 200 && svc.running; i++) await sleep(20);
    assert.equal(calls.length, 1);
    assert.equal(svc.publicView().trigger, 'manual');
    const none = new ClaudeCheckService({ file: fileFor(), claude: null, log: () => {} });
    assert.equal(none.runManual().status, 503);
    assert.equal(none.publicView().available, false);
  });

  test('a contract that throws is recorded as failed; log lines are sanitised', async () => {
    const logs = [];
    const svc = new ClaudeCheckService({
      file: fileFor(),
      claude: FAKE,
      env: envFor('8.0.0'),
      log: (l) => logs.push(l),
      runContract: async () => ({ version: '8.0.0', result: 'warning', failing: ['x'], checks: [{ name: 'x', ok: false, detail: `${os.homedir()}/a dari me@example.com` }], usedModel: false, durationMs: 1 }),
    });
    await svc.tick();
    assert.ok(logs.every((l) => !l.includes(os.homedir()) && !l.includes('me@example.com')), logs.join('\n'));
    const boom = new ClaudeCheckService({ file: fileFor(), claude: FAKE, env: envFor('8.1.0'), log: () => {}, runContract: async () => { throw new Error('kaboom'); } });
    await boom.tick();
    assert.equal(boom.publicView().result, 'failed');
    assert.deepEqual(boom.publicView().failing, ['cek tidak selesai']);
  });

  test('a corrupt or hand-edited file is ignored / cleaned', async () => {
    const file = fileFor();
    writeFileSync(file, '{not json');
    const a = new ClaudeCheckService({ file, claude: FAKE, log: () => {} });
    assert.deepEqual(a.publicView().settings, { autoCheck: true, allowModel: true });
    writeFileSync(file, JSON.stringify({ version: '<script>', lastGoodVersion: 5, check: { result: 'ok', version: '1.0.0', failing: ['a', 7, 'b'], at: 'x' }, settings: { autoCheck: 'yes' } }));
    const b = new ClaudeCheckService({ file, claude: FAKE, log: () => {} });
    const v = b.publicView();
    assert.equal(v.version, null);
    assert.equal(v.lastGoodVersion, null);
    assert.deepEqual(v.failing, ['a', 'b']);
    assert.equal(v.lastCheckedAt, 0);
    assert.equal(v.settings.autoCheck, true);
  });

  test('a --version that hangs: the tick ends (bounded), nothing is checked', async () => {
    const { svc, calls, logs } = service({ version: '9.0.0', broken: ['version-hang'], readVersion: (claude, opts) => readClaudeVersion(claude, { ...opts, timeoutMs: 800 }) });
    const t0 = Date.now();
    await svc.tick();
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(calls.length, 0);
    assert.ok(logs.some((l) => /versi tidak terbaca \(timeout/.test(l)), logs.join('\n'));
  });
});
