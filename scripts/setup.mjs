// One-time setup for a device, step by step, asking before anything is installed:
//   1. Node.js + Claude Code    2. Tailscale (phone access from anywhere)
//   3. Firewall rule for Tailscale    4. Auto-start at login + start the server now
// Usage: node scripts/setup.mjs            interactive setup
//        node scripts/setup.mjs --check    report each step's status, change nothing
//        node scripts/setup.mjs --remove   remove auto-start
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { autostartStatus, setAutostart } from '../src/autostart.js';
import { findClaude } from '../src/claude-bin.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.OFFICE_PORT ?? 4317);
const WIN = process.platform === 'win32';
const FIREWALL_RULE = 'Claude Coworking (Tailscale)';
const CHECK_ONLY = process.argv.includes('--check');

const ok = (msg) => console.log(`  [OK]  ${msg}`);
const warn = (msg) => console.log(`  [!!]  ${msg}`);
const info = (msg) => console.log(`        ${msg}`);
const step = (n, title) => console.log(`\n${n}. ${title}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
async function ask(question, def = true) {
  if (CHECK_ONLY) return false; // report only
  if (!process.stdin.isTTY) return def;
  const answer = (await rl.question(`        ${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  return answer ? answer.startsWith('y') : def;
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', windowsHide: false, ...opts });
const capture = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return (err.stdout || err.stderr || '').toString().trim() || null;
  }
};
const powershell = (command) => capture('powershell', ['-NoProfile', '-Command', command]);

async function serverRunning() {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

// ---------- 1. Node.js + Claude Code ----------

async function checkBasics() {
  step(1, 'Node.js & Claude Code');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    warn(`Node.js ${process.versions.node} terlalu lama. Pasang Node.js 20+ dari https://nodejs.org lalu jalankan setup lagi.`);
    return false;
  }
  ok(`Node.js ${process.versions.node}`);
  const claude = findClaude();
  if (!claude) {
    warn('Claude Code belum terpasang.');
    info('Pasang:  npm install -g @anthropic-ai/claude-code');
    info('Lalu jalankan `claude` sekali di terminal untuk login, kemudian jalankan setup ini lagi.');
    return false;
  }
  ok(`Claude Code ${capture(claude.command, [...claude.args, '--version']) ?? ''}`);
  info('Pastikan sudah login sekali: buka terminal, jalankan `claude`.');
  return true;
}

// ---------- 2. Tailscale ----------

function tailscaleBin() {
  const candidates = WIN ? ['C:\\Program Files\\Tailscale\\tailscale.exe'] : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  return candidates.find((p) => existsSync(p)) ?? (capture(WIN ? 'where' : 'which', ['tailscale'])?.split(/\r?\n/)[0] || null);
}

async function setupTailscale() {
  step(2, 'Tailscale — buka kantor dari HP di jaringan mana saja (opsional)');
  let bin = tailscaleBin();
  if (!bin) {
    info('Tailscale belum terpasang. Tanpa Tailscale, HP hanya bisa membuka kantor di WiFi yang sama.');
    if (WIN && (await ask('Pasang Tailscale sekarang lewat winget?'))) {
      run('winget', ['install', '--id', 'Tailscale.Tailscale', '-e', '--accept-source-agreements', '--accept-package-agreements']);
      bin = tailscaleBin();
    }
    if (!bin) {
      info(WIN ? 'Lewati. Pasang nanti dari https://tailscale.com/download lalu jalankan setup lagi.' : 'Pasang dari https://tailscale.com/download lalu jalankan setup lagi.');
      return null;
    }
  }
  ok('Tailscale terpasang');
  let ip = capture(bin, ['ip', '-4']);
  if (!/^100\./.test(ip ?? '')) {
    info('Tailscale belum login. Halaman login akan terbuka — masuk dengan akun yang juga dipakai di HP.');
    if (await ask('Login Tailscale sekarang?')) {
      run(bin, ['up']);
      ip = capture(bin, ['ip', '-4']);
    }
  }
  if (!/^100\./.test(ip ?? '')) {
    warn('Tailscale belum tersambung. Login lewat ikon Tailscale di tray, lalu jalankan setup lagi.');
    return null;
  }
  ok(`Tailscale tersambung: ${ip.split(/\r?\n/)[0]}`);
  info('Di HP: pasang aplikasi Tailscale, login dengan akun yang sama, nyalakan.');
  return ip;
}

