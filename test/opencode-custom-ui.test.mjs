/* global document, window -- functions passed to page.eval run in the browser */
// 👤 Akun → tab OpenCode → ＋ Provider kustom: ID/nama/base URL/API key form, "Cek model" against
// /api/opencode/custom/check (a checkbox list of models), saved through /api/opencode/custom/add. The custom backend
// is faked IN THE PAGE (fetch interception, the opencode-config-ui.test.mjs pattern): the server side of these
// endpoints is covered elsewhere. Phone and desktop, headless Chrome/Edge via test-support/cdp.mjs.
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
const VIEWPORTS = [
  { name: 'mobile 390x844', width: 390, height: 844, mobile: true },
  { name: 'desktop 1440x900', width: 1440, height: 900, mobile: false },
];

let TMP;
let BASE;
let server;
let browser;
const horizontalOverflow = () => document.documentElement.scrollWidth > document.documentElement.clientWidth;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-oc-custom-ui-'));
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_APP_DIR: APP, // pin the app dir to the repo: a dev machine's OFFICE_APP_DIR may point at an installed Adhitron
      OFFICE_PORT: String(port),
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

/** Fake of the custom-provider backend in the page: records what goes out, answers the happy path (or a failure). */
function installCustomFake() {
  const fake = { checks: [], adds: [], fail: false };
  window.__ocCustomFake = fake;
  const real = window.fetch.bind(window);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, opts = {}) => {
    const endpoint = String(url);
    if (endpoint === '/api/opencode/providers') {
      return json({
        connected: [{ id: 'anthropic', name: 'Anthropic', connections: [{ id: 'cred-1', type: 'credential', label: 'Claude Pro', method: 'oauth' }] }],
        available: [],
        usage: { today: { total: 100, costUsd: 0.01 }, week: { total: 700, costUsd: 0.07, costCoverage: 1 } },
      });
    }
    if (endpoint === '/api/opencode/custom/check') {
      fake.checks.push(JSON.parse(opts.body ?? '{}'));
      await new Promise((r) => setTimeout(r, 60)); // the "Memeriksa…" state is observable, however briefly
      return json({ models: ['river-large', { id: 'river-mini', name: 'River Mini' }] });
    }
    if (endpoint === '/api/opencode/custom/add') {
      fake.adds.push(JSON.parse(opts.body ?? '{}'));
      if (fake.fail) return json({ error: 'ID sudah dipakai.' }, 400);
      return json({ ok: true });
    }
    return real(url, opts);
  };
}

