// Claude Code binary discovery: the npm package can lose bin/claude.exe after a self-update while a running session
// holds it open (only bin/claude.exe.old and cli-wrapper.cjs remain). The wrapper must be used instead.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findClaude, windowsInstallDirs } from '../src/claude-bin.js';

test('findClaude: binary platform di dalam paket dipakai saat bin/claude.exe hilang (bukan wrapper Node)', { skip: process.platform !== 'win32' }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'office-cbin-'));
  const pkg = path.join(tmp, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  writeFileSync(path.join(pkg, 'bin', 'claude.exe.old'), 'old');
  writeFileSync(path.join(pkg, 'cli-wrapper.cjs'), '// wrapper');
  // The real wrapper runs the platform binary beside the package; a self-update leaves that one in place.
  const platform = path.join(pkg, 'node_modules', '@anthropic-ai', `claude-code-${process.platform}-${process.arch}`);
  mkdirSync(platform, { recursive: true });
  writeFileSync(path.join(platform, 'claude.exe'), 'native');
  const saved = Object.fromEntries(['PATH', 'CLAUDE_BIN', 'NVM_HOME', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles'].map((key) => [key, process.env[key]]));
  try {
    process.env.PATH = tmp;
    delete process.env.CLAUDE_BIN;
    // A version manager installed on the machine running the test must not win over the folder under test.
    for (const key of ['NVM_HOME', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles']) process.env[key] = path.join(tmp, 'absent');
    const found = findClaude();
    assert.equal(found.command, path.join(platform, 'claude.exe'));
    assert.deepEqual(found.args, []);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findClaude: paket lengkap di instalasi node lain menang atas wrapper tanpa binary platform', { skip: process.platform !== 'win32' }, () => {
  // The reported bug: nvm kept a v26 install whose bin/ and platform package were gone (only cli-wrapper.cjs
  // remained), while v24 held a complete package. PATH pointed at v26, so the broken wrapper won and login failed
  // with "spawnSync ...claude-code-win32-x64\claude.exe ENOENT".
  const tmp = mkdtempSync(path.join(tmpdir(), 'office-cbroken-'));
  const oldDir = path.join(tmp, 'installs', 'v26.13.0');
  const newDir = path.join(tmp, 'installs', 'v24.22.3');
  const brokenPkg = path.join(oldDir, 'node_modules', '@anthropic-ai', 'claude-code');
  const goodPkg = path.join(newDir, 'node_modules', '@anthropic-ai', 'claude-code');
  const platform = path.join(goodPkg, 'node_modules', '@anthropic-ai', `claude-code-${process.platform}-${process.arch}`);
  mkdirSync(brokenPkg, { recursive: true });
  writeFileSync(path.join(brokenPkg, 'cli-wrapper.cjs'), '// wrapper without its native binary');
  mkdirSync(platform, { recursive: true });
  writeFileSync(path.join(platform, 'claude.exe'), 'native');
  const saved = Object.fromEntries(['PATH', 'CLAUDE_BIN', 'NVM_HOME', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'OFFICE_NODE_BIN'].map((key) => [key, process.env[key]]));
  try {
    process.env.PATH = oldDir; // the broken install is still first on PATH
    delete process.env.CLAUDE_BIN;
    delete process.env.OFFICE_NODE_BIN;
    process.env.NVM_HOME = tmp; // its installs/ folder holds both versions
    for (const key of ['LOCALAPPDATA', 'APPDATA', 'ProgramFiles']) process.env[key] = path.join(tmp, 'absent');
    assert.deepEqual(findClaude(), { command: path.join(platform, 'claude.exe'), args: [] });
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
    mkdirSync(path.join(tmp, 'local', 'Author Software', 'nvm', 'installs', 'v2'), { recursive: true });
    const dirs = windowsInstallDirs({ NVM_HOME: path.join(tmp, 'nvm'), LOCALAPPDATA: path.join(tmp, 'local'), APPDATA: path.join(tmp, 'roaming'), ProgramFiles: path.join(tmp, 'pf') });
    assert.ok(dirs.includes(path.join(tmp, 'nvm', 'installs', 'v1')));
    assert.ok(dirs.includes(path.join(tmp, 'local', 'Author Software', 'nvm', 'installs', 'v2')), 'nvm-windows Author Software ikut dicari');
    assert.ok(dirs.includes(path.join(tmp, 'roaming', 'npm')));
    assert.ok(dirs.includes(path.join(tmp, 'pf', 'nodejs')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findClaude: binary platform di dalam paket dipakai saat bin/claude.exe hilang', { skip: process.platform !== 'win32' }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'office-cplat-'));
  const pkg = path.join(tmp, 'node_modules', '@anthropic-ai', 'claude-code');
  const platform = path.join(pkg, 'node_modules', '@anthropic-ai', `claude-code-${process.platform}-${process.arch}`);
  mkdirSync(platform, { recursive: true });
  writeFileSync(path.join(platform, 'claude.exe'), 'native');
  const saved = Object.fromEntries(['PATH', 'CLAUDE_BIN', 'NVM_HOME', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'OFFICE_NODE_BIN'].map((key) => [key, process.env[key]]));
  try {
    process.env.PATH = tmp;
    delete process.env.CLAUDE_BIN;
    process.env.OFFICE_NODE_BIN = path.join(tmp, 'absent');
    for (const key of ['NVM_HOME', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles']) process.env[key] = path.join(tmp, 'absent');
    assert.deepEqual(findClaude(), { command: path.join(platform, 'claude.exe'), args: [] });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
