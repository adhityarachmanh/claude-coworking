// src/setup/service.js: the setup state machine without any real installer, network or CLI. Fake probes/installers
// exercise the contracts the server relies on: one job at a time, Node-before-npm, progress phases, cancel, a failed
// job's safe error view, refresh coalescing/throttling, and a public view without absolute paths.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { MIN_REFRESH_MS, SetupService } from '../src/setup/service.js';
import { runtimePaths } from '../src/setup/runtime.js';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'office-setup-service-'));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

let n = 0;
const tmpPath = (name) => path.join(TMP, `${name}-${n++}`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 4000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await delay(10);
  }
}

async function withEnv(values, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function emptyDir(name) {
  const dir = tmpPath(name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A portable runtime layout activeNode() accepts (the fake installers never download anything). */
function makeRuntime(runtimeDir, version = 'v24.11.0') {
  const paths = runtimePaths({ runtimeDir });
  const nodeDir = path.join(paths.nodeRoot, version);
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node'), 'node');
  mkdirSync(paths.npmPrefix, { recursive: true });
  writeFileSync(path.join(paths.nodeRoot, 'current.txt'), `${version}\n`);
  return { paths, nodeDir, version };
}

const toolItem = (id, patch = {}) => ({
  id,
  label: id,
  optional: id === 'opencode' || id === 'tailscale',
  state: 'missing',
  version: null,
  login: null,
  origin: null,
  ...patch,
});

/** A probe over mutable state; every call records its deep flag. */
function fakeProbe(state, calls = []) {
  const probe = ({ deep }) => {
    calls.push({ deep: Boolean(deep) });
    return [
      toolItem('node', state.node ? { state: 'ready', version: '24.11.0', origin: 'runtime' } : {}),
      toolItem('claude', state.claude ? { state: 'ready', version: '2.0.0', origin: 'runtime' } : {}),
      toolItem('opencode', state.opencode ? { state: 'ready', version: '1.0.0', origin: 'runtime' } : {}),
      toolItem('npm', state.node ? { state: 'ready', version: '10.9.2', origin: 'runtime' } : {}),
      toolItem('git', { state: 'ready', version: '2.45.1', origin: 'system' }),
    ];
  };
  probe.calls = calls;
  return probe;
}

/** Never a real CLI lookup: a PATH with only an empty folder, an empty home and no overrides. */
async function withoutSystemTools(fn) {
  const empty = emptyDir('path');
  const home = emptyDir('home');
  return withEnv(
    {
      PATH: empty,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_BIN: undefined,
      OPENCODE_BIN: undefined,
      OFFICE_RUNTIME_DIR: undefined,
      OFFICE_APP_DIR: undefined,
    },
    fn,
  );
}

function serviceFor(runtimeDir, { probe, installers = {}, ...rest } = {}) {
  return new SetupService({ runtimeDir, platform: 'win32', probe, installers, now: Date.now, ...rest });
}

// ---------- install ----------

test('install node: runs the node installer, reports its phases and refreshes deep when done', async () => {
  await withoutSystemTools(async () => {
    const runtimeDir = tmpPath('runtime');
    const state = { node: false };
    const probe = fakeProbe(state);
    const changes = [];
    const phases = [];
    let service;
    const installers = {
      node: async (options) => {
        assert.equal(options.runtimeDir, runtimeDir);
        options.onProgress({ stage: 'download', received: 50, total: 100 });
        phases.push(service.snapshot().job.percent);
        options.onProgress({ stage: 'download', received: 100, total: 100 });
        phases.push(service.snapshot().job.percent);
        options.onProgress({ stage: 'extract', entries: 1, totalEntries: 2 });
        phases.push(service.snapshot().job.percent);
        state.node = true;
        return { installed: true, version: '24.11.0', dir: path.join(runtimeDir, 'node', '24.11.0') };
      },
    };
    service = serviceFor(runtimeDir, { probe, installers, onChange: (view) => changes.push(view) });

    const result = service.install('node');
    assert.deepEqual(result, { started: true, status: 202 });
    assert.equal(service.snapshot().busy, true);
    assert.equal(service.snapshot().job.state, 'running');

    await waitFor(() => service.snapshot().job.state !== 'running');
    const done = service.snapshot();
    assert.equal(done.job.state, 'done');
    assert.equal(done.job.percent, 100);
    assert.equal(done.job.error, null);
    assert.equal(done.busy, false);
    assert.ok(phases.every((p) => Number.isFinite(p) && p >= 0 && p <= 100), JSON.stringify(phases));
    assert.ok(phases.some((p) => p > 0 && p < 100), `progress phases ${JSON.stringify(phases)}`);
    // The job refresh after a finished install is always deep, so the new binary is seen at once.
    await waitFor(() => probe.calls.some((call) => call.deep));
    assert.ok(changes.length >= 2, `${changes.length} onChange calls`);
    assert.equal(service.publicView().needsSetup, true, 'claude is still missing');
  });
});

test('install claude: installs Node first (0–40), then npm with the active Node (40–100)', async () => {
  await withoutSystemTools(async () => {
    const runtimeDir = tmpPath('runtime');
    const state = { node: false, claude: false };
    const probe = fakeProbe(state);
    const nodeCalls = [];
    const npmCalls = [];
    const nodePhases = [];
    const nodeDir = path.join(runtimeDir, 'node', 'v24.11.0');
    let service;
    const installers = {
      node: async (options) => {
        nodeCalls.push(options);
        options.onProgress({ stage: 'download', received: 1, total: 4 });
        nodePhases.push(service.snapshot().job.percent);
        options.onProgress({ stage: 'download', received: 4, total: 4 });
        nodePhases.push(service.snapshot().job.percent);
        options.onProgress({ stage: 'extract', entries: 1, totalEntries: 1 });
        nodePhases.push(service.snapshot().job.percent);
        state.node = true;
        return { installed: true, version: 'v24.11.0', dir: nodeDir };
      },
      npm: async (options) => {
        npmCalls.push({ ...options, percentAtStart: service.snapshot().job.percent });
        options.onLine?.('added 1 package');
        state.claude = true;
        return { prefix: options.runtime.npmPrefix, lines: [] };
      },
    };
    service = serviceFor(runtimeDir, { probe, installers });

    assert.deepEqual(service.install('claude'), { started: true, status: 202 });
    await waitFor(() => service.snapshot().job.state !== 'running');

    assert.equal(service.snapshot().job.state, 'done');
    assert.equal(nodeCalls.length, 1);
    assert.equal(npmCalls.length, 1);
    assert.ok(nodePhases.every((p) => p >= 0 && p <= 40), JSON.stringify(nodePhases));
    assert.equal(npmCalls[0].percentAtStart, 40);
    assert.equal(npmCalls[0].runtime.node, nodeDir, 'npm runs through the Node it just installed');
    assert.equal(npmCalls[0].spec, '@anthropic-ai/claude-code');
    assert.equal(service.publicView().needsSetup, false);
    assert.equal(service.publicView().items.find((i) => i.id === 'claude').state, 'ready');
  });
});

test('install: an already usable target returns { already: true } without starting a job', async () => {
  const runtimeDir = tmpPath('runtime');
  makeRuntime(runtimeDir);
  const probe = fakeProbe({ node: true });
  const service = serviceFor(runtimeDir, { probe });
  assert.deepEqual(service.install('node'), { already: true });
  assert.equal(service.snapshot().busy, false);
  assert.equal(service.snapshot().job, null);

  // A probe can see a tool this process cannot: a ready item is enough to skip the install.
  const cached = serviceFor(tmpPath('runtime'), { probe: fakeProbe({ node: true }) });
  cached.refresh({ deep: true });
  await waitFor(() => !cached.snapshot().probing);
  assert.deepEqual(cached.install('node'), { already: true });

  const env = { CLAUDE_BIN: 'fake-claude', OPENCODE_BIN: 'fake-opencode' };
  await withEnv(env, async () => {
    const other = serviceFor(tmpPath('runtime'), { probe });
    assert.deepEqual(other.install('claude'), { already: true });
    assert.deepEqual(other.install('opencode'), { already: true });
  });
});

test('install: refuses a second job and a busy office with 409; unknown targets are 400', async () => {
  await withoutSystemTools(async () => {
    const runtimeDir = tmpPath('runtime');
    const { nodeDir } = makeRuntime(runtimeDir);
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const installers = {
      npm: async () => {
        await gate;
        return { prefix: 'x', lines: [] };
      },
    };
    const service = serviceFor(runtimeDir, { probe: fakeProbe({ node: true }), installers });
    assert.deepEqual(service.install('claude'), { started: true, status: 202 });
    const second = service.install('opencode');
    assert.equal(second.started, false);
    assert.equal(second.status, 409);
    release();
    await waitFor(() => service.snapshot().job.state !== 'running');
    assert.equal(service.snapshot().job.state, 'done');

    const busy = serviceFor(runtimeDir, { probe: fakeProbe({ node: true }), isBusy: () => true });
    const refused = busy.install('claude');
    assert.equal(refused.started, false);
    assert.equal(refused.status, 409);

    const invalid = service.install('nope');
    assert.equal(invalid.started, false);
    assert.equal(invalid.status, 400);
    assert.ok(!service.snapshot().job.error?.includes(nodeDir)); // no incidental path in a refusal view
  });
});

test('install: a failed installer leaves a failed job with a safe code/hint and no path or stack', async () => {
  await withoutSystemTools(async () => {
    const runtimeDir = tmpPath('runtime');
    makeRuntime(runtimeDir);
    const secret = path.join(TMP, 'secret-cache');
    const installers = {
      npm: async () => {
        throw Object.assign(new Error(`npm install gagal: ${secret}\\cache\\log.txt`), {
          code: 'NPM_FAILED',
          hint: `Periksa koneksi internet.\n    at Object.<anonymous> (${secret}\\x.js:1:1)\n${secret}`,
        });
      },
    };
    const changes = [];
    const service = serviceFor(runtimeDir, { probe: fakeProbe({ node: true }), installers, onChange: (view) => changes.push(view) });
    assert.deepEqual(service.install('claude'), { started: true, status: 202 });
    await waitFor(() => service.snapshot().job.state !== 'running');

    const view = service.publicView();
    assert.equal(view.job.state, 'failed');
    assert.equal(view.job.code, 'NPM_FAILED');
    assert.equal(view.busy, false);
    assert.ok(view.job.error.includes('gagal'));
    assert.doesNotMatch(view.job.error, /secret-cache|[A-Za-z]:[\\/]/);
    assert.ok(view.job.hint.includes('Periksa koneksi'));
    assert.doesNotMatch(view.job.hint, /secret-cache|[A-Za-z]:[\\/]|^\s*at\s/m);
    assert.ok(changes.some((change) => change.job?.state === 'failed'));
  });
});

test('cancel: aborts a running npm install; no job (or Tailscale) is 409', async () => {
  await withoutSystemTools(async () => {
    const runtimeDir = tmpPath('runtime');
    makeRuntime(runtimeDir);
    let started;
    const npmStarted = new Promise((resolve) => (started = resolve));
    const installers = {
      npm: (options) =>
        new Promise((resolve, reject) => {
          started();
          options.signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('dibatalkan'), { code: 'CANCELLED' })),
            { once: true },
          );
        }),
    };
    const service = serviceFor(runtimeDir, { probe: fakeProbe({ node: true }), installers });
    assert.deepEqual(service.cancel(), { cancelled: false, status: 409, error: 'Tidak ada instalasi yang sedang berjalan.' });
    service.install('claude');
    await npmStarted;
    assert.deepEqual(service.cancel(), { cancelled: true });
    await waitFor(() => service.snapshot().job.state !== 'running');
    assert.equal(service.snapshot().job.state, 'cancelled');
    assert.equal(service.snapshot().job.code, 'CANCELLED');
    assert.equal(service.snapshot().busy, false);

    // Tailscale is deliberately not cancellable, even while its job is marked running.
    service.busy = true;
    service.job = { target: 'tailscale', state: 'running', step: 'memasang', percent: 10, startedAt: 1, finishedAt: null, error: null, code: null, hint: null };
    service.controller = new AbortController();
    const tailscale = service.cancel();
    assert.equal(tailscale.cancelled, false);
    assert.equal(tailscale.status, 409);
    service.busy = false;
    service.job = null;
    service.controller = null;
  });
});

