/* global document, window -- functions passed to page.eval run in the browser */
// 👤 Akun → tab OpenCode → 🗑 Hapus (provider kustom): the delete button only on `custom: true` providers, the
// impact confirm before anything is sent, POST /api/opencode/custom/remove { id, confirm: 'HAPUS' }, the success
// toast + list reload, the 409 message shown inline, and a no-double-request guard. The custom backend is faked IN
// THE PAGE (fetch interception, the opencode-custom-ui.test.mjs pattern): the server side is covered elsewhere.
// Phone and desktop, headless Chrome/Edge via test-support/cdp.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';
import { accountImpactText } from '../public/js/core/account-impact.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const VIEWPORTS = [
  { name: 'mobile 390x844', width: 390, height: 844, mobile: true },
  { name: 'desktop 1440x900', width: 1440, height: 900, mobile: false },
];

let TMP;
let BASE;
let server;
let browser;
const horizontalOverflow = () => document.documentElement.scrollWidth > document.documentElement.clientWidth;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  TMP = mkdtempSync(path.join(tmpdir(), 'office-oc-remove-ui-'));
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      // Pin the app dir to the repo: a dev machine can carry OFFICE_APP_DIR pointing at an installed Adhitron,
      // and this test must exercise THIS repo's public/ (the installed copy never has the newest UI).
      OFFICE_APP_DIR: APP,
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000', // the engine checks stay out of the way
      OFFICE_OPENCODE_CHECK_DELAY_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 20000);
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
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// Phone Chat: a header button is reached through the ⋯ sheet (ui.test.mjs's route, only what this file needs).
const viaHeadMore = (sel) => ['#btn-head-more', `#head-more-modal [data-proxy="${sel}"]`];
const PHONE_ROUTE = { '#btn-account': viaHeadMore('#btn-account') };
const shown = (page, sel) => page.eval((s) => Boolean(document.querySelector(s)?.getClientRects().length), sel);

/** Clicks `sel` like a user: directly when it is on screen, else (phone) through its sheet route. */
async function tap(page, sel) {
  const route = PHONE_ROUTE[sel];
  if ((await shown(page, sel)) || !route || !(await shown(page, route[0]))) return page.click(sel);
  for (const step of route) {
    await page.waitFor((s) => document.querySelector(s)?.getClientRects().length && !document.querySelector(s).closest('.modal-card')?.getAnimations().some((a) => a.playState === 'running'), { timeoutMs: 2000, message: `${step} terlihat` }, step);
    await page.click(step);
  }
}

/** Fake of the custom-provider backend in the page: records removes, answers providers from `fake.providers`.
 *  Self-contained: functions passed to page.eval run in the browser and cannot close over Node-scope helpers. */
function installRemoveFake() {
  const fresh = [
    {
      id: 'river',
      name: 'River AI',
      custom: true,
      connections: [
        { id: 'cred-river-1', type: 'credential', label: 'River key', method: 'key' },
        { id: 'cred-river-2', type: 'credential', label: 'River OAuth', method: 'oauth' },
      ],
    },
    { id: 'anthropic', name: 'Anthropic', connections: [{ id: 'cred-1', type: 'credential', label: 'Claude Pro', method: 'oauth' }] },
  ];
  const clone = (list) => list.map((p) => JSON.parse(JSON.stringify(p)));
  const fake = {
    providers: clone(fresh),
    fresh,
    removes: [],
    confirms: [],
    confirm: true, // window.confirm's answer; the cancel test flips this
    fail: null, // { status, error } the next remove answers with
    delay: 60,
  };
  window.__ocRemoveFake = fake;
  const real = window.fetch.bind(window);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.confirm = (text) => {
    fake.confirms.push(String(text));
    return fake.confirm;
  };
  window.fetch = async (url, opts = {}) => {
    const endpoint = String(url);
    if (endpoint === '/api/opencode/providers') {
      return json({
        connected: fake.providers,
        available: [],
        usage: { today: { total: 100, costUsd: 0.01 }, week: { total: 700, costUsd: 0.07, costCoverage: 1 } },
      });
    }
    if (endpoint === '/api/opencode/custom/remove') {
      const body = JSON.parse(opts.body ?? '{}');
      fake.removes.push(body);
      await new Promise((r) => setTimeout(r, fake.delay)); // slow enough that a double click is observable
      if (fake.fail) return json({ error: fake.fail.error }, fake.fail.status);
      fake.providers = fake.providers.filter((p) => p.id !== body.id); // gone from the next providers fetch
      return json({ ok: true, provider: body.id, credentialsRemoved: 1, credentialErrors: [], path: 'C:\\config', backup: 'C:\\backup' });
    }
    return real(url, opts);
  };
}

