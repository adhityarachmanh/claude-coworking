#!/usr/bin/env node
// 📦 Windows build (spike): bundle the server into one executable with Node SEA, then copy the web assets next to it.
// Usage: node scripts/build-windows.mjs
// Output: dist/Adhitron/Adhitron.exe + public/ + ai_logos/ + package.json
//
// No runtime dependencies are added to the app: esbuild/postject are fetched with npx at build time.
import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, '.build');
const DIST = path.join(ROOT, 'dist', 'Adhitron');
const EXE = path.join(DIST, 'Adhitron.exe');
const POSTJECT = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** Windows cannot spawn .cmd files directly (Node 26); go through cmd.exe with every argument quoted. */
function run(command, args) {
  if (process.platform === 'win32') {
    const line = [command, ...args].map((arg) => `"${String(arg).replace(/"/g, '""')}"`).join(' ');
    execSync(line, { cwd: ROOT, stdio: 'inherit' });
  } else {
    execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  }
}

const step = (text) => process.stdout.write(`\n▶ ${text}\n`);

step('Bersihkan output lama');
rmSync(BUILD, { recursive: true, force: true });
rmSync(DIST, { recursive: true, force: true });
rmSync(path.join(ROOT, 'dist', 'electron'), { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
mkdirSync(DIST, { recursive: true });

step('Bundle server.js → satu file CommonJS');
await build({ entryPoints: [path.join(ROOT, 'server.js')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: path.join(BUILD, 'server.cjs'), logLevel: 'warning' });
// `import.meta` is empty in CJS; server.js falls back to process.execPath in that case (see APP_DIR).

step('Siapkan konfigurasi SEA');
const seaConfig = path.join(BUILD, 'sea-config.json');
const blob = path.join(BUILD, 'sea-prep.blob');
writeFileSync(seaConfig, `${JSON.stringify({ main: path.join(BUILD, 'server.cjs'), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2)}\n`);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: ROOT, stdio: 'inherit' });
if (!existsSync(blob)) throw new Error('SEA blob tidak dibuat.');

step('Salin runtime Node ke executable aplikasi');
copyFileSync(process.execPath, EXE);

step('Suntikkan blob SEA');
execFileSync(process.execPath, [POSTJECT, EXE, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE], { cwd: ROOT, stdio: 'inherit' });

step('Salin aset web dan metadata');
for (const name of ['public', 'ai_logos']) cpSync(path.join(ROOT, name), path.join(DIST, name), { recursive: true });
cpSync(path.join(ROOT, '.claude', 'agents'), path.join(DIST, '.claude', 'agents'), { recursive: true });
for (const name of ['package.json', 'README.md', 'CHANGELOG.md']) copyFileSync(path.join(ROOT, name), path.join(DIST, name));
cpSync(path.join(ROOT, 'docs'), path.join(DIST, 'docs'), { recursive: true });
const pubkey = path.join(ROOT, 'assets', 'update-pubkey.pem');
if (existsSync(pubkey)) copyFileSync(pubkey, path.join(DIST, 'update-pubkey.pem'));
if (existsSync(path.join(DIST, 'data')) || existsSync(path.join(DIST, 'portable'))) throw new Error('Folder data/portable ikut di dist; hapus sebelum membuat installer.');
writeFileSync(path.join(DIST, 'CARA-PAKAI.txt'), [
  'Adhitron (build Windows, eksperimental)',
  '',
  '1. Jalankan Adhitron.exe. Data disimpan di %LOCALAPPDATA%\\AdhitOffice\\data (nama folder lama, sengaja tidak berubah).',
  '2. Buka http://127.0.0.1:4317 di browser (atau pasang sebagai aplikasi/PWA).',
  '3. Belum punya Node.js/Claude Code/OpenCode? Buka 🧰 Persiapan di ⚙ → Sistem (atau wizard yang muncul di instalasi baru): semua dipasang ke folder aplikasi, tanpa admin.',
  '',
  'Mode Desktop: jalankan Adhitron Desktop dari Start Menu (Electron).',
  'Mode portable: buat file bernama "portable" di folder ini; data akan disimpan di .\\data.',
  'Update: ⚙ Sistem → Update aplikasi (GitHub Releases + verifikasi SHA-256/tanda tangan bila tersedia).',
  'Build ini belum ditandatangani; SmartScreen akan memperingatkan.',
  '',
].join('\r\n'));

step('Build Electron shell');
const electronBuilder = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
if (!existsSync(electronBuilder)) {
  throw new Error('Electron belum terpasang. Jalankan `npm install` sekali sebelum build.');
}
run(electronBuilder, ['--win', '--dir', '--config', path.join(ROOT, 'desktop', 'electron-builder.yml')]);

step('Selesai');
process.stdout.write(`\n📦 ${EXE}\n`);

// ---- Installer (Inno Setup). Optional: the portable folder above still works when ISCC is not installed. ----
const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const iscc = findIscc();
if (!iscc) {
  process.stdout.write('\n⚠ Inno Setup tidak ditemukan; Setup.exe dilewati. Pasang Inno Setup 6, atau set INNO_SETUP_ISCC.\n');
} else {
  step('Build installer (Inno Setup)');
  execFileSync(iscc, [`/DMyAppVersion=${version}`, path.join(ROOT, 'installer', 'Adhitron.iss')], { cwd: ROOT, stdio: 'inherit' });
  process.stdout.write(`\n📦 ${path.join(ROOT, 'dist', 'installer', `Adhitron-Setup-${version}.exe`)}\n`);
}

function findIscc() {
  if (process.env.INNO_SETUP_ISCC && existsSync(process.env.INNO_SETUP_ISCC)) return process.env.INNO_SETUP_ISCC;
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles ?? '', 'Inno Setup 6', 'ISCC.exe'),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}
