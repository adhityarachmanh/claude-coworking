// src/setup/detect.js: one stable, throw-free view of the tools setup can install or use, plus the redacted view
// the UI is allowed to see (no absolute paths, no stack traces).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { cleanToolView, probeTools } from '../src/setup/detect.js';
import { runtimePaths, saveRuntimeState } from '../src/setup/runtime.js';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'office-detect-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const tmpPath = (name) => path.join(TMP, `${name}-${n++}`);

function withEnv(values, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeRuntime({ nodeVersion = 'v24.11.0', npmVersion = '10.9.2' } = {}) {
  const runtimeDir = tmpPath('runtime');
  const paths = runtimePaths({ runtimeDir });
  const nodeDir = path.join(paths.nodeRoot, nodeVersion);
  mkdirSync(path.join(nodeDir, 'node_modules', 'npm', 'bin'), { recursive: true });
  writeFileSync(path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node'), 'node');
  writeFileSync(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '// npm');
  writeFileSync(path.join(paths.nodeRoot, 'current.txt'), `${nodeVersion}\n`);
  return { runtimeDir, paths, nodeDir, nodeVersion, npmVersion };
}

const tool = (items, id) => items.find((item) => item.id === id);

test('probeTools: runtime node/npm first, then system tools; stable order and shape', () => {
  const rt = makeRuntime();
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    const text = String(command);
    if (text.endsWith('node.exe') || text.endsWith(`${path.sep}node`)) return `${rt.npmVersion}\n`;
    if (command === 'fake-claude') return '2.9.1 (Claude Code)\n';
    if (command === 'fake-opencode' && args[0] === '--version') return '1.2.3\n';
    if (command === 'git') return 'git version 2.45.1.windows.1\n';
    if (command === 'winget') return 'v1.9.1\n';
    if (command === 'which' || command === 'where') throw Object.assign(new Error('tidak ada'), { code: 'ENOENT' });
    throw Object.assign(new Error(`perintah tak terduga: ${command} ${args.join(' ')}`), { code: 'ENOENT' });
  };

  const items = withEnv({ CLAUDE_BIN: 'fake-claude', OPENCODE_BIN: 'fake-opencode' }, () =>
    probeTools({
      runtimeDir: rt.runtimeDir,
      platform: 'win32',
      run,
      account: { current: { id: 'u1', email: 'ani@example.com', org: null } },
    }),
  );

  assert.deepEqual(
    items.map((item) => item.id),
    ['node', 'npm', 'claude', 'opencode', 'git', 'tailscale', 'winget'],
  );
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'label', 'login', 'optional', 'origin', 'state', 'version']);
    assert.ok(['ready', 'missing', 'unknown'].includes(item.state));
    assert.ok(['runtime', 'system', null].includes(item.origin));
  }

  assert.deepEqual(
    { state: tool(items, 'node').state, version: tool(items, 'node').version, origin: tool(items, 'node').origin },
    { state: 'ready', version: '24.11.0', origin: 'runtime' },
  );
  assert.deepEqual(
    { state: tool(items, 'npm').state, version: tool(items, 'npm').version, origin: tool(items, 'npm').origin },
    { state: 'ready', version: '10.9.2', origin: 'runtime' },
  );
  assert.equal(tool(items, 'claude').state, 'ready');
  assert.equal(tool(items, 'claude').version, '2.9.1');
  assert.equal(tool(items, 'claude').login, true);
  assert.equal(tool(items, 'opencode').state, 'ready');
  assert.equal(tool(items, 'opencode').version, '1.2.3');
  assert.equal(tool(items, 'opencode').login, null, 'no auth spawn unless deep');
  assert.equal(tool(items, 'git').version, '2.45.1.windows.1');
  assert.equal(tool(items, 'winget').version, '1.9.1');
  assert.ok(calls.some((call) => call[0] === path.join(rt.nodeDir, process.platform === 'win32' ? 'node.exe' : 'node') && call.some((part) => String(part).endsWith('npm-cli.js'))));
});

