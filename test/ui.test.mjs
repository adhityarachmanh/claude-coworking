// UI smoke test: the real server (fake Claude Code, throwaway data) in a headless Chrome/Edge over the
// DevTools Protocol, at a phone and a desktop viewport. No dependencies; skipped when no browser is found.
//   CHROME_PATH=/path/to/chrome npm test    # pick the browser explicitly
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
import { reportHtml } from '../src/report.js';
import { summarize } from '../src/usage.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { name: 'mobile 390x844', width: 390, height: 844, mobile: true },
  { name: 'desktop 1440x900', width: 1440, height: 900, mobile: false },
];

// How the app itself opens each dialog: the first visible selector is clicked (tapped on mobile).
// Dialogs without a simple button (slash commands, Esc Esc, Ctrl+B, team cards in the office view)
// are opened by un-hiding them, exactly what openModal() does.
const TRIGGERS = {
  'project-modal': ['#crumb'],
  'help-modal': ['#btn-help', '[data-open-help]'], // phone: #btn-help is hidden, the welcome card links it
  'settings-modal': ['#btn-settings'],
  'account-modal': ['#btn-account'],
  'report-modal': ['#btn-report'],
  'phone-modal': ['#btn-phone'],
  'sessions-modal': ['#btn-sessions'], // needs a real project (not the demo) selected
};

// Expected noise, not app bugs. Currently none: every resource the pages load exists on the test server.
const IGNORED_PROBLEMS = [];

let TMP;
let BASE;
let PORT;
let server;
let browser;
let projectId;

/** A free localhost port (never the user's running instance on 4317). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** First `snapshot` frame of the event stream. */
async function snapshot() {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/stream`, { signal: controller.signal });
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

/** Starts the server on PORT with the throwaway data in TMP (again after stopServer: same data, a new token). */
async function startServer() {
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      OFFICE_OPEN_DRY_RUN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  server.stderr.resume();
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await Promise.race([exited, sleep(3000)]);
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-ui-'));
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko', 'src'), { recursive: true });
  writeFileSync(path.join(projects, 'toko', 'src', 'checkout.ts'), 'export {};\n');
  mkdirSync(path.join(TMP, 'claude-projects'));
  PORT = await freePort();
  BASE = `http://localhost:${PORT}`;
  await startServer();
  projectId = (await snapshot()).projects.find((p) => p.name === 'toko').id;
  browser = await launchBrowser();
});

