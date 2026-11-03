/* global document, window, getComputedStyle, matchMedia -- functions passed to page.eval run in the browser */
// The other phone views (docs/design-mobile-chat.md, phase 2): Kantor, Perubahan, Aktivitas and the 🔎 palette, in
// portrait (390×844, 360×740) and landscape (844×390, touch). One clear primary action per view, everything else
// ≤ 2 taps away (view-aware header ⋯ sheet), no page overflow, diffs wrap inside their box, sheets fit a short
// landscape screen. A laptop (> 760 px, fine pointer) must stay exactly as it was.
//   OFFICE_UI_SHOTS=<folder> node --test --test-concurrency=1 test/mobile-views.test.mjs   # also keeps screenshots + audit.json
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const SHOTS = process.env.OFFICE_UI_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORTRAIT = [
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '360x740', width: 360, height: 740, mobile: true },
];
const LANDSCAPE = { name: '844x390', width: 844, height: 390, mobile: true, landscape: true };
const PHONES = [...PORTRAIT, LANDSCAPE];
const DESKTOP = { name: '1440x900', width: 1440, height: 900, mobile: false };
const SHORT_DESKTOP = { name: '900x480', width: 900, height: 480, mobile: false }; // a short laptop window: still the laptop layout

let TMP;
let BASE;
let server;
let browser;
let projectId; // "toko": a git repo with three changed files

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

async function snapshot() {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/stream`, { signal: controller.signal });
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-mobile-views-'));
  const proj = path.join(TMP, 'projects', 'toko');
  mkdirSync(path.join(proj, 'src'), { recursive: true });
  writeFileSync(path.join(proj, 'src', 'checkout.ts'), 'export const total = 0;\n');
  writeFileSync(path.join(proj, 'README.md'), '# toko\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: proj, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'awal');
  // A modified file with very long lines, a deleted one and a new one deep in the tree (long path).
  writeFileSync(
    path.join(proj, 'src', 'checkout.ts'),
    `export const total = 1;\nexport const configurationWithAVeryLongName = { endpoint: 'https://api.example.com/v1/checkout/sessions/${'x'.repeat(160)}', retries: 3 };\n${Array.from({ length: 60 }, (_, i) => `export const line${i} = ${i};`).join('\n')}\n`,
  );
  unlinkSync(path.join(proj, 'README.md'));
  mkdirSync(path.join(proj, 'src', 'components', 'checkout', 'payment-methods'), { recursive: true });
  writeFileSync(path.join(proj, 'src', 'components', 'checkout', 'payment-methods', 'BankTransferInstructionsPanel.tsx'), 'export default function Panel() { return null; }\n');
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
    .filter((el) => !el.closest('.statusline, .chat, .md, .table-wrap, pre, .ch-diff, .ch-files, .palette-list, .team') || el.matches('.statusline, .chat, .ch-diff, .ch-files, .palette-list, .team')) // scrollers clip their own content
    .slice(0, 5)
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className).trim().split(/\s+/).join('.')} right=${Math.round(el.getBoundingClientRect().right)}`);
  return scrollWidth > clientWidth || wide.length ? { scrollWidth, clientWidth, wide } : null;
}

/** Interactive controls a user can see in `rootSel`, minus list rows (`skipSel`): the view's chrome. */
function visibleControls(rootSel, skipSel = '') {
  const root = document.querySelector(rootSel);
  if (!root) return [];
  const shown = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]');
  return [...root.querySelectorAll('button, select, textarea, input:not([type="hidden"]), [role="button"], [role="option"]')]
    .filter(shown)
    .filter((el) => !skipSel || !el.closest(skipSel))
    .map((el) => el.id || `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`);
}

