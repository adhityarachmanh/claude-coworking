// Claude Code binary discovery: the npm package can lose bin/claude.exe after a self-update while a running session
// holds it open (only bin/claude.exe.old and cli-wrapper.cjs remain). The wrapper must be used instead.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findClaude, windowsInstallDirs } from '../src/claude-bin.js';

test('findClaude: paket dengan cli-wrapper (bin hilang setelah update) dijalankan lewat node', { skip: process.platform !== 'win32' }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'office-cbin-'));
  const pkg = path.join(tmp, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  writeFileSync(path.join(pkg, 'bin', 'claude.exe.old'), 'old');
  writeFileSync(path.join(pkg, 'cli-wrapper.cjs'), '// wrapper');
  const saved = Object.fromEntries(['PATH', 'CLAUDE_BIN', 'NVM_HOME', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles'].map((key) => [key, process.env[key]]));
  try {
    process.env.PATH = tmp;
    delete process.env.CLAUDE_BIN;
    // A version manager installed on the machine running the test must not win over the folder under test.
    for (const key of ['NVM_HOME', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles']) process.env[key] = path.join(tmp, 'absent');
    const found = findClaude();
    assert.equal(found.command, process.execPath);
    assert.deepEqual(found.args, [path.join(pkg, 'cli-wrapper.cjs')]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('windowsInstallDirs: folder installs version manager dan npm global ikut dicari', { skip: process.platform !== 'win32' }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'office-cdirs-'));
  try {
    mkdirSync(path.join(tmp, 'nvm', 'installs', 'v1'), { recursive: true });
    const dirs = windowsInstallDirs({ NVM_HOME: path.join(tmp, 'nvm'), LOCALAPPDATA: path.join(tmp, 'local'), APPDATA: path.join(tmp, 'roaming'), ProgramFiles: path.join(tmp, 'pf') });
    assert.ok(dirs.includes(path.join(tmp, 'nvm', 'installs', 'v1')));
    assert.ok(dirs.includes(path.join(tmp, 'roaming', 'npm')));
    assert.ok(dirs.includes(path.join(tmp, 'pf', 'nodejs')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
