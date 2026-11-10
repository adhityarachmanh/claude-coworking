// Runtime-local CLI lookup: the portable runtime installed by setup is searched only after the system PATH, so an
// existing install keeps winning, while a fresh machine with nothing on PATH still finds its own binaries.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { findClaude } from '../src/claude-bin.js';
import { findOpenCode } from '../src/opencode-bin.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-resolve-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const tmpPath = (name) => path.join(TMP, `${name}-${n++}`);
const EXE = process.platform === 'win32' ? '.exe' : '';
const EMPTY = tmpPath('empty-home');
mkdirSync(EMPTY, { recursive: true });

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

const cleanEnv = (extra) => ({
  PATH: extra.PATH,
  HOME: EMPTY,
  USERPROFILE: EMPTY,
  OFFICE_DATA_DIR: undefined,
  OFFICE_RUNTIME_DIR: extra.OFFICE_RUNTIME_DIR,
  OFFICE_APP_DIR: extra.OFFICE_APP_DIR,
  CLAUDE_BIN: extra.CLAUDE_BIN,
  OPENCODE_BIN: extra.OPENCODE_BIN,
});

function writeClaude(dir) {
  const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(cli, '// fake claude\n');
  return cli;
}

function writeOpenCode(dir) {
  const exe = path.join(dir, 'node_modules', '@opencode', 'cli', 'bin', `opencode${EXE}`);
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, 'fake opencode');
  return exe;
}

test('findClaude/findOpenCode: system PATH wins over the portable runtime', () => {
  const system = tmpPath('system');
  mkdirSync(system, { recursive: true });
  const systemClaude = writeClaude(system);
  const systemOpenCode = writeOpenCode(system);
  const runtime = tmpPath('runtime');
  mkdirSync(path.join(runtime, 'npm'), { recursive: true });
  writeClaude(path.join(runtime, 'npm'));
  writeOpenCode(path.join(runtime, 'npm'));

  withEnv(cleanEnv({ PATH: system, OFFICE_RUNTIME_DIR: runtime }), () => {
    assert.deepEqual(findClaude(), { command: process.execPath, args: [systemClaude] });
    assert.deepEqual(findOpenCode(), { command: systemOpenCode, args: [] });
  });
});

test('findClaude/findOpenCode: runtime npm prefix is the last candidate before giving up', () => {
  const runtime = tmpPath('runtime-only');
  const prefix = path.join(runtime, 'npm');
  mkdirSync(prefix, { recursive: true });
  const runtimeClaude = writeClaude(prefix);
  const runtimeOpenCode = writeOpenCode(prefix);
  const emptyPath = tmpPath('empty-path');
  mkdirSync(emptyPath, { recursive: true });

  withEnv(cleanEnv({ PATH: emptyPath, OFFICE_RUNTIME_DIR: runtime }), () => {
    assert.deepEqual(findClaude(), { command: process.execPath, args: [runtimeClaude] });
    assert.deepEqual(findOpenCode(), { command: runtimeOpenCode, args: [] });
  });
});

test('findOpenCode: a bare binary inside the runtime prefix is found too', () => {
  const runtime = tmpPath('runtime-direct');
  const prefix = path.join(runtime, 'npm');
  mkdirSync(prefix, { recursive: true });
  const direct = path.join(prefix, `opencode${EXE}`);
  writeFileSync(direct, 'fake opencode');
  const emptyPath = tmpPath('empty-direct');
  mkdirSync(emptyPath, { recursive: true });

  withEnv(cleanEnv({ PATH: emptyPath, OFFICE_RUNTIME_DIR: runtime }), () => {
    assert.deepEqual(findOpenCode(), { command: direct, args: [] });
  });
});

test('findClaude: OFFICE_APP_DIR falls back to <app>/runtime when OFFICE_RUNTIME_DIR is unset', () => {
  const appDir = tmpPath('app');
  mkdirSync(appDir, { recursive: true });
  const runtimeClaude = writeClaude(path.join(appDir, 'runtime', 'npm'));
  const emptyPath = tmpPath('empty-app-path');
  mkdirSync(emptyPath, { recursive: true });

  withEnv(cleanEnv({ PATH: emptyPath, OFFICE_APP_DIR: appDir }), () => {
    assert.deepEqual(findClaude(), { command: process.execPath, args: [runtimeClaude] });
  });
});

test('CLAUDE_BIN and OPENCODE_BIN overrides still beat every lookup', () => {
  const system = tmpPath('override-system');
  mkdirSync(system, { recursive: true });
  writeClaude(system);
  writeOpenCode(system);

  withEnv(cleanEnv({ PATH: system, CLAUDE_BIN: process.execPath, OPENCODE_BIN: process.execPath }), () => {
    assert.deepEqual(findClaude(), { command: process.execPath, args: [] });
    assert.deepEqual(findOpenCode(), { command: process.execPath, args: [] });
  });
});