/** The view's chrome, list rows and size facts (audit table + assertions). */
function auditView(view) {
  const VIEWS = {
    office: { root: '.office', rows: '.member-cell, .overlay' },
    chat: { root: '.panel', rows: '#chat' },
    changes: { root: '#changes', rows: '#ch-files, #ch-diff' },
    activity: { root: '#activity', rows: 'li' },
    palette: { root: '#palette-modal', rows: '.palette-list' },
  };
  const { root, rows } = VIEWS[view];
  // (a copy of visibleControls: probes are serialised one by one)
  const visibleControls = (rootSel, skipSel = '') => {
    const el0 = document.querySelector(rootSel);
    if (!el0) return [];
    const shown = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]');
    return [...el0.querySelectorAll('button, select, textarea, input:not([type="hidden"]), [role="button"], [role="option"]')]
      .filter(shown)
      .filter((el) => !skipSel || !el.closest(skipSel))
      .map((el) => el.id || `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}`);
  };
  const chrome = visibleControls(root, rows);
  const listRows = visibleControls(root).length - chrome.length;
  const primary = [...document.querySelector(root).querySelectorAll('button.primary')].filter((b) => b.getClientRects().length && !b.closest('[hidden]')).map((b) => b.textContent.trim());
  return {
    topbar: visibleControls('.topbar'),
    chrome,
    listRows,
    primary,
    nav: visibleControls('#mobile-nav').length,
    narrow: matchMedia('(max-width: 760px), (pointer: coarse) and (max-height: 500px)').matches,
    coarse: matchMedia('(pointer: coarse)').matches,
  };
}

/** Layout fingerprint of a laptop page (must not change): position, size and display of the main chrome. */
function layoutFingerprint() {
  const sels = ['.topbar', '#crumb', '#btn-account', '#btn-dashboard', '#btn-palette', '#btn-report', '#btn-notify', '#btn-help', '#btn-settings', '#conn', '.layout', '.office', '#dash-bar', '#stage', '#team', '.panel', '.tabs',
    '#changes', '.ch-head', '#ch-branch', '#ch-view', '#ch-open', '#ch-review', '#ch-refresh', '#ch-git', '#ch-git-select', '#ch-git-new', '#ch-git-fetch', '#ch-git-pull', '#ch-git-push', '#ch-git-pr', '#ch-files', '#ch-diff', '#ch-commit', '#activity',
    '#session-bar', '#chat', '#composer', '.controls', '.input', '#prompt', '#btn-send', '#mobile-nav', '#head-more-modal'];
  const out = {};
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (!el) {
      out[sel] = null;
      continue;
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out[sel] = { shown: Boolean(el.getClientRects().length) && cs.visibility !== 'hidden', x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), display: cs.display, font: cs.fontSize, ws: cs.whiteSpace };
  }
  const pre = document.querySelector('#ch-diff pre');
  out.diffPre = pre ? { ws: getComputedStyle(pre).whiteSpace, font: getComputedStyle(pre).fontSize } : null;
  out.phoneOnlyShown = [...document.querySelectorAll('.phone-only')].filter((el) => el.getClientRects().length).map((el) => el.id || el.className);
  return out;
}

/** A dialog card fits the screen: inside the viewport, ✕ visible, overflowing content scrolls inside the card. */
function sheetFit(modalSel) {
  const modal = document.querySelector(modalSel);
  const card = modal.querySelector('.modal-card');
  const r = card.getBoundingClientRect();
  const close = modal.querySelector('[data-close]')?.getBoundingClientRect();
  const scroller = [card, ...card.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY));
  const clipped = card.scrollHeight > card.clientHeight + 1 && !scroller;
  return {
    inView: r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5 && r.left >= -0.5 && r.right <= window.innerWidth + 0.5,
    closeInView: !close || (close.top >= 0 && close.bottom <= window.innerHeight && close.right <= window.innerWidth),
    clipped,
    h: Math.round(r.height),
    vh: window.innerHeight,
  };
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

const closeModals = (page) =>
  page.eval(() => {
    document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
    document.activeElement?.blur?.();
  });

const isShown = (page, sel) => page.eval((s) => Boolean(document.querySelector(s)?.getClientRects().length), sel);

