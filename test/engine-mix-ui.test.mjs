/* global document, window -- functions passed to page.eval run in the browser */
// The engine follows the model: ONE model list (Claude Code + OpenCode), no project engine switch anywhere, and the
// two engines' messages in one timeline with a faint ✳/▢ mark where the engine changes.
// A real server with the fake CLIs in headless Chrome/Edge; skipped when no browser is found.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';
import { projectId as projectIdOf } from '../src/util.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let TMP;
let BASE;
let server;
let browser;
let projectId;

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

const appReady = () => {
  const conn = document.querySelector('#conn');
  return conn?.classList.contains('ok') && document.querySelector('#crumb')?.textContent.trim().length > 0;
};

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-engine-mix-ui-'));
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko'), { recursive: true });
  writeFileSync(path.join(projects, 'toko', 'README.md'), '# toko\n');
  mkdirSync(path.join(TMP, 'claude-projects'));
  mkdirSync(path.join(TMP, 'acp-store'));
  // One timeline, two engines' stores: Claude speaks first, then OpenCode. Seeded BEFORE the server starts: the hub
  // reads each store once at boot and the snapshot tags/merges them (src/hub.js openChats/timeline).
  const seededId = projectIdOf(path.join(projects, 'toko'));
  const base = Date.now() - 60_000;
  const line = (m) => JSON.stringify(m);
  const chats = path.join(TMP, 'data', 'chats');
  const chatsOpen = path.join(TMP, 'data', 'chats-opencode');
  mkdirSync(chats, { recursive: true });
  mkdirSync(chatsOpen, { recursive: true });
  writeFileSync(
    path.join(chats, `${seededId}.jsonl`),
    `${[
      { id: 'mix-a1', kind: 'user', text: 'halo dari Claude', source: 'web', ts: base },
      { id: 'mix-a2', kind: 'assistant', text: 'jawaban Claude', ts: base + 1000 },
    ].map(line).join('\n')}\n`,
  );
  writeFileSync(
    path.join(chatsOpen, `${seededId}.jsonl`),
    `${[
      { id: 'mix-b1', kind: 'user', text: 'halo dari OpenCode', source: 'web', ts: base + 2000 },
      { id: 'mix-b2', kind: 'assistant', text: 'jawaban OpenCode', ts: base + 3000 },
    ].map(line).join('\n')}\n`,
  );
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
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      FAKE_ACP_STORE: path.join(TMP, 'acp-store'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
      OFFICE_OPENCODE_CONFIG_HOME: path.join(TMP, 'xdg'),
      OFFICE_OPEN_DRY_RUN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  server.stderr.resume();
  projectId = (await snapshot()).projects.find((p) => p.name === 'toko').id;
  assert.equal(projectId, seededId, 'the seeded chat files belong to the project listed by the server');
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  server?.kill();
  await sleep(400);
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('mesin mengikuti model', { skip: SKIP ?? false }, () => {
  test('satu daftar model: dua optgroup mesin, memilih model OpenCode mengirim {engine, model}', async () => {
    const page = await browser.newPage({ width: 1440, height: 900, mobile: false });
    try {
      page.clearProblems();
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(appReady, { timeoutMs: 10000, message: 'app ready' });
      await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        // The Claude catalog may still be empty on a fresh project: the picker falls back to config.models.
        state.config = {
          ...state.config,
          engine: 'claude',
          models: [
            { value: 'default', displayName: 'Default', description: 'bawaan' },
            { value: 'sonnet', displayName: 'Sonnet', description: 'Serbaguna' },
          ],
        };
        state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), engine: 'claude', model: '', modelAuto: false, busy: false, pending: 0, queue: 0, interrupted: false, rewinding: false };
        (await import('/js/features/engine.js')).wantModels(state.active); // the picker asks for the list when it opens
        document.querySelector('#model-search').dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitFor(() => [...document.querySelectorAll('#model optgroup')].some((g) => g.label === 'Claude Code') && [...document.querySelectorAll('#model optgroup')].some((g) => g.label === 'OpenCode') && Boolean(document.querySelector('#model option[data-engine="opencode"]')), { timeoutMs: 15000, message: 'dua optgroup mesin' });

      const groups = await page.eval(() => [...document.querySelectorAll('#model optgroup')].map((g) => g.label));
      assert.ok(groups.includes('Claude Code'), `grup Claude Code ada: ${groups.join(' | ')}`);
      assert.ok(groups.includes('OpenCode'), `grup OpenCode ada: ${groups.join(' | ')}`);
      const engines = await page.eval(() => [...document.querySelectorAll('#model option')].filter((o) => o.dataset.engine).map((o) => o.dataset.engine));
      assert.ok(engines.includes('claude') && engines.includes('opencode'), 'setiap option membawa data-engine');
      assert.ok(await page.eval(() => [...document.querySelectorAll('#model option[data-engine="claude"]')].some((o) => o.value && o.value !== 'auto')), 'model Claude dari katalog ikut');

      // Capture the next settings POST: picking an OpenCode model must send engine+model in ONE request.
      await page.eval(() => {
        window.__officeFetch ??= window.fetch;
        const prev = window.fetch;
        window.__mixBodies = [];
        window.fetch = (url, opts) => {
          if (/\/api\/projects\/[^/]+\/settings$/.test(String(url)) && String(opts?.method ?? '').toUpperCase() === 'POST') {
            window.__mixBodies.push(JSON.parse(opts.body ?? '{}'));
            return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
          return prev(url, opts);
        };
      });
      const picked = await page.eval(() => {
        const opt = [...document.querySelectorAll('#model option[data-engine="opencode"]')].find((o) => o.value && !o.disabled);
        const select = document.querySelector('#model');
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return opt.value;
      });
      await page.waitFor(() => window.__mixBodies.length === 1, { timeoutMs: 3000, message: 'satu request settings' });
      const bodies = await page.eval(() => window.__mixBodies);
      assert.deepEqual(bodies, [{ engine: 'opencode', model: picked, modelAuto: false }], 'satu request dengan engine+model');
      assert.deepEqual(page.problems, [], 'tanpa error console');
    } finally {
      await page.eval(() => {
        if (window.__officeFetch) window.fetch = window.__officeFetch;
        delete window.__officeFetch;
        delete window.__mixBodies;
      }).catch(() => {});
      await page.close();
    }
  });

  test('model mesin lain nonaktif selagi project bekerja, dengan alasan yang jelas', async () => {
    const page = await browser.newPage({ width: 1440, height: 900, mobile: false });
    try {
      page.clearProblems();
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(appReady, { timeoutMs: 10000, message: 'app ready' });
      await page.eval(async () => {
        const { state } = await import('/js/core/state.js');
        state.config = { ...state.config, engine: 'claude', models: [{ value: 'sonnet', displayName: 'Sonnet', description: 'Serbaguna' }] };
        state.statuses[state.active] = { ...(state.statuses[state.active] ?? {}), engine: 'claude', busy: true, model: '', modelAuto: false };
        const { wantModels } = await import('/js/features/engine.js');
        wantModels(state.active); // the list is fetched when the picker is opened (the chip does this for a user)
        (await import('/js/features/composer.js')).renderComposer();
      });
      await page.waitFor(() => [...document.querySelectorAll('#model option[data-engine="opencode"]')].length > 0, { timeoutMs: 8000, message: 'daftar OpenCode' });
      const view = await page.eval(() => ({
        opencode: [...document.querySelectorAll('#model option[data-engine="opencode"]')].map((o) => ({ disabled: o.disabled, title: o.title })),
        claude: [...document.querySelectorAll('#model option[data-engine="claude"]')].map((o) => o.disabled),
      }));
      assert.ok(view.opencode.every((o) => o.disabled), 'model mesin lain nonaktif saat sibuk');
      assert.ok(view.opencode.every((o) => o.title === 'Tunggu giliran ini selesai'), 'title menjelaskan alasannya');
      assert.ok(view.claude.every((disabled) => !disabled), 'model mesin yang sama tetap bisa dipilih');
      assert.deepEqual(page.problems, [], 'tanpa error console');
    } finally {
      await page.close();
    }
  });

  test('picker project tanpa badge mesin', async () => {
    const page = await browser.newPage({ width: 1440, height: 900, mobile: false });
    try {
      page.clearProblems();
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(appReady, { timeoutMs: 10000, message: 'app ready' });
      const view = await page.eval((id) => {
        const row = document.querySelector(`#project-list li[data-id="${id}"]`);
        return {
          badge: row?.querySelector('.engine-badge')?.textContent ?? null,
          engineTag: row?.querySelector('[data-engine]')?.outerHTML ?? null,
          header: document.querySelector('#sb-engine')?.textContent ?? null,
        };
      }, projectId);
      assert.equal(view.badge, null, 'baris picker tanpa badge mesin');
      assert.equal(view.engineTag, null, 'tidak ada data-engine di baris picker');
      assert.match(view.header, /Claude|OpenCode/, 'header sesi tetap menyebut mesin yang berjalan');
      assert.deepEqual(page.problems, [], 'tanpa error console');
    } finally {
      await page.close();
    }
  });

  test('modal Akun: dua tab info, tanpa memanggil /api/engine', async () => {
    const page = await browser.newPage({ width: 1440, height: 900, mobile: false });
    try {
      page.clearProblems();
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(appReady, { timeoutMs: 10000, message: 'app ready' });
      await page.eval(() => {
        window.localStorage.removeItem('office.accountTab');
        window.__officeFetch ??= window.fetch;
        const prev = window.fetch;
        window.__acctEngineCalls = 0;
        window.fetch = (url, opts) => {
          if (String(url) === '/api/engine') window.__acctEngineCalls += 1;
          if (String(url) === '/api/opencode/providers') {
            return Promise.resolve(new Response(JSON.stringify({ connected: [{ id: 'anthropic', name: 'Anthropic', connections: [{ id: 'cred-1', type: 'credential', label: 'Claude Pro', method: 'oauth' }] }], available: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
          return prev(url, opts);
        };
      });
      await page.eval(() => document.querySelector('#btn-account').click());
      await page.waitFor(() => !document.querySelector('#account-modal').hidden && document.querySelectorAll('#account-body [data-act="acct-tab"]').length === 2, { timeoutMs: 5000, message: 'dua tab Akun' });
      const first = await page.eval(() => ({
        tabs: [...document.querySelectorAll('#account-body [data-act="acct-tab"]')].map((b) => [b.dataset.tab, b.getAttribute('aria-selected')]),
        switch: Boolean(document.querySelector('#account-body .engine-switch')),
        engineButtons: document.querySelectorAll('#account-body [data-act="engine"]').length,
        title: document.querySelector('#account-title').textContent,
      }));
      assert.deepEqual(first.tabs, [['claude', 'true'], ['opencode', 'false']], 'tab default Claude');
      assert.equal(first.title, '👤 Akun');
      assert.equal(first.switch, false);
      assert.equal(first.engineButtons, 0, 'tidak ada tombol "Jadikan mesin bawaan"');

      await page.eval(() => document.querySelector('#account-body [data-act="acct-tab"][data-tab="opencode"]').click());
      await page.waitFor(() => document.querySelector('#acct-tab-opencode')?.getAttribute('aria-selected') === 'true', { timeoutMs: 3000, message: 'tab OpenCode' });
      await page.waitFor(() => /Provider OpenCode/.test(document.querySelector('#acct-panel')?.textContent ?? ''), { timeoutMs: 6000, message: 'isi OpenCode' });
      await page.eval(() => document.querySelector('#account-body [data-act="acct-tab"][data-tab="claude"]').click());
      await page.waitFor(() => document.querySelector('#acct-tab-claude')?.getAttribute('aria-selected') === 'true', { timeoutMs: 3000, message: 'tab Claude' });
      assert.equal(await page.eval(() => window.__acctEngineCalls), 0, 'tab tidak memanggil /api/engine');
      assert.deepEqual(page.problems, [], 'tanpa error console');
    } finally {
      await page.eval(() => {
        window.localStorage.removeItem('office.accountTab');
        if (window.__officeFetch) window.fetch = window.__officeFetch;
        delete window.__officeFetch;
        delete window.__acctEngineCalls;
      }).catch(() => {});
      await page.close();
    }
  });

  test('timeline satu alur: dua mesin berurutan, badge hanya saat mesin berubah', async () => {
    const page = await browser.newPage({ width: 1440, height: 900, mobile: false });
    try {
      page.clearProblems();
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(appReady, { timeoutMs: 10000, message: 'app ready' });
      await page.waitFor(() => document.querySelectorAll('#chat [data-id]').length >= 4, { timeoutMs: 10000, message: 'timeline dirender' });
      const view = await page.eval(() => ({
        texts: [...document.querySelectorAll('#chat [data-id]')].map((n) => n.textContent).join(' | '),
        marks: [...document.querySelectorAll('#chat .engine-mark')].map((n) => ({ mark: n.textContent, title: n.title, engine: n.dataset.engine })),
        rows: [...document.querySelectorAll('#chat [data-id]')].map((n) => n.dataset.id),
      }));
      assert.match(view.texts, /halo dari Claude/);
      assert.match(view.texts, /halo dari OpenCode/, 'kedua mesin tampil dalam satu alur');
      assert.deepEqual(view.rows.slice(0, 4), ['mix-a1', 'mix-a2', 'mix-b1', 'mix-b2'], 'urutan timeline apa adanya');
      assert.deepEqual(view.marks, [
        { mark: '✳', title: 'Claude Code', engine: 'claude' },
        { mark: '▢', title: 'OpenCode', engine: 'opencode' },
      ], 'badge hanya pada pesan pertama dan saat mesin berubah');

      // A duplicated chat event (snapshot + stream) updates the row instead of adding a second one.
      const dedupe = await page.eval(async (id) => {
        const { mergeChatMessage } = await import('/js/core/stream.js');
        const { state } = await import('/js/core/state.js');
        const before = state.chats[id].length;
        const msg = { id: 'mix-a1', project: id, kind: 'user', text: 'halo dari Claude', ts: Date.now(), engine: 'claude' };
        mergeChatMessage(msg);
        mergeChatMessage({ ...msg });
        return { before, after: state.chats[id].length };
      }, projectId);
      assert.deepEqual(dedupe, { before: 4, after: 4 }, 'id yang sama tidak menggandakan pesan');
      assert.deepEqual(page.problems, [], 'tanpa error console');
    } finally {
      await page.close();
    }
  });
});
