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
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'), // never the real Tailscale CLI
      OFFICE_GH_BIN: path.join(TMP, 'fake-gh.mjs'), // never the real GitHub CLI (or its login): always "not logged in"
      PROJECTS_ROOT: path.join(TMP, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'), // user-level settings.json (🛡️ Aturan izin), never the real ~/.claude
      OFFICE_OPEN_DRY_RUN: '1',
      OFFICE_EFFORT_FAKE: 'high', // Effort Auto tests never spawn a real classifier
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
  // gh installed but not logged in: `gh auth status` fails (the PR dialog shows its login, the form stays hidden)
  writeFileSync(path.join(TMP, 'fake-gh.mjs'), "process.stderr.write('You are not logged into any GitHub hosts.\\n');\nprocess.exit(1);\n");
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

/**
 * ♿ Audit of what is visible right now: unnamed controls, unlabeled fields, images without `alt`, duplicate ids,
 * ARIA references to missing ids and targets smaller than 24×24 px. Returns one line per problem (empty = clean).
 */
function a11yAudit() {
  const problems = [];
  const visible = (el) => el.getClientRects().length > 0 && !el.closest('[hidden]') && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const refText = (el, attr) => (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  const label = (el) => el.getAttribute('aria-label') || refText(el, 'aria-labelledby') || el.getAttribute('title') || '';
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${String(el.className).trim().split(/\s+/)[0]}` : ''} "${text(el).slice(0, 40)}"`;

  for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="option"], [role="checkbox"]')) {
    if (!visible(el)) continue;
    if (!(label(el) || text(el)).trim()) problems.push(`kontrol tanpa nama: ${describe(el)}`);
  }

  for (const el of document.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
    if (!visible(el)) continue;
    const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const named = label(el) || (byFor && text(byFor)) || (el.closest('label') && text(el.closest('label')));
    if (!(named ?? '').trim()) problems.push(`field tanpa label: ${describe(el)}`);
  }

  for (const img of document.querySelectorAll('img')) {
    if (visible(img) && !img.hasAttribute('alt')) problems.push(`img tanpa alt: ${img.getAttribute('src')}`);
  }

  const ids = new Map();
  for (const el of document.querySelectorAll('[id]')) {
    if (!visible(el)) continue;
    if (ids.has(el.id)) problems.push(`id ganda: #${el.id}`);
    ids.set(el.id, el);
  }

  for (const el of document.querySelectorAll('[aria-controls], [aria-labelledby], [aria-describedby], [aria-owns]')) {
    if (!visible(el)) continue;
    for (const attr of ['aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns']) {
      for (const id of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(id)) problems.push(`${attr} → #${id} tidak ada: ${describe(el)}`);
      }
    }
  }

  // WCAG 2.2 target size (minimum): 24×24 CSS px. A checkbox/radio inside its label is hit through the label;
  // an inline text link/button is exempt (the "inline" exception), and its padding would break the line flow.
  for (const el of document.querySelectorAll('button, input:not([type="hidden"]), select, textarea, [role="button"]')) {
    if (!visible(el) || (el.tagName === 'INPUT' && el.closest('label'))) continue;
    if (el.matches('.file-link') || getComputedStyle(el).display === 'inline') continue; // inline text link: WCAG exception
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) problems.push(`target < 24px: ${describe(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
  }
  return problems;
}

/**
 * ⚖ WCAG contrast of the visible text: each element with its own text node, its computed color and the effective
 * background from its ancestors (images/gradients/zero-opacity are skipped: not measurable). 4.5:1, or 3:1 for
 * large text (≥24 px, or ≥18.66 px bold). Returns "…ratio:1" lines for everything below the bar.
 */
function contrastProblems() {
  const parse = (c) => {
    const m = /^rgba?\(([^)]+)\)$/.exec(String(c).trim());
    if (!m) return null;
    const p = m[1].split(/[,/]\s*/).map((x) => Number(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 && Number.isFinite(p[3]) ? p[3] : 1 };
  };
  const channel = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const rootBg = parse(getComputedStyle(document.documentElement).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
  const base = rootBg.a > 0 ? over(rootBg, { r: 255, g: 255, b: 255, a: 1 }) : { r: 255, g: 255, b: 255, a: 1 };
  const backgroundOf = (el) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.backgroundImage && style.backgroundImage !== 'none') return null;
      const c = parse(style.backgroundColor);
      if (c && c.a > 0) chain.push(c);
      if (c && c.a >= 1) break;
    }
    let bg = base;
    for (let i = chain.length - 1; i >= 0; i -= 1) bg = over(chain[i], bg);
    return bg;
  };
  const visible = (el) => {
    if (!el.getClientRects().length || el.closest('[hidden]') || el.closest('[aria-hidden="true"]')) return false;
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false;
    }
    return true;
  };
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : ''} "${(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 32)}"`;
  const problems = [];
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim())) continue;
    if (!visible(el)) continue;
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize) || 0;
    if (size < 1) continue; // text hidden with font-size: 0 (the #conn dot, icon-only pills)
    const fg = parse(style.color);
    const bg = backgroundOf(el);
    if (!fg || !bg) continue;
    const fgOver = over(fg, bg);
    const l1 = lum(fgOver);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const weight = Number(style.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    if (ratio + 0.01 < need) problems.push(`${label(el)} ${ratio.toFixed(2)}:1 (butuh ${need})`);
  }
  return problems;
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
      // Tab stops only: `tabindex="-1"` is programmatically focusable but never reached by Tab (the settings tabs use
      // the ARIA tabs roving tabindex: the active tab is 0, the rest -1). Buttons match the `button` part of the
      // selector anyway, so the exclusion has to be applied to every match, not only to the `[tabindex]` part.
      const items = [...modal.querySelectorAll('button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (el) => el.getAttribute('tabindex') !== '-1' && !el.disabled && !el.closest('[hidden]') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden',
      );
      return { focusables: items.length, activeIndex: items.indexOf(active), items: items.map((el) => `${describe(el)}${el.getAttribute('tabindex') ? `[tabindex=${el.getAttribute('tabindex')}]` : ''}`) };
    })(),
  };
}

// ---------- helpers ----------

function realProblems(page) {
  return page.problems.filter((p) => !IGNORED_PROBLEMS.some((re) => re.test(p.text)));
}

// What the page actually holds while appReady is still false: the next CI flake names its cause instead of only
// "timeout menunggu app terhubung".
async function appState() {
  const conn = document.querySelector('#conn');
  let locks = null;
  try {
    locks = (await navigator.locks.query()).held?.map((l) => l.name) ?? [];
  } catch {
    locks = 'tidak tersedia'; // plain-HTTP WiFi has no Web Locks
  }
  return {
    conn: conn ? `${conn.className} | ${conn.textContent}` : null,
    crumb: document.querySelector('#crumb')?.textContent?.trim().slice(0, 60) ?? null,
    streamRole: document.documentElement.dataset.streamRole ?? null,
    locks,
    ready: document.readyState,
    hidden: document.visibilityState,
    bubbles: document.querySelectorAll('#chat .msg').length,
  };
}

async function openApp(page, hash = '') {
  page.clearProblems();
  const load = async () => {
    await page.goto(`${BASE}/${hash}`);
    await page.waitFor(appReady, { timeoutMs: 30000, message: 'app terhubung (#conn.ok) dan header terisi' });
  };
  // The diagnostic probe must never be the thing that hangs: a renderer stuck mid-navigation would otherwise hide it.
  const probe = () => Promise.race([page.eval(appState), sleep(2000).then(() => ({ probe: 'timeout 2 dtk' }))]).catch((err) => ({ probe: `gagal: ${err.message}` }));
  try {
    await load();
  } catch (err) {
    // Retry only a silent appReady stall (the shared stream handing leadership over). A console error or a failed
    // navigation is a real bug: fail now with it instead of reloading it away.
    const first = { error: err.message, problems: realProblems(page), state: await probe() };
    if (!/app terhubung/.test(err.message) || first.problems.length) {
      throw new Error(`${err.message}\n  keadaan: ${JSON.stringify(first.state)}\n  masalah console: ${JSON.stringify(first.problems)}`);
    }
    console.log(`↻ app ready gagal sekali (${err.message}); satu muat ulang. ${JSON.stringify(first.state)}`);
    try {
      await load();
    } catch (err2) {
      const second = { error: err2.message, problems: realProblems(page), state: await probe() };
      throw new Error(`${err2.message}\n  percobaan 1: ${JSON.stringify(first)}\n  percobaan 2: ${JSON.stringify(second)}`);
    }
  }
  await sleep(300); // let late async work (account, usage) surface any errors
}

/**
 * Per-test setup: the page shows the app at `hash` and is connected. A page already there is reused as it is
 * (cheap: dialogs closed, focus dropped, problems cleared); anything else (about:blank, another project, /pair,
 * a disconnected page) gets a full load. Lets every test run alone (--test-name-pattern) and in any order.
 */
async function ensureApp(page, hash = '') {
  const href = await page.eval('location.href').catch(() => '');
  if (href !== `${BASE}/${hash}` || !(await page.eval(appReady).catch(() => false))) return openApp(page, hash);
  page.clearProblems();
  await page.eval(() => {
    document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
    document.activeElement?.blur?.();
  });
}

/** POST to the app's API from the test (the token is read fresh: a restarted server hands out a new one). */
async function apiPost(p, body = {}) {
  const token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then((r) => r.json());
}

/** A throwaway project outside the projects root (empty chat), for a test that must not touch "toko". Forget it in finally. */
async function addTempProject(name) {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  const { id } = await apiPost('/api/projects', { path: dir });
  assert.ok(id, `project ${name} dibuat`);
  return id;
}

const forgetTempProject = (id) => (id ? apiPost(`/api/projects/${id}/forget`).catch(() => {}) : undefined);

const draftKey = () => `office.draft.${projectId}`;

// Phone Chat (docs/design-mobile-chat.md): these controls stay in the DOM but are reached through a sheet on a phone.
const viaHeadMore = (sel) => ['#btn-head-more', `#head-more-modal [data-proxy="${sel}"]`];
const PHONE_ROUTE = {
  '#btn-settings': viaHeadMore('#btn-settings'),
  '#btn-account': viaHeadMore('#btn-account'),
  '#btn-report': viaHeadMore('#btn-report'),
  '#btn-phone': viaHeadMore('#btn-phone'),
  '#btn-sessions': viaHeadMore('#btn-sessions'),
  '#btn-template': ['#btn-plus', '#plus-modal [data-proxy="#btn-template"]'],
  '#btn-voice': ['#btn-plus', '#plus-modal [data-proxy="#btn-voice"]'],
  '#sb-tasks': ['#statusline [data-open-tasks]'],
  '#sb-queue': ['#statusline [data-open-queue]'],
};
for (const item of ['export', 'export-session', 'permissions', 'roster', 'terminal']) PHONE_ROUTE[`#more-menu [data-more="${item}"]`] = viaHeadMore(`[data-more='${item}']`);

const shownInPage = (page, sel) => page.eval((s) => Boolean(document.querySelector(s)?.getClientRects().length), sel);

/** Clicks `sel` like a user: directly when it is on screen, else (phone) through its sheet route. */
async function tap(page, sel) {
  const route = PHONE_ROUTE[sel];
  if ((await shownInPage(page, sel)) || !route || !(await shownInPage(page, route[0]))) return page.click(sel);
  for (const step of route) {
    // visible, and its sheet done sliding up (a tap mid-animation would land on the row next to it)
    await page.waitFor((s) => document.querySelector(s)?.getClientRects().length && !document.querySelector(s).closest('.modal-card')?.getAnimations().some((a) => a.playState === 'running'), { timeoutMs: 2000, message: `${step} terlihat` }, step);
    await page.click(step);
  }
}

/** ⋯ → item: the session bar menu on a laptop, the header sheet on a phone. */
async function tapMore(page, item) {
  if (await shownInPage(page, '#btn-more')) {
    await page.click('#btn-more');
    return page.click(`#more-menu [data-more="${item}"]`);
  }
  return tap(page, `#more-menu [data-more="${item}"]`);
}

/** Replaces the composer text by typing (a trusted `input` event, as from the keyboard). */
/**
 * Taps a Perubahan-tab action: on a laptop the button itself, on a phone the row of the header ⋯ sheet that forwards
 * to it (the phone shows only ⎇ and Commit in that view, docs/design-mobile-chat.md §9).
 */
async function tapChangesAction(page, sel, mobile) {
  if (!mobile) return page.click(sel);
  await page.click('#btn-head-more');
  await page.waitFor(() => !document.querySelector('#head-more-modal').hidden, { timeoutMs: 2000, message: 'sheet ⋯' });
  await page.click(`#head-more-modal [data-proxy="${sel}"]`);
}

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
  let trigger = candidates ? await page.eval((sels) => sels.find((sel) => document.querySelector(sel)?.getClientRects().length) ?? null, candidates) : null;
  // Phone: a header button lives in the ⋯ sheet; focus then returns to ⋯ (the sheet's opener).
  const routed = !trigger && candidates?.find((sel) => PHONE_ROUTE[sel]);
  if (routed && (await shownInPage(page, PHONE_ROUTE[routed][0]))) {
    trigger = PHONE_ROUTE[routed][0];
    await tap(page, routed);
  } else if (candidates) {
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
  const via = routed && trigger ? `klik ${PHONE_ROUTE[routed].join(' → ')}` : trigger ? `klik ${trigger}` : 'hidden=false';
  if (!st.open) return { fails: [`tidak terbuka lewat ${via}`] };
  if (!st.focusInside) fails.push(`fokus tidak masuk modal setelah dibuka (activeElement=${st.active})`);

  const unnamed = await page.eval(unnamedButtons, `#${id}`);
  if (unnamed.length) fails.push(`tombol tanpa nama aksesibel di dalam modal: ${unnamed.join(' | ')}`);

  // Enough presses to walk past the last element and wrap; also proves Tab really moves focus.
  // A date/time input is one element but several Tab stops in Chrome (hours, minutes, AM/PM): 2 extra each.
  const segmented = await page.eval((m) => document.getElementById(m).querySelectorAll('input[type="time"], input[type="date"], input[type="datetime-local"]').length, id);
  const presses = Math.min(Math.max(st.focusables + 2 + segmented * 2, 3), 80);
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
    const missed = st.items.filter((_, i) => !visited.has(i));
    fails.push(`Tab hanya mengunjungi ${visited.size} dari ${st.focusables} elemen fokus (tidak terjangkau: ${missed.join(', ')})`);
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

/** One row of byEngineSource: 1000 tokens are split over the four rows (see reportSummary). */
const engineRow = (key, total, costUsd, costCoverage, records) => ({
  key,
  engine: key.slice(0, key.indexOf(':')),
  source: key.slice(key.indexOf(':') + 1),
  input: Math.round(total * 0.6),
  output: Math.round(total * 0.4),
  cacheRead: 0,
  cacheWrite: 0,
  total,
  requests: records,
  turns: records,
  costUsd,
  costCoverage,
  cacheHitRate: 0,
  records,
});

/** A rounded /api/report/summary answer: 1000 tokens, 60% of the records with a cost. */
function reportSummary(overrides = {}) {
  const now = Date.now();
  const period = { start: now - 86_400_000, end: now, input: 600, output: 400, cacheRead: 0, cacheWrite: 0, total: 1000, costUsd: 0.75, costCoverage: 0.6, cacheHitRate: 0 };
  return {
    from: now - 6 * 86_400_000,
    to: now,
    groupBy: 'day',
    records: 10,
    totals: { input: 600, output: 400, cacheRead: 0, cacheWrite: 0, total: 1000, requests: 12, turns: 9, costUsd: 0.75, costCoverage: 0.6, cacheHitRate: 0 },
    byModel: [{ key: 'claude-sonnet', ...period }],
    byProject: [],
    bySource: [],
    byEngine: [],
    byEngineSource: [
      engineRow('claude:web', 500, 0.5, 1, 4),
      engineRow('claude:cli', 300, null, 0, 3),
      engineRow('opencode:web', 150, 0, 0.5, 2),
      engineRow('opencode:cli', 50, 0.25, 1, 1),
    ],
    byPeriod: [period],
    topSessions: [],
    ...overrides,
  };
}

/**
 * Opens the report dialog on a canned summary: what the test server's ledger holds is other tests'
 * business. Everything but the two report endpoints still goes to the real API (fetch is restored by
 * restoreReport, also when the test fails).
 */
async function stubReport(page, summary, accounts = [{ id: 'uji', email: 'uji@example.com', first: Date.now() - 7 * 86_400_000 }]) {
  await page.eval((payload, list) => {
    window.__officeFetch ??= window.fetch;
    window.__reportPayload = payload;
    // Every summary call is kept so a test can check which accountId the dialog sent.
    window.__reportCalls = [];
    window.fetch = (url, opts) => {
      const path = String(url);
      const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (path.includes('/api/report/accounts')) return json({ accounts: list, current: list[0]?.id ?? null });
      if (path.includes('/api/report/summary')) {
        try {
          window.__reportCalls.push(JSON.parse(opts?.body ?? '{}'));
        } catch {
          window.__reportCalls.push({});
        }
        return json(window.__reportPayload);
      }
      return window.__officeFetch(url, opts);
    };
  }, summary, accounts);
}

/** The query bodies the dialog sent to /api/report/summary, oldest first. */
const reportCalls = (page) => page.eval(() => window.__reportCalls ?? []);

/** Puts the real fetch back and closes the dialog (a failed test must not leave the stub behind). */
async function restoreReport(page) {
  await page
    .eval(() => {
      if (window.__officeFetch) window.fetch = window.__officeFetch;
      delete window.__officeFetch;
      delete window.__reportPayload;
      delete window.__reportCalls;
      document.querySelector('#report-modal').hidden = true;
    })
    .catch(() => {});
}

/**
 * A canned /api/health answer (⚙ → Sistem → 🩺): green / amber / red (non-essential) checks, a 5-of-6
 * checklist, a long data path that must wrap, and a last error that must stay text (escaped).
 */
const HEALTH_ANSWER = () => ({
  at: '2026-11-05T10:00:00.000Z',
  app: { version: '0.2.0', pid: 4321, uptimeSec: 3 * 3600 + 5 * 60, engine: 'claude', port: 4317 },
  checks: [
    { id: 'node', label: 'Node.js', ok: true, detail: 'v22.11.0' },
    { id: 'agents', label: 'Folder sesi Claude', ok: false, warn: true, detail: 'folder lama', hint: 'Folder baru dibuat otomatis.' },
    { id: 'data-dir', label: 'Data aplikasi bisa ditulis', ok: false, essential: false, detail: 'hanya baca', hint: 'Periksa izin folder data.' },
  ],
  checklist: [
    { id: 'login', label: 'Login Claude Code', done: true, hint: 'Jalankan claude di terminal.' },
    { id: 'roots', label: 'Folder project', done: true },
    { id: 'team', label: 'Nama anggota tim', done: true },
    { id: 'notify', label: 'Notifikasi HP', done: true },
    { id: 'backup', label: 'Backup otomatis', done: true },
    { id: 'tailscale', label: 'Tailscale', done: false, hint: 'Pasang Tailscale untuk membuka kantor dari HP.' },
  ],
  errors: { count24h: 2, last: '<script>alert("x")</script> ENOENT: data/sesi/panjang/sekali/berkas-yang-tidak-ada.json' },
  data: { bytes: 12_900_000, files: 123, dir: `C:\\Users\\adhit\\AppData\\Local\\adhit-office\\data\\${'folder-panjang-'.repeat(6)}` },
});

/**
 * Stubs POST /api/health (everything else still goes to the real API) and counts its calls, so a test can prove
 * that one ↻ is exactly one request. `delayMs` keeps a request in flight long enough to see the cached report.
 */
async function stubHealth(page, answer = HEALTH_ANSWER(), { fail = false, delayMs = 0 } = {}) {
  await page.eval(
    (payload, shouldFail, delay) => {
      window.__officeFetch ??= window.fetch;
      window.__healthAnswer = payload;
      window.__healthFail = shouldFail;
      window.__healthDelay = delay;
      window.__healthCalls = 0;
      window.fetch = (url, opts) => {
        if (!String(url).includes('/api/health')) return window.__officeFetch(url, opts);
        window.__healthCalls += 1;
        const body = window.__healthFail ? { error: 'Server sibuk' } : { health: window.__healthAnswer };
        const status = window.__healthFail ? 500 : 200;
        return new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })), window.__healthDelay));
      };
    },
    answer,
    fail,
    delayMs,
  );
}

const healthCalls = (page) => page.eval(() => window.__healthCalls ?? 0);

/** Puts the real fetch back and closes both dialogs (a failed test must not leave the stub behind). */
async function restoreHealth(page) {
  await page
    .eval(() => {
      if (window.__officeFetch) window.fetch = window.__officeFetch;
      delete window.__officeFetch;
      delete window.__healthAnswer;
      delete window.__healthFail;
      delete window.__healthDelay;
      delete window.__healthCalls;
      document.querySelector('#health-modal').hidden = true;
      document.querySelector('#settings-modal').hidden = true;
    })
    .catch(() => {});
}

/**
 * A canned /api/budget view: a daily limit under the warn line, a weekly one above it and a monthly window with no
 * limit (its spend is still recorded). The server's percent/state are deliberately wrong: the UI recomputes them.
 */
const BUDGET_ANSWER = () => ({
  budget: { dailyUsd: 20, weeklyUsd: 50, monthlyUsd: 0 },
  spend: {
    day: { usd: 12.3, rows: 4, known: true },
    week: { usd: 45, rows: 9, known: true },
    month: { usd: 3, rows: 2, known: false },
  },
  windows: {
    day: { limit: 20, usd: 12.3, percent: 0.01, state: 'off' },
    week: { limit: 50, usd: 45, percent: 0.02, state: 'ok' },
    month: { limit: 0, usd: 3, percent: 0, state: 'ok' },
  },
  forecast: { monthUsd: 3, elapsedDays: 5, daysInMonth: 30, dailyUsd: 0.6, projectedUsd: 18 },
  trend: [0, 1.5, 0, 2.25, 0.5, 0, 3].map((usd, i) => ({ start: Date.now() - (6 - i) * 86_400_000, usd, rows: usd ? 1 : 0, known: usd ? 1 : 0 })),
  note: 'Dihitung dari biaya yang tercatat di ledger (9 dari 9 catatan punya biaya); OpenCode Go umumnya tercatat $0.',
});

/**
 * Stubs POST /api/budget and /api/budget/save (everything else still goes to the real API), counts the view reads
 * and keeps every save body. `window.__budgetSave = {status, error}` makes the next save fail like the server does.
 */
async function stubBudget(page, answer = BUDGET_ANSWER()) {
  await page.eval((payload) => {
    window.__budgetPreviousFetch ??= window.fetch;
    window.__budgetAnswer = payload;
    window.__budgetSave = { status: 200, error: '' };
    window.__budgetCalls = 0;
    window.__budgetSaves = [];
    window.fetch = (url, opts) => {
      const path = String(url);
      if (!path.includes('/api/budget')) return window.__budgetPreviousFetch(url, opts);
      const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
      if (path.includes('/api/budget/audit')) {
        return json({ entries: [{ ts: Date.now(), action: 'save', scope: 'global', projectId: null, actor: 'laptop', detail: 'dailyUsd=20' }] });
      }
      if (path.includes('/api/budget/save')) {
        let body = {};
        try {
          body = JSON.parse(opts?.body ?? '{}');
        } catch {
          body = {};
        }
        window.__budgetSaves.push(body);
        return window.__budgetSave.error ? json({ error: window.__budgetSave.error }, window.__budgetSave.status) : json({ budget: window.__budgetAnswer });
      }
      window.__budgetCalls += 1;
      return json({ budget: window.__budgetAnswer });
    };
  }, answer);
}

const budgetCalls = (page) => page.eval(() => window.__budgetCalls ?? 0);
const budgetSaves = (page) => page.eval(() => window.__budgetSaves ?? []);

/** Forgets the module's in-memory view, so the next open really asks the stub (also when run alone). */
const resetBudget = (page) =>
  page.eval(async () => {
    const { budgetView } = await import('/js/features/budget.js');
    Object.assign(budgetView, { data: null, error: null, loading: false, promise: null, fieldsKey: null, saving: false });
  });

/** Puts the previous fetch back, forgets the module's cached view (the page is reused between tests) and resets the fields. */
async function restoreBudget(page) {
  await page
    .eval(async () => {
      if (window.__budgetPreviousFetch) window.fetch = window.__budgetPreviousFetch;
      delete window.__budgetPreviousFetch;
      delete window.__budgetAnswer;
      delete window.__budgetSave;
      delete window.__budgetCalls;
      delete window.__budgetSaves;
      const { budgetView } = await import('/js/features/budget.js');
      Object.assign(budgetView, { data: null, error: null, loading: false, promise: null, fieldsKey: null, saving: false });
      for (const id of ['#budget-daily', '#budget-weekly', '#budget-monthly']) {
        const input = document.querySelector(id);
        if (!input) continue;
        input.value = '';
        input.setAttribute('aria-invalid', 'false');
      }
      const error = document.querySelector('#budget-error');
      if (error) error.textContent = '';
      document.querySelector('#settings-modal').hidden = true;
      document.querySelector('#health-modal').hidden = true;
    })
    .catch(() => {});
}

/** The budget rows as drawn (⚙ and 🩺): labels, amounts, remaining text, tones and the computed bar colours. */
function budgetRows(rootSel = '#budget-rows') {
  return [...document.querySelectorAll(`${rootSel} .budget-row`)].map((li) => {
    const bar = li.querySelector('.budget-bar');
    const fill = li.querySelector('.budget-fill');
    return {
      cls: li.className,
      window: li.querySelector('.budget-window')?.textContent ?? '',
      amount: (li.querySelector('.budget-amount')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      rest: li.querySelector('.budget-rest')?.textContent ?? null,
      pct: li.querySelector('.budget-pct')?.textContent ?? null,
      bar: bar
        ? {
            role: bar.getAttribute('role'),
            now: bar.getAttribute('aria-valuenow'),
            text: bar.getAttribute('aria-valuetext'),
            width: fill?.style.width ?? '',
            color: fill ? getComputedStyle(fill).backgroundColor : '',
          }
        : null,
    };
  });
}


/** A canned /api/models/prices answer: one OpenCode Go model with a peak factor, one free, and observed Claude prices. */
const PRICE_ANSWER = {
  fetchedAt: '2026-11-05T00:00:00.000Z',
  source: 'opencode.ai',
  stale: false,
  prices: [
    { model: 'opencode-go/kimi-k2', name: 'Kimi K2', input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0, peakFactor: 2 },
    { model: 'opencode-go/free', name: 'Free Model', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peakFactor: 1 },
  ],
  observed: [
    { model: 'claude-sonnet-4-5-20250929', perMillion: 1.23, records: 7, tokens: 1_234_567 },
    { model: 'claude-sonnet-4-5-old', perMillion: 9.99, records: 1, tokens: 100 },
  ],
};

/**
 * Stubs POST /api/models/prices with a canned answer (a test server may not have the route yet) and forgets the
 * module's cached answer, so the next composer render asks again. `fail` rejects the request like an offline page.
 */
async function stubPrices(page, answer, fail = false) {
  await page.eval(
    async (payload, shouldFail) => {
      window.__officeFetch ??= window.fetch;
      window.__priceCalls = 0;
      const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      window.fetch = (url, opts) => {
        if (String(url).includes('/api/models/prices')) {
          window.__priceCalls += 1;
          return shouldFail ? Promise.reject(new TypeError('Failed to fetch')) : json(payload);
        }
        return window.__officeFetch(url, opts);
      };
      const prices = await import('/js/features/model-prices.js');
      // A load that started before the stub was up can still answer after the reset and replace the canned cache:
      // let the module's in-flight request settle first, then forget whatever it brought.
      for (let i = 0; i < 40 && prices.modelPrices(() => {}) === null; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      prices.resetModelPrices();
    },
    answer,
    fail,
  );
}

/** Puts the real fetch back (a failed test must not leave the stub behind). */
const restorePrices = (page) =>
  page
    .eval(() => {
      if (window.__officeFetch) window.fetch = window.__officeFetch;
      delete window.__officeFetch;
      delete window.__priceCalls;
    })
    .catch(() => {});

/** Re-renders the composer like a keystroke in the model search does: no settings write, no server round-trip. */
const rerenderPicker = (page) => page.eval(() => document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true })));

/** Sets the project's model in the client state (what the server's status normally carries) before a re-render. */
const setPickerModel = (page, model) =>
  page.eval(async (value) => {
    const { state } = await import('/js/core/state.js');
    state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), model: value };
  }, model);

/** Sets the Model Auto flag (and, when given, the concrete model) in the client state like the server status does. */

/**
 * Captures the composer's own POST /api/projects/:id/settings bodies and answers ok, so a test can assert the exact
 * payload without the server (the backend's modelAuto field may still be landing). `fail` turns the next answers into
 * a 400 with an inline reason (for the ladder dialog's error state).
 */
async function stubSettings(page, { fail = false } = {}) {
  await page.eval((shouldFail) => {
    window.__officeFetch ??= window.fetch;
    const prev = window.fetch; // another stub may sit underneath (models, prices): chain, don't bypass it
    window.__settingsBodies = [];
    window.__settingsFail = shouldFail;
    window.fetch = (url, opts) => {
      const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
      if (/\/api\/projects\/[^/]+\/settings$/.test(String(url)) && String(opts?.method ?? 'GET').toUpperCase() === 'POST') {
        window.__settingsBodies.push(JSON.parse(opts.body ?? '{}'));
        if (window.__settingsFail) return json({ error: 'Model tidak dikenal mesin ini.' }, 400);
        return json({ ok: true });
      }
      return prev(url, opts);
    };
  }, fail);
}

const restoreSettings = (page) =>
  page
    .eval(() => {
      if (window.__officeFetch) window.fetch = window.__officeFetch;
      delete window.__officeFetch;
      delete window.__settingsBodies;
      delete window.__settingsFail;
    })
    .catch(() => {});

/** The OpenCode models the ladder/note tests use: the four cheap defaults, Kimi for custom-ladder tests, and one alternative. */
const OC_MODELS = [
  { value: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { value: 'opencode-go/glm-5.3-flash', name: 'GLM 5.3 Flash' },
  { value: 'opencode-go/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { value: 'opencode-go/glm-5.3', name: 'GLM 5.3' },
  { value: 'opencode-go/kimi-k3.1-pro', name: 'Kimi K3.1 Pro' },
  { value: 'opencode-go/kimi-k3', name: 'Kimi K3' },
  { value: 'opencode-go/hemat-lain', name: 'Hemat Lain' },
];

/** Claude Code's catalog as the app receives it (displayName/description), with one entry per tier. */
const CLAUDE_CATALOG = [
  { value: 'default', displayName: 'Default', description: 'bawaan' },
  { value: 'haiku', displayName: 'Haiku', description: 'Cepat' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Serbaguna' },
  { value: 'opus', displayName: 'Opus', description: 'Kuat' },
  { value: 'fable', displayName: 'Fable 5.1', description: 'Paling mampu' },
];

/** The tier defaults the composer shows with nothing stored (mirrors src/model-auto.js). */
const defaultTierValues = (engine) => (engine === 'opencode' ? OC_MODELS.slice(0, 4).map((m) => m.value) : ['haiku', 'sonnet', 'opus', 'fable']);

/** Opens the composer's "Pengaturan giliran" sheet, then the Model Auto ladder through its link. */
async function openLadder(page) {
  if (await page.eval(() => document.querySelector('#turn-settings-modal').hidden)) {
    await page.click('#settings-chip');
    await page.waitFor(() => !document.querySelector('#turn-settings-modal').hidden, { timeoutMs: 2000, message: 'sheet pengaturan giliran' });
  }
  await page.click('#model-tiers-open');
  await page.waitFor(() => !document.querySelector('#model-tiers-modal').hidden, { timeoutMs: 2000, message: 'dialog tangga model' });
}

/** Serves the project's model list (GET/POST /api/projects/:id/models) without waiting for a real OpenCode. */
async function stubModels(page, models = OC_MODELS) {
  await page.eval((list) => {
    window.__officeFetch ??= window.fetch;
    const prev = window.fetch; // chain onto whatever stub sits underneath (settings, prices)
    window.fetch = (url, opts) => {
      if (/\/api\/projects\/[^/]+\/models$/.test(String(url))) {
        return Promise.resolve(new Response(JSON.stringify({ models: list, current: list[0]?.value ?? '', needsStart: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return prev(url, opts);
    };
  }, models);
}

const restoreModels = (page) =>
  page
    .eval(() => {
      if (window.__officeFetch) window.fetch = window.__officeFetch;
      delete window.__officeFetch;
    })
    .catch(() => {});

/**
 * Answers the account dialog's endpoints from a canned scene (`profile`, `audit`), records the login/logout POSTs and
 * replaces window.confirm with a recorder that answers false (a cancelled dialog). A test opts in with
 * `window.__acct.confirm = true`. `audit` may be an array of entries or `{ status, error }` for a refused fetch.
 */
async function stubAccount(page, { profile = { loggedIn: false }, audit = [] } = {}) {
  await page.eval((scene) => {
    window.__officeFetch ??= window.fetch;
    const prev = window.fetch;
    window.__realConfirm = window.confirm;
    window.__acct = { scene, calls: [], confirms: [], confirm: false };
    window.confirm = (text) => {
      window.__acct.confirms.push(String(text));
      return window.__acct.confirm;
    };
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    window.fetch = (url, opts) => {
      const path = String(url);
      if (path === '/api/account') return json({ profile: window.__acct.scene.profile, login: null, usage: null });
      if (path === '/api/account/limits') return json({ windows: [], note: null });
      if (path === '/api/account/audit') {
        const a = window.__acct.scene.audit;
        return a && !Array.isArray(a) && a.status ? json({ error: a.error ?? 'Ditolak.' }, a.status) : json({ entries: a ?? [] });
      }
      if (path.startsWith('/api/account/login') || path === '/api/account/logout') {
        window.__acct.calls.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
        return json({ ok: true, login: null });
      }
      return prev(url, opts);
    };
  }, { profile, audit });
}

const restoreAccount = (page) =>
  page
    .eval(() => {
      if (window.__officeFetch) window.fetch = window.__officeFetch;
      if (window.__realConfirm) window.confirm = window.__realConfirm;
      delete window.__officeFetch;
      delete window.__realConfirm;
      delete window.__acct;
    })
    .catch(() => {});

/** OpenCode's Akun with one provider credential; logout is answered with a 400. Switches the app to OpenCode.
 *  `go` is passed through as the providers response's Go quota (omitted entirely when null); `usage` feeds the local
 *  summary above it. */
async function stubOpenCodeAccount(page, { go = null, usage = null } = {}) {
  await page.eval(async (payload) => {
    window.__officeFetch ??= window.fetch;
    const prev = window.fetch;
    window.__realConfirm = window.confirm;
    window.__ocAcct = { calls: [], confirms: [], providerCalls: 0, providerDone: 0, go: payload.go, usage: payload.usage };
    window.confirm = (text) => {
      window.__ocAcct.confirms.push(String(text));
      return true; // the user confirms; the point of this test is what goes out afterwards
    };
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    window.fetch = async (url, opts) => {
      const path = String(url);
      if (path === '/api/opencode/providers') {
        window.__ocAcct.providerCalls += 1;
        await new Promise((r) => setTimeout(r, 120)); // a slow answer: a second click must not start a second call
        window.__ocAcct.providerDone += 1;
        const body = { connected: [{ id: 'anthropic', name: 'Anthropic', connections: [{ id: 'cred-1', type: 'credential', label: 'Claude Pro', method: 'oauth' }] }], available: [], usage: window.__ocAcct.usage };
        const go = window.__ocAcct.go;
        if (go) body.go = go;
        return json(body);
      }
      if (path === '/api/account/go-plan') {
        window.__ocAcct.calls.push({ path, body: JSON.parse(opts?.body ?? '{}') });
        return json({ ok: true });
      }
      if (path === '/api/opencode/logout') {
        window.__ocAcct.calls.push(JSON.parse(opts?.body ?? '{}'));
        return json({ error: 'Ketik LOGOUT untuk konfirmasi logout provider.' }, 400);
      }
      return prev(url, opts);
    };
    const { state } = await import('/js/core/state.js');
    // The server broadcasts its own config (a background catalog probe) and renderRoots replaces state.config, which
    // would flip the dialog back to Claude mid-test. Lock the engine for this test; the server's config is remembered
    // for the restore.
    const locked = { ...(state.config ?? {}), engine: 'opencode' };
    window.__configLock = { locked, latest: state.config };
    Object.defineProperty(state, 'config', {
      configurable: true,
      enumerable: true,
      get: () => window.__configLock.locked,
      set: (value) => {
        window.__configLock.latest = value;
      },
    });
    (await import('/js/features/account.js')).renderAccountButton();
  }, { go, usage });
}

const restoreOpenCodeAccount = (page) =>
  page
    .eval(async () => {
      if (window.__officeFetch) window.fetch = window.__officeFetch;
      if (window.__realConfirm) window.confirm = window.__realConfirm;
      delete window.__officeFetch;
      delete window.__realConfirm;
      delete window.__ocAcct;
      const { state } = await import('/js/core/state.js');
      const lock = window.__configLock;
      if (lock) {
        delete state.config;
        if (lock.latest !== undefined) state.config = lock.latest;
        delete window.__configLock;
      }
      (await import('/js/features/account.js')).renderAccountButton();
    })
    .catch(() => {});

// ---------- tests ----------

/** The local token summary above the Go section (drawn only when the server records usage). */
const GO_USAGE = { today: { total: 1200, costUsd: 0.12 }, week: { total: 8400, costUsd: 0.84, costCoverage: 1 } };

/** Go quota as the server sends it: already sorted (highest 30d first), one green, one amber, one red, one unlimited.
 *  `percent*` are the server's own 0..100 fields; the bars read used/limit, so those stay honest either way. */
const GO_QUOTA = {
  plan: 'go',
  available: true,
  note: 'Perkiraan dari token di ledger × harga list Go, dibandingkan batas bulanan paket Go ($10/bulan). Batas 5 jam = 20% dan 7 hari = 50%; Go tidak melaporkan biaya, jadi angka ini bukan tagihan.',
  models: [
    { model: 'DeepSeek V4.1 Flash', limit: 10, used5h: 0.24, used7d: 4, used30d: 9.6, remaining: 0.4, percent5h: 12, percent7d: 80, percent30d: 96 },
    { model: 'GLM 5.3', limit: 10, used5h: 0.15, used7d: 2.5, used30d: 8.1, remaining: 1.9, percent5h: 7.5, percent7d: 50, percent30d: 81 },
    { model: 'Kimi K3', limit: 10, used5h: 0.04, used7d: 1, used30d: 4.2, remaining: 5.8, percent5h: 2, percent7d: 20, percent30d: 42 },
    { model: 'Model Gratis', limit: null, unlimited: true, used5h: 0, used7d: 0.2, used30d: 0.5, remaining: null, percent5h: null, percent7d: null, percent30d: null },
    { model: 'Model Tanpa Tabel', limit: null, used5h: 0.1, used7d: 0.3, used30d: 0.6, remaining: null, percent5h: null, percent7d: null, percent30d: null },
  ],
};

/** Ten models (top-8 + toggle) with an unbreakable long name and one over the allowance (bar capped at 100%). */
const GO_MANY = {
  plan: 'go',
  available: true,
  note: '',
  models: Array.from({ length: 10 }, (_, i) => ({
    model: i === 0 ? `opencode-go/${'x'.repeat(72)}` : `Model ${i + 1}`,
    limit: 10,
    used5h: 0.02,
    used7d: 0.25,
    used30d: i === 0 ? 12 : 10 - i,
    remaining: i,
    percent5h: 1,
    percent7d: 5,
    percent30d: i === 0 ? 120 : (10 - i) * 10,
  })),
};


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
      await openApp(page, '#demo');
      assert.deepEqual(realProblems(page), []);
    });

    test('index.html (demo): tidak ada scroll horizontal', async () => {
      await ensureApp(page, '#demo');
      assert.equal(await page.eval(horizontalOverflow), null);
    });

    test('index.html (demo): semua tombol terlihat punya nama aksesibel', async () => {
      await ensureApp(page, '#demo');
      assert.deepEqual(await page.eval(unnamedButtons), []);
      // Chrome's own accessibility tree agrees: no unignored button with an empty computed name.
      const { nodes } = await page.send('Accessibility.getFullAXTree');
      const empty = nodes.filter((n) => !n.ignored && n.role?.value === 'button' && !String(n.name?.value ?? '').trim());
      assert.deepEqual(empty.map((n) => n.backendDOMNodeId), [], 'AX tree: button tanpa nama');
    });

    test('button.primary berlatar rgb(184, 90, 60)', async () => {
      await ensureApp(page, '#demo');
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 }); // no :hover
      const colors = await page.eval(() => [...document.querySelectorAll('button.primary')].map((b) => ({ html: b.outerHTML.slice(0, 80), bg: getComputedStyle(b).backgroundColor })));
      assert.ok(colors.length > 0, 'tidak ada button.primary');
      assert.deepEqual(colors.filter((c) => c.bg !== 'rgb(184, 90, 60)'), []);
    });

    if (vp.mobile) {
      test('mobile: #conn titik 10x10, .pill lain tetap terbaca', async (t) => {
        await ensureApp(page, '#demo');
        const r = await page.eval(() => {
          const box = document.querySelector('#conn').getBoundingClientRect();
          const pills = [...document.querySelectorAll('.pill:not(#conn)')].map((p) => ({ html: p.outerHTML.slice(0, 80), fontSize: getComputedStyle(p).fontSize }));
          return { w: box.width, h: box.height, pills };
        });
        assert.deepEqual({ w: r.w, h: r.h }, { w: 10, h: 10 });
        if (!r.pills.length) t.diagnostic('tidak ada .pill lain di DOM saat ini (hanya #conn)');
        assert.deepEqual(r.pills.filter((p) => p.fontSize === '0px'), []);
      });

      test('👆 geser kiri/kanan antar view: tidak saat vertikal atau mulai di kotak pesan', async () => {
        await ensureApp(page, `#${projectId}`);
        const lane = () => page.eval(() => ({
          view: document.body.dataset.view,
          tab: document.body.dataset.tab,
          nav: document.querySelector('#mobile-nav button.active')?.dataset.view ?? null,
        }));
        const swipe = async (from, to, steps = 6) => {
          await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
          for (let i = 1; i <= steps; i += 1) {
            await page.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }],
            });
          }
          await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await sleep(150);
        };
        await page.click('#mobile-nav [data-view="chat"]');
        await swipe({ x: 320, y: 300 }, { x: 80, y: 300 });
        assert.deepEqual(await lane(), { view: 'panel', tab: 'changes', nav: 'changes' }, 'geser kiri → Perubahan');
        await swipe({ x: 320, y: 300 }, { x: 80, y: 300 });
        assert.equal((await lane()).tab, 'activity', 'geser kiri lagi → Aktivitas');
        await swipe({ x: 320, y: 300 }, { x: 80, y: 300 });
        assert.equal((await lane()).tab, 'activity', 'di ujung kanan tidak berpindah');
        await swipe({ x: 80, y: 300 }, { x: 320, y: 300 });
        assert.equal((await lane()).tab, 'changes', 'geser kanan → kembali');
        await swipe({ x: 80, y: 300 }, { x: 320, y: 300 });
        assert.equal((await lane()).tab, 'chat', 'geser kanan lagi → Chat');
        await swipe({ x: 80, y: 300 }, { x: 320, y: 300 });
        assert.deepEqual(await lane(), { view: 'office', tab: 'chat', nav: 'office' }, 'geser kanan sampai Kantor');

        // Vertical movement is scrolling, not navigation.
        await page.click('#mobile-nav [data-view="chat"]');
        await swipe({ x: 200, y: 300 }, { x: 210, y: 460 });
        assert.equal((await lane()).tab, 'chat', 'geser vertikal tidak berpindah');

        // A gesture that starts in the composer belongs to the text field.
        const box = await page.eval(() => {
          const r = document.querySelector('#prompt').getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await swipe({ x: box.x + 60, y: box.y }, { x: box.x - 60, y: box.y });
        assert.equal((await lane()).tab, 'chat', 'mulai di kotak pesan tidak berpindah');
      });
    }

    test('index.html (project): termuat tanpa error, tanpa scroll horizontal, tombol bernama', async () => {
      await openApp(page, `#${projectId}`);
      assert.equal(await page.eval(() => location.hash.slice(1)), projectId);
      assert.deepEqual(realProblems(page), []);
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(await page.eval(unnamedButtons), []);
    });

    test('♿ audit aksesibilitas: kontrol bernama, field berlabel, alt, id unik, referensi ARIA, target ≥24px', async () => {
      await ensureApp(page, `#${projectId}`);
      const audit = async (where) => {
        const problems = await page.eval(a11yAudit);
        assert.deepEqual(problems, [], `audit ${where}`);
      };
      // Representative rows (a tool row too), so the message actions are audited even on a fresh chat.
      await page.eval(async (pid) => {
        const { appendChat } = await import('/js/features/chat.js');
        const now = Date.now();
        appendChat({ id: 'a11y-user', project: pid, kind: 'user', text: 'halo', source: 'web', ts: now }, false);
        appendChat({ id: 'a11y-tool', project: pid, kind: 'tool', text: 'Bash', status: 'done', input: { command: 'npm test', file: 'src/checkout.ts', line: 2 }, output: 'ok', ts: now }, false);
        appendChat({ id: 'a11y-assistant', project: pid, kind: 'assistant', text: 'balasan', ts: now }, false);
      }, projectId);
      try {
        await audit('halaman project');

      // The other main tabs.
      const tab = async (name) => {
        if (vp.mobile) await page.click(`#mobile-nav [data-view="${name}"]`);
        else await page.click(`.tabs button[data-tab="${name}"]`);
        await sleep(300);
      };
      await tab('changes');
      await audit('perubahan');
      await tab('activity');
      await audit('aktivitas');
      await tab('chat');

      // 📋 Antrian.
      await page.eval(async () => (await import('/js/features/queue.js')).openQueue());
      await page.waitFor(() => !document.querySelector('#queue-modal').hidden, { timeoutMs: 4000, message: 'antrian terbuka' });
      await sleep(300);
      await audit('antrian');
      await page.press('Escape');
      await sleep(100);

      // ⚙ Pengaturan: the biggest dialog.
      await page.eval(async () => (await import('/js/ui/modals.js')).openModal('settings-modal'));
      await page.waitFor(() => !document.querySelector('#settings-modal').hidden, { timeoutMs: 4000, message: 'pengaturan terbuka' });
      await sleep(300);
      await audit('pengaturan');
      await page.press('Escape');
      await sleep(100);

      // 🗂 Semua project, including ⚠ Perlu perhatian.
      await page.eval(async () => (await import('/js/features/dashboard.js')).openDashboard());
      await page.waitFor(() => !document.querySelector('#dash-modal').hidden, { timeoutMs: 4000, message: 'dashboard terbuka' });
      await sleep(300);
      await audit('semua project');
      await page.press('Escape');
      await sleep(100);

      // Ctrl+P palette.
      await page.eval(async () => (await import('/js/features/palette.js')).openPalette());
      await page.waitFor(() => !document.querySelector('#palette-modal').hidden, { timeoutMs: 4000, message: 'palet terbuka' });
      await sleep(200);
      await audit('palet perintah');
      await page.press('Escape');
      await sleep(100);
      } finally {
        // The synthetic rows are not in state.chats: drawing the chat again removes them.
        await page.eval(async () => (await import('/js/features/chat.js')).renderChat());
      }
    });

    test('💲 harga model: label harga list OpenCode Go (± jam sibuk), gratis, optgroup & saring tetap', async () => {
      await apiPost(`/api/projects/${projectId}/settings`, { model: '', modelAuto: false }); // no leftover Auto from another test
      await ensureApp(page, `#${projectId}`);
      await stubPrices(page, PRICE_ANSWER);
      try {
        const view = await page.eval(async () => {
          const { modelPrices, resetModelPrices } = await import('/js/features/model-prices.js');
          resetModelPrices(); // no cached answer from an earlier test
          await new Promise((resolve) => modelPrices(resolve)); // the composer's own lazy load, once the stub is up
          const { projectModelOptions } = await import('/js/features/engine.js');
          const entry = {
            engine: 'opencode',
            models: [
              { value: 'opencode-go/kimi-k2', name: 'Kimi K2' },
              { value: 'opencode-go/free', name: 'Free Model' },
              { value: 'other/plain', name: 'Plain' },
            ],
            current: '',
            loading: false,
            error: null,
          };
          const read = (html) => {
            const div = document.createElement('div');
            div.innerHTML = html;
            return {
              groups: [...div.querySelectorAll('optgroup')].map((g) => g.label),
              options: [...div.querySelectorAll('optgroup option')].map((o) => ({ value: o.value, text: o.textContent, title: o.title })),
            };
          };
          return { all: read(projectModelOptions(entry, '', '')), filtered: read(projectModelOptions(entry, '', 'kimi')) };
        });
        assert.deepEqual(view.all.groups, ['opencode-go', 'other'], 'optgroup per provider tetap');
        const kimi = view.all.options.find((o) => o.value === 'opencode-go/kimi-k2');
        assert.equal(kimi.text, 'Kimi K2 — ±$0.15 in / $0.6 out /1M', 'harga list dengan ± saat jam sibuk');
        assert.match(kimi.title, /opencode-go\/kimi-k2/, 'title memuat id model');
        assert.match(kimi.title, /hingga 2× saat jam sibuk/);
        assert.match(kimi.title, /sumber opencode\.ai/);
        const free = view.all.options.find((o) => o.value === 'opencode-go/free');
        assert.equal(free.text, 'Free Model — gratis', 'input & output 0 → gratis');
        assert.equal(view.all.options.find((o) => o.value === 'other/plain').text, 'Plain', 'tanpa data → tanpa akhiran');
        assert.deepEqual(view.filtered.options.map((o) => o.value), ['opencode-go/kimi-k2'], 'saring model tetap jalan');
      } finally {
        await restorePrices(page);
      }
    });

    test('💲 harga model: ≈ harga tercatat alias Claude, catatan di bawah select, demo tanpa catatan', async () => {
      await ensureApp(page, `#${projectId}`);
      await stubPrices(page, PRICE_ANSWER);
      await stubSettings(page); // model picks below must not send a real settings POST (its status broadcast would flip the engine)
      try {
        // This test drives the Claude catalog (state.config.models): make the engine deterministic.
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.config = { ...state.config, engine: 'claude' };
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), engine: 'claude', model: '', modelAuto: false };
        });
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          const { modelPrices, resetModelPrices } = await import('/js/features/model-prices.js');
          resetModelPrices(); // no cached answer from an earlier test
          await new Promise((resolve) => modelPrices(resolve));
          state.config = {
            ...state.config,
            models: [
              { value: 'default', displayName: 'Default', description: 'bawaan' },
              { value: 'sonnet', displayName: 'Sonnet', description: 'Serbaguna' },
              { value: 'opencode-go/kimi-k2', displayName: 'Kimi K2', description: 'Murah' },
              { value: 'opencode-go/free', displayName: 'Free Model', description: '' },
              { value: 'tanpa-harga', displayName: 'Tanpa Harga', description: '' },
            ],
          };
        });
        await setPickerModel(page, 'sonnet');
        await rerenderPicker(page);
        await page.waitFor(() => /≈\$1\.23\/1M tercatat$/.test([...document.querySelectorAll('#model option')].find((o) => o.value === 'sonnet')?.textContent ?? ''), { timeoutMs: 3000, message: 'akhiran ≈ untuk alias sonnet' });
        let view = await page.eval(() => {
          const opt = [...document.querySelectorAll('#model option')].find((o) => o.value === 'sonnet');
          const note = document.querySelector('#model-price-note');
          return {
            text: opt?.textContent,
            title: opt?.title,
            note: note && { hidden: note.hidden, text: note.textContent, live: note.getAttribute('aria-live'), afterControls: note.previousElementSibling?.classList.contains('controls') },
          };
        });
        assert.equal(view.text, 'Sonnet — ≈$1.23/1M tercatat', 'alias keluarga memakai model keluarga tersibuk');
        assert.match(view.title, /claude-sonnet-4-5-20250929/, 'title memuat id model yang dipakai');
        assert.match(view.title, /7 catatan/);
        assert.equal(view.note.hidden, false, 'catatan harga tampil');
        assert.equal(view.note.text, 'Harga efektif dari 7 catatan: ≈$1.23 per 1 juta token');
        assert.equal(view.note.live, 'polite', 'catatan diumumkan pembaca layar');
        assert.equal(view.note.afterControls, true, 'catatan menempel pada area kontrol');

        await setPickerModel(page, 'opencode-go/kimi-k2');
        await rerenderPicker(page);
        await page.waitFor(() => document.querySelector('#model-price-note')?.textContent.startsWith('Harga list OpenCode Go'), { timeoutMs: 3000, message: 'catatan harga list' });
        view = await page.eval(() => {
          const opt = [...document.querySelectorAll('#model option')].find((o) => o.value === 'opencode-go/kimi-k2');
          const note = document.querySelector('#model-price-note');
          return { text: opt?.textContent, note: note.textContent, hidden: note.hidden };
        });
        assert.equal(view.text, 'Kimi K2 — ±$0.15 in / $0.6 out /1M');
        assert.equal(view.note, 'Harga list OpenCode Go: $0.15 input · $0.60 output · $0.003 cache read per 1 juta token (bisa 2× saat jam sibuk)');

        if (vp.mobile) {
          // 390 px: the long note lives in the "Pengaturan giliran" sheet; nothing may stick out sideways.
          await page.click('#settings-chip');
          await page.waitFor(() => !document.querySelector('#turn-settings-modal').hidden, { timeoutMs: 2000, message: 'sheet pengaturan giliran' });
          assert.equal(await page.eval(horizontalOverflow), null, 'tanpa scroll horizontal dengan catatan harga panjang');
          await page.press('Escape');
          await sleep(100);
        } else {
          assert.equal(await page.eval(horizontalOverflow), null, 'tanpa scroll horizontal dengan catatan harga panjang');
        }

        await setPickerModel(page, 'opencode-go/free');
        await rerenderPicker(page);
        await page.waitFor(() => document.querySelector('#model-price-note')?.textContent === 'Gratis', { timeoutMs: 3000, message: 'catatan gratis' });
        await setPickerModel(page, 'tanpa-harga');
        await rerenderPicker(page);
        await page.waitFor(() => document.querySelector('#model-price-note')?.textContent === 'Belum ada data harga untuk model ini.', { timeoutMs: 3000, message: 'catatan tanpa data' });

        await ensureApp(page, '#demo');
        const demo = await page.eval(() => {
          const note = document.querySelector('#model-price-note');
          return note ? { hidden: note.hidden, text: note.textContent } : null;
        });
        assert.equal(demo?.hidden, true, 'catatan disembunyikan di project demo');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await restorePrices(page);
        await restoreSettings(page);
        await openApp(page, `#${projectId}`); // the mutated model list must not leak into later tests
      }
    });

    test('💲 harga model: gagal memuat harga → label tetap, tanpa error console & toast', async () => {
      await ensureApp(page, `#${projectId}`);
      await stubPrices(page, null, true); // the route is refused (plain WiFi) / offline
      try {
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.config = {
            ...state.config,
            models: [
              { value: 'default', displayName: 'Default', description: 'bawaan' },
              { value: 'opencode-go/kimi-k2', displayName: 'Kimi K2', description: '' },
              { value: 'sonnet', displayName: 'Sonnet', description: '' },
            ],
          };
        });
        await setPickerModel(page, 'opencode-go/kimi-k2');
        await rerenderPicker(page);
        await sleep(250);
        const view = await page.eval(() => {
          const option = (value) => [...document.querySelectorAll('#model option')].find((o) => o.value === value);
          const note = document.querySelector('#model-price-note');
          return {
            kimi: { text: option('opencode-go/kimi-k2')?.textContent, title: option('opencode-go/kimi-k2')?.title },
            sonnet: option('sonnet')?.textContent,
            note: note && { hidden: note.hidden, text: note.textContent },
            calls: window.__priceCalls,
            toasts: document.querySelectorAll('.toast').length,
          };
        });
        assert.equal(view.kimi.text, 'Kimi K2', 'label tanpa akhiran harga');
        assert.equal(view.kimi.title, '', 'title tanpa detail harga');
        assert.equal(view.sonnet, 'Sonnet');
        assert.equal(view.note.hidden, false, 'catatan tetap jujur: belum ada data');
        assert.equal(view.note.text, 'Belum ada data harga untuk model ini.');
        assert.equal(view.toasts, 0, 'kegagalan tidak memunculkan toast');
        assert.ok(view.calls >= 1, 'harga memang dicoba dimuat');
        assert.deepEqual(realProblems(page), [], 'kegagalan senyap, tanpa error console');
      } finally {
        await restorePrices(page);
        await openApp(page, `#${projectId}`);
      }
    });

    test('💲 estimasi biaya: tampil setelah harga dimuat, ikut isi kotak & ganti model, sembunyi tanpa harga/demo', async () => {
      await ensureApp(page, `#${projectId}`);
      // A previous run may have left 400 characters in this project's draft: start from a clean box.
      await page.eval((k) => {
        localStorage.removeItem(k);
        const input = document.querySelector('#prompt');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, draftKey());
      await stubPrices(page, PRICE_ANSWER);
      try {
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.config = {
            ...state.config,
            models: [
              { value: 'default', displayName: 'Default', description: 'bawaan' },
              { value: 'opencode-go/kimi-k2', displayName: 'Kimi K2', description: 'Murah' },
              { value: 'opencode-go/free', displayName: 'Free Model', description: '' },
              { value: 'tanpa-harga', displayName: 'Tanpa Harga', description: '' },
            ],
          };
          const prices = await import('/js/features/model-prices.js');
          // The page starts its own price load before the stub is up; that answer can land right after the stub's and
          // replace it. Load the canned answer until it sticks (one stale response at most).
          for (let attempt = 0; attempt < 6; attempt++) {
            prices.resetModelPrices();
            await new Promise((resolve) => prices.modelPrices(resolve)); // the same lazy load the composer asks for
            await new Promise((resolve) => setTimeout(resolve, 300));
            if (prices.priceFor('opencode-go/kimi-k2')) return;
          }
          throw new Error('harga stub tidak bertahan');
        });
        // A model the project does not actually run, plus a context the turn already carries. The injection and the
        // render happen in ONE page task: a status push from the server cannot land between them and replace it.
        const probe = (model, extra = {}) =>
          page.eval(
            async (value, more) => {
              const { state } = await import('/js/core/state.js');
              const { renderComposer } = await import('/js/features/composer.js');
              state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), model: value, activeModel: null, context: { used: 20_000, window: 200_000 }, ...more };
              renderComposer();
              const el = document.querySelector('#cost-estimate');
              return { hidden: el.hidden, visible: el.getClientRects().length > 0, text: el.textContent.trim(), title: el.title };
            },
            model,
            extra,
          );
        let view = await probe('opencode-go/kimi-k2');
        assert.equal(view.hidden, false, 'estimasi tampil');
        assert.equal(view.visible, true, 'estimasi terlihat di composer');
        assert.match(view.text, /^Perkiraan biaya: ±<?\$[0-9<]/, `teks ringkas: ${view.text}`);
        assert.match(view.title, /konteks 20\.000 token/, 'tooltip: token konteks');
        assert.match(view.title, /prompt ±0 token/, 'tooltip: prompt kosong');
        assert.match(view.title, /asumsi 600 token output/, 'tooltip: asumsi jawaban');
        assert.match(view.title, /harga list OpenCode Go/, 'tooltip: sumber harga');
        assert.match(view.title, /hingga 2×|jam sibuk 2×/, 'tooltip: asumsi jam sibuk');

        // Typing: the estimate follows the box (≤ 4 characters per token).
        await typeInPrompt(page, 'x'.repeat(400));
        view = await probe('opencode-go/kimi-k2');
        assert.match(view.title, /prompt ±100 token/, `estimasi ikut isi kotak: ${view.title}`);

        // Another model: an observed price changes the source line (no request: the cache is used).
        view = await probe('sonnet');
        assert.match(view.title, /harga efektif tercatat/, `estimasi ikut model: ${view.title}`);
        assert.match(view.title, /7 catatan/, 'tooltip: jumlah catatan harga tercatat');

        // Model Auto with no applied model yet: the project's own model is estimated (status.activeModel wins once set).
        view = await probe('opencode-go/kimi-k2', { modelAuto: true });
        assert.match(view.title, /harga list OpenCode Go/, 'Auto memakai status.model selama activeModel kosong');
        assert.match(view.title, /konteks 20\.000 token/, 'Auto: konteks tetap dihitung');

        // A model without any price: no number at all.
        view = await probe('tanpa-harga', { modelAuto: false });
        assert.equal(view.hidden, true, 'tanpa harga: estimasi disembunyikan');

        if (vp.mobile) {
          // 390 px: back on a priced model, one line that never sticks out sideways.
          view = await probe('opencode-go/kimi-k2');
          assert.equal(view.visible, true, 'estimasi tampil lagi di HP');
          assert.equal(await page.eval(horizontalOverflow), null, 'tanpa scroll horizontal dengan estimasi biaya');
          const box = await page.eval(() => {
            const el = document.querySelector('#cost-estimate');
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
            return { width: r.width, right: r.right, viewport: document.documentElement.clientWidth, lines: Math.round(r.height / lineHeight) };
          });
          assert.ok(box.width <= box.viewport && box.right <= box.viewport + 0.5, JSON.stringify(box));
          assert.ok(box.lines <= 1, `satu baris: ${JSON.stringify(box)}`);
        }

        await ensureApp(page, '#demo');
        assert.equal(await page.eval(() => document.querySelector('#cost-estimate')?.hidden ?? true), true, 'project demo tanpa estimasi biaya');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await restorePrices(page);
        await page
          .eval((k) => {
            localStorage.removeItem(k);
            const input = document.querySelector('#prompt');
            if (input) {
              input.value = '';
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }, draftKey())
          .catch(() => {});
        await openApp(page, `#${projectId}`); // the mutated model list/status must not leak into later tests
      }
    });

    test('🤖 Effort Auto: alasan klasifikasi tampil kecil di badge (bukan hanya tooltip), aman & ringkas', async () => {
      await ensureApp(page, `#${projectId}`);
      const prefix = 'uji-auto-why';
      try {
        const view = await page.eval(async (mark) => {
          const { appendChat } = await import('/js/features/chat.js');
          const long = 'prompt menyentuh migrasi database dan seluruh codebase tanpa downtime tanpa regresi apa pun '.repeat(3);
          const add = (suffix, autoEffort) =>
            appendChat({ id: `${mark}-${suffix}`, kind: 'user', text: 'halo', source: 'web', ts: Date.now(), autoEffort }, false);
          add('panjang', { level: 'high', reason: long, source: 'llm' });
          add('html', { level: 'medium', reason: '<b>aman</b> & cepat', source: 'llm' });
          add('fallback', { level: 'low', reason: 'pertanyaan singkat', source: 'fallback' });
          add('tanpa-sumber', { level: 'low', reason: 'tanpa sumber', source: '' });
          const tagOf = (suffix) => document.querySelector(`[data-id="${mark}-${suffix}"] .tag.auto-effort`);
          const read = (suffix) => {
            const tag = tagOf(suffix);
            const why = tag?.querySelector('.auto-why');
            return tag && {
              text: tag.textContent,
              reason: why?.textContent ?? '',
              reasonSize: why ? parseFloat(getComputedStyle(why).fontSize) : null,
              tagSize: parseFloat(getComputedStyle(tag).fontSize),
              title: tag.title,
              aria: tag.getAttribute('aria-label'),
              hasHtml: Boolean(tag.querySelector('b')),
              fallback: tag.classList.contains('fallback'),
            };
          };
          return { long: read('panjang'), html: read('html'), fallback: read('fallback'), none: read('tanpa-sumber'), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        }, prefix);

        assert.match(view.long.text, /^Auto: High/, 'level tetap terbaca');
        assert.ok(view.long.reason.startsWith('· '), 'alasan terlihat, bukan hanya di title');
        const reasonText = view.long.reason.replace(/^·\s*/, '');
        assert.ok(reasonText.length <= 70, `alasan dipotong ~70 karakter (${reasonText.length})`);
        assert.ok(reasonText.endsWith('…'), 'potongan diberi elipsis');
        assert.match(view.long.title, /^Auto: High — prompt menyentuh migrasi/);
        assert.equal(view.long.aria, view.long.title, 'aria-label memuat alasan yang sama');
        assert.ok(view.long.reasonSize < view.long.tagSize, 'teks alasan lebih kecil dari badge-nya');

        assert.equal(view.html.hasHtml, false, 'HTML dari alasan tidak dieksekusi');
        assert.match(view.html.reason, /<b>aman<\/b> & cepat/, 'teks alasan di-escape');

        assert.equal(view.fallback.fallback, true, 'sumber fallback tetap ditandai');
        assert.match(view.fallback.text, /Auto: Low \(fallback\)/);
        assert.match(view.fallback.reason, /pertanyaan singkat/);

        assert.equal(view.none.reason, '', 'tanpa sumber: tanpa alasan');
        assert.equal(view.none.title, 'Auto: Low', 'tanpa sumber: title hanya level');
        assert.equal(view.overflow, 0, 'alasan panjang tidak melebarkan halaman');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await page.eval((mark) => document.querySelectorAll(`[data-id^="${mark}-"]`).forEach((n) => n.remove()), prefix);
      }
    });

    test('🤖 Model Auto: "Auto — sesuaikan task" jadi opsi pertama di kedua mesin', async () => {
      await ensureApp(page, `#${projectId}`);
      try {
        const claude = await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.config = {
            ...state.config,
            models: [
              { value: 'default', displayName: 'Default', description: 'bawaan' },
              { value: 'fable', displayName: 'Fable 5.1', description: 'Paling mampu' },
              { value: 'haiku', displayName: 'Haiku', description: 'Cepat' },
            ],
          };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
          return [...document.querySelectorAll('#model option')].slice(0, 2).map((o) => ({ value: o.value, text: o.textContent, title: o.title }));
        });
        assert.deepEqual(claude.map((o) => o.value), ['auto', ''], 'Claude: Auto lalu Default');
        assert.equal(claude[0].text, 'Auto — sesuaikan task');
        assert.match(claude[0].title, /Hemat \/ Seimbang \/ Kuat \/ Maks/, 'tooltip menjelaskan tier');

        const opencode = await page.eval(async () => {
          const { projectModelOptions } = await import('/js/features/engine.js');
          const entry = { engine: 'opencode', models: [{ value: 'opencode-go/kimi-k3', name: 'Kimi K3' }], current: '', loading: false, error: null };
          const div = document.createElement('div');
          div.innerHTML = projectModelOptions(entry, '', '');
          return [...div.querySelectorAll('option')].slice(0, 2).map((o) => ({ value: o.value, text: o.textContent }));
        });
        assert.deepEqual(opencode.map((o) => o.value), ['auto', ''], 'OpenCode: Auto lalu Default');
        assert.equal(opencode[0].text, 'Auto — sesuaikan task');
      } finally {
        await openApp(page, `#${projectId}`); // the mutated catalog must not leak into later tests
      }
    });

    test('🤖 Model Auto: Auto mengirim {modelAuto:true}, model konkret & Default mematikan Auto', async () => {
      await ensureApp(page, `#${projectId}`);
      await stubSettings(page);
      try {
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.config = {
            ...state.config,
            models: [
              { value: 'default', displayName: 'Default', description: 'bawaan' },
              { value: 'sonnet', displayName: 'Sonnet', description: 'Serbaguna' },
            ],
          };
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), model: '', modelAuto: false };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
        });
        await typeInPrompt(page, 'jangan hilang');
        const pick = (value) =>
          page.eval((v) => {
            const select = document.querySelector('#model');
            select.value = v;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }, value);
        await pick('auto');
        await page.waitFor(() => window.__settingsBodies.length === 1, { timeoutMs: 2000, message: 'POST Auto' });
        await pick('sonnet');
        await page.waitFor(() => window.__settingsBodies.length === 2, { timeoutMs: 2000, message: 'POST model konkret' });
        await pick('');
        await page.waitFor(() => window.__settingsBodies.length === 3, { timeoutMs: 2000, message: 'POST Default' });
        const view = await page.eval(() => ({
          bodies: window.__settingsBodies,
          prompt: document.querySelector('#prompt').value,
          selected: document.querySelector('#model').value,
        }));
        assert.deepEqual(view.bodies[0], { modelAuto: true }, 'Auto: hanya flag, tanpa model');
        assert.deepEqual(view.bodies[1], { model: 'sonnet', modelAuto: false }, 'model konkret mematikan Auto');
        assert.deepEqual(view.bodies[2], { model: '', modelAuto: false }, 'Default: model kosong + Auto mati');
        assert.equal(view.selected, '', 'select kembali ke Default');
        assert.equal(view.prompt, 'jangan hilang', 'kotak pesan tidak dikosongkan');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await restoreSettings(page);
        await openApp(page, `#${projectId}`);
      }
    });

    test('🤖 Model Auto: status.modelAuto menampilkan Auto, catatan tier aria-live, tanpa scroll horizontal', async () => {
      await ensureApp(page, `#${projectId}`);
      try {
        const view = await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), model: 'sonnet', modelAuto: true };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
          const select = document.querySelector('#model');
          const note = document.querySelector('#model-price-note');
          return {
            value: select.value,
            selected: select.selectedOptions[0]?.textContent,
            suffix: /\$\d/.test(select.selectedOptions[0]?.textContent ?? ''),
            note: note && { text: note.textContent, hidden: note.hidden, live: note.getAttribute('aria-live'), afterControls: note.previousElementSibling?.classList.contains('controls') },
            label: document.querySelector('#model').closest('label')?.querySelector('span')?.textContent,
          };
        });
        assert.equal(view.value, 'auto', 'status.modelAuto memilih Auto');
        assert.equal(view.selected, 'Auto — sesuaikan task');
        assert.equal(view.label, 'Model', 'label select tetap ada');
        assert.equal(view.suffix, false, 'Auto tanpa akhiran harga');
        assert.equal(view.note.text, 'Model dipilih otomatis: Hemat haiku · Seimbang sonnet · Kuat opus · Maks fable. Sekarang: sonnet.');
        assert.equal(view.note.hidden, false);
        assert.equal(view.note.live, 'polite', 'catatan diumumkan pembaca layar');
        assert.equal(view.note.afterControls, true, 'catatan menempel pada area kontrol');

        // Belum ada model konkret (server belum memilih): catatan tanpa "Sekarang".
        const none = await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), model: '', modelAuto: true };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
          return document.querySelector('#model-price-note').textContent;
        });
        assert.equal(none, 'Model dipilih otomatis: Hemat haiku · Seimbang sonnet · Kuat opus · Maks fable.');

        if (vp.mobile) {
          await page.click('#settings-chip');
          await page.waitFor(() => !document.querySelector('#turn-settings-modal').hidden, { timeoutMs: 2000, message: 'sheet pengaturan giliran' });
        }
        assert.equal(await page.eval(horizontalOverflow), null, 'tanpa scroll horizontal dengan catatan Auto');
        if (vp.mobile) await page.press('Escape');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await page
          .eval(async () => {
            const { state } = await import('/js/core/state.js');
            state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), modelAuto: false, model: '' };
            document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
          })
          .catch(() => {});
      }
    });

    test('🤖 Tangga Model Auto: tautan "Atur tangga…" hanya saat Auto, catatan memuat tangga', async () => {
      await ensureApp(page, `#${projectId}`);
      try {
        const auto = await page.eval(async (catalog) => {
          const { state } = await import('/js/core/state.js');
          state.config = { ...state.config, models: catalog };
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), model: '', modelAuto: true, modelTiers: undefined };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
          const link = document.querySelector('#model-tiers-open');
          const note = document.querySelector('#model-price-note');
          return { text: link?.textContent, hidden: link?.hidden, note: note.textContent, live: note.getAttribute('aria-live') };
        }, CLAUDE_CATALOG);
        assert.equal(auto.text, 'Atur tangga…', 'teks tautan');
        assert.equal(auto.hidden, false, 'tautan tampil saat Auto');
        assert.equal(auto.note, 'Model dipilih otomatis: Hemat haiku · Seimbang sonnet · Kuat opus · Maks fable.', 'catatan memuat tangga bawaan');
        assert.equal(auto.live, 'polite', 'catatan diumumkan pembaca layar');

        // It sits right under the note, in the turn-settings dialog (where .controls always live).
        await page.click('#settings-chip');
        await page.waitFor(() => !document.querySelector('#turn-settings-modal').hidden, { timeoutMs: 2000, message: 'sheet pengaturan giliran' });
        const inSheet = await page.eval(() => {
          const link = document.querySelector('#model-tiers-open');
          const note = document.querySelector('#model-price-note');
          return { visible: Boolean(link?.getClientRects().length), afterNote: note.nextElementSibling === link, dialog: Boolean(link?.closest('#turn-settings-modal')) };
        });
        assert.deepEqual(inSheet, { visible: true, afterNote: true, dialog: true });

        // A concrete model hides the link (the note turns into that model's price line).
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), modelAuto: false, model: 'sonnet' };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
        });
        assert.equal(await page.eval(() => document.querySelector('#model-tiers-open').hidden), true, 'tautan skrip saat model konkret');
        await page.press('Escape');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await openApp(page, `#${projectId}`); // the mutated catalog must not leak into later tests
      }
    });

    test('🤖 Tangga Model Auto: dialog 4 tingkat, bawaan terpilih di kedua mesin', async () => {
      await ensureApp(page, `#${projectId}`);
      try {
        // Claude Code: the app catalog (flat list with displayName).
        await page.eval(async (catalog) => {
          const { state } = await import('/js/core/state.js');
          state.config = { ...state.config, engine: 'claude', models: catalog };
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), model: '', modelAuto: true, modelTiers: undefined };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
        }, CLAUDE_CATALOG);
        await openLadder(page);
        const claude = await page.eval(() => ({
          title: document.querySelector('#tiers-title').textContent,
          labels: [...document.querySelectorAll('#tiers-rows .tiers-name')].map((n) => n.textContent),
          rows: [...document.querySelectorAll('#tiers-rows select')].map((s) => ({ id: s.id, value: s.value, label: s.getAttribute('aria-label'), first: s.options[0]?.value })),
          save: document.querySelector('#tiers-save').textContent,
        }));
        assert.equal(claude.title, 'Tangga Model Auto', 'judul dialog');
        assert.deepEqual(claude.labels, ['Hemat', 'Seimbang', 'Kuat', 'Maks'], 'satu baris per tingkat');
        assert.deepEqual(claude.rows.map((r) => r.id), ['tier-hemat', 'tier-seimbang', 'tier-kuat', 'tier-maks'], 'id per tingkat');
        assert.deepEqual(claude.rows.map((r) => r.value), ['haiku', 'sonnet', 'opus', 'fable'], 'bawaan terpilih');
        assert.deepEqual(claude.rows.map((r) => r.first), ['', '', '', ''], 'opsi Bawaan di tiap baris');
        assert.match(claude.rows[0].label, /Hemat/, 'select punya nama aksesibel');
        assert.equal(claude.save, 'Simpan');
        // Esc closes the dialog and hands focus back to its opener (the sheet stays open).
        await page.press('Escape');
        await sleep(60);
        assert.deepEqual(
          await page.eval(() => ({ tiers: document.querySelector('#model-tiers-modal').hidden, sheet: document.querySelector('#turn-settings-modal').hidden, focus: document.activeElement?.id })),
          { tiers: true, sheet: false, focus: 'model-tiers-open' },
          'Esc menutup dialog, fokus kembali ke tautan',
        );
        await page.press('Escape');

        // OpenCode: the project's own model list (fetched), the same four tiers with its defaults.
        await stubModels(page);
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.config = { ...state.config, engine: 'opencode' };
          // Stage 1: the PROJECT's engine decides (status.engine); config.engine is only the default for new projects.
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), engine: 'opencode', model: '', modelAuto: true, modelTiers: undefined };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitFor(() => document.querySelectorAll('#model optgroup option').length >= 5, { timeoutMs: 3000, message: 'daftar model OpenCode termuat' });
        await openLadder(page);
        const oc = await page.eval(() => [...document.querySelectorAll('#tiers-rows select')].map((s) => ({ id: s.id, value: s.value, groups: [...s.querySelectorAll('optgroup')].map((g) => g.label), options: [...s.options].map((o) => o.value) })));
        assert.equal(oc.length, 4, 'empat tingkat untuk OpenCode');
        assert.deepEqual(oc.map((r) => r.value), defaultTierValues('opencode'), 'bawaan OpenCode terpilih');
        assert.deepEqual(oc[0].groups, ['opencode-go'], 'dikelompokkan per provider');
        assert.ok(oc[0].options.includes(''), 'opsi Bawaan ada');
        assert.ok(oc[0].options.includes('opencode-go/hemat-lain'), 'model project ikut ditawarkan');
        await page.press('Escape');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await restoreModels(page);
        await openApp(page, `#${projectId}`);
      }
    });

    test('🤖 Tangga Model Auto: Simpan mengirim tangga mesin aktif, kosong = "", catatan mengikuti, galat inline', async () => {
      await ensureApp(page, `#${projectId}`);
      await stubModels(page);
      await stubSettings(page);
      try {
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.config = { ...state.config, engine: 'opencode' };
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), engine: 'opencode', model: '', modelAuto: true, modelTiers: undefined };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitFor(() => document.querySelectorAll('#model optgroup option').length >= 5, { timeoutMs: 3000, message: 'daftar model OpenCode termuat' });
        await openLadder(page);
        assert.equal(await page.eval(horizontalOverflow), null, 'dialog tangga tanpa scroll horizontal');
        await page.eval(() => {
          const pick = (id, value) => {
            const el = document.querySelector(id);
            el.value = value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          };
          pick('#tier-hemat', 'opencode-go/hemat-lain');
          pick('#tier-kuat', ''); // Bawaan: cleared back to the default
        });
        await page.click('#tiers-save');
        await page.waitFor(() => window.__settingsBodies.length === 1, { timeoutMs: 2000, message: 'POST tangga model' });
        await page.waitFor(() => document.querySelector('#model-tiers-modal').hidden, { timeoutMs: 2000, message: 'dialog tertutup setelah simpan' });
        const saved = await page.eval(() => ({
          body: window.__settingsBodies[0],
          open: !document.querySelector('#model-tiers-modal').hidden,
          note: document.querySelector('#model-price-note').textContent,
          toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
        }));
        assert.deepEqual(saved.body, {
          modelTiers: { opencode: { hemat: 'opencode-go/hemat-lain', seimbang: 'opencode-go/glm-5.3-flash', kuat: '', maks: 'opencode-go/glm-5.3' } },
        }, 'badan: hanya mesin aktif, slot yang dikosongkan = ""');
        assert.equal(saved.open, false, 'dialog tertutup setelah tersimpan');
        assert.ok(saved.toasts.some((t) => /Tangga model Auto disimpan/.test(t)), saved.toasts.join(' | '));
        assert.equal(saved.note, 'Model dipilih otomatis: Hemat hemat-lain · Seimbang glm-5.3-flash · Kuat deepseek-v4-pro · Maks glm-5.3.', 'catatan memakai tangga tersimpan (slot kosong = bawaan)');

        // Reopening shows the saved ladder; a cleared slot shows the default again.
        await openLadder(page);
        assert.deepEqual(
          await page.eval(() => ['hemat', 'seimbang', 'kuat', 'maks'].map((t) => document.querySelector(`#tier-${t}`).value)),
          ['opencode-go/hemat-lain', 'opencode-go/glm-5.3-flash', 'opencode-go/deepseek-v4-pro', 'opencode-go/glm-5.3'],
          'tangga tersimpan dipilih ulang',
        );

        // The server refuses: the dialog stays open with the reason, the note goes back.
        await page.eval(async () => {
          // keep the engine/ladder deterministic: another test's broadcast must not flip this project to Claude
          const { state } = await import('/js/core/state.js');
          state.config = { ...state.config, engine: 'opencode' };
          state.statuses[state.active] = {
            ...(state.statuses[state.active] ?? {}),
            engine: 'opencode',
            modelAuto: true,
            modelTiers: { opencode: { hemat: 'opencode-go/hemat-lain', seimbang: 'opencode-go/glm-5.3', maks: 'opencode-go/kimi-k3' } },
          };
          window.__settingsFail = true;
          const el = document.querySelector('#tier-maks');
          el.value = 'opencode-go/hemat-lain';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.click('#tiers-save');
        await page.waitFor(() => window.__settingsBodies.length === 2 && !document.querySelector('#tiers-error').hidden, { timeoutMs: 2000, message: 'POST tangga model gagal' });
        const failed = await page.eval(() => ({
          open: !document.querySelector('#model-tiers-modal').hidden,
          error: document.querySelector('#tiers-error').textContent,
          errorHidden: document.querySelector('#tiers-error').hidden,
          note: document.querySelector('#model-price-note').textContent,
          save: { text: document.querySelector('#tiers-save').textContent, disabled: document.querySelector('#tiers-save').disabled },
        }));
        assert.equal(failed.open, true, 'dialog tetap terbuka saat gagal');
        assert.equal(failed.errorHidden, false);
        assert.match(failed.error, /Model tidak dikenal mesin ini/, 'alasan server inline');
        assert.match(failed.note, /Maks kimi-k3\.$/, 'catatan kembali ke tangga tersimpan');
        assert.deepEqual(failed.save, { text: 'Simpan', disabled: false }, 'tombol siap lagi');
        await page.press('Escape');
        assert.deepEqual(realProblems(page).filter((p) => !/400/.test(p.text)), [], '400 wajar, bukan error console lain');
      } finally {
        await restoreSettings(page);
        await restoreModels(page);
        await openApp(page, `#${projectId}`);
      }
    });

    test('🤖 Tangga Model Auto: tanpa daftar model, tiap baris jadi input teks ber-placeholder', async () => {
      const pid = await addTempProject(`tiers-${vp.mobile ? 'hp' : 'laptop'}`);
      try {
        await openApp(page, `#${pid}`);
        await stubModels(page, []); // the project has no list yet (nothing to pick from)
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.config = { ...state.config, engine: 'opencode' };
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), engine: 'opencode', model: '', modelAuto: true, modelTiers: undefined };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitFor(() => /Daftar model muncul/.test(document.querySelector('#model')?.innerHTML ?? ''), { timeoutMs: 3000, message: 'daftar model kosong' });
        await openLadder(page);
        const rows = await page.eval(() => [...document.querySelectorAll('#tiers-rows [data-tier]')].map((el) => ({ tag: el.tagName, value: el.value, placeholder: el.getAttribute('placeholder'), label: el.getAttribute('aria-label') })));
        assert.deepEqual(rows.map((r) => r.tag), ['INPUT', 'INPUT', 'INPUT', 'INPUT'], 'tanpa daftar: input teks');
        assert.match(rows[0].placeholder, /opencode-go\//, 'placeholder berisi contoh id');
        assert.equal(rows[0].value, 'opencode-go/deepseek-v4.1-flash', 'bawaan tetap terisi walau daftar kosong');
        assert.match(rows[3].label, /Maks/, 'input punya nama aksesibel');
        assert.equal(await page.eval(horizontalOverflow), null, 'tanpa scroll horizontal');
        await page.press('Escape');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await restoreModels(page);
        await forgetTempProject(pid);
      }
    });

    test('setiap .modal: buka → fokus masuk, Tab terkurung, Esc menutup, fokus kembali', async (t) => {
      // A real project (sessions-modal) with an empty chat: on a phone the welcome card is help-modal's only trigger,
      // and toko's chat may already have messages from other tests.
      const pid = await addTempProject(`modal-${vp.mobile ? 'hp' : 'laptop'}`);
      try {
        await openApp(page, `#${pid}`);
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
      } finally {
        await forgetTempProject(pid);
      }
    });

    test('Laporan: Per mesin (4 label, % dari total, biaya) dan petunjuk biaya di kartu KPI', async () => {
      await ensureApp(page, '#demo');
      await stubReport(page, reportSummary());
      try {
        await tap(page, '#btn-report');
        await page.waitFor(() => document.querySelectorAll('#report-engines tbody tr').length === 4, { timeoutMs: 4000, message: 'blok Per mesin dengan 4 baris' });
        assert.equal(await page.eval(() => document.querySelector('#report-modal .report-more')?.open), false, 'rincian laporan dilipat dulu');
        await page.eval(() => (document.querySelector('#report-modal .report-more').open = true));
        const view = await page.eval(() => {
          const box = document.querySelector('#report-engines');
          const kpis = [...document.querySelectorAll('#report-kpis > div')];
          return {
            heading: box.querySelector('h4')?.textContent,
            heads: [...box.querySelectorAll('thead th')].map((th) => th.textContent),
            rows: [...box.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent)),
            kpis: kpis.length,
            costKpi: kpis.at(-1)?.textContent ?? '',
            hint: kpis.at(-1)?.querySelector('.kpi-hint')?.textContent ?? '',
          };
        });
        assert.equal(view.heading, 'Per mesin');
        // No request/turn columns: those counts only exist on one surface each.
        assert.deepEqual(view.heads, ['Mesin · sumber', 'Total', '%', 'Biaya']);
        assert.deepEqual(view.rows, [
          ['Claude · Web', '500', '50%', '$0.50'],
          ['Claude · Terminal', '300', '30%', '— (belum ada biaya)'], // null cost, nothing known
          ['OpenCode · Web', '150', '15%', '$0.00 (50%)'], // 0 is a real $0.00, seen on half the records
          ['OpenCode · Terminal', '50', '5%', '$0.25'],
        ]);
        assert.equal(view.kpis, 4, 'petunjuk tetap di dalam 4 kartu, bukan kartu ke-5');
        assert.match(view.costKpi, /\$0\.75/);
        assert.equal(view.hint, '60% catatan punya biaya');
        assert.equal(await page.eval(horizontalOverflow), null, 'tanpa scroll horizontal');
        assert.deepEqual(await page.eval(unnamedButtons, '#report-modal'), []);
      } finally {
        await restoreReport(page);
      }
    });

    test('Laporan: baris mesin kosong dan server lama tanpa byEngineSource, state kosong tetap muncul', async () => {
      await ensureApp(page, '#demo');
      const rows = reportSummary().byEngineSource;
      await stubReport(page, reportSummary({ byEngineSource: rows.map((r) => (r.key === 'claude:cli' ? { ...r, records: 0 } : r)) }));
      try {
        await tap(page, '#btn-report');
        await page.waitFor(() => document.querySelectorAll('#report-engines tbody tr').length === 3, { timeoutMs: 4000, message: 'baris tanpa catatan disembunyikan' });
        const labels = await page.eval(() => [...document.querySelectorAll('#report-engines tbody tr td:first-child')].map((td) => td.textContent));
        assert.deepEqual(labels, ['Claude · Web', 'OpenCode · Web', 'OpenCode · Terminal'], 'baris records 0 tidak tampil');

        // An older server sends no byEngineSource at all: the block disappears, the rest stays.
        await page.eval((p) => (window.__reportPayload = p), reportSummary({ byEngineSource: undefined, totals: { ...reportSummary().totals, costUsd: null, costCoverage: 0 } }));
        await page.click('#report-periods [data-period="30"]');
        await page.waitFor(
          () => document.querySelector('#report-engines').hidden && document.querySelector('#report-kpis .kpi-hint')?.textContent === 'belum ada biaya tercatat',
          { timeoutMs: 4000, message: 'tanpa byEngineSource: blok hilang, petunjuk biaya muncul' },
        );
        const old = await page.eval(() => ({
          empty: document.querySelector('#report-engines').innerHTML,
          bodyHidden: document.querySelector('#report-body').hidden,
          models: document.querySelectorAll('#report-models tbody tr').length,
          cost: [...document.querySelectorAll('#report-kpis > div')].at(-1).textContent,
        }));
        assert.equal(old.empty, '', 'blok Per mesin tidak menyisakan markup');
        assert.equal(old.bodyHidden, false, 'data lain (model, tren) tetap tampil');
        assert.equal(old.models, 1);
        assert.match(old.cost, /—\s*belum ada biaya tercatat/);

        // No records in the period: the empty message replaces the whole preview body.
        await page.eval((p) => (window.__reportPayload = p), reportSummary({ records: 0 }));
        await page.click('#report-periods [data-period="month"]');
        await page.waitFor(() => !document.querySelector('#report-empty').hidden, { timeoutMs: 4000, message: 'pesan periode kosong' });
        const empty = await page.eval(() => ({ text: document.querySelector('#report-empty').textContent, bodyHidden: document.querySelector('#report-body').hidden }));
        assert.match(empty.text, /Tidak ada pemakaian di periode ini/);
        assert.equal(empty.bodyHidden, true, 'state kosong menyembunyikan seluruh pratinjau');
      } finally {
        await restoreReport(page);
      }
    });

    test('Laporan: cakupan Semua akun mengirim accountId "all" dan menampilkan Claude + OpenCode', async () => {
      await ensureApp(page, '#demo');
      await stubReport(page, reportSummary());
      try {
        await tap(page, '#btn-report');
        await page.waitFor(() => (window.__reportCalls ?? []).length >= 1, { timeoutMs: 4000, message: 'ringkasan akun aktif' });
        const options = await page.eval(() => [...document.querySelector('#report-account').options].map((o) => ({ value: o.value, text: o.textContent })));
        assert.deepEqual(options[0], { value: 'all', text: 'Semua akun (Claude + OpenCode)' }, 'opsi Semua akun paling atas');
        assert.deepEqual(options.slice(1).map((o) => o.value), ['uji'], 'opsi per akun tetap ada');
        assert.equal(await page.eval(() => document.querySelector('#report-account').value), 'uji', 'default tetap akun aktif');
        assert.deepEqual((await reportCalls(page)).map((c) => c.accountId), ['uji'], 'buka dialog: akun aktif');

        // "Semua akun": both engines in one preview, no email in the scope.
        await page.eval(() => {
          const select = document.querySelector('#report-account');
          select.value = 'all';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitFor(() => (window.__reportCalls ?? []).at(-1)?.accountId === 'all' && document.querySelector('#report-range').textContent.includes('Semua akun'), { timeoutMs: 4000, message: 'ringkasan Semua akun' });
        const all = await page.eval(() => ({
          range: document.querySelector('#report-range').textContent,
          scope: document.querySelector('#report-scope').textContent,
          engines: [...document.querySelectorAll('#report-engines tbody tr td:first-child')].map((td) => td.textContent),
          models: document.querySelectorAll('#report-models tbody tr').length,
          call: window.__reportCalls.at(-1),
        }));
        assert.match(all.range, /^📅 Semua akun · Claude \+ OpenCode · .+ · per (hari|minggu|bulan)/);
        assert.match(all.scope, /PDF berisi persis yang tampil di atas: Semua akun · Claude \+ OpenCode/);
        assert.doesNotMatch(all.scope, /uji@example\.com/, 'tanpa email');
        assert.deepEqual(all.engines, ['Claude · Web', 'Claude · Terminal', 'OpenCode · Web', 'OpenCode · Terminal'], 'dua mesin tampil bersama');
        assert.equal(all.models, 1, 'total, tren, dan model tetap tampil');
        assert.equal(all.call.accountId, 'all');
        assert.equal(all.call.groupBy, 'day');
        assert.equal(await page.eval(horizontalOverflow), null, 'tanpa scroll horizontal');

        // Back to one account: that account's id is sent again and the scope drops "Semua akun".
        await page.eval(() => {
          const select = document.querySelector('#report-account');
          select.value = 'uji';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitFor(() => (window.__reportCalls ?? []).at(-1)?.accountId === 'uji' && !document.querySelector('#report-range').textContent.includes('Semua akun'), { timeoutMs: 4000, message: 'kembali ke satu akun' });
        const back = await page.eval(() => ({ range: document.querySelector('#report-range').textContent, scope: document.querySelector('#report-scope').textContent }));
        assert.equal((await reportCalls(page)).at(-1).accountId, 'uji');
        assert.doesNotMatch(back.range, /Semua akun/);
        assert.match(back.scope, /uji@example\.com/, 'akun lagi menyebut emailnya');

        // No accounts at all (a fresh install): the option stays, the existing message appears, nothing crashes.
        await stubReport(page, reportSummary({ records: 0 }), []);
        await page.eval(() => (document.querySelector('#report-modal').hidden = true));
        await tap(page, '#btn-report');
        await page.waitFor(() => document.querySelector('#report-account').options[1]?.value === '', { timeoutMs: 4000, message: 'opsi tanpa akun (Belum ada data)' });
        await page.waitFor(() => !document.querySelector('#report-empty').hidden, { timeoutMs: 4000, message: 'pesan tanpa data' });
        const none = await page.eval(() => ({
          options: [...document.querySelector('#report-account').options].map((o) => o.value),
          value: document.querySelector('#report-account').value,
          text: document.querySelector('#report-empty').textContent,
          pdf: document.querySelector('#report-pdf').disabled,
          calls: window.__reportCalls.length,
        }));
        assert.deepEqual(none.options, ['all', ''], 'opsi Semua akun tetap ada; penanda "Belum ada data" di bawahnya');
        assert.equal(none.value, '', 'tanpa akun: tidak ada yang terpilih');
        assert.match(none.text, /Belum ada pemakaian yang tercatat/);
        assert.equal(none.pdf, true, 'PDF nonaktif tanpa akun');
        assert.equal(none.calls, 0, 'tidak ada request ringkasan tanpa akun');
        assert.deepEqual(realProblems(page), [], 'tanpa error console');
      } finally {
        await restoreReport(page);
      }
    });

    test('⚙ Pengaturan: bagian jadi tab di desktop dan HP', async () => {
      await ensureApp(page, `#${projectId}`);
      await tap(page, '#btn-settings');
      await settle(page, 'settings-modal');
      const tabs = await page.eval(() =>
        [...document.querySelectorAll('#settings-tabs [data-settings-tab]')].map((b) => ({
          tab: b.dataset.settingsTab,
          hidden: b.hidden,
          shown: Boolean(b.getClientRects().length),
          selected: b.getAttribute('aria-selected'),
        })),
      );
      const panels = await page.eval(() =>
        [...document.querySelectorAll('#settings-modal [data-settings-panel]')].map((p) => ({
          panel: p.dataset.settingsPanel,
          shown: Boolean(p.getClientRects().length),
          on: p.classList.contains('on'),
        })),
      );
      assert.equal(await shownInPage(page, '#settings-tabs'), true, 'bar tab tampil di desktop dan HP');
      assert.deepEqual(tabs.filter((t) => t.shown).map((t) => t.tab), ['umum', 'tim', 'jadwal', 'notifikasi', 'spotify', 'cadangan', 'sistem'], 'semua bagian punya tab');
      assert.deepEqual(panels.filter((p) => p.shown).map((p) => p.panel), ['umum'], 'hanya bagian tab aktif yang tampil');
      await page.click('[data-settings-tab="cadangan"]');
      assert.equal(await shownInPage(page, '#settings-modal .backup'), true, 'tab Cadangan menampilkan backup');
      assert.equal(await shownInPage(page, '[data-settings-panel="umum"]'), false, 'bagian tab lama disembunyikan');
      await page.click('[data-settings-tab="notifikasi"]');
      assert.equal(await shownInPage(page, '#quota-on'), true, 'tab Notifikasi menampilkan kuota');
      await page.click('[data-settings-tab="sistem"]');
      assert.equal(await shownInPage(page, '#cc-status'), true, 'tab Sistem menampilkan kompatibilitas');
      await page.click('[data-settings-tab="umum"]');
      await page.press('ArrowRight');
      assert.equal(await page.eval(() => document.activeElement?.dataset.settingsTab), 'tim', 'panah kanan pindah tab');
      await page.press('Escape');
    });

    test('👋 Tur singkat: empat langkah, selesai menandai perangkat', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval(async () => (await import('/js/features/tour.js')).openTour());
      await page.waitFor(() => !document.querySelector('#tour-modal').hidden, { timeoutMs: 3000, message: 'tur terbuka' });
      assert.match(await page.eval(() => document.querySelector('#tour-progress').textContent), /^1 \/ 4$/);
      for (let i = 0; i < 3; i += 1) await page.click('#tour-next');
      assert.match(await page.eval(() => document.querySelector('#tour-progress').textContent), /^4 \/ 4$/);
      assert.equal(await page.eval(() => document.querySelector('#tour-next').textContent), 'Selesai');
      await page.click('#tour-next');
      await page.waitFor(() => document.querySelector('#tour-modal').hidden, { timeoutMs: 3000, message: 'tur selesai' });
      assert.equal(await page.eval(() => localStorage.getItem('office.tourDone')), '1');
    });

    test('🔔 Toast menumpuk rapi, maksimal 3, dan pesan yang sama tidak dobel', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval(async () => {
        document.querySelector('#toasts')?.remove();
        const { toast } = await import('/js/core/api.js');
        toast('satu', 'ok');
        toast('dua', 'ok');
        toast('tiga', 'error');
        toast('empat', 'ok');
      });
      const view = await page.eval(() => {
        const box = document.querySelector('#toasts');
        const items = [...document.querySelectorAll('.toast')];
        return {
          box: Boolean(box),
          count: items.length,
          texts: items.map((t) => t.textContent),
          pointer: box ? getComputedStyle(box).pointerEvents : null,
          rects: items.map((t) => {
            const r = t.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
          }),
        };
      });
      assert.equal(view.box, true, 'satu wadah toast');
      assert.equal(view.count, 3, 'maksimal 3 toast tampil');
      assert.deepEqual(view.texts, ['dua', 'tiga', 'empat'], 'yang terlama dibuang');
      assert.equal(view.pointer, 'none', 'wadah toast tidak menelan klik');
      for (let i = 1; i < view.rects.length; i++) {
        assert.ok(view.rects[i].top >= view.rects[i - 1].bottom, `toast ${i} tidak menimpa toast sebelumnya (${JSON.stringify(view.rects)})`);
      }
      const roles = await page.eval(() => [...document.querySelectorAll('.toast')].map((t) => [t.textContent, t.getAttribute('role'), getComputedStyle(t).pointerEvents]));
      assert.deepEqual(roles, [['dua', 'status', 'none'], ['tiga', 'alert', 'none'], ['empat', 'status', 'none']], 'peran ARIA tetap dan toast anak juga tembus klik');

      // The same message again is moved to the newest slot, not shown twice.
      await page.eval(async () => (await import('/js/core/api.js')).toast('dua', 'ok'));
      const again = await page.eval(() => ({ count: document.querySelectorAll('.toast').length, texts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }));
      assert.equal(again.count, 3, 'pesan yang sama tidak menambah toast');
      assert.deepEqual(again.texts, ['tiga', 'empat', 'dua'], 'pesan yang sama pindah ke urutan terbaru');
      await page.eval(() => document.querySelector('#toasts')?.remove());
    });

    test('🔍 Cari di chat: saring, sorot, lompat antar hasil, dan tahan render ulang', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval(async (pid) => {
        const { state } = await import('/js/core/state.js');
        const chat = await import('/js/features/chat.js');
        window.__searchSaved = state.chats[pid];
        state.chats[pid] = [
          { id: 'cari-1', project: pid, kind: 'assistant', text: 'apel jeruk', ts: Date.now() },
          { id: 'cari-2', project: pid, kind: 'assistant', text: 'durian manis', ts: Date.now() },
          { id: 'cari-3', project: pid, kind: 'assistant', text: 'durian hijau', ts: Date.now() },
        ];
        chat.renderChat();
      }, projectId);
      try {
        await page.eval(() => document.querySelector('#btn-chat-search').click());
        assert.deepEqual(await page.eval(() => ({ chat: document.querySelector('.chat-wrap').hidden, tab: document.body.dataset.tab, focus: document.activeElement?.id })), { chat: false, tab: 'chat', focus: 'chat-search-input' }, 'membuka pencarian tidak berpindah/menyembunyikan tab chat');
        await page.eval(() => {
          const input = document.querySelector('#chat-search-input');
          input.value = 'durian';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const stateOfSearch = () => page.eval(() => ({
          visible: [...document.querySelectorAll('#chat > [data-id]')].filter((n) => !n.classList.contains('search-hidden')).map((n) => n.dataset.id),
          count: document.querySelector('#chat-search-count').textContent,
          active: document.querySelector('#chat > [data-id].search-active')?.dataset.id ?? null,
          highlight: CSS.highlights?.has('chat-search') ? CSS.highlights.get('chat-search').size : 0,
        }));

        let found = await stateOfSearch();
        assert.deepEqual(found.visible, ['cari-2', 'cari-3'], 'hanya pesan yang cocok');
        assert.equal(found.count, '1/2', 'hasil pertama dari dua');
        assert.equal(found.active, 'cari-2', 'hasil pertama disorot');
        assert.equal(found.highlight, 2, 'teks yang cocok ditandai di kedua pesan');

        // Case-insensitive, and a query with no match says so instead of showing a stale count.
        await page.eval(() => {
          const input = document.querySelector('#chat-search-input');
          input.value = 'DURIAN';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        assert.equal((await stateOfSearch()).count, '1/2', 'tidak beda huruf besar');
        await page.eval(() => {
          const input = document.querySelector('#chat-search-input');
          input.value = 'zzz';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        found = await stateOfSearch();
        assert.equal(found.count, '0 hasil', 'tanpa hasil');
        assert.equal(found.active, null, 'tanpa baris aktif');
        assert.equal(found.highlight, 0, 'tanpa sorotan');
        await page.eval(() => {
          const input = document.querySelector('#chat-search-input');
          input.value = 'durian';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });

        await page.press('Enter');
        found = await stateOfSearch();
        assert.equal(found.count, '2/2', 'Enter ke hasil berikutnya');
        assert.equal(found.active, 'cari-3');
        await page.press('Enter');
        assert.equal((await stateOfSearch()).count, '1/2', 'Enter membungkus ke hasil pertama');
        await page.press('Enter', { shift: true });
        found = await stateOfSearch();
        assert.equal(found.count, '2/2', 'Shift+Enter kembali ke hasil sebelumnya');
        assert.equal(found.active, 'cari-3');

        // A full re-render (reconnect, project event) keeps the query, the filter, the highlight and the position.
        await page.eval(async () => (await import('/js/features/chat.js')).renderChat());
        const kept = await stateOfSearch();
        assert.equal(await page.eval(() => document.querySelector('#chat-search-input').value), 'durian', 'kueri tetap ada');
        assert.deepEqual(kept.visible, ['cari-2', 'cari-3'], 'saringan tetap ada');
        assert.equal(kept.count, '2/2', 'posisi hasil tidak melompat');
        assert.equal(kept.active, 'cari-3');
        assert.equal(kept.highlight, 2, 'sorotan dipasang ulang');

        // Switching project closes the search: the query belongs to the conversation it was typed in.
        const afterSwitch = await page.eval(async (pid) => {
          const { state } = await import('/js/core/state.js');
          state.active = 'demo';
          (await import('/js/features/chat.js')).renderChat();
          const out = { hidden: document.querySelector('#chat-search').hidden, value: document.querySelector('#chat-search-input').value };
          state.active = pid;
          (await import('/js/features/chat.js')).renderChat();
          return out;
        }, projectId);
        assert.deepEqual(afterSwitch, { hidden: true, value: '' }, 'pindah project menutup pencarian');

        // Open it again for the close check (the project re-render above emptied it).
        await page.eval(() => document.querySelector('#btn-chat-search').click());
        await page.eval(() => {
          const input = document.querySelector('#chat-search-input');
          input.value = 'durian';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.eval(() => document.querySelector('#chat-search-close').click());
        assert.equal(await page.eval(() => document.querySelector('#chat-search').hidden), true);
        assert.equal(await page.eval(() => document.querySelectorAll('#chat > .search-hidden').length), 0, 'semua pesan tampil lagi');
        assert.equal(await page.eval(() => CSS.highlights?.has('chat-search') ?? false), false, 'sorotan dibersihkan');
      } finally {
        await page.eval(() => {
          const close = document.querySelector('#chat-search-close');
          if (close && !document.querySelector('#chat-search').hidden) close.click();
        });
        await page.eval(async (pid) => {
          const { state } = await import('/js/core/state.js');
          state.chats[pid] = window.__searchSaved;
          (await import('/js/features/chat.js')).renderChat();
        }, projectId);
      }
    });

    test('📜 Chat panjang: 80 pesan terakhir dulu, "Muat pesan lama" menjaga posisi, pencarian menjangkau semua', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval(async (pid) => {
        const { state } = await import('/js/core/state.js');
        window.__longSaved = state.chats[pid];
        state.chats[pid] = Array.from({ length: 200 }, (_, i) => ({
          id: `panjang-${i}`,
          project: pid,
          kind: 'assistant',
          text: `pesan ${i}`,
          ts: Date.now() - (200 - i) * 60_000,
        }));
        (await import('/js/features/chat.js')).renderChat();
      }, projectId);
      try {
        const first = await page.eval(() => ({
          count: document.querySelectorAll('#chat > [data-id]').length,
          first: document.querySelector('#chat > [data-id]')?.dataset.id ?? null,
          last: [...document.querySelectorAll('#chat > [data-id]')].at(-1)?.dataset.id ?? null,
          btn: document.querySelector('#chat-load-older')?.textContent ?? '',
        }));
        assert.equal(first.count, 80, 'hanya 80 pesan terakhir yang dirender');
        assert.equal(first.first, 'panjang-120');
        assert.equal(first.last, 'panjang-199');
        assert.match(first.btn, /Muat 120 pesan lama/);

        // The row being read keeps its place when 80 older messages are prepended.
        await page.eval(() => (document.querySelector('#chat').scrollTop = 0));
        const anchor = await page.eval(() => document.querySelector('#chat > [data-id="panjang-120"]').getBoundingClientRect().top);
        await page.eval(() => document.querySelector('#chat-load-older').click());
        await sleep(60); // the page settles its anchors in the next couple of frames
        const after = await page.eval(() => ({
          count: document.querySelectorAll('#chat > [data-id]').length,
          first: document.querySelector('#chat > [data-id]')?.dataset.id ?? null,
          btn: document.querySelector('#chat-load-older')?.textContent ?? '',
          top: document.querySelector('#chat > [data-id="panjang-120"]').getBoundingClientRect().top,
          jumpHidden: document.querySelector('#jump-latest').hidden,
        }));
        assert.equal(after.count, 160);
        assert.equal(after.first, 'panjang-40');
        assert.match(after.btn, /Muat 40 pesan lama/);
        assert.ok(Math.abs(after.top - anchor) <= 4, `baris yang dibaca tidak melompat (${anchor} → ${after.top})`);
        assert.equal(after.jumpHidden, false, 'tombol ↓ Terbaru tampil setelah membaca pesan lama');

        await page.eval(() => document.querySelector('#chat-load-older').click());
        assert.equal(await page.eval(() => document.querySelectorAll('#chat > [data-id]').length), 200, 'semua pesan termuat');
        assert.equal(await page.eval(() => document.querySelectorAll('#chat-load-older').length), 0, 'tombol hilang saat semua termuat');

        // Search spans the whole conversation, not only the rendered window.
        await page.eval(async () => (await import('/js/features/chat.js')).renderChat());
        assert.equal(await page.eval(() => document.querySelectorAll('#chat > [data-id]').length), 80, 'render ulang kembali ke jendela terbaru');
        await page.eval(() => document.querySelector('#btn-chat-search').click());
        await page.eval(() => {
          const input = document.querySelector('#chat-search-input');
          input.value = 'pesan 0';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        assert.deepEqual(
          await page.eval(() => ({
            rows: document.querySelectorAll('#chat > [data-id]').length,
            count: document.querySelector('#chat-search-count').textContent,
            active: document.querySelector('#chat > [data-id].search-active')?.dataset.id ?? null,
          })),
          { rows: 200, count: '1/1', active: 'panjang-0' },
          'pesan lama di luar jendela ikut dicari',
        );
        await page.eval(() => document.querySelector('#chat-search-close').click());

        // A message opened from elsewhere (attention/queue/push) is revealed even when older than the window.
        await page.eval(async () => {
          const chat = await import('/js/features/chat.js');
          chat.renderChat();
          window.__revealed = chat.revealChatMessage('panjang-3')?.dataset.id ?? null;
        });
        assert.equal(await page.eval(() => window.__revealed), 'panjang-3', 'revealChatMessage mengembalikan barisnya');
        assert.equal(await page.eval(() => document.querySelectorAll('#chat > [data-id="panjang-3"]').length), 1);
      } finally {
        await page.eval(async (pid) => {
          if (!document.querySelector('#chat-search').hidden) document.querySelector('#chat-search-close').click();
          const { state } = await import('/js/core/state.js');
          state.chats[pid] = window.__longSaved;
          (await import('/js/features/chat.js')).renderChat();
        }, projectId);
      }
    });

    test('🔎 Cari pengaturan: panel yang cocok tampil, yang lain disembunyikan', async () => {
      await ensureApp(page, `#${projectId}`);
      await tap(page, '#btn-settings');
      await settle(page, 'settings-modal');
      const type = (text) => page.eval((value) => {
        const input = document.querySelector('#settings-search');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, text);
      await type('budget');
      assert.equal(await shownInPage(page, '#budget-section'), true, 'budget found');
      assert.equal(await shownInPage(page, '[data-settings-panel="cadangan"]'), false, 'backup hidden');
      await type('jadwal');
      assert.equal(await shownInPage(page, '[data-settings-panel="jadwal"]'), true, 'the schedule panel is shown');
      assert.equal(await shownInPage(page, '#routine-list'), true);
      await type('');
      assert.equal(await shownInPage(page, '[data-settings-panel="umum"]'), true, 'clearing restores the remembered tab');
      await page.press('Escape');
    });

    test('⚠ Perlu perhatian: badge dan daftar di dashboard', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval((pid) => {
        window.__attentionFetch ??= window.fetch;
        window.fetch = (url, opts) =>
          String(url).includes('/api/attention')
            ? Promise.resolve(
                new Response(
                  JSON.stringify({
                    count: 2,
                    items: [
                      { kind: 'budget', project: null, projectName: 'Global', label: 'Budget harian tercapai', detail: 'Prompt dihentikan' },
                      { kind: 'routine', project: pid, projectName: 'toko', label: 'Jadwal gagal', detail: 'Cek CI' },
                    ],
                  }),
                  { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
              )
            : window.__attentionFetch(url, opts);
      }, projectId);
      try {
        await page.eval(async () => (await import('/js/features/attention.js')).loadAttention({ force: true }));
        await page.eval(async () => (await import('/js/features/dashboard.js')).openDashboard());
        await page.waitFor(() => !document.querySelector('#dash-attention').hidden, { timeoutMs: 4000, message: 'daftar perhatian' });
        assert.equal(await page.eval(() => document.querySelectorAll('#dash-attention-list li').length), 2);
        assert.equal(await page.eval(() => document.querySelector('#attention-count').textContent), '2');
        assert.match(await page.eval(() => document.querySelector('#dash-attention').textContent), /Budget harian tercapai/);
        await page.press('Escape');
      } finally {
        await page.eval(async () => {
          window.fetch = window.__attentionFetch;
          await (await import('/js/features/attention.js')).loadAttention({ force: true });
        });
      }
    });

    test('⏰ Perlu perhatian: tunda 1 jam, badge ikut, bertahan saat muat ulang, bisa ditampilkan lagi', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval((pid) => {
        localStorage.removeItem('office.attention.snooze');
        window.__attCalls = 0;
        window.__attentionFetch2 ??= window.fetch;
        window.fetch = (url, opts) => {
          if (!String(url).includes('/api/attention')) return window.__attentionFetch2(url, opts);
          window.__attCalls += 1;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                count: 2,
                items: [
                  { id: 'budget:global', kind: 'budget', project: null, projectName: 'Global', label: 'Budget harian tercapai', detail: 'Prompt dihentikan' },
                  { id: 'routine:r1', kind: 'routine', project: pid, projectName: 'toko', label: 'Jadwal gagal', detail: 'Cek CI' },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        };
      }, projectId);
      const view = () =>
        page.eval(() => ({
          rows: [...document.querySelectorAll('#dash-attention-list li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
          badge: document.querySelector('#attention-count').textContent,
          note: document.querySelector('#dash-attention-note')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
          calls: window.__attCalls,
        }));
      try {
        await page.eval(async () => (await import('/js/features/attention.js')).loadAttention({ force: true }));
        await page.eval(async () => (await import('/js/features/dashboard.js')).openDashboard());
        await page.waitFor(() => !document.querySelector('#dash-attention').hidden, { timeoutMs: 4000, message: 'daftar perhatian' });
        let shown = await view();
        assert.equal(shown.rows.length, 2);
        assert.equal(shown.badge, '2');

        // Tunda the first item: it leaves the list and the badge, without another server round-trip.
        const before = shown.calls;
        await page.eval(() => document.querySelector('#dash-attention-list [data-snooze]').click());
        shown = await view();
        assert.equal(shown.rows.length, 1, 'satu item disembunyikan');
        assert.match(shown.rows[0], /Jadwal gagal/, 'item lain tetap tampil');
        assert.equal(shown.badge, '1', 'badge ikut berkurang');
        assert.equal(shown.calls, before, 'menunda tidak memanggil server');
        assert.match(shown.note, /1 ditunda/, 'jumlah yang ditunda terlihat');
        const stored = await page.eval(() => JSON.parse(localStorage.getItem('office.attention.snooze')));
        assert.ok(stored['budget:global'] > Date.now(), 'tenggat tunda tersimpan');

        // A reload of the list keeps it snoozed.
        await page.eval(async () => (await import('/js/features/attention.js')).loadAttention({ force: true }));
        assert.equal((await view()).rows.length, 1, 'tetap ditunda setelah muat ulang');

        // "Tampilkan" brings it back.
        await page.eval(() => document.querySelector('[data-attention-restore]').click());
        shown = await view();
        assert.equal(shown.rows.length, 2);
        assert.equal(shown.badge, '2');
        assert.equal(shown.note, '', 'catatan tunda hilang');

        // An expired snooze is ignored.
        await page.eval(() => localStorage.setItem('office.attention.snooze', JSON.stringify({ 'budget:global': Date.now() - 1000 })));
        await page.eval(async () => (await import('/js/features/attention.js')).loadAttention({ force: true }));
        assert.equal((await view()).rows.length, 2, 'tunda kedaluwarsa diabaikan');
        await page.press('Escape');
      } finally {
        await page.eval(async () => {
          localStorage.removeItem('office.attention.snooze');
          window.fetch = window.__attentionFetch2;
          await (await import('/js/features/attention.js')).loadAttention({ force: true });
        });
      }
    });

    test('⚖ audit kontras: teks memenuhi WCAG AA di tema terang dan gelap', async () => {
      await ensureApp(page, `#${projectId}`);
      const before = await page.eval(async () => (await import('/js/office/themes.js')).theme.current);
      const audit = async (where) => {
        const problems = await page.eval(contrastProblems);
        assert.deepEqual(problems, [], `kontras ${where}`);
      };
      try {
        for (const id of ['light', 'dark']) {
          await page.eval((themeId) => import('/js/features/theme.js').then((m) => m.applyTheme(themeId)), id);
          await sleep(120);
          await audit(`${id} halaman`);
          await page.eval(async () => (await import('/js/features/dashboard.js')).openDashboard());
          await sleep(200);
          await audit(`${id} dashboard`);
          await page.press('Escape');
          await sleep(80);
          await page.eval(async () => (await import('/js/ui/modals.js')).openModal('settings-modal'));
          await sleep(350);
          await audit(`${id} pengaturan`);
          await page.press('Escape');
          await sleep(80);
          await page.eval(async () => (await import('/js/features/palette.js')).openPalette());
          await sleep(180);
          await audit(`${id} palet`);
          await page.press('Escape');
          await sleep(80);
        }
      } finally {
        await page.eval((themeId) => import('/js/features/theme.js').then((m) => m.applyTheme(themeId)), before);
      }
    });

    test('★ Pesan tersimpan: bintang di chat, daftar di Ctrl+P, buka & hapus', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval(async (pid) => {
        const { state } = await import('/js/core/state.js');
        localStorage.removeItem('office.bookmarks');
        window.__bmSaved = state.chats[pid];
        const now = Date.now();
        state.chats[pid] = [
          { id: 'bm-user', project: pid, kind: 'user', text: 'tolong cek checkout', source: 'web', ts: now - 60_000 },
          { id: 'bm-a', project: pid, kind: 'assistant', text: 'Checkout sudah diperbaiki di src/checkout.ts', ts: now - 30_000 },
        ];
        (await import('/js/features/chat.js')).renderChat();
      }, projectId);
      try {
        assert.equal(await page.eval(() => document.querySelectorAll('#chat [data-id="bm-user"] [data-msg-act="star"]').length), 1, 'bintang di pesan user');
        await page.eval(() => document.querySelector('#chat [data-id="bm-a"] [data-msg-act="star"]').click());
        const saved = await page.eval(() => ({
          stored: JSON.parse(localStorage.getItem('office.bookmarks')),
          pressed: document.querySelector('#chat [data-id="bm-a"] [data-msg-act="star"]').getAttribute('aria-pressed'),
          text: document.querySelector('#chat [data-id="bm-a"] [data-msg-act="star"]').textContent,
        }));
        assert.equal(saved.pressed, 'true');
        assert.equal(saved.text, '★');
        assert.equal(saved.stored[projectId].length, 1);
        assert.match(saved.stored[projectId][0].text, /Checkout sudah diperbaiki/);

        // A rebuild of the chat (reconnect/project event) keeps it starred.
        await page.eval(async () => (await import('/js/features/chat.js')).renderChat());
        assert.equal(await page.eval(() => document.querySelector('#chat [data-id="bm-a"] [data-msg-act="star"]').getAttribute('aria-pressed')), 'true', 'tetap berbintang setelah render ulang');

        await page.eval(async () => (await import('/js/features/bookmarks.js')).openBookmarks());
        const list = await page.eval(() => ({
          note: document.querySelector('#bookmarks-note').textContent,
          text: document.querySelector('#bookmarks-list').textContent.replace(/\s+/g, ' ').trim(),
        }));
        assert.match(list.note, /1 pesan di/);
        assert.match(list.text, /Claude/);
        assert.match(list.text, /Checkout sudah diperbaiki/);

        await page.eval(() => document.querySelector('#bookmarks-list [data-open="bm-a"]').click());
        assert.equal(await page.eval(() => document.querySelector('#bookmarks-modal').hidden), true, 'dialog menutup');
        assert.equal(await page.eval(() => document.querySelectorAll('#chat [data-id="bm-a"].bm-flash').length), 1, 'baris disorot');

        await page.eval(async () => (await import('/js/features/bookmarks.js')).openBookmarks());
        await page.eval(() => document.querySelector('#bookmarks-list [data-remove="bm-a"]').click());
        assert.match(await page.eval(() => document.querySelector('#bookmarks-list').textContent), /Belum ada pesan tersimpan/);
        assert.deepEqual(await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          return JSON.parse(localStorage.getItem('office.bookmarks'))[state.active];
        }), []);
        assert.equal(await page.eval(() => document.querySelector('#chat [data-id="bm-a"] [data-msg-act="star"]').getAttribute('aria-pressed')), 'false', 'bintang kembali kosong di baris');
        await page.press('Escape');
      } finally {
        await page.eval(async (pid) => {
          localStorage.removeItem('office.bookmarks');
          const { state } = await import('/js/core/state.js');
          state.chats[pid] = window.__bmSaved;
          (await import('/js/features/chat.js')).renderChat();
        }, projectId);
      }
    });

    test('⚡ Dashboard: tombol Antrian & Hentikan di kartu project', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval(async (pid) => {
        const { state } = await import('/js/core/state.js');
        window.__dashSaved = { status: state.statuses[pid], projects: state.projects };
        state.statuses[pid] = { ...(state.statuses[pid] ?? {}), busy: true, taskQueue: { waiting: 2, running: 0, paused: false, rev: 99 } };
        window.__stopCalls = [];
        window.__queueCalls = [];
        window.__dashFetch = window.fetch;
        window.fetch = async (url, opts) => {
          const u = String(url);
          if (u.endsWith('/stop')) {
            window.__stopCalls.push(u);
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          if (u.endsWith(`/api/projects/${pid}/queue`)) {
            window.__queueCalls.push(u);
            return new Response(JSON.stringify({ queue: { project: pid, paused: false, rev: 1, items: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return window.__dashFetch(url, opts);
        };
      }, projectId);
      try {
        await page.eval(async () => (await import('/js/features/dashboard.js')).openDashboard());
        await page.waitFor(() => Boolean(document.querySelector('#dash-list [data-dash-stop]')), { timeoutMs: 4000, message: 'tombol hentikan di kartu' });
        const acts = await page.eval((pid) => ({
          queue: document.querySelector(`#dash-list li[data-id="${pid}"] [data-dash-queue]`)?.textContent ?? '',
          stop: document.querySelector(`#dash-list li[data-id="${pid}"] [data-dash-stop]`)?.textContent ?? '',
        }), projectId);
        assert.match(acts.queue, /Antrian 2/);
        assert.equal(acts.stop, '■ Hentikan');

        // Antrian: closes the dashboard and opens the queue of that project (not necessarily the active one).
        await page.eval((pid) => document.querySelector(`#dash-list li[data-id="${pid}"] [data-dash-queue]`).click(), projectId);
        await page.waitFor(() => !document.querySelector('#queue-modal').hidden, { timeoutMs: 4000, message: 'antrian terbuka' });
        assert.equal(await page.eval(() => document.querySelector('#dash-modal').hidden), true, 'dashboard menutup');
        assert.equal(await page.eval(() => window.__queueCalls.length), 1);
        await page.press('Escape');
        await sleep(80);

        // Hentikan: calls that project's stop route and keeps the dashboard open.
        await page.eval(async () => (await import('/js/features/dashboard.js')).openDashboard());
        await page.waitFor(() => Boolean(document.querySelector('#dash-list [data-dash-stop]')), { timeoutMs: 4000, message: 'tombol hentikan kembali' });
        await page.eval((pid) => document.querySelector(`#dash-list li[data-id="${pid}"] [data-dash-stop]`).click(), projectId);
        await page.waitFor(() => window.__stopCalls.length === 1, { timeoutMs: 4000, message: 'panggilan stop' });
        assert.equal(await page.eval((pid) => window.__stopCalls[0].endsWith(`/api/projects/${pid}/stop`), projectId), true);
        assert.equal(await page.eval(() => document.querySelector('#dash-modal').hidden), false, 'dashboard tetap terbuka');
        await page.press('Escape');
      } finally {
        await page.eval(async (pid) => {
          window.fetch = window.__dashFetch;
          const { state } = await import('/js/core/state.js');
          state.statuses[pid] = window.__dashSaved.status;
          state.projects = window.__dashSaved.projects;
          (await import('/js/features/dashboard.js')).renderDashboard();
        }, projectId);
      }
    });

    test('🧭 Dashboard: chip status menyaring kartu dan menghitung semua project', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval(async () => (await import('/js/features/dashboard.js')).openDashboard());
      await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        const now = Date.now();
        window.__chipsSaved = { projects: state.projects, statuses: state.statuses, chats: state.chats, events: state.events, approval: null };
        const mk = (id, name) => ({ id, name, favorite: false, lastActivity: now, path: `C:\\fake\\${id}` });
        state.projects = [mk('f-needs', 'Butuh Izin'), mk('f-work', 'Sedang Kerja'), mk('f-queue', 'Antri'), mk('f-idle', 'Menganggur')];
        state.statuses = { 'f-work': { busy: true }, 'f-queue': { taskQueue: { waiting: 2, running: 0, paused: false, rev: 1 } } };
        state.chats = {};
        state.events = {};
        const approval = { project: 'f-needs', status: 'pending', label: 'Izin bash', ts: now, chatId: 'c1' };
        window.__chipsSaved.approval = approval;
        state.approvals.set('f-needs-1', approval);
        (await import('/js/features/dashboard.js')).renderDashboard();
      });
      const visible = () => page.eval(() => [...document.querySelectorAll('#dash-list li[data-id]')].filter((li) => !li.hidden).map((li) => li.dataset.id).sort());
      try {
        await page.waitFor(() => document.querySelectorAll('#dash-list li[data-id]').length === 4, { timeoutMs: 4000, message: 'empat kartu' });
        assert.deepEqual(await visible(), ['f-idle', 'f-needs', 'f-queue', 'f-work']);
        const chips = await page.eval(() => document.querySelector('#dash-filters').textContent.replace(/\s+/g, ' ').trim());
        assert.match(chips, /Semua 4/);
        assert.match(chips, /Butuh kamu 1/);
        assert.match(chips, /Bekerja 1/);
        assert.match(chips, /Antrian 1/);
        assert.match(chips, /Idle 1/);

        await page.eval(() => document.querySelector('[data-dash-filter="working"]').click());
        assert.deepEqual(await visible(), ['f-work'], 'chip Bekerja');
        assert.equal(await page.eval(() => document.querySelector('[data-dash-filter="working"]').getAttribute('aria-pressed')), 'true');
        await page.eval(() => document.querySelector('[data-dash-filter="needs"]').click());
        assert.deepEqual(await visible(), ['f-needs'], 'chip Butuh kamu');
        await page.eval(() => document.querySelector('[data-dash-filter="all"]').click());
        assert.deepEqual(await visible(), ['f-idle', 'f-needs', 'f-queue', 'f-work'], 'kembali ke semua');
      } finally {
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          const saved = window.__chipsSaved;
          state.projects = saved.projects;
          state.statuses = saved.statuses;
          state.chats = saved.chats;
          state.events = saved.events;
          state.approvals.delete('f-needs-1');
          (await import('/js/features/dashboard.js')).renderDashboard();
        });
        await page.press('Escape');
      }
    });

    test('📲 Panduan: tombol pasang muncul saat browser menawarkan PWA', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval(async () => (await import('/js/ui/modals.js')).openModal('help-modal'));
      await page.waitFor(() => !document.querySelector('#help-modal').hidden, { timeoutMs: 3000, message: 'panduan terbuka' });
      await page.eval(() => {
        const event = new Event('beforeinstallprompt');
        event.prompt = () => {
          window.__installPrompted = true;
        };
        event.userChoice = Promise.resolve({ outcome: 'accepted' });
        window.dispatchEvent(event);
      });
      assert.equal(await page.eval(() => document.querySelector('#install-app').hidden), false, 'tawaran datang: tombol tampil');
      await page.eval(() => {
        window.__installPrompted = false;
        document.querySelector('#install-app').click();
      });
      await page.waitFor(() => window.__installPrompted === true, { timeoutMs: 2000, message: 'dialog pasang dipanggil' });
      await page.waitFor(() => document.querySelector('#install-app').hidden, { timeoutMs: 2000, message: 'tombol hilang setelah dipasang' });
      await page.press('Escape');
    });

    test('📊 Dashboard: ringkasan hari ini dari ledger (biaya, giliran, token, sesi, project)', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval(() => {
        window.__todayFetch = window.fetch;
        window.fetch = (url, opts) =>
          String(url).endsWith('/api/summary/today')
            ? Promise.resolve(
                new Response(
                  JSON.stringify({ today: { from: Date.now(), rows: 9, costUsd: 2.5, costCoverage: 0.75, turns: 3, tokens: 12345, projects: 2, sessions: 4 } }),
                  { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
              )
            : window.__todayFetch(url, opts);
      });
      try {
        await page.eval(async () => {
          const { dashboard } = await import('/js/features/dashboard.js');
          dashboard.today = { at: 0, data: null, loading: false }; // no cached answer from an earlier test
        });
        await page.eval(async () => (await import('/js/features/dashboard.js')).openDashboard());
        await page.waitFor(() => !document.querySelector('#dash-today').hidden, { timeoutMs: 4000, message: 'ringkasan hari ini' });
        const text = await page.eval(() => document.querySelector('#dash-today').textContent.replace(/\s+/g, ' ').trim());
        assert.match(text, /Hari ini/);
        assert.match(text, /\$2,50/, 'biaya hari ini');
        assert.match(text, /75% berbiaya/, 'cakupan biaya');
        assert.match(text, /3 giliran/);
        assert.match(text, /12k token/);
        assert.match(text, /4 sesi/);
        assert.match(text, /2 project/);
        await page.press('Escape');
      } finally {
        await page.eval(() => {
          window.fetch = window.__todayFetch;
        });
      }
    });

    test('🎛️ Tampilan: tema, ukuran teks, kepadatan, dan animasi tersimpan per perangkat', async () => {
      await ensureApp(page, `#${projectId}`);
      await tap(page, '#btn-settings');
      await settle(page, 'settings-modal');
      if (!(await shownInPage(page, '[data-appearance="theme"]'))) await page.click('[data-settings-tab="umum"]');
      const pick = (kind, value) => page.click(`[data-appearance="${kind}"] [data-value="${value}"]`);
      await pick('theme', 'light');
      assert.equal(await page.eval(() => document.documentElement.dataset.appTheme), 'light');
      assert.equal(await page.eval(() => localStorage.getItem('office.appTheme')), 'light');
      await pick('size', 'large');
      assert.equal(await page.eval(() => getComputedStyle(document.documentElement).getPropertyValue('--fs-base').trim()), '16px');
      await pick('density', 'compact');
      assert.equal(await page.eval(() => document.documentElement.dataset.appDensity), 'compact');
      await pick('motion', 'reduce');
      assert.equal(await page.eval(() => document.documentElement.dataset.appMotion), 'reduce');
      // Back to the dark look the older tests assume (the product default stays "system").
      await pick('theme', 'dark');
      await pick('size', 'normal');
      await pick('density', 'comfortable');
      await pick('motion', 'system');
      await page.press('Escape');
    });

    test('⏰ Tugas terjadwal: validasi, tambah, ubah, jalankan sekarang, jeda, hapus', async () => {
      await ensureApp(page, `#${projectId}`);
      await tap(page, '#btn-settings');
      await settle(page, 'settings-modal');
      await page.click('[data-settings-tab="jadwal"]');
      await page.waitFor(() => document.querySelector('#routine-project')?.options.length > 0 && !/Memuat jadwal/.test(document.querySelector('#routine-list')?.textContent ?? ''), { timeoutMs: 4000, message: 'tab jadwal siap' });

      await page.click('#routine-add');
      assert.match(await page.eval(() => document.querySelector('#routine-error').textContent), /Prompt jadwal masih kosong/);

      await page.eval(() => {
        document.querySelector('#routine-prompt').value = 'cek CI lalu laporkan';
        document.querySelector('#routine-frequency').value = 'daily';
        document.querySelector('#routine-frequency').dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#routine-time').value = '09:00';
      });
      await page.click('#routine-add');
      await page.waitFor(() => document.querySelectorAll('.routine-item').length === 1, { timeoutMs: 4000, message: 'jadwal tersimpan' });
      assert.match(await page.eval(() => document.querySelector('.routine-item').textContent), /Harian 09:00/);
      // The success toast sits above the form: it must never swallow the next click on the button underneath.
      assert.equal(await page.eval(() => getComputedStyle(document.querySelector('.toast.ok')).pointerEvents), 'none', 'toast tidak menghalangi klik');

      // Edit: the form is filled, the save button switches, the prompt is replaced.
      await page.click('.routine-item [data-routine-edit]');
      assert.equal(await page.eval(() => document.querySelector('#routine-prompt').value), 'cek CI lalu laporkan');
      assert.match(await page.eval(() => document.querySelector('#routine-add').textContent), /Simpan perubahan/);
      await page.eval(() => (document.querySelector('#routine-prompt').value = 'cek CI versi 2'));
      await page.click('#routine-add');
      await page.waitFor(() => /cek CI versi 2/.test(document.querySelector('.routine-item')?.textContent ?? ''), { timeoutMs: 4000, message: 'jadwal diperbarui' });

      // Jalankan sekarang: the prompt goes into the queue and the chat says so.
      await page.click('.routine-item [data-routine-run]');
      await page.waitFor(() => [...document.querySelectorAll('.info')].some((n) => /dijalankan manual/.test(n.textContent)), { timeoutMs: 4000, message: 'jadwal dijalankan manual' });
      await page.waitFor(() => /terakhir selesai/.test(document.querySelector('.routine-item')?.textContent ?? ''), { timeoutMs: 10000, message: 'riwayat hasil jadwal' });


      await page.click('.routine-item [data-routine-toggle]');
      await page.waitFor(() => document.querySelector('.routine-item')?.classList.contains('off'), { timeoutMs: 4000, message: 'jadwal dijeda' });
      await page.click('.routine-item [data-routine-delete]');
      await page.waitFor(() => document.querySelectorAll('.routine-item').length === 0, { timeoutMs: 4000, message: 'jadwal dihapus' });
      await page.press('Escape');
    });

    test('🔀 Mesin project: nilai dari status project, konfirmasi, route baru, 409 inline', async () => {
      await ensureApp(page, `#${projectId}`);
      // This laptop has no OpenCode: pretend it is installed, and answer the new route from the test (409 once).
      await page.eval(async (id) => {
        const { state } = await import('/js/core/state.js');
        window.__pe = { prevConfig: state.config, prevEngine: state.statuses[id]?.engine, calls: [], confirms: [] };
        state.config = {
          ...state.config,
          engine: 'claude',
          engines: { ...state.config.engines, opencode: { ...(state.config.engines?.opencode ?? {}), available: true, caps: state.config.engines?.opencode?.caps } },
        };
        state.statuses[id] = { ...(state.statuses[id] ?? {}), engine: 'claude' };
        window.__peConfirm = window.confirm;
        window.confirm = (text) => {
          window.__pe.confirms.push(String(text));
          return true;
        };
        window.__officeFetch ??= window.fetch;
        const prev = window.fetch;
        window.fetch = (url, opts) => {
          if (String(url) === `/api/projects/${id}/engine` && String(opts?.method ?? '').toUpperCase() === 'POST') {
            window.__pe.calls.push(JSON.parse(opts.body ?? '{}'));
            const fail = window.__pe.calls.length === 1;
            const body = fail ? { error: 'Masih ada permintaan izin yang menunggu jawaban. Jawab dulu, lalu ganti mesin.' } : { ok: true, engine: 'opencode' };
            return Promise.resolve(new Response(JSON.stringify(body), { status: fail ? 409 : 200, headers: { 'Content-Type': 'application/json' } }));
          }
          return prev(url, opts);
        };
        const { syncProjectEngine } = await import('/js/features/settings.js');
        syncProjectEngine();
      }, projectId);
      try {
        await tap(page, '#btn-settings');
        await settle(page, 'settings-modal');
        await page.click('[data-settings-tab="tim"]');
        await page.waitFor(() => document.querySelector('#project-engine-opts [data-project-engine="claude"]'), { timeoutMs: 3000, message: 'pilihan mesin project' });
        const before = await page.eval(() => ({
          pressed: [...document.querySelectorAll('#project-engine-opts [data-project-engine]')].map((b) => [b.dataset.projectEngine, b.getAttribute('aria-pressed'), b.disabled]),
          desc: document.querySelector('#project-engine-desc').textContent,
          hint: document.querySelector('#project-engine-hint').textContent,
        }));
        assert.deepEqual(before.pressed, [['claude', 'true', false], ['opencode', 'false', false]], 'status project = Claude Code');
        assert.match(before.desc, /Riwayat tiap mesin disimpan terpisah\. Berganti mesin hanya menampilkan riwayat mesin itu/);
        assert.match(before.hint, /Project ini memakai Claude Code/);
        assert.deepEqual(await page.eval(unnamedButtons, '#project-engine'), [], 'pilihan mesin punya nama aksesibel');
        assert.equal(await page.eval(horizontalOverflow), null, 'tanpa scroll horizontal di 390px');

        // 1st try: the server refuses (open approval) — the message is inline and the old value stays.
        await page.click('#project-engine-opts [data-project-engine="opencode"]');
        await page.waitFor(() => document.querySelector('#project-engine-error').textContent.includes('permintaan izin'), { timeoutMs: 3000, message: 'galat 409 inline' });
        const refused = await page.eval(() => ({
          calls: window.__pe.calls,
          confirms: window.__pe.confirms,
          error: document.querySelector('#project-engine-error').textContent,
          role: document.querySelector('#project-engine-error').getAttribute('role'),
          pressed: [...document.querySelectorAll('#project-engine-opts [data-project-engine]')].map((b) => [b.dataset.projectEngine, b.getAttribute('aria-pressed')]),
          enabled: [...document.querySelectorAll('#project-engine-opts [data-project-engine]')].every((b) => !b.disabled),
        }));
        assert.deepEqual(refused.calls, [{ engine: 'opencode' }], 'POST ke route project, bukan /api/engine');
        assert.match(refused.confirms[0], /Riwayat tiap mesin disimpan terpisah/);
        assert.match(refused.confirms[0], /Project lain tidak terpengaruh/);
        assert.equal(refused.role, 'alert');
        assert.match(refused.error, /permintaan izin/);
        assert.deepEqual(refused.pressed, [['claude', 'true'], ['opencode', 'false']], 'nilai lama tetap setelah 409');
        assert.equal(refused.enabled, true, 'tombol bisa dicoba lagi');

        // 2nd try: accepted — the toast names the engine (the SSE status then redraws the selector).
        await page.click('#project-engine-opts [data-project-engine="opencode"]');
        await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Project ini sekarang memakai OpenCode\./.test(t.textContent)), { timeoutMs: 3000, message: 'toast sukses' });
        const accepted = await page.eval(() => ({ calls: window.__pe.calls.length, error: document.querySelector('#project-engine-error').textContent }));
        assert.equal(accepted.calls, 2);
        assert.equal(accepted.error, '', 'galat lama dibersihkan sebelum percobaan berikutnya');
        assert.deepEqual(realProblems(page), [], 'tanpa error console');
      } finally {
        await page.eval(async (id) => {
          const { state } = await import('/js/core/state.js');
          if (window.__officeFetch) window.fetch = window.__officeFetch;
          if (window.__peConfirm) window.confirm = window.__peConfirm;
          if (window.__pe) {
            state.config = window.__pe.prevConfig;
            state.statuses[id] = { ...(state.statuses[id] ?? {}), engine: window.__pe.prevEngine };
          }
          delete window.__pe;
          delete window.__peConfirm;
          (await import('/js/features/settings.js')).syncProjectEngine();
        }, projectId).catch(() => {});
        await page.press('Escape').catch(() => {});
      }
    });

    test('🔀 Mesin project: demo dan halaman hanya-lihat dinonaktifkan dengan alasan', async () => {
      await ensureApp(page, '#demo');
      await tap(page, '#btn-settings');
      await settle(page, 'settings-modal');
      await page.click('[data-settings-tab="tim"]');
      const demo = await page.eval(() => ({
        disabled: [...document.querySelectorAll('#project-engine-opts [data-project-engine]')].map((b) => b.disabled),
        hint: document.querySelector('#project-engine-hint').textContent,
      }));
      assert.deepEqual(demo.disabled, [true, true], 'demo: tidak bisa mengganti mesin');
      assert.match(demo.hint, /Pilih project nyata/);
      await page.press('Escape');

      await ensureApp(page, `#${projectId}`);
      const ro = await page.eval(async (id) => {
        const { state } = await import('/js/core/state.js');
        const { syncProjectEngine } = await import('/js/features/settings.js');
        window.__roPrev = state.readOnly;
        state.readOnly = true;
        syncProjectEngine();
        const out = {
          disabled: [...document.querySelectorAll('#project-engine-opts [data-project-engine]')].map((b) => b.disabled),
          hint: document.querySelector('#project-engine-hint').textContent,
        };
        state.readOnly = window.__roPrev;
        delete window.__roPrev;
        syncProjectEngine();
        return { ...out, id };
      }, projectId);
      assert.deepEqual(ro.disabled, [true, true], 'WiFi hanya-lihat: tombol mati');
      assert.match(ro.hint, /Hanya lihat lewat WiFi/);
      assert.deepEqual(realProblems(page), [], 'tanpa error console');
    });

    test('🔀 badge mesin: tiap baris picker dan header sesi menyebut mesin project', async () => {
      const other = await addTempProject('dua-mesin');
      try {
        await ensureApp(page, `#${projectId}`);
        await page.waitFor(async (id) => (await import('/js/core/state.js')).state.projects.some((p) => p.id === id), { timeoutMs: 5000, message: 'project kedua terdaftar' }, other);
        const view = await page.eval(async (ids) => {
          const { state } = await import('/js/core/state.js');
          const { renderSidebar } = await import('/js/features/picker.js');
          const { renderSessionBar } = await import('/js/features/sessions.js');
          window.__badgePrev = { config: state.config, active: state.active, a: state.statuses[ids.a]?.engine, b: state.statuses[ids.b]?.engine };
          state.config = { ...state.config, engine: 'claude' };
          state.statuses[ids.a] = { ...(state.statuses[ids.a] ?? {}), engine: 'opencode' };
          state.statuses[ids.b] = { ...(state.statuses[ids.b] ?? {}), engine: 'claude' };
          state.active = ids.a;
          renderSidebar();
          renderSessionBar();
          const read = () => ({
            a: document.querySelector(`#project-list li[data-id="${ids.a}"] .engine-badge`)?.textContent ?? null,
            b: document.querySelector(`#project-list li[data-id="${ids.b}"] .engine-badge`)?.textContent ?? null,
            header: document.querySelector('#sb-engine')?.textContent ?? null,
            engine: document.querySelector('#sb-engine')?.dataset.engine ?? null,
            title: document.querySelector('#sb-engine')?.title ?? '',
            aria: document.querySelector('#sb-engine')?.getAttribute('aria-label') ?? '',
          });
          const first = read();
          state.statuses[ids.a] = { ...state.statuses[ids.a], engine: 'claude' };
          state.statuses[ids.b] = { ...state.statuses[ids.b], engine: 'opencode' };
          renderSidebar();
          renderSessionBar();
          const second = read();
          state.config = window.__badgePrev.config;
          state.active = window.__badgePrev.active;
          state.statuses[ids.a] = { ...state.statuses[ids.a], engine: window.__badgePrev.a };
          state.statuses[ids.b] = { ...state.statuses[ids.b], engine: window.__badgePrev.b };
          delete window.__badgePrev;
          renderSidebar();
          renderSessionBar();
          return { first, second };
        }, { a: projectId, b: other });
        assert.equal(view.first.a, '⌘ OpenCode', 'project OpenCode');
        assert.equal(view.first.b, '✳ Claude', 'project Claude');
        assert.equal(view.first.header, '⌘ OpenCode');
        assert.equal(view.first.engine, 'opencode');
        assert.equal(view.first.aria, 'Mesin project: OpenCode');
        assert.match(view.first.title, /ganti di ⚙ Pengaturan/);
        assert.equal(view.second.a, '✳ Claude', 'status berubah: badge ikut');
        assert.equal(view.second.b, '⌘ OpenCode');
        assert.equal(view.second.header, '✳ Claude');
        assert.equal(await page.eval(horizontalOverflow), null, 'badge tidak membuat scroll horizontal');
        assert.deepEqual(realProblems(page), [], 'tanpa error console');
      } finally {
        await forgetTempProject(other);
      }
    });

    test('🧹 project yatim: badge "folder hilang", purge hanya untuk yang hilang, konfirmasi & hanya-lihat', async () => {
      await ensureApp(page, `#${projectId}`);
      const view = await page.eval(async (active) => {
        const { state } = await import('/js/core/state.js');
        const { renderSidebar } = await import('/js/features/picker.js');
        const prev = {
          projects: state.projects,
          statuses: state.statuses,
          active: state.active,
          readOnly: state.readOnly,
          confirm: window.confirm,
          fetch: window.fetch,
        };
        const calls = [];
        const confirms = [];
        const row = (id) => document.querySelector(`#project-list li[data-id="${id}"]`);
        const read = () => ({
          badge: row('missing-1')?.querySelector('.badge.missing')?.textContent ?? null,
          purge: Boolean(row('missing-1')?.querySelector('.purge')),
          purgeNormal: Boolean(row('normal-1')?.querySelector('.purge')),
          purgeDemo: Boolean(row('demo')?.querySelector('.purge')),
          disabled: row('missing-1')?.querySelector('.purge')?.disabled ?? null,
          title: row('missing-1')?.querySelector('.purge')?.title ?? '',
          toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
        });
        try {
          const base = { sources: ['custom'], favorite: false, lastActivity: 0, path: 'C:/tmp/project' };
          state.projects = [
            { ...base, id: 'missing-1', name: 'project hilang', missing: true },
            { ...base, id: 'normal-1', name: 'project ada', missing: false },
            { ...base, id: 'demo', name: 'Demo kantor', path: null, virtual: true, sources: ['demo'] },
          ];
          state.active = active;
          state.statuses = {};
          renderSidebar();
          const initial = read();

          window.confirm = (text) => {
            confirms.push(text);
            return false; // Batal: tidak boleh ada request
          };
          row('missing-1').querySelector('.purge').click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const afterCancel = calls.length;

          window.fetch = async (url, opts) => {
            calls.push({ url: String(url), method: opts?.method, body: opts?.body });
            return { ok: true, json: async () => ({ ok: true }) };
          };
          window.confirm = (text) => {
            confirms.push(text);
            return true;
          };
          row('missing-1').querySelector('.purge').click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const afterPurge = read();

          state.readOnly = true;
          renderSidebar();
          const readOnly = read();
          return { initial, afterCancel, afterPurge, readOnly, calls, confirms };
        } finally {
          state.readOnly = prev.readOnly;
          state.projects = prev.projects;
          state.statuses = prev.statuses;
          state.active = prev.active;
          window.confirm = prev.confirm;
          window.fetch = prev.fetch;
          renderSidebar();
        }
      }, projectId);
      assert.equal(view.initial.badge, 'folder hilang', 'folder yang hilang diberi badge');
      assert.equal(view.initial.purge, true, 'project yatim punya tombol purge');
      assert.equal(view.initial.purgeNormal, false, 'project yang foldernya ada tidak punya purge');
      assert.equal(view.initial.purgeDemo, false, 'demo tidak punya purge');
      assert.equal(view.afterCancel, 0, 'Batal tidak mengirim request');
      assert.match(view.confirms[0], /sudah tidak ada/, 'konfirmasi menyebut folder yang hilang');
      assert.deepEqual(view.calls, [{ url: '/api/projects/missing-1/purge', method: 'POST', body: JSON.stringify({ confirm: 'missing-1' }) }], 'kirim confirm berisi id');
      assert.ok(view.afterPurge.toast.some((t) => /Data project dihapus/.test(t)), 'toast sukses');
      assert.equal(view.readOnly.disabled, true, 'hanya-lihat: purge mati');
      assert.match(view.readOnly.title, /Hanya lihat lewat WiFi/, 'hanya-lihat: tooltip menjelaskan alasannya');
      assert.deepEqual(realProblems(page), [], 'tanpa error console');
    });

    test('🏷️ empty state menyebut mesin project, bukan selalu Claude', async () => {
      await ensureApp(page, `#${projectId}`);
      const r = await page.eval(async (id) => {
        const { state } = await import('/js/core/state.js');
        const { renderChat } = await import('/js/features/chat.js');
        const prev = { chats: state.chats[id], status: state.statuses[id], active: state.active };
        state.active = id;
        state.chats[id] = [];
        const read = () => document.querySelector('#chat .empty p')?.textContent ?? '';
        state.statuses[id] = { ...(state.statuses[id] ?? {}), engine: 'opencode' };
        renderChat();
        const opencode = read();
        state.statuses[id] = { ...(state.statuses[id] ?? {}), engine: 'claude' };
        renderChat();
        const claude = read();
        state.chats[id] = prev.chats;
        state.statuses[id] = prev.status;
        state.active = prev.active;
        renderChat();
        return { opencode, claude };
      }, projectId);
      assert.match(r.opencode, /OpenCode/);
      assert.doesNotMatch(r.opencode, /Claude/);
      assert.match(r.claude, /Claude Code/);
      assert.deepEqual(realProblems(page), []);
    });

    test('🔀 fitur mengikuti mesin project: Claude-only hilang di project OpenCode, rewind tetap ada', async () => {
      await ensureApp(page, `#${projectId}`);
      const caps = await page.eval(async (id) => {
        const { state } = await import('/js/core/state.js');
        const { renderComposer } = await import('/js/features/composer.js');
        const { capBlocked } = await import('/js/features/engine.js');
        const prev = { config: state.config, engine: state.statuses[id]?.engine };
        state.config = { ...state.config, engine: 'claude' }; // the default stays Claude: the PROJECT decides
        const read = () => ({
          permissions: document.querySelector('#more-menu [data-more="permissions"]').hidden,
          exportSession: document.querySelector('#more-menu [data-more="export-session"]').hidden,
          permissionsBtn: document.querySelector('#btn-permissions').hidden,
          plugins: capBlocked('extensions'),
          rewind: capBlocked('rewind'),
          modes: [...document.querySelectorAll('#mode option')].filter((o) => !o.hidden).map((o) => o.value),
          note: document.querySelector('#engine-note').textContent,
        });
        state.statuses[id] = { ...(state.statuses[id] ?? {}), engine: 'opencode' };
        renderComposer();
        const opencode = read();
        state.statuses[id] = { ...state.statuses[id], engine: 'claude' };
        renderComposer();
        const claude = read();
        state.statuses[id] = { ...state.statuses[id], engine: prev.engine };
        state.config = prev.config;
        renderComposer();
        return { opencode, claude };
      }, projectId);
      assert.equal(caps.opencode.permissions, true, 'Aturan izin Claude Code disembunyikan');
      assert.equal(caps.opencode.exportSession, true, 'Export sesi lengkap Claude disembunyikan');
      assert.equal(caps.opencode.permissionsBtn, true, 'tombol di ⚙ ikut tersembunyi');
      assert.match(caps.opencode.plugins, /opencode\.json/i, 'plugin/agent Claude diarahkan ke opencode.json');
      assert.equal(caps.opencode.rewind, null, 'OpenCode project tetap boleh rewind');
      assert.deepEqual(caps.opencode.modes, ['manual', 'plan'], 'hanya Build & Plan');
      assert.equal(caps.opencode.note, '', 'OpenCode mendukung effort/team/rewind/MCP/tugas latar: tanpa catatan "belum mendukung"');
      assert.equal(caps.claude.permissions, false, 'project Claude menampilkan entri Claude-only');
      assert.equal(caps.claude.exportSession, false);
      assert.equal(caps.claude.permissionsBtn, false);
      assert.equal(caps.claude.plugins, null);
      assert.deepEqual(caps.claude.modes, ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk']);
      assert.deepEqual(realProblems(page), [], 'tanpa error console');
    });

    test('👤 Akun: sakelar mesin kini "Mesin bawaan untuk project baru"', async () => {
      await ensureApp(page, `#${projectId}`);
      await tap(page, '#btn-account');
      await page.waitFor(() => document.querySelector('#account-body .engine-switch'), { timeoutMs: 4000, message: 'sakelar mesin di Akun' });
      const label = await page.eval(() => {
        const box = document.querySelector('#account-body .engine-switch');
        return {
          title: box.querySelector('.acct-title')?.textContent.trim(),
          group: box.querySelector('.engine-opts')?.getAttribute('aria-label'),
          note: box.querySelector('p')?.textContent ?? '',
          buttons: [...box.querySelectorAll('[data-act="engine"]')].map((b) => ({ engine: b.dataset.engine, pressed: b.getAttribute('aria-pressed') })),
        };
      });
      assert.equal(label.title, 'Mesin bawaan untuk project baru');
      assert.equal(label.group, 'Mesin bawaan untuk project baru');
      assert.match(label.note, /Hanya untuk project yang baru ditambahkan/);
      assert.match(label.note, /tetap memakai mesinnya sendiri/);
      assert.match(label.note, /tidak memindahkan project mana pun/);
      assert.doesNotMatch(label.note, /Semua project memakai/);
      assert.deepEqual(label.buttons.map((b) => b.engine).sort(), ['claude', 'opencode']);
      assert.deepEqual(label.buttons.filter((b) => b.pressed === 'true').map((b) => b.engine), ['claude'], 'bawaan sekarang ditandai');
      assert.deepEqual(realProblems(page), [], 'tanpa error console');
      await page.press('Escape');
    });

    test('🩺 Kesehatan sistem: ringkasan, pemeriksaan, persiapan, data & error; ↻ satu request; galat inline', async () => {
      await ensureApp(page, '#demo');
      await stubHealth(page);
      // The settings sheet is scrollable on a phone: bring the opener into view before the trusted click.
      const reveal = (sel) => page.eval((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
      try {
        await tap(page, '#btn-settings');
        await settle(page, 'settings-modal');
        if (!(await shownInPage(page, '#health-open'))) await page.click('[data-settings-tab="sistem"]');
        assert.equal(await shownInPage(page, '#health-open'), true, 'tombol 🩺 tampil di tab Sistem');
        await reveal('#health-open');
        await page.click('#health-open');
        await page.waitFor(() => !document.querySelector('#health-modal').hidden && Boolean(document.querySelector('#health-verdict')), { timeoutMs: 4000, message: 'laporan kesehatan tampil' });
        assert.equal(await healthCalls(page), 1, 'satu request saat modal dibuka');

        assert.equal(await page.eval(() => document.querySelector('#health-modal .health-more')?.open), false, 'detail kesehatan dilipat dulu');
        await page.eval(() => (document.querySelector('#health-modal .health-more').open = true));
        const view = await page.eval(() => ({
          verdict: document.querySelector('#health-verdict').textContent.trim(),
          meta: document.querySelector('#health-meta').textContent,
          checks: [...document.querySelectorAll('#health-modal .health-check')].map((li) => ({
            cls: li.className,
            label: li.querySelector('b').textContent,
            detail: li.querySelector('.health-detail')?.textContent ?? '',
            hint: li.querySelector('small')?.textContent ?? '',
            tone: li.querySelector('.sr-only')?.textContent ?? '',
            dot: getComputedStyle(li.querySelector('.health-dot')).backgroundColor,
          })),
          todos: [...document.querySelectorAll('#health-modal .health-todo')].map((li) => ({ cls: li.className, mark: li.querySelector('.health-mark').textContent })),
          progress: document.querySelector('#health-todos-title').textContent.trim(),
          size: document.querySelector('#health-size').textContent,
          path: document.querySelector('#health-path')?.textContent ?? document.querySelector('.health-path')?.textContent ?? '',
          errors: document.querySelector('#health-errors').textContent,
          last: document.querySelector('#health-last').textContent,
          lastTitle: document.querySelector('#health-last').getAttribute('title'),
          scripts: document.querySelectorAll('#health-modal script').length,
          refresh: document.querySelector('#health-refresh').disabled,
          pathOverflow: (() => {
            const el = document.querySelector('.health-path');
            return el ? el.scrollWidth - el.clientWidth : 0;
          })(),
        }));

        // Header: enough of the checklist done and no failing *essential* check → "Siap dipakai (5/6)".
        assert.equal(view.verdict, 'Siap dipakai (5/6)');
        assert.match(view.meta, /v0\.2\.0/);
        assert.match(view.meta, /Claude Code/);
        assert.match(view.meta, /aktif 3 jam 5 mnt/);
        assert.match(view.meta, /port 4317/);

        // Pemeriksaan: green / amber / red dot, label, detail, hint, and a spoken tone (colour is not the only cue).
        assert.deepEqual(view.checks.map((c) => c.cls), ['health-check ok', 'health-check warn', 'health-check bad']);
        assert.deepEqual(view.checks.map((c) => c.tone), ['lulus', 'peringatan', 'gagal']);
        assert.deepEqual(view.checks.map((c) => c.dot), ['rgb(63, 185, 80)', 'rgb(245, 165, 36)', 'rgb(240, 82, 74)']);
        assert.equal(view.checks[1].detail, 'folder lama');
        assert.equal(view.checks[1].hint, 'Folder baru dibuat otomatis.');

        // Persiapan: checkmarks for done, empty circles otherwise, progress X/N.
        assert.equal(view.todos.length, 6);
        assert.deepEqual(view.todos.map((t) => t.mark), ['✓', '✓', '✓', '✓', '✓', '○']);
        assert.equal(view.todos.filter((t) => t.cls.includes('done')).length, 5);
        assert.match(view.progress, /5\/6/);

        // Data aplikasi + error 24 jam (monospace, text only: the server's message is escaped, not markup).
        assert.equal(view.size, '12,3 MB · 123 file');
        assert.match(view.path, /folder-panjang/);
        assert.equal(view.pathOverflow <= 1, true, 'path panjang tidak melebar');
        assert.equal(view.errors, '2 error');
        assert.match(view.last, /^<script>alert\("x"\)<\/script> ENOENT: /);
        assert.equal(view.lastTitle, view.last, 'judul = pesan utuh');
        assert.equal(view.scripts, 0, 'pesan error di-escape');
        assert.equal(view.refresh, false);

        if (vp.mobile) assert.deepEqual(await page.eval(horizontalOverflow), null, 'tidak ada scroll horizontal di 390px');

        // ↻ = exactly one more request (and nothing afterwards: no polling).
        const before = await healthCalls(page);
        await reveal('#health-refresh');
        await page.click('#health-refresh');
        await page.waitFor((n) => window.__healthCalls === n + 1, { timeoutMs: 4000, message: 'satu request dari ↻' }, before);
        await settle(page, 'health-modal');
        assert.equal(await healthCalls(page), before + 1, 'tidak ada request tambahan');
        assert.equal(await page.eval(() => Boolean(document.querySelector('#health-verdict'))), true);

        // A failed refresh shows the error inline (role=alert) and keeps the last good report on screen.
        await page.eval(() => {
          window.__healthFail = true;
        });
        await reveal('#health-refresh');
        await page.click('#health-refresh');
        await page.waitFor(() => document.querySelector('#health-error')?.textContent.includes('Gagal memeriksa'), { timeoutMs: 4000, message: 'galat inline' });
        const failed = await page.eval(() => ({
          role: document.querySelector('#health-error')?.getAttribute('role'),
          verdict: document.querySelector('#health-verdict')?.textContent.trim(),
          checks: document.querySelectorAll('#health-modal .health-check').length,
          last: document.querySelector('#health-last')?.textContent,
          refresh: document.querySelector('#health-refresh').disabled,
          text: document.querySelector('#health-error')?.textContent,
        }));
        assert.equal(failed.role, 'alert');
        assert.match(failed.text, /Server sibuk/);
        assert.equal(failed.verdict, 'Siap dipakai (5/6)', 'laporan lama tetap tampil');
        assert.equal(failed.checks, 3);
        assert.match(failed.last, /ENOENT/);
        assert.equal(failed.refresh, false, '↻ bisa dicoba lagi');

        // A failing *essential* check flips the verdict (an amber warning or a non-essential failure does not).
        await page.eval(() => {
          window.__healthFail = false;
          window.__healthAnswer = {
            ...window.__healthAnswer,
            checks: window.__healthAnswer.checks.map((c) => (c.id === 'node' ? { ...c, ok: false, warn: false } : c)),
          };
        });
        await reveal('#health-refresh');
        await page.click('#health-refresh');
        await page.waitFor(() => document.querySelector('#health-verdict')?.textContent.includes('Perlu perhatian'), { timeoutMs: 4000, message: 'perlu perhatian' });
        assert.equal(await page.eval(() => document.querySelector('#health-verdict').textContent.trim()), 'Perlu perhatian (5/6)');

        // Reopening shows the last report at once and refreshes it in the background.
        await page.eval(() => {
          window.__healthDelay = 400;
        });
        const callsBeforeReopen = await healthCalls(page);
        await page.click('#health-close');
        await page.waitFor(() => document.querySelector('#health-modal').hidden, { timeoutMs: 2000, message: 'modal tertutup' });
        await reveal('#health-open');
        await page.click('#health-open');
        const instant = await page.eval(() => ({
          verdict: document.querySelector('#health-verdict')?.textContent ?? null,
          refresh: document.querySelector('#health-refresh').disabled,
        }));
        assert.equal(instant.verdict, 'Perlu perhatian (5/6)', 'laporan tersimpan tampil langsung');
        assert.equal(instant.refresh, true, '↻ nonaktif selama request berjalan');
        await page.waitFor((n) => window.__healthCalls > n, { timeoutMs: 4000, message: 'refresh latar belakang' }, callsBeforeReopen);
        await page.waitFor(() => document.querySelector('#health-refresh').disabled === false, { timeoutMs: 4000, message: '↻ aktif lagi' });
        assert.deepEqual(realProblems(page), [], 'tanpa error console');
      } finally {
        await restoreHealth(page);
      }
    });

    test('🩺 Kesehatan sistem: tersembunyi & tidak membuka modal saat hanya-lihat (WiFi)', async () => {
      await ensureApp(page, '#demo');
      try {
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.readOnly = true;
          document.body.classList.add('read-only');
        });
        await tap(page, '#btn-settings');
        await settle(page, 'settings-modal');
        await page.click('[data-settings-tab="sistem"]');
        const ro = await page.eval(() => {
          const btn = document.querySelector('#health-open');
          return {
            shown: Boolean(btn.getClientRects().length),
            hidden: btn.hidden,
            disabled: btn.disabled,
            section: document.querySelector('#health-section').hidden,
            styleShown: getComputedStyle(document.querySelector('#health-section')).display !== 'none',
          };
        });
        assert.equal(ro.shown, false, 'tombol tidak tampil di halaman hanya-lihat');
        assert.equal(ro.hidden, true, 'tombol hidden');
        assert.equal(ro.disabled, true, 'tombol nonaktif');
        assert.equal(ro.section, true, 'bagian kesehatan ikut disembunyikan');
        assert.equal(ro.styleShown, false, 'CSS hanya-lihat juga menyembunyikannya');
        // Even a forced click (a stale page that still shows it) must not open a dialog the server would refuse.
        await page.eval(() => document.querySelector('#health-open').click());
        await sleep(100);
        assert.equal(await page.eval(() => document.querySelector('#health-modal').hidden), true, 'modal tidak dibuka');
      } finally {
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.readOnly = false;
          document.body.classList.remove('read-only');
          document.querySelector('#settings-modal').hidden = true;
        }).catch(() => {});
      }
    });

    test('💰 Budget pemakaian global: batas, pemakaian, bar berwarna & sisa; tanpa batas bila 0', async () => {
      await ensureApp(page, '#demo');
      await stubBudget(page);
      try {
        await resetBudget(page);
        await tap(page, '#btn-settings');
        await settle(page, 'settings-modal');
        // Desktop keeps one panel at a time (the remembered tab may be another one); a phone stacks them all.
        if (!(await shownInPage(page, '#budget-section'))) await page.click('[data-settings-tab="umum"]');
        await page.waitFor(() => document.querySelectorAll('#budget-rows .budget-row').length === 3, { timeoutMs: 4000, message: 'tiga baris budget tampil' });
        await page.eval(() => (document.querySelector('#budget-audit').open = true));
        await page.waitFor(() => /Budget global/.test(document.querySelector('#budget-audit-list').textContent), { timeoutMs: 4000, message: 'riwayat budget' });

        const view = await page.eval(budgetRows);
        assert.deepEqual(view.map((r) => r.window), ['Harian', 'Mingguan', 'Bulanan']);
        assert.deepEqual(view.map((r) => r.cls), ['budget-row ok', 'budget-row warn', 'budget-row off']);
        assert.deepEqual(view.map((r) => r.amount), ['$12,30 / $20 (62%)', '$45,00 / $50 (90%)', '$3,00 tercatat · tanpa batas']);
        assert.deepEqual(view.map((r) => r.rest), ['sisa $7,70', 'sisa $5,00', null]);
        assert.deepEqual(view.map((r) => r.pct), ['(62%)', '(90%)', null]);
        // Green under 80%, amber from 80%, red at 100% (the server's wrong percent/state are ignored).
        assert.deepEqual(view.map((r) => r.bar?.color ?? null), ['rgb(63, 185, 80)', 'rgb(245, 165, 36)', null]);
        assert.equal(view[0].bar.role, 'progressbar');
        assert.equal(view[0].bar.now, '62');
        assert.equal(view[0].bar.width, '62%');
        assert.match(view[0].bar.text, /62% dari batas harian, sisa \$7,70/);
        assert.equal(view[1].bar.now, '90');

        const fields = await page.eval(() => ({
          daily: document.querySelector('#budget-daily').value,
          weekly: document.querySelector('#budget-weekly').value,
          monthly: document.querySelector('#budget-monthly').value,
          placeholders: [...document.querySelectorAll('#budget-form input')].map((i) => i.placeholder),
          step: [...document.querySelectorAll('#budget-form input')].map((i) => i.step),
          error: document.querySelector('#budget-error').textContent,
          coverage: document.querySelector('#budget-coverage').textContent,
          coverageShown: Boolean(document.querySelector('#budget-coverage').getClientRects().length),
          saveDisabled: document.querySelector('#budget-save').disabled,
          note: document.querySelector('#budget-note').textContent,
          forecast: document.querySelector('#budget-section .budget-forecast')?.textContent ?? '',
          trendDays: document.querySelectorAll('#budget-section .budget-trend .bt-day').length,
          trendLabel: document.querySelector('#budget-section .budget-trend')?.getAttribute('aria-label') ?? '',
        }));
        assert.deepEqual({ daily: fields.daily, weekly: fields.weekly, monthly: fields.monthly }, { daily: '20', weekly: '50', monthly: '' });
        assert.deepEqual(fields.placeholders, ['tanpa batas', 'tanpa batas', 'tanpa batas']);
        assert.deepEqual(fields.step, ['0.01', '0.01', '0.01']);
        assert.equal(fields.error, '');
        assert.equal(fields.coverageShown, true);
        assert.match(fields.coverage, /ledger/);
        assert.equal(fields.saveDisabled, false);
        assert.match(fields.note, /OpenCode Go/);
        assert.match(fields.note, /langganan/);
        assert.match(fields.forecast, /Perkiraan akhir bulan ±\$/, 'proyeksi akhir bulan tampil');
        assert.equal(fields.trendDays, 7, 'tujuh batang harian');
        assert.match(fields.trendLabel, /Biaya 7 hari terakhir/);

        assert.equal(await budgetCalls(page), 1, 'satu request saat panel dibuka');
        if (vp.mobile) {
          assert.equal(await page.eval(horizontalOverflow), null, 'tidak ada scroll horizontal di 390px');
          assert.equal(await page.eval(() => document.querySelector('#budget-section').scrollWidth - document.querySelector('#budget-section').clientWidth <= 1), true, 'bagian budget tidak melebar');
        }

        // The view is cached in memory: reopening the dialog (or switching tabs) asks nothing again.
        await page.press('Escape');
        await page.waitFor(() => document.querySelector('#settings-modal').hidden, { timeoutMs: 2000, message: 'pengaturan tertutup' });
        await tap(page, '#btn-settings');
        await settle(page, 'settings-modal');
        await sleep(300);
        assert.equal(await budgetCalls(page), 1, 'tanpa polling/request berulang');
        assert.deepEqual(realProblems(page), [], 'tanpa error console');
      } finally {
        await restoreBudget(page);
      }
    });

    test('💰 Budget: batas terlampaui menampilkan peringatan hard stop', async () => {
      await ensureApp(page, '#demo');
      const answer = BUDGET_ANSWER();
      answer.budget.dailyUsd = 10;
      answer.spend.day.usd = 12.3;
      answer.windows.day = { limit: 10, usd: 12.3, percent: 1.23, state: 'over' };
      await stubBudget(page, answer);
      try {
        await resetBudget(page);
        await tap(page, '#btn-settings');
        await settle(page, 'settings-modal');
        if (!(await shownInPage(page, '#budget-stop'))) await page.click('[data-settings-tab="umum"]');
        await page.waitFor(() => !document.querySelector('#budget-stop').hidden, { timeoutMs: 4000, message: 'peringatan hard stop' });
        assert.match(await page.eval(() => document.querySelector('#budget-stop').textContent), /Pengiriman prompt dihentikan/);
        assert.equal(await page.eval(() => document.querySelector('#budget-project').options.length > 1), true, 'bisa pilih global atau project');
        assert.equal(await page.eval(() => document.querySelector('#budget-override').hidden), false, 'tombol izinkan satu giliran tampil');
      } finally {
        await restoreBudget(page);
      }
    });

    test('💰 Budget: Simpan mengirim tiga angka (kosong/0 = tanpa batas), galat inline, ringkasan ikut jawaban server', async () => {
      await ensureApp(page, '#demo');
      await stubBudget(page);
      try {
        await resetBudget(page);
        await tap(page, '#btn-settings');
        await settle(page, 'settings-modal');
        if (!(await shownInPage(page, '#budget-section'))) await page.click('[data-settings-tab="umum"]');
        await page.waitFor(() => document.querySelectorAll('#budget-rows .budget-row').length === 3, { timeoutMs: 4000, message: 'tiga baris budget tampil' });

        // New limits: daily 25.50, weekly empty (= tanpa batas), monthly 0 (also tanpa batas). The answer shows the result.
        await page.eval(() => {
          window.__budgetAnswer = {
            ...window.__budgetAnswer,
            budget: { dailyUsd: 25.5, weeklyUsd: 0, monthlyUsd: 0 },
            windows: { day: { limit: 25.5, usd: 12.3 }, week: { limit: 0, usd: 45 }, month: { limit: 0, usd: 3 } },
          };
          document.querySelector('#budget-daily').value = '25.5';
          document.querySelector('#budget-weekly').value = '';
          document.querySelector('#budget-monthly').value = '0';
        });
        await page.click('#budget-save');
        await page.waitFor(() => (window.__budgetSaves ?? []).length === 1, { timeoutMs: 4000, message: 'satu kiriman simpan' });
        assert.deepEqual(await budgetSaves(page), [{ dailyUsd: 25.5, weeklyUsd: 0, monthlyUsd: 0 }], 'tiga angka, kosong & 0 = tanpa batas');
        await page.waitFor(() => document.querySelector('#budget-rows .budget-row .budget-amount')?.textContent.includes('(48%)'), { timeoutMs: 4000, message: 'ringkasan ikut jawaban simpan' });
        const saved = await page.eval(budgetRows);
        assert.equal(saved[0].amount, '$12,30 / $25,50 (48%)');
        assert.equal(saved[1].amount, '$45,00 tercatat · tanpa batas');
        assert.equal(saved[2].amount, '$3,00 tercatat · tanpa batas');
        assert.equal(await page.eval(() => document.querySelector('.toast.ok')?.textContent ?? ''), '💰 Budget pemakaian global disimpan.');

        // A field the browser/UI cannot accept never leaves: inline error (role=alert), no POST.
        await page.eval(() => {
          document.querySelector('#budget-daily').value = '20000';
        });
        await page.click('#budget-save');
        await page.waitFor(() => document.querySelector('#budget-error').textContent.includes('Harian'), { timeoutMs: 2000, message: 'galat inline' });
        const invalid = await page.eval(() => ({
          role: document.querySelector('#budget-error').getAttribute('role'),
          text: document.querySelector('#budget-error').textContent,
          invalid: document.querySelector('#budget-daily').getAttribute('aria-invalid'),
          saves: (window.__budgetSaves ?? []).length,
        }));
        assert.equal(invalid.role, 'alert');
        assert.match(invalid.text, /\$0–\$10\.000/);
        assert.equal(invalid.invalid, 'true');
        assert.equal(invalid.saves, 1, 'tidak ada kiriman untuk isian tidak valid');

        // A 400 from the server shows its reason inline and keeps the form (the numbers can be fixed).
        await page.eval(() => {
          window.__budgetSave = { status: 400, error: 'Batas harian maksimal $10.000.' };
          document.querySelector('#budget-daily').value = '5';
        });
        await page.click('#budget-save');
        await page.waitFor(() => document.querySelector('#budget-error').textContent.includes('maksimal'), { timeoutMs: 4000, message: 'pesan 400 inline' });
        const refused = await page.eval(() => ({
          text: document.querySelector('#budget-error').textContent,
          saves: (window.__budgetSaves ?? []).length,
          daily: document.querySelector('#budget-daily').value,
        }));
        assert.equal(refused.text, 'Batas harian maksimal $10.000.');
        assert.equal(refused.saves, 2);
        assert.equal(refused.daily, '5', 'isian tetap, bisa diperbaiki');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await restoreBudget(page);
      }
    });

    test('🩺 Kesehatan sistem: ringkasan budget tampil di atas laporan, tanpa kolom isian', async () => {
      await ensureApp(page, '#demo');
      await stubHealth(page);
      await stubBudget(page);
      try {
        await resetBudget(page);
        await tap(page, '#btn-settings');
        await settle(page, 'settings-modal');
        // The settings sheet is scrollable on a phone: bring the opener into view before the trusted click.
        const reveal = (sel) => page.eval((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), sel);
        if (!(await shownInPage(page, '#health-open'))) await page.click('[data-settings-tab="sistem"]');
        await reveal('#health-open');
        await page.click('#health-open');
        await page.waitFor(
          () =>
            !document.querySelector('#health-modal').hidden &&
            document.querySelectorAll('#health-modal .health-budget .budget-row').length === 3 &&
            document.querySelector('#health-verdict')?.textContent.trim() === 'Siap dipakai (5/6)',
          { timeoutMs: 4000, message: 'laporan + budget tampil' },
        );

        const health = await page.eval(() => {
          const body = document.querySelector('#health-body');
          const section = document.querySelector('#health-modal .health-budget');
          return {
            atTop: body.firstElementChild === section,
            title: section.querySelector('h3')?.textContent.trim(),
            fields: section.querySelectorAll('input, select, textarea, button').length,
            verdict: document.querySelector('#health-verdict')?.textContent.trim(),
            checks: document.querySelectorAll('#health-modal .health-check').length,
            note: section.querySelector('.muted.small')?.textContent ?? '',
          };
        });
        const healthRows = await page.eval(budgetRows, '#health-modal .health-budget .budget-rows');
        assert.equal(health.atTop, true, 'di atas ringkasan kesehatan');
        assert.equal(health.title, 'Budget pemakaian');
        assert.deepEqual(healthRows.map((r) => r.window), ['Harian', 'Mingguan', 'Bulanan']);
        assert.deepEqual(healthRows.map((r) => r.amount), ['$12,30 / $20 (62%)', '$45,00 / $50 (90%)', '$3,00 tercatat · tanpa batas']);
        assert.deepEqual(healthRows.map((r) => r.bar?.color ?? null), ['rgb(63, 185, 80)', 'rgb(245, 165, 36)', null]);
        assert.equal(health.fields, 0, 'tidak ada kolom isian di kesehatan');
        assert.equal(health.verdict, 'Siap dipakai (5/6)', 'laporan kesehatan tetap tampil');
        assert.equal(health.checks, 3);
        assert.match(health.note, /OpenCode Go/);
        assert.equal(await budgetCalls(page), 1, 'satu request budget, tidak dobel dengan ⚙');
        if (vp.mobile) assert.equal(await page.eval(horizontalOverflow), null, 'tidak ada scroll horizontal di 390px');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await restoreBudget(page); // installed last: restored first (LIFO), then the health stub
        await restoreHealth(page);
      }
    });

    test('💰 Budget: tersembunyi di halaman hanya-lihat (WiFi) dan tidak mengirim request', async () => {
      await ensureApp(page, '#demo');
      await stubBudget(page);
      try {
        await resetBudget(page);
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.readOnly = true;
          document.body.classList.add('read-only');
        });
        await tap(page, '#btn-settings');
        await settle(page, 'settings-modal');
        const ro = await page.eval(() => {
          const section = document.querySelector('#budget-section');
          return {
            hidden: section.hidden,
            shown: Boolean(section.getClientRects().length),
            display: getComputedStyle(section).display,
            inputs: [...section.querySelectorAll('input')].map((i) => i.disabled),
            save: document.querySelector('#budget-save').disabled,
          };
        });
        assert.equal(ro.hidden, true, 'bagian disembunyikan');
        assert.equal(ro.shown, false, 'tidak tampil di halaman hanya-lihat');
        assert.equal(ro.display, 'none', 'CSS hanya-lihat juga menyembunyikannya');
        assert.deepEqual(ro.inputs, [true, true, true]);
        assert.equal(ro.save, true);
        // Even a forced click and a stray call must not reach the route.
        await page.eval(() => document.querySelector('#budget-save').click());
        await page.eval(async () => {
          const { loadBudgetView } = await import('/js/features/budget.js');
          await loadBudgetView({ force: true });
        });
        await sleep(150);
        assert.equal(await budgetCalls(page), 0, 'tidak ada request dari halaman hanya-lihat');
        assert.deepEqual(await budgetSaves(page), [], 'tidak ada kiriman');
      } finally {
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.readOnly = false;
          document.body.classList.remove('read-only');
        }).catch(() => {});
        await restoreBudget(page);
      }
    });


    test('⚙ Effort Auto (LLM) ada di picker dan tersimpan sebagai auto', async () => {
      await ensureApp(page, `#${projectId}`);
      assert.equal(
        await page.eval(() => [...document.querySelectorAll('#effort option')].some((o) => o.value === 'auto')),
        true,
        'opsi Auto (LLM) tersedia',
      );
      await page.eval(() => {
        const select = document.querySelector('#effort');
        select.value = 'auto';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitFor(async (id) => (await import('/js/core/state.js')).state.statuses[id]?.effortAuto === true, { timeoutMs: 5000, message: 'effortAuto tersimpan' }, projectId);
      await page.eval(() => {
        const select = document.querySelector('#effort');
        select.value = '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitFor(async (id) => (await import('/js/core/state.js')).state.statuses[id]?.effortAuto === false, { timeoutMs: 5000, message: 'kembali manual' }, projectId);
    });

    test('⚙ Effort Auto: indikator Menentukan effort tampil saat prompt menunggu klasifikasi', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval(() => {
        const select = document.querySelector('#effort');
        select.value = 'auto';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitFor(async (id) => (await import('/js/core/state.js')).state.statuses[id]?.effortAuto === true, { timeoutMs: 5000, message: 'Auto aktif' }, projectId);
      await page.eval(() => {
        const real = window.fetch;
        window.__effortRealFetch = real;
        window.fetch = async (url, opts) => {
          if (String(url).endsWith('/prompt')) await new Promise((r) => setTimeout(r, 400));
          return real(url, opts);
        };
      });
      await typeInPrompt(page, 'halo');
      await page.press('Enter');
      await page.waitFor(
        () => {
          const typing = document.querySelector('#typing');
          return typing && !typing.hidden && /Menentukan effort/.test(document.querySelector('#typing-text').textContent);
        },
        { timeoutMs: 2000, message: 'indikator Menentukan effort' },
      );
      await page.waitFor(() => [...document.querySelectorAll('.msg.user .body')].some((n) => n.textContent === 'halo'), { timeoutMs: 6000, message: 'bubble prompt muncul' });
      await page.eval(() => {
        if (window.__effortRealFetch) window.fetch = window.__effortRealFetch;
      });
      await page.eval(() => {
        const select = document.querySelector('#effort');
        select.value = '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });

    test('📱 HP: Lanjutkan dari mesin lain ada di sheet ⋯', { skip: !vp.mobile }, async () => {
      await ensureApp(page, `#${projectId}`);
      await page.click('#btn-head-more');
      await page.waitFor(() => !document.querySelector('#head-more-modal').hidden, { timeoutMs: 2000, message: 'sheet ⋯ terbuka' });
      const row = '#head-more-modal [data-proxy*="handoff"]';
      assert.equal(await shownInPage(page, row), true, 'baris handoff ada di sheet HP');
      await page.eval((sel) => document.querySelector(sel).click(), row);
      await page.waitFor(() => !document.querySelector('#handoff-modal').hidden, { timeoutMs: 3000, message: 'dialog handoff terbuka' });
      await page.press('Escape');
    });

    test('⚙ Pengaturan: bagian Cadangkan riwayat tampil, tombol aktif di laptop, export terunduh, tanpa error console', async () => {
      await ensureApp(page, `#${projectId}`);
      await tap(page, '#btn-settings');
      await settle(page, 'settings-modal');
      await page.click('[data-settings-tab="cadangan"]'); // one tab at a time on the phone too
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

    test('⬆ Import riwayat menampilkan pratinjau isi backup dulu, baru memulihkan', async () => {
      await ensureApp(page, `#${projectId}`);
      await tap(page, '#btn-settings');
      await settle(page, 'settings-modal');
      await page.click('[data-settings-tab="cadangan"]');
      await page.eval(() => {
        window.__previewCalls = 0;
        window.__importCalls = 0;
        window.__importOnly = [];
        window.__importParts = [];
        window.__backupFetch = window.fetch;
        window.fetch = async (url, opts) => {
          const u = String(url);
          if (u.endsWith('/api/backup/preview')) {
            window.__previewCalls += 1;
            return new Response(
              JSON.stringify({
                format: 'adhit-office-backup',
                version: 1,
                createdAt: '2026-11-01T03:00:00.000Z',
                source: { homeDir: 'C:\\Users\\lama', platform: 'win32', appVersion: '0.2.0' },
                entries: 42,
                unpackedBytes: 5 * 1024 * 1024,
                projects: [
                  { folder: 'C--Users-lama-toko', cwd: 'C:\\Users\\lama\\toko', sessions: 12, files: 3 },
                  { folder: 'C--Users-lama-kasir', cwd: 'C:\\Users\\lama\\kasir', sessions: 4, files: 1 },
                ],
                sessions: 16,
                chats: { claude: 2, opencode: 1 },
                chatSessions: 3,
                includes: { state: true, usage: true, history: true, fileHistory: 5, plans: 2 },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (u.endsWith('/api/backup/import')) {
            window.__importCalls += 1;
            window.__importOnly.push(opts?.headers?.['X-Backup-Only'] ?? null);
            window.__importParts.push(opts?.headers?.['X-Backup-Parts'] ?? null);
            return new Response(
              JSON.stringify({
                projects: 2,
                sessions: { added: 16, updated: 0, skipped: 0 },
                files: { added: 4, copies: 0, skipped: 0 },
                history: { added: 3 },
                usage: { added: 2 },
                state: { roots: 1, custom: 0, favorites: 0, settings: 2, engines: 2, engineSettings: 1, sessions: 0, chats: 3, teamNames: 0 },
                remapped: [],
                warnings: [],
                projectsAdded: [],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return window.__backupFetch(url, opts);
        };
      });
      try {
        await page.eval(() => {
          const input = document.querySelector('#backup-file');
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'backup.zip', { type: 'application/zip' }));
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitFor(() => Boolean(document.querySelector('#backup-restore')), { timeoutMs: 4000, message: 'pratinjau backup' });
        const preview = await page.eval(() => ({
          calls: [window.__previewCalls, window.__importCalls],
          hidden: document.querySelector('#backup-result').hidden,
          text: document.querySelector('#backup-result').textContent.replace(/\s+/g, ' ').trim(),
        }));
        assert.deepEqual(preview.calls, [1, 0], 'pratinjau hanya membaca, belum memulihkan');
        assert.equal(preview.hidden, false);
        assert.match(preview.text, /2 project · 16 sesi Claude/);
        assert.match(preview.text, /toko/);
        assert.match(preview.text, /12 sesi/);
        assert.match(preview.text, /Dibuat/);
        assert.equal(await page.eval(() => document.querySelectorAll('#backup-result .backup-pick-box').length), 2, 'satu kotak per project');
        assert.equal(await page.eval(() => document.querySelector('#backup-restore').textContent), 'Pulihkan semua', 'semua terpilih awalnya');

        // Unchecking a project leaves it out of the restore (the header names the chosen folder).
        await page.eval(() => {
          document.querySelector('#backup-result .backup-pick-box[data-folder="C--Users-lama-kasir"]').click();
          document.querySelector('#backup-result .backup-part-box[data-part="usage"]').click();
        });
        assert.equal(await page.eval(() => document.querySelector('#backup-restore').textContent), 'Pulihkan 1 project');
        await page.click('#backup-restore');
        await page.waitFor(() => window.__importCalls === 1, { timeoutMs: 4000, message: 'import setelah konfirmasi' });
        const only = await page.eval(() => {
          const raw = window.__importOnly[0];
          if (!raw) return null;
          const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
          return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
        });
        assert.deepEqual(only, ['C--Users-lama-toko'], 'project yang tidak dicentang tidak ikut');
        const parts = await page.eval(() => {
          const raw = window.__importParts[0];
          if (!raw) return null;
          const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
          return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
        });
        assert.deepEqual(parts, { state: true, usage: false, history: true }, 'laporan token tidak ikut');
        await page.waitFor(() => /Hasil import/.test(document.querySelector('#backup-result').textContent), { timeoutMs: 4000, message: 'ringkasan import' });
        assert.equal(await page.eval(() => document.querySelectorAll('#backup-restore').length), 0, 'tombol pratinjau diganti hasil');
        await page.press('Escape');
      } finally {
        await page.eval(() => {
          window.fetch = window.__backupFetch;
        });
      }
    });

    test('🕘 Backup otomatis: riwayat di folder tujuan bisa dipulihkan', async () => {
      await ensureApp(page, `#${projectId}`);
      await page.eval(() => {
        window.__restoreCalls = [];
        window.__baFetch = window.fetch;
        window.__baConfirm = window.confirm;
        window.confirm = () => true;
        const now = Date.now();
        window.fetch = async (url, opts) => {
          const u = String(url);
          if (u.endsWith('/api/backup/schedule/history')) {
            return new Response(
              JSON.stringify({
                backups: [
                  { name: 'adhit-office-backup-auto-20261107-020000.zip', bytes: 3 * 1024 * 1024, at: now - 3_600_000 },
                  { name: 'adhit-office-backup-auto-20261106-020000.zip', bytes: 2 * 1024 * 1024, at: now - 86_400_000 },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (u.endsWith('/api/backup/schedule/restore')) {
            window.__restoreCalls.push(JSON.parse(opts?.body ?? '{}'));
            return new Response(JSON.stringify({ projects: 2, sessions: { added: 5, updated: 1, skipped: 0 }, warnings: [], projectsAdded: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          if (u.endsWith('/api/backup/schedule')) {
            return new Response(JSON.stringify({ schedule: { enabled: true, frequency: 'daily', weekday: 1, time: '02:00', folder: 'D:\\Backup', keep: 3 }, last: null, running: false, nextAt: now + 86_400_000, keepMax: 100 }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return window.__baFetch(url, opts);
        };
      });
      try {
        await tap(page, '#btn-settings');
        await settle(page, 'settings-modal');
        await page.click('[data-settings-tab="cadangan"]');
        await page.waitFor(() => !document.querySelector('#ba-history').hidden && document.querySelectorAll('#ba-history-list [data-ba-restore]').length === 2, { timeoutMs: 4000, message: 'riwayat backup otomatis' });
        const text = await page.eval(() => document.querySelector('#ba-history').textContent.replace(/\s+/g, ' ').trim());
        assert.match(text, /20261107-020000/);
        assert.match(text, /3 MB/);

        await page.eval(() => document.querySelector('#ba-history-list [data-ba-restore]').click());
        await page.waitFor(() => /Dipulihkan/.test(document.querySelector('#ba-restore-status').textContent), { timeoutMs: 4000, message: 'hasil pemulihan' });
        assert.deepEqual(await page.eval(() => window.__restoreCalls[0]), { name: 'adhit-office-backup-auto-20261107-020000.zip' });
        assert.match(await page.eval(() => document.querySelector('#ba-restore-status').textContent), /Dipulihkan: 2 project, 5 sesi ditambahkan/);
        await page.press('Escape');
      } finally {
        await page.eval(() => {
          window.fetch = window.__baFetch;
          window.confirm = window.__baConfirm;
        });
      }
    });

    // Regression: renderAccount() rebuilds #account-body; focus must survive (↻ "Cek ulang kuota" re-renders it).
    test('account-modal: fokus tetap di dalam modal setelah ↻ Cek ulang kuota', async () => {
      await ensureApp(page, `#${projectId}`);
      await tap(page, '#btn-account');
      await settle(page, 'account-modal');
      await page.eval(() => document.querySelector('#account-body [data-act="limits"]').focus());
      assert.equal(await page.eval(() => document.activeElement.dataset.act), 'limits');
      await page.press('Enter');
      await settle(page, 'account-modal');
      const st = await page.eval(modalState, 'account-modal');
      await page.press('Escape');
      assert.ok(st.focusInside, `fokus pindah ke ${st.active} setelah kuota dimuat ulang`);
    });

    // Every account change confirms its impact first, and a cancelled dialog must not send anything.
    test('akun: ringkasan dampak tampil sebelum login & logout, Batal tidak mengirim request', async () => {
      await ensureApp(page, `#${projectId}`);
      try {
        await stubAccount(page, { profile: { loggedIn: false } });
        await tap(page, '#btn-account');
        await settle(page, 'account-modal');
        assert.match(await page.eval(() => document.querySelector('#account-body').textContent), /Login dengan akun Claude/);
        await page.click('#account-body [data-act="login"]');
        const login = await page.eval(() => ({ confirms: window.__acct.confirms, calls: window.__acct.calls }));
        assert.equal(login.calls.length, 0, 'Batal: tidak ada POST /api/account/login');
        assert.equal(login.confirms.length, 1, 'satu dialog konfirmasi sebelum login');
        assert.match(login.confirms[0], /seluruh Claude Code di laptop/);
        assert.match(login.confirms[0], /Giliran yang sedang berjalan dibiarkan selesai dulu/);
        assert.match(login.confirms[0], /Antrian semua project dijeda/);
        assert.match(login.confirms[0], /Sesi terminal perlu dibuka ulang/);
        await page.press('Escape');

        // Logout: the same summary, now naming the account, and still nothing sent on cancel.
        await restoreAccount(page);
        await stubAccount(page, { profile: { loggedIn: true, email: 'uji@example.com', subscriptionType: 'pro', authMethod: 'claude.ai' } });
        await tap(page, '#btn-account');
        await settle(page, 'account-modal');
        await page.waitFor(() => document.querySelector('#account-body [data-act="logout"]'), { timeoutMs: 4000, message: 'tombol Logout' });
        await page.click('#account-body [data-act="logout"]');
        const logout = await page.eval(() => ({ confirms: window.__acct.confirms, calls: window.__acct.calls }));
        assert.equal(logout.calls.length, 0, 'Batal: tidak ada POST /api/account/logout');
        assert.equal(logout.confirms.length, 1, 'satu dialog konfirmasi sebelum logout');
        assert.match(logout.confirms[0], /Logout dari uji@example\.com/);
        assert.match(logout.confirms[0], /seluruh Claude Code di laptop/);
        assert.match(logout.confirms[0], /Antrian semua project dijeda/);
        assert.match(logout.confirms[0], /Sesi terminal perlu dibuka ulang/);
        await page.press('Escape');
      } finally {
        await restoreAccount(page);
      }
    });

    test('akun OpenCode: logout provider mengirim confirm LOGOUT dan pesan 400 tampil inline', async () => {
      await ensureApp(page, `#${projectId}`);
      try {
        await stubOpenCodeAccount(page);
        await tap(page, '#btn-account');
        await page.waitFor(() => document.querySelector('#account-body [data-act="oc-logout"]'), { timeoutMs: 8000, message: 'daftar provider OpenCode' });
        await settle(page, 'account-modal');
        await page.click('#account-body [data-act="oc-logout"]');
        await page.waitFor(() => /Ketik LOGOUT/.test(document.querySelector('#account-body')?.textContent ?? ''), { timeoutMs: 4000, message: 'pesan server inline' });
        const r = await page.eval(() => ({ calls: window.__ocAcct.calls, confirms: window.__ocAcct.confirms, body: document.querySelector('#account-body').textContent }));
        assert.deepEqual(r.calls, [{ credentialID: 'cred-1', confirm: 'LOGOUT' }], 'credentialID + confirm LOGOUT');
        assert.equal(r.confirms.length, 1);
        assert.match(r.confirms[0], /Model dari provider ini tidak bisa dipakai/);
        assert.match(r.confirms[0], /Antrian semua project dijeda/);
        assert.match(r.body, /Ketik LOGOUT/);
        assert.equal(await page.eval(horizontalOverflow), null);
        await page.press('Escape');
      } finally {
        await restoreOpenCodeAccount(page);
      }
    });

    // Estimated Go quota: the note, per-model used/remaining money, three bars each, colors, server order, unlimited.
    test('kuota OpenCode Go: catatan estimasi, bar 5 jam/7 hari/30 hari, warna, urutan kiriman', async () => {
      await ensureApp(page, `#${projectId}`);
      try {
        await stubOpenCodeAccount(page, { go: GO_QUOTA, usage: GO_USAGE });
        await tap(page, '#btn-account');
        await page.waitFor(() => document.querySelectorAll('#account-body .oc-go-row').length === 5, { timeoutMs: 8000, message: 'lima baris kuota Go' });
        await settle(page, 'account-modal');
        const r = await page.eval(() => {
          const body = document.querySelector('#account-body');
          const text = body.textContent;
          return {
            title: body.querySelector('.oc-go .acct-title b')?.textContent ?? '',
            note: body.querySelector('.oc-go-note')?.textContent ?? '',
            afterLocalUsage: text.indexOf('Pemakaian lokal OpenCode') >= 0 && text.indexOf('Pemakaian lokal OpenCode') < text.indexOf('Kuota OpenCode Go'),
            rows: [...body.querySelectorAll('.oc-go-row')].map((li) => ({
              model: li.querySelector('.oc-go-model').textContent,
              money: li.querySelector('.oc-go-money').textContent,
              wins: [...li.querySelectorAll('.oc-go-win')].map((w) => ({
                label: w.querySelector('.oc-go-win-label').textContent,
                pct: w.querySelector('.oc-go-pct').textContent,
                tone: w.querySelector('.oc-go-bar i').className,
                width: w.querySelector('.oc-go-bar i').style.width,
                aria: w.querySelector('.oc-go-bar').getAttribute('aria-label'),
                now: w.querySelector('.oc-go-bar').getAttribute('aria-valuenow'),
                height: getComputedStyle(w.querySelector('.oc-go-bar')).height,
              })),
            })),
            toggle: Boolean(body.querySelector('[data-act="oc-go-all"]')),
            page: text,
          };
        });
        assert.equal(r.title, 'Kuota OpenCode Go');
        assert.match(r.note, /Perkiraan/, 'disebut perkiraan, bukan kuota resmi');
        assert.match(r.note, /harga list/);
        assert.match(r.note, /\$10\/bulan/);
        assert.match(r.note, /paket Go/);
        assert.equal(r.afterLocalUsage, true, 'seksi Go tepat setelah pemakaian lokal');
        assert.deepEqual(r.rows.map((x) => x.model), ['DeepSeek V4.1 Flash', 'GLM 5.3', 'Kimi K3', 'Model Gratis', 'Model Tanpa Tabel'], 'urutan kiriman (30 hari tertinggi dulu) tidak diacak');
        assert.equal(r.rows[0].money, 'terpakai $9.60 / $10.00 · sisa $0.40');
        assert.equal(r.rows[1].money, 'terpakai $8.10 / $10.00 · sisa $1.90');
        assert.deepEqual(r.rows[0].wins.map((w) => w.label), ['5 jam', '7 hari', '30 hari']);
        assert.deepEqual(r.rows[0].wins.map((w) => w.pct), ['12%', '80%', '96%'], 'persen dibulatkan');
        assert.deepEqual(r.rows[0].wins.map((w) => w.tone), ['ok', 'warn', 'bad'], 'hijau <70%, kuning 70–90%, merah >90%');
        assert.deepEqual(r.rows[0].wins.map((w) => w.width), ['12%', '80%', '96%']);
        assert.equal(r.rows[0].wins[2].aria, 'DeepSeek V4.1 Flash · 30 hari · 96%', 'label aksesibel: model + jendela + persen');
        assert.equal(r.rows[0].wins[2].now, '96');
        assert.deepEqual(r.rows[0].wins.map((w) => w.height), ['5px', '5px', '5px'], 'bar tipis');
        assert.deepEqual(r.rows[1].wins.map((w) => w.tone), ['ok', 'ok', 'warn'], '81% masih kuning');
        assert.match(r.rows[3].money, /tak terbatas/, 'model tanpa limit: tak terbatas');
        assert.equal(r.rows[3].money, 'terpakai $0.50 / tak terbatas · sisa tak terbatas');
        assert.equal(r.rows[4].money, 'terpakai $0.60 / batas belum diketahui', 'limit tak dikenal bukan "tak terbatas"');
        assert.equal(r.toggle, false, 'lima model: tanpa tombol Tampilkan semua');
        assert.doesNotMatch(r.page, /undefined|NaN|null/);
        assert.equal(await page.eval(horizontalOverflow), null);

        // The plan is unknowable from OpenCode: the user picks it, the server re-estimates with that plan's limits.
        const plans = await page.eval(() => ({
          labels: [...document.querySelectorAll('#account-body .oc-go-plan [data-act="oc-go-plan"]')].map((b) => b.textContent),
          pressed: [...document.querySelectorAll('#account-body .oc-go-plan [data-act="oc-go-plan"]')].map((b) => b.getAttribute('aria-pressed')),
        }));
        assert.deepEqual(plans.labels, ['Go', 'Go Plus', 'Go Teams'], 'tiga paket resmi');
        assert.deepEqual(plans.pressed, ['true', 'false', 'false'], 'Go aktif');
        await page.eval(() => {
          const go = window.__ocAcct.go;
          window.__ocAcct.go = {
            ...go,
            plan: 'plus',
            note: 'Perkiraan dari token × harga list paket Go Plus ($40/bulan).',
            models: [{ model: 'GLM 5.3', limit: 120, used5h: 1, used7d: 3, used30d: 4, remaining: 116 }, ...go.models.slice(1)],
          };
        });
        const before = await page.eval(() => window.__ocAcct.providerCalls);
        await page.click('#account-body .oc-go-plan [data-plan="plus"]');
        await page.waitFor(() => window.__ocAcct.calls.some((c) => c?.path === '/api/account/go-plan'), { timeoutMs: 4000, message: 'POST paket Go' });
        await page.waitFor(() => /Go Plus/.test(document.querySelector('#account-body .oc-go-note')?.textContent ?? ''), { timeoutMs: 4000, message: 'catatan Go Plus' });
        const switched = await page.eval(() => ({
          calls: window.__ocAcct.calls.filter((c) => c?.path === '/api/account/go-plan'),
          pressed: document.querySelector('#account-body .oc-go-plan [data-plan="plus"]')?.getAttribute('aria-pressed'),
          money: document.querySelector('#account-body .oc-go-row .oc-go-money')?.textContent,
          providerCalls: window.__ocAcct.providerCalls,
        }));
        assert.deepEqual(switched.calls, [{ path: '/api/account/go-plan', body: { plan: 'plus' } }], 'hanya paket yang dikirim');
        assert.equal(switched.pressed, 'true', 'tombol Plus aktif');
        assert.match(switched.money, /\$120\.00/, 'batas Plus dipakai, bukan batas Go');
        assert.equal(switched.providerCalls, before + 1, 'satu muat ulang, bukan dua');
        await page.press('Escape');
      } finally {
        await restoreOpenCodeAccount(page);
      }
    });

    // Ten models: the list stops at 8 behind "Tampilkan semua", bars cap at 100%, long names never widen the dialog.
    test('kuota OpenCode Go: top 8 + Tampilkan semua, bar dibatasi 100%, nama panjang tidak melebar', async () => {
      await ensureApp(page, `#${projectId}`);
      try {
        await stubOpenCodeAccount(page, { go: GO_MANY, usage: GO_USAGE });
        await tap(page, '#btn-account');
        await page.waitFor(() => document.querySelectorAll('#account-body .oc-go-row').length === 8, { timeoutMs: 8000, message: 'delapan baris pertama' });
        const collapsed = await page.eval(() => {
          const body = document.querySelector('#account-body');
          const first = body.querySelector('.oc-go-row');
          const win30 = first.querySelectorAll('.oc-go-win')[2];
          const card = document.querySelector('#account-modal .modal-card');
          const list = body.querySelector('.oc-go');
          return {
            models: [...body.querySelectorAll('.oc-go-model')].map((b) => b.textContent),
            pct: win30.querySelector('.oc-go-pct').textContent,
            width: win30.querySelector('.oc-go-bar i').style.width,
            toggle: body.querySelector('[data-act="oc-go-all"]')?.textContent ?? '',
            expanded: body.querySelector('[data-act="oc-go-all"]')?.getAttribute('aria-expanded'),
            wrap: getComputedStyle(body.querySelector('.oc-go-model')).overflowWrap,
            cardX: card.scrollWidth <= card.clientWidth,
            listX: list.scrollWidth <= list.clientWidth,
          };
        });
        assert.equal(collapsed.models.length, 8);
        assert.equal(collapsed.toggle, 'Tampilkan semua (10)');
        assert.equal(collapsed.expanded, 'false');
        assert.equal(collapsed.pct, '120%', 'persen asli tetap tampil');
        assert.equal(collapsed.width, '100%', 'lebar bar dibatasi 100%');
        assert.equal(collapsed.wrap, 'anywhere', 'nama panjang boleh patah di mana saja');
        assert.equal(collapsed.cardX, true, 'dialog tidak melebar');
        assert.equal(collapsed.listX, true, 'daftar tidak melebar');
        assert.equal(await page.eval(horizontalOverflow), null);

        await page.click('#account-body [data-act="oc-go-all"]');
        await page.waitFor(() => document.querySelectorAll('#account-body .oc-go-row').length === 10, { timeoutMs: 4000, message: 'sepuluh baris setelah Tampilkan semua' });
        assert.equal(await page.eval(() => document.querySelector('#account-body [data-act="oc-go-all"]').getAttribute('aria-expanded')), 'true');
        assert.match(await page.eval(() => document.querySelector('#account-body [data-act="oc-go-all"]').textContent), /Tampilkan lebih sedikit/);
        await page.click('#account-body [data-act="oc-go-all"]');
        await page.waitFor(() => document.querySelectorAll('#account-body .oc-go-row').length === 8, { timeoutMs: 4000, message: 'kembali delapan baris' });
        assert.equal(await page.eval(horizontalOverflow), null);
        await page.press('Escape');
      } finally {
        await restoreOpenCodeAccount(page);
      }
    });

    // Hidden without Go (missing/false), the empty state when available, and one providers call for open + double refresh.
    test('kuota OpenCode Go: tersembunyi tanpa Go, state kosong, buka panel & refresh tidak dobel', async () => {
      await ensureApp(page, `#${projectId}`);
      try {
        await stubOpenCodeAccount(page, { go: GO_QUOTA, usage: GO_USAGE });
        // First open loads the panel; closing and reopening must fetch once more (fresh quota, not the cached body).
        await tap(page, '#btn-account');
        await page.waitFor((name) => window.__ocAcct.providerDone >= 1 && [...document.querySelectorAll('#account-body .oc-go-model')].some((b) => b.textContent === name), { timeoutMs: 8000, message: 'kuota Go saat panel dibuka' }, 'DeepSeek V4.1 Flash');
        assert.match(await page.eval(() => document.querySelector('#account-body').textContent), /Kuota OpenCode Go/);
        await page.press('Escape');
        await page.waitFor(() => document.querySelector('#account-modal').hidden, { timeoutMs: 2000, message: 'panel tertutup' });
        const quiet = await page.eval(() => ({ done: window.__ocAcct.providerDone, calls: window.__ocAcct.providerCalls }));
        await tap(page, '#btn-account');
        await page.waitFor((n) => window.__ocAcct.providerDone === n + 1, { timeoutMs: 8000, message: 'satu permintaan providers saat panel dibuka ulang' }, quiet.done);
        await page.waitFor((name) => [...document.querySelectorAll('#account-body .oc-go-model')].some((b) => b.textContent === name), { timeoutMs: 4000, message: 'kuota segar setelah panel dibuka ulang' }, 'DeepSeek V4.1 Flash');
        assert.equal(await page.eval(() => window.__ocAcct.providerCalls), quiet.calls + 1, 'membuka panel menyegarkan kuota sekali');

        // available:false → the whole section is gone, the provider list stays.
        await page.eval(() => (window.__ocAcct.go = { ...window.__ocAcct.go, available: false }));
        await page.click('#account-body [data-act="oc-refresh"]');
        await page.waitFor(() => !document.querySelector('#account-body .oc-go'), { timeoutMs: 4000, message: 'seksi Go tersembunyi (available:false)' });
        assert.match(await page.eval(() => document.querySelector('#account-body').textContent), /Provider OpenCode/);
        assert.equal(await page.eval(() => Boolean(document.querySelector('#account-body [data-act="oc-refresh"]'))), true);

        // available but no models → its own message.
        await page.eval(() => (window.__ocAcct.go = { plan: 'go', available: true, note: '', models: [] }));
        await page.click('#account-body [data-act="oc-refresh"]');
        await page.waitFor(() => /Belum ada pemakaian OpenCode Go yang tercatat\./.test(document.querySelector('#account-body')?.textContent ?? ''), { timeoutMs: 4000, message: 'state kosong Go' });
        const empty = await page.eval(() => ({ rows: document.querySelectorAll('#account-body .oc-go-row').length, toggle: Boolean(document.querySelector('[data-act="oc-go-all"]')) }));
        assert.deepEqual(empty, { rows: 0, toggle: false });

        // A server without `go` at all: still no section (and no leftover markup).
        await page.eval(() => (window.__ocAcct.go = null));
        await page.click('#account-body [data-act="oc-refresh"]');
        await page.waitFor(() => !document.querySelector('#account-body .oc-go'), { timeoutMs: 4000, message: 'seksi Go tersembunyi (go tidak ada)' });
        assert.doesNotMatch(await page.eval(() => document.querySelector('#account-body').textContent), /Kuota OpenCode Go/);

        // Two quick refresh clicks, one providers request: single-flight.
        await page.eval(() => {
          window.__ocAcct.providerCalls = 0;
          window.__ocAcct.providerDone = 0;
          const btn = () => document.querySelector('#account-body [data-act="oc-refresh"]');
          btn().click();
          btn().click();
        });
        await page.waitFor(() => window.__ocAcct.providerDone >= 1, { timeoutMs: 4000, message: 'refresh selesai' });
        assert.deepEqual(await page.eval(() => ({ calls: window.__ocAcct.providerCalls, done: window.__ocAcct.providerDone })), { calls: 1, done: 1 }, 'klik ganda → satu permintaan providers');
        await page.press('Escape');
      } finally {
        await restoreOpenCodeAccount(page);
      }
    });

    test('antrian: alasan "akun berubah" punya label dan satu toast', async () => {
      await ensureApp(page, `#${projectId}`);
      try {
        const r = await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          const { renderComposer } = await import('/js/features/composer.js');
          const project = state.active;
          window.__qPrev = { had: project in state.statuses, value: state.statuses[project] };
          const base = { ...(state.statuses[project] ?? {}) };
          const seen = () => [...document.querySelectorAll('.toast')].filter((t) => /akun berubah/.test(t.textContent)).length;
          state.statuses[project] = { ...base, taskQueue: { waiting: 2, running: 0, failed: 0, paused: true, reason: 'user', rev: 1 } };
          renderComposer();
          const before = seen();
          state.statuses[project] = { ...base, taskQueue: { waiting: 2, running: 0, failed: 0, paused: true, reason: 'account', rev: 2 } };
          renderComposer();
          const chip = document.querySelector('#sb-queue');
          const first = { before, after: seen(), label: chip.getAttribute('aria-label'), text: chip.textContent };
          renderComposer(); // the same pause is not announced again
          return { ...first, again: seen() };
        });
        assert.equal(r.before, 0, 'belum ada toast sebelum alasan akun');
        assert.equal(r.after, 1, 'satu toast saat antrian dijeda karena akun');
        assert.equal(r.again, 1, 'toast tidak berulang pada render berikutnya');
        assert.match(r.label, /dijeda karena akun berubah/);
        assert.match(r.text, /⏸/);
      } finally {
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          const { renderComposer } = await import('/js/features/composer.js');
          if (window.__qPrev?.had) state.statuses[state.active] = window.__qPrev.value;
          else delete state.statuses[state.active];
          delete window.__qPrev;
          renderComposer();
        });
      }
    });

    test('modelStale: peringatan model aktif muncul, hilang saat status bersih, tanpa overflow', async () => {
      await ensureApp(page, `#${projectId}`);
      try {
        const r = await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          const { renderComposer } = await import('/js/features/composer.js');
          const project = state.active;
          window.__stPrev = { had: project in state.statuses, value: state.statuses[project] };
          const base = { ...(state.statuses[project] ?? {}), model: 'opencode-go/kimi-k3', activeModel: null };
          state.statuses[project] = { ...base, modelStale: true };
          renderComposer();
          const box = document.querySelector('#model-stale');
          const shown = { hidden: box.hidden, role: box.getAttribute('role'), text: box.textContent, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
          state.statuses[project] = { ...base, modelStale: false };
          renderComposer();
          return { shown, after: { hidden: box.hidden, text: box.textContent } };
        });
        assert.equal(r.shown.hidden, false);
        assert.equal(r.shown.role, 'alert');
        assert.match(r.shown.text, /opencode-go\/kimi-k3/);
        assert.match(r.shown.text, /model lain \(atau Default\)/);
        assert.ok(r.shown.overflow <= 0, `tidak ada scroll horizontal (${r.shown.overflow}px)`);
        assert.equal(r.after.hidden, true);
        assert.equal(r.after.text, '');
      } finally {
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          const { renderComposer } = await import('/js/features/composer.js');
          if (window.__stPrev?.had) state.statuses[state.active] = window.__stPrev.value;
          else delete state.statuses[state.active];
          delete window.__stPrev;
          renderComposer();
        });
      }
    });

    // The audit is laptop/Tailscale only (the server refuses it from plain WiFi): newest first, error marker, empty state.
    test('riwayat akun: terbaru dulu, penanda gagal, kosong, tersembunyi di WiFi', async () => {
      await ensureApp(page, `#${projectId}`);
      const flags = await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        return { readOnly: state.readOnly, accountAuth: state.accountAuth };
      });
      try {
        await stubAccount(page, {
          profile: { loggedIn: true, email: 'uji@example.com', subscriptionType: 'pro' },
          audit: [
            { ts: '2026-11-01T03:00:00.000Z', action: 'login', engine: 'claude', provider: null, actor: 'laptop', ok: true },
            { ts: '2026-11-03T05:30:00.000Z', action: 'logout', engine: 'claude', provider: null, actor: 'HP Adhit', ok: false },
            { ts: '2026-11-02T01:00:00.000Z', action: 'login', engine: 'opencode', provider: 'anthropic', actor: 'laptop', ok: true },
          ],
        });
        await tap(page, '#btn-account');
        await settle(page, 'account-modal');
        const toggle = '#account-body [data-act="audit-toggle"]';
        await page.waitFor(() => document.querySelector('#account-body [data-act="audit-toggle"]'), { timeoutMs: 4000, message: 'tombol Riwayat perubahan akun' });
        assert.equal(await page.eval(() => document.querySelector('#audit-body')?.hidden), true, 'tertutup sampai diminta');
        await page.click(toggle);
        await page.waitFor(() => document.querySelectorAll('#audit-body .audit-item').length === 3, { timeoutMs: 4000, message: 'tiga entri riwayat' });
        const rows = await page.eval(() => [...document.querySelectorAll('#audit-body .audit-item')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
        assert.match(rows[0], /Keluar/, 'terbaru (logout) di atas');
        assert.match(rows[0], /HP Adhit/);
        assert.match(rows[0], /⚠ gagal/);
        assert.match(rows[1], /Masuk/);
        assert.match(rows[1], /OpenCode · anthropic/);
        assert.match(rows[2], /Masuk/);
        assert.match(rows[2], /laptop ini/);
        assert.equal(await page.eval(() => document.querySelector('#account-body [data-act="audit-toggle"]').getAttribute('aria-expanded')), 'true');
        assert.equal(await page.eval(horizontalOverflow), null);

        // Empty answer: a clear state, no "undefined".
        await page.click(toggle); // close
        await page.eval(() => (window.__acct.scene.audit = []));
        await page.click(toggle); // reopen → fetch
        await page.waitFor(() => /Belum ada perubahan akun/.test(document.querySelector('#audit-body')?.textContent ?? ''), { timeoutMs: 4000, message: 'state kosong' });
        assert.doesNotMatch(await page.eval(() => document.querySelector('#audit-body').textContent), /undefined|null/);
        await page.click(toggle); // close again, so the next checks start collapsed

        // Plain WiFi (read-only): the section is gone entirely.
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.accountAuth = false;
          state.readOnly = true;
          (await import('/js/features/account.js')).onAccountState({ profile: state.account?.profile });
        });
        const wifiBody = await page.eval(() => document.querySelector('#account-body').textContent);
        assert.doesNotMatch(wifiBody, /Riwayat perubahan akun/);
        assert.equal(await page.eval(() => Boolean(document.querySelector('#account-body [data-act="audit-toggle"]'))), false);
      } finally {
        await page.eval(async (f) => {
          const { state } = await import('/js/core/state.js');
          state.readOnly = f.readOnly;
          state.accountAuth = f.accountAuth;
          (await import('/js/features/account.js')).onAccountState({ profile: state.account?.profile });
        }, flags).catch(() => {});
        await page.press('Escape').catch(() => {});
        await restoreAccount(page);
      }
    });

    // A read-only (plain WiFi) phone gets the profile without email/name/org/ids (server: accountPrivacyView).
    test('akun tanpa email (HP WiFi): label "Akun Claude (paket)", dialog tanpa undefined/null', async () => {
      await ensureApp(page, `#${projectId}`);
      const original = await page.eval(async () => structuredClone((await import('/js/core/state.js')).state.account));
      const wifiProfile = { loggedIn: true, subscriptionType: 'team', authMethod: 'claude.ai', role: null, seatTier: null, billingType: null, rateLimitTier: null, accountKey: 'acct-0123456789abcdef' };
      try {
        // The dialog reloads /api/account when it opens: answer it like the server does for a WiFi phone.
        await page.eval((p) => {
          window.__realFetch = window.fetch;
          window.fetch = async (url, opts) => {
            const res = await window.__realFetch(url, opts);
            if (url !== '/api/account') return res;
            const data = await res.json();
            return new Response(JSON.stringify({ ...data, profile: p }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          };
        }, wifiProfile);
        await page.eval(async (p) => (await import('/js/features/account.js')).onAccountState({ profile: p }), wifiProfile);
        const r = await page.eval(() => ({ label: document.querySelector('#account-label').textContent, title: document.querySelector('#btn-account').title, avatar: document.querySelector('#account-avatar').textContent }));
        assert.equal(r.label, 'Akun Claude (team)');
        assert.match(r.title, /^Akun Claude \(team\) — /);
        assert.equal(r.avatar, 'A');
        await tap(page, '#btn-account');
        await settle(page, 'account-modal');
        // The dialog paints the cached state first and replaces it after /api/account answers: wait for that answer.
        await page.waitFor(() => !document.querySelector('#account-body').textContent.includes('@'), { timeoutMs: 3000, message: 'akun WiFi teredaksi' });
        const body = await page.eval(() => document.querySelector('#account-body').textContent);
        await page.press('Escape');
        assert.match(body, /Akun Claude/);
        assert.doesNotMatch(body, /undefined|null|@/);
        assert.equal(await page.eval(horizontalOverflow), null);
      } finally {
        await page.eval(() => window.__realFetch && (window.fetch = window.__realFetch));
        await page.eval(async (a) => (await import('/js/features/account.js')).onAccountState(a ?? { profile: null }), original);
      }
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
        await tap(page, '#btn-template');
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
      await tap(page, '#btn-settings');
      await settle(page, 'settings-modal');
      await page.click('[data-settings-tab="notifikasi"]');
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

    // Sends a prompt to toko (its welcome card goes): the dialog checks above use an empty project of their own.
    test('draf prompt: kembali setelah reload, terhapus setelah server menerima prompt', async () => {
      await ensureApp(page, `#${projectId}`);
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

    test('📎 lampiran: drop log/PDF/gambar → chip (ikon, nama, ukuran, hapus), jenis lain ditolak, paste teks tetap teks, bubble hanya chip', async () => {
      await openApp(page, `#${projectId}`);
      await page.eval(() => {
        document.querySelectorAll('.toast').forEach((t) => t.remove());
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File(['TypeError: boom\n'], 'error "<b>x".log', { type: 'text/plain' }));
        dt.items.add(new File(['%PDF-1.4\n%%EOF\n'], 'spec.pdf', { type: 'application/pdf' }));
        dt.items.add(new File([png], 'shot.png', { type: 'image/png' }));
        dt.items.add(new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' }));
        document.querySelector('.input').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      });
      await page.waitFor(() => document.querySelectorAll('#attachments .att-chip').length === 3, { timeoutMs: 5000, message: '3 chip lampiran' });
      const chips = await page.eval(() => [...document.querySelectorAll('#attachments .att-chip')].map((c) => ({
        kind: c.dataset.kind,
        name: c.querySelector('.att-name').textContent,
        size: c.querySelector('.att-size').textContent,
        img: Boolean(c.querySelector('.att-thumb img')),
        icon: c.querySelector('.att-icon')?.textContent ?? '',
        remove: c.querySelector('button')?.getAttribute('aria-label'),
        fits: c.getBoundingClientRect().right <= document.documentElement.clientWidth,
      })));
      assert.deepEqual(chips.map((c) => [c.kind, c.name, c.size, c.img, c.icon]), [
        ['text', 'error __b_x_.log', '16 B', false, '📄'],
        ['pdf', 'spec.pdf', '15 B', false, '📕'],
        ['image', 'shot.png', '70 B', true, ''],
      ]);
      assert.ok(chips.every((c) => c.remove?.startsWith('Hapus lampiran ') && c.fits), 'tombol hapus bernama, chip tidak melebar');
      assert.ok((await page.eval(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('\n'))).includes('setup.exe: jenis file tidak didukung'));
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(await page.eval(unnamedButtons, '#composer'), []);

      // × removes one; text on the clipboard stays a normal paste even when a file rides along
      await page.eval(() => document.querySelector('#attachments .att-chip[data-kind="pdf"] button').click());
      await page.eval(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', 'baris log panjang\n'.repeat(200));
        dt.items.add(new File(['x'], 'excel.png', { type: 'image/png' }));
        document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await sleep(200);
      assert.equal(await page.eval(() => document.querySelectorAll('#attachments .att-chip').length), 2);

      await typeInPrompt(page, 'lampiran?');
      await page.press('Enter');
      // The newest bubble (earlier 📎 tests in the same project left other "lampiran? …" bubbles with chips).
      await page.waitFor(() => document.querySelector('.msg.user.latest .body')?.textContent === 'lampiran?' && document.querySelectorAll('.msg.user.latest .msg-attachments .att-chip').length === 2, { timeoutMs: 5000, message: 'bubble dengan 2 chip' });
      const bubble = await page.eval(() => {
        const m = document.querySelector('.msg.user.latest');
        return { body: m.querySelector('.body').textContent, chips: [...m.querySelectorAll('.att-chip')].map((c) => c.textContent), buttons: m.querySelectorAll('.att-chip button').length };
      });
      assert.equal(bubble.body, 'lampiran?', 'isi file tidak masuk bubble');
      assert.deepEqual(bubble.chips, ['📄error __b_x_.log16 B', '🖼shot.png70 B']);
      assert.equal(bubble.buttons, 0);
      assert.equal(await page.eval(() => document.querySelector('#attachments').hidden), true, 'kotak lampiran kosong setelah kirim');
      await page.waitFor(() => [...document.querySelectorAll('.msg.assistant')].some((m) => m.textContent.includes('blocks=text,image,text')), { timeoutMs: 5000, message: 'Claude menerima blok text + image' });
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(realProblems(page), []);
    });

    // 📎 helpers for the attachment tests below (in-page, so self-contained)
    const dropLogAndImage = () => {
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File(['TypeError: ulangi\n'], 'ulangi.log', { type: 'text/plain' }));
      dt.items.add(new File([png], 'ulangi.png', { type: 'image/png' }));
      document.querySelector('.input').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    };
    const dropNamed = (name) => {
      const dt = new DataTransfer();
      dt.items.add(new File([`isi ${name}\n`], name, { type: 'text/plain' }));
      document.querySelector('.input').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    };
    const chipNames = () => [...document.querySelectorAll('#attachments .att-chip .att-name')].map((n) => n.textContent);
    const repliesWith = (needle) => [...document.querySelectorAll('.msg.assistant')].filter((m) => m.textContent.includes(needle)).length;
    // A scratch project outside the projects root, so these tests don't lengthen "toko"'s chat the later tests read.
    const addScratchProject = async (name) => {
      const dir = path.join(TMP, `${name}-${vp.mobile ? 'hp' : 'laptop'}`);
      mkdirSync(dir, { recursive: true });
      const id = await page.eval(async (d) => {
        const token = document.querySelector('meta[name="office-token"]').content;
        const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify({ path: d }) });
        return (await r.json()).id;
      }, dir);
      assert.ok(id, `project ${name} dibuat`);
      return id;
    };
    const forgetProject = (id) =>
      page.eval(async (p) => {
        const token = document.querySelector('meta[name="office-token"]').content;
        await fetch(`/api/projects/${p}/forget`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: '{}' });
      }, id);

    test('📎 ↻ Ulangi / Edit prompt terakhir membawa lampirannya lagi; setelah reload hanya teks + catatan', async () => {
      await openApp(page, `#${projectId}`);
      const pid = await addScratchProject('ulangi');
      await openApp(page, `#${pid}`);
      await page.waitFor(() => document.querySelector('#btn-stop').hidden, { timeoutMs: 10000, message: 'tim diam' });
      await page.eval(dropLogAndImage);
      await page.waitFor(() => document.querySelectorAll('#attachments .att-chip').length === 2, { timeoutMs: 5000, message: '2 chip' });
      const full = 'blocks=text,image,text';
      const before = await page.eval(repliesWith, full);
      await typeInPrompt(page, 'lampiran? ulangi');
      await page.press('Enter');
      await page.waitFor((n, s) => [...document.querySelectorAll('.msg.assistant')].filter((m) => m.textContent.includes(s)).length === n, { timeoutMs: 8000, message: 'balasan pertama' }, before + 1, full);
      await page.waitFor(() => document.querySelector('#btn-stop').hidden, { timeoutMs: 8000, message: 'giliran selesai' });

      // ↻ Ulangi: same text and the same files (Claude gets text + image + text again), the bubble shows the chips
      await page.eval(() => document.querySelector('.msg.user.latest [data-msg-act="resend"]').click());
      await page.waitFor((n, s) => [...document.querySelectorAll('.msg.assistant')].filter((m) => m.textContent.includes(s)).length === n, { timeoutMs: 8000, message: 'Ulangi dengan lampiran' }, before + 2, full);
      assert.deepEqual(await page.eval(() => [...document.querySelectorAll('.msg.user.latest .att-chip .att-name')].map((n) => n.textContent)), ['ulangi.log', 'ulangi.png']);
      await page.waitFor(() => document.querySelector('#btn-stop').hidden, { timeoutMs: 8000, message: 'giliran Ulangi selesai' });

      // Edit: text and chips back in the composer (no duplicates on a second Edit), image thumbnail included
      await page.eval(() => document.querySelector('.msg.user.latest [data-msg-act="edit"]').click());
      await page.eval(() => document.querySelector('.msg.user.latest [data-msg-act="edit"]').click());
      assert.equal(await page.eval(() => document.querySelector('#prompt').value), 'lampiran? ulangi');
      assert.deepEqual(await page.eval(chipNames), ['ulangi.log', 'ulangi.png']);
      assert.equal(await page.eval(() => Boolean(document.querySelector('#attachments .att-chip[data-kind="image"] img'))), true, 'thumbnail kembali');
      assert.equal(await page.eval(horizontalOverflow), null);
      await page.eval(() => {
        while (document.querySelector('#attachments .att-chip button')) document.querySelector('#attachments .att-chip button').click();
        const input = document.querySelector('#prompt');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true })); // the stored draft goes too (later tests start clean)
      });

      // after a reload the files are gone from memory: Ulangi sends the text only and says so; Edit says so too
      await openApp(page, `#${pid}`);
      await page.eval(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      const textOnly = 'blocks=text docs=-';
      const beforeText = await page.eval(repliesWith, textOnly);
      await page.eval(() => document.querySelector('.msg.user.latest [data-msg-act="resend"]').click());
      await page.waitFor(() => [...document.querySelectorAll('.toast.warn')].some((t) => t.textContent.includes('Lampiran tidak ikut: muat ulang halaman menghapusnya')), { timeoutMs: 5000, message: 'catatan lampiran tidak ikut' });
      await page.waitFor((n, s) => [...document.querySelectorAll('.msg.assistant')].filter((m) => m.textContent.includes(s)).length === n, { timeoutMs: 8000, message: 'Ulangi hanya teks' }, beforeText + 1, textOnly);
      await page.waitFor(() => document.querySelector('#btn-stop').hidden, { timeoutMs: 8000, message: 'giliran selesai' });
      await page.eval(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      // the text-only resend is now the latest prompt; Edit on the earlier bubble with chips: text back, note shown
      await page.eval(() => [...document.querySelectorAll('.msg.user')].filter((m) => m.querySelector('.msg-attachments')).at(-1).querySelector('[data-msg-act="edit"]').click());
      assert.equal(await page.eval(() => document.querySelector('#prompt').value), 'lampiran? ulangi');
      assert.deepEqual(await page.eval(chipNames), []);
      assert.ok(await page.eval(() => [...document.querySelectorAll('.toast.warn')].some((t) => t.textContent.includes('Lampiran tidak ikut'))));
      await page.eval(() => {
        const input = document.querySelector('#prompt');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelectorAll('.toast').forEach((t) => t.remove());
      });
      await page.waitFor((k) => localStorage.getItem(k) === null, { timeoutMs: 3000, message: 'draf Edit dihapus' }, `office.draft.${pid}`);
      assert.deepEqual(realProblems(page), []);
      await forgetProject(pid);
      await openApp(page, `#${projectId}`);
    });

    test('📎 draf: chip lampiran tetap milik project-nya saat pindah project (memori saja), hilang setelah terkirim', async () => {
      await openApp(page, `#${projectId}`);
      const other = await addScratchProject('lampiran');
      const select = (id) => page.eval(async (p) => (await import('/js/features/picker.js')).selectProject(p), id);

      await page.eval(dropNamed, 'toko.log');
      await page.waitFor(() => document.querySelectorAll('#attachments .att-chip').length === 1, { timeoutMs: 5000, message: 'chip toko' });
      await select(other);
      assert.deepEqual(await page.eval(chipNames), [], 'project lain: kotak lampiran kosong');
      assert.equal(await page.eval(() => document.querySelector('#attachments').hidden), true);
      await page.eval(dropNamed, 'kasir.log');
      await page.waitFor(() => document.querySelectorAll('#attachments .att-chip').length === 1, { timeoutMs: 5000, message: 'chip kasir' });
      await select(projectId);
      assert.deepEqual(await page.eval(chipNames), ['toko.log'], 'kembali: chip toko dipulihkan');
      await select(other);
      assert.deepEqual(await page.eval(chipNames), ['kasir.log']);
      assert.equal(await page.eval(() => Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? '').includes('isi kasir'))), false, 'isi lampiran tidak di localStorage');

      // sent (in the scratch project): its box empties and stays empty across switches; toko keeps its own chip
      await typeInPrompt(page, 'kirim draf dengan lampiran');
      await page.press('Enter');
      await page.waitFor(() => document.querySelector('.msg.user.latest .body')?.textContent === 'kirim draf dengan lampiran' && [...document.querySelectorAll('.msg.user.latest .att-chip .att-name')].map((n) => n.textContent).join() === 'kasir.log', { timeoutMs: 8000, message: 'terkirim dengan kasir.log' });
      assert.deepEqual(await page.eval(chipNames), []);
      await page.waitFor(() => document.querySelector('#btn-stop').hidden, { timeoutMs: 8000, message: 'giliran selesai' });
      await select(projectId);
      assert.deepEqual(await page.eval(chipNames), ['toko.log'], 'toko: chip-nya tetap');
      await page.eval(() => document.querySelector('#attachments .att-chip button').click());
      await select(other);
      assert.deepEqual(await page.eval(chipNames), [], 'kasir: kosong setelah terkirim');
      await select(projectId);
      assert.deepEqual(await page.eval(chipNames), [], 'toko: chip yang dihapus tidak kembali');
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(realProblems(page), []);
      await forgetProject(other);
    });

    test('⚙ Tema kantor: pilih Halloween → tersimpan, bertahan setelah reload, sprite & avatar berganti; kembali ke Kantor', async (t) => {
      await ensureApp(page, `#${projectId}`);
      // Starts on the default theme (the palette test, or a failed run of this one, may have left another stored).
      if ((await page.eval(() => localStorage.getItem('office.theme'))) !== null) {
        await page.eval(() => localStorage.removeItem('office.theme'));
        await openApp(page, `#${projectId}`);
      }
      // Whatever happens, the next test gets Kantor back.
      t.after(() => page.eval(() => localStorage.removeItem('office.theme')).catch(() => {}));
      page.clearProblems();
      const openSettings = async () => {
        await page.eval(() => document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)));
        await tap(page, '#btn-settings');
        await settle(page, 'settings-modal');
        await page.click('[data-settings-tab="umum"]');
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
      // phone: the strip chip is short ("⧗ 2"), its aria-label says the rest
      assert.match(chip.statusline, vp.mobile ? new RegExp(`^⧗ ${n}$`) : new RegExp(`⧗ ${n} tugas berjalan`));
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
      await tap(page, '#sb-tasks');
      await page.waitFor(() => !document.querySelector('#tasks-modal').hidden && document.querySelectorAll('#tasks-list [data-task]').length >= 2, { timeoutMs: 3000, message: 'monitor terbuka dengan daftar' });
      const groups = await page.eval(() => [...document.querySelectorAll('#tasks-list .tasks-group')].map((g) => g.textContent));
      assert.match(groups[0], /^Berjalan/, 'yang berjalan di atas');

      // Agent detail: live steps (labels like the chat), auto-scrolled to the newest.
      await page.eval(() => [...document.querySelectorAll('#tasks-list [data-task]')].find((b) => b.textContent.includes('Uji regresi')).click());
      await page.waitFor(() => document.querySelectorAll('#td-body .td-steps .step').length >= 2, { timeoutMs: 5000, message: 'langkah agent tampil' });
      // The agent is started once per run: by the second viewport it can be past the newest DETAIL_MAX_STEPS (200)
      // the monitor shows, so "grows" means more steps or, once full, a newer last step.
      const lastStep = () => {
        const steps = document.querySelectorAll('#td-body .td-steps .step');
        return { n: steps.length, last: steps[steps.length - 1]?.textContent ?? '' };
      };
      const before = await page.eval(lastStep);
      await page.waitFor((b) => {
        const steps = document.querySelectorAll('#td-body .td-steps .step');
        return steps.length > b.n || (steps[steps.length - 1]?.textContent ?? '') !== b.last;
      }, { timeoutMs: 6000, message: 'langkah bertambah (polling)' }, before);
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
      if (!vp.mobile && (await page.eval(() => document.querySelector('.office').classList.contains('team-hidden')))) await page.click('#team-toggle');
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
      await openApp(page, `#${projectId}`); // self-contained: also runs alone (--test-name-pattern)
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
      // The new row is picked by its message id, not by position (earlier tests leave a chat of varying length).
      const known = await page.eval(() => [...document.querySelectorAll('#chat > .line.tool')].map((n) => n.dataset.id));
      await page.eval(async (pid) => {
        const token = document.querySelector('meta[name="office-token"]').content;
        await fetch(`/api/projects/${pid}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify({ text: 'jalankan perintah panjang' }) });
      }, projectId);
      const rowId = await page.waitFor((ids) => [...document.querySelectorAll('#chat > .line.tool')].find((n) => !ids.includes(n.dataset.id))?.dataset.id, { timeoutMs: 8000, message: 'baris perintah muncul' }, known);
      // Looked up again on every read (a resync redraws the chat) and kept on screen: live output is only read
      // for rows in view, so this test does not depend on where the chat happens to be scrolled.
      await page.eval((id) => {
        window.__liveRow = () => {
          const r = document.querySelector(`#chat > [data-id="${CSS.escape(id)}"]`);
          r?.scrollIntoView({ block: 'nearest' });
          return r;
        };
      }, rowId);
      // Collapsed: the last lines appear under the row and grow while it runs.
      const tail = () => window.__liveRow()?.querySelector('.live-tail:not([hidden])')?.textContent ?? '';
      await page.waitFor(() => /compile modul-/.test(window.__liveRow()?.querySelector('.live-tail:not([hidden])')?.textContent ?? ''), { timeoutMs: 6000, message: 'ekor output tampil di baris tertutup' });
      const first = await page.eval(tail);
      await page.waitFor((t) => (window.__liveRow()?.querySelector('.live-tail')?.textContent ?? '') !== t, { timeoutMs: 5000, message: 'ekor output bertambah' }, first);
      assert.ok((await page.eval(() => window.__liveRow().querySelectorAll('.live-tail span').length)) <= 8, 'paling banyak 8 baris ringkas');
      // Expanded: the whole live output, still growing.
      await page.eval(() => window.__liveRow().querySelector('.row').click());
      await page.waitFor(() => /compile modul-/.test(window.__liveRow()?.querySelector('[data-live-out]')?.textContent ?? ''), { timeoutMs: 4000, message: 'blok output live terbuka' });
      const len = await page.eval(() => window.__liveRow().querySelector('[data-live-out]').textContent.length);
      await page.waitFor((l) => (window.__liveRow()?.querySelector('[data-live-out]')?.textContent.length ?? Infinity) > l, { timeoutMs: 5000, message: 'output live bertambah' }, len);
      assert.equal(await page.eval(horizontalOverflow), null, 'output live tanpa scroll horizontal');
      // Done: the final output (tool_result) replaces the live block; no more reads.
      await page.waitFor(() => window.__liveRow()?.classList.contains('st-ok'), { timeoutMs: 12000, message: 'perintah selesai' });
      const done = await page.eval(() => {
        const r = window.__liveRow();
        return { live: Boolean(r.querySelector('[data-live-out], .live-tail')), out: r.querySelector('pre.out')?.textContent ?? '' };
      });
      assert.equal(done.live, false, 'blok live hilang setelah selesai');
      assert.match(done.out, /\[16\/16\][\s\S]*Build selesai\./);
      const calls = await page.eval(() => window.__liveCalls);
      assert.ok(calls >= 2, `task-output dibaca ${calls}x`);
      await sleep(3500);
      assert.equal(await page.eval(() => window.__liveCalls), calls, 'polling berhenti setelah perintah selesai');
      assert.deepEqual(realProblems(page), []);
    });

    test('chat tetap mengikuti pesan terbaru setelah pindah project cepat berkali-kali; ↓ Terbaru tetap jalan', async () => {
      await openApp(page, `#${projectId}`);
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      // Own scratch projects: a & b get a long history, c stays empty (welcome card).
      const pids = [await addScratchProject('ikut-a'), await addScratchProject('ikut-b'), await addScratchProject('ikut-c')];
      const post = (pid, text) =>
        page.eval(async (p, t) => {
          const token = document.querySelector('meta[name="office-token"]').content;
          await fetch(`/api/projects/${p}/${t ? 'prompt' : 'stop'}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(t ? { text: t } : {}) });
        }, pid, text);
      const chatPos = () => {
        const chat = document.querySelector('#chat');
        return { dist: Math.round(chat.scrollHeight - chat.scrollTop - chat.clientHeight), jumpHidden: document.querySelector('#jump-latest').hidden };
      };
      try {
        await post(pids[0], 'jawab lama');
        await post(pids[1], 'jawab lama');
        await page.waitFor(async (ps) => {
          const { state } = await import('/js/core/state.js');
          return ps.every((p) => (state.chats[p] ?? []).some((m) => m.kind === 'assistant' && /kata399/.test(m.text ?? '')) && !state.statuses[p]?.busy);
        }, { timeoutMs: 25000, message: 'riwayat panjang di a & b' }, pids.slice(0, 2));
        // Rapid switching like a user clicking through the picker (selectProject), ending on a.
        const switchRapidly = (ps) =>
          page.eval(async (ids) => {
            const { selectProject } = await import('/js/features/picker.js');
            const frame = () => new Promise((res) => requestAnimationFrame(() => res()));
            const wait = (ms) => new Promise((res) => setTimeout(res, ms));
            const order = [ids[0], ids[1], ids[2], ids[0], ids[2], ids[1], ids[0], ids[1], ids[0]];
            for (const [i, p] of order.entries()) {
              selectProject(p);
              await (i % 3 === 0 ? frame() : wait(i * 7));
            }
          }, ps);
        await switchRapidly(pids);
        await sleep(300);
        const settled = await page.eval(chatPos);
        assert.ok(settled.dist < 60, `setelah pindah cepat chat di pesan terbaru (jarak ${settled.dist}px)`);
        assert.equal(settled.jumpHidden, true, 'setelah pindah cepat tombol ↓ Terbaru tidak muncul');
        // A reply streaming in a (started while away, so no "your own prompt" force-scroll), then switch again.
        await page.eval(async (p) => (await import('/js/features/picker.js')).selectProject(p), pids[1]);
        await post(pids[0], 'jawab lama lagi');
        await page.waitFor(async (p) => {
          const { state } = await import('/js/core/state.js');
          return (state.chats[p] ?? []).some((m) => m.kind === 'assistant' && m.streaming);
        }, { timeoutMs: 8000, message: 'balasan baru mulai mengalir di a' }, pids[0]);
        await switchRapidly(pids);
        await page.waitFor(() => /kata1[5-9]\d/.test(document.querySelector('#chat .msg.assistant.streaming')?.textContent ?? ''), { timeoutMs: 10000, message: 'balasan terus mengalir' });
        const streaming = await page.eval(chatPos);
        assert.ok(streaming.dist < 60, `chat ikut ke bawah saat balasan mengalir (jarak ${streaming.dist}px)`);
        assert.equal(streaming.jumpHidden, true, 'tombol ↓ Terbaru tidak muncul saat masih mengikuti');
        // The user scrolls up to read: following stops and ↓ Terbaru shows; clicking it resumes following.
        await page.eval(() => (document.querySelector('#chat').scrollTop = 0));
        await page.waitFor(() => !document.querySelector('#jump-latest').hidden, { timeoutMs: 2000, message: 'tombol ↓ Terbaru muncul setelah scroll ke atas' });
        await sleep(400);
        assert.ok((await page.eval(chatPos)).dist > 200, 'scroll ke atas tidak ditarik kembali ke bawah');
        await page.click('#jump-latest');
        await sleep(400);
        const resumed = await page.eval(chatPos);
        assert.ok(resumed.dist < 60 && resumed.jumpHidden, `↓ Terbaru kembali mengikuti (${JSON.stringify(resumed)})`);
      } finally {
        // Leave nothing behind for the next test: the stopped turn must finish (its late chat updates for a
        // project the page no longer knows would make the next test's page re-sync and redraw its chat), then
        // the scratch projects go and the page is back on toko.
        await post(pids[0], null).catch(() => {});
        for (let i = 0; i < 50; i++) {
          const snap = await snapshot().catch(() => null);
          if (snap && pids.every((p) => !snap.statuses?.[p]?.busy)) break;
          await sleep(200);
        }
        await sleep(300);
        for (const p of pids) await forgetProject(p).catch(() => {});
        await page.eval(async (p) => (await import('/js/features/picker.js')).selectProject(p), projectId).catch(() => {});
      }
      assert.deepEqual(realProblems(page), []);
    });

    test('⚠ deteksi macet: chip di baris tool & delegasi (jam digeser), aksi, kantor, fokus, tanpa auto-stop', async (t) => {
      // An idle project of its own: toko's live status events (e.g. background tasks started by other tests) would
      // overwrite the busy status faked below in the middle of the test.
      const tmpId = await addTempProject(`macet-1-${vp.mobile ? 'hp' : 'laptop'}`);
      t.after(() => forgetTempProject(tmpId));
      await openApp(page, `#${tmpId}`);
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      await page.eval(() => document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)));
      // Client-side only: a busy status and two running rows (no task id: nothing is read from the server).
      const r = await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        const { appendChat } = await import('/js/features/chat.js');
        const { onChatUpdate } = await import('/js/core/stream.js');
        const { checkStuck, stuck, stuckClock } = await import('/js/features/stuck.js');
        const { sceneFor } = await import('/js/core/scenes.js');
        // A stream resync in flight (stray events of another test's project) pauses the detector: wait for its snapshot.
        for (let i = 0; i < 100 && !stuck.online; i++) await new Promise((res) => setTimeout(res, 50));
        const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
        // A normal tick at "start + min": the previous tick was 15 s ago (not a sleep/wake jump).
        const tick = (min) => {
          stuckClock.now = () => Date.now() + min * 60_000;
          stuck.lastTick = stuckClock.now() - 15_000;
          checkStuck();
        };
        const pid = state.active;
        const savedStatus = state.statuses[pid];
        state.statuses[pid] = { ...savedStatus, busy: true };
        const now = Date.now();
        const tool = { id: 'stuck-tool', project: pid, ts: now, kind: 'tool', role: 'dba', tool: 'Bash', text: 'until grep -q X file; do sleep 2; done', status: 'running', input: { command: 'until grep -q X file; do sleep 2; done' } };
        const dele = { id: 'stuck-dele', project: pid, ts: now, kind: 'delegate', role: 'data', from: 'claude', text: 'Perbaiki API', status: 'running', input: { prompt: 'x' } };
        for (const m of [tool, dele]) {
          (state.chats[pid] ??= []).push(m);
          appendChat(m);
        }
        const calls = [];
        const origFetch = window.fetch;
        window.fetch = (url, opts) => {
          if (/\/(stop|background|task-stop)$/.test(String(url))) {
            calls.push(String(url).split('/').pop());
            return Promise.resolve(new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }));
          }
          return origFetch(url, opts);
        };
        const chip = (id) => document.querySelector(`#chat > [data-id="${id}"] > .stuck-chip`);
        const mine = () => [...stuck.episodes.keys()].filter((k) => /\|(dba|data)$/.test(k)).sort();
        const out = {};
        try {
          tick(4);
          out.at4 = { tool: chip('stuck-tool')?.textContent ?? null, dele: chip('stuck-dele')?.textContent ?? null };
          tick(11 + 5 / 60);
          out.at11 = {
            tool: chip('stuck-tool').querySelector('.stuck-text').textContent,
            toolActs: [...chip('stuck-tool').querySelectorAll('button')].map((b) => [b.dataset.stuckAct, b.disabled]),
            dele: chip('stuck-dele').querySelector('.stuck-text').textContent,
            deleActs: [...chip('stuck-dele').querySelectorAll('button')].map((b) => [b.dataset.stuckAct, b.disabled]),
            office: { dba: sceneFor(pid).people.dba?.stuck ?? null, data: sceneFor(pid).people.data?.stuck ?? null },
            episodes: mine(),
            autoStopped: calls.length,
            // Layout while the chips are up (phone: 390 px).
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            chipsInside: [chip('stuck-tool'), chip('stuck-dele')].every((c) => c.getBoundingClientRect().right <= document.documentElement.clientWidth + 0.5),
            unnamed: [...document.querySelectorAll('#chat .stuck-chip button')].filter((b) => !/[\p{L}\p{N}]/u.test(b.textContent) && !b.getAttribute('aria-label')).length,
          };
          // A minute later: same episode, the text counts on, a focused button keeps its focus.
          chip('stuck-tool').querySelector('[data-stuck-act="stop"]').focus();
          tick(12 + 5 / 60);
          out.at12 = { tool: chip('stuck-tool').querySelector('.stuck-text').textContent, focusKept: document.activeElement?.dataset?.stuckAct === 'stop', episodes: mine().length };
          // An "elapsed" update redraws the whole row: the focused chip button is focused again.
          onChatUpdate({ project: pid, id: 'stuck-tool', patch: { elapsed: 700 } });
          await frame();
          out.focusAfterElapsed = document.activeElement?.dataset?.stuckAct === 'stop' && Boolean(document.activeElement.closest('[data-id="stuck-tool"]'));
          chip('stuck-tool').querySelector('[data-stuck-act="stop"]').click();
          chip('stuck-dele').querySelector('[data-stuck-act="detail"]').click();
          await new Promise((res) => setTimeout(res, 100));
          out.calls = [...calls];
          out.deleOpen = document.querySelector('#chat > [data-id="stuck-dele"]').classList.contains('open');
          out.chipAfterRerender = Boolean(chip('stuck-dele'));
          // The tool ends (chat_update) while its verdict is still cached: no chip, and a stale Stop does nothing.
          const staleStop = chip('stuck-tool').querySelector('[data-stuck-act="stop"]');
          onChatUpdate({ project: pid, id: 'stuck-tool', patch: { status: 'ok', output: 'selesai' } });
          await frame();
          out.chipAfterDone = Boolean(chip('stuck-tool'));
          staleStop.click(); // detached button of the old row: nothing happens
          await new Promise((res) => setTimeout(res, 50));
          out.callsAfterDone = calls.length;
        } finally {
          // Ended: chips and the office mark go away.
          tool.status = 'cancel';
          dele.status = 'cancel';
          stuckClock.now = () => Date.now();
          stuck.lastTick = null;
          state.statuses[pid] = savedStatus;
          checkStuck();
          out.cleared = { tool: Boolean(chip('stuck-tool')), dele: Boolean(chip('stuck-dele')), office: Boolean(sceneFor(pid).people.dba?.stuck || sceneFor(pid).people.data?.stuck) };
          for (const id of ['stuck-tool', 'stuck-dele']) state.chats[pid].splice(state.chats[pid].findIndex((m) => m.id === id), 1);
          window.fetch = origFetch;
        }
        return out;
      });
      assert.deepEqual(r.at4.dele, null, 'delegasi belum 5 mnt');
      assert.equal(r.at4.tool, null, 'tool tanpa output terbaca: hanya aturan 10 mnt');
      assert.equal(r.at11.tool, '⚠ Berjalan 11 mnt — mungkin macet');
      assert.deepEqual(r.at11.toolActs, [['stop', false], ['background', false]]);
      assert.match(r.at11.dele, /^⚠ .+ tidak ada aktivitas 11 mnt$/);
      assert.deepEqual(r.at11.deleActs, [['detail', false], ['stop', false]]);
      assert.deepEqual(r.at11.office, { dba: true, data: true }, 'yang macet ditandai di kantor');
      assert.equal(r.at11.episodes.length, 2, 'satu episode per orang');
      assert.equal(r.at11.autoStopped, 0, 'tidak pernah menghentikan sendiri');
      assert.equal(r.at12.tool, '⚠ Berjalan 12 mnt — mungkin macet');
      assert.equal(r.at12.focusKept, true, 'fokus tetap di tombol');
      assert.equal(r.at12.episodes, 2);
      assert.equal(r.focusAfterElapsed, true, 'fokus bertahan setelah update elapsed');
      assert.deepEqual(r.calls, ['stop']);
      assert.equal(r.deleOpen, true, 'Lihat detail (tanpa tugas) membuka instruksi & laporan');
      assert.equal(r.chipAfterRerender, true, 'chip tetap ada setelah baris digambar ulang');
      assert.equal(r.chipAfterDone, false, 'baris selesai: chip hilang tanpa menunggu tick');
      assert.equal(r.callsAfterDone, 1, 'Stop dari chip basi tidak terkirim');
      assert.deepEqual(r.cleared, { tool: false, dele: false, office: false });
      assert.equal(r.at11.overflow, false, 'chip tanpa scroll horizontal');
      assert.equal(r.at11.chipsInside, true, 'chip muat di layar');
      assert.equal(r.at11.unnamed, 0, 'tombol punya nama aksesibel');
      assert.equal(await page.eval(horizontalOverflow), null);
      await page.eval(() => document.querySelectorAll('#chat > [data-id^="stuck-"]').forEach((n) => n.remove()));
      assert.deepEqual(realProblems(page), []);
    });

    test('⚠ deteksi macet: tidak saat menunggu izin (jam mulai ulang), tidak ada notifikasi beruntun setelah laptop tidur', async (t) => {
      // An idle project of its own: toko's live status events (e.g. background tasks started by other tests) would
      // overwrite the busy status faked below in the middle of the test.
      const tmpId = await addTempProject(`macet-2-${vp.mobile ? 'hp' : 'laptop'}`);
      t.after(() => forgetTempProject(tmpId));
      await openApp(page, `#${tmpId}`);
      const r = await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        const { appendChat } = await import('/js/features/chat.js');
        const { checkStuck, stuck, stuckClock } = await import('/js/features/stuck.js');
        // A stream resync in flight (stray events of another test's project) pauses the detector: wait for its snapshot.
        for (let i = 0; i < 100 && !stuck.online; i++) await new Promise((res) => setTimeout(res, 50));
        const tick = (min, { wake = false } = {}) => {
          stuckClock.now = () => Date.now() + min * 60_000;
          if (!wake) stuck.lastTick = stuckClock.now() - 15_000;
          checkStuck();
        };
        const pid = state.active;
        const savedStatus = state.statuses[pid];
        state.statuses[pid] = { ...savedStatus, busy: true };
        const tool = { id: 'stuck-wait', project: pid, ts: Date.now(), kind: 'tool', role: 'dba', tool: 'WebFetch', text: 'Fetch https://x', status: 'running', input: {} };
        (state.chats[pid] ??= []).push(tool);
        appendChat(tool);
        const chip = () => Boolean(document.querySelector('#chat > [data-id="stuck-wait"] > .stuck-chip'));
        const out = {};
        try {
          // A permission card is waiting: no verdict however long it takes.
          state.approvals.set('stuck-ap', { id: 'stuck-ap', project: pid, status: 'pending', role: 'dba', label: 'x' });
          tick(11);
          out.waiting = chip();
          // Answered at +11: the clock starts again, so +20 is only 9 minutes of running.
          state.approvals.delete('stuck-ap');
          tick(20);
          out.afterWait9 = chip();
          tick(21.5);
          out.afterWait10 = chip();
          // Reset, then: the laptop sleeps 60 minutes between two ticks: nothing stuck, no notification burst.
          tool.status = 'cancel';
          stuck.lastTick = null;
          stuckClock.now = () => Date.now();
          checkStuck();
          tool.status = 'running';
          tool.ts = Date.now();
          tick(1);
          const episodesBefore = new Set(stuck.episodes.keys());
          tick(61, { wake: true });
          out.afterSleep = { chip: chip(), newEpisodes: [...stuck.episodes.keys()].filter((k) => !episodesBefore.has(k)).length };
        } finally {
          state.approvals.delete('stuck-ap');
          tool.status = 'cancel';
          stuckClock.now = () => Date.now();
          stuck.lastTick = null;
          state.statuses[pid] = savedStatus;
          checkStuck();
          state.chats[pid].splice(state.chats[pid].indexOf(tool), 1);
          document.querySelector('#chat > [data-id="stuck-wait"]')?.remove();
        }
        return out;
      });
      assert.deepEqual(r, { waiting: false, afterWait9: false, afterWait10: true, afterSleep: { chip: false, newEpisodes: 0 } });
      assert.deepEqual(realProblems(page), []);
    });

    test('⚠ deteksi macet: dua delegasi role sama paralel dicocokkan lewat taskId, lastActivityAt tanpa baca task-detail', async (t) => {
      // An idle project of its own: toko's live status events (e.g. background tasks started by other tests) would
      // overwrite the busy status faked below in the middle of the test.
      const tmpId = await addTempProject(`macet-3-${vp.mobile ? 'hp' : 'laptop'}`);
      t.after(() => forgetTempProject(tmpId));
      await openApp(page, `#${tmpId}`);
      const r = await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        const { appendChat } = await import('/js/features/chat.js');
        const { checkStuck, stuck, stuckClock } = await import('/js/features/stuck.js');
        // A stream resync in flight (stray events of another test's project) pauses the detector: wait for its snapshot.
        for (let i = 0; i < 100 && !stuck.online; i++) await new Promise((res) => setTimeout(res, 50));
        const tick = (min) => {
          stuckClock.now = () => Date.now() + min * 60_000;
          stuck.lastTick = stuckClock.now() - 15_000;
          checkStuck();
        };
        const pid = state.active;
        const savedStatus = state.statuses[pid];
        const now = Date.now();
        // Same role, same start: role + nearest start time alone cannot tell them apart.
        const task = (id, toolUseId, lastActivityAt) => ({ id, kind: 'agent', agent: 'backend', role: 'backend', status: 'running', background: true, startedAt: now, toolUseId, lastActivityAt });
        state.statuses[pid] = { ...savedStatus, busy: true, tasks: [task('T-a', 'a1', now + 9 * 60_000), task('T-b', 'a2', now)] };
        const row = (id, toolUseId, taskId) => ({ id, project: pid, ts: now, kind: 'delegate', role: 'backend', from: 'claude', text: id, status: 'running', input: { prompt: 'x' }, toolUseId, taskId });
        const rows = [row('stuck-par-b', 'a2', 'T-b'), row('stuck-par-a', 'a1', 'T-a')];
        for (const m of rows) {
          (state.chats[pid] ??= []).push(m);
          appendChat(m);
        }
        let detailReads = 0;
        const origFetch = window.fetch;
        window.fetch = (url, opts) => {
          if (/\/task-detail$/.test(String(url))) detailReads++;
          return origFetch(url, opts);
        };
        const chip = (id) => Boolean(document.querySelector(`#chat > [data-id="${id}"] > .stuck-chip`));
        const out = {};
        try {
          for (const min of [2, 4, 6, 8, 11]) tick(min); // quiet long enough that task-detail would have been read before
          await new Promise((res) => setTimeout(res, 50));
          out.chips = { a: chip('stuck-par-a'), b: chip('stuck-par-b') };
          out.taskOfB = stuck.verdicts.get(`${pid}|stuck-par-b`)?.taskId ?? null;
          out.detailReads = detailReads;
        } finally {
          for (const m of rows) m.status = 'cancel';
          stuckClock.now = () => Date.now();
          stuck.lastTick = null;
          state.statuses[pid] = savedStatus;
          checkStuck();
          for (const m of rows) {
            state.chats[pid].splice(state.chats[pid].indexOf(m), 1);
            document.querySelector(`#chat > [data-id="${m.id}"]`)?.remove();
          }
          window.fetch = origFetch;
        }
        return out;
      });
      assert.deepEqual(r.chips, { a: false, b: true }, 'hanya yang benar-benar diam yang ditandai');
      assert.equal(r.taskOfB, 'T-b', 'Lihat detail membuka tugasnya sendiri');
      assert.equal(r.detailReads, 0, 'lastActivityAt cukup: tidak membaca task-detail');
      assert.deepEqual(realProblems(page), []);
    });

    test('nama role yang diganti berisi HTML tampil sebagai teks di baris delegasi dan aktivitas', async () => {
      await openApp(page, `#${projectId}`);
      const r = await page.eval(async () => {
        const { CAST } = await import('/js/office/cast.js');
        const { appendChat } = await import('/js/features/chat.js');
        const { appendActivity } = await import('/js/features/activity.js');
        const saved = CAST.data.name;
        window.__xss = 0;
        CAST.data.name = '<img src=x onerror="window.__xss++">';
        try {
          appendChat({ id: 'xss-dele', ts: Date.now(), kind: 'delegate', role: 'data', from: 'claude', text: 'cek', status: 'ok', input: {} }, false);
          appendActivity({ ts: Date.now(), kind: 'tool_start', role: 'data', label: 'x' }, false);
          await new Promise((res) => setTimeout(res, 100));
          const row = document.querySelector('#chat > [data-id="xss-dele"]');
          return { injected: document.querySelectorAll('img[src="x"]').length, text: row.querySelector('.txt b').textContent, fired: window.__xss };
        } finally {
          CAST.data.name = saved;
          document.querySelector('#chat > [data-id="xss-dele"]')?.remove();
        }
      });
      assert.deepEqual(r, { injected: 0, text: '<img src=x onerror="window.__xss++">', fired: 0 });
      assert.deepEqual(realProblems(page), []);
    });

    test('📄 penampil file: dari path di jawaban (:line disorot), baris tool Read, tab Perubahan; cari, escape, rapi', async () => {
      await ensureApp(page, `#${projectId}`);
      const proj = path.join(TMP, 'projects', 'toko');
      writeFileSync(path.join(proj, 'src', 'app.js'), 'const a = 1;\n/* multi\nbaris */\n<b>tebal</b>\nconst b = "nilai";\n');
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      // The reply is picked by its message id, not by position (other turns, e.g. background tasks, may add bubbles).
      const known = await page.eval(() => [...document.querySelectorAll('#chat .msg.assistant')].map((n) => n.dataset.id));
      await page.eval(async (pid) => {
        const token = document.querySelector('meta[name="office-token"]').content;
        await fetch(`/api/projects/${pid}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify({ text: 'sebut file' }) });
      }, projectId);
      const replyId = await page.waitFor((ids) => [...document.querySelectorAll('#chat .msg.assistant')].find((n) => !ids.includes(n.dataset.id) && n.querySelector('.file-link[data-file="src/app.js"]'))?.dataset.id, { timeoutMs: 8000, message: 'path di jawaban jadi link' }, known);
      await page.eval((id) => (window.__fileReply = () => document.querySelector(`#chat [data-id="${CSS.escape(id)}"]`)), replyId);
      const links = await page.eval(() => [...window.__fileReply().querySelectorAll('.file-link')].map((b) => [b.dataset.file, b.dataset.line ?? null]));
      assert.deepEqual(links, [['src/checkout.ts', '2'], ['src/app.js', '3'], ['src/hilang.ts', null]], 'URL tidak ikut jadi link');

      // From the answer, with :line
      await page.eval(() => window.__fileReply().querySelector('.file-link[data-file="src/app.js"]').click());
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
      await page.eval(() => window.__fileReply().querySelector('.file-link[data-file="src/hilang.ts"]').click());
      await page.waitFor(() => /tidak ditemukan/.test(document.querySelector('#fv-body .state-error')?.textContent ?? ''), { timeoutMs: 4000, message: 'file hilang: pesan rapi' });
      await page.press('Escape');
      // The 404 itself is the expected answer (logged by the browser as a failed request), nothing else.
      assert.deepEqual(realProblems(page).filter((p) => !/\/file\b/.test(p.text)), []);
      page.clearProblems();

      // A link outside the project (e.g. a screenshot in temp): confirmed once, read-only, no VS Code.
      const outsideFile = path.join(TMP, 'screenshot-di-luar.txt');
      writeFileSync(outsideFile, 'isi di luar project\n');
      await page.eval(async (file) => {
        const prev = window.confirm;
        window.confirm = () => true;
        try {
          const { openFile } = await import('/js/features/file-viewer.js');
          await openFile(file);
        } finally {
          window.confirm = prev;
        }
      }, outsideFile);
      await page.waitFor(() => /screenshot-di-luar\.txt/.test(document.querySelector('#fv-title')?.textContent ?? '') && /isi di luar project/.test(document.querySelector('#file-modal')?.textContent ?? ''), { timeoutMs: 5000, message: 'file di luar project terbuka' });
      const outside = await page.eval(() => ({ open: document.querySelector('#fv-open').disabled, title: document.querySelector('#fv-open').title }));
      assert.equal(outside.open, true, 'VS Code hanya untuk file di dalam project');
      assert.match(outside.title, /di dalam project/);
      const linked = await page.eval(async (file) => {
        const { linkifyPaths } = await import('/js/features/file-viewer.js');
        const div = document.createElement('div');
        div.textContent = `Lihat ${file} untuk detail.`;
        linkifyPaths(div);
        return [...div.querySelectorAll('.file-link')].map((b) => b.dataset.file);
      }, outsideFile);
      assert.deepEqual(linked, [outsideFile], 'path absolut di chat juga menjadi link');
      await page.press('Escape');

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
      await tapChangesAction(page, '#ch-refresh', vp.mobile);
      await page.waitFor(() => [...document.querySelectorAll('#ch-files li[data-path]')].some((li) => li.dataset.path === 'src/checkout.ts'), { timeoutMs: 6000, message: 'file berubah di tab Perubahan' });
      await page.eval(() => [...document.querySelectorAll('#ch-files li[data-path]')].find((li) => li.dataset.path === 'src/checkout.ts').click());
      assert.equal(await page.eval(horizontalOverflow), null, 'tab Perubahan tanpa scroll horizontal');
      await tapChangesAction(page, '#ch-view', vp.mobile);
      await page.waitFor(() => /export const total/.test(document.querySelector('#fv-code')?.textContent ?? ''), { timeoutMs: 4000, message: 'penampil dari tab Perubahan' });
      assert.equal(await page.eval(horizontalOverflow), null);
      await page.press('Escape');
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      else await page.click('.tabs button[data-tab="chat"]');
      assert.deepEqual(realProblems(page), []);
    });

    test('📄 penampil file panjang: pratinjau & kode bisa di-scroll (wheel, PageDown), cari menggulir ke hasil, markdown rapi', async (t) => {
      await ensureApp(page, `#${projectId}`);
      page.clearProblems();
      const proj = path.join(TMP, 'projects', 'toko');
      mkdirSync(path.join(proj, 'docs'), { recursive: true });
      const md = path.join(proj, 'docs', 'panjang.md');
      const json = path.join(proj, 'docs', 'panjang.json');
      t.after(() => {
        rmSync(md, { force: true });
        rmSync(json, { force: true });
      });
      const body = Array.from({ length: 400 }, (_, i) => `Paragraf ${i + 1}${i === 40 || i === 360 ? ' TANDA' : ''} dengan teks yang cukup panjang untuk mengisi baris.\n`).join('\n');
      writeFileSync(
        md,
        '# Judul\n\n> **Catatan** (kutipan):\n> - **D3/D4:** satu\n> - **D7:** dua\n\n' +
          "| ID | Keputusan | Alasan |\n|---|---|---|\n| D1 | Setting **`engine: 'claude' \\| 'opencode'`**, default `'claude'` | Satu tempat \\| aman |\n\n" +
          body,
      );
      writeFileSync(json, JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: i, nama: `item ${i}` }))));
      const wheelAndPage = async (sel) => {
        const box = await page.eval((s) => {
          const el = document.querySelector(s);
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 200), sh: el.scrollHeight, ch: el.clientHeight, focused: document.activeElement === el };
        }, sel);
        assert.ok(box.sh > box.ch, `${sel}: isi lebih tinggi dari kotaknya (${box.sh} > ${box.ch})`);
        assert.equal(box.focused, true, `${sel}: kotak scroll difokus, keyboard langsung menggulir`);
        await page.eval((s) => (document.querySelector(s).scrollTop = 0), sel);
        await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 300 });
        const afterWheel = await page.waitFor((s) => document.querySelector(s).scrollTop > 0 && document.querySelector(s).scrollTop, { timeoutMs: 3000, message: `${sel}: wheel menggulir` }, sel);
        const key = { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 };
        await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
        await page.waitFor((s, from) => document.querySelector(s).scrollTop > from, { timeoutMs: 3000, message: `${sel}: PageDown menggulir` }, sel, afterWheel);
      };

      // 👁 Markdown preview
      await page.eval(() => import('/js/features/file-viewer.js').then((m) => m.openFile('docs/panjang.md')));
      await page.waitFor(() => document.querySelector('#fv-body .fv-preview.md'), { timeoutMs: 5000, message: 'pratinjau markdown' });
      const r = await page.eval(() => {
        const box = document.querySelector('#fv-body .fv-preview.md');
        const row = box.querySelector('tbody tr');
        return {
          quoteItems: [...box.querySelectorAll('blockquote ul li')].map((li) => li.textContent),
          literalQuote: /&gt;|^>/m.test(box.textContent) || box.textContent.includes('> -'),
          heads: box.querySelectorAll('thead th').length,
          cells: [...row.children].map((td) => td.textContent),
          code: row.querySelector('strong code')?.textContent,
          literalStars: box.querySelector('table').textContent.includes('**'),
          role: box.getAttribute('role'),
        };
      });
      assert.deepEqual(r.quoteItems, ['D3/D4: satu', 'D7: dua'], 'kutipan berisi list');
      assert.equal(r.literalQuote, false, 'tanda > tidak tampil literal');
      assert.equal(r.heads, 3);
      assert.deepEqual(r.cells, ['D1', "Setting engine: 'claude' | 'opencode', default 'claude'", 'Satu tempat | aman'], '\\| = pipe literal, tanpa kolom ekstra');
      assert.equal(r.code, "engine: 'claude' | 'opencode'");
      assert.equal(r.literalStars, false, '** tidak tampil literal');
      assert.equal(r.role, 'region');
      await wheelAndPage('#fv-body .fv-preview.md');
      assert.equal(await page.eval(horizontalOverflow), null);

      // ‹› Kode: the search steps scroll the hit into view
      await page.click('#fv-mode');
      await page.waitFor(() => document.querySelectorAll('#fv-code .fv-l').length > 400, { timeoutMs: 3000, message: 'mode kode' });
      await page.eval(() => document.querySelector('#fv-code').focus());
      await wheelAndPage('#fv-code');
      const visible = () => {
        const box = document.querySelector('#fv-code').getBoundingClientRect();
        const el = document.querySelector('#fv-code .fv-l.cur');
        if (!el) return null;
        const r2 = el.getBoundingClientRect();
        return { n: el.dataset.n, inView: r2.top >= box.top && r2.bottom <= box.bottom };
      };
      await page.eval(() => document.querySelector('#fv-q').focus());
      await page.send('Input.insertText', { text: 'TANDA' });
      await page.waitFor(() => document.querySelector('#fv-count').textContent === '1/2', { timeoutMs: 2000, message: 'hasil cari pertama' });
      const first = await page.eval(visible);
      assert.equal(first.inView, true, 'hasil pertama terlihat');
      await page.click('#fv-next');
      await page.waitFor(() => document.querySelector('#fv-count').textContent === '2/2', { timeoutMs: 2000, message: '↓ ke hasil kedua' });
      const second = await page.eval(visible);
      assert.notEqual(second.n, first.n);
      assert.equal(second.inView, true, '↓ menggulir ke hasil kedua (jauh di bawah)');
      await page.click('#fv-prev');
      await page.waitFor(() => document.querySelector('#fv-count').textContent === '1/2', { timeoutMs: 2000, message: '↑ kembali' });
      assert.deepEqual(await page.eval(visible), first, '↑ menggulir kembali ke hasil pertama');
      await page.press('Escape');

      // 👁 JSON preview (another preview kind) scrolls the same way
      await page.eval(() => import('/js/features/file-viewer.js').then((m) => m.openFile('docs/panjang.json')));
      await page.waitFor(() => document.querySelector('#fv-body .fv-preview .fv-pre'), { timeoutMs: 5000, message: 'pratinjau JSON' });
      await wheelAndPage('#fv-body .fv-preview');
      await page.press('Escape');
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
      await tapMore(page, 'permissions');
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
      await tapChangesAction(page, '#ch-refresh', vp.mobile);
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
      await tapChangesAction(page, '#ch-git-new', vp.mobile);
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
      // ⇡ PR: a dialog (gh status + form). gh not logged in here: the form stays hidden, the login and
      // "✳ Biar Claude yang buat" are offered; Claude's route puts the prompt in the composer, not sent
      const users = await page.eval(() => document.querySelectorAll('#chat .msg.user, #chat [data-kind="user"]').length);
      await tapChangesAction(page, '#ch-git-pr', vp.mobile);
      await page.waitFor(() => !document.querySelector('#pr-modal').hidden && document.querySelector('#pr-gh [data-pr="claude"]'), { timeoutMs: 6000, message: 'dialog PR: status gh + rute Claude' });
      const prDialog = await page.eval(() => ({
        branch: document.querySelector('#pr-branch').textContent,
        formHidden: document.querySelector('#pr-form').hidden,
        login: Boolean(document.querySelector('#pr-gh [data-pr="login"]')),
        prompt: document.querySelector('#prompt').value,
      }));
      assert.deepEqual(prDialog, { branch: `· ${bar.branch}`, formHidden: true, login: true, prompt: '' });
      assert.equal(await page.eval(horizontalOverflow), null, 'dialog PR tanpa scroll horizontal');
      assert.deepEqual(await page.eval(unnamedButtons, '#pr-modal'), []);
      await shot('pr');
      await page.click('#pr-gh [data-pr="claude"]');
      await page.waitFor(() => /pull request/.test(document.querySelector('#prompt').value) && document.querySelector('#pr-modal').hidden, { timeoutMs: 2000, message: 'prompt PR di kotak pesan, dialog tertutup' });
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

// ---------- 🧹 Ringkas konteks (features/compact.js) ----------

/** Stubs POST …/compact on the page (its backend lands separately) and records every request body. */
async function stubCompact(page, status, body) {
  await page.eval((st, b) => {
    window.__officeFetch ??= window.fetch;
    window.__compactReply = { status: st, body: b };
    window.__compactCalls = [];
    window.fetch = (url, opts) => {
      if (!/\/compact(\?|$)/.test(String(url))) return window.__officeFetch(url, opts);
      try {
        window.__compactCalls.push(JSON.parse(opts?.body ?? '{}'));
      } catch {
        window.__compactCalls.push(null);
      }
      return Promise.resolve(new Response(JSON.stringify(window.__compactReply.body), { status: window.__compactReply.status, headers: { 'Content-Type': 'application/json' } }));
    };
  }, status, body);
}

async function restoreCompact(page) {
  await page
    .eval(() => {
      if (window.__officeFetch) window.fetch = window.__officeFetch;
      delete window.__officeFetch;
      delete window.__compactReply;
      delete window.__compactCalls;
      document.querySelector('#compact-modal').hidden = true;
    })
    .catch(() => {});
}

/** Gives the active project a session and a context reading: the status-line action only shows with a session. */
async function seedSessionContext(page) {
  await page.eval(async () => {
    const { state } = await import('/js/core/state.js');
    const { renderComposer } = await import('/js/features/composer.js');
    state.readOnly = false;
    state.statuses[state.active] = {
      ...(state.statuses[state.active] ?? {}),
      sessionId: '11111111-1111-4111-8111-111111111111',
      context: { used: 80000, window: 200000 },
    };
    renderComposer();
  });
}

const compactOpen = (page) => page.waitFor(() => !document.querySelector('#compact-modal').hidden, { timeoutMs: 2000, message: 'dialog Ringkas terbuka' });

for (const vp of VIEWPORTS) {
  describe(`UI Ringkas konteks — ${vp.name}`, { skip: SKIP ?? false }, () => {
    let page;
    let pid;
    before(async () => {
      if (SKIP) return;
      page = await browser.newPage();
      await page.setViewport(vp);
      pid = await addTempProject(`ringkas-${vp.mobile ? 'hp' : 'laptop'}`);
    });
    after(async () => {
      if (!SKIP) await forgetTempProject(pid);
      await page?.close();
    });

    /** Fresh page on the throwaway project, with a session + context so the chip exists. */
    async function ready() {
      await openApp(page, `#${pid}`);
      await seedSessionContext(page);
    }

    test('Ringkas: chip status membuka dialog (konteks + mesin), Enter mengirim fokus, kotak pesan tetap', async () => {
      await ready();
      await stubCompact(page, 200, { ok: true, engine: 'claude', command: '/compact' });
      try {
        const chip = await page.eval(() => {
          const b = document.querySelector('#statusline [data-compact]');
          return b ? { visible: b.getClientRects().length > 0, label: b.textContent.trim() } : null;
        });
        assert.ok(chip?.visible, 'tombol 🧹 terlihat di status line');
        assert.match(chip.label, /Ringkas/);

        await page.eval(() => {
          const p = document.querySelector('#prompt');
          p.value = 'draf pesan';
        });
        await page.click('#statusline [data-compact]');
        await compactOpen(page);

        const view = await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          const { engineLabel, engineOf } = await import('/js/core/engine-caps.js');
          const st = state.statuses[state.active] ?? {};
          const input = document.querySelector('#compact-focus');
          const doc = document.documentElement;
          return {
            summary: document.querySelector('#compact-summary').textContent,
            engine: engineLabel(engineOf(st, state.config)),
            label: (input.labels?.[0]?.textContent ?? '').trim(),
            maxlength: input.getAttribute('maxlength'),
            opencodeNoteHidden: document.querySelector('#compact-opencode-note').hidden,
            focusInside: document.querySelector('#compact-modal').contains(document.activeElement),
            overflow: doc.scrollWidth - doc.clientWidth,
            cardRight: document.querySelector('.compact-card').getBoundingClientRect().right,
            clientWidth: doc.clientWidth,
          };
        });
        assert.match(view.summary, /80k/);
        assert.match(view.summary, /200k/);
        assert.match(view.summary, /40%/);
        assert.match(view.summary, new RegExp(view.engine), 'nama mesin tampil');
        assert.match(view.label, /Fokus/);
        assert.equal(view.maxlength, '300');
        assert.equal(view.opencodeNoteHidden, true, 'catatan OpenCode hanya untuk OpenCode');
        assert.equal(view.focusInside, true, 'fokus masuk dialog');
        assert.equal(view.overflow, 0, 'tanpa scroll horizontal');
        assert.ok(view.cardRight <= view.clientWidth + 0.5, 'kartu muat di lebar layar');

        await page.eval(() => document.querySelector('#compact-focus').focus());
        await page.send('Input.insertText', { text: 'pertahankan keputusan API' });
        await page.press('Enter');
        await page.waitFor(() => document.querySelector('#compact-modal').hidden, { timeoutMs: 4000, message: 'dialog tertutup setelah sukses' });
        assert.deepEqual(await page.eval(() => window.__compactCalls), [{ focus: 'pertahankan keputusan API' }]);
        assert.equal(await page.eval(() => document.querySelector('#prompt').value), 'draf pesan', 'kotak pesan tidak dikosongkan');
        const toasts = await page.eval(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
        assert.ok(toasts.some((t) => /Konteks sedang diringkas/.test(t)), toasts.join(' | '));
        assert.deepEqual(realProblems(page), []);
      } finally {
        await restoreCompact(page);
      }
    });

    test('🔎 Ctrl+P mencari isi percakapan dan membuka sesinya', async () => {
      await ready();
      await page.eval((pid) => {
        window.__transcriptBodies = [];
        window.__resumeCalls = [];
        window.__palFetch2 = window.fetch;
        window.__palConfirm = window.confirm;
        window.confirm = () => true; // a busy project would ask first; the test only checks the call
        window.fetch = async (url, opts) => {
          const u = String(url);
          const search = u.match(/\/api\/projects\/([^/?]+)\/search(?:\?|$)/);
          if (search) {
            const body = JSON.parse(opts?.body ?? '{}');
            window.__transcriptBodies.push(body);
            const project = decodeURIComponent(search[1]);
            return new Response(
              JSON.stringify({
                query: body.q,
                truncated: false,
                results: [
                  {
                    projectId: project,
                    sessionId: 'sess-checkout-001',
                    title: 'Perbaikan checkout',
                    engine: 'claude',
                    source: 'web',
                    role: 'assistant',
                    ts: Date.now(),
                    snippet: { before: 'sudah selesai di ', match: body.q, after: ' baris 42' },
                  },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (/\/api\/projects\/[^/?]+\/resume(?:\?|$)/.test(u)) {
            window.__resumeCalls.push(JSON.parse(opts?.body ?? '{}'));
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return window.__palFetch2(url, opts);
        };
      }, projectId);
      const transcriptOption = () =>
        page.eval(() => {
          const hit = [...document.querySelectorAll('#palette-list .pal-opt')].find((o) => o.textContent.includes('Perbaikan checkout'));
          return hit ? { label: hit.querySelector('.pal-label').textContent, hint: hit.querySelector('.pal-text small')?.textContent ?? '' } : null;
        });
      try {
        await paletteType(page, 'checkout');
        await page.waitFor(() => [...document.querySelectorAll('#palette-list .pal-group-head')].some((g) => g.textContent === 'Percakapan'), { timeoutMs: 4000, message: 'grup Percakapan' });
        const hit = await transcriptOption();
        assert.ok(hit, 'hasil transkrip tampil di palet');
        assert.equal(hit.label, 'Perbaikan checkout');
        assert.match(hit.hint, /sudah selesai di checkout baris 42/);
        assert.deepEqual(await page.eval(() => {
          const b = window.__transcriptBodies.at(-1);
          return { q: b.q, all: b.all };
        }), { q: 'checkout', all: true }, 'kueri dikirim ke semua project');

        // A prefix means another search: `>` is commands, so no transcript request.
        const before = await page.eval(() => window.__transcriptBodies.length);
        await paletteType(page, '>checkout');
        await sleep(450);
        assert.equal(await page.eval(() => window.__transcriptBodies.length), before, 'prefix > tidak mencari transkrip');

        // Picking the hit opens that session.
        await paletteType(page, 'checkout');
        await page.waitFor(() => [...document.querySelectorAll('#palette-list .pal-opt')].some((o) => o.textContent.includes('Perbaikan checkout')), { timeoutMs: 4000, message: 'hasil transkrip kembali' });
        await page.eval(() => [...document.querySelectorAll('#palette-list .pal-opt')].find((o) => o.textContent.includes('Perbaikan checkout')).click());
        await page.waitFor(() => window.__resumeCalls.length === 1, { timeoutMs: 4000, message: 'sesi dilanjutkan' });
        assert.deepEqual(await page.eval(() => window.__resumeCalls[0]), { sessionId: 'sess-checkout-001' });
        assert.equal(await page.eval(() => document.querySelector('#palette-modal').hidden), true, 'palet menutup');
      } finally {
        await page.eval(() => {
          window.fetch = window.__palFetch2;
          window.confirm = window.__palConfirm;
        });
      }
    });

    test('🔎 ?opencode 7d memfilter hasil transkrip di palet', async () => {
      await ready();
      await page.eval(() => {
        window.__qBodies = [];
        window.__qFetch = window.fetch;
        const now = Date.now();
        const day = 86_400_000;
        const result = (sessionId, title, engine, ts) => ({
          projectId: 'p1',
          sessionId,
          title,
          engine,
          source: 'web',
          role: 'assistant',
          ts,
          snippet: { before: 'selesai ', match: 'checkout', after: ' baris 42' },
        });
        window.fetch = async (url, opts) => {
          if (/\/api\/projects\/[^/?]+\/search(?:\?|$)/.test(String(url))) {
            const body = JSON.parse(opts?.body ?? '{}');
            window.__qBodies.push(body);
            return new Response(
              JSON.stringify({
                query: body.q,
                truncated: false,
                results: [result('s-claude-new', 'Claude baru', 'claude', now - day), result('s-oc-new', 'OpenCode baru', 'opencode', now - day), result('s-oc-old', 'OpenCode lama', 'opencode', now - 40 * day)],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return window.__qFetch(url, opts);
        };
      });
      const labels = () => page.eval(() => [...document.querySelectorAll('#palette-list .pal-group')].flatMap((g) => (g.querySelector('.pal-group-head')?.textContent === 'Percakapan' ? [...g.querySelectorAll('.pal-label')].map((n) => n.textContent) : [])));
      try {
        await paletteType(page, '?opencode 7d checkout');
        await page.waitFor(() => [...document.querySelectorAll('#palette-list .pal-label')].some((n) => n.textContent === 'OpenCode baru'), { timeoutMs: 4000, message: 'hasil transkrip terfilter' });
        assert.deepEqual(await labels(), ['OpenCode baru'], 'hanya OpenCode dalam 7 hari');
        assert.deepEqual(await page.eval(() => {
          const b = window.__qBodies.at(-1);
          return { q: b.q, all: b.all };
        }), { q: 'checkout', all: true }, 'filter tidak ikut terkirim sebagai kata kunci');
        assert.equal(await page.eval(() => document.querySelector('#palette-scope').textContent), 'Isi percakapan · OpenCode · 7 hari');

        await paletteType(page, '?claude checkout');
        await page.waitFor(() => [...document.querySelectorAll('#palette-list .pal-label')].some((n) => n.textContent === 'Claude baru'), { timeoutMs: 4000, message: 'hasil Claude' });
        assert.deepEqual(await labels(), ['Claude baru'], 'hanya Claude');

        // Filters alone are not a query: no request, with a hint about what to type.
        const before = await page.eval(() => window.__qBodies.length);
        await paletteType(page, '?opencode 7d');
        await sleep(450);
        assert.equal(await page.eval(() => window.__qBodies.length), before, 'tanpa kata kunci tidak mencari');
        assert.match(await page.eval(() => document.querySelector('#palette-list').textContent), /Ketik kata kunci/);
        await page.press('Escape');
      } finally {
        await page.eval(() => {
          window.fetch = window.__qFetch;
        });
      }
    });

    test('Ringkas: /ringkas dari palet perintah, fokus kosong mengirim {}', async () => {
      await ready();
      await stubCompact(page, 200, { ok: true, engine: 'claude', command: '/compact' });
      try {
        await paletteType(page, '>ringkas');
        await page.waitFor(() => (document.querySelector('#palette-list .pal-opt.active .pal-label')?.textContent ?? '') === '/ringkas', { timeoutMs: 2000, message: '/ringkas terpilih di palet' });
        await page.press('Enter');
        await page.waitFor(() => !document.querySelector('#compact-modal').hidden && document.querySelector('#palette-modal').hidden, { timeoutMs: 2000, message: 'dialog Ringkas dari palet' });
        assert.equal(await page.eval(() => document.querySelector('#compact-focus').value), '');
        await page.eval(() => document.querySelector('#compact-focus').focus());
        await page.press('Enter');
        await page.waitFor(() => document.querySelector('#compact-modal').hidden, { timeoutMs: 4000, message: 'dialog tertutup' });
        assert.deepEqual(await page.eval(() => window.__compactCalls), [{}], 'fokus kosong: tanpa key focus');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await restoreCompact(page);
      }
    });

    test('Ringkas: 409 tetap di dialog, pesan server inline (role=alert), tanpa kirim ulang', async () => {
      await ready();
      await stubCompact(page, 409, { error: 'Masih ada giliran yang berjalan. Tunggu sampai selesai, lalu coba lagi.' });
      try {
        await page.click('#statusline [data-compact]');
        await compactOpen(page);
        await page.eval(() => document.querySelector('#compact-focus').focus());
        await page.send('Input.insertText', { text: 'fokus' });
        await page.press('Enter');
        await page.waitFor(() => document.querySelector('#compact-error').textContent.length > 0, { timeoutMs: 4000, message: 'pesan 409 tampil' });
        await sleep(300); // a retry would show up by now
        const view = await page.eval(() => ({
          open: !document.querySelector('#compact-modal').hidden,
          error: document.querySelector('#compact-error').textContent,
          role: document.querySelector('#compact-error').getAttribute('role'),
          calls: window.__compactCalls.length,
          sendDisabled: document.querySelector('#compact-send').disabled,
          focusInside: document.querySelector('#compact-modal').contains(document.activeElement),
        }));
        assert.equal(view.open, true, 'dialog tetap terbuka');
        assert.match(view.error, /giliran/i);
        assert.equal(view.role, 'alert');
        assert.equal(view.calls, 1, 'tidak dicoba ulang');
        assert.equal(view.sendDisabled, false, 'tombol bisa dipakai lagi');
        assert.equal(view.focusInside, true);
        assert.deepEqual(realProblems(page).filter((p) => !/409/.test(p.text)), [], '409 wajar, bukan error console lain');
      } finally {
        await restoreCompact(page);
      }
    });

    test('Ringkas: hanya-lihat menyembunyikan chip & menonaktifkan perintah; catatan fokus khusus OpenCode', async () => {
      await ready();
      try {
        // OpenCode: the focus text is ignored, and the dialog says so (no re-render: only the dialog reads the engine).
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.config.engine = 'opencode';
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), engine: 'opencode' };
        });
        await page.click('#statusline [data-compact]');
        await compactOpen(page);
        const oc = await page.eval(() => ({ noteHidden: document.querySelector('#compact-opencode-note').hidden, summary: document.querySelector('#compact-summary').textContent }));
        assert.equal(oc.noteHidden, false, 'catatan OpenCode tampil');
        assert.match(oc.summary, /OpenCode/);
        await page.press('Escape');

        // Read-only: no chip, and the slash command explains why and stays closed.
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          const { renderComposer } = await import('/js/features/composer.js');
          state.config.engine = 'claude';
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), engine: 'claude' };
          state.readOnly = true;
          renderComposer();
        });
        assert.equal(await page.eval(() => Boolean(document.querySelector('#statusline [data-compact]'))), false, 'chip disembunyikan saat hanya-lihat');
        await paletteType(page, '>ringkas');
        await page.waitFor(() => Boolean(document.querySelector('#palette-list .pal-opt.active[aria-disabled="true"]')), { timeoutMs: 2000, message: '/ringkas nonaktif saat hanya-lihat' });
        assert.match(await page.eval(() => document.querySelector('#palette-list .pal-opt.active')?.textContent ?? ''), /Hanya lihat/);
        await page.press('Enter');
        assert.equal(await page.eval(() => document.querySelector('#compact-modal').hidden), true, 'dialog tidak dibuka');
        await page.press('Escape');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await page
          .eval(async () => {
            const { state } = await import('/js/core/state.js');
            const { renderComposer } = await import('/js/features/composer.js');
            state.readOnly = false;
            renderComposer();
          })
          .catch(() => {});
      }
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

  /** The LAN page on toko, connected (reused when already there: the first test loads it with a check of its own). */
  async function ensureLanApp() {
    const href = await page.eval('location.href').catch(() => '');
    if (href === `${LAN}/#${projectId}` && (await page.eval(appReady).catch(() => false))) return;
    await page.goto(`${LAN}/#${projectId}`);
    await page.waitFor(appReady, { timeoutMs: 10000, message: 'app terhubung lewat LAN' });
  }

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

  test('⚠ chip macet terlihat di HP, tombol aksi nonaktif dengan petunjuk hanya-lihat', async (t) => {
    if (!LAN) return t.skip('laptop ini tidak punya alamat LAN');
    await ensureLanApp();
    page.clearProblems();
    const r = await page.eval(async () => {
      const { state } = await import('/js/core/state.js');
      const { appendChat } = await import('/js/features/chat.js');
      const { checkStuck, stuck, stuckClock } = await import('/js/features/stuck.js');
      // A stream resync in flight (stray events of another test's project) pauses the detector: wait for its snapshot.
      for (let i = 0; i < 100 && !stuck.online; i++) await new Promise((res) => setTimeout(res, 50));
      const pid = state.active;
      const saved = state.statuses[pid];
      state.statuses[pid] = { ...saved, busy: true, pending: 0 };
      // This suite keeps a permission card pending, and a project waiting for the user is never "stuck":
      // park its approvals for the check (restored below).
      const parked = [...(state.approvals?.entries?.() ?? [])].filter(([, a]) => a.project === pid && a.status === 'pending');
      for (const [k] of parked) state.approvals.delete(k);
      const msg = { id: 'stuck-ro', project: pid, ts: Date.now(), kind: 'tool', role: 'devops', tool: 'Bash', text: 'sleep', status: 'running', input: { command: 'sleep' } };
      (state.chats[pid] ??= []).push(msg);
      appendChat(msg);
      stuckClock.now = () => Date.now() + 10 * 60_000 + 5000;
      stuck.lastTick = stuckClock.now() - 15_000; // a normal tick, not a wake-up
      checkStuck();
      const chip = document.querySelector('#chat > [data-id="stuck-ro"] > .stuck-chip');
      const out = { text: chip?.querySelector('.stuck-text').textContent ?? null, buttons: [...(chip?.querySelectorAll('button') ?? [])].map((b) => [b.dataset.stuckAct, b.disabled, b.title]) };
      msg.status = 'cancel';
      stuck.lastTick = null;
      checkStuck();
      state.chats[pid].splice(state.chats[pid].indexOf(msg), 1);
      document.querySelector('#chat > [data-id="stuck-ro"]')?.remove();
      stuckClock.now = () => Date.now();
      state.statuses[pid] = saved;
      for (const [k, a] of parked) state.approvals.set(k, a);
      return out;
    });
    assert.equal(r.text, '⚠ Berjalan 10 mnt — mungkin macet');
    assert.deepEqual(r.buttons.map(([a, d]) => [a, d]), [['stop', true], ['background', true]]);
    for (const [, , title] of r.buttons) assert.equal(title, 'Hanya lihat lewat WiFi — pakai Tailscale untuk mengirim perintah');
    assert.deepEqual(realProblems(page), []);
  });

  // The stream really stays up here; the handlers are driven directly (same module instance as the app's).
  test('putus lama di HP: petunjuk laptop/Tailscale (bukan start-office), Kirim tetap hanya-lihat', async (t) => {
    if (!LAN) return t.skip('laptop ini tidak punya alamat LAN');
    await ensureLanApp();
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
  const OLD = 120; // within the 150 messages a snapshot carries, so one "Muat pesan lama" brings all of them back
  const api = async (p, body = {}) => {
    const token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
    return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then((r) => r.json());
  };
  const bubbles = () => page.eval(() => [...document.querySelectorAll('#chat .msg.assistant')].map((n) => n.querySelector('.body').textContent));
  /** 📜 Chat lazy-load: expand "Muat pesan lama" until the whole stored history is in the DOM. */
  const loadAllOlder = async () => {
    for (let i = 0; i < 20 && (await page.eval(() => document.querySelectorAll('#chat-load-older').length)); i += 1) {
      await page.eval(() => document.querySelector('#chat-load-older').click());
      await sleep(20);
    }
  };

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
    // Left in the format of app versions before data/chats (chats inside state.json), as an upgrade finds it;
    // this project's chat file from the tests above goes, so the seeded chat is its whole history.
    rmSync(path.join(TMP, 'data', 'chats', `${projectId}.jsonl`), { force: true });
    writeFileSync(file, JSON.stringify({ ...saved, chats: { ...saved.chats, [projectId]: old } }));
    await startServer();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).chats, undefined, 'chats moved out of state.json at start');
    assert.ok(existsSync(path.join(TMP, 'data', 'chats', `${projectId}.jsonl`)), 'into data/chats');
    page = await browser.newPage();
    await page.setViewport(VIEWPORTS[1]);
    await openApp(page, `#${projectId}`);
  });
  after(async () => page?.close());

  test('setelah server restart: balasan baru tampil berisi di bubble baru, bubble lama tidak tertimpa', async () => {
    await ensureApp(page, `#${projectId}`);
    // Counted first: in another order an earlier turn of this describe already left a result row.
    const results = await page.eval(() => document.querySelectorAll('#chat .result.ok').length);
    await api(`/api/projects/${projectId}/prompt`, { text: 'halo setelah restart' });
    await page.waitFor((n) => document.querySelectorAll('#chat .result.ok').length > n, { timeoutMs: 10000, message: 'giliran selesai (baris hasil)' }, results);
    await sleep(300);
    await loadAllOlder(); // the page draws the newest page first (📜 chat lazy-load)
    const all = await bubbles();
    assert.deepEqual(await page.eval(() => document.querySelectorAll('#chat .msg.assistant.streaming').length), 0, `masih "mengetik" setelah selesai; 3 bubble terakhir: ${JSON.stringify(all.slice(-3))}`);
    assert.match(all.at(-1), /Halo dari Claude palsu yang sedang mengetik\./, 'bubble terakhir berisi balasan');
    assert.equal(all.filter((t) => !t.trim()).length, 0, 'tidak ada bubble kosong');
    const oldShown = all.filter((t) => /^jawaban lama \d+$/.test(t));
    assert.deepEqual(oldShown, Array.from({ length: OLD }, (_, i) => `jawaban lama ${i + 1}`), 'bubble lama tetap utuh');
    // What the page shows equals what a fresh load shows.
    await openApp(page, `#${projectId}`);
    await loadAllOlder();
    assert.deepEqual(await bubbles(), all);
  });

  test('restart lagi (riwayat dari data/chats): riwayat utuh, balasan baru di bubble baru', async () => {
    // The history as the page shows it now (self-contained: whatever ran before in this describe).
    await ensureApp(page, `#${projectId}`);
    await loadAllOlder();
    const history = await bubbles();
    assert.ok(history.length >= OLD, `riwayat termuat (${history.length} bubble)`);
    // Clean stop (⚙ → Matikan server): the chat is in data/chats/<id>.jsonl now, not in state.json.
    const exited = new Promise((r) => server.once('exit', r));
    await api('/api/shutdown');
    await Promise.race([exited, sleep(5000)]);
    assert.equal(JSON.parse(readFileSync(path.join(TMP, 'data', 'state.json'), 'utf8')).chats, undefined);
    await startServer();
    await openApp(page, `#${projectId}`);
    await loadAllOlder();
    assert.deepEqual(await bubbles(), history, 'the same history after a restart from data/chats');
    const results = await page.eval(() => document.querySelectorAll('#chat .result.ok').length);
    await api(`/api/projects/${projectId}/prompt`, { text: 'halo setelah restart kedua' });
    await page.waitFor((n) => document.querySelectorAll('#chat .result.ok').length > n, { timeoutMs: 10000, message: 'giliran kedua selesai' }, results);
    await sleep(300);
    const all = await bubbles();
    assert.equal(await page.eval(() => document.querySelectorAll('#chat .msg.assistant.streaming').length), 0, `masih "mengetik": ${JSON.stringify(all.slice(-3))}`);
    assert.deepEqual(all.slice(0, -1), history, 'old bubbles untouched');
    assert.match(all.at(-1), /Halo dari Claude palsu yang sedang mengetik\./);
    const ids = await page.eval(() => [...document.querySelectorAll('#chat [data-id]')].map((n) => n.dataset.id));
    assert.equal(new Set(ids).size, ids.length, 'every message id on the page is unique');
  });

  test('bubble assistant selesai tapi kosong (atau hanya spasi) tidak ditampilkan', async () => {
    await ensureApp(page, `#${projectId}`);
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
    await ensureApp(page, `#${projectId}`);
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
      return { back: Boolean(node), text: node?.textContent ?? '', lost: lost.text, inState: state.chats[state.active].some((m) => m.id === lost.id) };
    });
    assert.equal(r.back, true, 'pesan muncul lagi');
    assert.ok(r.lost && r.text.includes(r.lost), `isi pesan kembali (${JSON.stringify(r.text.slice(0, 80))})`);
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
    // A fresh document: no "Tersambung lagi." toast or shortened CONN_TIMING left by the restart test.
    await openApp(page, `#${projectId}`);
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
    await ensureApp(page, `#${projectId}`);
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

    /** Per-test setup: the app on toko, connected, with saveBlob downloads captured in this document. */
    async function ready() {
      await ensureApp(page, `#${projectId}`);
      if (!(await page.eval(() => Array.isArray(window.__downloads)))) await page.eval(captureDownloads);
    }

    test('Ctrl+P membuka palet (combobox/listbox), ↓ dan Esc; Ctrl+K tetap pemilih project', async () => {
      await ready();
      // No "Terakhir dipakai" group (the fuzzy test's actions, in another order): the plain groups are checked.
      await page.eval(() => localStorage.removeItem('office.palette.recent'));
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
      for (const g of ['Project', 'Chat', 'Buka', 'Pengaturan', 'Tema', 'Perintah']) assert.ok(groups.includes(g), `grup ${g}: ${groups.join(', ')}`);
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
      await ready();
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
      await ready();
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
      await ready();
      await page.eval(() => (window.__downloads = []));
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      await tap(page, '#btn-sessions');
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

    test('🗑 Hapus beberapa sesi sekaligus dari Riwayat sesi', async () => {
      await ready();
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      await page.eval(() => {
        window.__delCalls = [];
        window.__exportCalls = [];
        window.__sessionsFetch = window.fetch;
        window.__sessionsConfirm = window.confirm;
        window.confirm = () => true;
        const now = Date.now();
        window.fetch = async (url, opts) => {
          const u = String(url);
          if (/\/api\/projects\/[^/?]+\/sessions(?:\?|$)/.test(u)) {
            return new Response(
              JSON.stringify({
                current: 'sess-current',
                sessions: [
                  { id: 'sess-current', title: 'Sedang dibuka', source: 'web', updated: now },
                  { id: 'sess-bulk-1', title: 'Sesi satu', source: 'web', updated: now - 86_400_000 },
                  { id: 'sess-bulk-2', title: 'Sesi dua', source: 'cli', updated: now - 172_800_000 },
                  { id: 'sess-bulk-3', title: 'Sesi tiga', source: 'web', updated: now - 259_200_000 },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (/\/api\/projects\/[^/?]+\/session-delete(?:\?|$)/.test(u)) {
            window.__delCalls.push(JSON.parse(opts?.body ?? '{}'));
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          if (/\/api\/projects\/[^/?]+\/sessions-export(?:\?|$)/.test(u)) {
            window.__exportCalls.push(JSON.parse(opts?.body ?? '{}'));
            return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
              status: 200,
              headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="sesi-toko-2026-11-07.zip"' },
            });
          }
          return window.__sessionsFetch(url, opts);
        };
      });
      try {
        await page.eval(async () => (await import('/js/features/sessions.js')).openSessions());
        await page.waitFor(() => document.querySelectorAll('#sessions-list [data-pick]').length === 3, { timeoutMs: 4000, message: 'tiga sesi bisa dipilih' });
        assert.equal(await page.eval(() => document.querySelector('#sessions-bulk').hidden), false, 'bar pilih tampil');
        assert.equal(await page.eval(() => document.querySelectorAll('#sessions-list .s-item').length), 4, 'sesi yang sedang dibuka tetap tampil');

        await page.eval(() => {
          for (const id of ['sess-bulk-1', 'sess-bulk-2']) document.querySelector(`#sessions-list [data-pick="${id}"]`).click();
        });
        assert.equal(await page.eval(() => document.querySelector('#sessions-delete-selected').textContent), 'Hapus 2 sesi', 'hitungan pilihan');
        assert.equal(await page.eval(() => document.querySelector('#sessions-export-selected').textContent), '⬇ Export 2', 'tombol export ikut hitungan');

        // ⬇ Export the two selected sessions: one .zip download.
        await page.eval(() => {
          window.__downloads = [];
          document.querySelector('#sessions-export-selected').click();
        });
        await page.waitFor(() => window.__downloads.length === 1, { timeoutMs: 4000, message: 'unduhan export' });
        assert.equal(await page.eval(() => window.__downloads[0].name), 'sesi-toko-2026-11-07.zip');
        assert.deepEqual(await page.eval(() => window.__exportCalls[0].sessionIds.slice().sort()), ['sess-bulk-1', 'sess-bulk-2']);

        await page.eval(() => document.querySelector('#sessions-select-all').click());
        assert.equal(await page.eval(() => document.querySelector('#sessions-delete-selected').textContent), 'Hapus 3 sesi', 'pilih semua');

        await page.eval(() => document.querySelector('#sessions-delete-selected').click());
        await page.waitFor(() => window.__delCalls.length === 3, { timeoutMs: 4000, message: 'tiga sesi dihapus' });
        assert.deepEqual(await page.eval(() => window.__delCalls.map((c) => c.sessionId).sort()), ['sess-bulk-1', 'sess-bulk-2', 'sess-bulk-3']);
        await page.press('Escape');
      } finally {
        await page.eval(() => {
          window.fetch = window.__sessionsFetch;
          window.confirm = window.__sessionsConfirm;
        });
      }
    });

    test('↩ Sesi terhapus tampil di Riwayat sesi dan bisa dipulihkan', async () => {
      await ready();
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      await page.eval(() => {
        window.__restoreCalls = [];
        window.__trashFetch = window.fetch;
        const now = Date.now();
        window.fetch = async (url, opts) => {
          const u = String(url);
          if (/\/api\/projects\/[^/?]+\/sessions(?:\?|$)/.test(u)) {
            return new Response(
              JSON.stringify({ current: 'sess-current', sessions: [{ id: 'sess-current', title: 'Sedang dibuka', source: 'web', updated: now }] }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (/\/api\/projects\/[^/?]+\/session-trash(?:\?|$)/.test(u)) {
            return new Response(
              JSON.stringify({ retentionDays: 30, sessions: [{ sessionId: 'sess-trashed-1', title: 'Sesi yang salah terhapus', source: 'web', trashedAt: now - 3_600_000, size: 4096 }] }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (/\/api\/projects\/[^/?]+\/session-restore(?:\?|$)/.test(u)) {
            window.__restoreCalls.push(JSON.parse(opts?.body ?? '{}'));
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return window.__trashFetch(url, opts);
        };
      });
      try {
        await page.eval(async () => (await import('/js/features/sessions.js')).openSessions());
        await page.waitFor(
          () => !document.querySelector('#sessions-trash').hidden && document.querySelectorAll('#sessions-trash-list [data-restore]').length === 1,
          { timeoutMs: 4000, message: 'bagian sesi terhapus' },
        );
        const box = await page.eval(() => document.querySelector('#sessions-trash').textContent.replace(/\s+/g, ' ').trim());
        assert.match(box, /Sesi yang salah terhapus/);
        assert.match(box, /Dihapus/);
        assert.match(box, /otomatis dibersihkan setelah 30 hari/);
        await page.eval(() => document.querySelector('#sessions-trash [data-restore]').click());
        await page.waitFor(() => window.__restoreCalls.length === 1, { timeoutMs: 4000, message: 'panggilan pulihkan' });
        assert.deepEqual(await page.eval(() => window.__restoreCalls[0]), { sessionId: 'sess-trashed-1' });
        await page.press('Escape');
      } finally {
        await page.eval(() => {
          window.fetch = window.__trashFetch;
        });
      }
    });

    test('📅 Riwayat sesi: saring 7/30/90 hari dan gabung dengan pencarian', async () => {
      await ready();
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      await page.eval(() => {
        window.__rangeFetch = window.fetch;
        const now = Date.now();
        const day = 86_400_000;
        window.fetch = async (url, opts) => {
          const u = String(url);
          if (/\/api\/projects\/[^/?]+\/sessions(?:\?|$)/.test(u)) {
            return new Response(
              JSON.stringify({
                current: null,
                sessions: [
                  { id: 'sess-a', title: 'Alpha baru', source: 'web', updated: now - 2 * day },
                  { id: 'sess-b', title: 'Beta sepuluh', source: 'cli', updated: now - 10 * day },
                  { id: 'sess-c', title: 'Gamma enam puluh', source: 'web', updated: now - 60 * day },
                  { id: 'sess-d', title: 'Delta lama', source: 'cli', updated: now - 200 * day },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (/\/api\/projects\/[^/?]+\/session-trash(?:\?|$)/.test(u)) {
            return new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return window.__rangeFetch(url, opts);
        };
      });
      const titles = () => page.eval(() => [...document.querySelectorAll('#sessions-list .s-title')].map((n) => n.textContent));
      const pick = (value) =>
        page.eval((v) => {
          const box = document.querySelector('#sessions-range');
          box.value = v;
          box.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
      try {
        await page.eval(async () => (await import('/js/features/sessions.js')).openSessions());
        await page.waitFor(() => document.querySelectorAll('#sessions-list .s-item').length === 4, { timeoutMs: 4000, message: 'empat sesi' });
        await pick('7');
        assert.deepEqual(await titles(), ['Alpha baru'], '7 hari');
        await pick('30');
        assert.deepEqual(await titles(), ['Alpha baru', 'Beta sepuluh'], '30 hari');
        await pick('90');
        assert.equal((await titles()).length, 3, '90 hari');
        // Search and range combine.
        await pick('30');
        await page.eval(() => {
          const q = document.querySelector('#sessions-search');
          q.value = 'beta';
          q.dispatchEvent(new Event('input', { bubbles: true }));
        });
        assert.deepEqual(await titles(), ['Beta sepuluh'], 'cari di dalam rentang');
        await page.press('Escape');
      } finally {
        await page.eval(() => {
          window.fetch = window.__rangeFetch;
        });
      }
    });

    test('✎ Riwayat sesi: ganti nama sesi Claude dari daftar', async () => {
      await ready();
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');
      await page.eval(() => {
        window.__renameCalls = [];
        window.__renameFetch = window.fetch;
        window.__renamePrompt = window.prompt;
        window.prompt = () => 'Judul dari daftar';
        window.fetch = async (url, opts) => {
          const u = String(url);
          if (/\/api\/projects\/[^/?]+\/sessions(?:\?|$)/.test(u)) {
            return new Response(JSON.stringify({ current: null, sessions: [{ id: 'sess-rename-1', title: 'Judul lama', source: 'cli', updated: Date.now() }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          if (/\/api\/projects\/[^/?]+\/session-trash(?:\?|$)/.test(u)) {
            return new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          if (/\/api\/projects\/[^/?]+\/session-rename(?:\?|$)/.test(u)) {
            window.__renameCalls.push(JSON.parse(opts?.body ?? '{}'));
            return new Response(JSON.stringify({ ok: true, title: 'Judul dari daftar' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return window.__renameFetch(url, opts);
        };
      });
      try {
        await page.eval(async () => (await import('/js/features/sessions.js')).openSessions());
        await page.waitFor(() => Boolean(document.querySelector('#sessions-list [data-rename]')), { timeoutMs: 4000, message: 'tombol ganti nama' });
        await page.eval(() => document.querySelector('#sessions-list [data-rename]').click());
        await page.waitFor(() => window.__renameCalls.length === 1, { timeoutMs: 4000, message: 'panggilan ganti nama' });
        assert.deepEqual(await page.eval(() => window.__renameCalls[0]), { sessionId: 'sess-rename-1', title: 'Judul dari daftar' });
        await page.press('Escape');
      } finally {
        await page.eval(() => {
          window.fetch = window.__renameFetch;
          window.prompt = window.__renamePrompt;
        });
      }
    });

    test('👥 Kelola tim: dialog, toggle, kantor bertambah meja tanpa reload, read-only di WiFi, tanpa error console/overflow', async (t) => {
      await openApp(page, `#${projectId}`);
      page.clearProblems();
      const shot = async (name) => {
        if (process.env.OFFICE_UI_SHOTS) writeFileSync(path.join(process.env.OFFICE_UI_SHOTS, `${name}-${vp.mobile ? 'mobile' : 'desktop'}.png`), await page.screenshot());
      };
      const DEFAULT = ['pm', 'ba', 'architect', 'ui-ux', 'frontend', 'backend', 'dba', 'qa', 'security', 'devops', 'writer', 'freelancer', 'mobile', 'data', 'support', 'reviewer', 'compliance'];
      // whatever happens, the next test gets the default team back
      t.after(() => page.eval((enabled) => {
        const token = document.querySelector('meta[name="office-token"]').content;
        return fetch('/api/team/roster/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify({ enabled }) }).then((r) => r.status);
      }, DEFAULT));
      const office = () => page.eval(async () => {
        const { scenes, stage } = await import('/js/core/scenes.js');
        const { DESKS, room } = await import('/js/office/world.js');
        const canvas = stage.world; // the logical canvas the office is drawn on (the view may be hidden on a phone)
        return {
          people: Object.keys(scenes.get(location.hash.slice(1))?.people ?? {}).length,
          cards: document.querySelectorAll('#team .member').length,
          roomH: room.h,
          reviewerY: DESKS.reviewer?.y ?? null,
          complianceY: DESKS.compliance?.y ?? null,
          empty: scenes.get(location.hash.slice(1))?.emptyDesks.length ?? null, // off roles: their desk stays, empty
          // pod names, Ruang Rapat, Pantry (+ the door plate of an empty private office)
          signs: [...document.querySelectorAll('#stage .sign')].filter((n) => !n.hidden).length,
          ratio: Math.round((canvas.height / canvas.width) * 100) / 100,
          marker: window.__sameDocument === true,
        };
      });
      await page.eval(() => (window.__sameDocument = true)); // gone after a reload
      assert.deepEqual(await office(), { people: 18, cards: 18, roomH: 344, reviewerY: 192, complianceY: 192, empty: 0, signs: 6, ratio: 0.54, marker: true }, 'tim bawaan: 17 meja + Lead di denah tetap');

      // opened from ⋯ (⚙, Ctrl+P and /team are the other ways in)
      await tapMore(page, 'roster');
      await page.waitFor(() => !document.querySelector('#roster-modal').hidden && document.querySelectorAll('#roster-list .roster-row').length === 18, { timeoutMs: 3000, message: 'dialog Kelola tim terbuka' });
      await settle(page, 'roster-modal');
      const dialog = await page.eval(() => ({
        count: document.querySelector('#roster-count').textContent,
        leadLocked: !document.querySelector('#roster-list .roster-row:first-child input') && /Lead/.test(document.querySelector('#roster-list .roster-row:first-child').textContent),
        freelancer: [document.querySelector('#roster-freelancer').checked, document.querySelector('#roster-freelancer').disabled],
        off: [...document.querySelectorAll('#roster-list input:not(:checked)')].map((i) => i.dataset.role),
        saveDisabled: document.querySelector('#roster-save').disabled,
        roHidden: document.querySelector('#roster-ro').hidden,
        avatars: [...document.querySelectorAll('#roster-list img')].every((img) => img.complete && img.naturalWidth > 0),
        switches: [...document.querySelectorAll('#roster-list input')].every((i) => i.getAttribute('role') === 'switch' && document.querySelector(`label[for="${i.id}"]`) && i.getAttribute('aria-describedby')),
        focusInside: document.querySelector('#roster-modal').contains(document.activeElement),
        rowsFit: [...document.querySelectorAll('#roster-list .roster-row')].every((r) => r.scrollWidth <= r.clientWidth + 1),
      }));
      assert.deepEqual(dialog, { count: '17/17 meja', leadLocked: true, freelancer: [true, true], off: [], saveDisabled: true, roHidden: true, avatars: true, switches: true, focusInside: true, rowsFit: true });
      assert.equal(await page.eval(horizontalOverflow), null, 'dialog tanpa scroll horizontal');
      assert.deepEqual(await page.eval(unnamedButtons, '#roster-modal'), []);

      // the five optional roles off: 12/17, saved, their desks empty in place without a reload
      for (const role of ['mobile', 'data', 'support', 'reviewer', 'compliance']) await page.eval((r) => document.querySelector(`#roster-${r}`).click(), role);
      assert.equal(await page.eval(() => document.querySelector('#roster-count').textContent), '12/17 meja');
      assert.match(await page.eval(() => document.querySelector('#roster-mobile-desc').textContent), /Nonaktif → dikerjakan Adhit - Frontend/, 'fallback tampil');
      assert.match(await page.eval(() => document.querySelector('#roster-compliance-desc').textContent), /Nonaktif → dikerjakan Adhit - Security/, 'Compliance mati: Security yang mengerjakan');
      assert.equal(await page.eval(() => document.querySelector('#roster-save').disabled), false);
      await shot('roster');
      await page.click('#roster-save');
      await page.waitFor(() => document.querySelector('#roster-modal').hidden, { timeoutMs: 4000, message: 'dialog tertutup setelah simpan' });
      await page.waitFor(() => document.querySelectorAll('#team .member').length === 13, { timeoutMs: 3000, message: 'kartu tim berkurang' });
      assert.deepEqual(await office(), { people: 13, cards: 13, roomH: 344, reviewerY: null, complianceY: null, empty: 5, signs: 6, ratio: 0.54, marker: true }, '12 meja + Lead: 5 meja kosong di tempatnya, ukuran kantor tetap, tanpa reload');
      assert.deepEqual((await snapshot()).config.team.enabled.filter((r) => ['mobile', 'data', 'support', 'reviewer', 'compliance'].includes(r)), [], 'tersimpan di server');

      // a phone on plain WiFi sees the same dialog, read-only
      await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        state.readOnly = true;
        (await import('/js/features/roster.js')).openRoster();
      });
      await page.waitFor(() => !document.querySelector('#roster-modal').hidden, { timeoutMs: 2000, message: 'dialog terbuka (read-only)' });
      const ro = await page.eval(() => ({
        note: !document.querySelector('#roster-ro').hidden,
        save: document.querySelector('#roster-save').hidden,
        allDisabled: [...document.querySelectorAll('#roster-list input')].every((i) => i.disabled),
      }));
      await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        state.readOnly = false;
      });
      assert.deepEqual(ro, { note: true, save: true, allDisabled: true });
      await page.press('Escape');

      // /team, then ↺ Tim bawaan: back to all 17 desks
      await typeInPrompt(page, '/team');
      await page.eval(() => document.querySelector('#btn-send').click());
      await page.waitFor(() => !document.querySelector('#roster-modal').hidden, { timeoutMs: 2000, message: '/team membuka dialog' });
      // (clicked in-page: the "Tim disimpan" toast from the first save may still cover the dialog's bottom edge)
      await page.eval(() => document.querySelector('#roster-default').click());
      assert.equal(await page.eval(() => document.querySelector('#roster-count').textContent), '17/17 meja');
      assert.equal(await page.eval(() => document.querySelector('#roster-compliance').checked), true, '↺ Tim bawaan: Compliance ikut aktif');
      await page.eval(() => document.querySelector('#roster-save').click());
      await page.waitFor(() => document.querySelectorAll('#team .member').length === 18, { timeoutMs: 4000, message: 'kembali ke 17 meja' });
      assert.deepEqual(await office(), { people: 18, cards: 18, roomH: 344, reviewerY: 192, complianceY: 192, empty: 0, signs: 6, ratio: 0.54, marker: true });
      if (vp.mobile) await page.click('#mobile-nav [data-view="office"]');
      await sleep(400);
      assert.equal(await page.eval(horizontalOverflow), null, 'kantor 17 meja tanpa scroll horizontal');
      // Name tags with everyone at their desk: none overlap (a phone shortens them), the full name stays in the
      // tooltip and for screen readers, and a desktop keeps the full names.
      const tags = await page.eval(async () => {
        const { scenes, stage } = await import('/js/core/scenes.js');
        const scene = scenes.get(location.hash.slice(1));
        for (const p of Object.values(scene.people)) {
          p.release();
          Object.assign(p, { plan: [], walking: false, onSofa: null, holding: null, seated: true, x: p.seat.x, y: p.seat.y, nextIdleAt: performance.now() + 60_000 });
        }
        scene.visitor = null;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const names = [...stage.overlay.querySelectorAll('.actor:not(.tag-measure) .name')];
        const rects = names.map((n) => n.getBoundingClientRect());
        const overlaps = [];
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const [a, b] = [rects[i], rects[j]];
            if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push(`${names[i].title} × ${names[j].title}`);
          }
        }
        return {
          count: names.length,
          overlaps,
          titled: names.every((n) => /^Adhit - /.test(n.title)),
          spoken: names.every((n) => n.querySelector('.sr-only')?.textContent === n.title || n.textContent === n.title),
          shown: names.map((n) => n.querySelector('[aria-hidden]')?.textContent ?? n.textContent),
        };
      });
      assert.equal(tags.count, 18, '18 label nama');
      assert.deepEqual(tags.overlaps, [], 'label nama tidak saling tumpuk');
      assert.ok(tags.titled && tags.spoken, 'nama lengkap tetap di title dan untuk pembaca layar');
      if (vp.mobile) assert.ok(tags.shown.every((t) => !t.startsWith('Adhit - ')), `HP: awalan bersama "Adhit - " dibuang (${tags.shown.join(', ')})`);
      else assert.ok(tags.shown.every((t) => t.startsWith('Adhit - ')), `desktop: nama lengkap (${tags.shown.join(', ')})`);
      // A private office whose role is off shows its door plate; occupied, it has none (its person has a name tag).
      const plates = await page.eval(async () => {
        const { stage } = await import('/js/core/scenes.js');
        const { DESKS, layoutDesks } = await import('/js/office/world.js');
        const visible = () => [...document.querySelectorAll('#stage .sign.plate')].filter((n) => !n.hidden).map((n) => n.textContent);
        const team = Object.keys(DESKS).filter((id) => id !== 'claude');
        const occupied = visible();
        layoutDesks(team.filter((id) => id !== 'pm'));
        stage.refreshLayout();
        const empty = visible();
        layoutDesks(team);
        stage.refreshLayout();
        return { occupied, empty, back: visible() };
      });
      assert.deepEqual(plates, { occupied: ['Ruang Rapat', 'Pantry'], empty: ['PM', 'Ruang Rapat', 'Pantry'], back: ['Ruang Rapat', 'Pantry'] });
      await shot('office-17');
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');

      // Compliance off: 16/17, its desk empties, still no reload
      await page.eval(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      await tapMore(page, 'roster');
      await page.waitFor(() => !document.querySelector('#roster-modal').hidden, { timeoutMs: 3000, message: 'dialog terbuka lagi' });
      await page.eval(() => document.querySelector('#roster-compliance').click());
      assert.equal(await page.eval(() => document.querySelector('#roster-count').textContent), '16/17 meja');
      await page.eval(() => document.querySelector('#roster-save').click());
      await page.waitFor(() => document.querySelectorAll('#team .member').length === 17, { timeoutMs: 4000, message: '16 meja' });
      assert.deepEqual(await office(), { people: 17, cards: 17, roomH: 344, reviewerY: 192, complianceY: null, empty: 1, signs: 6, ratio: 0.54, marker: true }, '16 meja: meja Compliance kosong');
      if (vp.mobile) await page.click('#mobile-nav [data-view="office"]');
      await sleep(400);
      assert.equal(await page.eval(horizontalOverflow), null, 'kantor 16 meja tanpa scroll horizontal');
      await shot('office-16');
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]');

      // ↺ Tim bawaan again: back to 17 (Compliance on)
      await page.eval(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
      await tapMore(page, 'roster');
      await page.waitFor(() => !document.querySelector('#roster-modal').hidden, { timeoutMs: 3000, message: 'dialog terbuka lagi' });
      await page.eval(() => document.querySelector('#roster-default').click());
      assert.equal(await page.eval(() => document.querySelector('#roster-count').textContent), '17/17 meja');
      await page.eval(() => document.querySelector('#roster-save').click());
      await page.waitFor(() => document.querySelectorAll('#team .member').length === 18, { timeoutMs: 4000, message: 'kembali ke 17 meja' });
      assert.deepEqual(await office(), { people: 18, cards: 18, roomH: 344, reviewerY: 192, complianceY: 192, empty: 0, signs: 6, ratio: 0.54, marker: true });
      assert.deepEqual(realProblems(page), []);
    });

    test('🧠 logo model: papan di dinding Lead + inti Mode Otak memakai logo model aktif, ganti model ikut berganti', async () => {
      await ensureApp(page, `#${projectId}`);
      page.clearProblems();
      // The names come from one public request (no token); the plaque and the brain both read that list.
      const asked = await page.eval(() => performance.getEntriesByType('resource').filter((e) => /\/ai-logos\/index\.json(\?|$)/.test(e.name)).length);
      assert.ok(asked >= 1, '/ai-logos/index.json diminta app');
      await page.waitFor(async () => (await import('/js/core/model-logo.js')).logoIndex().length > 0, { timeoutMs: 5000, message: 'index logo tiba' });
      // 🧠 Mode Otak only draws on a visible stage: on a phone the office pane must be the one showing.
      if (vp.mobile) {
        await page.click('#mobile-nav [data-view="office"]');
        await page.waitFor(async () => (await import('/js/core/scenes.js')).brain.w > 60, { timeoutMs: 3000, message: 'panggung Mode Otak punya ukuran' });
      }
      const probe = await page.eval(async () => {
        const { Scene } = await import('/js/office/scene.js');
        const { brain, scenes, stage } = await import('/js/core/scenes.js');
        const id = location.hash.slice(1);
        const real = scenes.get(id);
        const scene = new Scene(); // detached: the live stream can't overwrite the status mid-test
        const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const read = async (status) => {
          scene.setStatus({ busy: false, ...status });
          await nextFrame();
          const host = document.querySelector('#stage');
          return { logo: host.dataset.modelLogo, name: host.dataset.modelName };
        };
        try {
          stage.setScene(scene);
          const first = await read({ model: 'opencode-go/kimi-k3.1-pro' });
          const second = await read({ model: 'sonnet' }); // the alias resolves to the Claude Sonnet file
          const unknown = await read({ model: 'acme-1' }); // no file: the plaque and the core show a monogram
          const active = await read({ activeModel: 'opencode-go/gemini-4-argon', model: 'sonnet' }); // activeModel wins
          // The plaque is really painted on the Lead's wall: a dark frame inside the cream wall, a cream panel inside it.
          const g = stage.world.getContext('2d');
          const sum = (x, y) => {
            const [r, gg, b] = g.getImageData(x, y, 1, 1).data;
            return r + gg + b;
          };
          const plaque = { frame: sum(549, 9), wall: sum(545, 9), panel: sum(552, 30) };
          // 🧠 Mode Otak: the thinking core takes the same logo (the Stage is not drawn in that mode).
          document.querySelector('#view-mode').click();
          await nextFrame();
          const brainLogo = brain.on ? { file: brain.logo?.file ?? null, label: brain.logo?.label ?? null } : null;
          return { first, second, unknown, active, plaque, brainLogo };
        } finally {
          if (brain.on) document.querySelector('#view-mode').click(); // later tests want the pixel office
          if (real) stage.setScene(real);
        }
      });
      assert.deepEqual(probe.first, { logo: 'kimi-k3.1-pro.svg', name: 'kimi-k3.1-pro' }, 'logo model aktif di papan');
      assert.deepEqual(probe.second, { logo: 'claude-sonnet-5-5.svg', name: 'sonnet' }, 'ganti model: logo ikut berganti');
      assert.deepEqual(probe.unknown, { logo: '', name: 'acme-1' }, 'model tanpa file: monogram, tanpa error');
      assert.deepEqual(probe.active, { logo: 'gemini-4-argon.svg', name: 'gemini-4-argon' }, 'status.activeModel menang atas status.model');
      assert.ok(probe.plaque.frame > 0 && probe.plaque.frame < probe.plaque.wall * 0.7, `bingkai gelap di dinding (${JSON.stringify(probe.plaque)})`);
      assert.ok(probe.plaque.panel > probe.plaque.frame, 'panel krem di dalam bingkai');
      assert.deepEqual(probe.brainLogo, { file: 'gemini-4-argon.svg', label: 'gemini-4-argon' }, 'Mode Otak memakai logo yang sama');
      assert.equal(await page.eval(horizontalOverflow), null);
      assert.deepEqual(realProblems(page), []);
      if (vp.mobile) await page.click('#mobile-nav [data-view="chat"]'); // leave the phone where it was
    });

    if (vp.mobile) {
      test('HP: tombol 🔎 di navigasi bawah membuka palet, tanpa overflow', async () => {
        await ready();
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

// ---------- 🔔 notification settings and 🎤 voice input (browser APIs stubbed in the page) ----------

/** Fake AudioContext + Notification: counts oscillators (one per note), gain peaks and notifications. */
function stubSoundAndNotifications() {
  window.__audio = { osc: 0, peaks: [] };
  window.__notes = [];
  window.AudioContext = class {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
    }
    createOscillator() {
      window.__audio.osc++;
      return { frequency: {}, connect: (g) => g, start() {}, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime: (v) => window.__audio.peaks.push(v) }, connect: (d) => d };
    }
  };
  window.Notification = class {
    static permission = 'granted';
    static requestPermission = () => Promise.resolve('granted');
    constructor(title, opts) {
      window.__notes.push({ title, tag: opts?.tag });
    }
    close() {}
  };
}

/** Fake SpeechRecognition: the instance is exposed as window.__rec; results are pushed by the test. */
function stubSpeech() {
  window.__recs = [];
  class FakeRecognition {
    start() {
      this.started = true;
      window.__rec = this;
      window.__recs.push(this);
    }
    stop() {
      this.stopped = true;
      setTimeout(() => this.onend?.(), 10);
    }
    abort() {
      this.stop();
    }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  window.__speak = (text, isFinal) => window.__rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] });
}

// ---------- quick tier commands (/hemat…/maks, /auto) + 🎯 focus mode ----------

for (const vp of VIEWPORTS) {
  describe(`UI perintah tier & mode fokus — ${vp.name}`, { skip: SKIP ?? false }, () => {
    let page;
    before(async () => {
      if (SKIP) return;
      page = await browser.newPage();
      await page.setViewport(vp);
      await openApp(page, `#${projectId}`);
    });
    after(async () => {
      await page?.eval(() => localStorage.removeItem('office.focus')).catch(() => {});
      await page?.close();
    });

    /** Types a local slash command and runs it (first Enter picks the autocomplete row, second sends). */
    async function runCommand(text) {
      await typeInPrompt(page, text);
      await page.press('Enter');
      await page.press('Enter');
    }

    const status = () =>
      page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        const st = state.statuses[state.active] ?? {};
        return { model: st.model, modelAuto: st.modelAuto, select: document.querySelector('#model').value };
      });

    test('tier (/hemat /seimbang /kuat /maks) muncul di autocomplete & mengirim model tier + Auto mati (Claude)', async () => {
      await ensureApp(page, `#${projectId}`);
      await stubSettings(page);
      try {
        const catalog = await page.eval(async (models) => {
          const { state } = await import('/js/core/state.js');
          state.config = { ...state.config, engine: 'claude', models };
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), engine: 'claude', model: '', modelAuto: true, modelTiers: {} };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
          const { slashCatalog } = await import('/js/features/suggest.js');
          return slashCatalog()
            .filter((c) => ['hemat', 'seimbang', 'kuat', 'maks', 'auto', 'fokus'].includes(c.name))
            .map((c) => ({ name: c.name, description: c.description ?? '' }));
        }, CLAUDE_CATALOG);
        assert.deepEqual(catalog.map((c) => c.name), ['hemat', 'seimbang', 'kuat', 'maks', 'auto', 'fokus'], 'LOCAL_COMMANDS mengisi autocomplete/palet');
        assert.ok(catalog.every((c) => c.description.trim().length >= 20), `deskripsi jelas: ${JSON.stringify(catalog)}`);

        for (const command of ['/hemat', '/seimbang', '/kuat', '/maks']) await runCommand(command);
        await page.waitFor(() => window.__settingsBodies.length === 4, { timeoutMs: 3000, message: 'empat POST model tier' });
        const view = await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          return {
            bodies: window.__settingsBodies,
            model: state.statuses[state.active]?.model,
            modelAuto: state.statuses[state.active]?.modelAuto,
            select: document.querySelector('#model').value,
            prompt: document.querySelector('#prompt').value,
            toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
          };
        });
        assert.deepEqual(
          view.bodies,
          [
            { model: 'haiku', modelAuto: false },
            { model: 'sonnet', modelAuto: false },
            { model: 'opus', modelAuto: false },
            { model: 'fable', modelAuto: false },
          ],
          'tiap perintah: model tier + Auto dimatikan',
        );
        assert.deepEqual({ model: view.model, modelAuto: view.modelAuto }, { model: 'fable', modelAuto: false }, 'status optimistis');
        assert.equal(view.select, 'fable', 'composer menampilkan model tier');
        assert.equal(view.prompt, '', 'kotak pesan dikosongkan');
        assert.match(view.toasts.join('\n'), /Model: Maks → fable \(Auto dimatikan\)/, 'toast menyebut tier dan model');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await restoreSettings(page);
        await openApp(page, `#${projectId}`);
      }
    });

    test('tier mengikuti tangga project di engine OpenCode (/kuat → deepseek-v4-pro)', async () => {
      await ensureApp(page, `#${projectId}`);
      await stubSettings(page);
      await stubModels(page);
      try {
        await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          state.config = { ...state.config, engine: 'opencode' };
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), engine: 'opencode', model: '', modelAuto: true, modelTiers: undefined };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
        });
        await runCommand('/kuat');
        await page.waitFor(() => window.__settingsBodies.length === 1, { timeoutMs: 3000, message: 'POST /kuat' });
        const view = await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          return {
            bodies: window.__settingsBodies,
            model: state.statuses[state.active]?.model,
            modelAuto: state.statuses[state.active]?.modelAuto,
            toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
          };
        });
        assert.deepEqual(view.bodies[0], { model: 'opencode-go/deepseek-v4-pro', modelAuto: false }, 'model tier dari tangga OpenCode');
        assert.deepEqual({ model: view.model, modelAuto: view.modelAuto }, { model: 'opencode-go/deepseek-v4-pro', modelAuto: false });
        assert.match(view.toasts.join('\n'), /Model: Kuat → deepseek-v4-pro \(Auto dimatikan\)/, 'nama pendek di toast');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await restoreModels(page);
        await restoreSettings(page);
        await openApp(page, `#${projectId}`);
      }
    });

    test('/auto menyalakan Model Auto; tier tidak valid → peringatan tanpa POST & status tetap', async () => {
      await ensureApp(page, `#${projectId}`);
      await stubSettings(page);
      try {
        await page.eval(async (models) => {
          const { state } = await import('/js/core/state.js');
          state.config = { ...state.config, engine: 'claude', models };
          state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), engine: 'claude', model: 'sonnet', modelAuto: false, modelTiers: { claude: { kuat: 'dua kata' } } };
          document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
        }, CLAUDE_CATALOG);

        await runCommand('/kuat');
        await page.waitFor(() => [...document.querySelectorAll('.toast.warn')].some((t) => /Model tingkat Kuat/.test(t.textContent)), { timeoutMs: 2000, message: 'peringatan tier tidak valid' });
        assert.deepEqual(await status(), { model: 'sonnet', modelAuto: false, select: 'sonnet' }, 'tier tidak valid tidak mengubah apa pun');
        assert.equal(await page.eval(() => window.__settingsBodies.length), 0, 'tidak ada POST');

        await runCommand('/auto');
        await page.waitFor(() => window.__settingsBodies.length === 1, { timeoutMs: 3000, message: 'POST /auto' });
        const view = await page.eval(async () => {
          const { state } = await import('/js/core/state.js');
          return {
            bodies: window.__settingsBodies,
            modelAuto: state.statuses[state.active]?.modelAuto,
            select: document.querySelector('#model').value,
            toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
          };
        });
        assert.deepEqual(view.bodies, [{ modelAuto: true }], '/auto hanya mengirim flag Auto');
        assert.equal(view.modelAuto, true, 'status optimistis');
        assert.equal(view.select, 'auto', 'composer menampilkan Auto');
        assert.match(view.toasts.join('\n'), /Model Auto aktif/, 'toast /auto');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await restoreSettings(page);
        await openApp(page, `#${projectId}`);
      }
    });

    test('/fokus: kelas body, localStorage, kantor tersembunyi + animasi jeda, chip keluar, bertahan setelah muat ulang', async () => {
      await ensureApp(page, `#${projectId}`);
      try {
        await page.eval(async () => {
          localStorage.removeItem('office.focus');
          localStorage.setItem('office.viewMode', 'office'); // measure the office, not 🧠 Mode Otak from an earlier test
          document.querySelectorAll('.toast').forEach((t) => t.remove());
          (await import('/js/features/focus.js')).setFocus(false);
          const { brain } = await import('/js/core/scenes.js');
          if (brain.on) brain.setOn(false);
        });
        // Count real stage frames: the app loop must run none while focus mode is on.
        await page.eval(async () => {
          const { stage } = await import('/js/core/scenes.js');
          window.__realStageFrame = stage.frame;
          window.__frames = 0;
          stage.frame = function (t) {
            window.__frames += 1;
            return window.__realStageFrame.call(this, t);
          };
        });
        await runCommand('/fokus');
        await page.waitFor(() => document.body.classList.contains('focus-mode'), { timeoutMs: 2000, message: 'mode fokus aktif' });
        const frames0 = await page.eval(() => window.__frames);
        await sleep(300);
        const on = await page.eval(() => ({
          frames: window.__frames,
          stored: localStorage.getItem('office.focus'),
          toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
          office: getComputedStyle(document.querySelector('.office')).display,
          stageRects: document.querySelector('#stage').getClientRects().length,
          chip: (() => {
            const b = document.querySelector('#focus-exit');
            return { hidden: b.hidden, visible: Boolean(b.getClientRects().length), label: b.getAttribute('aria-label') ?? '' };
          })(),
        }));
        assert.equal(on.frames, frames0, 'tidak ada frame kantor selagi mode fokus');
        assert.equal(on.stored, '1', 'tersimpan di localStorage');
        assert.equal(on.office, 'none', 'wadah kantor disembunyikan');
        assert.equal(on.stageRects, 0, '#stage tidak tampil');
        assert.deepEqual({ hidden: on.chip.hidden, visible: on.chip.visible }, { hidden: false, visible: true }, 'chip keluar terlihat');
        assert.match(on.chip.label, /keluar dari mode fokus/i, 'chip punya aria-label');
        assert.ok(on.toasts.includes('Mode fokus aktif — animasi kantor disembunyikan'), on.toasts.join(' | '));
        assert.equal(await page.eval(horizontalOverflow), null, 'tanpa scroll horizontal di mode fokus');

        // the chip brings the office back and the animation resumes
        await page.click('#focus-exit');
        await page.waitFor(() => !document.body.classList.contains('focus-mode'), { timeoutMs: 2000, message: 'mode fokus mati' });
        const framesOff = await page.eval(() => window.__frames);
        await sleep(250);
        const off = await page.eval(() => ({ frames: window.__frames, stored: localStorage.getItem('office.focus'), chip: document.querySelector('#focus-exit').hidden }));
        assert.ok(off.frames > framesOff, 'frame kantor jalan lagi');
        assert.deepEqual({ stored: off.stored, chip: off.chip }, { stored: '0', chip: true }, 'mode fokus mati & chip hilang');
        await page.eval(async () => {
          const { stage } = await import('/js/core/scenes.js');
          if (window.__realStageFrame) stage.frame = window.__realStageFrame;
          delete window.__realStageFrame;
          delete window.__frames;
        });

        // a reload keeps the setting, before the first frame
        await runCommand('/fokus');
        await page.waitFor(() => document.body.classList.contains('focus-mode'), { timeoutMs: 2000, message: 'fokus aktif lagi' });
        await openApp(page, `#${projectId}`);
        const reloaded = await page.eval(() => {
          if (document.body.dataset.view !== 'office') document.body.dataset.view = 'office'; // phone: prove the office is hidden by focus, not by the view
          return {
            cls: document.body.classList.contains('focus-mode'),
            stored: localStorage.getItem('office.focus'),
            office: getComputedStyle(document.querySelector('.office')).display,
            chip: !document.querySelector('#focus-exit').hidden,
          };
        });
        assert.deepEqual(reloaded, { cls: true, stored: '1', office: 'none', chip: true }, 'setelan bertahan setelah muat ulang (termasuk HP)');

        // and the chip still restores the office on the reloaded page
        await page.click('#focus-exit');
        await page.waitFor(() => !document.body.classList.contains('focus-mode'), { timeoutMs: 2000, message: 'keluar setelah muat ulang' });
        await sleep(250); // the stage's ResizeObserver measures the shown host again
        const back = await page.eval(() => ({
          stored: localStorage.getItem('office.focus'),
          office: getComputedStyle(document.querySelector('.office')).display,
          stageRects: document.querySelector('#stage').getClientRects().length,
          canvas: document.querySelector('#stage canvas').width,
        }));
        assert.equal(back.stored, '0');
        assert.notEqual(back.office, 'none', 'kantor kembali tampil');
        assert.ok(back.stageRects > 0, 'kanvas kantor kembali');
        assert.ok(back.canvas > 0, 'kanvas digambar ulang setelah mode fokus');
        assert.equal(await page.eval(horizontalOverflow), null, 'tanpa scroll horizontal setelah keluar');
        assert.deepEqual(realProblems(page), []);
      } finally {
        await page
          .eval(async () => {
            localStorage.removeItem('office.focus');
            (await import('/js/features/focus.js')).setFocus(false);
          })
          .catch(() => {});
        await openApp(page, `#${projectId}`).catch(() => {});
      }
    });
  });
}

for (const vp of VIEWPORTS) {
  describe(`UI notifikasi & input suara — ${vp.name}`, { skip: SKIP ?? false }, () => {
    let page;
    before(async () => {
      if (SKIP) return;
      page = await browser.newPage();
      await page.setViewport(vp);
    });
    after(async () => page?.close());

    // A fresh page per test: the stubs must be in place before the first chime creates the AudioContext.
    async function freshApp(storage = {}) {
      await openApp(page, `#${projectId}`);
      await page.eval((s) => {
        for (const k of ['office.notify', 'office.notifySettings', 'office.voiceLang']) localStorage.removeItem(k);
        for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
      }, storage);
      await openApp(page, `#${projectId}`);
    }

    const counts = () => page.eval(() => ({ osc: window.__audio.osc, notes: window.__notes.length, peak: Math.max(0, ...window.__audio.peaks.filter((v) => v > 0.001)) }));
    const fire = (kind, where) =>
      page.eval(
        async (k, w) => {
          const { notify } = await import('/js/features/notify.js');
          const { state } = await import('/js/core/state.js');
          notify(k, `judul ${k}`, 'isi', w === 'here' ? state.active : 'project-lain');
        },
        kind,
        where,
      );

    test('🔔 bawaan tidak berubah: suara + pop-up hanya saat di project lain, izin tetap berbunyi', async () => {
      await freshApp({ 'office.notify': '1' });
      page.clearProblems();
      await page.eval(stubSoundAndNotifications);
      await fire('done', 'away');
      assert.deepEqual(await counts(), { osc: 2, notes: 1, peak: 0.18 }, 'selesai di project lain: 2 nada + 1 notifikasi, volume penuh');
      await fire('done', 'here');
      await fire('error', 'here');
      assert.deepEqual(await counts(), { osc: 2, notes: 1, peak: 0.18 }, 'sedang dilihat: diam');
      await fire('ask', 'here');
      assert.deepEqual(await counts(), { osc: 5, notes: 1, peak: 0.18 }, 'minta izin di project ini: bunyi tanpa pop-up');
      await fire('error', 'away');
      assert.deepEqual(await counts(), { osc: 7, notes: 2, peak: 0.18 });
      assert.equal(await page.eval(() => localStorage.getItem('office.notifySettings')), null, 'tanpa pengaturan tersimpan');
      assert.deepEqual(realProblems(page), []);
    });

    test('🔔 pengaturan: dialog (klik kanan / Ctrl+P), tersimpan, jam tenang membisukan, izin dikecualikan, volume, tes suara', async () => {
      await freshApp({ 'office.notify': '1' });
      page.clearProblems();
      await page.eval(stubSoundAndNotifications);
      if (vp.mobile) {
        // the 🔔 button is not in the phone's top bar: the palette is the way in
        await paletteType(page, 'pengaturan notifikasi');
        await page.waitFor(() => (document.querySelector('#palette-list .pal-opt.active .pal-label')?.textContent ?? '') === 'Pengaturan notifikasi', { timeoutMs: 2000, message: 'aksi di palet' });
        await page.press('Enter');
      } else {
        await page.eval(() => document.querySelector('#btn-notify').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      }
      await page.waitFor(() => !document.querySelector('#notify-modal').hidden, { timeoutMs: 2000, message: 'dialog notifikasi terbuka' });
      const form = await page.eval(() => ({
        on: document.querySelector('#ns-on').checked,
        events: [...document.querySelectorAll('.ns-table input')].map((i) => i.checked),
        quiet: document.querySelector('#ns-quiet').checked,
        timesDisabled: document.querySelector('#ns-from').disabled && document.querySelector('#ns-to').disabled,
        allowAsk: document.querySelector('#ns-quiet-ask').checked,
        fav: document.querySelector('#ns-fav').checked,
        volume: document.querySelector('#ns-volume').value,
        labelled: [...document.querySelectorAll('#notify-form input')].every((i) => i.getAttribute('aria-label') || i.closest('label') || document.querySelector(`label[for="${i.id}"]`)),
        focusInside: document.querySelector('#notify-modal').contains(document.activeElement),
      }));
      assert.deepEqual(form, { on: true, events: [true, true, true, true, true, true], quiet: false, timesDisabled: true, allowAsk: true, fav: false, volume: '100', labelled: true, focusInside: true });
      assert.equal(await page.eval(horizontalOverflow), null, 'dialog tanpa scroll horizontal');
      assert.deepEqual(await page.eval(unnamedButtons, '#notify-modal'), []);
      assert.equal(await page.eval(() => document.querySelector('.notify-card').scrollWidth <= document.querySelector('.notify-card').clientWidth + 1), true, 'isi dialog muat');

      // Selesai: no sound; quiet hours around "now"; volume 50
      const saved = await page.eval(() => {
        const pad = (n) => String(n).padStart(2, '0');
        const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const now = Date.now();
        const set = (sel, value) => {
          const el = document.querySelector(sel);
          el.value = value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        document.querySelector('#ns-done-sound').click();
        document.querySelector('#ns-quiet').click();
        set('#ns-from', hhmm(new Date(now - 3600_000)));
        set('#ns-to', hhmm(new Date(now + 3600_000)));
        set('#ns-volume', '50');
        return JSON.parse(localStorage.getItem('office.notifySettings'));
      });
      assert.deepEqual(saved.events.done, { popup: true, sound: false });
      assert.equal(saved.quiet.enabled, true);
      assert.equal(saved.volume, 50);
      assert.equal(await page.eval(() => document.querySelector('#ns-volume-val').textContent), '50%');

      await fire('done', 'away');
      await fire('error', 'away');
      assert.deepEqual(await counts(), { osc: 0, notes: 0, peak: 0 }, 'jam tenang: tanpa suara, tanpa pop-up');
      await fire('ask', 'away');
      assert.deepEqual(await counts(), { osc: 3, notes: 1, peak: 0.09 }, 'izin tetap diberitahu, dengan volume 50%');
      await page.eval(() => document.querySelector('#ns-quiet-ask').click());
      await fire('ask', 'away');
      assert.deepEqual(await counts(), { osc: 3, notes: 1, peak: 0.09 }, 'tanpa pengecualian: izin juga dibisukan');

      // ▶ Tes suara plays at the slider's volume (quiet hours don't apply to a test)
      await page.eval(() => document.querySelector('#ns-test').click());
      assert.equal((await counts()).osc, 5);

      // same start and end: an error, the stored times stay
      const prevQuiet = await page.eval(() => JSON.parse(localStorage.getItem('office.notifySettings')).quiet);
      await page.eval(() => {
        const to = document.querySelector('#ns-to');
        to.value = document.querySelector('#ns-from').value;
        to.dispatchEvent(new Event('change', { bubbles: true }));
      });
      assert.match(await page.eval(() => document.querySelector('#ns-quiet-error').textContent), /tidak boleh sama/);
      assert.equal(await page.eval(() => document.querySelector('#ns-to').getAttribute('aria-invalid')), 'true');
      const afterErr = await page.eval(() => JSON.parse(localStorage.getItem('office.notifySettings')).quiet);
      assert.deepEqual([afterErr.from, afterErr.to, afterErr.enabled], [prevQuiet.from, prevQuiet.to, prevQuiet.enabled]);

      // favourites only: the test project is not a favourite
      await page.eval(() => document.querySelector('#ns-quiet').click()); // quiet off (also clears the error)
      assert.equal(await page.eval(() => document.querySelector('#ns-quiet-error').textContent), '');
      await page.eval(() => document.querySelector('#ns-fav').click());
      await fire('error', 'away');
      assert.deepEqual(await counts(), { osc: 5, notes: 1, peak: 0.09 }, 'bukan favorit: diam');
      await page.press('Escape');

      // survives a reload, shown again in the dialog
      await openApp(page, `#${projectId}`);
      const restored = await page.eval(async () => {
        (await import('/js/features/notify.js')).openNotifySettings();
        return {
          doneSound: document.querySelector('#ns-done-sound').checked,
          askSound: document.querySelector('#ns-ask-sound').checked,
          fav: document.querySelector('#ns-fav').checked,
          allowAsk: document.querySelector('#ns-quiet-ask').checked,
          volume: document.querySelector('#ns-volume').value,
        };
      });
      assert.deepEqual(restored, { doneSound: false, askSound: true, fav: true, allowAsk: false, volume: '50' });

      // ↺ back to the defaults
      await page.eval(() => document.querySelector('#ns-reset').click());
      assert.equal(await page.eval(() => document.querySelector('#ns-done-sound').checked && !document.querySelector('#ns-fav').checked && document.querySelector('#ns-volume').value === '100'), true);
      await page.press('Escape');
      assert.deepEqual(realProblems(page), []);
    });

    test('🎤 deteksi fitur: muncul hanya bila API ada, konteks aman, dan bukan hanya-lihat', async () => {
      await freshApp();
      page.clearProblems();
      const shown = () =>
        page.eval(async () => {
          (await import('/js/features/voice.js')).renderVoice();
          const b = document.querySelector('#btn-voice');
          return !b.hidden && b.getClientRects().length > 0 && !document.querySelector('#voice-lang-ctl').hidden;
        });
      await page.eval(stubSpeech);
      assert.equal(await shown(), true, 'API ada + localhost (secure context)');
      assert.equal(await page.eval(horizontalOverflow), null, 'kotak pesan dengan 🎤 tanpa overflow');
      await page.eval(() => {
        window.__saved = [window.SpeechRecognition, window.webkitSpeechRecognition];
        window.SpeechRecognition = undefined;
        window.webkitSpeechRecognition = undefined;
      });
      assert.equal(await shown(), false, 'tanpa API: tersembunyi');
      await page.eval(() => void ([window.SpeechRecognition, window.webkitSpeechRecognition] = window.__saved));
      // window.isSecureContext is an own accessor of the global: overridden, then put back exactly as it was
      await page.eval(() => {
        window.__secureDesc = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
        Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
      });
      assert.equal(await shown(), false, 'http:// biasa (bukan secure context): tersembunyi');
      await page.eval(() => void Object.defineProperty(window, 'isSecureContext', window.__secureDesc));
      assert.equal(await page.eval(() => window.isSecureContext), true);
      await page.eval(async () => ((await import('/js/core/state.js')).state.readOnly = true));
      assert.equal(await shown(), false, 'WiFi hanya-lihat: tersembunyi');
      await page.eval(async () => ((await import('/js/core/state.js')).state.readOnly = false));
      assert.equal(await shown(), true);
      assert.deepEqual(realProblems(page), []);
    });

    test('🎤 interim tampil live, hasil final masuk di posisi kursor, klik/Esc berhenti, error → toast', async () => {
      await freshApp();
      page.clearProblems();
      await page.eval(stubSpeech);
      await page.eval(async () => (await import('/js/features/voice.js')).renderVoice());
      await typeInPrompt(page, 'halo dunia');
      await page.eval(() => document.querySelector('#prompt').setSelectionRange(5, 5)); // after "halo "
      await tap(page, '#btn-voice');
      const rec = await page.eval(() => ({
        started: window.__rec?.started === true,
        lang: window.__rec.lang,
        interim: window.__rec.interimResults,
        pressed: document.querySelector('#btn-voice').getAttribute('aria-pressed'),
        label: document.querySelector('#btn-voice').getAttribute('aria-label'),
        pulsing: getComputedStyle(document.querySelector('#btn-voice')).animationName,
      }));
      assert.deepEqual(rec, { started: true, lang: 'id-ID', interim: true, pressed: 'true', label: 'Hentikan input suara', pulsing: 'voice-pulse' });

      await page.eval(() => window.__speak('apa', false));
      assert.match(await page.eval(() => document.querySelector('#voice-live').textContent), /Mendengarkan… apa$/);
      assert.equal(await page.eval(() => document.querySelector('#prompt').value), 'halo dunia', 'interim belum masuk kotak');
      await page.eval(() => window.__speak('apa kabar', true));
      assert.equal(await page.eval(() => document.querySelector('#prompt').value), 'halo apa kabar dunia', 'final di posisi kursor, teks lama utuh');
      await page.eval(() => window.__speak(' <b>tes</b>', true)); // the next phrase continues at the cursor
      assert.equal(await page.eval(() => document.querySelector('#prompt').value), 'halo apa kabar <b>tes</b> dunia');
      await page.eval(() => window.__speak('<img src=x onerror="window.__xss=1">', false));
      assert.equal(await page.eval(() => document.querySelector('#voice-live img')), null, 'interim tidak di-parse sebagai HTML');

      // Esc stops recording (and nothing else)
      await page.press('Escape');
      await page.waitFor(() => document.querySelector('#btn-voice').getAttribute('aria-pressed') === 'false', { timeoutMs: 2000, message: 'Esc menghentikan' });
      assert.equal(await page.eval(() => window.__rec.stopped), true);
      assert.equal(await page.eval(() => document.querySelector('#voice-live').textContent), '');
      assert.equal(await page.eval(() => document.querySelector('#prompt').value), 'halo apa kabar <b>tes</b> dunia', 'Esc tidak mengosongkan kotak');

      // click toggles on and off; English remembered for the next start
      await page.eval(() => {
        const sel = document.querySelector('#voice-lang');
        sel.value = 'en-US';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      assert.equal(await page.eval(() => localStorage.getItem('office.voiceLang')), 'en-US');
      await tap(page, '#btn-voice');
      assert.equal(await page.eval(() => window.__recs.length === 2 && window.__rec.lang), 'en-US');
      await tap(page, '#btn-voice');
      await page.waitFor(() => document.querySelector('#btn-voice').getAttribute('aria-pressed') === 'false', { timeoutMs: 2000, message: 'klik lagi menghentikan' });

      // the browser ends it on its own (silence): back to idle
      await page.eval(() => document.querySelector('#btn-voice').click());
      await page.eval(() => window.__rec.onend());
      assert.equal(await page.eval(() => document.querySelector('#btn-voice').getAttribute('aria-pressed')), 'false', 'berhenti otomatis saat end');

      // errors: a short Indonesian toast
      await page.eval(() => document.querySelector('#btn-voice').click());
      await page.eval(() => window.__rec.onerror({ error: 'not-allowed' }));
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Akses mikrofon ditolak/.test(t.textContent)), { timeoutMs: 2000, message: 'toast izin mikrofon' });
      await page.eval(() => window.__rec.onerror({ error: 'no-speech' }));
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Tidak terdengar suara/.test(t.textContent)), { timeoutMs: 2000, message: 'toast tanpa suara' });
      await page.eval(() => window.__rec.onend());

      // Alt+M toggles
      const altM = () => page.eval(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', altKey: true, bubbles: true })));
      await altM();
      assert.equal(await page.eval(() => document.querySelector('#btn-voice').getAttribute('aria-pressed')), 'true', 'Alt+M mulai');
      await altM();
      await page.waitFor(() => document.querySelector('#btn-voice').getAttribute('aria-pressed') === 'false', { timeoutMs: 2000, message: 'Alt+M berhenti' });
      // a held key (repeat) and an open dialog: Alt+M does nothing
      await page.eval(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', altKey: true, repeat: true, bubbles: true })));
      assert.equal(await page.eval(() => document.querySelector('#btn-voice').getAttribute('aria-pressed')), 'false', 'Alt+M repeat diabaikan');
      await page.eval(() => (document.querySelector('#help-modal').hidden = false));
      await altM();
      assert.equal(await page.eval(() => document.querySelector('#btn-voice').getAttribute('aria-pressed')), 'false', 'Alt+M diabaikan saat dialog terbuka');
      await page.eval(() => (document.querySelector('#help-modal').hidden = true));
      assert.equal(await page.eval(() => window.__xss), undefined);
      await page.eval(() => localStorage.removeItem('office.voiceLang'));
      assert.deepEqual(realProblems(page), []);
    });

    test('🎤 Esc saat merekam: hanya berhenti merekam — tanpa /stop di giliran yang berjalan, tanpa Esc-Esc (kosongkan / Rewind)', async () => {
      await freshApp();
      page.clearProblems();
      await page.eval(stubSpeech);
      await page.eval(async () => {
        (await import('/js/features/voice.js')).renderVoice();
        window.__posts = [];
        const orig = window.fetch;
        window.fetch = (url, opts) => (window.__posts.push(String(url)), orig(url, opts));
        const { state } = await import('/js/core/state.js');
        window.__savedStatus = state.statuses[state.active];
        state.statuses[state.active] = { ...(window.__savedStatus ?? {}), busy: true }; // a turn is running
      });
      const stopped = () => page.waitFor(() => document.querySelector('#btn-voice').getAttribute('aria-pressed') === 'false', { timeoutMs: 2000, message: 'rekaman berhenti' });
      await page.eval(() => document.querySelector('#btn-voice').click());
      await page.press('Escape');
      await stopped();
      await sleep(300);
      assert.deepEqual(await page.eval(() => window.__posts.filter((u) => /\/stop$/.test(u))), [], 'Esc tidak menghentikan giliran');

      // idle: two Esc in a row (each while recording) neither clear the box nor open Rewind
      await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        state.statuses[state.active] = window.__savedStatus;
      });
      await typeInPrompt(page, 'jangan dihapus');
      await page.eval(() => document.querySelector('#btn-voice').click());
      await page.press('Escape');
      await stopped();
      await page.eval(() => document.querySelector('#btn-voice').click());
      await page.press('Escape');
      await stopped();
      assert.equal(await page.eval(() => document.querySelector('#prompt').value), 'jangan dihapus');
      assert.equal(await page.eval(() => document.querySelector('#rewind-modal').hidden), true, 'Rewind tidak terbuka');
      assert.deepEqual(await page.eval(() => window.__posts.filter((u) => /\/stop$/.test(u))), []);
      assert.deepEqual(realProblems(page), []);
    });

    test('⏪ Rewind OpenCode: catatan apa yang dikembalikan, "Kode saja" mati, tanpa +/−; Claude tetap +/− dan "Kode saja"', async () => {
      await freshApp();
      page.clearProblems();
      // The server's answers as OpenCode / Claude give them (fetch stubbed only for the three rewind routes).
      await page.eval(async () => {
        window.__rw = [];
        const orig = window.fetch;
        const reply = (obj) => Promise.resolve(new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        window.__pv = { canRewind: true, filesChanged: ['src/a.js', '<img src=x onerror="window.__xss=1">.md'], codeOnly: false, note: 'OpenCode: pesan ini dan semua sesudahnya dihapus <b>x</b>' };
        window.fetch = (url, opts) => {
          const u = String(url);
          if (/\/rewind-points$/.test(u)) return reply({ points: [{ uuid: 'msg_b', text: 'kedua', ts: Date.now() }, { uuid: 'msg_a', text: 'pertama', ts: Date.now() }] });
          if (/\/rewind-preview$/.test(u)) return reply(window.__pv);
          if (/\/rewind$/.test(u)) return (window.__rw.push(JSON.parse(opts.body)), reply({ ok: true, text: 'kedua' }));
          return orig(url, opts);
        };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-list [data-uuid="msg_b"]'), { timeoutMs: 3000, message: 'daftar pesan' });
      await page.eval(() => document.querySelector('#rewind-list [data-uuid="msg_b"]').click());
      await page.waitFor(() => document.querySelector('#rewind-detail .rw-note'), { timeoutMs: 3000, message: 'catatan OpenCode' });
      const oc = await page.eval(() => {
        const box = document.querySelector('#rewind-detail');
        const btn = (k) => box.querySelector(`[data-rw="${k}"]`);
        return { note: box.querySelector('.rw-note').textContent, files: box.querySelectorAll('.rw-files li').length, counts: Boolean(box.querySelector('.add, .del')), both: btn('both').disabled, conv: btn('conversation').disabled, code: btn('code').disabled, codeTitle: btn('code').title };
      });
      assert.match(oc.note, /dihapus <b>x<\/b>/, 'catatan dari server tampil sebagai teks');
      assert.deepEqual([oc.files, oc.counts, oc.both, oc.conv, oc.code], [2, false, false, false, true]);
      assert.match(oc.codeTitle, /bersama percakapannya/);
      await page.eval(() => document.querySelector('#rewind-detail [data-rw="both"]').click());
      await page.waitFor(() => document.querySelector('#rewind-modal').hidden, { timeoutMs: 3000, message: 'modal tertutup' });
      assert.deepEqual(await page.eval(() => window.__rw), [{ uuid: 'msg_b', code: true, conversation: true }]);
      assert.equal(await page.eval(() => document.querySelector('#prompt').value), 'kedua', 'pesan kembali ke kotak untuk diedit');

      // file list unknown (too far back): "Kode & percakapan" asks once more; Batal sends nothing, OK sends it
      await page.eval(async () => {
        document.querySelector('#prompt').value = '';
        window.__rw = [];
        window.__confirms = [];
        window.__answer = false;
        window.confirm = (msg) => (window.__confirms.push(msg), window.__answer);
        window.__pv = { canRewind: true, filesChanged: [], filesUnknown: true, codeOnly: false, note: 'OpenCode' };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-list [data-uuid="msg_b"]'), { timeoutMs: 3000, message: 'daftar pesan (2)' });
      await page.eval(() => document.querySelector('#rewind-list [data-uuid="msg_b"]').click());
      await page.waitFor(() => document.querySelector('#rewind-detail .rw-note') && !document.querySelector('#rewind-detail [data-rw="both"]').disabled, { timeoutMs: 3000, message: 'pratinjau tanpa daftar file' });
      await page.eval(() => document.querySelector('#rewind-detail [data-rw="both"]').click());
      assert.equal(await page.eval(() => window.__confirms.length), 1, 'konfirmasi tambahan');
      assert.match(await page.eval(() => window.__confirms[0]), /Daftar file untuk pesan ini tidak diketahui/);
      assert.deepEqual(await page.eval(() => window.__rw), [], 'Batal: tidak ada rewind');
      await page.eval(() => document.querySelector('#rewind-detail [data-rw="conversation"]').click());
      await page.waitFor(() => document.querySelector('#rewind-modal').hidden, { timeoutMs: 3000, message: 'modal tertutup (percakapan saja)' });
      assert.equal(await page.eval(() => window.__confirms.length), 1, '"Percakapan saja" tidak menyentuh file: tanpa konfirmasi');
      assert.deepEqual(await page.eval(() => window.__rw), [{ uuid: 'msg_b', code: false, conversation: true }]);

      // Claude Code's preview (counts, code only) is unchanged
      await page.eval(async () => {
        document.querySelector('#prompt').value = '';
        window.__pv = { canRewind: true, filesChanged: ['catatan.txt'], insertions: 3, deletions: 1 };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-list [data-uuid="msg_a"]'), { timeoutMs: 3000, message: 'daftar pesan Claude' });
      await page.eval(() => document.querySelector('#rewind-list [data-uuid="msg_a"]').click());
      await page.waitFor(() => document.querySelector('#rewind-detail .add'), { timeoutMs: 3000, message: '+/− Claude' });
      const cl = await page.eval(() => ({ add: document.querySelector('#rewind-detail .add').textContent, note: Boolean(document.querySelector('#rewind-detail .rw-note')), code: document.querySelector('#rewind-detail [data-rw="code"]').disabled }));
      assert.deepEqual(cl, { add: '+3', note: false, code: false });
      await page.eval(async () => (await import('/js/ui/modals.js')).closeModal('rewind-modal'));
      assert.equal(await page.eval(() => window.__xss), undefined);
      assert.deepEqual(realProblems(page), []);
    });

    test('⏪ Redo: entri rewind terakhir, pratinjau file/konflik, centang Timpa mengirim overwrite, toast & refresh Changes', async () => {
      await freshApp();
      page.clearProblems();
      // The server's answers as the redo routes give them (fetch stubbed, only these routes).
      await page.eval(async () => {
        window.__calls = [];
        const orig = window.fetch;
        const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
        const now = Date.now();
        window.fetch = (url, opts) => {
          const u = String(url);
          window.__calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
          if (/\/rewind-points$/.test(u)) return reply({ points: [{ uuid: 'msg_a', text: 'pertama', ts: now }] });
          if (/\/rewind-preview$/.test(u)) return reply({ canRewind: true, filesChanged: ['src/a.js'], insertions: 1, deletions: 0 });
          if (/\/redo-list$/.test(u)) return reply({ bundles: [{ id: 'rb_1', createdAt: now - 3600000, files: ['src/a.js', 'src/b.js'], status: 'ready' }] });
          if (/\/redo-preview$/.test(u))
            return reply({
              id: 'rb_1',
              createdAt: now - 3600000,
              files: [
                { path: 'src/a.js', action: 'restore', conflict: false },
                { path: 'src/b.js', action: 'delete', conflict: true },
              ],
              conflicts: 1,
              unsupported: [],
            });
          if (/\/redo$/.test(u)) return reply({ restored: 2, skipped: 1, deleted: 1, conflicts: 1 });
          return orig(url, opts);
        };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo-recent]'), { timeoutMs: 3000, message: 'entri redo-list di dialog rewind' });
      const entry = await page.eval(() => {
        const b = document.querySelector('#rewind-redo [data-redo-recent]');
        return { id: b.dataset.redoRecent, text: b.textContent.replace(/\s+/g, ' ').trim() };
      });
      assert.equal(entry.id, 'rb_1');
      assert.match(entry.text, /Ulangi rewind terakhir/);
      assert.match(entry.text, /2 file · \S+/, 'jumlah file + waktu pembuatan bundel');

      // Same preview/confirm flow as after a rewind: files, restore/delete markers, conflicts, Timpa checkbox.
      await page.eval(() => document.querySelector('#rewind-redo [data-redo-recent]').click());
      await page.waitFor(() => document.querySelectorAll('#rewind-redo .rw-redo-files li').length === 2, { timeoutMs: 3000, message: 'pratinjau redo tampil' });
      const pv = await page.eval(() => {
        const box = document.querySelector('#rewind-redo');
        return {
          title: document.querySelector('#rewind-redo-title')?.textContent,
          marks: [...box.querySelectorAll('.rw-mk')].map((s) => s.textContent.trim()),
          paths: [...box.querySelectorAll('.rw-path')].map((s) => s.textContent),
          conflict: box.querySelector('.rw-conflict')?.textContent,
          note: box.querySelector('.rw-redo-note')?.textContent,
          checked: box.querySelector('[data-redo-overwrite]').checked,
          cancel: box.querySelector('[data-redo="cancel"]').textContent,
          runDisabled: box.querySelector('[data-redo="run"]').disabled,
        };
      });
      assert.equal(pv.title, '↩ Ulangi perubahan (redo)');
      assert.deepEqual(pv.marks, ['↩ kembalikan', '✕ hapus']);
      assert.deepEqual(pv.paths, ['src/a.js', 'src/b.js']);
      assert.match(pv.conflict, /bentrok/);
      assert.match(pv.note, /belum di-commit/);
      assert.match(pv.note, /percakapan tidak berubah/);
      assert.match(pv.note, /Cadangan rewind tetap disimpan/);
      assert.deepEqual([pv.checked, pv.cancel, pv.runDisabled], [false, 'Batal', false]);

      // Unchecked: the redo body names the bundle only. Checked: overwrite proves the user opted into clobbering.
      await page.eval(() => document.querySelector('#rewind-redo [data-redo-overwrite]').click());
      await page.eval(() => document.querySelector('#rewind-redo [data-redo="run"]').click());
      await page.waitFor(() => document.querySelector('#rewind-modal').hidden, { timeoutMs: 3000, message: 'dialog tertutup setelah redo' });
      const redoCall = await page.eval(() => window.__calls.filter((c) => /\/redo$/.test(c.url)).at(-1));
      assert.deepEqual(redoCall.body, { id: 'rb_1', overwrite: true });
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /^2 file dikembalikan, 1 dilewati\.$/.test(t.textContent)), { timeoutMs: 2000, message: 'toast hasil redo' });
      await page.waitFor(() => window.__calls.some((c) => /\/changes$/.test(c.url)), { timeoutMs: 3000, message: 'Changes dimuat ulang setelah redo' });
      assert.deepEqual(realProblems(page), []);
    });

    test('⏪ Redo: rewind kode yang mengembalikan bundel membiarkan dialog terbuka; Batal menutup tanpa redo', async () => {
      await freshApp();
      page.clearProblems();
      await page.eval(async () => {
        window.__calls = [];
        const orig = window.fetch;
        const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
        const now = Date.now();
        window.fetch = (url, opts) => {
          const u = String(url);
          window.__calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
          if (/\/rewind-points$/.test(u)) return reply({ points: [{ uuid: 'msg_a', text: 'pertama', ts: now }] });
          if (/\/rewind-preview$/.test(u)) return reply({ canRewind: true, filesChanged: ['src/a.js'], insertions: 1, deletions: 0 });
          if (/\/redo-list$/.test(u)) return reply({ bundles: [] });
          if (/\/redo-preview$/.test(u))
            return reply({ id: 'rb_new', createdAt: now, files: [{ path: 'src/a.js', action: 'restore', conflict: false }], conflicts: 0, unsupported: [] });
          if (/\/rewind$/.test(u)) return reply({ ok: true, text: '', redo: { id: 'rb_new', files: ['src/a.js'] } });
          return orig(url, opts);
        };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-list [data-uuid="msg_a"]'), { timeoutMs: 3000, message: 'daftar pesan' });
      await page.eval(() => document.querySelector('#rewind-list [data-uuid="msg_a"]').click());
      await page.waitFor(() => document.querySelector('#rewind-detail [data-rw="code"]') && !document.querySelector('#rewind-detail [data-rw="code"]').disabled, { timeoutMs: 3000, message: 'tombol Kode saja siap' });
      await page.eval(() => document.querySelector('#rewind-detail [data-rw="code"]').click());
      await page.waitFor(() => !document.querySelector('#rewind-modal').hidden && document.querySelector('#rewind-redo-title'), { timeoutMs: 3000, message: 'bagian redo dari bundel rewind' });
      const after = await page.eval(() => ({
        open: !document.querySelector('#rewind-modal').hidden,
        files: [...document.querySelectorAll('#rewind-redo .rw-path')].map((s) => s.textContent),
        marks: [...document.querySelectorAll('#rewind-redo .rw-mk')].map((s) => s.textContent.trim()),
        cancel: document.querySelector('#rewind-redo [data-redo="cancel"]').textContent,
        run: document.querySelector('#rewind-redo [data-redo="run"]').textContent,
        redoCalls: window.__calls.filter((c) => /\/redo$/.test(c.url)).length,
      }));
      assert.deepEqual(after.files, ['src/a.js'], 'file dari bundel rewind tampil di bagian redo');
      assert.deepEqual(after.marks, ['↩ kembalikan']);
      assert.deepEqual([after.open, after.cancel, after.run, after.redoCalls], [true, 'Batal', '↩ Ulangi', 0]);

      // Batal closes the dialog and sends nothing: redo is an offer, never automatic.
      await page.eval(() => document.querySelector('#rewind-redo [data-redo="cancel"]').click());
      await page.waitFor(() => document.querySelector('#rewind-modal').hidden, { timeoutMs: 2000, message: 'dialog tertutup lewat Batal' });
      assert.equal(await page.eval(() => window.__calls.filter((c) => /\/redo$/.test(c.url)).length), 0);
      assert.deepEqual(realProblems(page), []);
    });

    test('⏪ Redo: 409 rewind kode dan 409 redo tampil inline, tanpa retry otomatis', async () => {
      await freshApp();
      page.clearProblems();
      await page.eval(async () => {
        window.__calls = [];
        const orig = window.fetch;
        const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
        const now = Date.now();
        window.fetch = (url, opts) => {
          const u = String(url);
          window.__calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
          if (/\/rewind-points$/.test(u)) return reply({ points: [{ uuid: 'msg_a', text: 'pertama', ts: now }] });
          if (/\/rewind-preview$/.test(u)) return reply({ canRewind: true, filesChanged: ['src/a.js'] });
          if (/\/redo-list$/.test(u)) return reply({ bundles: [{ id: 'rb_1', createdAt: now - 60000, files: ['src/a.js'], status: 'ready' }] });
          if (/\/redo-preview$/.test(u)) return reply({ id: 'rb_1', createdAt: now - 60000, files: [{ path: 'src/a.js', action: 'restore', conflict: false }], conflicts: 0, unsupported: [] });
          if (/\/redo$/.test(u)) return reply({ error: 'File src/a.js sudah kamu ubah sejak rewind. Centang “Timpa” untuk melanjutkan.' }, 409);
          if (/\/rewind$/.test(u)) return reply({ error: 'Bukan repository git: rewind kode hanya tersedia di repo git.' }, 409);
          return orig(url, opts);
        };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-list [data-uuid="msg_a"]'), { timeoutMs: 3000, message: 'daftar pesan' });
      await page.eval(() => document.querySelector('#rewind-list [data-uuid="msg_a"]').click());
      await page.waitFor(() => document.querySelector('#rewind-detail [data-rw="code"]') && !document.querySelector('#rewind-detail [data-rw="code"]').disabled, { timeoutMs: 3000, message: 'tombol Kode saja siap' });
      await page.eval(() => document.querySelector('#rewind-detail [data-rw="code"]').click());
      await page.waitFor(() => /Bukan repository git/.test(document.querySelector('#rewind-error').textContent), { timeoutMs: 3000, message: '409 rewind inline' });
      const rw409 = await page.eval(() => ({
        open: !document.querySelector('#rewind-modal').hidden,
        error: document.querySelector('#rewind-error').textContent,
        retryDisabled: document.querySelector('#rewind-detail [data-rw="code"]').disabled,
        calls: window.__calls.filter((c) => /\/rewind$/.test(c.url)).length,
      }));
      assert.equal(rw409.open, true, 'dialog tetap terbuka');
      assert.match(rw409.error, /Bukan repository git/);
      assert.equal(rw409.retryDisabled, false, 'tombol bisa dicoba lagi oleh user');
      assert.equal(rw409.calls, 1, 'tidak ada retry otomatis');
      await sleep(300);
      assert.equal(await page.eval(() => window.__calls.filter((c) => /\/rewind$/.test(c.url)).length), 1);

      // Close and reopen: the recent bundle is offered, and a 409 from redo also stays inline.
      await page.eval(() => document.querySelector('#rewind-modal [data-close]').click());
      await page.eval(async () => (await import('/js/features/rewind.js')).openRewind());
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo-recent]'), { timeoutMs: 3000, message: 'entri redo-list setelah buka ulang' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo-recent]').click());
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo="run"]') && !document.querySelector('#rewind-redo [data-redo="run"]').disabled, { timeoutMs: 3000, message: 'pratinjau redo siap' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo="run"]').click());
      await page.waitFor(() => /Centang “Timpa”/.test(document.querySelector('#rewind-redo .rw-redo-error')?.textContent ?? ''), { timeoutMs: 3000, message: '409 redo inline' });
      const redo409 = await page.eval(() => ({
        open: !document.querySelector('#rewind-modal').hidden,
        runDisabled: document.querySelector('#rewind-redo [data-redo="run"]').disabled,
        calls: window.__calls.filter((c) => /\/redo$/.test(c.url)).length,
      }));
      assert.equal(redo409.open, true, 'dialog tetap terbuka');
      assert.equal(redo409.runDisabled, false, 'tombol Ulangi aktif lagi');
      assert.equal(redo409.calls, 1, 'tidak ada retry otomatis');
      await sleep(300);
      assert.equal(await page.eval(() => window.__calls.filter((c) => /\/redo$/.test(c.url)).length), 1);
      assert.deepEqual(realProblems(page), []);
    });

    test('⏪ Redo: tanpa scroll horizontal di 390px (path panjang, konflik, tombol bernama)', { skip: !vp.mobile }, async () => {
      await freshApp();
      page.clearProblems();
      await page.eval(async () => {
        const orig = window.fetch;
        const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
        const long = `src/${'folder-yang-sangat-panjang/'.repeat(8)}berkas-dengan-nama-panjang.js`;
        const now = Date.now();
        window.fetch = (url, opts) => {
          const u = String(url);
          if (/\/rewind-points$/.test(u)) return reply({ points: [] });
          if (/\/redo-list$/.test(u)) return reply({ bundles: [{ id: 'rb_long', createdAt: now, files: [long], status: 'ready' }] });
          if (/\/redo-preview$/.test(u)) return reply({ id: 'rb_long', createdAt: now, files: [{ path: long, action: 'delete', conflict: true }], conflicts: 1, unsupported: [] });
          return orig(url, opts);
        };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo-recent]'), { timeoutMs: 3000, message: 'entri redo-list' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo-recent]').click());
      await page.waitFor(() => document.querySelector('#rewind-redo .rw-redo-overwrite'), { timeoutMs: 3000, message: 'pratinjau dengan konflik' });
      assert.equal(await page.eval(horizontalOverflow), null, 'dialog redo tidak membuat overflow');
      assert.equal(
        await page.eval(() => [...document.querySelectorAll('#rewind-redo, #rewind-redo *')].every((el) => el.scrollWidth <= el.clientWidth + 1)),
        true,
        'tidak ada isi dialog yang lebih lebar dari kotaknya',
      );
      assert.deepEqual(await page.eval(unnamedButtons, '#rewind-redo'), [], 'tombol redo punya nama aksesibel');
      assert.deepEqual(realProblems(page), []);
    });

    test('⏪ Pulihkan percakapan: blok tampil untuk Claude & OpenCode dengan teks dan tombol sekunder yang tepat', async () => {
      await freshApp();
      page.clearProblems();
      await page.eval(async () => {
        window.__calls = [];
        window.__conv = { engine: 'claude', sessionId: 'c1a2b3c4-1111-2222-3333-444455556666', title: 'Rapikan checkout', available: true };
        const orig = window.fetch;
        const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
        const now = Date.now();
        window.fetch = (url, opts) => {
          const u = String(url);
          window.__calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
          if (/\/rewind-points$/.test(u)) return reply({ points: [] });
          if (/\/redo-list$/.test(u)) return reply({ bundles: [{ id: 'rb_conv', createdAt: now, files: ['src/a.js'], status: 'ready', conversation: window.__conv }] });
          if (/\/redo-preview$/.test(u))
            return reply({ id: 'rb_conv', createdAt: now, files: [{ path: 'src/a.js', action: 'restore', conflict: false }], conflicts: 0, unsupported: [], conversation: window.__conv });
          return orig(url, opts);
        };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo-recent]'), { timeoutMs: 3000, message: 'entri redo-list' });
      assert.match(await page.eval(() => document.querySelector('#rewind-redo [data-redo-recent]').textContent), /1 file \+ percakapan/, 'entri menyebut percakapan yang bisa dipulihkan');

      await page.eval(() => document.querySelector('#rewind-redo [data-redo-recent]').click());
      await page.waitFor(() => /transkrip tidak dihapus/.test(document.querySelector('#rewind-redo .rw-redo-conv-note')?.textContent ?? ''), { timeoutMs: 3000, message: 'blok percakapan Claude' });
      const claude = await page.eval(() => {
        const box = document.querySelector('#rewind-redo');
        const btn = box.querySelector('[data-redo="conversation"]');
        return {
          heading: box.querySelector('#rw-redo-conv-title')?.textContent,
          note: box.querySelector('.rw-redo-conv-note')?.textContent,
          session: box.querySelector('.rw-redo-conv-session')?.textContent,
          label: btn?.textContent.trim(),
          primary: btn?.classList.contains('primary'),
          described: btn?.getAttribute('aria-describedby'),
          disabled: btn?.disabled,
          files: [...box.querySelectorAll('.rw-path')].map((s) => s.textContent),
        };
      });
      assert.equal(claude.heading, '🔄 Pulihkan percakapan');
      assert.equal(claude.note, 'Percakapan kembali ke posisi terakhir (transkrip tidak dihapus).');
      assert.match(claude.session, /Rapikan checkout/);
      assert.deepEqual([claude.label, claude.primary, claude.described, claude.disabled], ['Pulihkan percakapan', false, 'rw-redo-conv-note', false], 'tombol sekunder, bernama, dan dijelaskan oleh catatan mesin');
      assert.deepEqual(claude.files, ['src/a.js'], 'daftar file kode tetap seperti sebelumnya');

      // OpenCode: the same bundle says the restore is a COPY, in a new session.
      await page.eval(async () => {
        window.__conv = { engine: 'opencode', sessionId: 'ses_lama', title: 'Sesi OpenCode', available: true };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo-recent]'), { timeoutMs: 3000, message: 'entri redo-list (2)' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo-recent]').click());
      await page.waitFor(() => /SALINAN/.test(document.querySelector('#rewind-redo .rw-redo-conv-note')?.textContent ?? ''), { timeoutMs: 3000, message: 'blok percakapan OpenCode' });
      assert.equal(
        await page.eval(() => document.querySelector('#rewind-redo .rw-redo-conv-note').textContent),
        'Percakapan dipulihkan sebagai SALINAN (sesi baru); sesi lama yang terhapus tidak kembali.',
      );
      assert.equal(await page.eval(() => window.__calls.filter((c) => /\/redo-conversation$/.test(c.url)).length), 0, 'menampilkan blok tidak memulihkan apa pun');
      assert.deepEqual(realProblems(page), []);
    });

    test('⏪ Pulihkan percakapan: Batal di konfirmasi tidak mengirim apa pun', async () => {
      await freshApp();
      page.clearProblems();
      await page.eval(async () => {
        window.__calls = [];
        window.__confirms = [];
        window.__answer = false;
        window.confirm = (msg) => (window.__confirms.push(msg), window.__answer);
        const orig = window.fetch;
        const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
        const now = Date.now();
        const conv = { engine: 'claude', sessionId: 'c1a2b3c4-1111-2222-3333-444455556666', title: 'Rapikan checkout', available: true };
        window.fetch = (url, opts) => {
          const u = String(url);
          window.__calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
          if (/\/rewind-points$/.test(u)) return reply({ points: [] });
          if (/\/redo-list$/.test(u)) return reply({ bundles: [{ id: 'rb_conv', createdAt: now, files: ['src/a.js'], status: 'ready', conversation: conv }] });
          if (/\/redo-preview$/.test(u)) return reply({ id: 'rb_conv', createdAt: now, files: [{ path: 'src/a.js', action: 'restore', conflict: false }], conflicts: 0, unsupported: [], conversation: conv });
          if (/\/redo-conversation$/.test(u)) return reply({ ok: true, engine: 'claude' });
          return orig(url, opts);
        };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo-recent]'), { timeoutMs: 3000, message: 'entri redo-list' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo-recent]').click());
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo="conversation"]') && !document.querySelector('#rewind-redo [data-redo="conversation"]').disabled, { timeoutMs: 3000, message: 'tombol Pulihkan percakapan siap' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo="conversation"]').click());
      await sleep(250);
      const after = await page.eval(() => ({
        calls: window.__calls.filter((c) => /\/redo-conversation$/.test(c.url)).length,
        open: !document.querySelector('#rewind-modal').hidden,
        disabled: document.querySelector('#rewind-redo [data-redo="conversation"]').disabled,
        confirms: window.__confirms,
      }));
      assert.equal(after.calls, 0, 'Batal: tidak ada permintaan');
      assert.equal(after.open, true, 'dialog tetap terbuka');
      assert.equal(after.disabled, false, 'tombol tetap bisa dipakai');
      assert.equal(after.confirms.length, 1);
      assert.match(after.confirms[0], /Rapikan checkout/, 'konfirmasi menyebut sesinya');
      assert.match(after.confirms[0], /transkrip tidak dihapus/, 'konfirmasi menjelaskan efek khas Claude Code');
      assert.deepEqual(realProblems(page), []);
    });

    test('⏪ Pulihkan percakapan: konfirmasi mengirim {id} ke redo-conversation, toast (dengan sesi baru untuk OpenCode), dialog tertutup', async () => {
      await freshApp();
      page.clearProblems();
      await page.eval(async () => {
        window.__calls = [];
        window.__confirms = [];
        window.__answer = true;
        window.confirm = (msg) => (window.__confirms.push(msg), window.__answer);
        window.__conv = { engine: 'opencode', sessionId: 'ses_lama', title: 'Sesi OpenCode', available: true };
        window.__resp = { ok: true, engine: 'opencode', sessionId: 'ses_baru' };
        const orig = window.fetch;
        const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
        const now = Date.now();
        window.fetch = (url, opts) => {
          const u = String(url);
          window.__calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
          if (/\/rewind-points$/.test(u)) return reply({ points: [] });
          if (/\/redo-list$/.test(u)) return reply({ bundles: [{ id: 'rb_conv', createdAt: now, files: ['src/a.js'], status: 'ready', conversation: window.__conv }] });
          if (/\/redo-preview$/.test(u)) return reply({ id: 'rb_conv', createdAt: now, files: [{ path: 'src/a.js', action: 'restore', conflict: false }], conflicts: 0, unsupported: [], conversation: window.__conv });
          if (/\/redo-conversation$/.test(u)) return reply(window.__resp);
          return orig(url, opts);
        };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo-recent]'), { timeoutMs: 3000, message: 'entri redo-list' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo-recent]').click());
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo="conversation"]') && !document.querySelector('#rewind-redo [data-redo="conversation"]').disabled, { timeoutMs: 3000, message: 'tombol Pulihkan percakapan siap' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo="conversation"]').click());
      await page.waitFor(() => document.querySelector('#rewind-modal').hidden, { timeoutMs: 3000, message: 'dialog tertutup setelah pemulihan' });
      const sent = await page.eval(() => window.__calls.filter((c) => /\/redo-conversation$/.test(c.url)).at(-1));
      assert.deepEqual(sent.body, { id: 'rb_conv' }, 'hanya id bundel yang dikirim');
      assert.match(await page.eval(() => window.__confirms[0]), /SALINAN \(sesi baru\)/, 'konfirmasi menjelaskan efek khas OpenCode');
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent === 'Percakapan dipulihkan. Sesi baru: ses_baru'), { timeoutMs: 2000, message: 'toast percakapan + sesi baru' });

      // Claude Code: the same call, a toast without a new session.
      await page.eval(async () => {
        window.__conv = { engine: 'claude', sessionId: 'c1a2b3c4-1111-2222-3333-444455556666', title: 'Sesi Claude', available: true };
        window.__resp = { ok: true, engine: 'claude' };
        window.__calls = [];
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo-recent]'), { timeoutMs: 3000, message: 'entri redo-list (2)' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo-recent]').click());
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo="conversation"]') && !document.querySelector('#rewind-redo [data-redo="conversation"]').disabled, { timeoutMs: 3000, message: 'tombol Pulihkan percakapan siap (2)' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo="conversation"]').click());
      await page.waitFor(() => document.querySelector('#rewind-modal').hidden, { timeoutMs: 3000, message: 'dialog tertutup (Claude)' });
      assert.deepEqual(await page.eval(() => window.__calls.filter((c) => /\/redo-conversation$/.test(c.url)).map((c) => c.body)), [{ id: 'rb_conv' }]);
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent === 'Percakapan dipulihkan.'), { timeoutMs: 2000, message: 'toast Claude tanpa sesi baru' });
      assert.deepEqual(realProblems(page), []);
    });

    test('⏪ Pulihkan percakapan: 502 tampil inline di area error redo, tanpa retry otomatis', async () => {
      await freshApp();
      page.clearProblems();
      await page.eval(async () => {
        window.__calls = [];
        window.confirm = () => true;
        const orig = window.fetch;
        const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
        const now = Date.now();
        const conv = { engine: 'opencode', sessionId: 'ses_lama', title: 'Sesi OpenCode', available: true };
        window.fetch = (url, opts) => {
          const u = String(url);
          window.__calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
          if (/\/rewind-points$/.test(u)) return reply({ points: [] });
          if (/\/redo-list$/.test(u)) return reply({ bundles: [{ id: 'rb_conv', createdAt: now, files: ['src/a.js'], status: 'ready', conversation: conv }] });
          if (/\/redo-preview$/.test(u)) return reply({ id: 'rb_conv', createdAt: now, files: [{ path: 'src/a.js', action: 'restore', conflict: false }], conflicts: 0, unsupported: [], conversation: conv });
          if (/\/redo-conversation$/.test(u)) return reply({ error: 'Import percakapan gagal: sesi OpenCode tidak bisa diimpor.' }, 502);
          return orig(url, opts);
        };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo-recent]'), { timeoutMs: 3000, message: 'entri redo-list' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo-recent]').click());
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo="conversation"]') && !document.querySelector('#rewind-redo [data-redo="conversation"]').disabled, { timeoutMs: 3000, message: 'tombol Pulihkan percakapan siap' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo="conversation"]').click());
      await page.waitFor(() => /Import percakapan gagal/.test(document.querySelector('#rewind-redo .rw-redo-error')?.textContent ?? ''), { timeoutMs: 3000, message: '502 inline di area error redo' });
      const failed = await page.eval(() => ({
        open: !document.querySelector('#rewind-modal').hidden,
        error: document.querySelector('#rewind-redo .rw-redo-error').textContent,
        role: document.querySelector('#rewind-redo .rw-redo-error').getAttribute('role'),
        conv: Boolean(document.querySelector('#rewind-redo .rw-redo-conv')),
        disabled: document.querySelector('#rewind-redo [data-redo="conversation"]').disabled,
        calls: window.__calls.filter((c) => /\/redo-conversation$/.test(c.url)).length,
      }));
      assert.equal(failed.open, true, 'dialog tetap terbuka');
      assert.equal(failed.error, 'Import percakapan gagal: sesi OpenCode tidak bisa diimpor.');
      assert.equal(failed.role, 'alert', 'pesan dibacakan sebagai peringatan');
      assert.equal(failed.conv, true, 'blok percakapan tetap tampil');
      assert.equal(failed.disabled, false, 'tombol bisa dicoba lagi oleh user');
      assert.equal(failed.calls, 1);
      await sleep(400);
      assert.equal(await page.eval(() => window.__calls.filter((c) => /\/redo-conversation$/.test(c.url)).length), 1, 'tidak ada retry otomatis');
      assert.deepEqual(realProblems(page), []);
    });

    test('⏪ Pulihkan percakapan: rewind percakapan saja (file 0) tetap menampilkan bagian redo, tanpa daftar file', async () => {
      await freshApp();
      page.clearProblems();
      await page.eval(async () => {
        window.__calls = [];
        const orig = window.fetch;
        const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
        const now = Date.now();
        window.fetch = (url, opts) => {
          const u = String(url);
          window.__calls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
          if (/\/rewind-points$/.test(u)) return reply({ points: [{ uuid: 'msg_a', text: 'pertama', ts: now }] });
          if (/\/rewind-preview$/.test(u)) return reply({ canRewind: true, filesChanged: ['src/a.js'], insertions: 1, deletions: 0 });
          if (/\/redo-list$/.test(u)) return reply({ bundles: [] });
          if (/\/rewind$/.test(u)) return reply({ ok: true, text: '', redo: { id: 'rd_conv', files: [], conversation: true } });
          if (/\/redo-preview$/.test(u))
            return reply({ id: 'rd_conv', createdAt: now, files: [], conversation: { engine: 'opencode', sessionId: 'ses_a', title: 'Sesi A', available: true } });
          return orig(url, opts);
        };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-list [data-uuid="msg_a"]'), { timeoutMs: 3000, message: 'daftar pesan' });
      await page.eval(() => document.querySelector('#rewind-list [data-uuid="msg_a"]').click());
      await page.waitFor(() => document.querySelector('#rewind-detail [data-rw="conversation"]') && !document.querySelector('#rewind-detail [data-rw="both"]').disabled, { timeoutMs: 3000, message: 'pratinjau siap' });
      await page.eval(() => document.querySelector('#rewind-detail [data-rw="conversation"]').click());
      await page.waitFor(
        () => /SALINAN \(sesi baru\)/.test(document.querySelector('#rewind-redo .rw-redo-conv-note')?.textContent ?? ''),
        { timeoutMs: 3000, message: 'bagian redo dengan blok percakapan' },
      );
      const after = await page.eval(() => {
        const box = document.querySelector('#rewind-redo');
        return {
          open: !document.querySelector('#rewind-modal').hidden,
          files: box.querySelectorAll('.rw-redo-files').length,
          run: Boolean(box.querySelector('[data-redo="run"]')),
          conv: box.querySelector('.rw-redo-conv-note')?.textContent,
          empty: /Tidak ada file kode/.test(box.textContent),
          rewind: window.__calls.filter((c) => /\/rewind$/.test(c.url)).at(-1)?.body,
        };
      });
      assert.deepEqual(after.rewind, { uuid: 'msg_a', code: false, conversation: true }, 'rewind percakapan saja');
      assert.equal(after.open, true, 'dialog tetap terbuka: redo masih ditawarkan');
      assert.equal(after.files, 0, 'tanpa daftar file saat file 0');
      assert.equal(after.run, false, 'tanpa tombol Ulangi kode yang tidak ada');
      assert.equal(after.empty, false, 'tanpa pesan "tidak ada file" saat percakapan bisa dipulihkan');
      assert.match(after.conv, /SALINAN \(sesi baru\)/, 'blok percakapan tetap tampil');
      assert.deepEqual(realProblems(page), []);
    });

    test('⏪ Pulihkan percakapan: tanpa scroll horizontal di 390px (judul sesi panjang, tombol bernama)', { skip: !vp.mobile }, async () => {
      await freshApp();
      page.clearProblems();
      await page.eval(async () => {
        const orig = window.fetch;
        const reply = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }));
        const long = `Sesi ${'dengan-judul-yang-sangat-panjang '.repeat(6)}sekali`;
        const now = Date.now();
        const conv = { engine: 'opencode', sessionId: `ses_${'a'.repeat(90)}`, title: long, available: true };
        window.fetch = (url, opts) => {
          const u = String(url);
          if (/\/rewind-points$/.test(u)) return reply({ points: [] });
          if (/\/redo-list$/.test(u)) return reply({ bundles: [{ id: 'rb_long', createdAt: now, files: ['src/a.js'], status: 'ready', conversation: conv }] });
          if (/\/redo-preview$/.test(u))
            return reply({ id: 'rb_long', createdAt: now, files: [{ path: 'src/a.js', action: 'restore', conflict: false }], conflicts: 0, unsupported: [], conversation: conv });
          return orig(url, opts);
        };
        (await import('/js/features/rewind.js')).openRewind();
      });
      await page.waitFor(() => document.querySelector('#rewind-redo [data-redo-recent]'), { timeoutMs: 3000, message: 'entri redo-list' });
      await page.eval(() => document.querySelector('#rewind-redo [data-redo-recent]').click());
      await page.waitFor(() => document.querySelector('#rewind-redo .rw-redo-conv-session'), { timeoutMs: 3000, message: 'blok percakapan' });
      assert.equal(await page.eval(horizontalOverflow), null, 'dialog redo tidak membuat overflow');
      assert.equal(
        await page.eval(() => [...document.querySelectorAll('#rewind-redo, #rewind-redo *')].every((el) => el.scrollWidth <= el.clientWidth + 1)),
        true,
        'tidak ada isi dialog yang lebih lebar dari kotaknya',
      );
      assert.deepEqual(await page.eval(unnamedButtons, '#rewind-redo'), [], 'tombol redo dan Pulihkan percakapan punya nama aksesibel');
      assert.deepEqual(realProblems(page), []);
    });

    test('🎤 hasil final yang datang setelah pindah project tidak masuk ke kotak pesan project lain', async (t) => {
      await freshApp();
      const dir = path.join(TMP, vp.mobile ? 'kasir-hp' : 'kasir-laptop'); // outside the projects root: only this test sees it
      mkdirSync(dir, { recursive: true });
      const other = await page.eval(async (d) => {
        const token = document.querySelector('meta[name="office-token"]').content;
        const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify({ path: d }) });
        return (await r.json()).id;
      }, dir);
      assert.ok(other, 'project kedua dibuat');
      t.after(() => forgetTempProject(other));
      page.clearProblems();
      await page.eval(stubSpeech);
      await page.eval(async () => (await import('/js/features/voice.js')).renderVoice());
      await typeInPrompt(page, 'draf toko');
      await page.eval(() => document.querySelector('#btn-voice').click());
      await page.eval(() => window.__speak('masih', false));
      await page.eval(async (id) => (await import('/js/features/picker.js')).selectProject(id), other);
      await page.waitFor(() => document.querySelector('#btn-voice').getAttribute('aria-pressed') === 'false' && document.querySelector('#voice-live').textContent === '', { timeoutMs: 2000, message: 'pindah project menghentikan rekaman' });
      assert.equal(await page.eval(() => window.__rec.stopped), true);
      await page.eval(() => window.__speak('kata terlambat', true)); // the engine delivers the last words after stop
      assert.doesNotMatch(await page.eval(() => document.querySelector('#prompt').value), /kata terlambat/, 'tidak masuk ke project lain');
      await page.eval(async (id) => (await import('/js/features/picker.js')).selectProject(id), projectId);
      assert.doesNotMatch(await page.eval(() => document.querySelector('#prompt').value), /kata terlambat/);
      assert.deepEqual(realProblems(page), []);
    });

    test('🔔 jam tenang tidak valid saat diaktifkan: saklar kembali mati, jam tetap bisa diperbaiki', async () => {
      await freshApp({ 'office.notify': '1' });
      page.clearProblems();
      await page.eval(async () => (await import('/js/features/notify.js')).openNotifySettings());
      const ui = () =>
        page.eval(() => ({
          checked: document.querySelector('#ns-quiet').checked,
          error: document.querySelector('#ns-quiet-error').textContent !== '',
          timesEnabled: !document.querySelector('#ns-from').disabled && !document.querySelector('#ns-to').disabled,
          stored: JSON.parse(localStorage.getItem('office.notifySettings') ?? 'null')?.quiet?.enabled ?? false,
        }));
      const change = (sel, value) =>
        page.eval(
          (s, v) => {
            const el = document.querySelector(s);
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          },
          sel,
          value,
        );
      await page.eval(() => document.querySelector('#ns-quiet').click()); // on with the default 22:00–07:00
      await change('#ns-to', '22:00'); // same as the start: refused, stays on with the stored times
      assert.deepEqual(await ui(), { checked: true, error: true, timesEnabled: true, stored: true });
      await page.eval(() => document.querySelector('#ns-quiet').click()); // off: no validation, saved off
      assert.deepEqual(await ui(), { checked: false, error: false, timesEnabled: false, stored: false });
      await page.eval(() => document.querySelector('#ns-quiet').click()); // on again with 22:00–22:00: refused
      assert.deepEqual(await ui(), { checked: false, error: true, timesEnabled: true, stored: false }, 'saklar kembali mati, jam bisa diperbaiki');
      await change('#ns-to', '06:00');
      await page.eval(() => document.querySelector('#ns-quiet').click());
      assert.deepEqual(await ui(), { checked: true, error: false, timesEnabled: true, stored: true });
      await page.press('Escape');
      assert.deepEqual(realProblems(page), []);
    });

    if (!vp.mobile) {
      test('🔔 tekan lama (sentuh) membuka pengaturan tanpa ikut mematikan; ketuk singkat tetap on/off', async () => {
        await freshApp({ 'office.notify': '1' });
        page.clearProblems();
        await page.eval(stubSoundAndNotifications);
        const pointer = (type) =>
          page.eval((t) => {
            const btn = document.querySelector('#btn-notify');
            const r = btn.getBoundingClientRect();
            btn.dispatchEvent(new PointerEvent(t, { pointerType: 'touch', clientX: r.left + 5, clientY: r.top + 5, bubbles: true }));
          }, type);
        await pointer('pointerdown');
        await sleep(650);
        assert.equal(await page.eval(() => document.querySelector('#notify-modal').hidden), false, 'tekan lama membuka dialog');
        await pointer('pointerup');
        await page.eval(() => document.querySelector('#btn-notify').click()); // the click that ends the press
        assert.equal(await page.eval(() => localStorage.getItem('office.notify')), '1', '🔔 tetap aktif');
        await page.press('Escape');
        await pointer('pointerdown');
        await sleep(80);
        await pointer('pointerup');
        await page.eval(() => document.querySelector('#btn-notify').click());
        await page.waitFor(() => localStorage.getItem('office.notify') === '0', { timeoutMs: 2000, message: 'ketuk singkat mematikan 🔔' });
        assert.equal(await page.eval(() => document.querySelector('#notify-modal').hidden), true);
        assert.deepEqual(realProblems(page), []);
      });
    }
  });
}

// ---------- 🗂 Semua project (features/dashboard.js): every project at once, live, read-only ----------

describe('UI 🗂 Semua project', { skip: SKIP ?? false }, () => {
  let api;
  const ids = {};
  const SHOTS = process.env.OFFICE_UI_SHOTS;

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
    const token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
    api = (p, body = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(body) }).then((r) => r.json());
    for (const name of ['gudang', 'kasir']) mkdirSync(path.join(TMP, 'projects', name), { recursive: true });
    await api('/api/projects/refresh');
    const snap = await untilSnapshot((s) => ['gudang', 'kasir'].every((n) => s.projects.some((p) => p.name === n)), 'project gudang & kasir terdaftar');
    for (const name of ['gudang', 'kasir']) ids[name] = snap.projects.find((p) => p.name === name).id;
    // gudang: a permission card waiting for the user (fake Claude asks before writing a file).
    await api(`/api/projects/${ids.gudang}/prompt`, { text: 'minta izin tulis file <b>penting</b>' });
    await untilSnapshot((s) => s.approvals.some((a) => a.project === ids.gudang && a.status === 'pending'), 'izin gudang menunggu');
  });

  after(async () => {
    if (!api) return;
    const snap = await snapshot().catch(() => null);
    for (const a of snap?.approvals ?? []) if (a.status === 'pending') await api(`/api/approvals/${a.id}`, { allow: false }).catch(() => {});
    if (ids.kasir) await api(`/api/projects/${ids.kasir}/stop`).catch(() => {});
  });

  /** kasir: a turn that is still running (fake Claude streams "lama" for ~10 s). */
  async function startRunningTurn() {
    const snap = await snapshot();
    if (!snap.statuses[ids.kasir]?.busy) await api(`/api/projects/${ids.kasir}/prompt`, { text: 'jawab lama' });
  }

  async function openDashboardLikeUser(page, vp) {
    if (vp.mobile) {
      await page.click('#mobile-nav button[data-view="office"]');
      await page.click('#dash-bar');
    } else {
      await page.click('#btn-dashboard');
    }
    await page.waitFor(() => !document.querySelector('#dash-modal').hidden && document.querySelectorAll('#dash-list > li').length > 0, { timeoutMs: 3000, message: 'dialog Semua project terbuka berisi kartu' });
  }

  function cards() {
    return [...document.querySelectorAll('#dash-list > li')]
      .filter((li) => !li.hidden)
      .map((li) => ({ id: li.dataset.id, cls: li.className, pill: li.querySelector('.dash-pill')?.textContent.trim(), text: li.textContent, approval: Boolean(li.querySelector('[data-dash-approval]')) }));
  }

  for (const vp of VIEWPORTS) {
    describe(vp.name, () => {
      let page;
      before(async () => {
        if (SKIP) return;
        page = await browser.newPage();
        await page.setViewport(vp);
      });
      after(async () => page?.close());

      test('kartu per project, urutan izin → bekerja → idle, update di tempat, tanpa overflow/tombol tanpa nama/error console', async () => {
        await openApp(page, `#${projectId}`);
        await startRunningTurn();
        await openDashboardLikeUser(page, vp);
        await page.waitFor(
          (g, k) => {
            const get = (id) => document.querySelector(`#dash-list > li[data-id="${id}"]`)?.className ?? '';
            return get(g).includes('k-ask') && get(k).includes('k-busy');
          },
          { timeoutMs: 8000, message: 'kartu gudang (izin) dan kasir (bekerja)' },
          ids.gudang,
          ids.kasir,
        );
        const list = await page.eval(cards);
        assert.deepEqual(list.slice(0, 2).map((c) => c.id), [ids.gudang, ids.kasir], 'izin dulu, lalu yang bekerja');
        assert.ok(list.some((c) => c.id === projectId), 'project toko ada');
        assert.equal(list.at(-1).id, 'demo', 'demo paling bawah');
        assert.equal(list[0].pill, '✋ Butuh izin (1)');
        assert.match(list[0].text, /Menunggu: /);
        assert.equal(list[0].approval, true, 'tombol Lihat izin');
        assert.match(list[0].text, /Kamu: minta izin tulis file <b>penting<\/b>/, 'potongan prompt tampil sebagai teks (di-escape)');
        assert.equal(await page.eval(() => document.querySelectorAll('#dash-list .dash-snip b').length), 0, 'tidak ada HTML dari prompt');
        assert.equal(list[1].pill, '⏳ Bekerja');
        assert.match(await page.eval(() => document.querySelector('#dash-summary').textContent), /1 butuh kamu · 1 bekerja/);
        // In place: the cards survive the running turn's events (no full re-render).
        await page.eval(() => document.querySelectorAll('#dash-list > li').forEach((li) => (li.__kept = true)));
        await sleep(1200);
        assert.equal(await page.eval(() => [...document.querySelectorAll('#dash-list > li')].every((li) => li.__kept)), true, 'kartu tidak dibuat ulang');
        assert.equal(await page.eval(horizontalOverflow), null);
        assert.deepEqual(await page.eval(unnamedButtons, '#dash-modal'), []);
        assert.equal(await page.eval(() => document.querySelector('#dash-list').getAttribute('aria-label')), 'Status semua project');
        assert.equal(await page.eval(() => document.querySelector('#dash-live').getAttribute('aria-live')), 'polite');
        if (SHOTS) writeFileSync(path.join(SHOTS, `dashboard-${vp.mobile ? 'mobile' : 'desktop'}.png`), await page.screenshot());
        assert.deepEqual(realProblems(page), []);
      });

      test('ketuk kartu → pindah project dan lompat ke kartu izin', async () => {
        // The dialog the previous test left open is reused; alone (or after another test) it is opened here.
        if (!(await page.eval(() => Boolean(document.querySelector('#dash-modal') && !document.querySelector('#dash-modal').hidden)).catch(() => false))) {
          await ensureApp(page, `#${projectId}`);
          await openDashboardLikeUser(page, vp);
        }
        await page.waitFor((g) => document.querySelector(`#dash-list > li[data-id="${g}"] .dash-open`), { timeoutMs: 8000, message: 'kartu gudang' }, ids.gudang);
        await page.click(`#dash-list > li[data-id="${ids.gudang}"] .dash-open`);
        await page.waitFor((g) => document.querySelector('#dash-modal').hidden && location.hash.slice(1) === g, { timeoutMs: 3000, message: 'pindah ke gudang' }, ids.gudang);
        const r = await page.waitFor(
          () => {
            const el = document.activeElement;
            return el?.matches?.('#chat > .approval.pending') ? { view: document.body.dataset.view, tab: document.body.dataset.tab } : null;
          },
          { timeoutMs: 3000, message: 'fokus di kartu izin' },
        );
        assert.deepEqual(r, { view: 'panel', tab: 'chat' });
        if (vp.mobile) assert.equal(await page.eval(() => document.querySelector('#mobile-nav button[data-view="chat"]').classList.contains('active')), true);
        if (SHOTS) writeFileSync(path.join(SHOTS, `dashboard-izin-${vp.mobile ? 'mobile' : 'desktop'}.png`), await page.screenshot());
        assert.deepEqual(realProblems(page), []);
      });

      test('Ctrl+P "Semua project", saring, /dashboard dan 🗂 di pemilih project membuka dialog yang sama', async () => {
        await ensureApp(page, `#${projectId}`);
        await page.click(vp.mobile ? '#nav-palette' : '#btn-palette');
        await page.waitFor(() => !document.querySelector('#palette-modal').hidden, { timeoutMs: 2000, message: 'palet terbuka' });
        await page.send('Input.insertText', { text: 'Semua project' });
        await page.waitFor(() => document.querySelector('#palette-list .pal-opt.active')?.textContent.includes('Semua project'), { timeoutMs: 2000, message: 'aksi Semua project di atas' });
        await page.press('Enter');
        await page.waitFor(() => !document.querySelector('#dash-modal').hidden, { timeoutMs: 2000, message: 'dialog dari palet' });
        await page.eval(() => {
          const input = document.querySelector('#dash-search');
          input.value = '';
          input.focus();
        });
        await page.send('Input.insertText', { text: 'GUD' });
        assert.deepEqual((await page.eval(cards)).map((c) => c.id), [ids.gudang], 'saring nama');
        await page.send('Input.insertText', { text: 'zzz' });
        assert.match(await page.eval(() => document.querySelector('#dash-empty:not([hidden])')?.textContent ?? ''), /Tidak ada project yang cocok/);
        await page.press('Escape');
        await page.waitFor(() => document.querySelector('#dash-modal').hidden, { timeoutMs: 2000, message: 'Esc menutup' });
        const viaSlash = await page.eval(async () => {
          const { localCommand } = await import('/js/features/commands.js');
          const input = document.querySelector('#dash-search');
          input.value = '';
          input.dispatchEvent(new Event('input'));
          return localCommand('/dashboard') && !document.querySelector('#dash-modal').hidden;
        });
        assert.equal(viaSlash, true, '/dashboard');
        await page.press('Escape');
        await page.click('#crumb');
        await page.click('#project-dash');
        await page.waitFor(() => !document.querySelector('#dash-modal').hidden && document.querySelector('#project-modal').hidden, { timeoutMs: 2000, message: '🗂 dari pemilih project' });
        await page.press('Escape');
        assert.deepEqual(realProblems(page), []);
      });

      test('hanya-lihat (WiFi): dialog tetap bisa dibuka, Lihat izin aktif (hanya navigasi)', async () => {
        await ensureApp(page, `#${projectId}`);
        const r = await page.eval(async (g) => {
          const { state } = await import('/js/core/state.js');
          const { openDashboard } = await import('/js/features/dashboard.js');
          state.readOnly = true;
          openDashboard();
          const btn = document.querySelector(`#dash-list > li[data-id="${g}"] [data-dash-approval]`);
          const out = { open: !document.querySelector('#dash-modal').hidden, enabled: btn ? !btn.disabled : null };
          state.readOnly = false;
          return out;
        }, ids.gudang);
        assert.deepEqual(r, { open: true, enabled: true });
        await page.press('Escape');
        assert.deepEqual(realProblems(page), []);
      });
    });
  }
});
