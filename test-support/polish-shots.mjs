// Design-polish evidence shots: boots the repo's own server (fake Claude + fake ACP OpenCode, throwaway data)
// and drives the real UI over CDP at desktop 1440x900 and phone 390x844, light AND dark appearance.
//   node test-support/polish-shots.mjs %TEMP%\polish-before
// (office-shots.mjs pattern; OFFICE_APP_DIR is stripped so the repo copy is what runs)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
  { name: 'mobile-land', width: 844, height: 390, mobile: true, only: ['turn-settings', 'ladder'] },
];
const APPEARANCES = ['light', 'dark'];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer(tmp, port) {
  mkdirSync(path.join(tmp, 'projects', 'toko'), { recursive: true });
  mkdirSync(path.join(tmp, 'claude-projects'), { recursive: true });
  const env = { ...process.env };
  // the office session leaks OFFICE_APP_DIR (and friends) — this server must exercise the repo
  for (const key of ['OFFICE_APP_DIR', 'OFFICE_PORT', 'OFFICE_HTTPS_PORT', 'OFFICE_DATA_DIR', 'PROJECTS_ROOT', 'CLAUDE_BIN', 'CLAUDE_PROJECTS_DIR', 'CLAUDE_CONFIG_FILE', 'CLAUDE_CONFIG_DIR', 'OPENCODE_BIN']) delete env[key];
  const server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: {
      ...env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(tmp, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(tmp, 'no-tailscale.exe'),
      PROJECTS_ROOT: path.join(tmp, 'projects'),
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(tmp, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(tmp, 'no-such-claude.json'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000',
      OFFICE_OPENCODE_CHECK_DELAY_MS: '600000',
      OFFICE_OPEN_DRY_RUN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 20000);
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && (clearTimeout(timer), resolve()));
    server.on('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}`))));
  });
  server.stderr.resume();
  return server;
}

// ---------- fakes in the page (opencode-custom-ui.test.mjs pattern) ----------


/** Rich OpenCode data so the Akun tab renders every section (providers, usage cards, Go console, requests). */
function installFakes() {
  const stamp = (offsetMin) => new Date(Date.now() + offsetMin * 60_000).toISOString();
  const real = window.fetch.bind(window);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, opts = {}) => {
    const endpoint = String(url);
    if (endpoint === '/api/opencode/providers') {
      return json({
        connected: [
          { id: 'opencode-zen', name: 'OpenCode Zen', connections: [{ id: 'cred-zen', type: 'credential', label: 'OpenCode Go', method: 'oauth' }] },
          { id: 'anthropic', name: 'Anthropic', connections: [{ id: 'cred-anthropic', type: 'credential', label: 'Claude Pro', method: 'oauth' }] },
          { id: 'river', name: 'River AI', custom: true, edit: { baseURL: 'https://api.river.ai/v1', models: ['river-large', 'river-mini'] }, connections: [{ id: 'cred-river', type: 'credential', label: 'API key', method: 'key' }] },
        ],
        available: [
          { id: 'opencode-zen', name: 'OpenCode Zen', methods: [{ id: 'oauth', type: 'oauth', label: 'Login browser' }, { id: 'key', type: 'key', label: 'API key' }] },
          { id: 'anthropic', name: 'Anthropic', methods: [{ id: 'oauth', type: 'oauth', label: 'Login browser' }] },
          { id: 'github-copilot', name: 'GitHub Copilot', methods: [{ id: 'oauth', type: 'oauth', label: 'Login browser' }] },
        ],
        usage: {
          today: { total: 148000, inputTokens: 90000, outputTokens: 22000, cacheReadTokens: 34000, cacheWriteTokens: 2000, requests: 41, costUsd: 0.31 },
          week: { total: 912000, inputTokens: 610000, outputTokens: 150000, cacheReadTokens: 140000, cacheWriteTokens: 12000, requests: 260, costUsd: 1.94, costCoverage: 0.86 },
        },
        go: {
          available: true,
          plan: 'go',
          source: 'console',
          console: {
            product: 'OpenCode Go',
            activeUntil: stamp(60 * 24 * 9),
            fetchedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
            usage: {
              today: { tokens: 148000, inputTokens: 90000, outputTokens: 22000, cacheReadTokens: 34000, cacheWriteTokens: 2000, requests: 41, costUsd: 0.31, models: [{ model: 'qwen3-coder', provider: 'opencode', requests: 30, inputTokens: 60000, cacheReadTokens: 20000, outputTokens: 15000, costUsd: 0.2 }, { model: 'claude-sonnet-4', provider: 'anthropic', requests: 11, inputTokens: 30000, cacheReadTokens: 14000, outputTokens: 7000, costUsd: 0.11 }] },
              week: { tokens: 912000, inputTokens: 610000, outputTokens: 150000, cacheReadTokens: 140000, cacheWriteTokens: 12000, requests: 260, costUsd: 1.94 },
            },
            meters: [
              { key: 'fiveHour', percent: 0.42, resetsAt: stamp(150) },
              { key: 'week', percent: 0.61, resetsAt: stamp(60 * 24 * 2) },
              { key: 'month', percent: 0.28, resetsAt: stamp(60 * 24 * 9) },
            ],
          },
        },
      });
    }
    if (endpoint === '/api/opencode/requests') {
      return json({
        requests: Array.from({ length: 8 }, (_, i) => ({ at: Date.now() - i * 90_000, model: i % 2 ? 'qwen3-coder' : 'claude-sonnet-4', app: i % 3 ? 'desktop' : 'web', ms: 800 + i * 120, ttft: 300 + i * 40, tokens: 1200 + i * 300, costUsd: 0.01 + i * 0.002, status: i === 5 ? 'error' : 'ok' })),
        total: 260,
      });
    }
    if (endpoint.endsWith('/task-detail')) {
      return json({ found: true, prompt: 'Uji ulang modul pembayaran dan laporkan hasilnya.', steps: [
        { ts: Date.now() - 70_000, type: 'tool', tool: 'Bash', label: 'npm test -- payment', detail: '12 passing', status: 'ok' },
        { ts: Date.now() - 40_000, type: 'tool', tool: 'Read', label: 'src/payment/retry.ts', detail: '', status: 'ok' },
        { ts: Date.now() - 12_000, type: 'text', text: 'Retry masih mengirim ulang dua kali saat timeout; sedang menyiapkan perbaikan.' },
      ], result: null, truncated: false });
    }
    if (endpoint.endsWith('/task-output')) {
      return json({ output: 'vite v6 ready in 320 ms\n➜ Local: http://localhost:5173/\n', truncated: false });
    }
    return real(url, opts);
  };
  return true;
}

