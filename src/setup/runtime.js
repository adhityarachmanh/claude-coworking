// Portable runtime for setup: one Node.js LTS under <runtimeDir>/node/<version>, npm's prefix and cache beside it,
// a verified download, ZIP extraction that cannot escape its folder, and a small process lock. No dependencies.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { ZipReader } from '../zip.js';
import { NODE_DIST, NODE_MAJOR, nodeZipName } from './packages.js';

const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_IDLE_MS = 30_000;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ARCHIVE_BYTES = 700 * 1024 * 1024;
const LOCK_STALE_MS = 30 * 60_000;
const VERSION_RE = /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

// ---------- errors ----------

/** An aborted setup step: every caller can test `err.code === 'CANCELLED'`. */
export function cancelledError(message = 'Setup dibatalkan.') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'CANCELLED';
  return err;
}

function timeoutError(ms) {
  const err = new Error(`Unduhan berhenti selama ${ms} ms (tidak ada data masuk).`);
  err.code = 'ETIMEDOUT';
  return err;
}

function isAbortLike(err) {
  return err?.code === 'CANCELLED' || err?.code === 'ABORT_ERR' || err?.name === 'AbortError';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

// ---------- layout ----------

/**
 * Every path of the portable runtime. `node` is the stable "current install" path; the versioned folder is
 * `<nodeRoot>/<version>` and `current.txt` inside nodeRoot says which one it is.
 */
export function runtimePaths({ runtimeDir } = {}) {
  if (typeof runtimeDir !== 'string' || !runtimeDir) throw new TypeError('runtimeDir wajib diisi.');
  const root = path.resolve(runtimeDir);
  const nodeRoot = path.join(root, 'node');
  return {
    root,
    nodeRoot,
    npmPrefix: path.join(root, 'npm'),
    npmCache: path.join(root, 'cache'),
    npmrc: path.join(root, 'npmrc'),
    globalNpmrc: path.join(root, 'npm', 'etc', 'npmrc'),
    stateFile: path.join(root, 'runtime.json'),
    lockFile: path.join(root, '.lock'),
    tmpDir: path.join(root, 'tmp'),
    node: path.join(nodeRoot, 'current'),
  };
}

function currentFile(paths) {
  return path.join(paths.nodeRoot, 'current.txt');
}

function normalizeVersion(value) {
  return String(value ?? '')
    .trim()
    .replace(/^v/i, '');
}

function validVersion(value) {
  return typeof value === 'string' && VERSION_RE.test(value.trim());
}

function versionFromState(state) {
  const raw = state?.node?.version ?? state?.version;
  return validVersion(raw) ? raw.trim() : null;
}

function readCurrentVersion(nodeRoot) {
  try {
    const value = readFileSync(path.join(nodeRoot, 'current.txt'), 'utf8').trim();
    return validVersion(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------- shasums and hashing ----------

/** SHASUMS256.txt → Map(file name → lowercase SHA-256). Accepts CRLF, repeated spaces and the `*` marker. */
export function parseShasums(text) {
  const sums = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** SHA-256 of a file on disk, streamed (never loads the whole archive into memory). */
export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// ---------- verified download ----------

/**
 * Downloads `url` to `dest` only when it is HTTPS, the body matches Content-Length, it stays under `maxBytes`, it
 * does not stall for `idleMs`, and its SHA-256 equals `expectedSha256`. The body is written to `dest.part` and only
 * renamed after every check; any error/abort removes the partial file.
 * @returns {Promise<{ bytes: number, sha256: string }>}
 */
export async function downloadVerified({
  url,
  dest,
  expectedSha256,
  signal,
  maxBytes = MAX_DOWNLOAD_BYTES,
  idleMs = DOWNLOAD_IDLE_MS,
  onProgress,
  fetchImpl = fetch,
} = {}) {
  if (typeof dest !== 'string' || !dest) throw new TypeError('dest wajib diisi.');
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new TypeError(`URL unduhan tidak valid: ${url}`);
  }
  if (target.protocol !== 'https:') throw new Error('Unduhan harus memakai HTTPS.');
  const expected = String(expectedSha256 ?? '')
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new TypeError('expectedSha256 harus berupa SHA-256 heksadesimal 64 digit.');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes harus berupa angka positif.');
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new TypeError('idleMs harus berupa angka positif.');
  throwIfAborted(signal);

  const part = `${dest}.part`;
  await mkdir(path.dirname(dest), { recursive: true });
  await rm(part, { force: true });

  const controller = new AbortController();
  let outerAborted = false;
  let timedOut = false;
  let timer = null;
  let fileHandle = null;
  let reader = null;

  const onOuterAbort = () => {
    outerAborted = true;
    controller.abort(cancelledError());
  };
  if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await fetchImpl(target.href, {
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/octet-stream' },
    });
    if (!response || response.status !== 200) throw new Error(`Unduhan gagal (HTTP ${response?.status ?? 'tidak ada respons'}).`);
    const rawLength = response.headers?.get?.('content-length');
    const declared = rawLength != null && /^\d+$/.test(String(rawLength).trim()) ? Number(rawLength) : null;
    if (declared != null && declared > maxBytes) throw new Error(`Ukuran unduhan melebihi batas ${maxBytes} byte.`);
    if (!response.body) throw new Error('Respons unduhan tidak berisi data.');

    reader = response.body.getReader();
    fileHandle = await open(part, 'wx');
    const hash = createHash('sha256');

    const armIdle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError(idleMs));
      }, idleMs);
    };
    // reader.read() does not know about our AbortController: race it with the abort reason so a stalled (or
    // cancelled) body rejects immediately instead of waiting for the next byte.
    const readChunk = () =>
      new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          reject(controller.signal.reason ?? cancelledError());
        };
        if (controller.signal.aborted) return onAbort();
        controller.signal.addEventListener('abort', onAbort, { once: true });
        reader.read().then(
          (value) => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (err) => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener('abort', onAbort);
            reject(err);
          },
        );
      });

    let received = 0;
    armIdle();
    for (;;) {
      if (signal?.aborted) {
        outerAborted = true;
        throw cancelledError();
      }
      const { done, value } = await readChunk();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.length;
      if (received > maxBytes) throw new Error(`Ukuran unduhan melebihi batas ${maxBytes} byte.`);
      hash.update(chunk);
      await fileHandle.write(chunk);
      armIdle();
      if (typeof onProgress === 'function') onProgress({ received, total: declared });
    }

    if (declared != null && received !== declared) throw new Error(`Content-Length tidak cocok: ${declared} byte dinyatakan, ${received} diterima.`);
    const actual = hash.digest('hex');
    if (actual !== expected) throw new Error(`Checksum SHA-256 tidak cocok: diharapkan ${expected}, didapat ${actual}.`);
    await fileHandle.close();
    fileHandle = null;
    await rename(part, dest);
    return { bytes: received, sha256: actual };
  } catch (err) {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
      fileHandle = null;
    }
    if (reader) {
      await reader.cancel().catch(() => {});
      reader = null;
    }
    await rm(part, { force: true }).catch(() => {});
    if (signal?.aborted || outerAborted) throw cancelledError();
    if (timedOut) throw timeoutError(idleMs);
    if (isAbortLike(err)) throw cancelledError();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