/** Typing into the form as the keyboard would: value + a trusted `input` event (state must remember it). */
const fillFields = (flat) => {
  for (let i = 0; i < flat.length; i += 2) {
    const input = document.querySelector(flat[i]);
    input.value = flat[i + 1];
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
};

for (const vp of VIEWPORTS) {
  describe(`👤 Akun → ＋ Provider kustom — ${vp.name}`, { skip: SKIP ?? false }, () => {
    test('tombol di panel login, form, cek model, simpan, dan pesan gagal server', async () => {
      const page = await browser.newPage({ width: vp.width, height: vp.height, mobile: vp.mobile });
      try {
        page.clearProblems();
        await page.goto(`${BASE}/`);
        await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000, message: 'app ready' });
        await page.eval(installCustomFake);
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.accountAuth = true; // localhost already grants this; set for determinism
        });

        await tap(page, '#btn-account');
        await page.waitFor(() => !document.querySelector('#account-modal').hidden, { timeoutMs: 4000, message: 'modal Akun terbuka' });
        await page.eval(() => { const s = document.querySelector('#acct-tab'); s.value = 'opencode'; s.dispatchEvent(new Event('change', { bubbles: true })); });
        await page.waitFor(() => document.querySelector('#account-body [data-act="oc-pick"]')?.getClientRects().length, { timeoutMs: 6000, message: 'tombol ＋ Login provider' });
        const buttons = await page.eval(() => ({
          login: document.querySelector('#account-body [data-act="oc-pick"]')?.textContent.trim() ?? null,
          custom: document.querySelector('#account-body [data-act="oc-custom"]')?.textContent.trim() ?? null,
        }));
        assert.equal(buttons.login, '＋ Login provider');
        assert.equal(buttons.custom, '＋ Provider kustom', 'tombol ＋ Provider kustom di sampingnya');

        // Opening the custom form replaces the provider picker panel.
        await page.click('#account-body [data-act="oc-custom"]');
        await page.waitFor(() => document.querySelector('#oc-custom-form')?.getClientRects().length, { timeoutMs: 4000, message: 'form provider kustom' });
        const form = await page.eval(() => ({
          picker: Boolean(document.querySelector('#oc-provider')),
          placeholders: ['#oc-custom-id', '#oc-custom-name', '#oc-custom-base', '#oc-custom-key'].map((s) => document.querySelector(s)?.placeholder ?? null),
          keyType: document.querySelector('#oc-custom-key')?.type,
          autocompleteOff: [...document.querySelectorAll('#oc-custom-form input')].every((i) => i.getAttribute('autocomplete') === 'off'),
          checkBtn: document.querySelector('#account-body [data-act="oc-check"]')?.textContent.trim() ?? null,
          close: document.querySelector('#account-body [data-act="oc-close"]')?.textContent.trim() ?? null,
        }));
        assert.equal(form.picker, false, 'panel pilih provider digantikan form kustom');
        assert.deepEqual(form.placeholders, ['river', 'River AI', 'https://api.river.ai/v1', 'Tempel API key']);
        assert.equal(form.keyType, 'password', 'API key tersembunyi');
        assert.equal(form.autocompleteOff, true);
        assert.equal(form.checkBtn, 'Cek model');
        assert.equal(form.close, 'Tutup');

        // Client guard: a base URL off https://(loopback) is refused inline, without calling the server.
        await page.eval(fillFields, ['#oc-custom-base', 'ftp://api.river.ai/v1']);
        await page.click('#account-body [data-act="oc-check"]');
        await page.waitFor(() => /Base URL harus/.test(document.querySelector('#oc-login')?.textContent ?? ''), { timeoutMs: 3000, message: 'pesan guard base URL' });
        assert.equal(await page.eval(() => window.__ocCustomFake.checks.length), 0, 'guard klien: tidak ada fetch');

        // The rest of the fields, then "Cek model": the fake answers two models, pre-ticked.
        await page.eval(fillFields, [
          '#oc-custom-base',
          'https://api.river.ai/v1',
          '#oc-custom-id',
          'river',
          '#oc-custom-name',
          'River AI',
          '#oc-custom-key',
          'sk-river-secret',
        ]);
        await page.click('#account-body [data-act="oc-check"]');
        await page.waitFor(() => document.querySelectorAll('#oc-custom-form input[name="oc-custom-model"]').length === 2, { timeoutMs: 4000, message: 'daftar model dari cek' });
        const listed = await page.eval(() => ({
          count: (document.querySelector('#oc-custom-form')?.textContent.match(/\d+ model ditemukan/) ?? [])[0] ?? null,
          boxes: [...document.querySelectorAll('#oc-custom-form input[name="oc-custom-model"]')].map((b) => [b.value, b.checked]),
          checkPayload: window.__ocCustomFake.checks[0] ?? null,
          checkBtn: document.querySelector('#account-body [data-act="oc-check"]')?.textContent.trim(),
        }));
        assert.equal(listed.count, '2 model ditemukan');
        assert.deepEqual(listed.boxes, [['river-large', true], ['river-mini', true]], 'semua model tercentang');
        assert.deepEqual(listed.checkPayload, { baseURL: 'https://api.river.ai/v1', key: 'sk-river-secret' }, '"Cek model" hanya kirim baseURL + key');
        assert.equal(listed.checkBtn, 'Cek model', 'tombol kembali normal setelah cek selesai');

        // Uncheck one model, save: only the checked ids go out, then the panel returns to its buttons.
        await page.click('#oc-custom-form input[name="oc-custom-model"][value="river-mini"]');
        await page.click('#oc-custom-form .primary');
        await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Provider kustom River AI tersimpan\. API key disimpan ke OpenCode\./.test(t.textContent)), { timeoutMs: 4000, message: 'toast sukses' });
        const saved = await page.eval(() => ({
          add: window.__ocCustomFake.adds[0] ?? null,
          formGone: !document.querySelector('#oc-custom-form'),
          customBack: document.querySelector('#account-body [data-act="oc-custom"]')?.getClientRects().length ?? 0,
        }));
        assert.deepEqual(saved.add, { id: 'river', name: 'River AI', baseURL: 'https://api.river.ai/v1', key: 'sk-river-secret', models: ['river-large'] }, 'payload add lengkap, hanya model tercentang');
        assert.equal(saved.formGone, true, 'form ditutup setelah sukses');
        assert.ok(saved.customBack, 'tombol ＋ Provider kustom tampil lagi');

        // Server error: the toast names it and the form keeps everything typed.
        await page.click('#account-body [data-act="oc-custom"]');
        await page.waitFor(() => document.querySelector('#oc-custom-form')?.getClientRects().length, { timeoutMs: 4000, message: 'form terbuka lagi' });
        await page.eval(fillFields, [
          '#oc-custom-id',
          'river-dupe',
          '#oc-custom-name',
          'River Dua',
          '#oc-custom-base',
          'https://api.river.ai/v1',
          '#oc-custom-key',
          'sk-dupe',
        ]);
        await page.click('#account-body [data-act="oc-check"]');
        await page.waitFor(() => document.querySelectorAll('#oc-custom-form input[name="oc-custom-model"]').length === 2, { timeoutMs: 4000, message: 'cek ulang' });
        await page.eval(() => {
          window.__ocCustomFake.fail = true;
        });
        await page.click('#oc-custom-form .primary');
        await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Gagal: ID sudah dipakai\./.test(t.textContent)), { timeoutMs: 4000, message: 'toast gagal' });
        const kept = await page.eval(() => ({
          form: Boolean(document.querySelector('#oc-custom-form')),
          id: document.querySelector('#oc-custom-id')?.value,
          name: document.querySelector('#oc-custom-name')?.value,
          baseURL: document.querySelector('#oc-custom-base')?.value,
          key: document.querySelector('#oc-custom-key')?.value,
        }));
        assert.equal(kept.form, true, 'form tetap ada setelah gagal');
        assert.deepEqual([kept.id, kept.name, kept.baseURL], ['river-dupe', 'River Dua', 'https://api.river.ai/v1'], 'isi form tidak hilang');
        assert.equal(kept.key, 'sk-dupe', 'API key tidak dihapus');

        page.clearProblems(); // the 400 above is the point of this step
        assert.equal(await page.eval(horizontalOverflow), false);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });
  });
}