const shown = (page, sel) => page.eval((s) => Boolean(document.querySelector(s)?.getClientRects().length), sel);

/** Realistic live/done tasks + a finished turn with background work, rendered by the app itself (evidence for the
 *  live-vs-done polish): the rows above the monitor come from state.statuses[..].tasks, the chat rows from state.chats. */
function injectTaskRows() {
  return (async () => {
    const { state } = await import('/js/core/state.js');
    const now = Date.now();
    state.statuses[state.active] = {
      ...state.statuses[state.active],
      tasks: [
        { id: 'bg-1', kind: 'agent', role: 'backend', status: 'running', background: true, startedAt: now - 95_000, description: 'Uji regresi modul pembayaran', tokens: 4200, toolUses: 3 },
        { id: 'bg-2', kind: 'agent', role: 'qa', status: 'running', background: true, startedAt: now - 40_000, description: 'Cek ulang pesan error checkout', tokens: 900, toolUses: 1 },
        { id: 'done-1', kind: 'agent', role: 'writer', status: 'completed', startedAt: now - 260_000, endedAt: now - 45_000, description: 'Rapikan README bagian instalasi', tokens: 1200, toolUses: 2, summary: 'README dirapikan; 3 langkah diubah.' },
        { id: 'done-2', kind: 'shell', status: 'failed', startedAt: now - 200_000, endedAt: now - 190_000, command: 'npm run lint', description: 'npm run lint' },
      ],
    };
    const tasks = await import('/js/features/tasks.js');
    tasks.openTasks();
    await new Promise((r) => setTimeout(r, 600));
    return true;
  })();
}

function injectChatRows() {
  return (async () => {
    const { state } = await import('/js/core/state.js');
    const now = Date.now();
    const chats = (state.chats[state.active] ??= []);
    chats.push(
      { id: 'pol-dlg', kind: 'delegate', role: 'backend', from: 'claude', text: 'Uji regresi modul pembayaran', status: 'running', elapsed: 95, ts: now - 95_000 },
      { id: 'pol-dlg2', kind: 'delegate', role: 'writer', from: 'claude', text: 'Rapikan README bagian instalasi', status: 'ok', output: 'README dirapikan; 3 langkah diubah.', ts: now - 45_000 },
      { id: 'pol-res', kind: 'result', ok: true, meta: { durationMs: 182_000, turns: 6, tokensIn: 41_000, tokensOut: 5200 } },
    );
    const chat = await import('/js/features/chat.js');
    chat.renderChat();
    await new Promise((r) => setTimeout(r, 300));
    const box = document.querySelector('#chat');
    box.scrollTop = box.scrollHeight;
    return true;
  })();
}

async function settle(page, sel) {
  await page.waitFor((s) => document.querySelector(s)?.getClientRects().length, { timeoutMs: 4000, message: sel }, sel);
  await sleep(250); // sheets animate in
}