// ---------- safe extraction ----------

async function writeZipEntry(zip, entry, out, signal) {
  throwIfAborted(signal);
  const sink = createWriteStream(out, { flags: 'w' });
  let abortErr = null;
  const onAbort = () => {
    abortErr = cancelledError();
    sink.destroy(abortErr);
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    await zip.pipeTo(entry, sink);
    if (abortErr || signal?.aborted) throw abortErr ?? cancelledError();
  } catch (err) {
    await rm(out, { force: true }).catch(() => {});
    if (abortErr || signal?.aborted) throw abortErr ?? cancelledError();
    if (isAbortLike(err)) throw cancelledError();
    throw err;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Extracts a trusted-shape archive (Node.js distribution) below `destDir`, keeping only entries with `stripPrefix`.
 * Every entry is validated (prefix, path containment, count, total size) before the first byte is written.
 * @returns {Promise<{ entries: number, bytes: number }>}
 */
export async function extractZipSafe({
  zipFile,
  destDir,
  stripPrefix,
  signal,
  limits = {},
  onProgress,
} = {}) {
  throwIfAborted(signal);
  const maxEntries = Number.isFinite(limits?.maxEntries) && limits.maxEntries > 0 ? limits.maxEntries : MAX_ARCHIVE_ENTRIES;
  const maxBytes = Number.isFinite(limits?.maxBytes) && limits.maxBytes > 0 ? limits.maxBytes : MAX_ARCHIVE_BYTES;
  const prefix = String(stripPrefix ?? '');
  if (!prefix || !prefix.endsWith('/') || prefix.startsWith('/') || prefix.includes('\\') || prefix.includes(':')) {
    throw new TypeError('stripPrefix harus berupa folder relatif berakhiran "/".');
  }
  const prefixParts = prefix.slice(0, -1).split('/');
  if (prefixParts.some((part) => !part || part === '.' || part === '..')) throw new TypeError('stripPrefix tidak aman.');

  const destRoot = path.resolve(destDir);
  const zip = await ZipReader.open(zipFile, { maxEntries });
  try {
    if (zip.entries.length > maxEntries) throw new Error(`ZIP berisi terlalu banyak entri (${zip.entries.length}).`);
    const planned = [];
    let totalBytes = 0;

    for (const entry of zip.entries) {
      if (!entry.name.startsWith(prefix)) throw new Error(`Entri "${entry.name}" di luar prefix "${prefix}".`);
      const relative = entry.name.slice(prefix.length).replace(/\/+$/, '');
      if (!relative) {
        if (!entry.isDir) throw new Error(`Entri "${entry.name}" bukan folder.`);
        planned.push({ entry, target: destRoot, dir: true });
        continue;
      }
      const parts = relative.split('/');
      if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Entri "${entry.name}" memakai path yang tidak aman.`);
      const target = path.resolve(destRoot, ...parts);
      const inside = path.relative(destRoot, target);
      if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
        throw new Error(`Entri "${entry.name}" akan ditulis di luar folder tujuan.`);
      }
      if (!entry.isDir) totalBytes += entry.usize;
      planned.push({ entry, target, dir: entry.isDir });
    }
    if (totalBytes > maxBytes) throw new Error(`Ukuran isi ZIP melebihi batas ${maxBytes} byte.`);

    await mkdir(destRoot, { recursive: true });
    let entries = 0;
    let bytes = 0;
    for (const item of planned) {
      throwIfAborted(signal);
      if (item.dir) {
        await mkdir(item.target, { recursive: true });
      } else {
        await mkdir(path.dirname(item.target), { recursive: true });
        await writeZipEntry(zip, item.entry, item.target, signal);
        bytes += item.entry.usize;
      }
      entries++;
      if (typeof onProgress === 'function') {
        onProgress({ name: item.entry.name, entries, totalEntries: planned.length, bytes, totalBytes });
      }
    }
    return { entries, bytes };
  } catch (err) {
    if (signal?.aborted || isAbortLike(err)) throw cancelledError();
    throw err;
  } finally {
    await zip.close();
  }
}

// ---------- persistent state ----------

/** runtime.json, or null when it is missing/corrupt (setup then treats the runtime as absent). */
export function readRuntimeState(runtimeDir) {
  try {
    const value = JSON.parse(readFileSync(runtimePaths({ runtimeDir }).stateFile, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Writes runtime.json through runtime.json.tmp and renames, so a crash never leaves half a JSON file. */
export function saveRuntimeState(runtimeDir, state) {
  const paths = runtimePaths({ runtimeDir });
  mkdirSync(paths.root, { recursive: true });
  const tmp = `${paths.stateFile}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, paths.stateFile);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // no temp file to remove
    }
    throw err;
  }
  return paths.stateFile;
}

/** npm's folder and the current Node folder, for PATH-like use; missing folders are omitted. */
export function runtimeBinDirs(runtimeDir) {
  const paths = runtimePaths({ runtimeDir });
  const current = readCurrentVersion(paths.nodeRoot) ?? versionFromState(readRuntimeState(runtimeDir));
  const dirs = [];
  if (existsSync(paths.npmPrefix)) dirs.push(paths.npmPrefix);
  if (current) {
    const nodeDir = path.join(paths.nodeRoot, current);
    if (existsSync(nodeDir)) dirs.push(nodeDir);
  }
  return dirs;
}

/**
 * The active Node installation in the portable runtime, or null when none was installed yet.
 * `dir` is the version folder (node.exe lives there); `npmCli` is npm's entry point inside the same folder.
 * The portable runtime is ALWAYS the Windows layout (installNodeRuntime downloads the win-x64 zip on every
 * host), so the binary is node.exe regardless of the OS this process runs on.
 */
export function activeNode(runtimeDir) {
  const paths = runtimePaths({ runtimeDir });
  const version = readCurrentVersion(paths.nodeRoot) ?? versionFromState(readRuntimeState(runtimeDir));
  if (!version) return null;
  const dir = path.join(paths.nodeRoot, version);
  const exe = path.join(dir, 'node.exe');
  if (!existsSync(exe)) return null;
  return { version, dir, exe, npmCli: path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js') };
}

// ---------- process lock ----------

function lockError(lockFile) {
  const err = new Error(`Runtime sedang dipakai proses lain (${lockFile}).`);
  err.code = 'ELOCKED';
  return err;
}

/**
 * Runs `fn` while holding <runtimeDir>/.lock. A lock older than 30 minutes is stale and may be taken over.
 * The lock is always removed at the end (success, error or abort).
 */
export async function withRuntimeLock(runtimeDir, fn) {
  if (typeof fn !== 'function') throw new TypeError('fn harus berupa fungsi.');
  const paths = runtimePaths({ runtimeDir });
  mkdirSync(paths.root, { recursive: true });

  let fd = null;
  for (let attempt = 0; attempt < 3 && fd === null; attempt++) {
    try {
      fd = openSync(paths.lockFile, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age;
      try {
        age = Date.now() - statSync(paths.lockFile).mtimeMs;
      } catch (statErr) {
        if (statErr.code === 'ENOENT') continue; // released between open and stat: try again
        throw statErr;
      }
      if (age <= LOCK_STALE_MS) throw lockError(paths.lockFile);
      try {
        unlinkSync(paths.lockFile);
      } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
      }
    }
  }
  if (fd === null) throw lockError(paths.lockFile);

  try {
    try {
      writeSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
    } catch (err) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      try {
        unlinkSync(paths.lockFile);
      } catch {
        // nothing to remove
      }
      throw err;
    }
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    try {
      unlinkSync(paths.lockFile);
    } catch {
      // someone else already removed a stale lock
    }
  }
}

// ---------- Node runtime installation ----------

function semverParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const left = semverParts(a) ?? [0, 0, 0];
  const right = semverParts(b) ?? [0, 0, 0];
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** The portable runtime's Node binary: node.exe on every host (the win-x64 zip layout). */
function nodeBinary(dir) {
  return path.join(dir, 'node.exe');
}

/** True when dir contains the expected Node binary (and, on a Windows host, it answers `--version`). */
function nodeBinaryWorks(dir, version, hostPlatform, spawnImpl) {
  const exe = nodeBinary(dir);
  if (!existsSync(exe)) return false;
  if (hostPlatform !== 'win32') return true; // a Windows PE cannot be executed on another host: existence is the check
  try {
    const result = spawnImpl(exe, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!result || result.error || result.status !== 0) return false;
    return normalizeVersion(result.stdout) === normalizeVersion(version);
  } catch {
    return false;
  }
}

function writeCurrentVersion(paths, version) {
  mkdirSync(paths.nodeRoot, { recursive: true });
  const file = currentFile(paths);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${version}\n`);
  renameSync(tmp, file);
}

function writeInstallState(paths, { version, arch, target, platform, reused }) {
  const relative = (file) => path.relative(paths.root, file).split(path.sep).join('/');
  const state = {
    version,
    arch,
    node: { version, dir: relative(target) },
    npm: { prefix: relative(paths.npmPrefix), cache: relative(paths.npmCache) },
    platform,
    reused,
    installedAt: new Date().toISOString(),
  };
  saveRuntimeState(paths.root, state);
  writeCurrentVersion(paths, version);
  return state;
}

async function fetchText(url, { fetchImpl, signal }) {
  throwIfAborted(signal);
  const response = await fetchImpl(url, { redirect: 'error', signal, headers: { accept: 'text/plain, application/json' } });
  if (!response || response.status !== 200) throw new Error(`Gagal mengunduh ${url} (HTTP ${response?.status ?? 'tidak ada respons'}).`);
  throwIfAborted(signal);
  const text = await response.text();
  throwIfAborted(signal);
  return text;
}

function safeRemove(target) {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // cleanup is best effort; the original error is more useful
  }
}

/**
 * Installs the latest Node.js LTS of `major` into the portable runtime:
 * index.json → SHASUMS256.txt → verified zip in tmp/ → node/.tmp-<version> → node.exe --version → node/<version>.
 * A valid existing install is reused (installed: false) without downloading again.
 * @returns {Promise<{ installed: boolean, version: string, dir: string }>}
 */
export async function installNodeRuntime({
  runtimeDir,
  major = NODE_MAJOR,
  arch = 'x64',
  signal,
  onProgress,
  fetchImpl = fetch,
  indexUrl = `${NODE_DIST}/index.json`,
  log,
  spawnImpl = spawnSync,
} = {}) {
  const paths = runtimePaths({ runtimeDir });
  const say = (message) => {
    if (typeof log !== 'function') return;
    try {
      log(message);
    } catch {
      // logging must never break setup
    }
  };
  const report = (stage) => (info) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ stage, ...info });
    } catch {
      // a progress renderer must never break setup
    }
  };

  return withRuntimeLock(runtimeDir, async () => {
    let staging = null;
    try {
      throwIfAborted(signal);
      const majorNumber = Number(major);
      if (!Number.isInteger(majorNumber) || majorNumber <= 0) throw new TypeError(`Major Node.js tidak valid: ${major}`);
      if (!/^[a-z0-9]+$/i.test(String(arch))) throw new TypeError(`Arsitektur tidak valid: ${arch}`);

      say('Membaca daftar rilis Node.js…');
      const indexText = await fetchText(indexUrl, { fetchImpl, signal });
      let index;
      try {
        index = JSON.parse(indexText);
      } catch {
        throw new Error('Daftar rilis Node.js tidak valid (bukan JSON).');
      }
      if (!Array.isArray(index)) throw new Error('Daftar rilis Node.js tidak valid.');

      const wantedFile = `win-${arch}-zip`;
      const candidates = index
        .filter(
          (entry) =>
            entry &&
            entry.lts &&
            typeof entry.version === 'string' &&
            semverParts(entry.version)?.[0] === majorNumber &&
            Array.isArray(entry.files) &&
            entry.files.includes(wantedFile),
        )
        .sort((a, b) => compareVersions(b.version, a.version));
      if (!candidates.length) {
        throw new Error(`Tidak ada Node.js ${majorNumber} LTS dengan arsip ${wantedFile} di ${indexUrl}.`);
      }

      const rawVersion = String(candidates[0].version).trim();
      const version = rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`;
      const base = nodeZipName(version, arch);
      const zipName = `${base}.zip`;
      const target = path.join(paths.nodeRoot, version);

      mkdirSync(paths.nodeRoot, { recursive: true });
      mkdirSync(paths.npmPrefix, { recursive: true });
      mkdirSync(paths.npmCache, { recursive: true });

      if (nodeBinaryWorks(target, version, process.platform, spawnImpl)) {
        say(`Node.js ${version} sudah terpasang.`);
        writeInstallState(paths, { version, arch, target, platform: 'win32', reused: true }); // the zip layout is win-x64 on every host
        return { installed: false, version, dir: target };
      }

      say('Membaca checksum resmi Node.js…');
      const shasums = parseShasums(await fetchText(`${NODE_DIST}/${version}/SHASUMS256.txt`, { fetchImpl, signal }));
      const expectedSha256 = shasums.get(zipName);
      if (!expectedSha256) throw new Error(`Checksum ${zipName} tidak ada di SHASUMS256.txt Node.js ${version}.`);

      mkdirSync(paths.tmpDir, { recursive: true });
      const zipPath = path.join(paths.tmpDir, zipName);
      say(`Mengunduh Node.js ${version} (${arch})…`);
      const download = await downloadVerified({
        url: `${NODE_DIST}/${version}/${zipName}`,
        dest: zipPath,
        expectedSha256,
        signal,
        onProgress: report('download'),
        fetchImpl,
      });
      say(`${download.bytes} byte terverifikasi.`);

      staging = path.join(paths.nodeRoot, `.tmp-${version}`);
      safeRemove(staging);
      say('Mengekstrak Node.js…');
      await extractZipSafe({
        zipFile: zipPath,
        destDir: staging,
        stripPrefix: `${base}/`,
        signal,
        onProgress: report('extract'),
      });
      if (!nodeBinaryWorks(staging, version, process.platform, spawnImpl)) {
        throw new Error(`Node.js ${version} hasil ekstraksi tidak bisa dijalankan.`);
      }

      if (existsSync(target)) safeRemove(target);
      renameSync(staging, target);
      staging = null;
      say(`Node.js ${version} terpasang di ${target}.`);
      writeInstallState(paths, { version, arch, target, platform: 'win32', reused: false }); // the zip layout is win-x64 on every host
      return { installed: true, version, dir: target };
    } catch (err) {
      if (signal?.aborted || isAbortLike(err)) throw cancelledError();
      throw err;
    } finally {
      safeRemove(paths.tmpDir);
      if (staging) safeRemove(staging);
    }
  });
}