test('stop: aborts the running install, waits for it and refuses new work', async () => {
  await withoutSystemTools(async () => {
    const runtimeDir = tmpPath('runtime');
    makeRuntime(runtimeDir);
    let started;
    const npmStarted = new Promise((resolve) => (started = resolve));
    const installers = {
      npm: (options) =>
        new Promise((resolve, reject) => {
          started();
          options.signal.addEventListener('abort', () => reject(Object.assign(new Error('stop'), { code: 'CANCELLED' })), { once: true });
        }),
    };
    const service = serviceFor(runtimeDir, { probe: fakeProbe({ node: true }), installers });
    service.install('claude');
    await npmStarted;
    await service.stop();
    assert.equal(service.snapshot().job.state, 'cancelled');
    assert.equal(service.snapshot().busy, false);
    assert.equal(service.install('claude').status, 409);
  });
});

// ---------- refresh ----------

test('refresh: coalesces overlapping probes, throttles normal ones and queues a deep request', async () => {
  const runtimeDir = tmpPath('runtime');
  const calls = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const probe = async ({ deep }) => {
    calls.push(Boolean(deep));
    if (calls.length === 1) await gate;
    return [toolItem('node', { state: 'ready', version: '24.11.0', origin: 'system' })];
  };
  let now = 1000;
  const changes = [];
  const service = new SetupService({ runtimeDir, platform: 'win32', probe, now: () => now, onChange: (view) => changes.push(view) });

  assert.deepEqual(service.refresh(), { started: true });
  assert.equal(service.snapshot().probing, true);
  assert.deepEqual(service.refresh(), { started: false });
  assert.deepEqual(service.refresh({ deep: true }), { started: false });
  assert.deepEqual(service.refresh({ deep: true }), { started: false }, 'many deep requests queue only one follow-up');
  release();
  await waitFor(() => calls.length === 2 && !service.snapshot().probing);
  assert.deepEqual(calls, [false, true], 'the queued deep probe runs right after the running one');
  assert.equal(changes.length, 2);

  // Within the window a normal refresh does nothing; deep is explicit and always allowed.
  now += MIN_REFRESH_MS - 1;
  assert.deepEqual(service.refresh(), { started: false });
  now += 1;
  assert.deepEqual(service.refresh(), { started: true });
  await waitFor(() => calls.length === 3 && !service.snapshot().probing);
  assert.deepEqual(service.refresh({ deep: true }), { started: true });
  await waitFor(() => calls.length === 4 && !service.snapshot().probing);
  assert.deepEqual(calls, [false, true, false, true]);
});