/** Clicks `sel` like a user: directly when on screen, else through the phone ⋯ sheet route; a header button that is
 *  desktop-hidden (⋯ menu instead) still gets its real listener via a JS click (fine for screenshots). */
async function tap(page, sel) {
  const route = { '#btn-account': ['#btn-head-more', '#head-more-modal [data-proxy="#btn-account"]'], '#btn-notify': ['#btn-head-more', '#head-more-modal [data-proxy="#btn-notify-settings"]'], '#btn-phone': ['#btn-head-more', '#head-more-modal [data-proxy="#btn-phone"]'], '#btn-sessions': ['#btn-head-more', '#head-more-modal [data-proxy="#btn-sessions"]'] }[sel];
  if ((await shown(page, sel)) || !route || !(await shown(page, route[0]))) {
    try {
      return await page.click(sel);
    } catch {
      // desktop-hidden header buttons keep their listeners: the real opener may be another element
      const opener = { '#btn-notify': '#btn-notify-settings' }[sel] ?? sel;
      return page.eval((s) => document.querySelector(s)?.click(), opener);
    }
  }
  for (const step of route) {
    await settle(page, step);
    await page.click(step);
  }
}

async function closeModals(page) {
  for (let i = 0; i < 4 && (await page.eval(() => [...document.querySelectorAll('.modal')].some((m) => !m.hidden))); i++) {
    await page.press('Escape');
    await sleep(200);
  }
}

async function setSelect(page, sel, value) {
  await page.eval(
    (s, v) => {
      const el = document.querySelector(s);
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    sel,
    value,
  );
  await sleep(350);
}

const shot = async (page, dir, name) => writeFileSync(path.join(dir, name), await page.screenshot());

// ---------- one viewport × appearance pass ----------

let only = null; // a viewport can limit the pass to a few surfaces (e.g. landscape phone: ⚙ only)
const want = (name) => !only || only.includes(name);

const step = async (name, fn) => {
  if (!want(name) && name !== 'pilih project') return;
  try {
    await fn();
  } catch (err) {
    throw new Error(`[${name}] ${err.message}`);
  }
};

async function capture(page, { name: vp, width, height, mobile, only: onlyList }, look, dir) {
  only = onlyList ?? null;
  await page.setViewport({ width, height, mobile });
  await page.goto('about:blank');
  await page.goto(`${BASE}/`);
  await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000 });
  await page.eval((t) => localStorage.setItem('office.appTheme', t), look);
  await page.goto(`${BASE}/`);
  await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000 });
  await page.eval(installFakes);
  if (mobile) {
    await page.click('#mobile-nav button[data-view="office"]');
    await sleep(600);
    await page.click('#mobile-nav button[data-view="chat"]');
    await sleep(400);
  }
  await sleep(800);
  const prefix = `${vp}-${look}`;

  // Activate the real project (not Demo kantor) so the composer and ⚙ chip are live.
  await step('pilih project', async () => {
    await page.click('#crumb');
    await settle(page, '#project-list li');
    await page.eval(() => {
      [...document.querySelectorAll('#project-list li[data-id]')].find((li) => li.textContent.includes('toko'))?.click();
    });
    await sleep(600);
  });

  // 👤 Akun — Claude tab
  await step('akun-claude', async () => {
    await tap(page, '#btn-account');
    await settle(page, '#account-modal #account-body');
    await sleep(700); // account + quota load
    await shot(page, dir, `${prefix}-1-akun-claude.png`);
  });

  // 👤 Akun — OpenCode tab (＋ Login provider flow, usage, Go console, requests)
  await step('akun-opencode', async () => {
    await setSelect(page, '#acct-tab', 'opencode');
    await page.waitFor(() => document.querySelector('#acct-panel')?.textContent.includes('Provider OpenCode'), { timeoutMs: 4000, message: 'tab OpenCode' });
    await sleep(600);
    await shot(page, dir, `${prefix}-2-akun-opencode.png`);
  });
  await step('akun-oc-pick', async () => {
    await page.click('#acct-panel [data-act="oc-pick"]');
    await sleep(300);
    await shot(page, dir, `${prefix}-3-akun-oc-login-pick.png`);
    await setSelect(page, '#oc-provider', 'opencode-zen');
    await sleep(300);
    await shot(page, dir, `${prefix}-4-akun-oc-login-method.png`);
  });
  // requests drawer (the dialog is still open from the pick step; close its login flow first)
  await step('akun-oc-requests', async () => {
    const closeBtn = await page.eval(() => Boolean(document.querySelector('#acct-panel [data-act="oc-close"]')));
    if (closeBtn) {
      await page.click('#acct-panel [data-act="oc-close"]');
      await sleep(300);
    }
    await page.waitFor(() => document.querySelector('#acct-panel')?.textContent.includes('Request'), { timeoutMs: 4000, message: 'bagian request' });
    await page.click('#acct-panel [data-oc-requests]');
    await sleep(700);
    await shot(page, dir, `${prefix}-5-akun-oc-requests.png`);
  });
  // audit section
  await step('akun-audit', async () => {
    const hasAudit = await page.eval(() => Boolean(document.querySelector('#account-body [data-act="audit-toggle"]')));
    if (!hasAudit) return;
    await page.click('#account-body [data-act="audit-toggle"]');
    await sleep(800);
    await shot(page, dir, `${prefix}-6-akun-audit.png`);
  });
  await closeModals(page);

  // ⚙ Pengaturan giliran (engine OpenCode) — desktop modal / phone sheet
  await step('turn-settings', async () => {
    await page.click('#settings-chip');
    await settle(page, '#turn-settings-modal .controls');
    await sleep(700); // model list loads
    await shot(page, dir, `${prefix}-7-turn-settings.png`);
  });
  // "Atur tangga…" ladder dialog
  await step('ladder', async () => {
    if (!(await shown(page, '#model-tiers-open'))) return;
    await page.click('#model-tiers-open');
    await settle(page, '#model-tiers-modal .tiers-rows');
    await shot(page, dir, `${prefix}-8-ladder.png`);
    await page.press('Escape');
    await sleep(200);
  });
  await closeModals(page);

  // 🕘 Riwayat sesi
  await step('sessions', async () => {
    await tap(page, '#btn-sessions');
    await settle(page, '#sessions-modal');
    await sleep(500);
    await shot(page, dir, `${prefix}-9-sessions.png`);
    await closeModals(page);
  });

  // 🔔 Pengaturan notifikasi
  await step('notify', async () => {
    await tap(page, '#btn-notify');
    await settle(page, '#notify-modal');
    await shot(page, dir, `${prefix}-10-notify.png`);
    await closeModals(page);
  });

  // 📱 Buka dari HP
  await step('phone', async () => {
    await tap(page, '#btn-phone');
    await settle(page, '#phone-modal');
    await sleep(600);
    await shot(page, dir, `${prefix}-11-phone.png`);
    await closeModals(page);
  });

  // ⧗ Monitor tugas: baris live (⏱ + spinner) vs selesai (✓/✗/■, tanpa spinner) + badge "⏳ masih bekerja"
  await step('tasks', async () => {
    await page.eval(injectTaskRows);
    await settle(page, '#tasks-list [data-task]');
    await sleep(400);
    await shot(page, dir, `${prefix}-12-tasks.png`);
    await closeModals(page);
  });

  // Baris tugas di chat: delegate live (⏱ + spinner), delegate selesai (✓), result + badge latar
  await step('chat-rows', async () => {
    await page.eval(injectChatRows);
    await sleep(500);
    await shot(page, dir, `${prefix}-13-chat-rows.png`);
    await closeModals(page);
  });
}

