#!/usr/bin/env node
// One-click update of Adhit Office (update.cmd): fetch → show what is new → ask → git pull --ff-only → clean restart
// (scripts/restart.mjs: a running turn is recorded and offered to continue). Never touches local changes: with
// uncommitted changes or a diverged branch it stops and says what to do.
// Usage: node scripts/update.mjs          ask before pulling
//        node scripts/update.mjs --yes    no question (still refuses with local changes)
//        node scripts/update.mjs --check  only report whether an update is available
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const YES = process.argv.includes('--yes') || process.argv.includes('-y');
const CHECK = process.argv.includes('--check');
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

const git = (...args) => execFileSync('git', args, { cwd: APP_DIR, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, windowsHide: true }).trim();
const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};
const fail = (msg) => {
  console.log(`\n  [!!] ${msg}\n`);
  process.exit(1);
};

console.log('\nAdhit Office - update\n');
if (tryGit('rev-parse', '--is-inside-work-tree') !== 'true') fail('Folder ini bukan repo git (diunduh sebagai ZIP?). Clone ulang dengan git agar bisa di-update.');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const upstream = tryGit('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
if (!upstream) fail(`Branch "${branch}" tidak punya upstream. Jalankan: git branch --set-upstream-to=origin/${branch}`);
console.log(`  Branch: ${branch} (mengikuti ${upstream})`);
console.log('  Mengambil info terbaru dari GitHub…');
try {
  git('fetch', '--quiet', '--no-tags');
} catch (err) {
  fail(`git fetch gagal (internet / login GitHub?):\n       ${String(err.stderr ?? err.message).trim().split('\n').at(-1)}`);
}
const behind = Number(git('rev-list', '--count', 'HEAD..@{u}'));
const ahead = Number(git('rev-list', '--count', '@{u}..HEAD'));
if (!behind) {
  console.log('\n  [OK] Sudah versi terbaru.\n');
  process.exit(0);
}
console.log(`\n  ${behind} perubahan baru:`);
for (const line of git('log', '--format=  - %h %s', '-n', '20', 'HEAD..@{u}').split('\n')) console.log(line);
if (behind > 20) console.log(`  … dan ${behind - 20} lainnya`);
if (CHECK) process.exit(0);
if (git('status', '--porcelain', '--untracked-files=no')) fail('Ada perubahan lokal yang belum di-commit di folder aplikasi. Commit atau `git stash` dulu, lalu jalankan update lagi.');
if (ahead) fail(`Branch lokal punya ${ahead} commit yang belum ada di ${upstream} (bercabang). Selesaikan dulu dengan git (push atau rebase).`);

if (!YES && process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\n  Update sekarang dan restart server? [Y/n] ')).trim().toLowerCase();
  rl.close();
  if (answer && !answer.startsWith('y')) {
    console.log('  Dibatalkan.\n');
    process.exit(0);
  }
}
console.log('\n  git pull --ff-only …');
const pull = spawnSync('git', ['pull', '--ff-only', '--no-rebase'], { cwd: APP_DIR, env, stdio: 'inherit', windowsHide: true });
if (pull.status !== 0) fail('git pull gagal. Tidak ada yang diubah kecuali sudah tertulis di atas.');
console.log('\n  Restart server…');
const restart = spawnSync(process.execPath, [path.join(APP_DIR, 'scripts', 'restart.mjs')], { cwd: APP_DIR, stdio: 'inherit', windowsHide: true });
if (restart.status !== 0) fail('Restart gagal. Jalankan start-office.cmd atau node scripts\\restart.mjs.');
console.log(`\n  [OK] Adhit Office sudah diperbarui (${behind} perubahan). Muat ulang halaman di browser/HP.\n`);
