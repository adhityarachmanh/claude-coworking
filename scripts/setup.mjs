// One-time setup for a new device: checks prerequisites, then (optionally) installs auto-start.
// Usage: node scripts/setup.mjs [--autostart | --remove]
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autostartStatus, setAutostart } from '../src/autostart.js';
import { findClaude } from '../src/claude-bin.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const ok = (msg) => console.log(`  [OK]   ${msg}`);
const fail = (msg) => console.log(`  [!!]   ${msg}`);

console.log('\nClaude Coworking — setup\n');

// 1. Node.js version
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`Node.js ${process.versions.node}`);
else {
  fail(`Node.js ${process.versions.node} terlalu lama. Pasang Node.js 20 atau lebih baru: https://nodejs.org`);
  process.exit(1);
}

// 2. Claude Code installed + logged in
const claude = findClaude();
if (!claude) {
  fail('Claude Code belum terpasang. Jalankan:  npm install -g @anthropic-ai/claude-code   lalu  claude  (login sekali).');
  process.exit(1);
}
let version = '';
try {
  version = execFileSync(claude.command, [...claude.args, '--version'], { encoding: 'utf8', windowsHide: true }).trim();
} catch {
  // version check is informational only
}
ok(`Claude Code ${version} — ${claude.command}`);
console.log('         Pastikan sudah login: buka terminal, jalankan `claude`, ikuti login sekali saja.');

// 3. Auto-start
if (args.includes('--remove')) {
  setAutostart(false, APP_DIR);
  ok('Auto-start dihapus dari Startup Windows.');
} else if (args.includes('--autostart')) {
  const status = setAutostart(true, APP_DIR);
  if (!status.supported) fail('Auto-start hanya tersedia di Windows.');
  else {
    ok(`Auto-start terpasang: ${status.path}`);
    // Start it now too, exactly as Windows will at the next login.
    spawn('wscript', [status.path], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    ok('Server dinyalakan di latar belakang (log: data\\server.log).');
  }
} else {
  const status = autostartStatus();
  console.log(`  [i]    Auto-start: ${status.enabled ? 'aktif' : 'belum aktif'}`);
}
console.log('\nBuka http://localhost:4317 di browser.\n');