let BASE;
const outDir = path.resolve(process.argv[2] ?? path.join(tmpdir(), 'polish-shots'));
mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(path.join(tmpdir(), 'polish-shots-data-'));
const port = await freePort();
BASE = `http://localhost:${port}`;
const server = await startServer(tmp, port);

// Switch the project to the OpenCode engine once, so ⚙ / agent row render for real (read via the page's state:
// /api/projects is not a GET endpoint — projects arrive in the initial state snapshot).
const browser = await launchBrowser();
let switched = 'belum dicoba';
try {
  const page0 = await browser.newPage();
  await page0.setViewport({ width: 800, height: 600, mobile: false });
  await page0.goto(`${BASE}/`);
  await page0.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000 });
  switched = await page0.eval(async () => {
    const { state, auth } = await import('/js/core/state.js');
    const ids = (state.projects ?? []).map((p) => `${p.id}(${p.name})`).join(', ');
    const p = (state.projects ?? []).find((x) => x.id && x.id !== 'demo') ?? (state.projects ?? [])[0];
    if (!p?.id) return `project tidak ada di state (${ids})`;
    const res = await fetch(`/api/projects/${p.id}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Office-Token': auth.token },
      body: JSON.stringify({ engine: 'opencode' }),
    });
    return `${ids} -> ${res.status} ${await res.text()}`;
  });
  await page0.close();
} catch (err) {
  switched = `gagal: ${err.message}`;
}
console.log('engine switch:', switched);
try {
  for (const look of APPEARANCES) {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage();
      await capture(page, vp, look, outDir).catch(async (err) => {
        console.error(`GAGAL ${vp.name}-${look}:`, err.message);
        writeFileSync(path.join(outDir, `${vp.name}-${look}-FAILED.png`), await page.screenshot().catch(() => Buffer.alloc(0)));
      });
      await page.close();
    }
  }
  console.log(`PNG ditulis ke ${outDir}`);
} finally {
  await browser.close().catch(() => {});
  server.kill();
  await sleep(400);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
