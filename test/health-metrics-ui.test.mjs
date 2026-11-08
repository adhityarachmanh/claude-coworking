/* global document, window -- fungsi page.eval berjalan di dalam browser */
// 🩺 → 📈 "Aktivitas 7 hari": the metrics section of the health dialog (public/js/features/health.js) with a stubbed
// /api/health answer — today's summary, a 7-row table (empty days included), the restart line, the backup warning, and
// the compatibility fallback when an older server sends `metrics: null`. Headless Chrome/Edge over CDP
// (test-support/cdp.mjs); the real server runs only to serve the app, no turn is started.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [
  { name: 'mobile 390x844', width: 390, height: 844, mobile: true },
  { name: 'desktop 1440x900', width: 1440, height: 900, mobile: false },
];

let TMP;
let BASE;
let server;
let browser;

// ---------- the canned report ----------

/** One day of the server's 7-day view, exactly the shape src/metrics.js dayView() returns. */
const day = (key, over = {}) => ({
  day: key,
  turns: 0,
  ok: 0,
  failed: 0,
  avgTurnMs: null,
  queueStarted: 0,
  waitP50Ms: null,
  waitP95Ms: null,
  waitSamples: 0,
  capacityQueued: 0,
  capacityRefused: 0,
  ...over,
});

const TODAY = day('2026-11-08', {
  turns: 5,
  ok: 4,
  failed: 1,
  avgTurnMs: 42_000,
  queueStarted: 2,
  waitP50Ms: 15_000,
  waitP95Ms: 120_000,
  waitSamples: 2,
  capacityQueued: 1,
  capacityRefused: 2,
});

/** today + seven days (oldest first, empty days included) + restarts, as the server sends them. */
const METRICS = () => ({
  today: TODAY,
  days: [
    day('2026-11-02'),
    day('2026-11-03'),
    day('2026-11-04', { turns: 1, ok: 1, avgTurnMs: 1_000 }),
    day('2026-11-05'),
    day('2026-11-06', { turns: 3, ok: 2, failed: 1, queueStarted: 1, waitP95Ms: 60_000, capacityRefused: 1 }),
    day('2026-11-07'),
    TODAY,
  ],
  restarts: { count: 4, lastAt: Date.parse('2026-11-08T09:30:00+07:00') },
});

const CHECK = (id, label, detail) => ({ id, label, ok: true, detail });

/** A healthy report: all checks pass, 5/5 onboarding steps done, no errors, small data dir. */
function healthAnswer({ metrics = METRICS(), checks = [] } = {}) {
  const base = [
    CHECK('claude', 'Akun Claude', 'tester@example.com · paket team'),
    CHECK('projects', 'Folder project', '1 folder root · 1 project'),
    CHECK('backup', 'Backup otomatis', 'Terakhir 1 jam lalu · adhit-office-backup-auto-20261108-020000.zip'),
  ];
  // A later check with the same id replaces the default one (the backup warning test).
  const byId = new Map(base.map((c) => [c.id, c]));
  for (const c of checks) byId.set(c.id, c);
  return {
    at: '2026-11-08T10:00:00.000Z',
    app: { version: '0.2.0', pid: 4321, uptimeSec: 3 * 3600 + 5 * 60, engine: 'claude', port: 4317 },
    checks: [...byId.values()],
    checklist: [
      { id: 'login', label: 'Login Claude', done: true },
      { id: 'project', label: 'Folder project', done: true },
      { id: 'backup', label: 'Backup otomatis', done: true },
      { id: 'https', label: 'HTTPS untuk HP', done: true },
      { id: 'opencode', label: 'OpenCode (opsional)', done: true },
    ],
    errors: { count24h: 0, last: '' },
    data: { bytes: 2048, files: 2, dir: 'C:\\Users\\adhit\\projects\\claude-coworking\\data' },
    metrics,
  };
}

// ---------- browser helpers ----------

