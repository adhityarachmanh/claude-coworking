// ⬆ Desktop update: GitHub release check, mandatory SHA-256, and no install while a turn is running.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DesktopUpdater } from '../src/desktop-update.js';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'office-desktop-update-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const bytes = Buffer.from('installer-bytes');
const sha = createHash('sha256').update(bytes).digest('hex');
const installerUrl = 'https://github.com/adhityarachmanh/claude-coworking/releases/download/v0.3.0/AdhitOffice-Setup-0.3.0.exe';
const shaUrl = `${installerUrl}.sha256`;

function fakeFetch({ tag = 'v0.3.0', checksum = sha, badHash = false, assetHost = 'github.com' } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({
        tag_name: tag,
        body: 'Perbaikan penting.',
        assets: [
          { name: `AdhitOffice-Setup-${tag.replace(/^v/, '')}.exe`, browser_download_url: installerUrl, size: bytes.length },
          { name: `AdhitOffice-Setup-${tag.replace(/^v/, '')}.exe.sha256`, browser_download_url: shaUrl, size: 65 },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url) === shaUrl) return new Response(`${checksum}  installer.exe\n`, { status: 200 });
    if (String(url) === installerUrl) {
      return {
        ok: true,
        url: `https://${assetHost}/asset.exe`,
        status: 200,
        headers: new Headers({ 'content-length': String(bytes.length) }),
        arrayBuffer: async () => bytes,
      };
    }
    return new Response('not found', { status: 404 });
  };
  return { calls, fetch, badHash };
}

test('check: a newer GitHub release becomes one update, with installer + checksum assets', async () => {
  const { fetch } = fakeFetch();
  const updater = new DesktopUpdater({ currentVersion: '0.2.0', dataDir: TMP, fetch, firstCheckMs: -1 });
  const view = await updater.check();
  assert.equal(view.available, true);
  assert.equal(view.mode, 'desktop');
  assert.equal(view.latestVersion, '0.3.0');
  assert.equal(view.behind, 1);
  assert.equal(view.commits[0].hash, '0.3.0');
  assert.equal(view.notes, 'Perbaikan penting.');
  assert.equal(view.error, null);
  updater.stop();
});

test('check: the same version is up to date; a missing checksum asset is an error', async () => {  const same = new DesktopUpdater({ currentVersion: '0.3.0', dataDir: TMP, fetch: fakeFetch().fetch, firstCheckMs: -1 });
  assert.equal((await same.check()).behind, 0);
  same.stop();

  const missing = new DesktopUpdater({
    currentVersion: '0.2.0',
    dataDir: TMP,
    firstCheckMs: -1,
    fetch: async () => new Response(JSON.stringify({ tag_name: 'v0.4.0', assets: [{ name: 'AdhitOffice-Setup-0.4.0.exe', browser_download_url: installerUrl }] }), { status: 200 }),
  });
  const view = await missing.check();
  assert.match(view.error, /SHA-256/);
  missing.stop();
});

test('prepare: downloads, verifies SHA-256, and keeps only the verified installer', async () => {
  const { fetch } = fakeFetch();
  const updater = new DesktopUpdater({ currentVersion: '0.2.0', dataDir: TMP, fetch, firstCheckMs: -1 });
  await updater.check();
  const file = await updater.prepare();
  assert.equal(file.version, '0.3.0');
  assert.equal(file.sha256, sha);
  assert.equal(existsSync(file.file), true);
  updater.stop();
});

test('prepare: a hash mismatch refuses the download and leaves no installer behind', async () => {
  const dir = path.join(TMP, 'mismatch');
  const { fetch } = fakeFetch({ checksum: '0'.repeat(64) });
  const updater = new DesktopUpdater({ currentVersion: '0.2.0', dataDir: dir, fetch, firstCheckMs: -1 });
  await updater.check();
  await assert.rejects(() => updater.prepare(), /tidak cocok/);
  assert.deepEqual(readdirSync(path.join(dir, 'updates')).filter((name) => name.endsWith('.exe')), []);
  updater.stop();
});

test('prepare: an installer redirected outside GitHub is refused', async () => {
  const { fetch } = fakeFetch({ assetHost: 'evil.example' });
  const updater = new DesktopUpdater({ currentVersion: '0.2.0', dataDir: path.join(TMP, 'redirect'), fetch, firstCheckMs: -1 });
  await updater.check();
  await assert.rejects(() => updater.prepare(), /host yang tidak dikenal/);
  updater.stop();
});

test('update: refuses while a turn is running, and old installers are pruned on start', async () => {
  const dir = path.join(TMP, 'busy');
  const updates = path.join(dir, 'updates');
  mkdirSync(updates, { recursive: true });
  writeFileSync(path.join(updates, 'AdhitOffice-Setup-0.1.0.exe'), 'old');
  const updater = new DesktopUpdater({ currentVersion: '0.2.0', dataDir: dir, fetch: fakeFetch().fetch, busy: () => true, firstCheckMs: -1 });
  assert.deepEqual(readdirSync(updates), [], 'old installer removed');
  await updater.check();
  const result = await updater.update();
  assert.equal(result.ok, false);
  // Windows checks the running turn first; elsewhere the installer is refused as Windows-only before that.
  assert.match(result.error, process.platform === 'win32' ? /giliran/ : /Windows/);
  updater.stop();
});

test('check: an unsafe version tag is refused, and a pinned public key requires a .sig asset', async () => {
  const unsafe = new DesktopUpdater({
    currentVersion: '0.2.0',
    dataDir: path.join(TMP, 'unsafe'),
    firstCheckMs: -1,
    fetch: async () => new Response(JSON.stringify({ tag_name: 'v1.2.3/../../evil', assets: [] }), { status: 200 }),
  });
  assert.match((await unsafe.check()).error, /versi stabil/);
  unsafe.stop();

  const { publicKey } = generateKeyPairSync('ed25519');
  const signed = new DesktopUpdater({
    currentVersion: '0.2.0',
    dataDir: path.join(TMP, 'unsigned'),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    firstCheckMs: -1,
    fetch: fakeFetch().fetch,
  });
  assert.match((await signed.check()).error, /ditandatangani/);
  signed.stop();
});

test('update: an installer changed after verification is re-hashed and rejected before spawn', async (t) => {
  if (process.platform !== 'win32') return t.skip('installer spawn hanya di Windows');
  const dir = path.join(TMP, 'toctou');
  const updater = new DesktopUpdater({ currentVersion: '0.2.0', dataDir: dir, fetch: fakeFetch().fetch, busy: () => false, firstCheckMs: -1 });
  await updater.check();
  const file = await updater.prepare();
  writeFileSync(file.file, 'tampered');
  const result = await updater.update();
  assert.equal(result.ok, false);
  assert.match(result.error, /berubah setelah diverifikasi/);
  updater.stop();
});