/** Goes to a phone view through the bottom navigation (or the 🔎 palette sheet). */
async function goView(page, view) {
  await closeModals(page);
  const phone = await isShown(page, '#mobile-nav');
  if (view === 'palette') {
    await page.click(phone ? '#nav-palette' : '#btn-palette');
    await page.waitFor(() => !document.querySelector('#palette-modal').hidden && document.querySelectorAll('#palette-list [role="option"]').length > 0, { timeoutMs: 3000, message: 'palet terbuka' });
    return;
  }
  if (phone) await page.click(`#mobile-nav [data-view="${view}"]`);
  else if (view !== 'office') await page.click(`.tabs [data-tab="${view}"]`); // laptop layout (landscape before phase 2)
  if (view === 'changes') {
    await page.waitFor(() => document.querySelectorAll('#ch-files li[data-path]').length === 3 && document.querySelector('#ch-diff pre') && !document.querySelector('#ch-git').hidden, { timeoutMs: 8000, message: 'tab Perubahan termuat' });
    await page.eval(() => document.querySelector('#ch-files li[data-path="src/checkout.ts"]').click()); // the long-line diff
    await page.waitFor(() => document.querySelector('#ch-diff pre')?.textContent.includes('configurationWithAVeryLongName'), { timeoutMs: 5000, message: 'diff checkout.ts' });
  }
  await sleep(150);
}

/** Many activity rows, some with long unbroken text (no server events needed). */
const fillActivity = (page) =>
  page.eval(async () => {
    const { appendActivity } = await import('/js/features/activity.js');
    const roles = ['claude', 'frontend', 'qa', 'backend'];
    for (let i = 0; i < 40; i++) {
      const kind = ['tool_start', 'delegate', 'agent_stop', 'tool_fail'][i % 4];
      appendActivity({ ts: Date.now() - i * 60000, kind, role: roles[i % 4], from: 'claude', agentType: 'frontend', label: i % 5 ? `Edit src/components/checkout/payment-methods/BankTransferInstructionsPanel.tsx baris ${i}` : `npm run test -- --grep=${'x'.repeat(80)}` }, false);
    }
  });

/** Sheets and dialogs reachable on a phone. */
const SHEETS = [
  ['#btn-head-more', '#head-more-modal'],
  ['#btn-plus', '#plus-modal'],
  ['#settings-chip', '#turn-settings-modal'],
  ['#nav-palette', '#palette-modal'],
  ['#crumb', '#project-modal'],
];

// ---------- screenshots + audit (before/after review; files only with OFFICE_UI_SHOTS) ----------

describe('HP view: screenshot + audit', { skip: SKIP ?? false }, () => {
  test('Kantor, Chat, Perubahan, Aktivitas, Cari di 390, 360, 844×390 + sidik desktop', async (t) => {
    const audit = {};
    for (const vp of PHONES) {
      const page = await browser.newPage();
      try {
        await page.setViewport(vp);
        await openApp(page, `#${projectId}`);
        await fillActivity(page);
        for (const view of ['office', 'chat', 'changes', 'activity', 'palette']) {
          await goView(page, view);
          const a = await page.eval(auditView, view);
          a.overflow = await page.eval(horizontalOverflow);
          audit[`${view}@${vp.name}`] = a;
          await shot(page, `${view}-${vp.name}`);
          if (view === 'changes') {
            await page.eval(() => {
              const d = document.querySelector('#ch-diff');
              d.scrollTop = d.scrollHeight;
            });
            await shot(page, `changes-scrolled-${vp.name}`);
          }
          if (view !== 'palette' && (await isShown(page, '#btn-head-more'))) {
            await page.click('#btn-head-more');
            await sleep(250);
            await shot(page, `${view}-sheet-more-${vp.name}`);
            await closeModals(page);
          }
        }
        if (vp.landscape) {
          await goView(page, 'chat');
          for (const [trigger, modal] of SHEETS) {
            await closeModals(page);
            if (!(await isShown(page, trigger))) continue;
            await page.click(trigger);
            await sleep(250);
            audit[`sheet ${modal}@${vp.name}`] = await page.eval(sheetFit, modal);
            await shot(page, `sheet-${modal.slice(1)}-${vp.name}`);
          }
          await closeModals(page);
        }
      } finally {
        await page.close();
      }
    }
    for (const vp of [DESKTOP, SHORT_DESKTOP]) {
      const page = await browser.newPage();
      try {
        await page.setViewport(vp);
        await openApp(page, `#${projectId}`);
        await page.click('.tabs [data-tab="changes"]');
        await page.waitFor(() => document.querySelector('#ch-diff pre'), { timeoutMs: 8000, message: 'diff desktop' });
        await sleep(200);
        audit[`desktop changes@${vp.name}`] = { fingerprint: await page.eval(layoutFingerprint) };
        await shot(page, `desktop-changes-${vp.name}`);
        await page.click('.tabs [data-tab="chat"]');
        await sleep(150);
        audit[`desktop chat@${vp.name}`] = { fingerprint: await page.eval(layoutFingerprint) };
        await shot(page, `desktop-chat-${vp.name}`);
      } finally {
        await page.close();
      }
    }
    if (SHOTS) writeFileSync(path.join(SHOTS, 'audit.json'), JSON.stringify(audit, null, 1));
    for (const [k, a] of Object.entries(audit)) if (!a.fingerprint) t.diagnostic(`${k}: ${JSON.stringify({ ...a, chrome: a.chrome?.join(' ') })}`);
  });
});

