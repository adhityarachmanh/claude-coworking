// src/setup/npm.js: npm is run through the portable Node runtime with a hardened environment, into a staging
// prefix that only replaces the real one after the package is verifiably there. No real npm and no network.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { hardenedNpmEnv, installNpmPackage, npmCliPath, npmInstallArgs } from '../src/setup/npm.js';
import { runtimePaths } from '../src/setup/runtime.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-npm-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const tmpPath = (name) => path.join(TMP, `${name}-${n++}`);

/** A fake spawn whose child answers after `closeDelay`; `setup` runs before the close event. */
function fakeSpawn({ code = 0, signal = null, stdout = '', stderr = '', closeDelay = 0, setup } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    setup?.(args, options);
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code, signal);
    }, closeDelay).unref?.();
    return child;
  };
  return { calls, spawnImpl };
}

const prefixFromArgs = (args) => args[args.indexOf('--prefix') + 1];

test('npmCliPath points inside the portable Node distribution', () => {
  assert.equal(npmCliPath(path.join('C:', 'runtime', 'node')), path.join('C:', 'runtime', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
});

test('npmInstallArgs is a fixed, shell-free argv (no string interpolation)', () => {
  assert.deepEqual(
    npmInstallArgs({
      npmCli: 'C:\\rt\\node\\node_modules\\npm\\bin\\npm-cli.js',
      npmPrefix: 'C:\\rt\\npm-stage-1',
      npmrc: 'C:\\rt\\npmrc',
      globalNpmrc: 'C:\\rt\\npm\\etc\\npmrc',
      spec: '@anthropic-ai/claude-code',
    }),
    [
      'C:\\rt\\node\\node_modules\\npm\\bin\\npm-cli.js',
      'install',
      '-g',
      '--prefix',
      'C:\\rt\\npm-stage-1',
      '--userconfig',
      'C:\\rt\\npmrc',
      '--globalconfig',
      'C:\\rt\\npm\\etc\\npmrc',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      '--progress=false',
      '@anthropic-ai/claude-code',
    ],
  );
});

test('hardenedNpmEnv drops inherited Node/npm settings and pins the portable cache', () => {
  const env = {
    PATH: 'C:\\Windows',
    HOME: 'C:\\Users\\ani',
    NODE_OPTIONS: '--require evil.js',
    node_path: 'C:\\evil',
    ELECTRON_RUN_AS_NODE: '1',
    npm_config_prefix: 'C:\\other',
    NPM_CONFIG_REGISTRY: 'https://evil.example',
    npm_config_cache: 'C:\\old-cache',
  };
  const out = hardenedNpmEnv(env, { cache: 'C:\\rt\\cache' });
  assert.notEqual(out, env);
  assert.equal(out.PATH, env.PATH);
  assert.equal(out.HOME, env.HOME);
  for (const key of Object.keys(out)) {
    assert.ok(!/^npm_config_/i.test(key) || key === 'npm_config_cache' || key === 'npm_config_update_notifier', `leftover ${key}`);
  }
  assert.equal(Object.hasOwn(out, 'NODE_OPTIONS'), false);
  assert.equal(Object.hasOwn(out, 'node_path'), false);
  assert.equal(Object.hasOwn(out, 'ELECTRON_RUN_AS_NODE'), false);
  assert.equal(out.npm_config_cache, 'C:\\rt\\cache');
  assert.equal(out.npm_config_update_notifier, 'false');
  assert.equal(out.NO_COLOR, '1');
});

test('installNpmPackage: stages, runs node + npm-cli with no shell, verifies and swaps the prefix', async () => {
  const root = tmpPath('install');
  const runtime = runtimePaths({ runtimeDir: root });
  mkdirSync(runtime.npmPrefix, { recursive: true });
  writeFileSync(path.join(runtime.npmPrefix, 'old.txt'), 'lama');
  const lines = [];
  const { calls, spawnImpl } = fakeSpawn({
    stdout: 'added 1 package\n',
    setup: (args) => {
      const stage = prefixFromArgs(args);
      const bin = path.join(stage, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude'), 'bin');
    },
  });

  const result = await installNpmPackage({
    runtime,
    spec: '@anthropic-ai/claude-code',
    spawnImpl,
    onLine: (line, source) => lines.push([source, line]),
  });

  assert.equal(result.prefix, runtime.npmPrefix);
  assert.equal(calls.length, 1);
  const [{ command, args, options }] = calls;
  const stage = prefixFromArgs(args);
  assert.equal(command, path.join(runtime.node, 'node.exe'), 'npm berjalan lewat node.exe layout runtime (Windows di semua host)');
  assert.deepEqual(args, npmInstallArgs({
    npmCli: npmCliPath(runtime.node),
    npmPrefix: stage,
    npmrc: runtime.npmrc,
    globalNpmrc: runtime.globalNpmrc,
    spec: '@anthropic-ai/claude-code',
  }));
  assert.equal(options.shell, false, 'never a shell');
  assert.equal(options.cwd, runtime.tmpDir);
  assert.equal(options.env.NODE_OPTIONS, undefined);
  assert.equal(options.env.npm_config_cache, runtime.npmCache);
  assert.equal(options.env.npm_config_update_notifier, 'false');
  assert.ok(existsSync(path.join(runtime.npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin')), 'new prefix installed');
  assert.equal(existsSync(path.join(runtime.npmPrefix, 'old.txt')), false, 'old prefix replaced');
  assert.equal(existsSync(stage), false, 'staging prefix was renamed away');
  assert.deepEqual(lines, [['stdout', 'added 1 package']]);
});

test('installNpmPackage: onLine gets every line but only the last 50 are kept for hints', async () => {
  const root = tmpPath('lines');
  const runtime = runtimePaths({ runtimeDir: root });
  const output = Array.from({ length: 60 }, (_, i) => `baris-${i}`).join('\n');
  const seen = [];
  const { spawnImpl } = fakeSpawn({
    stdout: `${output}\n`,
    setup: (args) => {
      const bin = path.join(prefixFromArgs(args), 'node_modules', '@opencode', 'cli', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, 'opencode.exe'), 'bin');
    },
  });
  const result = await installNpmPackage({ runtime, spec: '@opencode/cli', spawnImpl, onLine: (line) => seen.push(line) });
  assert.equal(seen.length, 60, 'the renderer sees each line as it arrives');
  assert.equal(result.lines.length, 50, 'the error hint buffer is capped');
  assert.equal(result.lines[0], 'baris-10');
  assert.equal(result.lines[49], 'baris-59');
});

test('installNpmPackage: a non-zero npm exit keeps the old prefix and reports the last lines', async () => {
  const root = tmpPath('failure');
  const runtime = runtimePaths({ runtimeDir: root });
  mkdirSync(runtime.npmPrefix, { recursive: true });
  writeFileSync(path.join(runtime.npmPrefix, 'keep.txt'), 'tetap');
  const { spawnImpl } = fakeSpawn({ code: 1, stdout: 'satu\n', stderr: 'npm ERR! jaringan\n' });

  await assert.rejects(
    installNpmPackage({ runtime, spec: '@anthropic-ai/claude-code', spawnImpl }),
    (err) => {
      assert.equal(err.code, 'NPM_FAILED');
      assert.match(err.hint, /npm ERR! jaringan/);
      return true;
    },
  );
  assert.equal(readFileSync(path.join(runtime.npmPrefix, 'keep.txt'), 'utf8'), 'tetap');
  const tmp = path.join(root, 'tmp');
  const stages = existsSync(tmp) ? readdirSync(tmp).filter((name) => name.startsWith('npm-stage-')) : [];
  assert.deepEqual(stages, [], 'no staging prefix left behind');
});

test('installNpmPackage: another file at <stage>/<shim>.cmd is enough verification', async () => {
  const root = tmpPath('shim');
  const runtime = runtimePaths({ runtimeDir: root });
  const { spawnImpl } = fakeSpawn({
    setup: (args) => writeFileSync(path.join(prefixFromArgs(args), 'opencode.cmd'), '@echo off\n'),
  });
  const result = await installNpmPackage({ runtime, spec: '@opencode/cli', spawnImpl });
  assert.equal(result.prefix, runtime.npmPrefix);
  assert.ok(existsSync(path.join(runtime.npmPrefix, 'opencode.cmd')));
});

test('installNpmPackage: timeout and abort stop the child and reject without swapping', async () => {
  const root = tmpPath('timeout');
  const runtime = runtimePaths({ runtimeDir: root });
  const { spawnImpl } = fakeSpawn({ closeDelay: 60_000 });
  await assert.rejects(
    installNpmPackage({ runtime, spec: '@opencode/cli', spawnImpl, timeoutMs: 20 }),
    (err) => err.code === 'NPM_FAILED' && /waktu|timeout/i.test(err.message + err.hint),
  );
  assert.equal(existsSync(runtime.npmPrefix), false);

  const controller = new AbortController();
  const abortRoot = tmpPath('abort');
  const abortRuntime = runtimePaths({ runtimeDir: abortRoot });
  const slow = fakeSpawn({ closeDelay: 60_000 });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    installNpmPackage({ runtime: abortRuntime, spec: '@opencode/cli', spawnImpl: slow.spawnImpl, signal: controller.signal }),
    (err) => err.code === 'CANCELLED',
  );
  assert.equal(existsSync(abortRuntime.npmPrefix), false);
});

test('installNpmPackage: a failed swap restores the old prefix and throws NPM_FAILED', async () => {
  const root = tmpPath('rollback');
  const runtime = runtimePaths({ runtimeDir: root });
  mkdirSync(runtime.npmPrefix, { recursive: true });
  writeFileSync(path.join(runtime.npmPrefix, 'lama.txt'), 'versi lama');
  const { spawnImpl } = fakeSpawn({
    setup: (args) => {
      const bin = path.join(prefixFromArgs(args), 'node_modules', '@opencode', 'cli', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, 'opencode.exe'), 'bin');
    },
  });
  let renames = 0;
  const renameImpl = async (from, to) => {
    renames++;
    if (renames === 2) {
      const err = new Error('direktori terkunci');
      err.code = 'EPERM';
      throw err;
    }
    return rename(from, to);
  };

  await assert.rejects(
    installNpmPackage({ runtime, spec: '@opencode/cli', spawnImpl, renameImpl }),
    (err) => {
      assert.equal(err.code, 'NPM_FAILED');
      assert.match(err.hint, /Gagal memasang|terkunci|direktori/i);
      return true;
    },
  );
  assert.equal(readFileSync(path.join(runtime.npmPrefix, 'lama.txt'), 'utf8'), 'versi lama', 'old prefix restored');
  const leftovers = readdirSync(path.dirname(runtime.npmPrefix)).filter((name) => name.includes('.old-'));
  assert.deepEqual(leftovers, [], 'no .old- prefix left behind');
});

test('installNpmPackage: missing package after a successful npm exit is an NPM_FAILED error', async () => {
  const root = tmpPath('empty');
  const runtime = runtimePaths({ runtimeDir: root });
  const { spawnImpl } = fakeSpawn({ code: 0 });
  await assert.rejects(installNpmPackage({ runtime, spec: '@anthropic-ai/claude-code', spawnImpl }), (err) => err.code === 'NPM_FAILED');
  assert.equal(existsSync(runtime.npmPrefix), false, 'nothing swapped in');
});