test('refresh: a failing probe keeps the last view, clears probing and still notifies', async () => {
  const runtimeDir = tmpPath('runtime');
  let fail = false;
  const probe = () => {
    if (fail) throw new Error('probe rusak');
    return [toolItem('node', { state: 'ready', version: '24.11.0', origin: 'system' })];
  };
  const logs = [];
  const changes = [];
  const service = new SetupService({ runtimeDir, platform: 'win32', probe, onChange: (view) => changes.push(view), log: (line) => logs.push(line) });
  service.refresh({ deep: true });
  await waitFor(() => !service.snapshot().probing);
  assert.equal(service.snapshot().items.length, 1);
  fail = true;
  service.refresh({ deep: true });
  await waitFor(() => !service.snapshot().probing);
  assert.equal(service.snapshot().items.length, 1, 'the last successful probe is kept');
  assert.ok(logs.some((line) => line.includes('gagal memeriksa')));
  assert.equal(changes.length, 2);
});

// ---------- public view ----------

test('publicView: cleaned items, needsSetup/firstRun, and no absolute path even from a stray probe field', async () => {
  const runtimeDir = tmpPath('runtime');
  const home = os.homedir();
  const probe = () => [
    toolItem('node', { state: 'ready', version: '24.11.0', origin: 'runtime', dir: path.join(TMP, 'secret-node') }),
    toolItem('claude', { state: 'ready', version: `2.0.0 ${path.join(TMP, 'secret-claude')}`, origin: 'runtime', command: path.join(TMP, 'secret-cmd.exe') }),
    toolItem('git', { state: 'ready', origin: 'system' }),
  ];
  const service = new SetupService({ runtimeDir, platform: 'win32', probe });
  service.refresh({ deep: true });
  await waitFor(() => !service.snapshot().probing);
  const view = service.publicView();
  const text = JSON.stringify(view);
  assert.ok(!text.includes('secret'), text);
  assert.ok(!text.includes(TMP), text);
  assert.ok(!text.includes(home), text);
  assert.equal(view.needsSetup, false);
  assert.equal(view.firstRun, false);
  assert.deepEqual(Object.keys(view.items[0]).sort(), ['id', 'label', 'login', 'optional', 'origin', 'state', 'version']);

  const missing = new SetupService({ runtimeDir, platform: 'win32', probe: () => [toolItem('node', { state: 'ready' }), toolItem('claude')] });
  missing.refresh({ deep: true });
  await waitFor(() => !missing.snapshot().probing);
  assert.equal(missing.publicView().needsSetup, true);
  assert.equal(missing.publicView().firstRun, false, 'node is ready even though Claude Code is missing');

  const empty = new SetupService({ runtimeDir, platform: 'win32', probe: () => [toolItem('node'), toolItem('claude')] });
  empty.refresh({ deep: true });
  await waitFor(() => !empty.snapshot().probing);
  assert.equal(empty.publicView().needsSetup, true);
  assert.equal(empty.publicView().firstRun, true);
  assert.equal(empty.snapshot().supported, true);
});