test('probeTools: runtime.json alone (no current.txt) still marks Node as the runtime', () => {
  const runtimeDir = tmpPath('state-runtime');
  const paths = runtimePaths({ runtimeDir });
  const version = 'v24.10.0';
  const nodeDir = path.join(paths.nodeRoot, version);
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node'), 'node');
  saveRuntimeState(runtimeDir, { node: { version } });
  const items = probeTools({
    runtimeDir,
    platform: process.platform,
    run: () => {
      throw Object.assign(new Error('tidak ada'), { code: 'ENOENT' });
    },
  });
  assert.equal(tool(items, 'node').state, 'ready');
  assert.equal(tool(items, 'node').version, '24.10.0');
  assert.equal(tool(items, 'node').origin, 'runtime');
});

test('probeTools: every probe timing out still returns a complete list and never throws', () => {
  const timeout = () => {
    throw Object.assign(new Error('waktu habis'), { code: 'ETIMEDOUT', killed: true });
  };
  const items = withEnv({ CLAUDE_BIN: 'fake-claude', OPENCODE_BIN: 'fake-opencode' }, () =>
    probeTools({ platform: 'linux', run: timeout, account: { current: null } }),
  );
  assert.equal(items.length, 7);
  for (const item of items) assert.ok(['unknown', 'missing'].includes(item.state), `${item.id}: ${item.state}`);
  assert.equal(tool(items, 'claude').login, false, 'account present but not logged in');
});

test('probeTools: odd version text is cleaned, not thrown, and deep OpenCode login is opt-in', () => {
  const run = (command, args) => {
    if (command === 'node') return 'node v24.x\n';
    if (command === 'npm') return 'npm 10.9\n';
    if (command === 'fake-opencode' && args[0] === '--version') return 'opencode v1.2.3-beta.1\n';
    if (command === 'fake-opencode' && args[0] === 'auth') return '0 credentials\n';
    if (command === 'git') return 'bukan versi\n';
    throw Object.assign(new Error('tidak ada'), { code: 'ENOENT' });
  };
  const items = withEnv({ CLAUDE_BIN: '', OPENCODE_BIN: 'fake-opencode' }, () =>
    probeTools({ platform: 'linux', env: { PATH: '' }, run, deep: true }),
  );
  assert.equal(tool(items, 'node').state, 'ready');
  assert.equal(tool(items, 'node').version, '24.x');
  assert.equal(tool(items, 'node').origin, 'system');
  assert.equal(tool(items, 'npm').version, '10.9');
  assert.equal(tool(items, 'opencode').version, '1.2.3-beta.1');
  assert.equal(tool(items, 'opencode').login, false, 'zero credentials is false');
  assert.equal(tool(items, 'git').version, null, 'unparseable version still leaves a usable tool');
  assert.equal(tool(items, 'winget').state, 'missing', 'winget is Windows-only');
});

test('cleanToolView: whitelisted fields only, home becomes ~, absolute paths and stacks are dropped', () => {
  const home = os.homedir();
  const items = [
    {
      id: 'node',
      label: 'Node.js',
      optional: false,
      state: 'ready',
      version: `v24.11.0 at ${home}\\rahasia\\node.exe`,
      login: null,
      origin: 'runtime',
      secret: 'jangan ikut',
      command: 'C:\\Users\\ani\\private\\node.exe',
    },
    {
      id: 'claude',
      label: 'Claude Code',
      optional: false,
      state: 'unknown',
      version: '2.1.5\n    at Object.<anonymous> (C:\\Users\\ani\\app\\cli.js:1:1)',
      login: true,
      origin: 'system',
    },
    { id: 'evil', label: 'Evil', optional: false, state: 'ready', version: 'x', login: null, origin: 'system' },
  ];
  const view = cleanToolView(items);
  assert.equal(view.length, 2);
  assert.deepEqual(Object.keys(view[0]).sort(), ['id', 'label', 'login', 'optional', 'origin', 'state', 'version']);
  assert.equal(view[0].secret, undefined);
  assert.equal(view[0].command, undefined);
  assert.ok(view[0].version.includes('~'), 'home folder is abbreviated');
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes(home), false, 'no home path');
  assert.equal(serialized.includes('C:\\\\Users\\\\ani'), false, 'no user path');
  assert.equal(serialized.includes('at Object'), false, 'no stack line');
  assert.equal(view[1].version, '2.1.5');
});
