/* global document, window, getComputedStyle, DataTransfer, DragEvent -- functions passed to page.eval run in the browser */
// Chat tab on a phone (docs/design-mobile-chat.md, phase 1) in a headless Chrome/Edge (test-support/cdp.mjs):
// compact header + ⋯ sheet, two-row composer (＋ sheet, settings chip, one morphing send/stop/🎤 button),
// status strip, read-only banner, keyboard inset. Desktop (1440×900) must stay exactly as it was.
//   OFFICE_UI_SHOTS=<folder> node --test --test-concurrency=1 test/mobile-chat.test.mjs   # also keeps screenshots
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';
import { lanAddresses } from '../src/remote.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const SHOTS = process.env.OFFICE_UI_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHONES = [
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '360x740', width: 360, height: 740, mobile: true },
];
const DESKTOP = { name: '1440x900', width: 1440, height: 900, mobile: false };

let TMP;
let BASE;
let server;
let browser;
let token;
let projectId; // "toko": a real project with an empty chat

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

const api = (p, body = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then((r) => r.json());

async function snapshot() {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/stream`, { signal: controller.signal });
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

/** Waits (bounded) until the server's snapshot satisfies `ok`. */
async function untilSnapshot(ok, message) {
  for (let i = 0; i < 50; i++) {
    const snap = await snapshot();
    if (ok(snap)) return snap;
    await sleep(200);
  }
  throw new Error(`timeout menunggu ${message}`);
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-mobile-chat-'));
  mkdirSync(path.join(TMP, 'projects', 'toko', 'src'), { recursive: true });
  writeFileSync(path.join(TMP, 'projects', 'toko', 'src', 'checkout.ts'), 'export {};\n');
  mkdirSync(path.join(TMP, 'projects', 'izin'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'), // never the real Tailscale CLI
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPEN_DRY_RUN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server tidak start dalam 20 dtk')), 20000);
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && (clearTimeout(timer), resolve()));
    server.on('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}`))));
  });
  server.stderr.resume();
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  projectId = (await snapshot()).projects.find((p) => p.name === 'toko').id;
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await Promise.race([exited, sleep(3000)]);
  }
  if (TMP) {
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(TMP, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------- in-page probes (self-contained: serialised into the page) ----------

function appReady() {
  return document.querySelector('#conn')?.classList.contains('ok') && document.querySelector('#crumb')?.textContent.trim().length > 0;
}

function horizontalOverflow() {
  const { scrollWidth, clientWidth } = document.documentElement;
  const wide = [...document.querySelectorAll('body *')]
    .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > clientWidth + 0.5 && !el.closest('.modal[hidden]') && getComputedStyle(el).position !== 'fixed')
    .filter((el) => !el.closest('.statusline, .chat, .md, .table-wrap, pre') || el.matches('.statusline, .chat')) // scrollers clip their own content
    .slice(0, 5)
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className).trim().split(/\s+/).join('.')} right=${Math.round(el.getBoundingClientRect().right)}`);
  return scrollWidth > clientWidth || wide.length ? { scrollWidth, clientWidth, wide } : null;
}

/** Interactive controls a user can see in `rootSel` (no hidden ancestors, a box on screen). */
function visibleControls(rootSel) {
  const root = document.querySelector(rootSel);
  const shown = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]');
  return [...root.querySelectorAll('button, select, textarea, input:not([type="hidden"]), [role="button"]')]
    .filter(shown)
    .map((el) => el.id || `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`);
}

/** Layout fingerprint of the chrome around the chat (desktop must not change). */
function layoutFingerprint() {
  const sels = ['.topbar', '#crumb', '#quota-pill', '#spotify-box', '#btn-account', '#btn-dashboard', '#btn-palette', '#btn-report', '#btn-phone', '#btn-notify', '#btn-help', '#btn-settings', '#conn',
    '.tabs', '#session-bar', '#sb-title', '#sb-tasks', '#sb-queue', '#btn-sessions', '#btn-new', '#btn-more', '#sb-meta', '#chat', '#typing', '#composer', '#todos', '.controls', '#settings-chip', '#mode', '#model', '#effort', '#team-mode',
    '#suggest', '#attachments', '.input', '#btn-attach', '#btn-template', '#prompt', '#btn-voice', '#btn-stop', '#btn-queue-add', '#btn-send', '#statusline', '#composer-hint', '#mobile-nav'];
  const out = {};
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (!el) {
      out[sel] = null;
      continue;
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out[sel] = { shown: Boolean(el.getClientRects().length) && cs.visibility !== 'hidden', x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), display: cs.display, font: cs.fontSize, parent: el.parentElement?.id || el.parentElement?.className || '', text: el.matches('button') ? el.textContent.trim().slice(0, 40) : undefined };
  }
  out.phoneOnlyShown = [...document.querySelectorAll('.phone-only')].filter((el) => el.getClientRects().length).map((el) => el.id || el.className);
  return out;
}

// ---------- helpers ----------

async function openApp(page, hash) {
  page.clearProblems();
  await page.goto(`${BASE}/${hash}`);
  await page.waitFor(appReady, { timeoutMs: 10000, message: 'app terhubung' });
  await sleep(300);
}

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await sleep(150); // let the last frame paint
  writeFileSync(path.join(SHOTS, `${name}.png`), await page.screenshot());
}

/** Overrides the active project's status in the page and re-renders the composer (restored by `resetStatus`). */
function patchStatus(page, patch) {
  return page.eval(async (patch) => {
    const { state } = await import('/js/core/state.js');
    const { renderComposer } = await import('/js/features/composer.js');
    const pid = state.active;
    window.__savedStatus ??= { value: state.statuses[pid] };
    state.statuses[pid] = { ...state.statuses[pid], ...patch };
    renderComposer();
  }, patch);
}

function resetStatus(page) {
  return page.eval(async () => {
    const { state } = await import('/js/core/state.js');
    const { renderComposer } = await import('/js/features/composer.js');
    if (window.__savedStatus) state.statuses[state.active] = window.__savedStatus.value ?? {};
    window.__savedStatus = undefined;
    renderComposer();
  });
}

const BUSY = {
  busy: true,
  todos: [
    { content: 'Baca kode login', status: 'completed', activeForm: 'Membaca kode login' },
    { content: 'Tambah validasi', status: 'completed', activeForm: 'Menambah validasi' },
    { content: 'Tulis test', status: 'in_progress', activeForm: 'Menulis test' },
    { content: 'Jalankan test', status: 'pending', activeForm: 'Menjalankan test' },
    { content: 'Review', status: 'pending', activeForm: 'Me-review' },
  ],
  tasks: [{ id: 'bg1', status: 'running', role: 'qa', description: 'Uji regresi', background: true, startedAt: Date.now() }],
  taskQueue: { waiting: 2, running: 0, failed: 0, done: 0, paused: false, rev: 1 },
  context: { used: 156000, window: 200000, autoCompactAt: 200000 },
};

/** Puts text in the composer like typing does (value + input event). */
const setPrompt = (page, text) =>
  page.eval((text) => {
    const input = document.querySelector('#prompt');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);

const dropFiles = (page) =>
  page.eval(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['TypeError: boom\n'], 'error.log', { type: 'text/plain' }));
    dt.items.add(new File(['%PDF-1.4\n%%EOF\n'], 'spesifikasi-lengkap.pdf', { type: 'application/pdf' }));
    dt.items.add(new File(['a,b\n1,2\n'], 'data.csv', { type: 'text/csv' }));
    document.querySelector('.input').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });

const clearAttachmentsInPage = (page) =>
  page.eval(async () => {
    const { clearAttachments } = await import('/js/features/attachments.js');
    clearAttachments();
  });

const closeModals = (page) =>
  page.eval(() => {
    document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
    document.activeElement?.blur?.();
  });

/** A read-only page (phone on plain WiFi), or null when this laptop has no LAN address. */
async function lanPage(vp) {
  const ip = lanAddresses()[0];
  if (!ip) return null;
  await api('/api/remote', { enabled: true });
  await sleep(300);
  const { code } = await api('/api/remote/pairing');
  const LAN = `http://${ip}:${new URL(BASE).port}`;
  const paired = await fetch(`${LAN}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal(paired.status, 200, 'pairing lewat LAN');
  const [name, value] = paired.headers.get('set-cookie').split(';')[0].split('=');
  const page = await browser.newPage();
  await page.setViewport(vp);
  await page.send('Network.setCookie', { name, value, url: LAN, httpOnly: true, sameSite: 'Strict' });
  await page.goto(`${LAN}/#${projectId}`);
  await page.waitFor(appReady, { timeoutMs: 10000, message: 'app terhubung lewat LAN' });
  await page.waitFor(() => document.body.classList.contains('read-only'), { timeoutMs: 5000, message: 'mode hanya-lihat' });
  return page;
}

