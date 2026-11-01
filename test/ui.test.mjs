// UI smoke test: the real server (fake Claude Code, throwaway data) in a headless Chrome/Edge over the
// DevTools Protocol, at a phone and a desktop viewport. No dependencies; skipped when no browser is found.
//   CHROME_PATH=/path/to/chrome npm test    # pick the browser explicitly
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'), // user-level settings.json (🛡️ Aturan izin), never the real ~/.claude
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

    test('⚡ Template: /t membuka pemilih, ↑↓ Enter menyisipkan (tidak terkirim), placeholder terseleksi, Tab ke berikutnya', async () => {
      await openApp(page, `#${projectId}`);
      page.clearProblems();
      const selected = () => page.eval(() => {
        const i = document.querySelector('#prompt');
        return { text: i.value.slice(i.selectionStart, i.selectionEnd), focused: document.activeElement === i };
      });
      // Other slash commands are untouched: /ta still offers /tasks first.
      await typeInPrompt(page, '/ta');
      await page.waitFor(() => !document.querySelector('#suggest').hidden, { timeoutMs: 2000, message: 'autocomplete /ta' });
      assert.match(await page.eval(() => document.querySelector('#suggest .opt.active').textContent), /^\/tasks/);
      await typeInPrompt(page, '/t');
      await page.waitFor(() => /^\/template/.test(document.querySelector('#suggest .opt.active')?.textContent ?? ''), { timeoutMs: 2000, message: '/t → /template di urutan pertama' });
      await page.press('Enter');
      await page.waitFor(() => !document.querySelector('#templates-modal').hidden && document.activeElement?.id === 'tpl-search', { timeoutMs: 2000, message: 'pemilih terbuka, fokus di pencarian' });
      assert.equal(await page.eval(() => document.querySelector('#prompt').value), '', '"/t" dihapus dari kotak pesan');
      const builtins = await page.eval(() => [...document.querySelectorAll('#tpl-list [role="option"] b')].map((b) => b.textContent));
      assert.ok(builtins.length >= 8, `template bawaan: ${builtins.join(' | ')}`);
      assert.equal(await page.eval(horizontalOverflow), null, 'pemilih tanpa scroll horizontal');
      assert.deepEqual(await page.eval(unnamedButtons, '#templates-modal'), []);

      await page.send('Input.insertText', { text: 'root cause' });
      const listed = await page.eval(() => [...document.querySelectorAll('#tpl-list [role="option"] b')].map((b) => b.textContent));
      assert.deepEqual(listed.slice(0, 2), ['Jelaskan error ini & perbaiki root cause', 'Cari & perbaiki bug']);
      await page.press('ArrowDown');
      assert.equal(await page.eval(() => document.querySelector('#tpl-list [aria-selected="true"] b').textContent), 'Cari & perbaiki bug');
      assert.equal(await page.eval(() => document.querySelector('#tpl-search').getAttribute('aria-activedescendant')), await page.eval(() => document.querySelector('#tpl-list [aria-selected="true"]').id));
      await page.press('ArrowUp');
      await page.press('Enter');
      await page.waitFor(() => document.querySelector('#templates-modal').hidden, { timeoutMs: 2000, message: 'pemilih tertutup' });
      const value = await page.eval(() => document.querySelector('#prompt').value);
      assert.match(value, /^Error berikut muncul saat \{langkah untuk mereproduksi\}/);
      assert.deepEqual(await selected(), { text: '{langkah untuk mereproduksi}', focused: true }, 'placeholder pertama terseleksi');
      await page.send('Input.insertText', { text: 'klik Bayar' });
      await page.press('Tab');
      assert.deepEqual(await selected(), { text: '{tempel log / stack trace di sini}', focused: true }, 'Tab ke placeholder berikutnya');
      await page.press('Tab');
      assert.equal((await selected()).focused, false, 'tanpa placeholder tersisa, Tab pindah fokus seperti biasa');
      assert.match(await page.eval(() => document.querySelector('#prompt').value), /saat klik Bayar:/);
      assert.equal(await page.eval(() => [...document.querySelectorAll('.msg.user')].some((m) => m.textContent.includes('Error berikut muncul'))), false, 'tidak langsung dikirim');
      await page.eval((k) => {
        document.querySelector('#prompt').value = '';
        localStorage.removeItem(k);
      }, draftKey());
      assert.deepEqual(realProblems(page), []);
    });

    test('⚡ Template milikku: tambah (validasi, di-escape), tersimpan di server setelah reload, hapus', async () => {
      await openApp(page, `#${projectId}`);
      page.clearProblems();
      const openPicker = async () => {
        await page.click('#btn-template');
        await page.waitFor(() => !document.querySelector('#templates-modal').hidden && !document.querySelector('#tpl-new').disabled, { timeoutMs: 3000, message: 'pemilih terbuka & daftar milikku termuat' });
      };
      const name = `<img src=x onerror="window.__xss=1">Cek ${vp.name}`;
      await openPicker();
      await page.click('#tpl-new');
      assert.equal(await page.eval(() => document.activeElement.id), 'tpl-name');
      await page.click('#tpl-save'); // empty: refused in the page, nothing sent
      assert.match(await page.eval(() => document.querySelector('#tpl-error').textContent), /Nama template wajib diisi/);
      assert.equal(await page.eval(() => document.querySelector('#tpl-name').getAttribute('aria-invalid')), 'true');
      await page.send('Input.insertText', { text: name });
      await page.eval(() => document.querySelector('#tpl-text').focus());
      await page.send('Input.insertText', { text: 'Halo {nama}, cek {file}' });
      assert.equal(await page.eval(() => document.querySelector('#tpl-text-count').textContent), '23/8000');
      assert.equal(await page.eval(horizontalOverflow), null, 'form tanpa scroll horizontal');
      await page.click('#tpl-save');
      await page.waitFor((n) => [...document.querySelectorAll('#tpl-list [role="option"] b')].some((b) => b.textContent === n), { timeoutMs: 3000, message: 'template baru di daftar' }, name);
      const safe = await page.eval(() => ({ img: Boolean(document.querySelector('#tpl-list img, #tpl-preview img')), xss: window.__xss ?? null, preview: document.querySelector('#tpl-preview').textContent }));
      assert.deepEqual(safe, { img: false, xss: null, preview: 'Halo {nama}, cek {file}' }, 'nama ditampilkan sebagai teks');
      await page.press('Escape');

      await openApp(page, `#${projectId}`); // reload: the list comes from the server
      await openPicker();
      const i = await page.eval((n) => [...document.querySelectorAll('#tpl-list [role="option"]')].findIndex((o) => o.querySelector('b').textContent === n), name);
      assert.ok(i >= 0, 'masih ada setelah reload');
      await page.eval((idx) => document.querySelectorAll('#tpl-list [role="option"]')[idx].click(), i);
      assert.deepEqual(await page.eval(() => ({ edit: !document.querySelector('#tpl-edit').hidden, del: !document.querySelector('#tpl-delete').hidden, copy: !document.querySelector('#tpl-copy').hidden })), { edit: true, del: true, copy: false });
      await page.click('#tpl-use');
      await page.waitFor(() => document.querySelector('#templates-modal').hidden, { timeoutMs: 2000, message: 'disisipkan' });
      assert.equal(await page.eval(() => document.querySelector('#prompt').value), 'Halo {nama}, cek {file}');
      await openPicker();
      await page.eval((idx) => document.querySelectorAll('#tpl-list [role="option"]')[idx].click(), i);
      await page.eval(() => (window.confirm = () => true));
      await page.click('#tpl-delete');
      await page.waitFor((n) => ![...document.querySelectorAll('#tpl-list [role="option"] b')].some((b) => b.textContent === n), { timeoutMs: 3000, message: 'terhapus' }, name);
      await page.press('Escape');
      await page.eval((k) => {
        document.querySelector('#prompt').value = '';
        localStorage.removeItem(k);
      }, draftKey());
      assert.deepEqual(realProblems(page), []);
    });

    test('⏳ Peringatan kuota: sekali per ambang 70/90/100, tidak berulang setelah reload, muncul lagi setelah reset; indikator & tooltip; ambang di ⚙', async () => {
      await openApp(page, `#${projectId}`);
      await page.eval(() => {
        localStorage.removeItem('office.quotaWarned');
        localStorage.removeItem('office.quotaAlerts');
      });
      await openApp(page, `#${projectId}`);
      await page.waitFor(() => window.document.querySelector('#account-label').textContent.includes('@'), { timeoutMs: 10000, message: 'profil akun termuat' });
      page.clearProblems();
      const reset1 = Math.floor(Date.now() / 1000) + 3 * 86400;
      // A rate_limit_event as the server forwards it (account.rateLimit.windows), straight into the app's handler.
      const fire = (pct, resetsAt) =>
        page.eval(
          async (p, r) => {
            document.querySelectorAll('.toast').forEach((t) => t.remove());
            const { onAccountState } = await import('/js/features/account.js');
            onAccountState({ rateLimit: { windows: { seven_day: { status: p >= 100 ? 'rejected' : 'allowed_warning', utilization: p / 100, resetsAt: r, at: Date.now() } }, at: Date.now() } });
            const pill = document.querySelector('#quota-pill');
            return {
              toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent).filter((t) => /Kuota/.test(t)),
              pill: pill.hidden ? null : { text: pill.textContent, tone: pill.classList.contains('crit') ? 'crit' : pill.classList.contains('warn') ? 'warn' : '', title: pill.title, label: pill.getAttribute('aria-label') },
            };
          },
          pct,
          resetsAt,
        );
      let r = await fire(50, reset1);
      assert.deepEqual(r, { toasts: [], pill: null }, 'di bawah 70: diam');
      r = await fire(72, reset1);
      assert.equal(r.toasts.length, 1);
      assert.match(r.toasts[0], /^⚠ Kuota mingguan sudah 72% — reset \S+ \d{2}\.\d{2}\.$/);
      assert.equal(r.pill.tone, 'warn');
      assert.equal(r.pill.text, '72%');
      assert.match(r.pill.title, /^Kuota mingguan 72% · reset \S+ \d{2}\.\d{2}\n/);
      assert.match(r.pill.label, /^Peringatan kuota: Kuota mingguan 72%/);
      assert.equal(await page.eval(horizontalOverflow), null, 'indikator tidak membuat overflow');
      assert.deepEqual((await fire(75, reset1)).toasts, [], 'tidak berulang');

      await openApp(page, `#${projectId}`); // reload: the same period is remembered
      r = await fire(76, reset1);
      assert.deepEqual(r.toasts, [], 'tidak berulang setelah reload');
      r = await fire(92, reset1);
      assert.equal(r.toasts.length, 1);
      assert.match(r.toasts[0], /sudah 92%/);
      assert.equal(r.pill.tone, 'crit');
      r = await fire(100, reset1);
      assert.match(r.toasts[0], /^⛔ Kuota mingguan habis — Claude tidak bisa dipakai sampai reset \S+ \d{2}\.\d{2}\.$/);
      assert.equal(r.pill.text, 'habis');
      // the next period (a later reset time): warned again
      r = await fire(71, reset1 + 7 * 86400);
      assert.equal(r.toasts.length, 1, 'muncul lagi setelah reset');
      assert.match(r.toasts[0], /sudah 71%/);

      // ⚙ Pengaturan: thresholds validated, saved per browser, can be switched off.
      await page.eval(() => document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)));
      await page.click('#btn-settings');
      await settle(page, 'settings-modal');
      assert.deepEqual(await page.eval(() => ({ on: document.querySelector('#quota-on').checked, warn: document.querySelector('#quota-warn').value, crit: document.querySelector('#quota-crit').value })), { on: true, warn: '70', crit: '90' });
      const setField = (sel, v) =>
        page.eval(
          (s, val) => {
            const el = document.querySelector(s);
            el.value = val;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          },
          sel,
          v,
        );
      await setField('#quota-warn', '95');
      assert.match(await page.eval(() => document.querySelector('#quota-error').textContent), /lebih kecil/);
      assert.equal(await page.eval(() => localStorage.getItem('office.quotaAlerts')), null, 'nilai salah tidak disimpan');
      await setField('#quota-warn', '60');
      await setField('#quota-crit', '80');
      assert.deepEqual(await page.eval(() => JSON.parse(localStorage.getItem('office.quotaAlerts'))), { enabled: true, warn: 60, crit: 80 });
      assert.equal(await page.eval(horizontalOverflow), null, 'Pengaturan tanpa scroll horizontal');
      await page.click('#quota-on');
      assert.equal(await page.eval(() => JSON.parse(localStorage.getItem('office.quotaAlerts')).enabled), false);
      await page.press('Escape');
      assert.deepEqual(await fire(99, reset1 + 14 * 86400), { toasts: [], pill: null }, 'dimatikan: tanpa toast & indikator');

      await page.eval(async () => {
        localStorage.removeItem('office.quotaWarned');
        localStorage.removeItem('office.quotaAlerts');
        const { onAccountState } = await import('/js/features/account.js');
        onAccountState({ rateLimit: null });
      });
      assert.deepEqual(realProblems(page), []);
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

    test('⚙ Tema kantor: pilih Halloween → tersimpan, bertahan setelah reload, sprite & avatar berganti; kembali ke Kantor', async () => {
      page.clearProblems();
      const openSettings = async () => {
        await page.eval(() => document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)));
        await page.click('#btn-settings');
        await settle(page, 'settings-modal');
      };
      const themeState = () => ({
        stored: localStorage.getItem('office.theme'),
        root: document.documentElement.dataset.officeTheme,
        checked: [...document.querySelectorAll('#theme-seg button[aria-pressed="true"]')].map((b) => b.dataset.theme),
        avatar: document.querySelector('#team .member[data-role="ui-ux"] img')?.src ?? '',
      });

      await openSettings();
      const seg = await page.eval(() => ({
        role: document.querySelector('#theme-seg').getAttribute('role'),
        label: document.querySelector('#theme-seg').getAttribute('aria-labelledby'),
        options: [...document.querySelectorAll('#theme-seg button')].map((b) => [b.dataset.theme, b.textContent.trim()]),
      }));
      assert.deepEqual(seg, {
        role: 'group',
        label: 'theme-title',
        options: [['kantor', '🏢 Kantor'], ['halloween', '🎃 Halloween'], ['natal', '🎄 Natal'], ['lebaran', '🌙 Lebaran'], ['agustus', '🇮🇩 17 Agustus']],
      });
      const before = await page.eval(themeState);
      assert.deepEqual({ root: before.root, checked: before.checked }, { root: 'kantor', checked: ['kantor'] }, 'default: Kantor');

      await page.click('#theme-seg button[data-theme="halloween"]');
      const picked = await page.eval(themeState);
      assert.deepEqual({ stored: picked.stored, root: picked.root, checked: picked.checked }, { stored: 'halloween', root: 'halloween', checked: ['halloween'] });
      assert.notEqual(picked.avatar, before.avatar, 'avatar kartu tim digambar ulang tanpa reload');
      assert.equal(await page.eval(horizontalOverflow), null, 'dialog Pengaturan tanpa scroll horizontal');
      await page.press('Escape');

      await openApp(page, `#${projectId}`); // full reload
      const reloaded = await page.eval(themeState);
      assert.deepEqual({ stored: reloaded.stored, root: reloaded.root, checked: reloaded.checked }, { stored: 'halloween', root: 'halloween', checked: ['halloween'] }, 'bertahan setelah reload');
      assert.equal(reloaded.avatar, picked.avatar);
      assert.equal(await page.eval(horizontalOverflow), null);

      // Every role in the main poses paints in both themes; switching really changes the sprites (cache invalidated).
      const sprites = await page.eval(async () => {
        const { applyTheme } = await import('/js/features/theme.js');
        const { characterSprite, catSprite } = await import('/js/office/sprites.js');
        const { CAST, ROLE_ORDER } = await import('/js/office/cast.js');
        const states = [];
        for (const view of ['down', 'up', 'left', 'right']) {
          for (const [pose, arms] of [['stand', 'down'], ['walk', 'down'], ['sit', 'type'], ['sofa', 'hold'], ['stand', 'raise'], ['stand', 'cheer'], ['stand', 'scratch']]) {
            for (const frame of [0, 1, 2]) states.push({ view, pose, arms, frame, item: 'cup', blink: frame === 2, talk: frame === 1, mood: frame ? 'happy' : 'worried' });
          }
        }
        const render = () => Object.fromEntries(ROLE_ORDER.map((id) => [id, states.map((s) => characterSprite(CAST[id].look, s).toDataURL()).join()]));
        const out = {};
        applyTheme('kantor', { persist: false });
        out.kantor = render();
        out.catKantor = catSprite('sit', 0, false).toDataURL();
        applyTheme('halloween', { persist: false });
        out.halloween = render();
        out.catHalloween = catSprite('sit', 0, false).toDataURL();
        // The newer themes: a sample of the poses (every view and pose, fewer frames) keeps this test quick.
        const sample = states.filter((_, i) => i % 3 === 0);
        const renderSample = () => Object.fromEntries(ROLE_ORDER.map((id) => [id, sample.map((s) => characterSprite(CAST[id].look, s).toDataURL()).join()]));
        applyTheme('kantor', { persist: false });
        const kantorSample = renderSample();
        const festive = {};
        for (const id of ['natal', 'lebaran', 'agustus']) {
          applyTheme(id, { persist: false });
          const looks = renderSample();
          festive[id] = {
            changed: ROLE_ORDER.filter((role) => kantorSample[role] !== looks[role]),
            catChanged: catSprite('sit', 0, false).toDataURL() !== out.catKantor,
          };
        }
        applyTheme('kantor', { persist: false });
        out.kantorAgain = render();
        out.catKantorAgain = catSprite('sit', 0, false).toDataURL();
        applyTheme('halloween', { persist: false });
        return {
          changed: ROLE_ORDER.filter((id) => out.kantor[id] !== out.halloween[id]),
          stable: ROLE_ORDER.filter((id) => out.kantor[id] === out.kantorAgain[id]),
          roles: ROLE_ORDER,
          catChanged: out.catKantor !== out.catHalloween,
          catStable: out.catKantor === out.catKantorAgain,
          festive,
        };
      });
      assert.deepEqual(sprites.changed, sprites.roles, 'setiap role berkostum di Halloween');
      assert.deepEqual(sprites.stable, sprites.roles, 'kembali ke Kantor = sprite semula');
      assert.ok(sprites.catChanged, 'kucing hitam di Halloween');
      assert.ok(sprites.catStable, 'kucing Kantor kembali semula');
      for (const [id, f] of Object.entries(sprites.festive)) {
        assert.deepEqual(f.changed, sprites.roles, `setiap role berkostum di ${id}`);
        assert.ok(f.catChanged, `kucing ${id} berbeda`);
      }

      // Natal, Lebaran, 17 Agustus via the picker: saved, avatars redrawn, a few frames of decor/lighting, no errors.
      await openSettings();
      for (const id of ['natal', 'lebaran', 'agustus']) {
        const prev = await page.eval(themeState);
        await page.click(`#theme-seg button[data-theme="${id}"]`);
        const now = await page.eval(themeState);
        assert.deepEqual({ stored: now.stored, root: now.root, checked: now.checked }, { stored: id, root: id, checked: [id] }, `${id} tersimpan`);
        assert.notEqual(now.avatar, prev.avatar, `${id}: avatar digambar ulang`);
        assert.equal(await page.eval(horizontalOverflow), null, `${id}: dialog tanpa scroll horizontal`);
        await sleep(200);
      }
      await page.press('Escape');

      // A couple of frames in Halloween (bats, candles, lighting) without errors, then back to Kantor.
      await sleep(300);
      await openSettings();
      await page.click('#theme-seg button[data-theme="kantor"]');
      await page.press('Escape');
      await openApp(page, `#${projectId}`);
      const back = await page.eval(themeState);
      assert.deepEqual({ stored: back.stored, root: back.root }, { stored: 'kantor', root: 'kantor' });
      assert.equal(back.avatar, before.avatar, 'avatar Kantor kembali seperti semula');
      assert.deepEqual(realProblems(page), []);
    });

    test('⧗ monitor tugas latar: chip, daftar, detail agent & shell live, buka dari kantor, polling berhenti saat ditutup', async () => {
      await openApp(page, `#${projectId}`);
      page.clearProblems();
      // Two background tasks (fake Claude: a qa subagent whose transcript grows, and a dev server) — once per run.
      const runningCount = (pid) =>
        fetch('/stream').then(async (res) => {
          const reader = res.body.getReader();
          let text = '';
          while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
          reader.cancel();
          return (JSON.parse(text.match(/^data: (.*)$/m)[1]).statuses[pid]?.tasks ?? []).filter((t) => t.status === 'running').length;
        });
      if ((await page.eval(runningCount, projectId)) < 2) {
        await page.eval(async (pid) => {
          const token = document.querySelector('meta[name="office-token"]').content;
          await fetch(`/api/projects/${pid}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify({ text: 'jalankan tugas latar' }) });
        }, projectId);
      }
      await page.waitFor(() => !document.querySelector('#sb-tasks').hidden, { timeoutMs: 10000, message: 'chip ⧗ tampil' });
      const n = await page.eval(runningCount, projectId);
      const chip = await page.eval(() => ({ n: document.querySelector('#sb-tasks-n').textContent, label: document.querySelector('#sb-tasks').getAttribute('aria-label'), statusline: document.querySelector('#statusline .sl-tasks')?.textContent }));
      assert.equal(chip.n, String(n), 'jumlah di chip = tugas berjalan');
      assert.match(chip.label, new RegExp(`^${n} tugas berjalan`));
      assert.match(chip.statusline, new RegExp(`⧗ ${n} tugas berjalan`));
      assert.equal(await page.eval(horizontalOverflow), null, 'chip tidak membuat overflow');

      // Count monitor requests from here on (to prove polling stops when the dialog closes).
      await page.eval(() => {
        window.__taskCalls = 0;
        const orig = window.fetch;
        window.fetch = (url, ...rest) => {
          if (/\/task-(detail|output)$/.test(String(url))) window.__taskCalls++;
          return orig(url, ...rest);
        };
      });
      await page.click('#sb-tasks');
      await page.waitFor(() => !document.querySelector('#tasks-modal').hidden && document.querySelectorAll('#tasks-list [data-task]').length >= 2, { timeoutMs: 3000, message: 'monitor terbuka dengan daftar' });
      const groups = await page.eval(() => [...document.querySelectorAll('#tasks-list .tasks-group')].map((g) => g.textContent));
      assert.match(groups[0], /^Berjalan/, 'yang berjalan di atas');

      // Agent detail: live steps (labels like the chat), auto-scrolled to the newest.
      await page.eval(() => [...document.querySelectorAll('#tasks-list [data-task]')].find((b) => b.textContent.includes('Uji regresi')).click());
      await page.waitFor(() => document.querySelectorAll('#td-body .td-steps .step').length >= 2, { timeoutMs: 5000, message: 'langkah agent tampil' });
      const before = await page.eval(() => document.querySelectorAll('#td-body .td-steps .step').length);
      await page.waitFor((b) => document.querySelectorAll('#td-body .td-steps .step').length > b, { timeoutMs: 6000, message: 'langkah bertambah (polling)' }, before);
      const agent = await page.eval(() => {
        const body = document.querySelector('#td-body');
        return {
          title: document.querySelector('#td-title').textContent,
          info: document.querySelector('#td-info').textContent,
          live: document.querySelector('#td-meta').getAttribute('aria-live'),
          labels: [...body.querySelectorAll('.step-label')].map((l) => l.textContent),
          atBottom: body.scrollHeight - body.scrollTop - body.clientHeight < 40,
          stop: Boolean(document.querySelector('#td-actions [data-task-act="stop"]')),
          showDetail: document.querySelector('#tasks-body').classList.contains('show-detail'),
          listVisible: Boolean(document.querySelector('#tasks-list').getClientRects().length),
        };
      });
      assert.match(agent.title, /Uji regresi checkout/);
      assert.match(agent.info, /Adhit - QA/);
      assert.match(agent.info, /\d+ (dtk|mnt)/, 'durasi tampil');
      assert.equal(agent.live, 'polite');
      assert.ok(agent.labels.some((l) => /^Membaca checkout\.ts$|^\$ npm test -- checkout$|^Mengedit checkout\.ts$/.test(l)), agent.labels.join(' | '));
      assert.ok(agent.atBottom, 'auto-scroll ke langkah terbaru');
      assert.ok(agent.stop, 'tombol Hentikan');
      assert.equal(agent.listVisible, !vp.mobile, vp.mobile ? 'HP: detail menggantikan daftar' : 'desktop: daftar & detail berdampingan');

      // Shell detail: the command and its live output.
      if (vp.mobile) await page.click('#td-back');
      await page.eval(() => [...document.querySelectorAll('#tasks-list [data-task]')].find((b) => b.textContent.includes('Dev server')).click());
      await page.waitFor(() => /GET \/checkout/.test(document.querySelector('#td-body .td-out')?.textContent ?? ''), { timeoutMs: 5000, message: 'output shell tampil' });
      const outLen = await page.eval(() => document.querySelector('#td-body .td-out').textContent.length);
      await page.waitFor((l) => document.querySelector('#td-body .td-out').textContent.length > l, { timeoutMs: 6000, message: 'output shell bertambah' }, outLen);
      assert.match(await page.eval(() => document.querySelector('#td-body .td-command').textContent), /\$ npm run dev -- --port 3000/);
      assert.deepEqual(await page.eval(unnamedButtons, '#tasks-modal'), []);
      assert.equal(await page.eval(horizontalOverflow), null, 'monitor tanpa scroll horizontal');

      // Closed: no more polling.
      await page.press('Escape');
      await sleep(300);
      const calls = await page.eval(() => window.__taskCalls);
      await sleep(4500);
      assert.equal(await page.eval(() => window.__taskCalls), calls, 'polling berhenti setelah monitor ditutup');

      // From the office: the ⧗ badge on the QA card (the card itself still renames).
      if (vp.mobile) await page.click('#mobile-nav [data-view="office"]');
      await page.waitFor(() => Boolean(document.querySelector('#team .member[data-role="qa"] + .member-task')), { timeoutMs: 3000, message: 'badge ⧗ di kartu QA' });
      await page.click('#team .member[data-role="qa"] + .member-task');
      await page.waitFor(() => !document.querySelector('#tasks-modal').hidden && /Uji regresi/.test(document.querySelector('#td-title').textContent), { timeoutMs: 3000, message: 'monitor terbuka dengan tugas QA' });
      assert.equal(await page.eval(() => document.querySelector('#team-modal').hidden), true, 'dialog ganti nama tidak ikut terbuka');
      await page.press('Escape');

      if (!vp.mobile) {
        // A click on the QA character in the canvas opens the same task.
        const at = await page.eval(async () => {
          const { sceneFor } = await import('/js/core/scenes.js');
          const { W } = await import('/js/office/world.js');
          const qa = sceneFor(location.hash.slice(1)).people.qa;
          const r = document.querySelector('#stage canvas').getBoundingClientRect();
          const k = r.width / W;
          return { x: r.left + qa.x * k, y: r.top + (qa.y - 12) * k };
        });
        const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
        await page.waitFor(() => !document.querySelector('#tasks-modal').hidden && /Uji regresi/.test(document.querySelector('#td-title').textContent), { timeoutMs: 3000, message: 'klik karakter QA membuka monitor' });
        await page.press('Escape');
      }
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      assert.deepEqual(realProblems(page), []);
    });

    test('output live perintah di chat: ekor ringkas & blok terbuka bertambah, polling berhenti setelah selesai', async () => {
      page.clearProblems();
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      await page.eval(() => document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)));
      await page.eval(() => {
        window.__liveCalls = 0;
        if (window.__liveWrapped) return;
        window.__liveWrapped = true;
        const orig = window.fetch;
        window.fetch = (url, opts) => {
          if (/\/task-output$/.test(String(url))) window.__liveCalls++;
          return orig(url, opts);
        };
      });
      const before = await page.eval(() => document.querySelectorAll('#chat .line.tool').length);
      await page.eval(async (pid) => {
        const token = document.querySelector('meta[name="office-token"]').content;
        await fetch(`/api/projects/${pid}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify({ text: 'jalankan perintah panjang' }) });
      }, projectId);
      await page.waitFor((n) => document.querySelectorAll('#chat .line.tool').length > n, { timeoutMs: 8000, message: 'baris perintah muncul' }, before);
      // Collapsed: the last lines appear under the row and grow while it runs.
      const tail = (n) => [...document.querySelectorAll('#chat .line.tool')][n]?.querySelector('.live-tail:not([hidden])')?.textContent ?? '';
      await page.waitFor((n) => /compile modul-/.test([...document.querySelectorAll('#chat .line.tool')][n]?.querySelector('.live-tail:not([hidden])')?.textContent ?? ''), { timeoutMs: 6000, message: 'ekor output tampil di baris tertutup' }, before);
      const first = await page.eval(tail, before);
      await page.waitFor((n, t) => ([...document.querySelectorAll('#chat .line.tool')][n]?.querySelector('.live-tail')?.textContent ?? '') !== t, { timeoutMs: 5000, message: 'ekor output bertambah' }, before, first);
      assert.ok((await page.eval((n) => [...document.querySelectorAll('#chat .line.tool')][n].querySelectorAll('.live-tail span').length, before)) <= 8, 'paling banyak 8 baris ringkas');
      // Expanded: the whole live output, still growing.
      await page.eval((n) => [...document.querySelectorAll('#chat .line.tool')][n].querySelector('.row').click(), before);
      await page.waitFor((n) => /compile modul-/.test([...document.querySelectorAll('#chat .line.tool')][n].querySelector('[data-live-out]')?.textContent ?? ''), { timeoutMs: 4000, message: 'blok output live terbuka' }, before);
      const len = await page.eval((n) => [...document.querySelectorAll('#chat .line.tool')][n].querySelector('[data-live-out]').textContent.length, before);
      await page.waitFor((n, l) => ([...document.querySelectorAll('#chat .line.tool')][n].querySelector('[data-live-out]')?.textContent.length ?? Infinity) > l, { timeoutMs: 5000, message: 'output live bertambah' }, before, len);
      assert.equal(await page.eval(horizontalOverflow), null, 'output live tanpa scroll horizontal');
      // Done: the final output (tool_result) replaces the live block; no more reads.
      await page.waitFor((n) => [...document.querySelectorAll('#chat .line.tool')][n].classList.contains('st-ok'), { timeoutMs: 12000, message: 'perintah selesai' }, before);
      const done = await page.eval((n) => {
        const r = [...document.querySelectorAll('#chat .line.tool')][n];
        return { live: Boolean(r.querySelector('[data-live-out], .live-tail')), out: r.querySelector('pre.out')?.textContent ?? '' };
      }, before);
      assert.equal(done.live, false, 'blok live hilang setelah selesai');
      assert.match(done.out, /\[16\/16\][\s\S]*Build selesai\./);
      const calls = await page.eval(() => window.__liveCalls);
      assert.ok(calls >= 2, `task-output dibaca ${calls}x`);
      await sleep(3500);
      assert.equal(await page.eval(() => window.__liveCalls), calls, 'polling berhenti setelah perintah selesai');
      assert.deepEqual(realProblems(page), []);
    });

    test('📄 penampil file: dari path di jawaban (:line disorot), baris tool Read, tab Perubahan; cari, escape, rapi', async () => {
      page.clearProblems();
      const proj = path.join(TMP, 'projects', 'toko');
      writeFileSync(path.join(proj, 'src', 'app.js'), 'const a = 1;\n/* multi\nbaris */\n<b>tebal</b>\nconst b = "nilai";\n');
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      await page.eval(() => document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)));
      const before = await page.eval(() => document.querySelectorAll('#chat .msg.assistant').length);
      await page.eval(async (pid) => {
        const token = document.querySelector('meta[name="office-token"]').content;
        await fetch(`/api/projects/${pid}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify({ text: 'sebut file' }) });
      }, projectId);
      await page.waitFor((n) => document.querySelectorAll('#chat .msg.assistant').length > n && [...document.querySelectorAll('#chat .msg.assistant')].at(-1).querySelector('.file-link[data-file="src/app.js"]'), { timeoutMs: 8000, message: 'path di jawaban jadi link' }, before);
      const links = await page.eval(() => [...[...document.querySelectorAll('#chat .msg.assistant')].at(-1).querySelectorAll('.file-link')].map((b) => [b.dataset.file, b.dataset.line ?? null]));
      assert.deepEqual(links, [['src/checkout.ts', '2'], ['src/app.js', '3'], ['src/hilang.ts', null]], 'URL tidak ikut jadi link');

      // From the answer, with :line
      await page.eval(() => [...document.querySelectorAll('#chat .msg.assistant')].at(-1).querySelector('.file-link[data-file="src/app.js"]').click());
      await page.waitFor(() => document.querySelector('#fv-code .fv-l'), { timeoutMs: 5000, message: 'penampil terbuka dengan isi' });
      const view = await page.eval(() => ({
        title: document.querySelector('#fv-title').textContent,
        meta: document.querySelector('#fv-meta').textContent,
        target: [...document.querySelectorAll('#fv-code .fv-l.target')].map((l) => l.dataset.n),
        carried: Boolean(document.querySelector('#fv-code .fv-l[data-n="3"] .hl-c')),
        injected: document.querySelectorAll('#fv-code b').length,
        line4: document.querySelector('#fv-code .fv-l[data-n="4"] .fv-t').textContent,
        targetVisible: (() => {
          const box = document.querySelector('#fv-code').getBoundingClientRect();
          const r = document.querySelector('#fv-code .fv-l.target').getBoundingClientRect();
          return r.top >= box.top && r.bottom <= box.bottom;
        })(),
        focusInside: document.querySelector('#file-modal').contains(document.activeElement),
      }));
      assert.match(view.title, /app\.js/);
      assert.match(view.meta, /byte · diubah .* · js · 5 baris/);
      assert.deepEqual(view.target, ['3'], 'baris :3 disorot');
      assert.equal(view.carried, true, 'komentar multi-baris tetap ter-highlight di baris berikutnya');
      assert.equal(view.injected, 0, 'isi file tidak pernah dirender sebagai HTML');
      assert.equal(view.line4, '<b>tebal</b>');
      assert.equal(view.targetVisible, true, 'baris tujuan terlihat');
      assert.equal(view.focusInside, true, 'fokus di dalam penampil');
      assert.equal(await page.eval(horizontalOverflow), null, 'penampil tanpa scroll horizontal halaman');
      assert.deepEqual(await page.eval(unnamedButtons, '#file-modal'), []);
      // Ctrl+F searches the file
      await page.eval(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })));
      assert.equal(await page.eval(() => document.activeElement.id), 'fv-q', 'Ctrl+F ke kotak cari');
      await page.send('Input.insertText', { text: 'NILAI' });
      await page.waitFor(() => document.querySelector('#fv-count').textContent === '1/1', { timeoutMs: 2000, message: 'hasil pencarian' });
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll('#fv-code mark')].map((m) => m.textContent)), ['nilai']);
      await page.press('Escape');
      assert.equal(await page.eval(() => document.querySelector('#file-modal').hidden), true, 'Esc menutup');

      // A missing file says so
      await page.eval(() => [...document.querySelectorAll('#chat .msg.assistant')].at(-1).querySelector('.file-link[data-file="src/hilang.ts"]').click());
      await page.waitFor(() => /tidak ditemukan/.test(document.querySelector('#fv-body .state-error')?.textContent ?? ''), { timeoutMs: 4000, message: 'file hilang: pesan rapi' });
      await page.press('Escape');
      // The 404 itself is the expected answer (logged by the browser as a failed request), nothing else.
      assert.deepEqual(realProblems(page).filter((p) => !/\/file\b/.test(p.text)), []);
      page.clearProblems();

      // From a Read row (absolute path in the tool input)
      await page.eval(() => [...document.querySelectorAll('#chat .line.tool')].reverse().find((r) => /checkout\.ts/.test(r.textContent)).querySelector('.row').click());
      await page.waitFor(() => [...document.querySelectorAll('#chat .line.tool.open .file-link')].some((b) => /checkout\.ts$/.test(b.dataset.file)), { timeoutMs: 3000, message: 'path di baris Read' });
      await page.eval(() => [...document.querySelectorAll('#chat .line.tool.open .file-link')].reverse().find((b) => /checkout\.ts$/.test(b.dataset.file)).click());
      await page.waitFor(() => /checkout\.ts/.test(document.querySelector('#fv-title').textContent) && document.querySelector('#fv-code .fv-l'), { timeoutMs: 4000, message: 'penampil dari baris Read' });
      assert.equal(await page.eval(() => /^export /.test(document.querySelector('#fv-code .fv-t').textContent)), true, 'isi checkout.ts');
      await page.press('Escape');

      // From the Changes tab (the project becomes a git repo with one changed file)
      if (!existsSync(path.join(proj, '.git'))) {
        const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: proj, stdio: 'ignore' });
        git('init', '-q');
        git('add', '-A');
        git('commit', '-qm', 'awal');
      }
      writeFileSync(path.join(proj, 'src', 'checkout.ts'), `export const total = ${Date.now()};\n`);
      if (vp.mobile) await page.click('#mobile-nav [data-view="changes"]');
      else await page.click('.tabs button[data-tab="changes"]');
      await page.click('#ch-refresh');
      await page.waitFor(() => [...document.querySelectorAll('#ch-files li[data-path]')].some((li) => li.dataset.path === 'src/checkout.ts'), { timeoutMs: 6000, message: 'file berubah di tab Perubahan' });
      await page.eval(() => [...document.querySelectorAll('#ch-files li[data-path]')].find((li) => li.dataset.path === 'src/checkout.ts').click());
      assert.equal(await page.eval(horizontalOverflow), null, 'tab Perubahan tanpa scroll horizontal');
      await page.click('#ch-view');
      await page.waitFor(() => /export const total/.test(document.querySelector('#fv-code')?.textContent ?? ''), { timeoutMs: 4000, message: 'penampil dari tab Perubahan' });
      assert.equal(await page.eval(horizontalOverflow), null);
      await page.press('Escape');
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      else await page.click('.tabs button[data-tab="chat"]');
      assert.deepEqual(realProblems(page), []);
    });

    test('🛡️ Aturan izin + ⎇ git di tab Perubahan: tampil rapi, validasi, tanpa error console/overflow', async (t) => {
      await openApp(page, `#${projectId}`);
      page.clearProblems();
      const proj = path.join(TMP, 'projects', 'toko');
      const shot = async (name) => {
        // OFFICE_UI_SHOTS=<dir>: keep screenshots to look at (never written otherwise)
        if (process.env.OFFICE_UI_SHOTS) writeFileSync(path.join(process.env.OFFICE_UI_SHOTS, `${name}-${vp.mobile ? 'mobile' : 'desktop'}.png`), await page.screenshot());
      };
      // Rules as "Izinkan selalu" stores them, next to other keys that must survive an edit
      const local = path.join(proj, '.claude', 'settings.local.json');
      t.after(() => rmSync(path.join(proj, '.claude'), { recursive: true, force: true }));
      mkdirSync(path.dirname(local), { recursive: true });
      writeFileSync(local, JSON.stringify({ permissions: { allow: ['Bash(npm run test:*)', 'Read(src/**)'], deny: ['Bash(curl *)'] }, env: { KEEP: '1' } }, null, 2));

      // opened from ⋯ (on every device; ⚙ is the laptop's other way in, /permissions the third)
      await page.click('#btn-more');
      await page.click('#more-menu [data-more="permissions"]');
      await page.waitFor(() => document.querySelectorAll('#perm-list .perm-rules li').length === 3, { timeoutMs: 4000, message: 'aturan tampil' });
      const perm = await page.eval(() => ({
        scopes: [...document.querySelectorAll('#perm-list .perm-scope-head b')].map((b) => b.textContent),
        rules: [...document.querySelectorAll('#perm-list .perm-rules li code')].map((c) => c.textContent),
        addVisible: Boolean(document.querySelector('#perm-add').getClientRects().length),
        roHidden: document.querySelector('#perm-ro').hidden,
        focusInside: document.querySelector('#perm-modal').contains(document.activeElement),
      }));
      assert.deepEqual(perm, { scopes: ['Project lokal', 'Project bersama', 'User'], rules: ['Bash(npm run test:*)', 'Read(src/**)', 'Bash(curl *)'], addVisible: true, roHidden: true, focusInside: true });
      assert.equal(await page.eval(horizontalOverflow), null, 'dialog aturan izin tanpa scroll horizontal');
      assert.deepEqual(await page.eval(unnamedButtons, '#perm-modal'), []);
      // a malformed rule is caught in place, nothing is sent
      await page.eval(() => (document.querySelector('#perm-add-rule').value = 'Bash('));
      await page.click('#perm-add button.primary');
      assert.match(await page.eval(() => document.querySelector('#perm-add-error').textContent), /Format/);
      await page.eval(() => (document.querySelector('#perm-add-rule').value = 'WebFetch(domain:example.com)'));
      await page.click('#perm-add button.primary');
      await page.waitFor(() => [...document.querySelectorAll('#perm-list .perm-rules code')].some((c) => c.textContent === 'WebFetch(domain:example.com)'), { timeoutMs: 4000, message: 'aturan baru tampil' });
      assert.deepEqual(JSON.parse(readFileSync(local, 'utf8')).env, { KEEP: '1' }, 'key lain di file tetap ada');
      assert.equal(await page.eval(() => document.querySelector('#perm-add-error').textContent), '');
      await shot('perm');
      await page.press('Escape');
      assert.equal(await page.eval(() => document.querySelector('#perm-modal').hidden), true);

      // ⎇ git bar: the project is a git repo (made by the file viewer test above, or here)
      if (!existsSync(path.join(proj, '.git'))) {
        const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: proj, stdio: 'ignore' });
        git('init', '-q');
        git('add', '-A');
        git('commit', '-qm', 'awal');
      }
      if (vp.mobile) await page.click('#mobile-nav [data-view="changes"]');
      else await page.click('.tabs button[data-tab="changes"]');
      await page.click('#ch-refresh');
      await page.waitFor(() => !document.querySelector('#ch-git').hidden && document.querySelector('#ch-git-select').options.length > 0 && document.querySelector('#ch-git-sync').textContent.trim(), { timeoutMs: 6000, message: 'bar git tampil' });
      const bar = await page.eval(() => ({
        branch: document.querySelector('#ch-git-select').value,
        sync: document.querySelector('#ch-git-sync').textContent.trim(),
        enabled: ['#ch-git-new', '#ch-git-pr', '#ch-git-select'].filter((s) => !document.querySelector(s).disabled),
        // no remote here: nothing to fetch/pull/push
        disabled: ['#ch-git-fetch', '#ch-git-pull', '#ch-git-push'].filter((s) => document.querySelector(s).disabled),
      }));
      assert.ok(bar.branch, 'branch saat ini terpilih');
      assert.equal(bar.sync, 'tanpa remote');
      assert.deepEqual(bar.enabled, ['#ch-git-new', '#ch-git-pr', '#ch-git-select']);
      assert.deepEqual(bar.disabled, ['#ch-git-fetch', '#ch-git-pull', '#ch-git-push']);
      assert.equal(await page.eval(horizontalOverflow), null, 'tab Perubahan + bar git tanpa scroll horizontal');
      assert.deepEqual(await page.eval(unnamedButtons, '#changes'), []);
      // ＋ Branch: a name with a space is caught before it is sent; a server refusal shows git's message in the panel
      await page.click('#ch-git-new');
      await page.waitFor(() => document.activeElement?.id === 'ch-git-name', { timeoutMs: 2000, message: 'fokus di nama branch' });
      await page.eval(() => (document.querySelector('#ch-git-name').value = 'ada spasi'));
      await page.click('#ch-git-create button.primary');
      assert.match(await page.eval(() => document.querySelector('#ch-git-name-error').textContent), /spasi/);
      await page.eval(() => (document.querySelector('#ch-git-name').value = 'a.lock'));
      await page.click('#ch-git-create button.primary');
      await page.waitFor(() => document.querySelector('#ch-git-out.err') && !document.querySelector('#ch-git-out').hidden, { timeoutMs: 4000, message: 'pesan penolakan git' });
      assert.match(await page.eval(() => document.querySelector('#ch-git-text').textContent), /ditolak git|tidak valid/);
      assert.equal(await page.eval(horizontalOverflow), null);
      await shot('git');
      await page.click('#ch-git-create-cancel');
      await page.click('#ch-git-out-close');
      // 🤖 PR: the prompt lands in the composer, not sent
      const users = await page.eval(() => document.querySelectorAll('#chat .msg.user, #chat [data-kind="user"]').length);
      await page.click('#ch-git-pr');
      await page.waitFor(() => /pull request/.test(document.querySelector('#prompt').value), { timeoutMs: 2000, message: 'prompt PR di kotak pesan' });
      assert.match(await page.eval(() => document.querySelector('#prompt').value), new RegExp(`branch \`${bar.branch}\``));
      assert.equal(await page.eval(() => document.querySelectorAll('#chat .msg.user, #chat [data-kind="user"]').length), users, 'tidak terkirim');
      await typeInPrompt(page, '');
      // The refused branch name (400) is the expected answer, logged by the browser as a failed request; nothing else.
      assert.deepEqual(realProblems(page).filter((p) => !/\/git-action\b/.test(p.text)), []);
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
        controls: ['#btn-send', '#btn-attach', '#btn-template', '#mode', '#model', '#effort', '#team-mode', '#btn-new', '#ch-review', '#ch-commit button', '#ch-git-select', '#ch-git-new', '#ch-git-fetch', '#ch-git-pull', '#ch-git-push', '#ch-git-pr'].filter((sel) => !dis(sel)),
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

// ---------- live chat: bubbles stay filled (restart with stored chats, desync, finished-but-empty) ----------

describe('UI chat live', { skip: SKIP ?? false }, () => {
  let page;
  const OLD = 120; // all within the 150 messages a snapshot carries, so every old bubble is on the page
  const api = async (p, body = {}) => {
    const token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
    return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then((r) => r.json());
  };
  const bubbles = () => page.eval(() => [...document.querySelectorAll('#chat .msg.assistant')].map((n) => n.querySelector('.body').textContent));

  before(async () => {
    if (SKIP) return;
    // A previous server run left a chat behind (ids m1…m120). The restarted server must not hand out
    // those ids again: the browser finds a bubble by id, so a reused id paints the new reply onto an old bubble.
    await stopServer();
    const file = path.join(TMP, 'data', 'state.json');
    let saved = {};
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // nothing saved yet
    }
    const old = Array.from({ length: OLD }, (_, i) => ({ id: `m${i + 1}`, ts: Date.now() - 86400000, project: projectId, kind: 'assistant', text: `jawaban lama ${i + 1}` }));
    writeFileSync(file, JSON.stringify({ ...saved, chats: { ...saved.chats, [projectId]: old } }));
    await startServer();
    page = await browser.newPage();
    await page.setViewport(VIEWPORTS[1]);
    await openApp(page, `#${projectId}`);
  });
  after(async () => page?.close());

  test('setelah server restart: balasan baru tampil berisi di bubble baru, bubble lama tidak tertimpa', async () => {
    await api(`/api/projects/${projectId}/prompt`, { text: 'halo setelah restart' });
    await page.waitFor(() => document.querySelector('#chat .result.ok'), { timeoutMs: 10000, message: 'giliran selesai (baris hasil)' });
    await sleep(300);
    const all = await bubbles();
    assert.deepEqual(await page.eval(() => document.querySelectorAll('#chat .msg.assistant.streaming').length), 0, `masih "mengetik" setelah selesai; 3 bubble terakhir: ${JSON.stringify(all.slice(-3))}`);
    assert.match(all.at(-1), /Halo dari Claude palsu yang sedang mengetik\./, 'bubble terakhir berisi balasan');
    assert.equal(all.filter((t) => !t.trim()).length, 0, 'tidak ada bubble kosong');
    const oldShown = all.filter((t) => /^jawaban lama \d+$/.test(t));
    assert.deepEqual(oldShown, Array.from({ length: OLD }, (_, i) => `jawaban lama ${i + 1}`), 'bubble lama tetap utuh');
    // What the page shows equals what a fresh load shows.
    await openApp(page, `#${projectId}`);
    assert.deepEqual(await bubbles(), all);
  });

  test('bubble assistant selesai tapi kosong (atau hanya spasi) tidak ditampilkan', async () => {
    const shown = await page.eval(async () => {
      const { appendChat } = await import('/js/features/chat.js');
      const probe = (msg) => {
        appendChat({ id: `probe-${Math.random()}`, ts: Date.now(), kind: 'assistant', ...msg }, false);
        const node = document.querySelector('#chat').lastElementChild;
        const visible = node.getClientRects().length > 0;
        node.remove();
        return visible;
      };
      return { empty: probe({ text: '', streaming: false }), blank: probe({ text: '\n\n ', streaming: false }), streaming: probe({ text: '', streaming: true }) };
    });
    assert.deepEqual(shown, { empty: false, blank: false, streaming: true });
  });

  test('update untuk pesan yang tak dikenal klien → sinkron ulang dari server (tidak dibuang)', async () => {
    // Simulates a missed `chat` event: the newest reply is gone from the page's state and DOM, then an update for it arrives.
    const r = await page.eval(async () => {
      const { state } = await import('/js/core/state.js');
      const { onChatUpdate } = await import('/js/core/stream.js');
      const list = state.chats[state.active];
      const lost = list.findLast((m) => m.kind === 'assistant');
      list.splice(list.indexOf(lost), 1);
      document.querySelector(`#chat [data-id="${lost.id}"]`)?.remove();
      onChatUpdate({ project: state.active, id: lost.id, patch: { text: lost.text, streaming: false } });
      const end = Date.now() + 5000;
      while (Date.now() < end && !document.querySelector(`#chat [data-id="${lost.id}"]`)) await new Promise((res) => setTimeout(res, 50));
      const node = document.querySelector(`#chat [data-id="${lost.id}"]`);
      return { back: Boolean(node), text: node?.textContent ?? '', inState: state.chats[state.active].some((m) => m.id === lost.id) };
    });
    assert.equal(r.back, true, 'pesan muncul lagi');
    assert.match(r.text, /Halo dari Claude palsu/);
    assert.equal(r.inState, true);
    await page.waitFor(appReady, { timeoutMs: 5000, message: 'tetap terhubung' });
    assert.deepEqual(realProblems(page), []);
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

// ---------- Ctrl+P command palette, 🔎 search conversations, ⬇ export .md ----------

/** Trusted key press with modifiers (Ctrl+P, arrows), which page.press doesn't do. */
async function keyCombo(page, key, { ctrl = false, shift = false } = {}) {
  const vk = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27 }[key] ?? key.toUpperCase().charCodeAt(0);
  const params = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: (ctrl ? 2 : 0) | (shift ? 8 : 0) };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

/** Opens the palette with Ctrl+P and types `text` into it (trusted input events). */
async function paletteType(page, text) {
  await page.eval(() => document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)));
  await keyCombo(page, 'p', { ctrl: true });
  await page.waitFor(() => !document.querySelector('#palette-modal').hidden && document.activeElement?.id === 'palette-input', { timeoutMs: 2000, message: 'palet terbuka, fokus di input' });
  if (text) await page.send('Input.insertText', { text });
}

const activeOption = (page) =>
  page.eval(() => {
    const input = document.querySelector('#palette-input');
    const opt = document.getElementById(input.getAttribute('aria-activedescendant'));
    return opt ? { label: opt.querySelector('.pal-label').textContent, marked: [...opt.querySelectorAll('mark')].map((m) => m.textContent).join(''), selected: opt.getAttribute('aria-selected') } : null;
  });

/** Captures what saveBlob downloads (anchor click on a blob: URL) instead of saving a file. */
function captureDownloads() {
  window.__downloads = [];
  const blobs = new Map(); // blob: URL -> Blob (CSP connect-src would refuse fetching the blob: URL back)
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const url = create(blob);
    blobs.set(url, blob);
    return url;
  };
  window.HTMLAnchorElement.prototype.click = function () {
    const blob = this.download && blobs.get(this.href);
    if (blob) blob.text().then((text) => window.__downloads.push({ name: this.download, text }));
  };
}

