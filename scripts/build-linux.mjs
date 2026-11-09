#!/usr/bin/env node
// 🐧 Linux build: Node SEA for linux-x64, a portable .tar.gz, and a .deb (no Linux machine needed for packaging).
// The binary itself is only smoke-tested by inspecting the archive here; run it on Linux before publishing.
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, '.build');
const DIST = path.join(ROOT, 'dist', 'linux');
const PKG = path.join(BUILD, 'linux-pkg');
const APP = path.join(PKG, 'opt', 'adhitron');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const NODE_VERSION = process.version.replace(/^v/, '');
const NODE_DIR = `node-v${NODE_VERSION}-linux-x64`;
const ARCHIVE = `${NODE_DIR}.tar.gz`;
const DOWNLOAD = path.join(BUILD, 'downloads', ARCHIVE);
const POSTJECT = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (text) => process.stdout.write(`\n▶ ${text}\n`);

function run(command, args, options = {}) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    execSync([command, ...args].map((arg) => `"${String(arg).replace(/"/g, '""')}"`).join(' '), { cwd: ROOT, stdio: 'inherit', ...options });
  } else {
    execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  }
}

/** True for the files that must be executable in the Linux package. */
const isExecutable = (rel) => /(^|\/)(Adhitron|jalankan\.sh|adhitron)$/.test(rel);

