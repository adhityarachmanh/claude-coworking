// One-time setup for a device, step by step, asking before anything is installed:
//   1. Node.js + Claude Code    2. Tailscale (phone access from anywhere)
//   3. Firewall rule for Tailscale    4. Auto-start at login + start the server now
// Usage: node scripts/setup.mjs            interactive setup
//        node scripts/setup.mjs --check    report each step's status, change nothing
//        node scripts/setup.mjs --remove   remove auto-start
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { appPaths } from '../src/app-paths.js';
import { autostartStatus, setAutostart } from '../src/autostart.js';
import { findClaude } from '../src/claude-bin.js';
import { findOpenCode } from '../src/opencode-bin.js';
import { installNpmPackage } from '../src/setup/npm.js';
import { SETUP_TARGETS } from '../src/setup/packages.js';
import { activeNode, installNodeRuntime, runtimeBinDirs, runtimePaths, withRuntimeLock } from '../src/setup/runtime.js';
import { httpsPortFrom } from '../src/tls.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.OFFICE_PORT ?? 4317);
// HTTPS listener on the Tailscale address (Web Push / PWA); same default and validation as the server.
const HTTPS_PORT = httpsPortFrom(process.env.OFFICE_HTTPS_PORT, PORT).port ?? 4318;
const WIN = process.platform === 'win32';
const FIREWALL_RULE = 'Claude Coworking (Tailscale)'; // pre-rename id, kept so existing rules are found
const CHECK_ONLY = process.argv.includes('--check');
const RUNTIME_DIR = appPaths({ appDir: APP_DIR }).runtimeDir;

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

// ---------- 1. Node.js + mesin AI ----------

function useRuntimePath() {
  const dirs = runtimeBinDirs(RUNTIME_DIR).filter(Boolean);
  if (!dirs.length) return;
  const have = new Set(String(process.env.PATH ?? '').split(path.delimiter));
  const extra = dirs.filter((dir) => !have.has(dir));
  if (extra.length) process.env.PATH = [...extra, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);
}

const versionOf = (bin) => {
  try {
    return capture(bin.command, [...bin.args, '--version']) ?? '';
  } catch {
    return '';
  }
};

/** The portable Node runtime, downloaded only with consent; null when the user skips it. */
async function ensureRuntimeNode() {
  const active = activeNode(RUNTIME_DIR);
  if (active) return active;
  if (CHECK_ONLY) return null;
  warn('Adhitron belum punya Node.js sendiri.');
  info('Runtime ini hanya dipakai Adhitron: tanpa admin dan tanpa mengubah PATH sistem.');
  if (!(await ask('Unduh Node.js LTS sekarang (±30 MB)?'))) return null;
  let last = '';
  try {
    // installNodeRuntime takes the runtime lock itself; wrapping it again would deadlock (the lock is not reentrant).
    await installNodeRuntime({
      runtimeDir: RUNTIME_DIR,
      onProgress: ({ stage, percent }) => {
        const label = stage ? `${stage}${percent != null ? ` ${Math.round(percent)}%` : ''}` : '';
        if (label && label !== last) {
          last = label;
          info(label);
        }
      },
    });
  } catch (err) {
    warn(`Gagal memasang Node.js: ${err?.message ?? err}`);
    return null;
  }
  const installed = activeNode(RUNTIME_DIR);
  if (installed) {
    useRuntimePath();
    ok(`Node.js ${installed.version} siap di runtime Adhitron`);
  }
  return installed;
}

/** Installs one npm CLI into the per-user runtime prefix; false when the user skips or it fails. */
async function installCli(target) {
  const spec = SETUP_TARGETS[target]?.npm;
  if (!spec) return false;
  const node = await ensureRuntimeNode();
  if (!node) {
    info(`Lewati ${SETUP_TARGETS[target].label}. Pasang manual lewat wizard Persiapan di aplikasi setelah Node tersedia.`);
    return false;
  }
  const runtime = { ...runtimePaths({ runtimeDir: RUNTIME_DIR }), node: node.dir };
  try {
    mkdirSync(path.dirname(runtime.npmrc), { recursive: true });
    writeFileSync(runtime.npmrc, 'registry=https://registry.npmjs.org/\nfund=false\naudit=false\nupdate-notifier=false\n');
    mkdirSync(path.dirname(runtime.globalNpmrc), { recursive: true });
    writeFileSync(runtime.globalNpmrc, '');
    info(`Memasang ${SETUP_TARGETS[target].label} ke runtime Adhitron (tanpa admin)…`);
    await withRuntimeLock(RUNTIME_DIR, () =>
      installNpmPackage({
        runtime,
        spec,
        onLine: (line) => {
          const text = String(line ?? '').trim();
          if (text) info(text.slice(0, 200));
        },
      }),
    );
    useRuntimePath();
    return true;
  } catch (err) {
    warn(`Gagal memasang ${SETUP_TARGETS[target].label}: ${err?.message ?? err}`);
    if (err?.hint) info(err.hint);
    return false;
  }
}