/** Stubs POST /api/health (everything else goes to the real API) and counts its calls. */
async function stubHealth(page, answer) {
  await page.eval((payload) => {
    window.__officeFetch ??= window.fetch;
    window.__healthAnswer = payload;
    window.__healthCalls = 0;
    window.fetch = (url, opts) => {
      if (!String(url).includes('/api/health')) return window.__officeFetch(url, opts);
      window.__healthCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({ health: window.__healthAnswer }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    };
  }, answer);
}

/** Puts the real fetch back and closes the dialogs (a failed test must not leak the stub into the next one). */
async function restoreHealth(page) {
  await page
    .eval(() => {
      if (window.__officeFetch) window.fetch = window.__officeFetch;
      delete window.__officeFetch;
      delete window.__healthAnswer;
      delete window.__healthCalls;
      document.querySelector('#health-modal').hidden = true;
      document.querySelector('#settings-modal').hidden = true;
    })
    .catch(() => {});
}

const shownInPage = (page, sel) => page.eval((s) => Boolean(document.querySelector(s)?.getClientRects().length), sel);

/** The app's own route to a header button on a phone (⋯ → the sheet's proxy row); direct on a laptop. */
const PHONE_ROUTE = { '#btn-settings': ['#btn-head-more', '#head-more-modal [data-proxy="#btn-settings"]'] };

async function tap(page, sel) {
  const route = PHONE_ROUTE[sel];
  if ((await shownInPage(page, sel)) || !route || !(await shownInPage(page, route[0]))) return page.click(sel);
  for (const step of route) {
    await page.waitFor((s) => document.querySelector(s)?.getClientRects().length, { timeoutMs: 3000, message: `${step} terlihat` }, step);
    await page.click(step);
  }
}

/** Loads the app, then stubs health (after the load: the stub lives on this document). */
async function openApp(page, answer) {
  page.clearProblems();
  await page.goto(`${BASE}/`);
  await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 15_000, message: 'app terhubung' });
  await stubHealth(page, answer);
}

/** ⚙ → Sistem → 🩺, and waits for the report to be on screen. */
async function openHealth(page) {
  await tap(page, '#btn-settings');
  await page.waitFor(() => !document.querySelector('#settings-modal').hidden, { timeoutMs: 4000, message: 'pengaturan terbuka' });
  if (!(await shownInPage(page, '#health-open'))) await page.click('[data-settings-tab="sistem"]');
  await page.waitFor(() => Boolean(document.querySelector('#health-open')?.getClientRects().length), { timeoutMs: 4000, message: 'tombol 🩺 terlihat' });
  await page.click('#health-open');
  await page.waitFor(() => !document.querySelector('#health-modal').hidden && Boolean(document.querySelector('#health-verdict')), { timeoutMs: 5000, message: 'laporan kesehatan tampil' });
}

/** The health activity section exactly as drawn (no parsing in the test: the DOM is the contract). */
function activityView() {
  const section = document.querySelector('#health-modal .health-activity');
  if (!section) return null;
  const rows = [...section.querySelectorAll('.health-days tbody tr')];
  return {
    title: section.querySelector('h3')?.textContent.trim() ?? '',
    labelId: section.querySelector('h3')?.id ?? '',
    ariaLabelledBy: section.getAttribute('aria-labelledby'),
    summary: section.querySelector('.health-size')?.textContent.trim() ?? '',
    headers: [...section.querySelectorAll('.health-days thead th')].map((th) => th.textContent.trim()),
    rows: rows.map((tr) => ({ cls: tr.className, cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()) })),
    restart: section.querySelector('p.muted')?.textContent.trim() ?? '',
    tables: section.querySelectorAll('table.health-days').length,
  };
}