// ---------- screenshots (before/after review; only written with OFFICE_UI_SHOTS) ----------

describe('HP chat: screenshot', { skip: SKIP ?? false }, () => {
  test('state chat di 390, 360 dan desktop 1440 (+ sidik layout desktop)', async () => {
    for (const vp of [...PHONES, DESKTOP]) {
      const page = await browser.newPage();
      const tag = vp.name;
      try {
        await page.setViewport(vp);
        await openApp(page, `#${projectId}`);
        await shot(page, `chat-idle-${tag}`);
        if (SHOTS && !vp.mobile) {
          writeFileSync(path.join(SHOTS, `desktop-layout-idle.json`), JSON.stringify(await page.eval(layoutFingerprint), null, 1));
          // Pixel crops without the animated office: header and chat panel (compared before/after byte for byte).
          for (const [name, sel] of [['topbar', '.topbar'], ['panel', '.panel']]) {
            const clip = await page.eval((s) => {
              const r = document.querySelector(s).getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            }, sel);
            writeFileSync(path.join(SHOTS, `desktop-${name}-idle.png`), await page.screenshot({ clip }));
          }
        }

        await patchStatus(page, BUSY);
        await shot(page, `chat-busy-${tag}`);
        if (SHOTS && !vp.mobile) writeFileSync(path.join(SHOTS, `desktop-layout-busy.json`), JSON.stringify(await page.eval(layoutFingerprint), null, 1));
        await setPrompt(page, 'tolong cek juga halaman checkout');
        await shot(page, `chat-busy-typing-${tag}`);
        await setPrompt(page, '');
        await resetStatus(page);

        await dropFiles(page);
        await page.waitFor(() => document.querySelectorAll('#attachments .att-chip').length === 3, { timeoutMs: 5000, message: '3 chip lampiran' });
        await setPrompt(page, 'tolong cek error di file ini,\nterutama bagian header');
        await shot(page, `chat-composer-attach-${tag}`);
        if (SHOTS && !vp.mobile) writeFileSync(path.join(SHOTS, `desktop-layout-attach.json`), JSON.stringify(await page.eval(layoutFingerprint), null, 1));
        await setPrompt(page, '');
        await clearAttachmentsInPage(page);

        // The sheets exist only after the redesign.
        for (const [trigger, name] of [['#btn-plus', 'sheet-plus'], ['#settings-chip', 'sheet-settings'], ['#btn-head-more', 'sheet-more']]) {
          const shown = await page.eval((sel) => Boolean(document.querySelector(sel)?.getClientRects().length), trigger);
          if (!shown) continue;
          await page.click(trigger);
          await sleep(250);
          await shot(page, `${name}-${tag}`);
          await closeModals(page);
        }

        if (vp.mobile) {
          await page.eval(() => document.querySelector('#prompt').focus());
          await page.setViewport({ ...vp, height: vp.height - 336 }); // a phone keyboard
          await sleep(300);
          await shot(page, `chat-keyboard-${tag}`);
          await page.setViewport(vp);
          await page.eval(() => document.querySelector('#prompt').blur());
        }
      } finally {
        await page.close();
      }
    }

    // A pending permission card (fake Claude asks before writing a file), on the phone.
    const pid = (await snapshot()).projects.find((p) => p.name === 'izin').id;
    await api(`/api/projects/${pid}/prompt`, { text: 'minta izin tulis file' });
    await untilSnapshot((s) => s.approvals.some((a) => a.project === pid && a.status === 'pending'), 'izin menunggu');
    for (const vp of [...PHONES, DESKTOP]) {
      const page = await browser.newPage();
      try {
        await page.setViewport(vp);
        await openApp(page, `#${pid}`);
        await page.waitFor(() => document.querySelector('.approval.pending'), { timeoutMs: 5000, message: 'kartu izin' });
        await shot(page, `chat-approval-${vp.name}`);
      } finally {
        await page.close();
      }
    }
    const snap = await snapshot();
    for (const a of snap.approvals) if (a.status === 'pending') await api(`/api/approvals/${a.id}`, { allow: false }).catch(() => {});

    // Read-only (phone on plain WiFi).
    for (const vp of PHONES) {
      const page = await lanPage(vp);
      if (!page) break;
      try {
        await shot(page, `chat-readonly-${vp.name}`);
        if (await page.eval(() => Boolean(document.querySelector('#btn-head-more')?.getClientRects().length))) {
          await page.click('#btn-head-more');
          await sleep(250);
          await shot(page, `sheet-more-readonly-${vp.name}`);
        }
      } finally {
        await page.close();
      }
    }
    await api('/api/remote', { enabled: false }).catch(() => {});
  });
});