async function setupEngines() {
  step(1, 'Node.js & mesin AI');
  const major = Number(process.versions.node.split('.')[0]);
  const runtime = activeNode(RUNTIME_DIR);
  if (major < 20) {
    warn(`Node.js ${process.versions.node} terlalu lama. Pasang Node.js 20+ dari https://nodejs.org lalu jalankan setup lagi.`);
    return false;
  }
  ok(`Node.js ${process.versions.node}${runtime ? ' (runtime Adhitron)' : ' (sistem)'}`);
  useRuntimePath();

  let claude = findClaude();
  if (claude) {
    ok(`Claude Code ${versionOf(claude)}`.trim());
  } else {
    warn('Claude Code belum terpasang.');
    if (!CHECK_ONLY && (await ask('Pasang Claude Code sekarang? (mesin utama, tanpa admin)'))) {
      await installCli('claude');
      claude = findClaude();
    }
    if (!claude) {
      warn('Claude Code tetap belum ada.');
      info('Tanpa Claude Code, Adhitron hanya bisa memakai OpenCode atau mode demo.');
      info('Pasang manual: npm install -g @anthropic-ai/claude-code, lalu jalankan `claude` sekali untuk login.');
    }
  }

  let opencode = findOpenCode();
  if (opencode) {
    ok(`OpenCode ${versionOf(opencode)}`.trim());
  } else {
    info('OpenCode belum terpasang (opsional: mesin kedua/provider lain).');
    if (!CHECK_ONLY && (await ask('Pasang OpenCode sekarang?', false))) {
      await installCli('opencode');
      opencode = findOpenCode();
    }
  }
  if (claude) info('Login sekali di terminal: jalankan `claude` (atau buka 🧰 Persiapan di aplikasi).');
  return Boolean(claude || opencode);
}

// ---------- 2. Tailscale ----------

function tailscaleBin() {
  const candidates = WIN ? ['C:\\Program Files\\Tailscale\\tailscale.exe'] : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  if (candidates.some((p) => existsSync(p))) return candidates.find((p) => existsSync(p));
  // capture() returns stderr on failure (e.g. "INFO: Could not find files..."), so only trust a real path
  const found = capture(WIN ? 'where' : 'which', ['tailscale'])?.split(/\r?\n/)[0];
  return found && existsSync(found) ? found : null;
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
  // Both listeners on the Tailscale address: HTTP (PORT) and HTTPS for push/PWA (HTTPS_PORT). A rule from an
  // older setup only opened PORT, which silently blocks https://<machine>.ts.net:4318 from the phone.
  const ports = [...new Set([PORT, HTTPS_PORT])].sort((a, b) => a - b);
  const want = ports.join(',');
  const current = powershell(`$r = Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue; if ($r) { (($r | Get-NetFirewallPortFilter).LocalPort | Sort-Object) -join ',' } else { 'none' }`);
  if (current === want) return ok(`Aturan "${FIREWALL_RULE}" sudah ada (TCP ${want})`);
  info('Windows menggolongkan Tailscale sebagai jaringan Private dan memblokir koneksi masuk ke Node.js.');
  if (current && current !== 'none') info(`Aturan lama hanya membuka TCP ${current}; diperbarui menjadi TCP ${want} (HTTPS untuk notifikasi push).`);
  info(`Aturan yang dipasang: hanya TCP ${want}, hanya dari alamat Tailscale (100.64.0.0/10).`);
  if (!(await ask('Pasang aturan firewall ini? (akan muncul jendela izin Administrator)'))) return info('Lewati. HP tidak akan bisa tersambung lewat Tailscale sampai aturan ini dipasang.');
  const rule = [
    `Remove-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue`,
    `New-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -Direction Inbound -Protocol TCP -LocalPort ${want} -RemoteAddress 100.64.0.0/10 -Profile Private -Action Allow`,
  ].join('; ');
  const encoded = Buffer.from(rule, 'utf16le').toString('base64');
  powershell(`Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`);
  const now = powershell(`$r = Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue; if ($r) { (($r | Get-NetFirewallPortFilter).LocalPort | Sort-Object) -join ',' } else { 'none' }`);
  if (now === want) ok(`Aturan firewall terpasang (TCP ${want})`);
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

console.log('\n=== Adhitron — setup ===');
if (process.argv.includes('--remove')) {
  setAutostart(false, APP_DIR, PORT);
  ok('Auto-start dan penjaga Task Scheduler dihapus.');
  rl.close();
  process.exit(0);
}
const enginesReady = await setupEngines();
const tailscaleIp = await setupTailscale();
await setupFirewall(tailscaleIp);
await setupAutostart();
rl.close();

if (CHECK_ONLY) process.exit(enginesReady ? 0 : 1);

console.log('\n=== Selesai ===');
console.log(`  Laptop : http://localhost:${PORT}`);
console.log('  HP     : di laptop klik 📱 → centang "Izinkan akses dari HP" → scan QR dari HP');
if (tailscaleIp) console.log('           pilih "Dari mana saja (Tailscale)" supaya bisa dibuka dari luar rumah');
console.log(`  Auto-start: ${autostartStatus().enabled ? 'aktif' : 'tidak aktif'} · laptop jangan sleep kalau mau diakses saat kamu pergi\n`);