// ---------- the server + browser ----------

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-health-metrics-ui-'));
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko', 'src'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = srv.address();
      srv.close(() => resolve(free));
    });
    srv.on('error', reject);
  });
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      OFFICE_GH_BIN: path.join(TMP, 'no-such-gh.exe'),
      OFFICE_UPDATE_CHECK: '0',
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000',
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_EFFORT_FAKE: 'high',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 20_000);
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && (clearTimeout(timer), resolve()));
    server.on('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}`))));
  });
  server.stdout.resume();
  server.stderr.resume();
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill();
    await sleep(500);
  }
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('🩺 📈 Aktivitas 7 hari', { skip: SKIP ?? false }, () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}: ringkasan hari ini, 7 baris (hari kosong ikut), restart; tanpa error konsol`, async () => {
      const page = await browser.newPage();
      try {
        await page.setViewport(vp);
        await openApp(page, healthAnswer());
        await openHealth(page);
        const view = await page.eval(activityView);

        assert.ok(view, 'section "Aktivitas 7 hari" tampil');
        assert.equal(view.title, 'Aktivitas 7 hari');
        assert.equal(view.labelId, 'health-activity-title');
        assert.equal(view.ariaLabelledBy, 'health-activity-title', 'judul section terhubung ke aria-labelledby');
        assert.equal(view.tables, 1);

        // Ringkasan hari ini: giliran, gagal, dari antrian, rata-rata, tunggu p95, dan kena batas (queued + refused).
        assert.equal(view.summary, 'Hari ini: 5 giliran (1 gagal) · 2 dari antrian · rata-rata 42 dtk · tunggu p95 2 mnt · 3× kena batas.');

        // Tabel: header tetap, tepat 7 baris (termasuk hari tanpa aktivitas), baris terakhir = hari ini.
        assert.deepEqual(view.headers, ['Hari', 'Giliran', 'Gagal', 'Antrian', 'Tunggu p95', 'Kena batas']);
        assert.deepEqual(view.rows.length, 7, '7 baris: hari kosong tidak dihilangkan');
        assert.deepEqual(view.rows[0].cells.slice(0, 4), ['02/11', '0', '0', '0'], 'hari kosong tetap punya baris');
        assert.equal(view.rows[0].cells[5], '0');
        assert.deepEqual(view.rows[4].cells, ['06/11', '3', '1', '1', '1 mnt', '1']);
        assert.deepEqual(view.rows[6], { cls: 'today', cells: ['08/11', '5', '1', '2', '2 mnt', '3'] }, 'baris hari ini berisi angka yang benar');

        // Restart: count + the last moment (the exact locale format is the browser\u2019s business).
        assert.match(view.restart, /^Server mulai ulang 4 kali · terakhir .+\.$/);

        assert.deepEqual(page.problems, [], 'tanpa error konsol');
      } finally {
        await restoreHealth(page);
        await page.close();
      }
    });
  }

  test('metrics kosong: ringkasan "Belum ada aktivitas", 7 baris nol, restart 0 kali', async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport(VIEWPORTS[1]);
      const metrics = {
        today: day('2026-11-08'),
        days: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'].map((key) => day(key)),
        restarts: { count: 0, lastAt: null },
      };
      await openApp(page, healthAnswer({ metrics }));
      await openHealth(page);
      const view = await page.eval(activityView);
      assert.equal(view.summary, 'Belum ada aktivitas hari ini.');
      assert.equal(view.rows.length, 7);
      assert.deepEqual(view.rows[0].cells.slice(0, 4), ['02/11', '0', '0', '0']);
      assert.deepEqual(view.rows[6].cells.slice(0, 4), ['08/11', '0', '0', '0']);
      assert.equal(view.restart, 'Server mulai ulang 0 kali.');
      assert.deepEqual(page.problems, [], 'tanpa error konsol');
    } finally {
      await restoreHealth(page);
      await page.close();
    }
  });

  test('regresi: hari tanpa sampel tunggu menampilkan "—", bukan "0 dtk"', async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport(VIEWPORTS[1]);
      await openApp(page, healthAnswer());
      await openHealth(page);
      const view = await page.eval(activityView);
      // src/metrics.js sends waitP95Ms: null when a day has no queue samples; metricMs must keep null as unknown so
      // fmtDuration shows "—" instead of turning it into 0 (Number(null) is finite).
      assert.equal(view.rows[0].cells[4], '—', 'hari tanpa sampel: kolom Tunggu p95 harus "—", bukan "0 dtk"');
    } finally {
      await restoreHealth(page);
      await page.close();
    }
  });

  test('metrics: null (server lama) → section tidak muncul, laporan lain tetap jalan', async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport(VIEWPORTS[1]);
      await openApp(page, healthAnswer({ metrics: null }));
      await openHealth(page);
      const view = await page.eval(() => ({
        activity: Boolean(document.querySelector('#health-modal .health-activity')),
        days: document.querySelectorAll('#health-modal .health-days').length,
        verdict: document.querySelector('#health-verdict')?.textContent.trim(),
        checks: document.querySelectorAll('#health-modal .health-check').length,
      }));
      assert.equal(view.activity, false, 'tanpa metrics: section 7 hari tidak dirender');
      assert.equal(view.days, 0, 'tanpa tabel aktivitas');
      assert.equal(view.verdict, 'Siap dipakai (5/5)', 'bagian lain laporan tetap tampil');
      assert.equal(view.checks, 3);
      assert.deepEqual(page.problems, [], 'tanpa error konsol');
    } finally {
      await restoreHealth(page);
      await page.close();
    }
  });

  test('backup warning: check "tidak ditemukan" tampil sebagai peringatan di dialog', async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport(VIEWPORTS[1]);
      const answer = healthAnswer({
        checks: [{ id: 'backup', label: 'Backup otomatis', ok: false, warn: true, detail: 'File backup tidak ditemukan di folder tujuan', hint: 'Folder mungkin dipindah atau file dihapus. Jalankan "Jalankan sekarang".' }],
      });
      await openApp(page, answer);
      await openHealth(page);
      const view = await page.eval(() => {
        const item = [...document.querySelectorAll('#health-modal .health-check')].find((li) => li.querySelector('b')?.textContent === 'Backup otomatis');
        return item
          ? {
              cls: item.className,
              detail: item.querySelector('.health-detail')?.textContent ?? '',
              hint: item.querySelector('small')?.textContent ?? '',
              tone: item.querySelector('.sr-only')?.textContent ?? '',
            }
          : null;
      });
      assert.ok(view, 'baris pemeriksaan backup tampil');
      assert.equal(view.cls, 'health-check warn');
      assert.equal(view.detail, 'File backup tidak ditemukan di folder tujuan');
      assert.match(view.hint, /Folder mungkin dipindah atau file dihapus/);
      assert.equal(view.tone, 'peringatan');
      assert.deepEqual(page.problems, [], 'tanpa error konsol');
    } finally {
      await restoreHealth(page);
      await page.close();
    }
  });
});
