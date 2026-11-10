// src/setup/*: the dependency-free setup foundation — target list, verified download, safe ZIP extraction,
// a portable Node runtime, its state and its process lock. No real network: fetch is always a fake.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ZipWriter } from '../src/zip.js';
import { NODE_DIST, NODE_MAJOR, SETUP_TARGETS, isSetupTarget, nodeZipName } from '../src/setup/packages.js';
import {
  downloadVerified,
  extractZipSafe,
  installNodeRuntime,
  parseShasums,
  readRuntimeState,
  runtimeBinDirs,
  runtimePaths,
  saveRuntimeState,
  sha256File,
  withRuntimeLock,
} from '../src/setup/runtime.js';

const TMP = mkdtempSync(path.join(tmpdir(), 'office-setup-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const tmpPath = (name) => path.join(TMP, `${name}-${n++}`);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Writes `entries` ([name, Buffer]) to a new ZIP file and returns its path. */
async function makeZip(entries) {
  const file = tmpPath('fixture') + '.zip';
  const out = createWriteStream(file);
  const zip = new ZipWriter(out);
  for (const [name, data] of entries) await zip.add(name, data);
  await zip.finish();
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  return file;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- packages ----------

test('setup targets: pinned Node major, npm packages without version tags, optional extras', () => {
  assert.equal(NODE_MAJOR, 24);
  assert.equal(NODE_DIST, 'https://nodejs.org/dist');
  assert.ok(Object.isFrozen(SETUP_TARGETS));
  assert.equal(SETUP_TARGETS.claude.npm, '@anthropic-ai/claude-code');
  assert.equal(SETUP_TARGETS.opencode.npm, '@opencode/cli');
  assert.equal(SETUP_TARGETS.opencode.optional, true);
  assert.equal(SETUP_TARGETS.tailscale.optional, true);
  assert.deepEqual(SETUP_TARGETS.tailscale.winget.args, [
    'install',
    '--id',
    'Tailscale.Tailscale',
    '-e',
    '--accept-source-agreements',
    '--accept-package-agreements',
  ]);
  for (const target of Object.values(SETUP_TARGETS)) {
    assert.ok(Object.isFrozen(target), 'each target is frozen');
    assert.equal(Object.hasOwn(target, 'version'), false, 'no package version pin');
    assert.equal(Object.hasOwn(target, 'tag'), false, 'no dist-tag pin');
  }
});

test('isSetupTarget and nodeZipName', () => {
  assert.equal(isSetupTarget('node'), true);
  assert.equal(isSetupTarget('claude'), true);
  assert.equal(isSetupTarget('opencode'), true);
  assert.equal(isSetupTarget('tailscale'), true);
  assert.equal(isSetupTarget(SETUP_TARGETS.claude), true);
  assert.equal(isSetupTarget('nope'), false);
  assert.equal(isSetupTarget('__proto__'), false);
  assert.equal(isSetupTarget(null), false);
  assert.equal(nodeZipName('24.11.0'), 'node-v24.11.0-win-x64');
  assert.equal(nodeZipName('v24.11.0'), 'node-v24.11.0-win-x64');
  assert.equal(nodeZipName('v24.11.0', 'arm64'), 'node-v24.11.0-win-arm64');
});

// ---------- paths, shasums, hashing ----------

test('runtimePaths: one portable layout for Node, npm, cache, state and lock', () => {
  const root = path.join(TMP, 'runtime-layout');
  assert.deepEqual(runtimePaths({ runtimeDir: root }), {
    root,
    nodeRoot: path.join(root, 'node'),
    npmPrefix: path.join(root, 'npm'),
    npmCache: path.join(root, 'cache'),
    npmrc: path.join(root, 'npmrc'),
    globalNpmrc: path.join(root, 'npm', 'etc', 'npmrc'),
    stateFile: path.join(root, 'runtime.json'),
    lockFile: path.join(root, '.lock'),
    tmpDir: path.join(root, 'tmp'),
    node: path.join(root, 'node', 'current'),
  });
});

test('parseShasums: CRLF, double spaces and the binary-mode * prefix', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const c = 'c'.repeat(64);
  const map = parseShasums([`${a} *node-v24.11.0-win-x64.zip`, `${b}  npm.txt`, '', `not a checksum  file.zip`, `${c} *lain.zip`].join('\r\n'));
  assert.equal(map.get('node-v24.11.0-win-x64.zip'), a);
  assert.equal(map.get('npm.txt'), b);
  assert.equal(map.get('lain.zip'), c);
  assert.equal(map.size, 3);
  assert.equal(parseShasums('').size, 0);
});

test('sha256File hashes a file without loading it whole', async () => {
  const file = tmpPath('hash');
  const data = Buffer.from('isi file untuk sha256\n'.repeat(1000));
  writeFileSync(file, data);
  assert.equal(await sha256File(file), sha256(data));
});

// ---------- downloadVerified ----------

test('downloadVerified: HTTPS only, verified, .part renamed only at the end', async () => {
  const dest = path.join(tmpPath('download'), 'node.zip');
  const body = Buffer.from('unduhan aman\n'.repeat(200));
  const digest = sha256(body);
  const calls = [];
  const progress = [];

  const result = await downloadVerified({
    url: 'https://example.test/node.zip',
    dest,
    expectedSha256: digest,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    },
    onProgress: (p) => progress.push(p),
  });

  assert.equal(result.bytes, body.length);
  assert.equal(result.sha256, digest);
  assert.deepEqual(readFileSync(dest), body);
  assert.equal(existsSync(`${dest}.part`), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal, 'the request can be cancelled');
  assert.equal(progress.at(-1).received, body.length);
  assert.equal(progress.at(-1).total, body.length);

  await assert.rejects(
    downloadVerified({ url: 'http://example.test/node.zip', dest: `${dest}.http`, expectedSha256: digest, fetchImpl: async () => assert.fail('must not fetch') }),
    /https/i,
  );
});

test('downloadVerified: wrong checksum leaves neither dest nor .part', async () => {
  const dest = path.join(tmpPath('download'), 'bad.zip');
  const body = Buffer.from('rusak');
  await assert.rejects(
    downloadVerified({
      url: 'https://example.test/bad.zip',
      dest,
      expectedSha256: '0'.repeat(64),
      fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }),
    }),
    /SHA-256/i,
  );
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.part`), false);
});

test('downloadVerified: byte limits, lying Content-Length and non-200 are refused', async () => {
  const dir = tmpPath('download');
  const body = Buffer.from('0123456789');

  await assert.rejects(
    downloadVerified({
      url: 'https://example.test/file.zip',
      dest: path.join(dir, 'too-big.zip'),
      expectedSha256: sha256(body),
      maxBytes: 5,
      fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }),
    }),
    /batas|besar|max/i,
  );
  assert.equal(existsSync(path.join(dir, 'too-big.zip')), false);

  await assert.rejects(
    downloadVerified({
      url: 'https://example.test/file.zip',
      dest: path.join(dir, 'short.zip'),
      expectedSha256: sha256(body),
      fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length + 1) } }),
    }),
    /content-length/i,
  );
  assert.equal(existsSync(path.join(dir, 'short.zip')), false);
  assert.equal(existsSync(path.join(dir, 'short.zip.part')), false);

  await assert.rejects(
    downloadVerified({
      url: 'https://example.test/file.zip',
      dest: path.join(dir, 'error.zip'),
      expectedSha256: sha256(body),
      fetchImpl: async () => new Response('no', { status: 500 }),
    }),
    /HTTP 500/i,
  );
  assert.equal(existsSync(path.join(dir, 'error.zip')), false);
});

test('downloadVerified: abort throws { code: CANCELLED } and removes the partial file', async () => {
  const dest = path.join(tmpPath('download'), 'abort.zip');
  const controller = new AbortController();
  const body = new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('potongan pertama'));
    },
  });

  await assert.rejects(
    downloadVerified({
      url: 'https://example.test/abort.zip',
      dest,
      expectedSha256: sha256(Buffer.from('potongan pertama')),
      signal: controller.signal,
      fetchImpl: async () => new Response(body, { status: 200 }),
      onProgress: () => controller.abort(),
    }),
    (err) => err.code === 'CANCELLED',
  );
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.part`), false);
});

