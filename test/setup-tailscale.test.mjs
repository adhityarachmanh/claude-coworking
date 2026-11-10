// src/setup/tailscale.js: candidate lookup without a shell, the Tailscale 100.x address, and the allowlisted
// winget install used by setup (Windows only).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SETUP_TARGETS } from '../src/setup/packages.js';
import { findTailscale, installTailscale, tailscaleIp } from '../src/setup/tailscale.js';

test('findTailscale: known Windows and POSIX locations are checked before where/which', () => {
  const win = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  assert.equal(findTailscale({ platform: 'win32', exists: (file) => file === win }), win);
  assert.equal(
    findTailscale({ platform: 'darwin', exists: (file) => file === '/Applications/Tailscale.app/Contents/MacOS/Tailscale' }),
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  );

  const calls = [];
  const found = findTailscale({
    platform: 'linux',
    exists: (file) => file === '/opt/ts/tailscale',
    run: (command, args) => {
      calls.push([command, ...args]);
      return '/opt/ts/tailscale\n';
    },
  });
  assert.equal(found, '/opt/ts/tailscale');
  assert.deepEqual(calls, [['which', 'tailscale']]);
  assert.equal(findTailscale({ platform: 'linux', exists: () => false, run: () => '' }), null);
});

test('tailscaleIp: the first 100.x address, null for errors or other output', () => {
  assert.equal(tailscaleIp('tailscale', { run: () => '100.101.102.103\n' }), '100.101.102.103');
  assert.equal(tailscaleIp('tailscale', { run: () => '100.64.0.1\r\n100.64.0.2\r\n' }), '100.64.0.1');
  assert.equal(tailscaleIp('tailscale', { run: () => '192.168.1.5\n' }), null);
  assert.equal(
    tailscaleIp('tailscale', {
      run: () => {
        throw new Error('belum login');
      },
    }),
    null,
  );
  assert.equal(tailscaleIp(null, { run: () => '100.1.1.1' }), null);
});

test('installTailscale: winget runs the frozen allowlist; other platforms are UNSUPPORTED', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => child.emit('close', 0, null), 0);
    return child;
  };
  const result = await installTailscale({ platform: 'win32', spawnImpl });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'winget');
  assert.deepEqual(calls[0].args, [...SETUP_TARGETS.tailscale.winget.args]);
  assert.equal(calls[0].options.shell, false);

  let spawned = false;
  await assert.rejects(
    installTailscale({ platform: 'linux', spawnImpl: () => ((spawned = true), null) }),
    (err) => err.code === 'UNSUPPORTED',
  );
  assert.equal(spawned, false, 'nothing is spawned off Windows');
});

test('installTailscale: a non-zero winget exit is a TAILSCALE_FAILED error with output', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => {
      child.stderr.emit('data', Buffer.from('winget gagal\n'));
      child.emit('close', 1, null);
    }, 0);
    return child;
  };
  await assert.rejects(installTailscale({ platform: 'win32', spawnImpl }), (err) => err.code === 'TAILSCALE_FAILED' && /winget gagal/.test(err.hint));
});