// ---------- functional checks (§8.2) ----------

/** Visible ones among the toolbar's send/stop/voice buttons. */
function toolbarButtons() {
  return ['#btn-send', '#btn-stop', '#btn-voice'].filter((sel) => document.querySelector(sel).getClientRects().length).map((sel) => ({ sel, label: document.querySelector(sel).getAttribute('aria-label') }));
}

const promptWidth = (page) => page.eval(() => Math.round(document.querySelector('#prompt').getBoundingClientRect().width));
const isShown = (page, sel) => page.eval((s) => Boolean(document.querySelector(s)?.getClientRects().length), sel);
const toastSeen = (page, re) => page.waitFor((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent)), { timeoutMs: 2000, message: `toast ${re}` }, re.source);

for (const vp of PHONES) {
  describe(`HP chat ${vp.name}`, { skip: SKIP ?? false }, () => {
    let page;
    before(async () => {
      if (SKIP) return;
      page = await browser.newPage();
      await page.setViewport(vp);
      await openApp(page, `#${projectId}`);
    });
    after(async () => page?.close());

    /** Back to a clean phone page on toko (any test may run alone). */
    async function fresh() {
      await page.setViewport(vp);
      await closeModals(page);
      await resetStatus(page);
      await setPrompt(page, '');
      await clearAttachmentsInPage(page);
      await page.eval(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      page.clearProblems();
    }

    test('composer ringkas: ≤ 5 kontrol di composer, header ≤ 2 tombol, tanpa overflow, textarea ≥ 280 px di setiap state', async () => {
      await fresh();
      const composer = await page.eval(visibleControls, '#composer');
      assert.ok(composer.length <= 5, `kontrol composer: ${composer.join(', ')}`);
      assert.deepEqual(composer.filter((c) => ['prompt', 'btn-plus', 'settings-chip'].includes(c)).sort(), ['btn-plus', 'prompt', 'settings-chip']);
      assert.deepEqual(await page.eval(visibleControls, '.topbar'), ['crumb', 'btn-head-more'], 'header: crumb + ⋯');
      if (vp.width === 390) {
        const chatH = await page.eval(() => Math.round(document.querySelector('#chat').getBoundingClientRect().height));
        assert.ok(chatH >= 560, `tinggi #chat ${chatH} px (A7: ≥ 560)`);
      }
      // 44 px targets: ＋, ⋯ and the send/stop/voice button; the chip ≥ 36 px tall
      const sizes = await page.eval(() =>
        Object.fromEntries(
          ['#btn-plus', '#btn-head-more', '#settings-chip', ...['#btn-send', '#btn-stop', '#btn-voice'].filter((s) => document.querySelector(s).getClientRects().length)].map((s) => {
            const r = document.querySelector(s).getBoundingClientRect();
            return [s, [Math.round(r.width), Math.round(r.height)]];
          }),
        ),
      );
      for (const [sel, [w, h]] of Object.entries(sizes)) {
        if (sel === '#settings-chip') assert.ok(h >= 36, `${sel} tinggi ${h}`);
        else assert.ok(w >= 44 && h >= 44, `${sel} ${w}×${h}`);
      }

      const states = {
        idle: async () => {},
        sibuk: () => patchStatus(page, BUSY),
        'sibuk+teks': async () => {
          await patchStatus(page, BUSY);
          await setPrompt(page, 'pesan panjang '.repeat(20));
        },
        lampiran: async () => {
          await dropFiles(page);
          await page.waitFor(() => document.querySelectorAll('#attachments .att-chip').length === 3, { timeoutMs: 5000, message: '3 chip' });
        },
        saran: async () => {
          await page.eval(() => document.querySelector('#prompt').focus());
          await setPrompt(page, '/');
          await page.waitFor(() => !document.querySelector('#suggest').hidden, { timeoutMs: 3000, message: 'saran / terbuka' });
        },
      };
      for (const [name, apply] of Object.entries(states)) {
        await fresh();
        await apply();
        await sleep(100);
        assert.equal(await page.eval(horizontalOverflow), null, `overflow (${name})`);
        const w = await promptWidth(page);
        assert.ok(w >= 280, `lebar #prompt ${w} px (${name})`);
      }
      await fresh();
      assert.deepEqual(page.problems, []);
    });

    test('satu tombol berubah fungsi: tepat satu dari ↑ Kirim / ■ Stop / 🎤 di setiap kombinasi', async () => {
      await fresh();
      const expect = ({ content, busy, voice, recording }) => (recording ? '#btn-voice' : content !== 'kosong' ? '#btn-send' : busy ? '#btn-stop' : voice ? '#btn-voice' : '#btn-send');
      const labels = { '#btn-send': 'Kirim pesan', '#btn-stop': 'Hentikan giliran', '#btn-voice': 'Mulai input suara' };
      const fails = [];
      for (const content of ['kosong', 'teks', 'lampiran']) {
        for (const busy of [false, true]) {
          for (const voice of [false, true]) {
            for (const recording of voice ? [false, true] : [false]) {
              await fresh();
              await patchStatus(page, { busy });
              if (content === 'teks') await setPrompt(page, 'halo');
              if (content === 'lampiran') {
                await dropFiles(page);
                await page.waitFor(() => document.querySelectorAll('#attachments .att-chip').length === 3, { timeoutMs: 5000, message: '3 chip' });
              }
              await page.eval(
                (voice, recording) => {
                  const b = document.querySelector('#btn-voice');
                  b.hidden = !voice;
                  b.setAttribute('aria-pressed', String(recording));
                },
                voice,
                recording,
              );
              const shown = await page.eval(toolbarButtons);
              const want = expect({ content, busy, voice, recording });
              const combo = `${content}/${busy ? 'sibuk' : 'idle'}/${voice ? 'suara' : 'tanpa suara'}${recording ? '/merekam' : ''}`;
              if (shown.length !== 1 || shown[0].sel !== want) fails.push(`${combo}: ${shown.map((s) => s.sel).join('+') || 'tidak ada'} (harus ${want})`);
              else if (!recording && shown[0].label !== labels[want]) fails.push(`${combo}: aria-label "${shown[0].label}"`);
            }
          }
        }
      }
      await page.eval(() => document.querySelector('#btn-voice').setAttribute('aria-pressed', 'false'));
      await fresh();
      assert.deepEqual(fails, []);
      // Typing while busy: ↑ in the toolbar, "■ Stop" next to "Tim sedang bekerja…"
      await patchStatus(page, { busy: true });
      await setPrompt(page, 'tambahan');
      assert.equal(await isShown(page, '#typing-stop'), true, '■ Stop di baris typing');
      await fresh();
      assert.equal(await isShown(page, '#typing-stop'), false);
    });

    test('sheet ＋: fokus masuk, Tab terkurung, @ / ! menyisipkan, 📎 memicu pemilih file, Esc mengembalikan fokus', async () => {
      await fresh();
      await page.click('#btn-plus');
      await page.waitFor(() => !document.querySelector('#plus-modal').hidden && document.querySelector('#plus-modal').contains(document.activeElement), { timeoutMs: 2000, message: 'sheet ＋ terbuka, fokus di dalam' });
      for (let i = 0; i < 12; i++) {
        await page.press('Tab');
        assert.equal(await page.eval(() => document.querySelector('#plus-modal').contains(document.activeElement)), true, `Tab ke-${i + 1} tetap di sheet`);
      }
      assert.equal(await page.eval(() => document.querySelector('#plus-queue-label').textContent), 'Buka antrian');
      await page.press('Escape');
      await sleep(80);
      assert.equal(await page.eval(() => document.querySelector('#plus-modal').hidden && document.activeElement?.id), 'btn-plus', 'Esc menutup, fokus kembali ke ＋');

      await page.eval(() => {
        window.__fileLookups = 0;
        const orig = window.fetch;
        window.fetch = (url, ...rest) => (/\/files$/.test(String(url)) && window.__fileLookups++, orig(url, ...rest));
      });
      await page.click('#btn-plus');
      await page.click('#plus-modal [data-insert="@"]');
      await page.waitFor(() => document.querySelector('#plus-modal').hidden && document.activeElement?.id === 'prompt' && document.querySelector('#prompt').value === '@', { timeoutMs: 2000, message: '@ di kotak, fokus di #prompt' });
      await page.waitFor(() => window.__fileLookups > 0, { timeoutMs: 3000, message: 'saran @file dicari (event input)' });
      await fresh();

      await page.click('#btn-plus');
      await page.click('#plus-modal [data-insert="!"]');
      assert.equal(await page.eval(() => [document.querySelector('#prompt').value, document.querySelector('#composer').classList.contains('bash-mode'), document.activeElement?.id].join()), '!,true,prompt');
      await fresh();

      await page.eval(() => {
        window.__fileClicks = 0;
        document.querySelector('#file-input').click = () => window.__fileClicks++;
      });
      await page.click('#btn-plus');
      await page.click('#plus-modal [data-proxy="#btn-attach"]');
      assert.equal(await page.eval(() => window.__fileClicks), 1, '📎 membuka pemilih file');
      await page.eval(() => delete document.querySelector('#file-input').click);
      await sleep(80);
      assert.equal(await page.eval(() => document.activeElement?.id), 'btn-plus', 'fokus kembali ke ＋');

      await setPrompt(page, 'kerjakan nanti');
      await page.click('#btn-plus');
      assert.equal(await page.eval(() => document.querySelector('#plus-queue-label').textContent), 'Tambah ke antrian');
      assert.equal(await page.eval(() => document.querySelector('#plus-modal [data-insert="/"]').disabled), true, '/ hanya ke kotak kosong');
      assert.equal(await isShown(page, '#plus-slash-note'), true, 'alasan / nonaktif tertulis');
      await fresh();
      assert.deepEqual(page.problems, []);
    });

    test('sheet pengaturan: .controls asli di sheet, ganti Izin → chip & server, lebar > 760 → chip pindah ke atas kotak', async () => {
      await fresh();
      assert.equal(await page.eval(() => document.querySelector('.controls').parentElement.matches('#turn-settings-modal .sheet-body')), true);
      await page.click('#settings-chip');
      await page.waitFor(() => !document.querySelector('#turn-settings-modal').hidden && document.querySelector('#turn-settings-modal').contains(document.activeElement), { timeoutMs: 2000, message: 'sheet pengaturan terbuka' });
      assert.equal(await page.eval(horizontalOverflow), null);
      const setMode = (v) =>
        page.eval((v) => {
          const s = document.querySelector('#mode');
          s.value = v;
          s.dispatchEvent(new Event('change', { bubbles: true }));
        }, v);
      await setMode('acceptEdits');
      assert.match(await page.eval(() => document.querySelector('#settings-chip').textContent), /Auto-edit/);
      assert.match(await page.eval(() => document.querySelector('#settings-chip').getAttribute('aria-label')), /mode Auto-edit/);
      await untilSnapshot((s) => s.statuses[projectId]?.mode === 'acceptEdits', 'mode tersimpan di server');
      await setMode('manual');
      await untilSnapshot((s) => (s.statuses[projectId]?.mode ?? 'manual') === 'manual', 'mode kembali');
      await page.press('Escape');
      await sleep(80);
      assert.equal(await page.eval(() => document.activeElement?.id), 'settings-chip', 'fokus kembali ke chip');

      // The window widens past 760 px (rotation): the controls stay in the dialog (a laptop opens it from the chip too),
      // the chip moves above the input; narrow again: back in the input toolbar.
      await page.setViewport(DESKTOP);
      await page.waitFor(() => document.querySelector('#settings-chip').parentElement.id === 'composer', { timeoutMs: 2000, message: 'chip di atas kotak input' });
      assert.equal(await page.eval(() => document.querySelector('#settings-chip').nextElementSibling.id), 'suggest');
      assert.equal(await page.eval(() => document.querySelector('.controls').parentElement.matches('#turn-settings-modal .sheet-body')), true);
      await page.setViewport(vp);
      await page.waitFor(() => document.querySelector('#settings-chip').parentElement.classList.contains('input'), { timeoutMs: 2000, message: 'chip kembali ke toolbar input' });
      assert.equal(await page.eval(() => document.querySelector('#mode').value), 'manual');
      assert.deepEqual(page.problems, []);
    });

    test('sheet ⋯: setiap baris membuka dialog yang sama dengan tombol aslinya, fokus kembali ke ⋯', async () => {
      await fresh();
      const rows = {
        '#btn-sessions': 'sessions-modal',
        "[data-more='permissions']": 'perm-modal',
        "[data-more='roster']": 'roster-modal',
        '#btn-report': 'report-modal',
        '#btn-account': 'account-modal',
        '#btn-help': 'help-modal',
        '#btn-settings': 'settings-modal',
        '#btn-notify-settings': 'notify-modal',
      };
      for (const [proxy, modal] of Object.entries(rows)) {
        await closeModals(page);
        await page.click('#btn-head-more');
        await page.waitFor(() => !document.querySelector('#head-more-modal').hidden, { timeoutMs: 2000, message: 'sheet ⋯ terbuka' });
        assert.equal(await page.eval(horizontalOverflow), null);
        await page.click(`#head-more-modal [data-proxy="${proxy}"]`);
        await page.waitFor((m) => !document.getElementById(m).hidden && document.querySelector('#head-more-modal').hidden, { timeoutMs: 3000, message: `${proxy} → ${modal}` }, modal);
        await sleep(150);
        await page.press('Escape');
        await sleep(100);
        assert.equal(await page.eval((m) => document.getElementById(m).hidden, modal), true, `${modal} tertutup`);
        assert.equal(await page.eval(() => document.activeElement?.id), 'btn-head-more', `fokus kembali ke ⋯ setelah ${modal}`);
      }
      // Export (no dialog): the original handler runs (empty chat → its own message).
      await page.click('#btn-head-more');
      await page.click(`#head-more-modal [data-proxy="[data-more='export']"]`);
      await toastSeen(page, /Belum ada percakapan/);
      // Rename only with a session; the header subtitle shows the session title.
      await page.click('#btn-head-more');
      assert.equal(await page.eval(() => document.querySelector('#head-more-modal [data-proxy="#sb-title"]').hidden), true, 'ganti nama: belum ada sesi');
      assert.equal(await page.eval(() => document.querySelector('#hm-title').textContent), 'Percakapan baru');
      await closeModals(page);
      assert.equal(await page.eval(() => document.querySelector('#head-sub').textContent), 'Percakapan baru');
      assert.deepEqual(page.problems, []);
    });

    test('strip status: todo terlipat 1 baris, chip ⧗/📋/konteks, 📋 membuka antrian, kosong → tersembunyi', async () => {
      await fresh();
      assert.equal(await isShown(page, '#statusline'), false, 'idle: strip tidak tampil');
      await patchStatus(page, BUSY);
      const strip = await page.eval(() => ({
        collapsed: document.querySelector('#todos').classList.contains('collapsed'),
        todoH: Math.round(document.querySelector('#todos').getBoundingClientRect().height),
        todoText: document.querySelector('#todos').textContent.replace(/\s+/g, ' ').trim(),
        chips: [...document.querySelectorAll('#statusline > *')].filter((c) => c.getClientRects().length).map((c) => c.textContent.trim()),
        sameRow: Math.abs(document.querySelector('#todos').getBoundingClientRect().top - document.querySelector('#statusline').getBoundingClientRect().top) < 4,
      }));
      assert.equal(strip.collapsed, true, 'todo terlipat di HP');
      assert.ok(strip.todoH <= 44, `todo 1 baris (${strip.todoH} px)`);
      assert.equal(strip.todoText, '◼ 2/5 Menulis test ▸');
      assert.deepEqual(strip.chips, ['⧗ 1', '📋 2', 'konteks 78%']);
      assert.equal(strip.sameRow, true, 'todo dan chip satu baris');
      assert.equal(await page.eval(horizontalOverflow), null);
      await page.click('#todos .todos-head');
      assert.equal(await page.eval(() => document.querySelectorAll('#todos li').length), 5, 'ketuk → daftar terbuka');
      await page.click('#todos .todos-head');
      await page.click('#statusline [data-open-queue]');
      await page.waitFor(() => !document.querySelector('#queue-modal').hidden, { timeoutMs: 3000, message: '📋 membuka antrian' });
      await closeModals(page);
      await patchStatus(page, { pending: 1, autoApprove: true });
      const chips = await page.eval(() => [...document.querySelectorAll('#statusline > *')].map((c) => c.textContent.trim()));
      assert.ok(chips.includes('✋ Menunggu izinmu') && chips.includes('⚠ Semua izin otomatis'), chips.join(' | '));
      assert.equal(await page.eval(() => document.querySelector('#settings-chip').classList.contains('warn')), true, 'chip peringatan saat auto-izin');
      await fresh();
      assert.deepEqual(page.problems, []);
    });

    test('keyboard (visualViewport menyusut): navigasi bawah hilang, kotak di atas keyboard, chat tetap di bawah', async () => {
      // A chat taller than the view: three short exchanges with fake Claude in a project of its own.
      let pid = (await snapshot()).projects.find((p) => p.name === 'panjang')?.id;
      if (!pid) {
        mkdirSync(path.join(TMP, 'projects', 'panjang'), { recursive: true });
        await api('/api/projects/refresh');
        pid = (await untilSnapshot((s) => s.projects.some((p) => p.name === 'panjang'), 'project panjang')).projects.find((p) => p.name === 'panjang').id;
        for (let i = 1; i <= 3; i++) {
          await api(`/api/projects/${pid}/prompt`, { text: `pesan ke-${i}` });
          await untilSnapshot((s) => !s.statuses[pid]?.busy && (s.chats?.[pid] ?? []).filter((m) => m.kind === 'result').length >= i, `balasan ${i}`);
        }
      }
      await openApp(page, `#${pid}`);
      try {
        await page.eval(() => document.querySelector('#prompt').focus());
        await page.setViewport({ ...vp, height: vp.height - 336 });
        await page.waitFor(() => document.body.classList.contains('kb-open'), { timeoutMs: 2000, message: 'body.kb-open' });
        const r = await page.eval(() => {
          const chat = document.querySelector('#chat');
          return {
            nav: Boolean(document.querySelector('#mobile-nav').getClientRects().length),
            inputBottom: Math.round(document.querySelector('.input').getBoundingClientRect().bottom),
            vv: Math.round(window.visualViewport.height),
            pinned: chat.scrollHeight <= chat.clientHeight || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60,
          };
        });
        assert.equal(r.nav, false, 'navigasi bawah tersembunyi');
        assert.ok(r.inputBottom <= r.vv, `kotak input (${r.inputBottom}) di atas keyboard (${r.vv})`);
        assert.equal(r.pinned, true, 'chat tetap di pesan terbaru');
        await page.setViewport(vp);
        await page.eval(() => document.querySelector('#prompt').blur());
        await page.waitFor(() => !document.body.classList.contains('kb-open') && document.querySelector('#mobile-nav').getClientRects().length, { timeoutMs: 2000, message: 'keyboard tertutup: navigasi kembali' });
        assert.deepEqual(page.problems, []);
      } finally {
        await page.setViewport(vp);
        await openApp(page, `#${projectId}`);
      }
    });
  });
}

describe('HP chat: WiFi hanya-lihat', { skip: SKIP ?? false }, () => {
  test('banner menggantikan kotak, baris ⋯ yang mengubah nonaktif dengan alasan tertulis', async (t) => {
    const page = await lanPage(PHONES[0]);
    if (!page) return t.skip('laptop ini tidak punya alamat LAN');
    try {
      assert.match(await page.eval(() => (document.querySelector('#ro-banner').getClientRects().length ? document.querySelector('#ro-banner').textContent : '')), /Hanya lihat lewat WiFi/);
      assert.equal(await isShown(page, '.input'), false, 'kotak input tersembunyi');
      assert.deepEqual(await page.eval(visibleControls, '#composer'), [], 'tidak ada kontrol nonaktif tanpa alasan di composer');
      await page.click('#btn-head-more');
      await page.waitFor(() => !document.querySelector('#head-more-modal').hidden, { timeoutMs: 2000, message: 'sheet ⋯' });
      const rows = await page.eval(() => [...document.querySelectorAll('#head-more-modal .sheet-row')].filter((b) => !b.hidden).map((b) => [b.dataset.proxy ?? b.dataset.action, b.disabled, b.querySelector('.sheet-row-note')?.textContent ?? '']));
      assert.deepEqual(rows.filter(([, dis, note]) => dis && !note), [], 'baris nonaktif tanpa alasan');
      const byKey = Object.fromEntries(rows.map(([k, dis, note]) => [k, { dis, note }]));
      assert.deepEqual(byKey['#btn-new'], { dis: true, note: 'Hanya dari laptop/Tailscale' });
      assert.equal(byKey['#btn-sessions'].dis, false, 'Riwayat tetap bisa dibuka');
      assert.equal(byKey["[data-more='export']"].dis, false, 'export tetap bisa');
      assert.equal(byKey['#btn-settings'], undefined, '⚙ hanya di laptop');
      assert.equal(await page.eval(horizontalOverflow), null);
    } finally {
      await page.close();
      await api('/api/remote', { enabled: false }).catch(() => {});
    }
  });
});

describe('desktop 1440x900 tidak berubah', { skip: SKIP ?? false }, () => {
  test('tidak ada .phone-only terlihat, chip ⚙ membuka Izin/Model/Effort, tombol lama terlihat, session bar tampil', async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport(DESKTOP);
      await openApp(page, `#${projectId}`);
      const fp = await page.eval(layoutFingerprint);
      assert.deepEqual(fp.phoneOnlyShown, [], '.phone-only terlihat di desktop');
      // Izin / Model / Effort live in the Pengaturan giliran dialog, opened by the chip above the input
      assert.equal(await page.eval(() => document.querySelector('.controls').parentElement.matches('#turn-settings-modal .sheet-body')), true);
      assert.equal(await page.eval(() => document.querySelector('#settings-chip').nextElementSibling.id), 'suggest');
      for (const sel of ['#btn-account', '#btn-dashboard', '#btn-palette', '#btn-report', '#btn-phone', '#btn-notify', '#btn-help', '#btn-settings', '#session-bar', '#btn-sessions', '#btn-new', '#btn-more', '.tabs', '#settings-chip', '#btn-attach', '#btn-template', '#btn-queue-add', '#btn-send', '#statusline']) assert.equal(fp[sel]?.shown, true, `${sel} terlihat`);
      await page.click('#settings-chip');
      await page.waitFor(() => !document.querySelector('#turn-settings-modal').hidden, { timeoutMs: 2000, message: 'dialog Pengaturan giliran' });
      assert.deepEqual(await page.eval(() => ['#mode', '#model', '#effort'].map((s) => document.querySelector(s).getClientRects().length > 0)), [true, true, true], 'Izin, Model, Effort di dialog');
      await page.press('Escape');
      assert.equal(fp['#mobile-nav'].shown, false);
      assert.equal(fp['#btn-send'].text, 'Kirim', 'teks Kirim tetap');
      assert.equal(fp['#btn-send'].font, '14px', 'Kirim tetap berteks (bukan ikon)');
      assert.deepEqual(await page.eval(visibleControls, '.input'), ['btn-attach', 'btn-template', 'prompt', 'btn-voice', 'btn-queue-add', 'btn-send'].filter((id) => id !== 'btn-voice' || fp['#btn-voice'].shown));
      // The status line keeps mode · model on a laptop (no phone chips); the todo list stays open.
      await patchStatus(page, BUSY);
      assert.equal(await page.eval(() => document.querySelector('#statusline .sl-mode') !== null && !document.querySelector('#statusline .sl-chip')), true);
      assert.equal(await page.eval(() => document.querySelector('#todos').classList.contains('collapsed')), false, 'daftar tugas tetap terbuka di desktop');
      assert.equal(await page.eval(() => document.body.classList.contains('kb-open')), false);
      await resetStatus(page);
      assert.deepEqual(page.problems, []);
    } finally {
      await page.close();
    }
  });
});
