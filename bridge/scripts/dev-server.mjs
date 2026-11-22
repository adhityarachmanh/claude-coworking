// bridge/scripts/dev-server.mjs — jalankan situs Adhitron Web secara lokal tanpa deploy.
//
// Netlify CLI punya dua perintah yang bisa menyajikan fungsi:
//   • `netlify dev`  — menyuntik env project otomatis, TETAPI di mesin ini proxy fungsinya macet
//     (edge-bundler butuh `deno`, dan folder `netlify/` nyasar di root repo membingungkan resolve).
//   • `netlify functions:serve` — MELAYANI fungsi dengan andal, tetapi env hanya dari proses
//     (`.env` tidak dibaca) dan hanya menyajikan fungsi (tanpa static server/portal).
//
// Skrip ini memuat `.env` ke `process.env` lalu menyerahkan sisanya ke `netlify functions:serve`.
// DATABASE_URL dari `.env` (kalau diisi) akan menang; kalau kosong, CLI menyuntik DATABASE_URL
// dari project Netlify secara otomatis. `.env` TIDAK pernah ditulis balik maupun di-commit.
//
// Pakai:  npm run dev            (port default 8888)
//         npm run dev -- --port 9000
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(BRIDGE, '.env');

/** Parser `.env` sederhana: KEY=VALUE per baris, dukung kutip, komentar `#`, tanpa ekspansi. */
function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// `.env` hanya pelengkap: nilai yang sudah ada di lingkungan (mis. di-set eksplisit) tidak ditimpa.
if (existsSync(ENV_FILE)) {
  const loaded = parseEnv(readFileSync(ENV_FILE, 'utf8'));
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  console.log(`[dev-server] memuat ${Object.keys(loaded).length} variabel dari .env`);
} else {
  console.log('[dev-server] .env tidak ada; memakai env project Netlify (DATABASE_URL) apa adanya.');
}

// Ambil argumen lewat `--` (mis. `npm run dev -- --port 9000`).
const args = process.argv.slice(2);
const port = args.includes('--port') ? args[args.indexOf('--port') + 1] : '8888';

console.log(`[dev-server] menyajikan fungsi di http://localhost:${port} (Ctrl+C untuk berhenti)`);

const child = spawn('netlify', ['functions:serve', '--functions', 'netlify/functions', '--port', port], {
  cwd: BRIDGE,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 0));