for (const vp of VIEWPORTS) {
  describe(`UI palet perintah & cari percakapan — ${vp.name}`, { skip: SKIP ?? false }, () => {
    let page;
    let sid;
    before(async () => {
      if (SKIP) return;
      // A transcript of the toko project to search and export (the folder Claude Code itself would use).
      const project = (await snapshot()).projects.find((p) => p.id === projectId);
      const dir = path.join(TMP, 'claude-projects', path.resolve(project.path).replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(dir, { recursive: true });
      sid = vp.mobile ? 'aaaaaaaa-1111-4222-8333-444444444444' : 'bbbbbbbb-1111-4222-8333-444444444444';
      const ts = new Date(Date.now() - 3600_000).toISOString();
      const lines = [
        { type: 'user', promptSource: 'typed', sessionId: sid, timestamp: ts, message: { role: 'user', content: 'Perbaiki alur Pembayaran <img src=x onerror="window.__xss=1"> di checkout' } },
        { type: 'assistant', sessionId: sid, timestamp: ts, message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'PIKIRAN-RAHASIA' }, { type: 'text', text: 'Modul pembayaran sudah saya perbaiki.' }] } },
        { type: 'custom-title', customTitle: `Bug pembayaran ${vp.mobile ? 'HP' : 'laptop'}` },
      ];
      writeFileSync(path.join(dir, `${sid}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
      page = await browser.newPage();
      await page.setViewport(vp);
      await openApp(page, `#${projectId}`);
      await page.eval(() => localStorage.removeItem('office.palette.recent'));
      await page.eval(captureDownloads);
    });
    after(async () => page?.close());

    test('Ctrl+P membuka palet (combobox/listbox), ↓ dan Esc; Ctrl+K tetap pemilih project', async () => {
      page.clearProblems();
      await paletteType(page, '');
      const a11y = await page.eval(() => {
        const input = document.querySelector('#palette-input');
        return {
          role: input.getAttribute('role'),
          controls: input.getAttribute('aria-controls'),
          listRole: document.querySelector('#palette-list').getAttribute('role'),
          active: Boolean(document.getElementById(input.getAttribute('aria-activedescendant'))),
          groups: [...document.querySelectorAll('#palette-list .pal-group-head')].map((g) => g.textContent),
        };
      });
      const { groups, ...roles } = a11y;
      assert.deepEqual(roles, { role: 'combobox', controls: 'palette-list', listRole: 'listbox', active: true });
      for (const g of ['Project', 'Chat', 'Buka', 'Tema', 'Perintah']) assert.ok(groups.includes(g), `grup ${g}: ${groups.join(', ')}`);
      assert.equal(await page.eval(horizontalOverflow), null, 'palet tanpa scroll horizontal');
      assert.deepEqual(await page.eval(unnamedButtons, '#palette-modal'), []);
      const first = await activeOption(page);
      await keyCombo(page, 'ArrowDown');
      const second = await activeOption(page);
      assert.notEqual(second.label, first.label, '↓ pindah pilihan');
      assert.equal(second.selected, 'true');
      await page.press('Escape');
      assert.equal(await page.eval(() => document.querySelector('#palette-modal').hidden), true, 'Esc menutup');
      // Ctrl+K is untouched
      await keyCombo(page, 'k', { ctrl: true });
      await page.waitFor(() => !document.querySelector('#project-modal').hidden, { timeoutMs: 2000, message: 'Ctrl+K membuka pemilih project' });
      assert.equal(await page.eval(() => document.querySelector('#palette-modal').hidden), true, 'palet tidak ikut terbuka');
      await page.press('Escape');
      // Ctrl+Shift+P: straight to commands
      await keyCombo(page, 'P', { ctrl: true, shift: true });
      await page.waitFor(() => document.querySelector('#palette-input').value === '>' && !document.querySelector('#palette-scope').hidden, { timeoutMs: 2000, message: 'Ctrl+Shift+P → prefix >' });
      await page.press('Escape');
      assert.deepEqual(realProblems(page), []);
    });

    test('fuzzy + Enter: pindah project (#), buka file (@), buka dialog, ganti tema, riwayat aksi', async () => {
      page.clearProblems();
      await paletteType(page, '#demo');
      await page.waitFor(() => /Demo/.test((document.querySelector('#palette-list .pal-opt.active .pal-label')?.textContent ?? '')), { timeoutMs: 2000, message: 'Demo terpilih' });
      assert.match((await activeOption(page)).marked, /demo/i, 'huruf yang cocok di-highlight');
      await page.press('Enter');
      await page.waitFor(() => location.hash === '#demo' && document.querySelector('#palette-modal').hidden, { timeoutMs: 2000, message: 'pindah ke demo' });
      await paletteType(page, 'tko'); // fuzzy: t…k…o
      await page.waitFor(() => (document.querySelector('#palette-list .pal-opt.active .pal-label')?.textContent ?? '') === 'toko', { timeoutMs: 2000, message: 'toko (fuzzy) di urutan pertama' });
      assert.equal((await activeOption(page)).marked, 'tko');
      await page.press('Enter');
      await page.waitFor((id) => location.hash === `#${id}`, { timeoutMs: 2000, message: 'kembali ke toko' }, projectId);

      // @ file: the project's file index → the file viewer
      await paletteType(page, '@checkout');
      await page.waitFor(() => (document.querySelector('#palette-list .pal-opt.active .pal-label')?.textContent ?? '') === 'src/checkout.ts', { timeoutMs: 4000, message: 'file ditemukan' });
      await page.press('Enter');
      await page.waitFor(() => !document.querySelector('#file-modal').hidden && /checkout\.ts/.test(document.querySelector('#fv-title').textContent), { timeoutMs: 4000, message: 'penampil file terbuka' });
      await page.press('Escape');

      // a dialog by a fuzzy name
      await paletteType(page, 'pngtrn');
      await page.waitFor(() => (document.querySelector('#palette-list .pal-opt.active .pal-label')?.textContent ?? '') === 'Pengaturan', { timeoutMs: 2000, message: 'Pengaturan (fuzzy)' });
      await page.press('Enter');
      await page.waitFor(() => !document.querySelector('#settings-modal').hidden && document.querySelector('#palette-modal').hidden, { timeoutMs: 2000, message: 'Pengaturan terbuka' });
      await page.press('Escape');

      // theme, then back; the last action is listed first next time
      await paletteType(page, 'halloween');
      await page.press('Enter');
      await page.waitFor(() => document.documentElement.dataset.officeTheme === 'halloween', { timeoutMs: 2000, message: 'tema halloween' });
      await paletteType(page, 'tema kantor');
      await page.press('Enter');
      await page.waitFor(() => document.documentElement.dataset.officeTheme === 'kantor', { timeoutMs: 2000, message: 'tema kantor' });
      await paletteType(page, '');
      const recent = await page.eval(() => ({ head: document.querySelector('#palette-list .pal-group-head')?.textContent, first: document.querySelector('#palette-list .pal-opt .pal-label')?.textContent }));
      assert.deepEqual(recent, { head: 'Terakhir dipakai', first: 'Tema: Kantor' });
      await page.press('Escape');
      assert.deepEqual(realProblems(page), []);
    });

    test('🔎 cari percakapan: cuplikan ber-highlight (teks di-escape), validasi, export .md terunduh', async () => {
      page.clearProblems();
      await paletteType(page, 'cari percakapan');
      await page.press('Enter');
      await page.waitFor(() => !document.querySelector('#search-modal').hidden, { timeoutMs: 2000, message: 'dialog cari terbuka' });
      // Desktop: focus is in the search box at once; a phone waits for a tap (no keyboard popping up unasked).
      if (vp.mobile) await page.click('#search-q');
      assert.equal(await page.eval(() => document.activeElement?.id), 'search-q');
      await page.send('Input.insertText', { text: 'a' });
      await page.press('Enter');
      assert.match(await page.eval(() => document.querySelector('#search-error').textContent), /minimal 2 huruf/);
      await page.eval(() => (document.querySelector('#search-q').value = ''));
      await page.send('Input.insertText', { text: 'PEMBAYARAN' });
      await page.press('Enter');
      await page.waitFor((id) => [...document.querySelectorAll('#search-results .sr-item')].filter((li) => li.textContent.includes(id.slice(0, 8))).length >= 2, { timeoutMs: 4000, message: 'hasil pencarian' }, sid);
      const r = await page.eval(() => ({
        marks: [...document.querySelectorAll('#search-results mark')].map((m) => m.textContent),
        text: document.querySelector('#search-results').textContent,
        img: document.querySelectorAll('#search-results img').length,
        xss: window.__xss ?? null,
        status: document.querySelector('#search-status').textContent,
        invalid: document.querySelector('#search-q').getAttribute('aria-invalid'),
      }));
      assert.ok(r.marks.length && r.marks.every((m) => m.toLowerCase() === 'pembayaran'), r.marks.join(','));
      assert.match(r.text, /<img src=x/, 'teks tampil apa adanya');
      assert.equal(r.img, 0);
      assert.equal(r.xss, null);
      assert.ok(!r.text.includes('PIKIRAN-RAHASIA'), 'thinking tidak ikut dicari');
      assert.match(r.status, /hasil/);
      assert.equal(r.invalid, null);
      assert.equal(await page.eval(horizontalOverflow), null, 'dialog cari tanpa scroll horizontal');
      assert.deepEqual(await page.eval(unnamedButtons, '#search-modal'), []);
      await page.eval(() => (window.__downloads = []));
      await page.eval((id) => [...document.querySelectorAll('#search-results .sr-item')].find((li) => li.textContent.includes(id.slice(0, 8))).querySelector('.s-export').click(), sid);
      await page.waitFor(() => window.__downloads.length === 1, { timeoutMs: 4000, message: 'export terunduh' });
      const dl = await page.eval(() => window.__downloads[0]);
      assert.match(dl.name, /^bug-pembayaran-(hp|laptop)-[0-9a-f]{8}\.md$/);
      assert.match(dl.text, /^# Bug pembayaran/);
      assert.match(dl.text, /## 🧑 Kamu/);
      assert.match(dl.text, /Modul pembayaran sudah saya perbaiki\./);
      assert.ok(!dl.text.includes('PIKIRAN-RAHASIA'), 'tanpa thinking');
      await page.press('Escape');
      assert.deepEqual(realProblems(page), []);
    });

    test('⬇ export dari Riwayat sesi; /export tanpa sesi aktif memberi pesan jelas', async () => {
      page.clearProblems();
      await page.eval(() => {
        document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
        window.__downloads = [];
      });
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      await page.click('#btn-sessions');
      await page.waitFor((id) => document.querySelector(`#sessions-list [data-export="${id}"]`), { timeoutMs: 4000, message: 'tombol export di riwayat' }, sid);
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(await page.eval(unnamedButtons, '#sessions-modal'), []);
      await page.eval((id) => document.querySelector(`#sessions-list [data-export="${id}"]`).click(), sid);
      await page.waitFor(() => window.__downloads.length === 1, { timeoutMs: 4000, message: 'export dari riwayat' });
      await page.press('Escape');
      // /export: the session the chat continues. Earlier tests may or may not have started one, so both paths
      // are checked deterministically: with a session its transcript is exported, without one a clear message.
      const snap = await snapshot();
      const live = snap.statuses[projectId]?.sessionId;
      if (live) {
        const project = snap.projects.find((p) => p.id === projectId);
        const dir = path.join(TMP, 'claude-projects', path.resolve(project.path).replace(/[^a-zA-Z0-9]/g, '-'));
        const line = { type: 'user', promptSource: 'typed', sessionId: live, timestamp: new Date().toISOString(), message: { role: 'user', content: 'EKSPOR-SESI-AKTIF' } };
        writeFileSync(path.join(dir, `${live}.jsonl`), `${JSON.stringify(line)}\n`, { flag: 'a' });
      }
      await typeInPrompt(page, '/export');
      await page.eval(() => document.querySelector('#btn-send').click());
      if (live) {
        await page.waitFor(() => window.__downloads.length === 2, { timeoutMs: 4000, message: '/export mengunduh sesi aktif' });
        assert.match(await page.eval(() => window.__downloads[1].text), /EKSPOR-SESI-AKTIF/);
      } else {
        await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Belum ada sesi/.test(t.textContent)), { timeoutMs: 2000, message: 'pesan "belum ada sesi"' });
        assert.equal(await page.eval(() => window.__downloads.length), 1);
      }
      assert.deepEqual(realProblems(page), []);
    });

    if (vp.mobile) {
      test('HP: tombol 🔎 di navigasi bawah membuka palet, tanpa overflow', async () => {
        page.clearProblems();
        await page.eval(() => document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)));
        assert.equal(await page.eval(horizontalOverflow), null, 'topbar dengan 🔎 tanpa overflow');
        assert.equal(await page.eval(() => document.querySelector('#btn-palette').getClientRects().length), 0, '🔎 tidak di topbar HP');
        await page.click('#nav-palette');
        await page.waitFor(() => !document.querySelector('#palette-modal').hidden, { timeoutMs: 2000, message: 'palet terbuka lewat 🔎' });
        assert.equal(await page.eval(horizontalOverflow), null);
        await page.press('Escape');
        assert.deepEqual(realProblems(page), []);
      });
    }
  });
}