for (const vp of VIEWPORTS) {
  describe(`👤 Akun → tab OpenCode → 🗑 Hapus provider kustom — ${vp.name}`, { skip: SKIP ?? false }, () => {
    test('tombol hanya di provider kustom, konfirmasi dampak, hapus, pesan 409 inline, dan guard dobel', async () => {
      const page = await browser.newPage({ width: vp.width, height: vp.height, mobile: vp.mobile });
      try {
        page.clearProblems();
        await page.goto(`${BASE}/`);
        await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000, message: 'app ready' });
        await page.eval(installRemoveFake);
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.accountAuth = true; // localhost already grants this; set for determinism
        });

        await tap(page, '#btn-account');
        await page.waitFor(() => !document.querySelector('#account-modal').hidden, { timeoutMs: 4000, message: 'modal Akun terbuka' });
        await page.eval(() => { const s = document.querySelector('#acct-tab'); s.value = 'opencode'; s.dispatchEvent(new Event('change', { bubbles: true })); });
        await page.waitFor(() => document.querySelector('#account-body [data-act="oc-refresh"]')?.getClientRects().length, { timeoutMs: 6000, message: 'tab OpenCode terbuka' });
        // The providers may already be loaded from the real server (before the fake): refresh through the fake once.
        await page.click('#account-body [data-act="oc-refresh"]');
        await page.waitFor(() => document.querySelector('#account-body [data-act="oc-delete"]')?.getClientRects().length, { timeoutMs: 6000, message: 'tombol 🗑 Hapus di bar River AI' });

        // Exactly one delete button, on the custom provider's title bar (not one per connection), none on Anthropic.
        const btn = await page.eval(() => {
          const all = [...document.querySelectorAll('#account-body [data-act="oc-delete"]')];
          const b = all[0];
          return {
            count: all.length,
            text: b.textContent.trim(),
            cls: b.className,
            id: b.dataset.id,
            name: b.dataset.name,
            title: b.title,
            inProvider: b.closest('li.oc-provider')?.querySelector('b')?.textContent ?? null,
            connCount: b.closest('li.oc-provider')?.querySelectorAll('.oc-conns li').length ?? null,
            anthropicHas: [...document.querySelectorAll('#account-body li.oc-provider')].some((li) => !li.querySelector('[data-act="oc-delete"]') && li.textContent.includes('Anthropic')),
          };
        });
        assert.equal(btn.count, 1, 'satu tombol Hapus (bar judul, bukan per koneksi)');
        assert.equal(btn.text, '🗑 Hapus');
        assert.match(btn.cls, /ghost/, 'kelas ghost');
        assert.match(btn.cls, /danger-text/, 'kelas danger-text');
        assert.equal(btn.id, 'river');
        assert.equal(btn.name, 'River AI');
        assert.equal(btn.title, 'Hapus provider kustom: kredensial + blok config', 'tooltip dampak');
        assert.equal(btn.inProvider, 'River AI', 'tombol ada di bar judul provider River AI');
        assert.equal(btn.connCount, 2, 'provider punya 2 koneksi: tetap satu tombol');
        assert.equal(btn.anthropicHas, true, 'provider resmi (Anthropic) tidak punya tombol Hapus');

        // Batal di dialog dampak: nothing is sent.
        await page.eval(() => {
          window.__ocRemoveFake.confirm = false;
        });
        await page.click('#account-body [data-act="oc-delete"]');
        const cancelled = await page.eval(() => ({ confirms: window.__ocRemoveFake.confirms, removes: window.__ocRemoveFake.removes }));
        assert.equal(cancelled.confirms.length, 1, 'satu dialog dampak sebelum hapus');
        const conf = cancelled.confirms[0];
        assert.match(conf, /Hapus provider kustom River AI\?/);
        assert.match(conf, /kredensial/, 'dampak menyebut kredensial');
        assert.match(conf, /blok config/, 'dampak menyebut blok config');
        assert.match(conf, /model lain/, 'dampak menyebut model project yang memakainya');
        assert.match(conf, /Antrian semua project dijeda/, 'dampak memuat poin bersama');
        assert.equal(cancelled.removes.length, 0, 'Batal: tidak ada POST /api/opencode/custom/remove');

        // Konfirmasi: exactly { id, confirm: 'HAPUS' } goes out, a success toast shows, and the list reloads.
        await page.eval(() => {
          window.__ocRemoveFake.confirm = true;
        });
        await page.click('#account-body [data-act="oc-delete"]');
        await page.waitFor(() => window.__ocRemoveFake.removes.length >= 1, { timeoutMs: 4000, message: 'POST remove terkirim' });
        await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Provider kustom River AI dihapus\./.test(t.textContent)), { timeoutMs: 4000, message: 'toast sukses' });
        await page.waitFor(() => !document.querySelector('#account-body [data-act="oc-delete"]'), { timeoutMs: 6000, message: 'daftar dimuat ulang tanpa River' });
        const afterDelete = await page.eval(() => ({
          remove: window.__ocRemoveFake.removes[0] ?? null,
          riverGone: ![...document.querySelectorAll('#account-body li.oc-provider')].some((li) => li.textContent.includes('River AI')),
        }));
        assert.deepEqual(afterDelete.remove, { id: 'river', confirm: 'HAPUS' }, 'payload remove: id + confirm HAPUS');
        assert.equal(afterDelete.riverGone, true, 'River AI hilang dari daftar setelah reload');

        // 409 (blok bukan buatan aplikasi): the server message shows inline, whole, near the provider list.
        const toastsBefore409 = await page.eval(() => document.querySelectorAll('.toast').length);
        await page.eval(() => {
          const fake = window.__ocRemoveFake;
          fake.providers = fake.fresh.map((p) => JSON.parse(JSON.stringify(p)));
          fake.fail = { status: 409, error: 'Blok config ini bukan buatan aplikasi. Hapus manual lewat ⚙ → Config OpenCode.' };
        });
        await page.click('#account-body [data-act="oc-refresh"]');
        await page.waitFor(() => document.querySelector('#account-body [data-act="oc-delete"]')?.getClientRects().length, { timeoutMs: 6000, message: 'River AI tampil lagi setelah refresh' });
        await page.click('#account-body [data-act="oc-delete"]');
        await page.waitFor(() => /Blok config ini bukan buatan aplikasi\. Hapus manual lewat ⚙ → Config OpenCode\./.test(document.querySelector('#account-body')?.textContent ?? ''), { timeoutMs: 4000, message: 'pesan 409 tampil inline utuh' });
        const errState = await page.eval(() => ({
          removes: window.__ocRemoveFake.removes.length,
          warn: document.querySelector('#account-body .warn')?.textContent ?? '',
          riverStill: Boolean([...document.querySelectorAll('#account-body li.oc-provider')].some((li) => li.textContent.includes('River AI'))),
          toasts: document.querySelectorAll('.toast').length,
        }));
        assert.equal(errState.removes, 2, 'hapus kedua memang terkirim (server yang menolak)');
        assert.match(errState.warn, /⚙ → Config OpenCode/, 'pesan server utuh, tidak dipotong');
        assert.equal(errState.riverStill, true, 'provider tetap di daftar setelah gagal');
        assert.equal(errState.toasts, toastsBefore409, 'gagal: tidak ada toast baru (sukses maupun gagal)');

        // Double click while the request runs: exactly one remove goes out.
        await page.eval(() => {
          const fake = window.__ocRemoveFake;
          fake.fail = null;
          fake.delay = 400;
        });
        await page.click('#account-body [data-act="oc-delete"]');
        await sleep(120); // the first request is in flight; the button is gone or guarded by now
        const second = await page.eval(() => document.querySelector('#account-body [data-act="oc-delete"]'));
        if (second) await page.click('#account-body [data-act="oc-delete"]');
        await page.waitFor(() => !document.querySelector('#account-body [data-act="oc-delete"]'), { timeoutMs: 8000, message: 'hapus ketiga (dibolehkan) selesai' });
        const guarded = await page.eval(() => window.__ocRemoveFake.removes.map((r) => r.id));
        assert.equal(guarded.length, 3, 'guard: klik saat request berjalan tidak mengirim request kedua');
        assert.deepEqual(guarded, ['river', 'river', 'river']);

        page.clearProblems(); // the 409 above is the point of this step
        assert.equal(await page.eval(horizontalOverflow), false);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });
  });
}

// The impact text is pure: read the same words without a browser (unknown kinds must stay empty).
test('accountImpactText: opencode-delete memuat dampak kredensial + blok config; kind tak dikenal kosong', () => {
  const text = accountImpactText('opencode-delete', 'River AI');
  assert.match(text, /Hapus provider kustom River AI\?/);
  assert.match(text, /kredensial/);
  assert.match(text, /blok config/);
  assert.match(text, /model lain/);
  assert.match(text, /Antrian semua project dijeda/);
  assert.match(text, /Giliran yang sedang berjalan dibiarkan selesai dulu/);
  assert.match(text, /Lanjutkan hapus\?/);
  assert.match(accountImpactText('opencode-delete', ''), /Hapus provider kustom ini\?/, 'target kosong tetap punya judul masuk akal');
  assert.equal(accountImpactText('tidak-ada', 'x'), '', 'kind tak dikenal: string kosong, dialog konfirmasi tidak pernah kosong');
});