/** Minimal ustar writer (Windows tar here has no --mode): modes are explicit, mtimes fixed, sorted entries. */
function tarBuffer(root, { base = '' } = {}) {
  const entries = [];
  const add = (abs, rel) => {
    const stat = statSync(abs);
    const name = (base ? `${base}/${rel}` : rel).split(path.sep).join('/').replace(/^\/+/, '');
    if (stat.isDirectory()) {
      if (name) entries.push({ name: `${name}/`, type: '5', data: Buffer.alloc(0), mode: 0o755 });
      for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        add(path.join(abs, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      }
      return;
    }
    if (stat.isFile()) entries.push({ name, type: '0', data: readFileSync(abs), mode: isExecutable(name) ? 0o755 : 0o644 });
  };
  add(root, '');
  const header = (entry) => {
    const h = Buffer.alloc(512, 0);
    let name = entry.name;
    let prefix = '';
    if (Buffer.byteLength(name, 'utf8') > 100) {
      const split = name.lastIndexOf('/', name.length - 100);
      if (split <= 0 || split > 155) throw new Error(`Nama file terlalu panjang untuk tar: ${name}`);
      prefix = name.slice(0, split);
      name = name.slice(split + 1);
    }
    h.write(name, 0, 100, 'utf8');
    h.write(prefix, 345, 155, 'utf8');
    h.write(`${entry.mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
    h.write(`${'0'.padStart(7, '0')}\0`, 108, 8, 'ascii');
    h.write(`${'0'.padStart(7, '0')}\0`, 116, 8, 'ascii');
    h.write(`${entry.data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    h.write(`${'0'.padStart(11, '0')}\0`, 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    h.write(entry.type, 156, 1, 'ascii');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    h.write('root', 265, 32, 'ascii');
    h.write('root', 297, 32, 'ascii');
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return h;
  };
  const parts = [];
  for (const entry of entries) {
    parts.push(header(entry), entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

function writeTarGz(root, out, options) {
  writeFileSync(out, gzipSync(tarBuffer(root, options), { level: 9 }));
}

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** A symlinked doc (e.g. ~/.ssh/id_rsa) must never be packaged as if it were a normal file. */
function assertNoSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (lstatSync(full).isSymbolicLink()) throw new Error(`Symlink ditolak saat build: ${full}`);
    if (entry.isDirectory()) assertNoSymlinks(full);
  }
}

async function download(url, file) {
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  process.stdout.write(`  mengunduh ${url}\n`);
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new Error(`Unduhan gagal: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(file, bytes);
}

function writeAr(files, out) {
  const chunks = [Buffer.from('!<arch>\n')];
  for (const { name, data } of files) {
    const header = Buffer.alloc(60, 0x20);
    const put = (value, at, len) => header.write(String(value).slice(0, len).padEnd(len, ' '), at, len, 'ascii');
    put(`${name}/`, 0, 16);
    put(0, 16, 12);
    put(0, 28, 6);
    put(0, 34, 6);
    put('100644', 40, 8);
    put(data.length, 48, 10);
    header.write('`\n', 58, 2, 'ascii');
    chunks.push(header, data);
    if (data.length % 2) chunks.push(Buffer.from('\n'));
  }
  writeFileSync(out, Buffer.concat(chunks));
}

step('Bersihkan output lama');
rmSync(DIST, { recursive: true, force: true });
rmSync(PKG, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
mkdirSync(APP, { recursive: true });

step('Bundle server.js → CommonJS');
await build({ entryPoints: [path.join(ROOT, 'server.js')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: path.join(BUILD, 'server-linux.cjs'), logLevel: 'warning' });

step('Siapkan blob SEA');
const seaConfig = path.join(BUILD, 'sea-linux.json');
const blob = path.join(BUILD, 'sea-linux.blob');
writeFileSync(seaConfig, `${JSON.stringify({ main: path.join(BUILD, 'server-linux.cjs'), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2)}\n`);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: ROOT, stdio: 'inherit' });

step(`Unduh runtime Node ${NODE_VERSION} (linux-x64)`);
await download(`https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}`, DOWNLOAD);
const sumsResponse = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) });
if (!sumsResponse.ok) throw new Error(`SHASUMS256.txt tidak bisa diunduh (${sumsResponse.status}).`);
const sums = await sumsResponse.text();
const expectedNode = sums.split('\n').map((line) => line.trim().split(/\s+/)).find((parts) => parts[1]?.replace(/^\*/, '') === ARCHIVE)?.[0]?.toLowerCase();
if (!expectedNode) throw new Error('Hash runtime Node tidak ada di SHASUMS256.txt.');
if (sha256File(DOWNLOAD) !== expectedNode) throw new Error('SHA-256 runtime Node tidak cocok; build dibatalkan.');
run('tar', ['-xzf', DOWNLOAD, '-C', BUILD, `${NODE_DIR}/bin/node`]);
const linuxNode = path.join(BUILD, NODE_DIR, 'bin', 'node');
if (!existsSync(linuxNode)) throw new Error(`Node Linux tidak ditemukan: ${linuxNode}`);
copyFileSync(linuxNode, path.join(APP, 'Adhitron'));
execFileSync(process.execPath, [POSTJECT, path.join(APP, 'Adhitron'), 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE], { cwd: ROOT, stdio: 'inherit' });

step('Salin aset web');
for (const name of ['public', 'ai_logos', 'docs']) assertNoSymlinks(path.join(ROOT, name));
for (const name of ['public', 'ai_logos', 'docs']) cpSync(path.join(ROOT, name), path.join(APP, name), { recursive: true });
cpSync(path.join(ROOT, '.claude', 'agents'), path.join(APP, '.claude', 'agents'), { recursive: true });
for (const name of ['package.json', 'README.md', 'CHANGELOG.md']) copyFileSync(path.join(ROOT, name), path.join(APP, name));
const pubkey = path.join(ROOT, 'assets', 'update-pubkey.pem');
if (existsSync(pubkey)) copyFileSync(pubkey, path.join(APP, 'update-pubkey.pem'));
writeFileSync(path.join(APP, 'CARA-PAKAI.txt'), [
  'Adhitron (build Linux x64, eksperimental)',
  '',
  'Portable: ./Adhitron --background lalu buka http://127.0.0.1:4317',
  'Data: ~/.local/share/adhit-office/data (nama folder lama, sengaja tidak berubah; mode portable: buat file "portable" di folder ini).',
  'Prasyarat: Claude Code dan/atau OpenCode terpasang dan login.',
  'Belum ditandatangani/notarized; update otomatis untuk build terpasang baru tersedia di Windows.',
  '',
].join('\n'));

step('Buat launcher, desktop entry, dan systemd user unit');
const BIN = path.join(PKG, 'usr', 'bin');
const APPLICATIONS = path.join(PKG, 'usr', 'share', 'applications');
const ICONS = path.join(PKG, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps');
const UNITS = path.join(PKG, 'usr', 'lib', 'systemd', 'user');
for (const dir of [BIN, APPLICATIONS, ICONS, UNITS]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(BIN, 'adhitron'), '#!/bin/sh\nexec /opt/adhitron/Adhitron "$@"\n');
chmodSync(path.join(BIN, 'adhitron'), 0o755);
writeFileSync(path.join(APPLICATIONS, 'adhitron.desktop'), [
  '[Desktop Entry]',
  'Type=Application',
  'Name=Adhitron',
  'Comment=Kantor pixel-art untuk Claude Code dan OpenCode',
  'Exec=adhitron',
  'Icon=adhitron',
  'Terminal=false',
  'Categories=Development;',
  'StartupWMClass=Adhitron',
  '',
].join('\n'));
copyFileSync(path.join(ROOT, 'public', 'icons', 'icon-512.png'), path.join(ICONS, 'adhitron.png'));
writeFileSync(path.join(UNITS, 'adhitron.service'), [
  '[Unit]',
  'Description=Adhitron',
  'After=network-online.target',
  '',
  '[Service]',
  'Type=simple',
  // Login shell so claude/opencode from nvm or ~/.local/bin are on PATH; hardening where available.
  'ExecStart=/bin/sh -lc \'exec /opt/adhitron/Adhitron --background\'',
  'Restart=on-failure',
  'RestartSec=5',
  'NoNewPrivileges=true',
  'PrivateTmp=true',
  'ProtectSystem=strict',
  'ProtectHome=read-only',
  // The data dir keeps its old name ("adhit-office") on purpose, so existing history is not orphaned.
  'ReadWritePaths=-%h/.local/share/adhit-office -%h/.claude -%h/.config/opencode',
  '',
  '[Install]',
  'WantedBy=default.target',
  '',
].join('\n'));

step('Buat tarball portable');
const tarRoot = path.join(BUILD, 'linux-tar', 'Adhitron-linux-x64');
rmSync(path.dirname(tarRoot), { recursive: true, force: true });
mkdirSync(tarRoot, { recursive: true });
cpSync(APP, tarRoot, { recursive: true });
writeFileSync(path.join(tarRoot, 'jalankan.sh'), '#!/bin/sh\ncd "$(dirname "$0")"\nexec ./Adhitron --background\n');
writeTarGz(tarRoot, path.join(DIST, `Adhitron-${VERSION}-linux-x64.tar.gz`), { base: path.basename(tarRoot) });

step('Buat paket .deb');
const dataDir = path.join(BUILD, 'deb-data');
const controlDir = path.join(BUILD, 'deb-control');
rmSync(dataDir, { recursive: true, force: true });
rmSync(controlDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(controlDir, { recursive: true });
cpSync(PKG, dataDir, { recursive: true });
writeFileSync(path.join(controlDir, 'control'), [
  'Package: adhitron',
  `Version: ${VERSION}`,
  'Section: utils',
  'Priority: optional',
  'Architecture: amd64',
  'Maintainer: Adhit <noreply@localhost>',
  'Depends: libc6',
  // The package was renamed; replace the old one instead of letting both services run on port 4317.
  'Conflicts: adhit-office',
  'Replaces: adhit-office',
  'Recommends: systemd',
  'Description: Adhitron',
  ' Kantor pixel-art untuk mengoperasikan Claude Code dan OpenCode dari browser dan HP.',
  ' UI disajikan lokal di http://127.0.0.1:4317; data di ~/.local/share/adhit-office/data (nama folder lama).',
  '',
].join('\n'));
// No maintainer scripts: `systemctl --global enable` would start a per-user server for every account without
// consent. The unit is installed and documented; each user opts in explicitly.

const controlTar = path.join(BUILD, 'control.tar.gz');
const dataTar = path.join(BUILD, 'data.tar.gz');
writeTarGz(controlDir, controlTar, { base: '.' });
writeTarGz(dataDir, dataTar, { base: '.' });
writeAr([
  { name: 'debian-binary', data: Buffer.from('2.0\n') },
  { name: 'control.tar.gz', data: readFileSync(controlTar) },
  { name: 'data.tar.gz', data: readFileSync(dataTar) },
], path.join(DIST, `adhitron_${VERSION}_amd64.deb`));

step('Selesai');
process.stdout.write(`\n📦 ${path.join(DIST, `Adhitron-${VERSION}-linux-x64.tar.gz`)}\n📦 ${path.join(DIST, `adhitron_${VERSION}_amd64.deb`)}\n`);
