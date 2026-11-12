/* global document, window -- functions passed to page.eval run in the browser */
// UI of the two new safety settings, against the real server and the fake Claude Code:
//   ⚡ ⚙ → Umum "Maksimal giliran" (POST /api/concurrency/save + hint) and the 🗂 badge "⚡ 2/3" (phone bar too);
//   ⏳ 🕵️ Data saya retention (selects from data.retention, Pratinjau numbers, Simpan body, Bersihkan = save+run).
// A browser is needed (CDP); without Chrome/Edge the whole file is skipped.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TMP;
let DATA;
let BASE;
let server;
let browser;
let token;
let toko;
let blog;

const stateFile = () => path.join(DATA, 'state.json');
const lines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean);
const jsonLines = (file) => lines(file).map((line) => JSON.parse(line));
const parsedLines = (file) =>
  lines(file).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function api(p, body = {}) {
  return fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office-Token': token },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

function appReady() {
  const conn = document.querySelector('#conn');
  return conn?.classList.contains('ok') && document.querySelector('#crumb')?.textContent.trim().length > 0;
}

async function openApp(page) {
  page.clearProblems();
  await page.goto(`${BASE}/#${toko}`);
  await page.waitFor(appReady, { timeoutMs: 30000, message: 'app terhubung (#conn.ok) dan header terisi' });
}

/** Opens ⚙ and one of its tabs, then waits until the panel is painted. */
async function openSettingsTab(page, tab) {
  await page.eval(() => document.querySelector('#btn-settings').click());
  await page.waitFor(() => !document.querySelector('#settings-modal').hidden, { timeoutMs: 5000, message: '⚙ terbuka' });
  await page.eval((name) => document.querySelector(`[data-settings-tab="${name}"]`)?.click(), tab);
  await page.waitFor((name) => document.querySelector(`[data-settings-panel="${name}"]`)?.getClientRects().length > 0, { timeoutMs: 5000, message: `tab ${tab}` }, tab);
}

/** Captures every POST body the page sends to `endpoint`, then forwards the request to the real server. */
function capturePosts(page, endpoint) {
  return page.eval((pathname) => {
    const orig = window.fetch.bind(window);
    window.__captured = [];
    window.fetch = (url, opts = {}) => {
      if (String(url).includes(pathname) && opts.body) {
        try {
          window.__captured.push({ url: String(url), body: JSON.parse(opts.body) });
        } catch {
          window.__captured.push({ url: String(url), body: String(opts.body) });
        }
      }
      return orig(url, opts);
    };
  }, endpoint);
}

const captured = (page) => page.eval(() => window.__captured ?? []);

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-conc-ret-ui-'));
  DATA = path.join(TMP, 'data');
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko'), { recursive: true });
  mkdirSync(path.join(projects, 'blog'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'), { recursive: true });
  // gh installed but not logged in: never touch the real GitHub CLI.
  writeFileSync(path.join(TMP, 'fake-gh.mjs'), "process.stderr.write('You are not logged into any GitHub hosts.\\n');\nprocess.exit(1);\n");
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_APP_DIR: APP, // pin the app dir to the repo: a dev machine's OFFICE_APP_DIR may point at an installed Adhitron
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: DATA,
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      OFFICE_GH_BIN: path.join(TMP, 'fake-gh.mjs'),
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      OFFICE_OPEN_DRY_RUN: '1',
      OFFICE_EFFORT_FAKE: 'high',
      OFFICE_UPDATE_CHECK: '0',
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  server.stderr.resume();
  const html = await (await fetch(BASE)).text();
  token = html.match(/office-token" content="([^"]+)"/)[1];
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  const snapshot = JSON.parse(text.match(/^data: (.*)$/m)[1]);
  toko = snapshot.projects.find((p) => p.name === 'toko')?.id;
  blog = snapshot.projects.find((p) => p.name === 'blog')?.id;
  assert.ok(toko && blog, 'project toko + blog');
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    try {
      await fetch(`${BASE}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: '{}' });
      await Promise.race([new Promise((r) => server.once('exit', r)), sleep(3000)]);
    } catch {
      // best effort
    }
  }
  server?.kill();
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('⚙ → Umum: batas giliran 1 disimpan + hint ikut, 9 ditolak tanpa request, 0 = tanpa batas', { skip: SKIP ?? false, timeout: 60000 }, async () => {
  const page = await browser.newPage({ width: 1440, height: 900, mobile: false });
  try {
    await openApp(page);
    await capturePosts(page, '/api/concurrency/save');
    await openSettingsTab(page, 'umum');
    await page.waitFor(
      () => document.querySelector('#concurrency-section')?.getClientRects().length > 0 && /Saat ini 0 dari 3 project sedang bekerja/.test(document.querySelector('#max-concurrent-hint')?.textContent ?? ''),
      { timeoutMs: 10000, message: 'bagian ⚡ + hint awal (0 dari 3)' },
    );
    assert.equal(await page.eval(() => document.querySelector('#max-concurrent').value), '3', 'field memuat nilai tersimpan');

    // 1: satu request, satu response, hint berubah.
    await page.eval(() => {
      const input = document.querySelector('#max-concurrent');
      input.value = '1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#max-concurrent-save').click();
    });
    await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /disimpan: 1 project/.test(t.textContent)), { timeoutMs: 10000, message: 'toast simpan 1' });
    await page.waitFor(() => /Saat ini 0 dari 1 project sedang bekerja/.test(document.querySelector('#max-concurrent-hint')?.textContent ?? ''), { timeoutMs: 5000, message: 'hint 0 dari 1' });
    assert.deepEqual(await captured(page), [{ url: '/api/concurrency/save', body: { maxConcurrent: 1 } }], 'body kiriman benar');
    assert.equal(JSON.parse(readFileSync(stateFile(), 'utf8')).maxConcurrent, 1, 'state.json ikut tersimpan');

    // 9: ditolak di UI (pesan jelas) tanpa mengirim request dan tanpa mengubah nilai tersimpan.
    await page.eval(() => {
      const input = document.querySelector('#max-concurrent');
      input.value = '9';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#max-concurrent-save').click();
    });
    await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /angka bulat 0 sampai 8/.test(t.textContent)), { timeoutMs: 5000, message: 'toast nilai 9 ditolak' });
    assert.equal((await captured(page)).length, 1, 'tidak ada request untuk nilai tidak valid');
    assert.equal(JSON.parse(readFileSync(stateFile(), 'utf8')).maxConcurrent, 1, 'nilai tersimpan tidak berubah');
    assert.match(await page.eval(() => document.querySelector('#max-concurrent-hint').textContent), /dari 1 project/, 'hint tetap pada nilai tersimpan');

    // 0: batas bawah = tanpa batas (hint khusus).
    await page.eval(() => {
      const input = document.querySelector('#max-concurrent');
      input.value = '0';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#max-concurrent-save').click();
    });
    await page.waitFor(() => /Tanpa batas — semua project boleh bekerja bersamaan/.test(document.querySelector('#max-concurrent-hint')?.textContent ?? ''), { timeoutMs: 5000, message: 'hint tanpa batas' });
    assert.deepEqual((await captured(page)).at(-1).body, { maxConcurrent: 0 });
    assert.equal(JSON.parse(readFileSync(stateFile(), 'utf8')).maxConcurrent, 0);

    // No console errors / failed requests on the happy path; the 9 was refused before any request.
    assert.deepEqual(page.problems, []);
  } finally {
    await api('/api/concurrency/save', { maxConcurrent: 3 });
    await page.close();
  }
});

test('🗂 badge ⚡ 2/3 tampil saat dua project bekerja, hilang saat batas 0 (desktop + bar HP)', { skip: SKIP ?? false, timeout: 120000 }, async () => {
  assert.equal((await api('/api/concurrency/save', { maxConcurrent: 3 })).status, 200);
  const desktop = await browser.newPage({ width: 1440, height: 900, mobile: false });
  const phone = await browser.newPage({ width: 390, height: 844, mobile: true });
  try {
    await openApp(desktop);
    // Two turns in two projects, so two of three slots are in use (the fake streams "lama" for ~10 s).
    assert.equal((await api(`/api/projects/${toko}/prompt`, { text: 'lama dari toko' })).status, 200);
    assert.equal((await api(`/api/projects/${blog}/prompt`, { text: 'lama dari blog' })).status, 200);

    await desktop.eval(() => document.querySelector('#btn-dashboard').click());
    await desktop.waitFor(
      () => {
        const badge = document.querySelector('#dash-capacity');
        return badge && !badge.hidden && badge.textContent.trim() === '⚡ 2/3';
      },
      { timeoutMs: 20000, message: 'badge ⚡ 2/3' },
    );
    const badge = await desktop.eval(() => {
      const node = document.querySelector('#dash-capacity');
      return { text: node.textContent.trim(), title: node.title, aria: node.getAttribute('aria-label'), full: node.classList.contains('full') };
    });
    assert.equal(badge.text, '⚡ 2/3');
    assert.match(badge.title, /2 dari 3 project sedang bekerja/);
    assert.match(badge.title, /toko/);
    assert.match(badge.title, /blog/);
    assert.equal(badge.full, false, '2 dari 3 belum penuh');

    // Phone: the same count in the 🗂 bar summary, and the dialog badge after tapping it.
    await openApp(phone);
    await phone.waitFor(() => /⚡ 2\/3/.test(document.querySelector('#dash-bar-sum')?.textContent ?? ''), { timeoutMs: 20000, message: 'bar HP ⚡ 2/3' });
    await phone.eval(() => document.querySelector('#dash-bar').click());
    await phone.waitFor(() => !document.querySelector('#dash-capacity').hidden && document.querySelector('#dash-capacity').textContent.trim() === '⚡ 2/3', { timeoutMs: 5000, message: 'badge dialog HP' });

    // 0 = tanpa batas: after a fresh load the badge/bar carry no ⚡ at all.
    assert.equal((await api('/api/concurrency/save', { maxConcurrent: 0 })).status, 200);
    await openApp(desktop);
    await desktop.eval(() => document.querySelector('#btn-dashboard').click());
    await desktop.waitFor(() => document.querySelector('#dash-capacity')?.hidden === true && document.querySelector('#dash-capacity').textContent === '', { timeoutMs: 10000, message: 'badge tersembunyi saat 0' });
    assert.doesNotMatch(await desktop.eval(() => document.querySelector('#dash-bar-sum').textContent), /⚡/);
    await openApp(phone);
    await phone.waitFor(() => (document.querySelector('#dash-bar-sum')?.textContent ?? '').length > 0 && !/⚡/.test(document.querySelector('#dash-bar-sum').textContent), { timeoutMs: 10000, message: 'bar HP tanpa ⚡ saat 0' });

    assert.deepEqual(desktop.problems, []);
    assert.deepEqual(phone.problems, []);
  } finally {
    await api(`/api/projects/${toko}/stop`).catch(() => {});
    await api(`/api/projects/${blog}/stop`).catch(() => {});
    await api('/api/concurrency/save', { maxConcurrent: 3 });
    await desktop.close();
    await phone.close();
  }
});

// Regression: POST /api/data answers with `retention` NEXT TO `data`; load() must merge both before render().
test(
  'retensi: select Chat/Laporan menampilkan batas tersimpan dari data.retention',
  { skip: SKIP ?? false, timeout: 60000 },
  async () => {
    assert.equal((await api('/api/data/retention/save', { chatsDays: 30, usageDays: 90 })).status, 200);
    const page = await browser.newPage({ width: 1440, height: 900, mobile: false });
    try {
      await openApp(page);
      await openSettingsTab(page, 'cadangan');
      await page.eval(() => document.querySelector('#btn-data-panel').click());
      await page.waitFor(() => !document.querySelector('#data-modal').hidden && /state\.json/.test(document.querySelector('#data-list')?.textContent ?? ''), { timeoutMs: 10000, message: 'panel Data saya termuat' });
      const values = await page.eval(() => ({
        chats: document.querySelector('#data-ret-chats').value,
        usage: document.querySelector('#data-ret-usage').value,
        server: document.querySelector('#data-ret-preview').textContent,
      }));
      assert.deepEqual({ chats: values.chats, usage: values.usage }, { chats: '30', usage: '90' }, 'panel harus menampilkan batas retensi tersimpan (bukan 0/0)');
    } finally {
      await page.close();
    }
  },
);

// Regression: `audit` is also a sibling of `data`, so load() must merge it too or the "Retensi data" filter is empty.
test(
  'retensi: audit "Retensi data" tampil di 🕵️ Data saya setelah run',
  { skip: SKIP ?? false, timeout: 60000 },
  async () => {
    assert.equal((await api('/api/data/retention/run', { target: 'all' })).status, 200);
    const page = await browser.newPage({ width: 1440, height: 900, mobile: false });
    try {
      await openApp(page);
      await openSettingsTab(page, 'cadangan');
      await page.eval(() => document.querySelector('#btn-data-panel').click());
      await page.waitFor(() => !document.querySelector('#data-modal').hidden && /state\.json/.test(document.querySelector('#data-list')?.textContent ?? ''), { timeoutMs: 10000, message: 'panel Data saya termuat' });
      const shown = await page.eval(() => document.querySelector('#data-audit').textContent);
      assert.match(shown, /Retensi data/, 'run yang baru tercatat harus tampil di daftar audit');
    } finally {
      await page.close();
    }
  },
);

test('🕵️ Data saya: Pratinjau menghitung, Simpan body benar, Bersihkan = save lalu run (backup ledger)', { skip: SKIP ?? false, timeout: 90000 }, async () => {
  const NOW = Date.now();
  const OLD = NOW - 400 * DAY;
  const chatFile = path.join(DATA, 'chats', 'retui.jsonl');
  const usageFile = path.join(DATA, 'usage.jsonl');
  const usageRow = (ts) => ({ ts, account: { id: 'akun-a' }, project: 'retui', projectId: 'retui', input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  mkdirSync(path.join(DATA, 'chats'), { recursive: true });
  writeFileSync(
    chatFile,
    [
      { id: 'm1', ts: OLD, project: 'retui', kind: 'assistant', text: 'pesan sangat lama' },
      { id: 'm2', ts: NOW, project: 'retui', kind: 'assistant', text: 'pesan baru' },
      { id: 'm3', project: 'retui', kind: 'info', text: 'tanpa waktu' },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n') + '\n',
  );
  writeFileSync(usageFile, [JSON.stringify(usageRow(OLD)), JSON.stringify(usageRow(NOW)), JSON.stringify({ account: { id: 'akun-a' } }), 'bukan-json'].join('\n') + '\n');
  assert.equal((await api('/api/data/retention/save', { chatsDays: 30, usageDays: 90 })).status, 200);

  const page = await browser.newPage({ width: 1440, height: 900, mobile: false });
  /** Writes both selects as a user would. */
  const choose = (chats, usage) =>
    page.eval(
      (c, u) => {
        const set = (id, value) => {
          const select = document.querySelector(id);
          select.value = value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('#data-ret-chats', c);
        set('#data-ret-usage', u);
      },
      chats,
      usage,
    );
  try {
    await openApp(page);
    await capturePosts(page, '/api/data/retention/');
    await openSettingsTab(page, 'cadangan');
    await page.eval(() => document.querySelector('#btn-data-panel').click());
    await page.waitFor(() => !document.querySelector('#data-modal').hidden && /state\.json/.test(document.querySelector('#data-list')?.textContent ?? ''), { timeoutMs: 10000, message: 'panel Data saya termuat' });
    assert.match(await page.eval(() => document.querySelector('#data-ret-preview').textContent), /Pilih batas lalu klik Pratinjau/, 'hint awal pratinjau');

    // Pratinjau with 30/180: counts, and neither file is written.
    await choose(30, 180);
    await page.eval(() => document.querySelector('#data-ret-preview-btn').click());
    await page.waitFor(() => /Akan dihapus: 1 pesan chat di 1 project dan 1 baris laporan di 1 file\./.test(document.querySelector('#data-ret-preview')?.textContent ?? ''), { timeoutMs: 10000, message: 'angka pratinjau' });
    assert.deepEqual((await captured(page)).at(-1), { url: '/api/data/retention/preview', body: { chatsDays: 30, usageDays: 180 } });
    assert.equal(lines(chatFile).length, 3, 'pratinjau tidak menulis chat');
    assert.equal(lines(usageFile).length, 4, 'pratinjau tidak menulis ledger');

    // Simpan: body is exactly what the two selects show.
    await page.eval(() => document.querySelector('#data-ret-save').click());
    await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Batas retensi disimpan/.test(t.textContent)), { timeoutMs: 10000, message: 'toast simpan retensi' });
    assert.deepEqual((await captured(page)).filter((p) => p.url === '/api/data/retention/save').at(-1).body, { chatsDays: 30, usageDays: 180 });
    assert.deepEqual(JSON.parse(readFileSync(stateFile(), 'utf8')).retention, { chatsDays: 30, usageDays: 180 });

    // Bersihkan sekarang: save (what is on screen) then run; confirmation shown. The selects are re-picked because
    // the previous Simpan round-trip reloads the panel from the server.
    await choose(30, 180);
    await page.eval(() => {
      window.__confirms = [];
      window.confirm = (message) => {
        window.__confirms.push(String(message));
        return true;
      };
      document.querySelector('#data-ret-run').click();
    });
    await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Retensi dijalankan: 1 pesan chat dan 1 baris laporan dihapus/.test(t.textContent)), { timeoutMs: 20000, message: 'toast retensi dijalankan' });
    const posts = await captured(page);
    assert.deepEqual(posts.slice(-2).map((p) => ({ url: p.url, body: p.body })), [
      { url: '/api/data/retention/save', body: { chatsDays: 30, usageDays: 180 } },
      { url: '/api/data/retention/run', body: { target: 'all' } },
    ]);
    assert.match((await page.eval(() => window.__confirms)).join('\n'), /Bersihkan sekarang data yang lebih lama/);

    assert.deepEqual(jsonLines(chatFile).map((m) => m.id), ['m2', 'm3'], 'pesan lama dihapus, tanpa-ts tetap');
    assert.equal(parsedLines(usageFile).some((r) => r.ts === OLD), false, 'baris lama dihapus');
    assert.equal(lines(usageFile).includes('bukan-json'), true, 'baris rusak dipertahankan');
    assert.equal(parsedLines(usageFile).some((r) => r.ts === undefined), true, 'baris tanpa ts dipertahankan');
    assert.equal(readdirSync(DATA).filter((name) => /^usage\.jsonl\.bak-retention-\d{8}$/.test(name)).length, 1, 'backup ledger harian');
    // The filter itself offers the new action (the list under it is covered by the BUG test above).
    assert.equal(await page.eval(() => [...document.querySelectorAll('#data-audit-filter option')].some((o) => o.value === 'retention-run' && /Retensi data/.test(o.textContent))), true);

    assert.deepEqual(page.problems, []);
  } finally {
    await api('/api/data/retention/save', { chatsDays: 0, usageDays: 0 });
    await page.close();
  }
});