after(async () => {
  // Every step is guarded so a failure in one never leaks the others (browser, server, temp dir).
  await browser?.close().catch(() => {});
  await stopServer();
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

// ---------- in-page probes (serialised into the page, so they must be self-contained) ----------

function appReady() {
  const conn = document.querySelector('#conn');
  return conn?.classList.contains('ok') && document.querySelector('#crumb')?.textContent.trim().length > 0;
}

function horizontalOverflow() {
  const { scrollWidth, clientWidth } = document.documentElement;
  if (scrollWidth <= clientWidth) return null;
  // Name the widest culprits so the report points at real elements.
  const wide = [...document.querySelectorAll('body *')]
    .filter((el) => el.getBoundingClientRect().right > clientWidth + 0.5 && el.getClientRects().length)
    .slice(0, 5)
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''} right=${Math.round(el.getBoundingClientRect().right)}`);
  return { scrollWidth, clientWidth, wide };
}

/** Visible buttons (optionally under `rootSel`) without a usable accessible name. */
function unnamedButtons(rootSel) {
  const root = rootSel ? document.querySelector(rootSel) : document;
  const visible = (el) => el.getClientRects().length && !el.closest('[hidden]') && getComputedStyle(el).visibility !== 'hidden';
  // Text a screen reader announces: skip aria-hidden parts; must contain a letter or digit (not just ✕ ↻ 📎).
  const spoken = (el) => {
    let text = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
      else if (node.nodeType === Node.ELEMENT_NODE && node.getAttribute('aria-hidden') !== 'true') node.childNodes.forEach(walk);
    };
    walk(el);
    return text.trim();
  };
  const named = (el) => {
    const labelledby = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    if (labelledby.trim() || el.getAttribute('aria-label')?.trim() || el.getAttribute('title')?.trim()) return true;
    return /[\p{L}\p{N}]/u.test(spoken(el));
  };
  return [...root.querySelectorAll('button')]
    .filter((el) => visible(el) && !named(el))
    .map((el) => el.outerHTML.slice(0, 160));
}

function modalState(id) {
  const modal = document.getElementById(id);
  const active = document.activeElement;
  const describe = (el) => (el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}` : 'null');
  return {
    open: !modal.hidden && getComputedStyle(modal).display !== 'none',
    focusInside: modal.contains(active),
    active: describe(active),
    ...(() => {
      const items = [...modal.querySelectorAll('button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && !el.closest('[hidden]') && el.getClientRects().length);
      return { focusables: items.length, activeIndex: items.indexOf(active) };
    })(),
  };
}

// ---------- helpers ----------

function realProblems(page) {
  return page.problems.filter((p) => !IGNORED_PROBLEMS.some((re) => re.test(p.text)));
}

async function openApp(page, hash = '') {
  page.clearProblems();
  await page.goto(`${BASE}/${hash}`);
  await page.waitFor(appReady, { timeoutMs: 10000, message: 'app terhubung (#conn.ok) dan header terisi' });
  await sleep(300); // let late async work (account, usage) surface any errors
}

const draftKey = () => `office.draft.${projectId}`;

/** Replaces the composer text by typing (a trusted `input` event, as from the keyboard). */
async function typeInPrompt(page, text) {
  await page.eval(() => {
    const input = document.querySelector('#prompt');
    input.value = '';
    input.focus();
  });
  await page.send('Input.insertText', { text });
}

const bannerText = (page) => page.eval(() => document.querySelector('#conn-banner').textContent.trim());

/** Waits until a dialog's markup stops changing (async loaders re-render it after opening). */
async function settle(page, id, { quietMs = 200, timeoutMs = 4000 } = {}) {
  const end = Date.now() + timeoutMs;
  let last = null;
  let since = Date.now();
  while (Date.now() < end) {
    const html = await page.eval((m) => document.getElementById(m).innerHTML, id);
    if (html !== last) (last = html), (since = Date.now());
    else if (Date.now() - since >= quietMs) return;
    await sleep(50);
  }
}

/** Opens `id` like the app does, checks the focus trap and Esc; returns { fails (empty = ok), via }. */
async function checkModal(page, id) {
  const fails = [];
  const candidates = TRIGGERS[id];
  await page.eval(() => {
    document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
    document.activeElement?.blur?.();
  });
  const trigger = candidates ? await page.eval((sels) => sels.find((sel) => document.querySelector(sel)?.getClientRects().length) ?? null, candidates) : null;
  if (candidates) {
    if (!trigger) return { fails: [`tidak ada pemicu yang terlihat di viewport ini (${candidates.join(', ')})`] };
    await page.click(trigger);
  } else {
    await page.eval((m) => (document.getElementById(m).hidden = false), id);
  }
  try {
    await page.waitFor(modalState, { timeoutMs: 2000, message: `${id} terbuka` }, id).then(() => page.waitFor((m) => document.getElementById(m).contains(document.activeElement), { timeoutMs: 1000, message: 'fokus' }, id));
  } catch {
    // reported below with the actual state
  }
  // Let loaders finish first so the checks see the settled dialog.
  await settle(page, id);
  let st = await page.eval(modalState, id);
  const via = trigger ? `klik ${trigger}` : 'hidden=false';
  if (!st.open) return { fails: [`tidak terbuka lewat ${via}`] };
  if (!st.focusInside) fails.push(`fokus tidak masuk modal setelah dibuka (activeElement=${st.active})`);

  const unnamed = await page.eval(unnamedButtons, `#${id}`);
  if (unnamed.length) fails.push(`tombol tanpa nama aksesibel di dalam modal: ${unnamed.join(' | ')}`);

  // Enough presses to walk past the last element and wrap; also proves Tab really moves focus.
  const presses = Math.min(Math.max(st.focusables + 2, 3), 30);
  const visited = new Set([st.activeIndex]);
  for (let i = 0; i < presses; i++) {
    await page.press('Tab');
    st = await page.eval(modalState, id);
    visited.add(st.activeIndex);
    if (!st.focusInside) {
      fails.push(`Tab ke-${i + 1} keluar dari modal (activeElement=${st.active})`);
      break;
    }
  }
  if (st.focusInside && st.focusables >= 2 && visited.size < Math.min(st.focusables, presses)) {
    fails.push(`Tab hanya mengunjungi ${visited.size} dari ${st.focusables} elemen fokus`);
  }
  for (let i = 0; i < 2 && st.focusInside; i++) {
    await page.press('Tab', { shift: true });
    st = await page.eval(modalState, id);
    if (!st.focusInside) fails.push(`Shift+Tab ke-${i + 1} keluar dari modal (activeElement=${st.active})`);
  }

  await page.press('Escape');
  await sleep(50); // MutationObserver restores focus in a microtask after `hidden` flips
  st = await page.eval(modalState, id);
  if (st.open) fails.push('Escape tidak menutup modal');
  else if (trigger) {
    const back = await page.eval((sel) => document.activeElement === document.querySelector(sel), trigger);
    if (!back) fails.push(`fokus tidak kembali ke pemicu ${trigger} (activeElement=${st.active})`);
  }
  return { fails, via };
}

// ---------- tests ----------

for (const vp of VIEWPORTS) {
  describe(`UI ${vp.name}`, { skip: SKIP ?? false }, () => {
    let page;
    before(async () => {
      if (SKIP) return;
      page = await browser.newPage();
      await page.setViewport(vp);
    });
    after(async () => page?.close());

    test('index.html (demo) termuat tanpa error console/exception', async () => {
      await openApp(page);
      assert.deepEqual(realProblems(page), []);
    });

    test('index.html (demo): tidak ada scroll horizontal', async () => {
      assert.equal(await page.eval(horizontalOverflow), null);
    });

    test('index.html (demo): semua tombol terlihat punya nama aksesibel', async () => {
      assert.deepEqual(await page.eval(unnamedButtons), []);
      // Chrome's own accessibility tree agrees: no unignored button with an empty computed name.
      const { nodes } = await page.send('Accessibility.getFullAXTree');
      const empty = nodes.filter((n) => !n.ignored && n.role?.value === 'button' && !String(n.name?.value ?? '').trim());
      assert.deepEqual(empty.map((n) => n.backendDOMNodeId), [], 'AX tree: button tanpa nama');
    });

    test('button.primary berlatar rgb(184, 90, 60)', async () => {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 }); // no :hover
      const colors = await page.eval(() => [...document.querySelectorAll('button.primary')].map((b) => ({ html: b.outerHTML.slice(0, 80), bg: getComputedStyle(b).backgroundColor })));
      assert.ok(colors.length > 0, 'tidak ada button.primary');
      assert.deepEqual(colors.filter((c) => c.bg !== 'rgb(184, 90, 60)'), []);
    });

    if (vp.mobile) {
      test('mobile: #conn titik 10x10, .pill lain tetap terbaca', async (t) => {
        const r = await page.eval(() => {
          const box = document.querySelector('#conn').getBoundingClientRect();
          const pills = [...document.querySelectorAll('.pill:not(#conn)')].map((p) => ({ html: p.outerHTML.slice(0, 80), fontSize: getComputedStyle(p).fontSize }));
          return { w: box.width, h: box.height, pills };
        });
        assert.deepEqual({ w: r.w, h: r.h }, { w: 10, h: 10 });
        if (!r.pills.length) t.diagnostic('tidak ada .pill lain di DOM saat ini (hanya #conn)');
        assert.deepEqual(r.pills.filter((p) => p.fontSize === '0px'), []);
      });
    }

    test('index.html (project): termuat tanpa error, tanpa scroll horizontal, tombol bernama', async () => {
      await openApp(page, `#${projectId}`);
      assert.equal(await page.eval(() => location.hash.slice(1)), projectId);
      assert.deepEqual(realProblems(page), []);
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(await page.eval(unnamedButtons), []);
    });

    test('setiap .modal: buka → fokus masuk, Tab terkurung, Esc menutup, fokus kembali', async (t) => {
      const ids = await page.eval(() => [...document.querySelectorAll('.modal')].map((m) => m.id));
      assert.ok(ids.length >= 10, `hanya ${ids.length} modal ditemukan`);
      page.clearProblems();
      const failures = {};
      for (const id of ids) {
        const { fails, via } = await checkModal(page, id);
        if (fails.length) failures[id] = fails;
        else t.diagnostic(`${id}: ok (${via})`);
      }
      assert.deepEqual(failures, {});
      assert.deepEqual(realProblems(page), [], 'error console saat membuka modal');
    });

    test('⚙ Pengaturan: bagian Cadangkan riwayat tampil, tombol aktif di laptop, export terunduh, tanpa error console', async () => {
      page.clearProblems();
      await page.eval(() => document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)));
      await page.click('#btn-settings');
      await settle(page, 'settings-modal');
      const r = await page.eval(() => ({
        visible: Boolean(document.querySelector('#settings-modal .backup')?.getClientRects().length),
        title: document.querySelector('#backup-title')?.textContent,
        exportEnabled: !document.querySelector('#btn-backup-export').disabled,
        importEnabled: !document.querySelector('#btn-backup-import').disabled,
        laptopOnlyNoteHidden: document.querySelector('#backup-remote').hidden,
        live: document.querySelector('#backup-status').getAttribute('aria-live'),
      }));
      const overflow = await page.eval(horizontalOverflow);
      // The same request the ⬇ button makes (CSP connect-src, token): a zip comes back.
      const download = await page.eval(async () => {
        const token = document.querySelector('meta[name="office-token"]').content;
        const res = await fetch('/api/backup/export', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: '{}' });
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, type: res.headers.get('content-type'), zip: bytes[0] === 0x50 && bytes[1] === 0x4b };
      });
      await page.press('Escape');
      assert.deepEqual(r, { visible: true, title: '💾 Cadangkan riwayat', exportEnabled: true, importEnabled: true, laptopOnlyNoteHidden: true, live: 'polite' });
      assert.equal(overflow, null);
      assert.deepEqual(download, { status: 200, type: 'application/zip', zip: true });
      assert.deepEqual(realProblems(page), []);
    });

    // Regression: renderAccount() rebuilds #account-body; focus must survive (↻ "Cek ulang kuota" re-renders it).
    test('account-modal: fokus tetap di dalam modal setelah ↻ Cek ulang kuota', async () => {
      await page.eval(() => document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)));
      await page.click('#btn-account');
      await settle(page, 'account-modal');
      await page.eval(() => document.querySelector('#account-body [data-act="limits"]').focus());
      assert.equal(await page.eval(() => document.activeElement.dataset.act), 'limits');
      await page.press('Enter');
      await settle(page, 'account-modal');
      const st = await page.eval(modalState, 'account-modal');
      await page.press('Escape');
      assert.ok(st.focusInside, `fokus pindah ke ${st.active} setelah kuota dimuat ulang`);
    });

    // After the dialog checks: sending a prompt removes the welcome card (the phone's only way into help-modal).
    test('draf prompt: kembali setelah reload, terhapus setelah server menerima prompt', async () => {
      const text = `draf ${vp.name} ${Date.now()}`;
      await typeInPrompt(page, text);
      await page.waitFor((k, t) => localStorage.getItem(k) === t, { timeoutMs: 3000, message: 'draf tersimpan (debounce)' }, draftKey(), text);
      await openApp(page, `#${projectId}`); // full reload
      assert.equal(await page.eval(() => document.querySelector('#prompt').value), text, 'draf dipulihkan');
      await page.eval(() => document.querySelector('#prompt').focus());
      await page.press('Enter');
      await page.waitFor((t) => [...document.querySelectorAll('.msg.user')].some((m) => m.textContent.includes(t)), { timeoutMs: 5000, message: 'prompt terkirim' }, text);
      await page.waitFor((k) => localStorage.getItem(k) === null, { timeoutMs: 3000, message: 'draf dihapus setelah terkirim' }, draftKey());
      assert.equal(await page.eval(() => document.querySelector('#prompt').value), '');
      assert.deepEqual(realProblems(page), []);
    });

    test('pair.html termuat tanpa error dan tanpa scroll horizontal', async () => {
      page.clearProblems();
      await page.goto(`${BASE}/pair`);
      await sleep(200);
      assert.deepEqual(realProblems(page), []);
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(await page.eval(unnamedButtons), []);
      assert.equal(await page.eval(() => document.querySelector('#msg').textContent.includes('__MESSAGE__')), false);
    });
  });
}

