/* global document -- functions passed to page.eval run in the browser */
// 🛡️ Preset izin UI: the preset row of the Aturan izin dialog in a headless Chrome/Edge
// (test-support/cdp.mjs, real server + fake Claude Code). One desktop viewport, two flows:
//   1. Kerja penuh → plan shows add/skip per rule → Terapkan writes real allow rules through the
//      same /permissions-edit API → applying again plans nothing new (idempotent).
//   2. A user deny catch-all (Bash) → every Bash rule is skipped with the reason shown, nothing is
//      written (no Terapkan button), files untouched.
// The laptop-only hiding of the preset row rides on the same state.local that hides #perm-add.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TMP;
let BASE;
let server;
let browser;
let projectId;
let proj;

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-perm-preset-ui-'));
  proj = path.join(TMP, 'projects', 'toko');
  mkdirSync(proj, { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_APP_DIR: APP,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'), // user scope: ~/.claude/settings.json stand-in
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server tidak siap dalam batas waktu')), 20000);
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && (clearTimeout(timer), resolve()));
    server.on('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}`))));
  });
  server.stderr.resume();
  const controller = new AbortController();
  const res = await fetch(`${BASE}/stream`, { signal: controller.signal });
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  projectId = JSON.parse(text.match(/^data: (.*)$/m)[1]).projects.find((p) => p.name === 'toko').id;
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await Promise.race([exited, sleep(3000)]);
  }
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const appReady = () => document.querySelector('#conn')?.classList.contains('ok') && document.querySelector('#crumb')?.textContent.trim().length > 0;
const visible = (sel) => Boolean(document.querySelector(sel)?.getClientRects().length);
const planLines = () => [...document.querySelectorAll('#perm-preset-plan li')].map((li) => ({ rule: li.querySelector('code')?.textContent, pill: li.querySelector('.pill')?.textContent, note: li.querySelector('small')?.textContent ?? '' }));

async function openPermDialog(page) {
  await page.eval(() => import('/js/features/permissions.js').then((m) => m.openPermissions()));
  await page.waitFor(() => document.querySelectorAll('#perm-list .perm-scope-head b').length === 3, { timeoutMs: 4000, message: 'tiga sumber tampil' });
}

describe('🛡️ Preset izin UI', { skip: SKIP ?? false }, () => {
  let page;

  test.beforeEach(async () => {
    page = await browser.newPage({ width: 1440, height: 900 });
    await page.goto(`${BASE}/#${projectId}`);
    await page.waitFor(appReady, { timeoutMs: 30000, message: 'app terhubung' });
  });
  test.afterEach(async () => page.close().catch(() => {}));

  test('Kerja penuh: plan → Terapkan menulis aturan asli; diterapkan lagi → tidak ada yang baru', async () => {
    // An ask rule the user kept: the matching preset rule must be skipped, not blindly added.
    const local = path.join(proj, '.claude', 'settings.local.json');
    mkdirSync(path.dirname(local), { recursive: true });
    writeFileSync(local, JSON.stringify({ permissions: { ask: ['Bash(git push *)'] } }, null, 2));
    await openPermDialog(page);

    assert.equal(await page.eval(visible, '#perm-presets'), true, 'preset row tampil di laptop');
    await page.click('#perm-presets [data-preset="kerja-penuh"]');
    await page.waitFor(() => document.querySelectorAll('#perm-preset-plan li').length === 15, { timeoutMs: 4000, message: '15 baris rencana' });
    let lines = await page.eval(planLines);
    const push = lines.find((l) => l.rule === 'Bash(git push*)');
    assert.equal(push.pill, 'lewati');
    assert.match(push.note, /ask Bash\(git push \*\) .*Project lokal/);
    assert.equal(lines.filter((l) => l.pill === 'tambah').length, 14, '14 akan ditambahkan, ask-nya dilewati');
    assert.match(await page.eval(() => document.querySelector('#perm-preset-plan .perm-plan-head').textContent), /14 akan ditambahkan, 1 dilewati/);

    await page.click('#perm-preset-plan [data-plan="apply"]');
    await page.waitFor(() => [...document.querySelectorAll('#perm-list .perm-rules li code')].some((c) => c.textContent === 'Bash(npm *)'), { timeoutMs: 8000, message: 'aturan preset tampil di daftar' });
    const saved = JSON.parse(readFileSync(local, 'utf8'));
    assert.deepEqual(saved.permissions.allow, [
      'Bash(npm *)', 'Bash(npx *)', 'Bash(pnpm *)', 'Bash(bun *)',
      'Bash(git status*)', 'Bash(git add*)', 'Bash(git commit*)',
      'Bash(git pull*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git branch*)',
      'Edit', 'Write', 'Read',
    ], '14 aturan allow; Bash(git push*) dilewati karena ask-nya dievaluasi lebih dulu');
    assert.deepEqual(saved.permissions.ask, ['Bash(git push *)'], 'aturan ask user tidak tersentuh');
    assert.deepEqual(saved.permissions.deny, undefined, 'preset tidak pernah menulis deny');

    // Second application: everything already covered → nothing to add, no write.
    await page.click('#perm-presets [data-preset="kerja-penuh"]');
    await page.waitFor(() => /Tidak ada yang perlu ditambahkan/.test(document.querySelector('#perm-preset-plan').textContent), { timeoutMs: 4000, message: 'rencana kosong' });
    lines = await page.eval(planLines);
    assert.equal(lines.filter((l) => l.pill === 'tambah').length, 0);
    assert.equal(await page.eval(visible, '#perm-preset-plan [data-plan="apply"]'), false, 'tidak ada tombol Terapkan');
    const before = readFileSync(local, 'utf8');
    await sleep(300);
    assert.equal(readFileSync(local, 'utf8'), before, 'tidak ada tulisan kedua');
  });

  test('deny catch-all user: semua aturan Bash dilewati dengan alasannya, file lokal tak tersentuh', async () => {
    const user = path.join(TMP, 'claude-config', 'settings.json');
    mkdirSync(path.dirname(user), { recursive: true });
    writeFileSync(user, JSON.stringify({ permissions: { deny: ['Bash'] } }, null, 2));
    await openPermDialog(page);
    await page.click('#perm-presets [data-preset="paket-test"]');
    await page.waitFor(() => document.querySelectorAll('#perm-preset-plan li').length === 12, { timeoutMs: 4000, message: '12 baris rencana' });
    const lines = await page.eval(planLines);
    assert.ok(lines.every((l) => l.pill === 'lewati' && /selalu menang atas allow/.test(l.note)), JSON.stringify(lines.slice(0, 2)));
    assert.equal(await page.eval(visible, '#perm-preset-plan [data-plan="apply"]'), false);
    assert.match(await page.eval(() => document.querySelector('#perm-preset-plan').textContent), /Tidak ada yang perlu ditambahkan/);
    assert.equal(await page.eval(visible, '#perm-preset-plan [data-plan="close"]'), true, 'ada Tutup');
  });
});