test('downloadVerified: an idle body times out and is cleaned up', async () => {
  const dest = path.join(tmpPath('download'), 'idle.zip');
  const body = new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('a'));
    },
  });
  await assert.rejects(
    downloadVerified({
      url: 'https://example.test/idle.zip',
      dest,
      expectedSha256: sha256(Buffer.from('a')),
      idleMs: 25,
      fetchImpl: async () => new Response(body, { status: 200 }),
    }),
    (err) => err.code === 'ETIMEDOUT',
  );
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.part`), false);
});

// ---------- extractZipSafe ----------

test('extractZipSafe: only entries under the prefix, directories created, sizes reported', async () => {
  const zipFile = await makeZip([
    ['node-v24.11.0-win-x64/', Buffer.alloc(0)],
    ['node-v24.11.0-win-x64/node.exe', Buffer.from('exe palsu')],
    ['node-v24.11.0-win-x64/npm/bin/npm-cli.js', Buffer.from('console.log(1)\n')],
  ]);
  const destDir = tmpPath('extract');
  const progress = [];
  const result = await extractZipSafe({
    zipFile,
    destDir,
    stripPrefix: 'node-v24.11.0-win-x64/',
    onProgress: (p) => progress.push(p),
  });
  assert.equal(result.entries, 3);
  assert.equal(result.bytes, Buffer.byteLength('exe palsu') + Buffer.byteLength('console.log(1)\n'));
  assert.equal(readFileSync(path.join(destDir, 'node.exe'), 'utf8'), 'exe palsu');
  assert.equal(readFileSync(path.join(destDir, 'npm', 'bin', 'npm-cli.js'), 'utf8'), 'console.log(1)\n');
  assert.ok(progress.length >= 3);
  assert.equal(progress.at(-1).bytes, result.bytes);
});

test('extractZipSafe: an entry outside the prefix is refused before anything is written', async () => {
  const zipFile = await makeZip([
    ['node-v24.11.0-win-x64/ok.txt', Buffer.from('ok')],
    ['other.txt', Buffer.from('lain')],
  ]);
  const destDir = tmpPath('extract');
  await assert.rejects(extractZipSafe({ zipFile, destDir, stripPrefix: 'node-v24.11.0-win-x64/' }), /prefix|luar/i);
  assert.equal(existsSync(path.join(destDir, 'ok.txt')), false);
  assert.equal(existsSync(path.join(destDir, 'other.txt')), false);
});

test('extractZipSafe: zip-slip names are refused (ZipReader + containment)', async () => {
  const zipFile = await makeZip([['../evil', Buffer.from('jahat')]]);
  const destDir = tmpPath('extract');
  await assert.rejects(extractZipSafe({ zipFile, destDir, stripPrefix: 'node-v24.11.0-win-x64/' }), /\.\.|ditolak|path/i);
  assert.equal(existsSync(path.join(TMP, 'evil')), false);
});

test('extractZipSafe: total byte and entry limits are checked before writing', async () => {
  const zipFile = await makeZip([
    ['node-v24.11.0-win-x64/a.txt', Buffer.alloc(8, 1)],
    ['node-v24.11.0-win-x64/b.txt', Buffer.alloc(8, 2)],
    ['node-v24.11.0-win-x64/c.txt', Buffer.alloc(8, 3)],
  ]);
  const bytesDest = tmpPath('extract');
  await assert.rejects(extractZipSafe({ zipFile, destDir: bytesDest, stripPrefix: 'node-v24.11.0-win-x64/', limits: { maxBytes: 10 } }), /batas|besar|max/i);
  assert.equal(existsSync(path.join(bytesDest, 'a.txt')), false);

  const entriesDest = tmpPath('extract');
  await assert.rejects(
    extractZipSafe({ zipFile, destDir: entriesDest, stripPrefix: 'node-v24.11.0-win-x64/', limits: { maxEntries: 2 } }),
    /entri|banyak/i,
  );
  assert.equal(existsSync(path.join(entriesDest, 'a.txt')), false);
});

test('extractZipSafe: abort (already aborted or mid-way) throws CANCELLED', async () => {
  const zipFile = await makeZip([
    ['node-v24.11.0-win-x64/a.txt', Buffer.from('a')],
    ['node-v24.11.0-win-x64/b.txt', Buffer.from('b')],
  ]);
  const firstDest = tmpPath('extract');
  await assert.rejects(
    extractZipSafe({ zipFile, destDir: firstDest, stripPrefix: 'node-v24.11.0-win-x64/', signal: AbortSignal.abort() }),
    (err) => err.code === 'CANCELLED',
  );
  assert.equal(existsSync(path.join(firstDest, 'a.txt')), false);

  const controller = new AbortController();
  const secondDest = tmpPath('extract');
  await assert.rejects(
    extractZipSafe({
      zipFile,
      destDir: secondDest,
      stripPrefix: 'node-v24.11.0-win-x64/',
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    (err) => err.code === 'CANCELLED',
  );
  assert.equal(existsSync(path.join(secondDest, 'b.txt')), false);
});

// ---------- runtime state and lock ----------

test('runtime state: atomic save, missing/corrupt state reads as null', () => {
  const root = tmpPath('state');
  assert.equal(readRuntimeState(root), null);
  saveRuntimeState(root, { version: 'v24.11.0', node: { version: 'v24.11.0' } });
  assert.deepEqual(readRuntimeState(root), { version: 'v24.11.0', node: { version: 'v24.11.0' } });
  assert.equal(existsSync(path.join(root, 'runtime.json.tmp')), false);
  writeFileSync(path.join(root, 'runtime.json'), '{ not json');
  assert.equal(readRuntimeState(root), null);
});

test('runtimeBinDirs: npm prefix and the current Node version, existing folders only', () => {
  const root = tmpPath('bins');
  const p = runtimePaths({ runtimeDir: root });
  assert.deepEqual(runtimeBinDirs(root), []);
  mkdirSync(p.npmPrefix, { recursive: true });
  assert.deepEqual(runtimeBinDirs(root), [p.npmPrefix]);
  mkdirSync(path.join(p.nodeRoot, 'v24.11.0'), { recursive: true });
  writeFileSync(path.join(p.nodeRoot, 'current.txt'), 'v24.11.0\n');
  assert.deepEqual(runtimeBinDirs(root), [p.npmPrefix, path.join(p.nodeRoot, 'v24.11.0')]);

  writeFileSync(path.join(p.nodeRoot, 'current.txt'), '../../../evil\n');
  assert.deepEqual(runtimeBinDirs(root), [p.npmPrefix], 'a malicious current.txt cannot escape node/');
});

test('withRuntimeLock: one holder at a time, always released, stale locks are stolen', async () => {
  const root = tmpPath('lock');
  const lockFile = path.join(root, '.lock');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = withRuntimeLock(root, async () => {
    await gate;
    return 'first';
  });
  for (let i = 0; i < 200 && !existsSync(lockFile); i++) await delay(5);
  assert.ok(existsSync(lockFile), 'the lock file exists while the callback runs');
  await assert.rejects(withRuntimeLock(root, () => 'second'), (err) => err.code === 'ELOCKED');
  release();
  assert.equal(await first, 'first');
  assert.equal(existsSync(lockFile), false);

  mkdirSync(root, { recursive: true });
  writeFileSync(lockFile, '{"pid":1}');
  const old = new Date(Date.now() - 31 * 60_000);
  utimesSync(lockFile, old, old);
  assert.equal(await withRuntimeLock(root, () => 'stale taken'), 'stale taken');
  assert.equal(existsSync(lockFile), false);

  await assert.rejects(
    withRuntimeLock(root, () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(existsSync(lockFile), false);
});

// ---------- installNodeRuntime ----------

test('installNodeRuntime: downloads, verifies, extracts, installs once and is idempotent', async () => {
  const version = 'v24.11.0';
  const arch = 'x64';
  const base = nodeZipName(version, arch);
  const zipFile = await makeZip([
    [`${base}/node.exe`, Buffer.from('node palsu')],
    [`${base}/npm/bin/npm-cli.js`, Buffer.from('// npm\n')],
  ]);
  const zipBuf = readFileSync(zipFile);
  const digest = sha256(zipBuf);
  const root = tmpPath('install');
  const calls = [];
  const spawned = [];
  const progress = [];

  const index = [
    { version: 'v26.0.0', lts: false, files: ['win-x64-zip'] },
    { version, lts: 'Krypton', files: ['win-x64-zip'] },
    { version: 'v24.10.0', lts: 'Krypton', files: ['win-x64-zip'] },
  ];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://nodejs.org/dist/index.json') return new Response(JSON.stringify(index), { status: 200 });
    if (url === `${NODE_DIST}/${version}/SHASUMS256.txt`) return new Response(`${digest} *${base}.zip\r\n`, { status: 200 });
    if (url === `${NODE_DIST}/${version}/${base}.zip`) return new Response(zipBuf, { status: 200, headers: { 'content-length': String(zipBuf.length) } });
    throw new Error(`URL tak terduga: ${url}`);
  };
  const spawnImpl = (command, args) => {
    spawned.push([command, ...args]);
    return { status: 0, stdout: `${version}\n`, stderr: '' };
  };

  const first = await installNodeRuntime({ runtimeDir: root, fetchImpl, spawnImpl, onProgress: (p) => progress.push(p) });
  assert.equal(first.installed, true);
  assert.equal(first.version, version);

  const p = runtimePaths({ runtimeDir: root });
  assert.ok(existsSync(path.join(p.nodeRoot, version, 'node.exe')));
  assert.ok(existsSync(path.join(p.nodeRoot, version, 'npm', 'bin', 'npm-cli.js')));
  assert.equal(readFileSync(path.join(p.nodeRoot, 'current.txt'), 'utf8').trim(), version);
  assert.ok(existsSync(p.npmPrefix), 'the npm prefix exists before npm installs anything');
  assert.equal(existsSync(p.tmpDir), false, 'tmp is removed in finally');
  const state = readRuntimeState(root);
  assert.equal(state.version, version);
  assert.equal(state.arch, arch);
  assert.equal(state.node.version, version);
  assert.deepEqual(runtimeBinDirs(root), [p.npmPrefix, path.join(p.nodeRoot, version)]);
  assert.ok(progress.some((x) => x.stage === 'download'));
  assert.ok(progress.some((x) => x.stage === 'extract'));
  if (process.platform === 'win32') assert.ok(spawned.length >= 1, 'the extracted node.exe was checked');

  const zipDownloadsBefore = calls.filter((u) => u.endsWith('.zip')).length;
  const second = await installNodeRuntime({ runtimeDir: root, fetchImpl, spawnImpl });
  assert.equal(second.installed, false);
  assert.equal(calls.filter((u) => u.endsWith('.zip')).length, zipDownloadsBefore, 'no second download');
  assert.equal(existsSync(p.tmpDir), false);
});

test('installNodeRuntime: no matching LTS is an error; abort is CANCELLED and cleans tmp', async () => {
  const root = tmpPath('install');
  const fetchImpl = async () => new Response(JSON.stringify([{ version: 'v26.0.0', lts: false, files: ['win-x64-zip'] }]), { status: 200 });
  await assert.rejects(installNodeRuntime({ runtimeDir: root, fetchImpl }), /LTS|Node\.js/i);

  const abortedRoot = tmpPath('install');
  await assert.rejects(
    installNodeRuntime({ runtimeDir: abortedRoot, signal: AbortSignal.abort(), fetchImpl }),
    (err) => err.code === 'CANCELLED',
  );
  assert.equal(existsSync(runtimePaths({ runtimeDir: abortedRoot }).tmpDir), false);
  assert.equal(existsSync(path.join(abortedRoot, '.lock')), false);
});