// ---------- Content-Security-Policy: the printable report still renders ----------

describe('CSP', { skip: SKIP ?? false }, () => {
  test('laporan cetak (document.write ke about:blank, mewarisi CSP) tetap bergaya tanpa pelanggaran CSP', async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport(VIEWPORTS[1]);
      await openApp(page);
      page.clearProblems();
      const now = Date.now();
      const html = reportHtml({
        account: { email: 'tester@example.com' },
        profile: null,
        limits: { windows: [{ label: 'Sesi', percent: 42, resets: 'besok' }] },
        summary: summarize([], { from: now - 86_400_000, to: now, groupBy: 'day' }),
      });
      // Same as downloadReport()'s fallback: an about:blank document written by the app inherits the app's CSP.
      const result = await page.eval((doc) => {
        const frame = document.createElement('iframe');
        document.body.append(frame);
        frame.contentDocument.open();
        frame.contentDocument.write(doc);
        frame.contentDocument.close();
        const d = frame.contentDocument;
        const out = {
          headerBorder: getComputedStyle(d.querySelector('header')).borderBottomStyle, // from the <style> block
          meterWidth: d.querySelector('.meter span')?.style.width, // from a style="" attribute
          meterComputed: getComputedStyle(d.querySelector('.meter span')).width,
        };
        frame.remove();
        return out;
      }, html);
      assert.equal(result.headerBorder, 'solid', '<style> di laporan diterapkan');
      assert.equal(result.meterWidth, '42%');
      assert.notEqual(result.meterComputed, '0px', 'style="" di laporan diterapkan');
      await sleep(200);
      assert.deepEqual(realProblems(page), [], 'tidak ada pelanggaran CSP / error console');
    } finally {
      await page.close();
    }
  });
});