// ---------- 3. Firewall ----------

async function setupFirewall(tailscaleIp) {
  step(3, 'Firewall Windows untuk Tailscale');
  if (!WIN) return info('Bukan Windows — lewati.');
  if (!tailscaleIp) return info('Tailscale belum siap — lewati.');
  const exists = powershell(`if (Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`);
  if (exists === 'yes') return ok(`Aturan "${FIREWALL_RULE}" sudah ada`);
  info('Windows menggolongkan Tailscale sebagai jaringan Private dan memblokir koneksi masuk ke Node.js.');
  info(`Aturan yang dipasang: hanya TCP ${PORT}, hanya dari alamat Tailscale (100.64.0.0/10).`);
  if (!(await ask('Pasang aturan firewall ini? (akan muncul jendela izin Administrator)'))) return info('Lewati. HP tidak akan bisa tersambung lewat Tailscale sampai aturan ini dipasang.');
  const rule = `New-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -Direction Inbound -Protocol TCP -LocalPort ${PORT} -RemoteAddress 100.64.0.0/10 -Profile Private -Action Allow`;
  const encoded = Buffer.from(rule, 'utf16le').toString('base64');
  powershell(`Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`);
  const now = powershell(`if (Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`);
  if (now === 'yes') ok('Aturan firewall terpasang');
  else warn('Aturan belum terpasang (izin Administrator ditolak?). Jalankan setup lagi kapan saja.');
}

// ---------- 4. Auto-start + server ----------

async function setupAutostart() {
  step(4, 'Auto-start & server di latar belakang');
  if (!WIN) {
    info('Auto-start otomatis hanya untuk Windows. Di macOS/Linux jalankan `npm start` (atau pasang sebagai service).');
    return;
  }
  if (CHECK_ONLY) {
    const current = autostartStatus();
    (current.enabled ? ok : warn)(`Auto-start saat login ${current.enabled ? 'terpasang' : 'belum terpasang'}`);
    (current.watchdog ? ok : warn)(`Penjaga 5 menit (Task Scheduler) ${current.watchdog ? 'terpasang' : 'belum terpasang'}`);
    ((await serverRunning()) ? ok : warn)(`Server di port ${PORT} ${(await serverRunning()) ? 'berjalan' : 'tidak berjalan'}`);
    return;
  }
  const status = setAutostart(true, APP_DIR, PORT);
  ok('Auto-start terpasang — server menyala sendiri setiap Windows login');
  info(status.path);
  if (status.watchdog) ok('Penjaga terpasang — dicek tiap 5 menit, server dinyalakan lagi kalau mati (setelah sleep/hibernate/crash)');
  else warn('Penjaga Task Scheduler gagal dipasang; auto-start tetap jalan saat login.');
  if (await serverRunning()) {
    ok(`Server sudah berjalan di port ${PORT}`);
    info('Kalau itu `npm run dev` di terminal, tutup terminalnya lalu jalankan setup lagi supaya server background yang dipakai.');
    return;
  }
  spawn('wscript', [status.path], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 20 && !(await serverRunning()); i++) await new Promise((r) => setTimeout(r, 500));
  if (await serverRunning()) ok('Server berjalan di latar belakang (log: data\\server.log)');
  else warn('Server belum menyala. Lihat data\\server.log untuk penyebabnya.');
}

// ---------- main ----------

console.log('\n=== Claude Coworking — setup ===');
if (process.argv.includes('--remove')) {
  setAutostart(false, APP_DIR, PORT);
  ok('Auto-start dan penjaga Task Scheduler dihapus.');
  rl.close();
  process.exit(0);
}
if (!(await checkBasics())) {
  rl.close();
  process.exit(1);
}
const tailscaleIp = await setupTailscale();
await setupFirewall(tailscaleIp);
await setupAutostart();
rl.close();

console.log('\n=== Selesai ===');
console.log(`  Laptop : http://localhost:${PORT}`);
console.log('  HP     : di laptop klik 📱 → centang "Izinkan akses dari HP" → scan QR dari HP');
if (tailscaleIp) console.log('           pilih "Dari mana saja (Tailscale)" supaya bisa dibuka dari luar rumah');
console.log(`  Auto-start: ${autostartStatus().enabled ? 'aktif' : 'tidak aktif'} · laptop jangan sleep kalau mau diakses saat kamu pergi\n`);