// ---------- PATH and login ----------

test('applyRuntimePath: prepends npm prefix + Node folder, keeps the host PATH and removes duplicates', () => {
  const runtimeDir = tmpPath('runtime');
  const { paths, nodeDir } = makeRuntime(runtimeDir);
  const host = tmpPath('host-bin');
  const other = tmpPath('other-bin');
  const env = { PATH: [host, paths.npmPrefix, other, nodeDir].join(path.delimiter) };
  const service = new SetupService({ runtimeDir, platform: 'win32', probe: () => [] });
  const added = service.applyRuntimePath(env);
  assert.deepEqual(added, [paths.npmPrefix, nodeDir]);
  assert.deepEqual(env.PATH.split(path.delimiter), [paths.npmPrefix, nodeDir, host, other]);
  // Idempotent: a second call does not duplicate anything.
  service.applyRuntimePath(env);
  assert.deepEqual(env.PATH.split(path.delimiter), [paths.npmPrefix, nodeDir, host, other]);
});

test('openLoginTerminal: only Claude/OpenCode, only when installed, with activeNode on the launcher PATH', async () => {
  await withoutSystemTools(async () => {
    const runtimeDir = tmpPath('runtime');
    const { paths, nodeDir } = makeRuntime(runtimeDir);
    const calls = [];
    const loginTerminal = (options) => {
      calls.push(options);
      return { ok: true };
    };
    const service = serviceFor(runtimeDir, { probe: fakeProbe({}), loginTerminal });
    assert.equal(service.openLoginTerminal('claude').code, 'NOT_INSTALLED');
    assert.equal(service.openLoginTerminal('node').code, 'BAD_TARGET');

    await withEnv({ CLAUDE_BIN: 'fake-claude' }, async () => {
      assert.deepEqual(service.openLoginTerminal('claude'), { ok: true });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].target, 'claude');
      assert.equal(calls[0].runtime.npmPrefix, paths.npmPrefix);
      assert.equal(calls[0].runtime.nodeDir, nodeDir, 'the active Node version folder is on PATH');
    });

    const busy = serviceFor(runtimeDir, { probe: fakeProbe({}), loginTerminal, isBusy: () => true });
    assert.equal(busy.openLoginTerminal('claude').code, 'BUSY');

    const unsupported = new SetupService({ runtimeDir, platform: 'linux', probe: () => [], loginTerminal });
    assert.equal(unsupported.openLoginTerminal('claude').code, 'UNSUPPORTED');
    assert.equal(unsupported.install('node').status, 501);

    const refused = serviceFor(runtimeDir, { probe: fakeProbe({}), loginTerminal: () => ({ ok: false, code: 'SPAWN_FAILED' }) });
    await withEnv({ CLAUDE_BIN: 'fake-claude' }, async () => {
      assert.deepEqual(refused.openLoginTerminal('claude'), { ok: false, code: 'SPAWN_FAILED' });
    });
  });
});