// ---------- a phone on plain WiFi: read-only ----------

describe('UI HP lewat WiFi (hanya lihat)', { skip: SKIP ?? false }, () => {
  let page;
  let LAN = null;
  let laptopApi;

  before(async () => {
    if (SKIP) return;
    const ip = lanAddresses()[0];
    if (!ip) return; // no network: the describe's tests skip themselves
    const token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
    laptopApi = (p, body = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then((r) => r.json());
    await laptopApi('/api/remote', { enabled: true });
    await sleep(300);
    const { code } = await laptopApi('/api/remote/pairing');
    LAN = `http://${ip}:${new URL(BASE).port}`;
    const paired = await fetch(`${LAN}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(paired.status, 200, 'pairing lewat LAN');
    const [name, value] = paired.headers.get('set-cookie').split(';')[0].split('=');
    page = await browser.newPage();
    await page.setViewport(VIEWPORTS[0]);
    await page.send('Network.setCookie', { name, value, url: LAN, httpOnly: true, sameSite: 'Strict' });
    // A pending permission card, to check it is shown but cannot be answered from here.
    await laptopApi(`/api/projects/${projectId}/prompt`, { text: 'minta izin tulis file' });
  });

  after(async () => {
    await page?.close().catch(() => {});
    if (laptopApi) {
      const snap = await snapshot().catch(() => null);
      for (const a of snap?.approvals ?? []) if (a.status === 'pending') await laptopApi(`/api/approvals/${a.id}`, { allow: false }).catch(() => {});
      await laptopApi('/api/remote', { enabled: false }).catch(() => {});
    }
  });

  test('aksi nonaktif dengan penjelasan, tanpa request yang ditolak, tanpa error console', async (t) => {
    if (!LAN) return t.skip('laptop ini tidak punya alamat LAN');
    page.clearProblems();
    await page.goto(`${LAN}/#${projectId}`);
    await page.waitFor(appReady, { timeoutMs: 10000, message: 'app terhubung lewat LAN' });
    await page.waitFor(() => document.querySelector('.approval.pending'), { timeoutMs: 10000, message: 'kartu izin tampil' });
    await sleep(500);
    await page.waitFor(() => !document.querySelector('#ch-files .spinner'), { timeoutMs: 10000, message: 'panel perubahan termuat' });
    // Any 403 the UI triggers on its own shows up here as an http problem: the page asks only for what it may read.
    assert.deepEqual(realProblems(page), []);
    const ui = await page.eval(() => {
      const dis = (sel) => document.querySelector(sel)?.disabled;
      return {
        readOnly: document.body.classList.contains('read-only'),
        prompt: dis('#prompt'),
        placeholder: document.querySelector('#prompt').placeholder,
        controls: ['#btn-send', '#btn-attach', '#mode', '#model', '#effort', '#team-mode', '#btn-new', '#ch-review', '#ch-commit button'].filter((sel) => !dis(sel)),
        hint: document.querySelector('#composer-hint').textContent,
        approvalEnabled: [...document.querySelectorAll('.approval.pending button, .approval.pending input')].filter((b) => !b.disabled).length,
        approvalNote: document.querySelector('.approval.pending .ro-note')?.textContent ?? '',
        // reads still go out: the UI checks them against the server's allowlist from the snapshot
        changesText: document.querySelector('#ch-files').textContent,
      };
    });
    assert.equal(ui.readOnly, true);
    assert.equal(ui.prompt, true, 'kotak pesan nonaktif');
    assert.equal(ui.placeholder, 'Hanya lihat lewat WiFi — pakai Tailscale untuk mengirim perintah');
    assert.deepEqual(ui.controls, [], 'tombol aksi yang masih aktif');
    assert.match(ui.hint, /Hanya lihat lewat WiFi/);
    assert.equal(ui.approvalEnabled, 0, 'kartu izin tidak bisa dijawab');
    assert.match(ui.approvalNote, /laptop atau HP lewat Tailscale/);
    assert.doesNotMatch(ui.changesText, /Hanya lihat lewat WiFi/, 'panel perubahan tetap bisa dibaca');
    assert.equal(await page.eval(horizontalOverflow), null);
    assert.deepEqual(await page.eval(unnamedButtons), []);
  });

  // The stream really stays up here; the handlers are driven directly (same module instance as the app's).
  test('putus lama di HP: petunjuk laptop/Tailscale (bukan start-office), Kirim tetap hanya-lihat', async (t) => {
    if (!LAN) return t.skip('laptop ini tidak punya alamat LAN');
    const shown = await page.eval(async () => {
      const m = await import('/js/features/connection.js');
      const saved = { ...m.CONN_TIMING };
      Object.assign(m.CONN_TIMING, { showAfterMs: 0, longAfterMs: 50 });
      m.streamLost();
      await new Promise((r) => setTimeout(r, 300));
      const text = document.querySelector('#conn-banner').textContent.trim();
      Object.assign(m.CONN_TIMING, saved);
      await m.streamOpened();
      return text;
    });
    assert.match(shown, /^Laptop tidak terjangkau — pastikan laptop menyala dan Tailscale\/WiFi aktif/);
    assert.doesNotMatch(shown, /start-office/);
    assert.equal(await bannerText(page), '', 'banner hilang setelah tersambung');
    assert.equal(await page.eval(() => document.querySelector('#btn-send').disabled), true, 'tersambung lagi tidak membuka Kirim di WiFi');
  });
});

// ---------- lost connection: the server stops and comes back (runs last: the restart gives a new token) ----------

describe('UI koneksi putus', { skip: SKIP ?? false }, () => {
  let page;
  before(async () => {
    if (SKIP) return;
    page = await browser.newPage();
    await page.setViewport(VIEWPORTS[0]);
    await openApp(page, `#${projectId}`);
  });
  after(async () => page?.close());

  test('putus sebentar (< ambang): tidak ada banner, tidak ada toast', async () => {
    const r = await page.eval(async () => {
      const m = await import('/js/features/connection.js');
      m.streamLost();
      await new Promise((res) => setTimeout(res, 500));
      const during = { banner: document.querySelector('#conn-banner').textContent, send: document.querySelector('#btn-send').disabled };
      await m.streamOpened();
      await new Promise((res) => setTimeout(res, m.CONN_TIMING.showAfterMs + 200)); // the cancelled timer must not fire
      const toast = [...document.querySelectorAll('.toast')].some((n) => /Tersambung lagi/.test(n.textContent));
      return { during, after: document.querySelector('#conn-banner').textContent, toast, send: document.querySelector('#btn-send').disabled };
    });
    assert.deepEqual(r, { during: { banner: '', send: true }, after: '', toast: false, send: false });
  });

  test('server mati → banner setelah ±2 dtk, Kirim ditahan, draf aman; hidup lagi → banner hilang, kirim jalan', async () => {
    await page.eval(async () => {
      const m = await import('/js/features/connection.js');
      m.CONN_TIMING.longAfterMs = 4500; // instead of 30 s
    });
    const text = `kirim setelah tersambung lagi ${Date.now()}`;
    await typeInPrompt(page, text);
    await page.waitFor((k, t) => localStorage.getItem(k) === t, { timeoutMs: 3000, message: 'draf tersimpan' }, draftKey(), text);

    const stoppedAt = Date.now();
    await stopServer();
    await page.waitFor(() => document.querySelector('#conn.bad'), { timeoutMs: 5000, message: '#conn merah' });
    if (Date.now() - stoppedAt < 1500) assert.equal(await bannerText(page), '', 'banner belum muncul sebelum ambang');
    await page.waitFor(() => /Terputus dari laptop — menyambung lagi/.test(document.querySelector('#conn-banner').textContent), { timeoutMs: 6000, message: 'banner terputus' });
    const ui = await page.eval(() => ({
      role: document.querySelector('#conn-banner').getAttribute('role'),
      live: document.querySelector('#conn-banner').getAttribute('aria-live'),
      send: document.querySelector('#btn-send').disabled,
      prompt: document.querySelector('#prompt').disabled,
    }));
    assert.deepEqual(ui, { role: 'status', live: 'polite', send: true, prompt: false });
    assert.equal(await page.eval(horizontalOverflow), null);

    // Enter while offline: refused with a message, nothing lost.
    await page.eval(() => document.querySelector('#prompt').focus());
    await page.press('Enter');
    await page.waitFor(() => [...document.querySelectorAll('.toast')].some((n) => /Belum tersambung ke laptop/.test(n.textContent)), { timeoutMs: 2000, message: 'toast belum tersambung' });
    assert.equal(await page.eval(() => document.querySelector('#prompt').value), text);
    assert.equal(await page.eval((k) => localStorage.getItem(k), draftKey()), text);

    await page.waitFor(() => /Server Adhit Office tidak berjalan — jalankan start-office\.cmd/.test(document.querySelector('#conn-banner').textContent), { timeoutMs: 6000, message: 'petunjuk putus lama (laptop)' });

    await startServer();
    await page.waitFor(() => document.querySelector('#conn.ok') && !document.querySelector('#conn-banner').textContent, { timeoutMs: 15000, message: 'tersambung lagi, banner hilang' });
    assert.ok(await page.eval(() => [...document.querySelectorAll('.toast')].some((n) => n.textContent === 'Tersambung lagi.')), 'toast tersambung lagi');
    assert.equal(await page.eval(() => document.querySelector('#btn-send').disabled), false);
    assert.equal(await page.eval(() => document.querySelector('#prompt').value), text, 'teks tetap di kotak');

    // The restarted server has a new token: sending works without a reload, then the draft goes.
    page.clearProblems();
    await page.eval(() => document.querySelector('#prompt').focus());
    await page.press('Enter');
    await page.waitFor((t) => [...document.querySelectorAll('.msg.user')].some((m) => m.textContent.includes(t)), { timeoutMs: 8000, message: 'prompt terkirim setelah restart' }, text);
    await page.waitFor((k) => localStorage.getItem(k) === null, { timeoutMs: 3000, message: 'draf dihapus' }, draftKey());
    assert.deepEqual(realProblems(page), []);
  });
});
