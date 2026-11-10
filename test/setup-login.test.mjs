// src/setup/login.js: a .cmd launcher with the portable runtime on PATH, opened in its own terminal so a login
// prompt has somewhere to live. Nothing runs on non-Windows.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loginCommand, openLoginTerminal, writeLoginLauncher } from '../src/setup/login.js';
import { runtimePaths } from '../src/setup/runtime.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-login-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const tmpPath = (name) => path.join(TMP, `${name}-${n++}`);

test('loginCommand: only Claude and OpenCode, no free-form shell text', () => {
  assert.equal(loginCommand('claude'), 'claude');
  assert.equal(loginCommand('opencode'), 'opencode auth login');
  assert.throws(() => loginCommand('powershell'), TypeError);
  assert.throws(() => loginCommand('claude & del *'), TypeError);
});

test('writeLoginLauncher: safe .cmd with npm prefix + node on PATH, percent signs escaped', () => {
  const runtime = runtimePaths({ runtimeDir: tmpPath('claude') });
  const file = writeLoginLauncher({ runtime, target: 'claude', platform: 'win32' });
  assert.equal(file, path.join(runtime.root, 'login', 'claude.cmd'));
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.equal(lines[1], `set "PATH=${runtime.npmPrefix};${runtime.node};%PATH%"`);
  assert.match(lines[2], /^title /);
  assert.equal(lines[3], 'claude');
  assert.equal(content.includes('\r\n'), true, 'cmd files use CRLF');

  const opencode = runtimePaths({ runtimeDir: tmpPath('opencode') });
  const openCodeFile = writeLoginLauncher({ runtime: opencode, target: 'opencode', platform: 'win32' });
  assert.equal(readFileSync(openCodeFile, 'utf8').split('\r\n')[3], 'opencode auth login');

  const percentRuntime = { ...runtime, root: path.join(runtime.root, 'persen'), npmPrefix: 'C:\\rt\\100%\\npm' };
  const percentFile = writeLoginLauncher({ runtime: percentRuntime, target: 'claude', platform: 'win32' });
  const percentLines = readFileSync(percentFile, 'utf8').split('\r\n');
  assert.ok(percentLines[1].includes('100%%\\npm'), 'literal % in a path is doubled for cmd');
  assert.ok(percentLines[1].endsWith(';%PATH%"'), 'the PATH variable itself is not doubled');
});

test('writeLoginLauncher: refused off Windows and for an unknown target', () => {
  const runtime = runtimePaths({ runtimeDir: tmpPath('unsupported') });
  assert.throws(() => writeLoginLauncher({ runtime, target: 'claude', platform: 'linux' }), (err) => err.code === 'UNSUPPORTED');
  assert.throws(() => writeLoginLauncher({ runtime, target: 'git', platform: 'win32' }), TypeError);
  assert.equal(existsSync(path.join(runtime.root, 'login', 'git.cmd')), false);
});

test('openLoginTerminal: cmd.exe start with the launcher, detached and no pipes; non-Windows does not spawn', async () => {
  const runtime = runtimePaths({ runtimeDir: tmpPath('terminal') });
  const calls = [];
  const child = { unref() {}, on() { return this; } };
  const result = await openLoginTerminal({
    runtime,
    target: 'claude',
    platform: 'win32',
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });
  assert.deepEqual(result, { ok: true, launcher: path.join(runtime.root, 'login', 'claude.cmd') });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'cmd.exe');
  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', `start "" "${path.join(runtime.root, 'login', 'claude.cmd')}"`]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, false);
  assert.equal(calls[0].options.stdio, 'ignore');

  let spawned = false;
  const offWindows = await openLoginTerminal({
    runtime,
    target: 'claude',
    platform: 'linux',
    spawnImpl: () => {
      spawned = true;
      return child;
    },
  });
  assert.deepEqual(offWindows, { ok: false, code: 'UNSUPPORTED' });
  assert.equal(spawned, false);
});