// ---------- functional checks ----------

/** Every action of a view, reachable in ≤ 2 taps: shown in the view (1 tap) or a row of the ⋯ sheet (2 taps). */
const ACTIONS = {
  office: ['#btn-dashboard', '#btn-account', '#btn-report', '#btn-settings', '#btn-help', '#btn-notify-settings'],
  changes: ['#ch-view', '#ch-open', '#ch-review', '#ch-refresh', '#ch-git-select', '#ch-git-new', '#ch-git-fetch', '#ch-git-pull', '#ch-git-push', '#ch-git-pr', '#ch-commit button', '#btn-account', '#btn-settings'],
  activity: ['#btn-account', '#btn-report', '#btn-settings', '#btn-help'],
};
/** What the view shows directly instead of the laptop control. */
const DIRECT = { '#btn-dashboard': '#dash-bar' };

for (const vp of PHONES) {
  describe(`HP view ${vp.name}`, { skip: SKIP ?? false }, () => {
    let page;
    before(async () => {
      if (SKIP) return;
      page = await browser.newPage();
      await page.setViewport(vp);
      await openApp(page, `#${projectId}`);
    });
    after(async () => page?.close());

    async function fresh(view = 'chat') {
      await page.setViewport(vp);
      await closeModals(page);
      await goView(page, view);
      page.clearProblems();
    }

    test('setiap view: tanpa overflow horizontal, header = nama project + ⋯, navigasi selalu terlihat', async () => {
      assert.equal(await page.eval(() => document.body.matches(':has(#mobile-nav:not([hidden]))') && matchMedia('(max-width: 760px), (pointer: coarse) and (max-height: 500px)').matches), true, 'layout HP aktif');
      await fillActivity(page);
      for (const view of ['office', 'chat', 'changes', 'activity']) {
        await fresh(view);
        assert.equal(await page.eval(horizontalOverflow), null, `overflow (${view})`);
        assert.deepEqual(await page.eval(visibleControls, '.topbar'), ['crumb', 'btn-head-more'], `header (${view})`);
        const nav = await page.eval(() => {
          const r = document.querySelector('#mobile-nav').getBoundingClientRect();
          return { shown: r.width > 0 && r.height > 0, inView: r.top >= 0 && r.bottom <= window.innerHeight + 0.5 && r.left >= 0 && r.right <= window.innerWidth + 0.5 };
        });
        assert.deepEqual(nav, { shown: true, inView: true }, `navigasi (${view})`);
      }
      assert.deepEqual(page.problems, []);
    });

    test('Perubahan: satu aksi utama (Commit), header view = ⎇ branch saja, diff dibungkus di dalam kotaknya, header tetap saat diff digulir', async () => {
      await fresh('changes');
      await page.click('#ch-files li[data-path="src/checkout.ts"]');
      await page.waitFor(() => document.querySelector('#ch-diff pre')?.textContent.includes('configurationWithAVeryLongName'), { timeoutMs: 5000, message: 'diff checkout.ts' });
      const a = await page.eval(auditView, 'changes');
      assert.deepEqual(a.chrome, ['ch-git-select', 'ch-message', 'button.primary'], `kontrol view: ${a.chrome.join(', ')}`);
      assert.deepEqual(a.primary, ['Commit']);
      const diff = await page.eval(() => {
        const box = document.querySelector('#ch-diff');
        const long = [...box.querySelectorAll('pre > span')].find((s) => s.textContent.includes('configurationWithAVeryLongName'));
        return { sideways: box.scrollWidth - box.clientWidth, longLines: Math.round(long.getBoundingClientRect().height / parseFloat(getComputedStyle(long).lineHeight)), font: parseFloat(getComputedStyle(box.querySelector('pre')).fontSize), boxRight: Math.round(box.getBoundingClientRect().right), vw: window.innerWidth };
      });
      assert.ok(diff.sideways <= 1, `diff tidak bergeser ke samping (${diff.sideways} px)`);
      assert.ok(diff.longLines >= 2, `baris panjang dibungkus (${diff.longLines} baris)`);
      assert.ok(diff.font >= 12, `font diff ${diff.font} px`);
      assert.ok(diff.boxRight <= diff.vw, 'kotak diff di dalam layar');
      // sticky: the branch row and the commit box stay put while the diff scrolls
      const before = await page.eval(() => [document.querySelector('#ch-git').getBoundingClientRect().top, document.querySelector('#ch-commit').getBoundingClientRect().bottom].map(Math.round));
      await page.eval(() => {
        const d = document.querySelector('#ch-diff');
        d.scrollTop = d.scrollHeight;
      });
      await sleep(80);
      const afterScroll = await page.eval(() => [document.querySelector('#ch-git').getBoundingClientRect().top, document.querySelector('#ch-commit').getBoundingClientRect().bottom, window.innerHeight].map(Math.round));
      assert.deepEqual(afterScroll.slice(0, 2), before, 'header ⎇ dan Commit tidak ikut tergulir');
      assert.ok(afterScroll[1] <= afterScroll[2], 'Commit terlihat di layar');
      // the file list: a long path is ellipsized inside the row, rows are finger-sized
      const rows = await page.eval(() => [...document.querySelectorAll('#ch-files li[data-path]')].map((li) => Math.round(li.getBoundingClientRect().height)));
      assert.ok(rows.every((h) => h >= 40), `tinggi baris file ${rows.join(',')}`);
      assert.deepEqual(page.problems, []);
    });

    test('Perubahan: aksi git/review/lihat file ada di ⋯ (2 tap), ↻ memuat ulang, ＋ Branch membuka form, baris nonaktif menulis alasannya', async () => {
      await fresh('changes');
      await page.click('#btn-head-more');
      await page.waitFor(() => !document.querySelector('#head-more-modal').hidden, { timeoutMs: 2000, message: 'sheet ⋯' });
      const rows = await page.eval(() =>
        [...document.querySelectorAll('#head-more-modal .sheet-row')]
          .filter((b) => b.getClientRects().length)
          .map((b) => ({ proxy: b.dataset.proxy ?? b.dataset.action, disabled: b.disabled, note: b.querySelector('.sheet-row-note')?.textContent ?? '' })),
      );
      const proxies = rows.map((r) => r.proxy);
      for (const sel of ['#ch-view', '#ch-review', '#ch-refresh', '#ch-git-new', '#ch-git-fetch', '#ch-git-pull', '#ch-git-push', '#ch-git-pr', '#ch-open']) assert.ok(proxies.includes(sel), `baris ${sel} di ⋯ (${proxies.join(' ')})`);
      assert.equal(proxies.indexOf('#ch-view'), 0, 'grup Perubahan di atas');
      assert.ok(!proxies.includes('#btn-new') && !proxies.includes("[data-more='export']"), 'baris khusus Chat tidak tampil di Perubahan');
      assert.deepEqual(rows.filter((r) => r.disabled && !r.note), [], 'baris nonaktif tanpa alasan');
      // the test repo has no remote: Fetch/Pull/Push are off and say why
      assert.ok(rows.find((r) => r.proxy === '#ch-git-push').disabled);
      assert.match(rows.find((r) => r.proxy === '#ch-git-push').note, /remote/, 'alasan Push');
      assert.match(rows.find((r) => r.proxy === '#ch-git-pull').note, /upstream/, 'alasan Pull');
      assert.equal(await page.eval(horizontalOverflow), null);
      // ↻ from the sheet: the list is read again
      await page.eval(() => {
        window.__changesReads = 0;
        const orig = window.fetch;
        window.fetch = (url, ...rest) => (/\/changes$/.test(String(url)) && window.__changesReads++, orig(url, ...rest));
      });
      await page.click('#head-more-modal [data-proxy="#ch-refresh"]');
      await page.waitFor(() => window.__changesReads > 0 && document.querySelector('#head-more-modal').hidden, { timeoutMs: 3000, message: '↻ dari sheet' });
      // ＋ Branch from the sheet: the inline form opens with the name field focused
      await page.click('#btn-head-more');
      await page.click('#head-more-modal [data-proxy="#ch-git-new"]');
      await page.waitFor(() => !document.querySelector('#ch-git-create').hidden && document.activeElement?.id === 'ch-git-name', { timeoutMs: 3000, message: 'form branch baru' });
      assert.equal(await page.eval(horizontalOverflow), null, 'form branch tanpa overflow');
      await page.click('#ch-git-create-cancel');
      assert.deepEqual(page.problems, []);
    });

    test('Kantor: 🗂 Semua project = aksi utama dan tetap terlihat saat digulir, kartu tim ≥ 44 px', async () => {
      await fresh('office');
      const a = await page.eval(auditView, 'office');
      assert.deepEqual(a.chrome, ['dash-bar', 'view-mode'], `kontrol view: ${a.chrome.join(', ')}`);
      const cards = await page.eval(() => [...document.querySelectorAll('#team .member')].map((m) => Math.round(m.getBoundingClientRect().height)));
      assert.ok(cards.length > 0 && cards.every((h) => h >= 44), `tinggi kartu ${cards.join(',')}`);
      const stage = await page.eval(() => {
        const r = document.querySelector('#stage canvas').getBoundingClientRect();
        const nav = document.querySelector('#mobile-nav').getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), navTop: Math.round(nav.top), vh: window.innerHeight };
      });
      assert.ok(stage.w >= 300 && stage.h >= 150, `kantor cukup besar ${stage.w}×${stage.h}`);
      if (vp.landscape) assert.ok(stage.bottom <= stage.vh, `landscape: seluruh kantor terlihat tanpa gulir (${stage.bottom} > ${stage.vh})`);
      await page.eval(() => {
        const o = document.querySelector('.office');
        o.scrollTop = o.scrollHeight;
        document.querySelector('#team').scrollTop = 1e6;
      });
      await sleep(80);
      const bar = await page.eval(() => {
        const r = document.querySelector('#dash-bar').getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), head: Math.round(document.querySelector('.topbar').getBoundingClientRect().bottom), vh: window.innerHeight };
      });
      assert.ok(bar.top >= bar.head - 1 && bar.bottom <= bar.vh, `🗂 tetap terlihat (${JSON.stringify(bar)})`);
      await page.click('#dash-bar');
      await page.waitFor(() => !document.querySelector('#dash-modal').hidden, { timeoutMs: 3000, message: '🗂 membuka Semua project' });
      assert.equal((await page.eval(sheetFit, '#dash-modal')).inView, true);
      await closeModals(page);
      assert.deepEqual(page.problems, []);
    });

    test('Aktivitas dan 🔎 Cari: baris terbaca tanpa overflow, palet muat sebagai sheet', async () => {
      await fresh('activity');
      await fillActivity(page);
      const act = await page.eval(() => ({ font: parseFloat(getComputedStyle(document.querySelector('#activity li')).fontSize), wide: [...document.querySelectorAll('#activity li')].some((li) => li.scrollWidth > li.clientWidth + 1) }));
      assert.ok(act.font >= 13, `font aktivitas ${act.font}`);
      assert.equal(act.wide, false, 'teks panjang dibungkus di baris');
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual((await page.eval(auditView, 'activity')).chrome, [], 'Aktivitas: hanya daftar');
      await goView(page, 'palette');
      const fit = await page.eval(sheetFit, '#palette-modal');
      assert.equal(fit.inView && fit.closeInView && !fit.clipped, true, JSON.stringify(fit));
      assert.deepEqual((await page.eval(auditView, 'palette')).chrome, ['palette-input', 'button.icon-btn.pal-close']);
      await closeModals(page);
      assert.deepEqual(page.problems, []);
    });

    test('setiap aksi ≤ 2 tap: terlihat di view atau baris ⋯ yang terlihat', async () => {
      const missing = [];
      for (const [view, sels] of Object.entries(ACTIONS)) {
        await fresh(view);
        const direct = await page.eval((sels, DIRECT) => sels.filter((s) => document.querySelector(DIRECT[s] ?? s)?.getClientRects().length), sels, DIRECT);
        await page.click('#btn-head-more');
        await page.waitFor(() => !document.querySelector('#head-more-modal').hidden, { timeoutMs: 2000, message: 'sheet ⋯' });
        const inSheet = await page.eval(() => [...document.querySelectorAll('#head-more-modal .sheet-row')].filter((b) => b.getClientRects().length).map((b) => b.dataset.proxy));
        for (const sel of sels) if (!direct.includes(sel) && !inSheet.includes(sel)) missing.push(`${view}: ${sel}`);
      }
      await closeModals(page);
      assert.deepEqual(missing, []);
    });

    if (vp.landscape) {
      test('landscape: navigasi jadi rail kiri, chat + composer satu baris muat, keyboard menyisakan chat', async () => {
        await fresh('chat');
        const r = await page.eval(() => {
          const rect = (s) => document.querySelector(s).getBoundingClientRect();
          const nav = rect('#mobile-nav');
          return { navW: Math.round(nav.width), navH: Math.round(nav.height), navLeft: Math.round(nav.left), chatH: Math.round(rect('#chat').height), chatLeft: Math.round(rect('#chat').left), inputBottom: Math.round(rect('.input').bottom), inputH: Math.round(rect('.input').height), prompt: Math.round(rect('#prompt').width), topbarH: Math.round(rect('.topbar').height), vh: window.innerHeight };
        });
        assert.ok(r.navH > r.navW && r.navLeft === 0, `rail vertikal di kiri (${r.navW}×${r.navH})`);
        assert.ok(r.chatLeft >= r.navW, 'chat di kanan rail');
        assert.ok(r.chatH >= 180, `tinggi chat ${r.chatH}`);
        assert.ok(r.inputH <= 64, `kotak input satu baris (${r.inputH} px)`);
        assert.ok(r.inputBottom <= r.vh, 'kotak input di layar');
        assert.ok(r.prompt >= 280, `lebar #prompt ${r.prompt}`);
        assert.ok(r.topbarH <= 48, `header ringkas ${r.topbarH}`);
        // on-screen keyboard (≈ 170 px in landscape): header and rail step aside, the box stays above the keyboard
        await page.eval(() => document.querySelector('#prompt').focus());
        await page.setViewport({ ...vp, height: vp.height - 170 });
        await page.waitFor(() => document.body.classList.contains('kb-open'), { timeoutMs: 2000, message: 'body.kb-open' });
        const kb = await page.eval(() => ({
          input: Math.round(document.querySelector('.input').getBoundingClientRect().bottom),
          vv: Math.round(window.visualViewport.height),
          chat: Math.round(document.querySelector('#chat').getBoundingClientRect().height),
          nav: Boolean(document.querySelector('#mobile-nav').getClientRects().length),
          left: Math.round(document.querySelector('.input').getBoundingClientRect().left),
        }));
        assert.ok(kb.input <= kb.vv, `kotak input (${kb.input}) di atas keyboard (${kb.vv})`);
        assert.ok(kb.chat >= 80, `chat tetap terlihat (${kb.chat} px)`);
        assert.equal(kb.nav, false, 'rail tersembunyi saat mengetik');
        assert.ok(kb.left < 40, 'kotak memakai lebar penuh saat mengetik');
        await page.setViewport(vp);
        await page.eval(() => document.querySelector('#prompt').blur());
        await page.waitFor(() => !document.body.classList.contains('kb-open'), { timeoutMs: 2000, message: 'keyboard tertutup' });
        assert.deepEqual(page.problems, []);
      });

      test('landscape: setiap sheet muat di tinggi 390 px (di layar, ✕ terlihat, isi panjang digulir di dalam)', async () => {
        const bad = [];
        for (const [trigger, modal] of SHEETS) {
          await fresh('chat');
          await page.click(trigger);
          await page.waitFor((m) => !document.querySelector(m).hidden, { timeoutMs: 3000, message: `${modal} terbuka` }, modal);
          await sleep(220); // slide-up animation
          const fit = await page.eval(sheetFit, modal);
          if (!fit.inView || !fit.closeInView || fit.clipped) bad.push(`${modal}: ${JSON.stringify(fit)}`);
          if (await page.eval(horizontalOverflow)) bad.push(`${modal}: overflow`);
        }
        await closeModals(page);
        assert.deepEqual(bad, []);
        assert.deepEqual(page.problems, []);
      });
    }
  });
}

