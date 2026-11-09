#!/usr/bin/env node
// 🍎 macOS build: Node SEA + a minimal .app bundle. Must run on macOS: the binary is signed/notarized there
// (and postject needs the local Mach-O runtime). This script produces an UNSIGNED app for local testing.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, '.build');
const DIST = path.join(ROOT, 'dist', 'macos');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const ESBUILD = 'esbuild@0.25.12';
const POSTJECT = 'postject@1.0.0-alpha.6';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (text) => process.stdout.write(`\n▶ ${text}\n`);
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });

if (process.platform !== 'darwin') {
  process.stderr.write('Build macOS harus dijalankan di macOS (butuh runtime Mach-O + codesign/notarization).\n');
  process.exit(2);
}

step('Bersihkan output lama');
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

step('Bundle server.js → CommonJS');
run('npx', ['--yes', ESBUILD, 'server.js', '--bundle', '--platform=node', '--format=cjs', '--target=node20', `--outfile=${path.join(BUILD, 'server-mac.cjs')}`, '--log-level=warning']);

step('Siapkan blob SEA');
const seaConfig = path.join(BUILD, 'sea-mac.json');
const blob = path.join(BUILD, 'sea-mac.blob');
writeFileSync(seaConfig, `${JSON.stringify({ main: path.join(BUILD, 'server-mac.cjs'), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2)}\n`);
run(process.execPath, ['--experimental-sea-config', seaConfig]);

step('Buat bundle .app');
const app = path.join(DIST, 'Adhit Office.app');
const macos = path.join(app, 'Contents', 'MacOS');
const resources = path.join(app, 'Contents', 'Resources');
const bin = path.join(macos, 'AdhitOffice-bin');
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });
copyFileSync(process.execPath, bin);
run('npx', ['--yes', POSTJECT, bin, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE, '--macho-segment-name', 'NODE_SEA']);

for (const name of ['public', 'ai_logos', 'docs']) cpSync(path.join(ROOT, name), path.join(resources, name), { recursive: true });
cpSync(path.join(ROOT, '.claude', 'agents'), path.join(resources, '.claude', 'agents'), { recursive: true });
for (const name of ['package.json', 'README.md', 'CHANGELOG.md']) copyFileSync(path.join(ROOT, name), path.join(resources, name));
const pubkey = path.join(ROOT, 'assets', 'update-pubkey.pem');
if (existsSync(pubkey)) copyFileSync(pubkey, path.join(resources, 'update-pubkey.pem'));
writeFileSync(path.join(resources, 'CARA-PAKAI.txt'), [
  'Adhit Office (build macOS, eksperimental, belum ditandatangani)',
  '',
  'Buka Adhit Office.app (klik kanan → Open bila Gatekeeper menolak), lalu kantor terbuka di browser.',
  'Data: ~/Library/Application Support/AdhitOffice/data.',
  'Prasyarat: Claude Code dan/atau OpenCode terpasang dan login.',
  'Update otomatis build terpasang baru tersedia di Windows; untuk macOS ganti .app secara manual.',
  '',
].join('\n'));

const launcher = path.join(macos, 'AdhitOffice');
writeFileSync(launcher, [
  '#!/bin/sh',
  'DIR="$(cd "$(dirname "$0")" && pwd)"',
  'export OFFICE_APP_DIR="$DIR/../Resources"',
  '"$DIR/AdhitOffice-bin" --background &',
  'for i in $(seq 1 40); do',
  '  curl -fsS http://127.0.0.1:4317/health >/dev/null 2>&1 && break',
  '  sleep 0.5',
  'done',
  'open "http://127.0.0.1:4317"',
  'wait',
  '',
].join('\n'));
chmodSync(launcher, 0o755);
chmodSync(bin, 0o755);

writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Adhit Office</string>
  <key>CFBundleDisplayName</key><string>Adhit Office</string>
  <key>CFBundleIdentifier</key><string>com.adhit.office</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key><string>AdhitOffice</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`);

step('Ad-hoc sign (lokal; rilis tetap butuh Developer ID + notarization)');
run('codesign', ['--force', '--deep', '--sign', '-', app]);

step('Buat ZIP');
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, path.join(DIST, `AdhitOffice-${VERSION}-macos-${ARCH}-unsigned.zip`)]);

step('Selesai (belum ditandatangani)');
process.stdout.write(`\n📦 ${path.join(DIST, `AdhitOffice-${VERSION}-macos-${ARCH}-unsigned.zip`)}\n`);
process.stdout.write('Untuk rilis: codesign --deep --force --options runtime --sign "Developer ID Application: …" "Adhit Office.app", lalu xcrun notarytool submit + stapler. Lihat docs/packaging-desktop.md.\n');