describe('desktop tidak berubah (> 760 px, pointer halus)', { skip: SKIP ?? false }, () => {
  for (const vp of [DESKTOP, SHORT_DESKTOP]) {
    test(`${vp.name}: layout laptop, tanpa .phone-only, tombol Perubahan lengkap, diff tidak dibungkus`, async () => {
      const page = await browser.newPage();
      try {
        await page.setViewport(vp);
        await openApp(page, `#${projectId}`);
        assert.equal(await page.eval(() => matchMedia('(max-width: 760px), (pointer: coarse) and (max-height: 500px)').matches), false, 'bukan layout HP');
        await page.click('.tabs [data-tab="changes"]');
        await page.waitFor(() => document.querySelector('#ch-diff pre') && !document.querySelector('#ch-git').hidden, { timeoutMs: 8000, message: 'diff desktop' });
        const fp = await page.eval(layoutFingerprint);
        assert.deepEqual(fp.phoneOnlyShown, [], '.phone-only terlihat di desktop');
        for (const sel of ['.tabs', '#session-bar', '#btn-account', '#btn-settings', '#btn-palette', '.ch-head', '#ch-view', '#ch-review', '#ch-refresh', '#ch-git-new', '#ch-git-fetch', '#ch-git-pull', '#ch-git-push', '#ch-git-pr', '#ch-commit']) {
          if (sel === '#session-bar') continue; // hidden on the Perubahan tab
          assert.equal(fp[sel]?.shown, true, `${sel} terlihat`);
        }
        assert.equal(fp['#mobile-nav'].shown, false, 'tanpa navigasi bawah');
        assert.equal(fp['#dash-bar'].shown, false, 'tanpa bar Kantor HP');
        assert.equal(fp.diffPre.ws, 'pre', 'diff laptop tetap bergeser ke samping (tidak dibungkus)');
        assert.equal(fp['.layout'].display, 'grid');
        assert.ok(fp['.office'].shown && fp['.panel'].shown, 'kantor dan panel berdampingan');
        // 1440: office | panel side by side; 900 (≤ 1100 px, the tablet layout as before): office on top, panel below
        if (vp.width > 1100) assert.ok(fp['.panel'].x > fp['.office'].x, 'panel di kanan kantor');
        else assert.ok(fp['.panel'].x === fp['.office'].x && fp['.panel'].y > fp['.office'].y, 'tablet: panel di bawah kantor');
        assert.equal(await page.eval(() => document.body.classList.contains('kb-open')), false);
        assert.deepEqual(page.problems, []);
      } finally {
        await page.close();
      }
    });
  }
});
