/* global document, window, location -- functions passed to page.eval run in the browser */
// UI of the OpenCode config/agent editor: phone and desktop. Throwaway HOME + project, fake OpenCode binary.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
let projectId;
let projectFile;
let globalFile;
const horizontalOverflow = () => document.documentElement.scrollWidth > document.documentElement.clientWidth;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFile = async (file, re, message) => {
  for (let i = 0; i < 80; i++) {
    if (existsSync(file) && re.test(readFileSync(file, 'utf8'))) return;
    await sleep(100);
  }
  throw new Error(message);
};

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
  TMP = mkdtempSync(path.join(tmpdir(), 'office-oc-config-ui-'));
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  projectFile = path.join(projects, 'toko', 'opencode.json');
  globalFile = path.join(TMP, 'xdg', 'opencode', 'opencode.json');
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
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
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  projectId = JSON.parse(text.match(/^data: (.*)$/m)[1]).projects.find((p) => p.name === 'toko').id;
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  server?.kill();
  await new Promise((r) => setTimeout(r, 400));
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const seed = () => {
  writeFileSync(projectFile, JSON.stringify({ model: 'anthropic/claude-lama', agent: { reviewer: { mode: 'subagent', system: 'old prompt' } } }, null, 2) + '\n');
  rmSync(path.join(TMP, 'xdg'), { recursive: true, force: true });
};

for (const vp of VIEWPORTS) {
  describe(`OpenCode config & agent — ${vp.name}`, () => {
    test('load project form, add an agent, save, JSON error, raw JSON comments and global scope', async () => {
      seed();
      const page = await browser.newPage({ width: vp.width, height: vp.height, mobile: vp.mobile });
      try {
        page.clearProblems();
        await page.goto(`${BASE}/#${projectId}`);
        await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok') && !document.querySelector('#oc-section')?.hidden, { timeoutMs: 10000, message: 'app + OpenCode section ready' });
        await page.eval(() => document.querySelector('#btn-settings').click());
        await page.eval(() => document.querySelector('[data-settings-tab="sistem"]')?.click());
        await page.waitFor(() => !document.querySelector('#settings-modal').hidden && document.querySelector('#oc-config-open')?.getClientRects().length, { message: 'settings loaded' });
        await page.eval(() => document.querySelector('#oc-config-open').click());
        await page.waitFor(() => !document.querySelector('#oc-config-modal').hidden && document.querySelector('#oc-config-path')?.textContent.includes('opencode.json'), { message: 'config modal' });
        assert.equal(await page.eval(() => document.querySelector('#oc-model').value), 'anthropic/claude-lama');
        assert.equal(await page.eval(() => document.querySelectorAll('#oc-agent-list .oc-agent').length), 1);

        await page.eval(() => {
          document.querySelector('#oc-model').value = 'anthropic/claude-baru';
          document.querySelector('#oc-agent-add').click();
          const row = [...document.querySelectorAll('#oc-agent-list .oc-agent')].at(-1);
          const set = (key, value) => {
            const input = row.querySelector(`[data-agent="${key}"]`);
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          };
          set('name', 'helper');
          set('mode', 'subagent');
          set('model', 'openai/gpt-5');
          set('description', 'Helper agent');
          set('prompt', 'Help carefully');
        });
        await page.eval(() => document.querySelector('#oc-config-save').click());
        await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Config OpenCode disimpan/.test(t.textContent)), { message: 'save toast' });
        const saved = JSON.parse(readFileSync(projectFile, 'utf8'));
        assert.equal(saved.model, 'anthropic/claude-baru');
        assert.equal(saved.agent.reviewer.system, 'old prompt');
        assert.equal(saved.agent.helper.system, 'Help carefully');
        assert.equal(saved.agent.helper.model, 'openai/gpt-5');
        // Backups now live in the app's data folder, so ask the server instead of looking next to the file.
        const history = await page.eval(async () => {
          const res = await fetch('/api/opencode-config/backups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Office-Token': document.querySelector('meta[name="office-token"]').content },
            body: JSON.stringify({ scope: 'project', projectId: location.hash.slice(1) }),
          });
          return { status: res.status, data: await res.json().catch(() => ({})) };
        });
        assert.equal(history.status, 200, 'backup history endpoint');
        assert.ok(history.data.backups.length >= 1, 'backup written');

        await page.eval(() => document.querySelector('#oc-mode-json').click());
        await page.waitFor(() => !document.querySelector('#oc-json-panel').hidden, { message: 'JSON tab' });
        const before = readFileSync(projectFile, 'utf8');
        await page.eval(() => {
          document.querySelector('#oc-json-text').value = '{broken';
          document.querySelector('#oc-config-save').click();
        });
        await page.waitFor(() => /JSON\/JSONC yang valid/.test(document.querySelector('#oc-config-error').textContent), { message: 'invalid JSON error' });
        assert.equal(readFileSync(projectFile, 'utf8'), before, 'invalid JSON is not written');
        page.clearProblems(); // the 400 above is the point of this step

        await page.eval(() => {
          document.querySelector('#oc-json-text').value = '{\n  // komentar tetap\n  "model": "json-model",\n}\n';
          document.querySelector('#oc-json-text').dispatchEvent(new Event('input', { bubbles: true }));
          document.querySelector('#oc-config-error').textContent = '';
          document.querySelector('#oc-config-save').click();
        });
        await waitFile(projectFile, /komentar tetap/, 'raw JSON saved');
        assert.match(readFileSync(projectFile, 'utf8'), /komentar tetap/);
        await page.waitFor(() => !document.querySelector('#oc-config-save').disabled, { message: 'save finished' });

        await page.eval(() => document.querySelector('#oc-scope-global').click());
        await page.waitFor(() => document.querySelector('#oc-config-path')?.textContent.includes('xdg'), { message: 'global scope' });
        await page.eval(() => {
          document.querySelector('#oc-mode-form').click();
          document.querySelector('#oc-model').value = 'global-model';
          document.querySelector('#oc-config-save').click();
        });
        await waitFile(globalFile, /global-model/, 'global config saved');
        await page.waitFor(() => !document.querySelector('#oc-config-save').disabled, { message: 'global save finished' });

        await page.eval(() => document.querySelector('#oc-scope-project').click());
        await page.waitFor(() => /toko/.test(document.querySelector('#oc-config-path').textContent) && !document.querySelector('#oc-config-save').disabled, { message: 'back to project scope' });
        writeFileSync(projectFile, '{broken\n');
        await page.eval(() => document.querySelector('#oc-config-reload').click());
        await page.waitFor(() => !document.querySelector('#oc-json-panel').hidden && /JSON\/JSONC yang valid/.test(document.querySelector('#oc-config-error').textContent), { message: 'broken config opens in JSON' });
        await page.eval(() => {
          document.querySelector('#oc-json-text').value = '{"model":"fixed"}\n';
          document.querySelector('#oc-config-save').click();
        });
        await waitFile(projectFile, /fixed/, 'broken config repaired');
        assert.equal(await page.eval(horizontalOverflow), false);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });

    test('konflik nyata root + .opencode: banner, konsolidasi, dan riwayat backup', async () => {
      seed();
      const dotDir = path.join(path.dirname(projectFile), '.opencode');
      const dotFile = path.join(dotDir, 'opencode.json');
      mkdirSync(dotDir, { recursive: true });
      writeFileSync(projectFile, `${JSON.stringify({ model: 'root-model', agent: { reviewer: { system: 'root prompt' } } }, null, 2)}\n`);
      writeFileSync(dotFile, `${JSON.stringify({ model: 'dot-model', small_model: 'dot-small' }, null, 2)}\n`);
      const page = await browser.newPage({ width: vp.width, height: vp.height, mobile: vp.mobile });
      try {
        page.clearProblems();
        await page.goto(`${BASE}/#${projectId}`);
        await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok') && !document.querySelector('#oc-section')?.hidden, { timeoutMs: 10000, message: 'app ready' });
        await page.eval(() => { window.confirm = () => true; }); // the dialog is listed, the confirm is the answer
        await page.eval(() => document.querySelector('#btn-settings').click());
        await page.eval(() => document.querySelector('[data-settings-tab="sistem"]')?.click());
        await page.waitFor(() => !document.querySelector('#settings-modal').hidden && document.querySelector('#oc-config-open')?.getClientRects().length, { message: 'settings loaded' });
        await page.eval(() => document.querySelector('#oc-config-open').click());
        await page.waitFor(() => !document.querySelector('#oc-conflict').hidden, { message: 'banner konflik dari server' });
        const banner = await page.eval(() => ({
          paths: [...document.querySelectorAll('#oc-conflict-paths li')].map((li) => li.textContent),
          consolidateHidden: document.querySelector('#oc-conflict-consolidate').hidden,
        }));
        assert.equal(banner.paths.length, 2, 'hanya file yang ada yang didaftar');
        assert.match(banner.paths.join('\n'), /opencode\.json/);
        assert.match(banner.paths.join('\n'), /\.opencode/);
        assert.equal(banner.consolidateHidden, false);

        await page.eval(() => document.querySelector('#oc-conflict-consolidate').click());
        await page.waitFor(() => [...document.querySelectorAll('.toast')].some((toast) => /digabung/i.test(toast.textContent)), { message: 'toast konsolidasi' });
        const toastText = await page.eval(() => [...document.querySelectorAll('.toast')].map((toast) => toast.textContent).join(' | '));
        assert.match(toastText, /pemulihan manual/i, 'file .opencode hanya untuk pemulihan manual');
        assert.doesNotMatch(toastText, /dipulihkan/i);
        const merged = JSON.parse(readFileSync(projectFile, 'utf8'));
        assert.equal(merged.model, 'dot-model', 'file .opencode menang per kunci');
        assert.equal(merged.small_model, 'dot-small');
        assert.equal(merged.agent.reviewer.system, 'root prompt');
        assert.equal(existsSync(dotFile), false, 'file .opencode dipindah');
        await page.waitFor(() => document.querySelector('#oc-conflict').hidden, { message: 'banner hilang' });

        // The moved `.opencode` file is stored as a `dot--` copy and is NOT part of this file's history any more.
        await page.eval(() => document.querySelector('#oc-history > summary').click());
        await page.waitFor(() => document.querySelectorAll('#oc-backup-list .oc-backup-row').length >= 1, { message: 'riwayat dari server' });
        assert.match(await page.eval(() => document.querySelector('#oc-backup-list').textContent), /KB/);
        assert.equal(await page.eval(horizontalOverflow), false);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
        rmSync(dotDir, { recursive: true, force: true });
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Conflict banner, backup history, preview/restore and the 409 on save. The config backend is faked IN THE PAGE
// (the read/save/backups/backup/restore/consolidate contract), so these tests do not wait for the server routes:
// test/opencode-config.test.mjs covers the real files on disk.
// ---------------------------------------------------------------------------------------------------------------

const ROOT_CONFIG = 'C:\\dev\\toko\\opencode.json';
const DOT_CONFIG = 'C:\\dev\\toko\\.opencode\\opencode.json';
const sourcesOf = () => [
  { path: ROOT_CONFIG, kind: 'project', exists: true, format: 'json', valid: true },
  { path: DOT_CONFIG, kind: 'dot-opencode', exists: true, format: 'json', valid: true },
];
const conflictOf = (over = {}) => ({
  others: [DOT_CONFIG],
  effective: ROOT_CONFIG,
  sameFolder: false,
  message: 'Ada dua file config OpenCode untuk project ini: opencode.json dan .opencode/opencode.json.',
  ...over,
});
const configView = (over = {}) => ({
  scope: 'project',
  path: ROOT_CONFIG,
  exists: true,
  format: 'json',
  text: '{\n  "model": "anthropic/claude-lama"\n}\n',
  config: { model: 'anthropic/claude-lama' },
  agents: [{ name: 'reviewer', mode: 'subagent', model: '', description: '', prompt: 'old prompt' }],
  parseError: null,
  hash: 'hash-1',
  sources: sourcesOf(),
  conflict: null,
  consolidatable: false,
  ...over,
});
const BACKUPS = [
  { id: 'b1', name: 'opencode.json.20261105', at: '2026-11-05T03:04:05.000Z', bytes: 2048, valid: true, format: 'json', legacy: false },
  { id: 'b2', name: 'opencode.json.20261104', at: '2026-11-04T01:02:03.000Z', bytes: 512, valid: false, format: 'json', legacy: true },
  // An old `.bak-*` next to the config: listed as legacy, still previewable/restorable when valid.
  { id: 'legacy:opencode.json.bak-20260101', name: 'opencode.json.bak-20260101', at: '2026-11-03T22:00:00.000Z', bytes: 1024, valid: true, format: 'json', legacy: true },
];
const LEGACY_ID = 'legacy:opencode.json.bak-20260101';
const STALE = 'File berubah di luar aplikasi.';
const BUSY = 'Tidak bisa mengubah config OpenCode saat masih ada giliran yang berjalan.';
const ROOT_JSONC = 'C:\\dev\\toko\\opencode.jsonc';
const DOT_JSONC = 'C:\\dev\\toko\\.opencode\\opencode.jsonc';
const modalOverflow = () => {
  const card = document.querySelector('#oc-config-modal .modal-card');
  return card ? card.scrollWidth > card.clientWidth + 1 : false;
};

/** Fake of the OpenCode config backend in the page: the contract's read shape plus every new endpoint. */
function installConfigFake() {
  if (window.__ocfake) return;
  const realFetch = window.fetch.bind(window);
  const fake = { view: null, backups: [], texts: {}, posts: [], confirms: [], failNext: {} };
  window.__ocfake = fake;
  window.confirm = (message) => {
    fake.confirms.push(String(message));
    return true;
  };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const read = () => ({
    ...fake.view,
    sources: (fake.view.sources ?? []).map((source) => ({ ...source })),
    conflict: fake.view.conflict ? { ...fake.view.conflict, others: [...(fake.view.conflict.others ?? [])] } : null,
  });
  // New contract: baseHash is mandatory (its own property, null when the file is absent) and must match the file.
  const hashGuard = (payload) => (Object.hasOwn(payload, 'baseHash') ? null : json({ error: 'Muat ulang config lalu coba lagi.', code: 'lock-missing' }, 409));
  const staleGuard = (payload) => (payload.baseHash === fake.view.hash ? null : json({ error: STALE, code: 'stale' }, 409));
  const guard = (payload) => hashGuard(payload) ?? staleGuard(payload);
  // fake.failNext[endpoint] = { message, code }: the server refuses once with 409 (no write).
  const refuse = (target) => {
    const failure = fake.failNext[target];
    if (!failure) return null;
    delete fake.failNext[target];
    return json({ error: failure.message, code: failure.code ?? 'stale' }, 409);
  };
  window.fetch = async (url, opts = {}) => {
    const endpoint = String(url);
    if (!endpoint.startsWith('/api/opencode-config')) return realFetch(url, opts);
    const body = opts.body ? JSON.parse(opts.body) : {};
    fake.posts.push({ path: endpoint, body });
    switch (endpoint) {
      case '/api/opencode-config':
        return json(read());
      case '/api/opencode-config/save': {
        const failed = refuse(endpoint) ?? guard(body);
        if (failed) return failed;
        fake.view = { ...read(), hash: 'hash-2', text: '{"model":"anthropic/claude-baru"}\n', config: { model: body.form?.model ?? 'anthropic/claude-baru' }, agents: [], parseError: null, backup: 'b-new' };
        return json(read());
      }
      case '/api/opencode-config/backups':
        return json({ backups: fake.backups.map((backup) => ({ ...backup })) });
      case '/api/opencode-config/backup': {
        const backup = fake.backups.find((item) => item.id === body.id);
        return backup ? json({ ...backup, text: fake.texts[body.id] ?? '' }) : json({ error: 'Backup tidak ditemukan.' }, 404);
      }
      case '/api/opencode-config/restore': {
        const failed = refuse(endpoint) ?? guard(body);
        if (failed) return failed;
        const backup = fake.backups.find((item) => item.id === body.id);
        if (!backup) return json({ error: 'Backup tidak ditemukan.' }, 404);
        fake.view = { ...read(), text: fake.texts[body.id] ?? '', config: { model: 'dipulihkan' }, agents: [], hash: 'hash-restored' };
        return json({ ...read(), restored: true, backup: { ...backup }, restarted: 2 });
      }
      case '/api/opencode-config/consolidate': {
        const failed = refuse(endpoint) ?? guard(body);
        if (failed) return failed;
        const moved = (fake.view.sources ?? [])
          .filter((source) => source?.kind === 'dot-opencode' && source.exists !== false)
          .map((source) => `dot--${String(source.path).split(/[\\/]/).pop()}`);
        fake.view = { ...read(), text: '{"model":"gabungan"}\n', config: { model: 'gabungan' }, agents: [], hash: 'hash-consolidated', conflict: null, consolidatable: false, sources: (fake.view.sources ?? []).filter((source) => source.kind !== 'dot-opencode') };
        return json({ ...read(), consolidated: true, movedBackups: moved, movedBackup: moved[0] ?? null, restarted: 1 });
      }
      default:
        return json({ error: 'Endpoint tidak dikenal.' }, 404);
    }
  };
}

const configPage = async (vp) => {
  const page = await browser.newPage({ width: vp.width, height: vp.height, mobile: vp.mobile });
  page.clearProblems();
  return page;
};

/** Full load, then the ⚙ → Sistem → editor config with the fake seeded. */
async function openConfigEditor(page, { conflict = false, backups = BACKUPS, texts = {}, view = null } = {}) {
  await page.goto(`${BASE}/#${projectId}`);
  await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok') && !document.querySelector('#oc-section')?.hidden, { timeoutMs: 10000, message: 'app + OpenCode section ready' });
  await page.eval(installConfigFake);
  await page.eval((seed) => {
    const fake = window.__ocfake;
    fake.view = seed.view;
    fake.backups = seed.backups;
    fake.texts = seed.texts;
    fake.posts.length = 0;
    fake.confirms.length = 0;
    fake.failNext = {};
  }, { view: view ?? configView(conflict ? { conflict: conflictOf(), consolidatable: true } : {}), backups, texts });
  await page.eval(() => document.querySelector('#btn-settings').click());
  await page.eval(() => document.querySelector('[data-settings-tab="sistem"]')?.click());
  await page.waitFor(() => !document.querySelector('#settings-modal').hidden && document.querySelector('#oc-config-open')?.getClientRects().length, { message: 'settings loaded' });
  await page.eval(() => document.querySelector('#oc-config-open').click());
  await page.waitFor(() => !document.querySelector('#oc-config-modal').hidden && document.querySelector('#oc-config-path')?.textContent.includes('opencode.json'), { message: 'config modal' });
}

for (const vp of VIEWPORTS) {
  describe(`OpenCode config: konflik & riwayat backup — ${vp.name}`, () => {
    test('banner konflik menampilkan sumber, bisa ditutup, dan menyembunyikan konsolidasi saat satu folder', async () => {
      const page = await configPage(vp);
      try {
        await openConfigEditor(page, { conflict: true });
        await page.waitFor(() => !document.querySelector('#oc-conflict').hidden, { message: 'banner konflik' });
        const banner = await page.eval(() => ({
          role: document.querySelector('#oc-conflict').getAttribute('role'),
          message: document.querySelector('#oc-conflict-message').textContent,
          paths: [...document.querySelectorAll('#oc-conflict-paths li')].map((li) => li.textContent),
          consolidateHidden: document.querySelector('#oc-conflict-consolidate').hidden,
          closeName: document.querySelector('#oc-conflict-close').textContent.trim(),
        }));
        assert.equal(banner.role, 'alert');
        assert.match(banner.message, /dua file config/);
        assert.equal(banner.paths.length, 2);
        assert.match(banner.paths[0], /opencode\.json/);
        assert.match(banner.paths[0], /diedit di sini/);
        assert.match(banner.paths[0], /dipakai OpenCode/);
        assert.match(banner.paths[1], /\.opencode/);
        assert.equal(banner.consolidateHidden, false);
        assert.equal(banner.closeName, 'Tutup');

        // Tutup only dismisses this view; a reload shows it again.
        await page.eval(() => document.querySelector('#oc-conflict-close').click());
        await page.waitFor(() => document.querySelector('#oc-conflict').hidden, { message: 'banner ditutup' });
        await page.eval(() => document.querySelector('#oc-config-reload').click());
        await page.waitFor(() => !document.querySelector('#oc-conflict').hidden, { message: 'banner muncul lagi setelah muat ulang' });

        // Mixed root .json + .jsonc + .opencode: `sameFolder` only explains the ignored .jsonc; the dot file is still
        // mergeable, so the server says consolidatable and the button stays.
        await page.eval((jsonc) => {
          window.__ocfake.view.sources = [
            { path: window.__ocfake.view.path, kind: 'project', exists: true, format: 'json', valid: true },
            { path: jsonc, kind: 'project', exists: true, format: 'jsonc', valid: true },
            { path: 'C:\\dev\\toko\\.opencode\\opencode.json', kind: 'dot-opencode', exists: true, format: 'json', valid: true },
          ];
          window.__ocfake.view.conflict = {
            others: ['C:\\dev\\toko\\.opencode\\opencode.json', jsonc],
            effective: 'C:\\dev\\toko\\.opencode\\opencode.json',
            sameFolder: true,
            message: 'Di folder yang sama hanya opencode.json yang dibaca, opencode.jsonc diabaikan.',
          };
          window.__ocfake.view.consolidatable = true;
        }, ROOT_JSONC);
        await page.eval(() => document.querySelector('#oc-config-reload').click());
        await page.waitFor(() => /opencode\.jsonc diabaikan/.test(document.querySelector('#oc-conflict-message').textContent), { message: 'pesan jsonc' });
        assert.equal(await page.eval(() => document.querySelector('#oc-conflict-consolidate').hidden), false, 'sameFolder tidak menyembunyikan konsolidasi');

        // Only .json + .jsonc (no .opencode at all): the banner warns, but there is nothing to consolidate.
        await page.eval((jsonc) => {
          window.__ocfake.view.sources = [
            { path: window.__ocfake.view.path, kind: 'project', exists: true, format: 'json', valid: true },
            { path: jsonc, kind: 'project', exists: true, format: 'jsonc', valid: true },
          ];
          window.__ocfake.view.conflict = {
            others: [jsonc],
            effective: window.__ocfake.view.path,
            sameFolder: true,
            message: 'Di folder yang sama hanya opencode.json yang dibaca, opencode.jsonc diabaikan.',
          };
          window.__ocfake.view.consolidatable = false;
        }, ROOT_JSONC);
        await page.eval(() => document.querySelector('#oc-config-reload').click());
        await page.waitFor(() => document.querySelector('#oc-conflict-consolidate')?.hidden, { message: 'konsolidasi disembunyikan' });
        assert.equal(await page.eval(() => document.querySelector('#oc-conflict').hidden), false);

        await page.eval(() => document.querySelector('#oc-history > summary').click());
        await page.waitFor(() => document.querySelectorAll('#oc-backup-list .oc-backup-row').length === 3, { message: 'riwayat terbuka' });
        assert.equal(await page.eval(horizontalOverflow), false);
        assert.equal(await page.eval(modalOverflow), false);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });

    test('konsolidasi: konfirmasi dulu, baseHash ikut, editor memakai view baru, nama file di toast', async () => {
      const page = await configPage(vp);
      try {
        await openConfigEditor(page, { conflict: true });
        await page.waitFor(() => !document.querySelector('#oc-conflict').hidden, { message: 'banner konflik' });
        await page.eval(() => document.querySelector('#oc-conflict-consolidate').click());
        await page.waitFor(() => [...document.querySelectorAll('.toast')].some((toast) => /digabung/i.test(toast.textContent)), { message: 'toast konsolidasi' });
        const fake = await page.eval(() => ({ posts: window.__ocfake.posts, confirms: window.__ocfake.confirms }));
        const call = fake.posts.find((post) => post.path === '/api/opencode-config/consolidate');
        assert.deepEqual(call.body, { projectId, baseHash: 'hash-1' });
        assert.equal(fake.confirms.length, 1);
        assert.match(fake.confirms[0], /\.opencode/);
        assert.match(fake.confirms[0], /digabung/i);
        assert.match(fake.confirms[0], /dot--/);
        assert.match(fake.confirms[0], /pemulihan manual/i);
        assert.match(fake.confirms[0], /tidak muncul di Riwayat backup/i);
        assert.match(fake.confirms[0], /JSON biasa/i, 'root ditulis sebagai JSON biasa');
        assert.match(fake.confirms[0], /komentar JSONC/i, 'komentar JSONC root tidak dipertahankan');
        const shown = await page.eval(() => ({
          conflictHidden: document.querySelector('#oc-conflict').hidden,
          model: document.querySelector('#oc-model').value,
          path: document.querySelector('#oc-config-path').textContent,
          toast: [...document.querySelectorAll('.toast')].map((toast) => toast.textContent).join(' | '),
        }));
        assert.equal(shown.conflictHidden, true);
        assert.equal(shown.model, 'gabungan');
        assert.match(shown.path, /opencode\.json/);
        assert.match(shown.toast, /\.opencode\/opencode\.json/);
        assert.match(shown.toast, /pemulihan manual/i);
        assert.match(shown.toast, /tidak di Riwayat backup|bukan di Riwayat backup/i);
        assert.doesNotMatch(shown.toast, /dipulihkan/i);
        assert.match(shown.toast, /1 sesi/);
        assert.equal(await page.eval(horizontalOverflow), false);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });

    test('konsolidasi: nama .opencode dari sumber yang ada, jumlah disebut bila lebih dari satu', async () => {
      const page = await configPage(vp);
      try {
        // `.opencode/opencode.json` is missing; only the `.jsonc` exists, so that is the file to name (not the first
        // dot entry of `sources`).
        const onlyJsonc = [
          { path: ROOT_CONFIG, kind: 'project', exists: true, format: 'json', valid: true },
          { path: DOT_CONFIG, kind: 'dot-opencode', exists: false, format: 'json', valid: false },
          { path: DOT_JSONC, kind: 'dot-opencode', exists: true, format: 'jsonc', valid: true },
        ];
        await openConfigEditor(page, {
          view: configView({
            sources: onlyJsonc,
            consolidatable: true,
            conflict: { others: [DOT_JSONC], effective: DOT_JSONC, sameFolder: false, message: 'Dua file config OpenCode untuk project ini.' },
          }),
        });
        await page.waitFor(() => !document.querySelector('#oc-conflict').hidden, { message: 'banner konflik' });
        await page.eval(() => document.querySelector('#oc-conflict-consolidate').click());
        await page.waitFor(() => [...document.querySelectorAll('.toast')].some((toast) => /digabung/i.test(toast.textContent)), { message: 'toast konsolidasi jsonc' });
        const first = await page.eval(() => ({
          confirm: window.__ocfake.confirms[0] ?? '',
          toast: [...document.querySelectorAll('.toast')].map((toast) => toast.textContent).join(' | '),
        }));
        assert.match(first.confirm, /\.opencode\/opencode\.jsonc/);
        assert.doesNotMatch(first.confirm, /\.opencode\/opencode\.json\b/);
        assert.match(first.toast, /\.opencode\/opencode\.jsonc/);
        assert.doesNotMatch(first.confirm, /2 file \.opencode/);

        // Both `.opencode` files exist: the confirm and the toast (from `movedBackups`) say the count.
        await page.eval(({ root, dot, jsonc }) => {
          window.__ocfake.view.sources = [
            { path: root, kind: 'project', exists: true, format: 'json', valid: true },
            { path: dot, kind: 'dot-opencode', exists: true, format: 'json', valid: true },
            { path: jsonc, kind: 'dot-opencode', exists: true, format: 'jsonc', valid: true },
          ];
          window.__ocfake.view.conflict = { others: [dot, jsonc], effective: dot, sameFolder: true, message: 'Di folder yang sama hanya opencode.json yang dibaca.' };
          window.__ocfake.view.consolidatable = true;
        }, { root: ROOT_CONFIG, dot: DOT_CONFIG, jsonc: DOT_JSONC });
        await page.eval(() => document.querySelector('#oc-config-reload').click());
        await page.waitFor(() => !document.querySelector('#oc-conflict').hidden && document.querySelectorAll('#oc-conflict-paths li').length === 3, { message: 'dua file .opencode' });
        await page.eval(() => document.querySelector('#oc-conflict-consolidate').click());
        await page.waitFor(() => window.__ocfake.posts.filter((post) => post.path === '/api/opencode-config/consolidate').length === 2, { message: 'konsolidasi kedua' });
        const second = await page.eval(() => ({
          confirm: window.__ocfake.confirms[1] ?? '',
          toast: [...document.querySelectorAll('.toast')].map((toast) => toast.textContent).join(' | '),
        }));
        assert.match(second.confirm, /2 file \.opencode/);
        assert.match(second.toast, /2 file \.opencode/);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });

    test('riwayat backup: waktu lokal, ukuran KB, badge tidak valid/format lama, pulihkan, dan state kosong', async () => {
      const page = await configPage(vp);
      try {
        await openConfigEditor(page, { texts: { [LEGACY_ID]: '{"model":"lama"}' } });
        await page.eval(() => document.querySelector('#oc-history > summary').click());
        await page.waitFor(() => document.querySelectorAll('#oc-backup-list .oc-backup-row').length === 3, { message: 'tiga baris backup' });
        const rows = await page.eval(() => [...document.querySelectorAll('#oc-backup-list .oc-backup-row')].map((row) => ({
          meta: row.querySelector('.oc-backup-meta').textContent,
          restoreDisabled: row.querySelector('[data-backup-restore]').disabled,
          previewDisabled: row.querySelector('[data-backup-preview]').disabled,
          badges: [...row.querySelectorAll('.pill')].map((pill) => pill.textContent),
        })));
        assert.match(rows[0].meta, /2\.0 KB/);
        assert.match(rows[0].meta, /\d/);
        assert.equal(rows[0].restoreDisabled, false);
        assert.deepEqual(rows[0].badges, []);
        assert.match(rows[1].meta, /0\.5 KB/);
        assert.equal(rows[1].restoreDisabled, true, 'backup tidak valid tidak bisa dipulihkan');
        assert.equal(rows[1].previewDisabled, false, 'pratinjau tetap boleh');
        assert.deepEqual(rows[1].badges, ['tidak valid', 'format lama']);
        assert.match(rows[2].meta, /1\.0 KB/);
        assert.deepEqual(rows[2].badges, ['format lama'], 'badge untuk .bak-* lama');
        assert.equal(rows[2].restoreDisabled, false, 'backup lama yang valid tetap bisa dipulihkan');
        assert.equal(rows[2].previewDisabled, false);

        // Legacy entries still preview from the same section.
        await page.eval((id) => document.querySelector(`[data-backup-preview="${id}"]`).click(), LEGACY_ID);
        await page.waitFor(() => document.querySelector('#oc-backup-preview').value === '{"model":"lama"}', { message: 'pratinjau backup lama' });

        await page.eval(() => { window.__ocfake.backups = []; });
        await page.eval(() => document.querySelector('#oc-history > summary').click());
        await page.eval(() => document.querySelector('#oc-history > summary').click());
        await page.waitFor(() => /Belum ada backup/.test(document.querySelector('#oc-backup-list').textContent), { message: 'state kosong' });
        assert.equal(await page.eval(modalOverflow), false);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });

    test('pratinjau backup menulis teks apa adanya, tidak pernah innerHTML', async () => {
      const page = await configPage(vp);
      try {
        const evil = '<img src=x onerror="window.__ocPwned = 1"> & <b>tebal</b>';
        await openConfigEditor(page, { texts: { b1: evil } });
        await page.eval(() => document.querySelector('#oc-history > summary').click());
        await page.waitFor(() => document.querySelector('[data-backup-preview="b1"]'), { message: 'baris backup' });
        await page.eval(() => document.querySelector('[data-backup-preview="b1"]').click());
        await page.waitFor(() => document.querySelector('#oc-backup-preview').value.length > 0, { message: 'pratinjau terisi' });
        const preview = await page.eval(() => ({
          tag: document.querySelector('#oc-backup-preview').tagName,
          value: document.querySelector('#oc-backup-preview').value,
          readonly: document.querySelector('#oc-backup-preview').readOnly,
          label: document.querySelector('#oc-backup-preview').getAttribute('aria-label'),
          injected: document.querySelectorAll('#oc-backup-preview-wrap img, #oc-backup-preview-wrap b').length,
          pwned: window.__ocPwned ?? null,
        }));
        assert.equal(preview.tag, 'TEXTAREA');
        assert.equal(preview.value, evil);
        assert.equal(preview.readonly, true);
        assert.ok(preview.label, 'pratinjau punya aria-label');
        assert.equal(preview.injected, 0);
        assert.equal(preview.pwned, null);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });

    test('pulihkan: konfirmasi, baseHash ikut, editor digambar ulang, riwayat dimuat ulang', async () => {
      const page = await configPage(vp);
      try {
        await openConfigEditor(page, { texts: { b1: '{"model":"dipulihkan"}\n' } });
        await page.eval(() => document.querySelector('#oc-history > summary').click());
        await page.waitFor(() => document.querySelector('[data-backup-restore="b1"]'), { message: 'baris backup' });
        await page.eval(() => document.querySelector('[data-backup-restore="b1"]').click());
        await page.waitFor(() => document.querySelector('#oc-model').value === 'dipulihkan', { message: 'editor digambar ulang' });
        const fake = await page.eval(() => ({ posts: window.__ocfake.posts, confirms: window.__ocfake.confirms }));
        const call = fake.posts.find((post) => post.path === '/api/opencode-config/restore');
        assert.deepEqual(call.body, { scope: 'project', projectId, id: 'b1', baseHash: 'hash-1' });
        assert.equal(fake.confirms.length, 1);
        assert.match(fake.confirms[0], /Pulihkan config dari backup/);
        const toastText = await page.eval(() => [...document.querySelectorAll('.toast')].map((toast) => toast.textContent).join(' | '));
        assert.match(toastText, /dipulihkan/i);
        assert.match(toastText, /2 sesi OpenCode/);
        assert.ok(fake.posts.filter((post) => post.path === '/api/opencode-config/backups').length >= 2, 'riwayat dimuat ulang');
        assert.equal(await page.eval(() => document.querySelector('#oc-config-path').textContent.includes('opencode.json')), true);

        // A backup the server called invalid has a disabled Pulihkan: clicking it does nothing.
        const restoreCalls = fake.posts.filter((post) => post.path === '/api/opencode-config/restore').length;
        assert.equal(await page.eval(() => document.querySelector('[data-backup-restore="b2"]').disabled), true);
        await page.eval(() => document.querySelector('[data-backup-restore="b2"]').click());
        assert.equal(await page.eval(() => window.__ocfake.posts.filter((post) => post.path === '/api/opencode-config/restore').length), restoreCalls);

        // A legacy (`.bak-*`) backup that is valid restores through the same endpoint, id untouched.
        await page.eval((id) => document.querySelector(`[data-backup-restore="${id}"]`).click(), LEGACY_ID);
        await page.waitFor((id) => window.__ocfake.posts.some((post) => post.path === '/api/opencode-config/restore' && post.body.id === id), { message: 'pulihkan backup lama' }, LEGACY_ID);
        const legacy = await page.eval(() => window.__ocfake.posts.filter((post) => post.path === '/api/opencode-config/restore').at(-1));
        assert.equal(legacy.body.id, LEGACY_ID);
        assert.equal(legacy.body.baseHash, 'hash-restored');
        await page.waitFor(() => window.__ocfake.posts.filter((post) => post.path === '/api/opencode-config/backups').length >= 3, { message: 'riwayat dimuat ulang setelah pulihkan lama' });
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });

    test('simpan mengirim baseHash; 409 menampilkan pesan server tanpa menimpa', async () => {
      const page = await configPage(vp);
      try {
        await openConfigEditor(page);
        await page.eval(() => { document.querySelector('#oc-model').value = 'anthropic/baru'; });
        await page.eval(() => document.querySelector('#oc-config-save').click());
        await page.waitFor(() => [...document.querySelectorAll('.toast')].some((toast) => /Config OpenCode disimpan/.test(toast.textContent)), { message: 'toast simpan' });
        const first = await page.eval(() => window.__ocfake.posts.find((post) => post.path === '/api/opencode-config/save'));
        assert.equal(first.body.baseHash, 'hash-1');
        assert.equal(first.body.form.model, 'anthropic/baru');

        // The file changed outside the app: the server refuses (`code: stale`). Nothing is written automatically.
        const before = await page.eval(() => window.__ocfake.view.text);
        await page.eval((message) => { window.__ocfake.failNext['/api/opencode-config/save'] = { message, code: 'stale' }; }, STALE);
        await page.eval(() => document.querySelector('#oc-config-save').click());
        await page.waitFor(() => /berubah di luar aplikasi/.test(document.querySelector('#oc-config-error').textContent), { message: 'pesan 409' });
        assert.match(await page.eval(() => document.querySelector('#oc-config-error').textContent), /Klik ↻ Muat ulang, lalu coba lagi/);
        assert.equal(await page.eval(() => window.__ocfake.view.text), before, 'file tidak ditimpa');
        const reload = await page.eval(() => ({
          disabled: document.querySelector('#oc-config-reload').disabled,
          hint: document.querySelector('#oc-config-reload').classList.contains('needs-reload'),
        }));
        assert.equal(reload.disabled, false);
        assert.equal(reload.hint, true, 'Muat ulang ditandai');
        const hashes = await page.eval(() => window.__ocfake.posts.filter((post) => post.path === '/api/opencode-config/save').map((post) => post.body.baseHash));
        assert.deepEqual(hashes, ['hash-1', 'hash-2'], 'hash basi dikirim lagi, bukan ditimpa');

        page.clearProblems(); // the 409 is the point of this step
        await page.eval(() => document.querySelector('#oc-config-reload').click());
        await page.waitFor(() => !document.querySelector('#oc-config-reload').classList.contains('needs-reload'), { message: 'hint hilang setelah muat ulang' });

        // A running turn is a 409 too (`code: busy`): message only, reloading would throw the edits away.
        await page.eval((message) => { window.__ocfake.failNext['/api/opencode-config/save'] = { message, code: 'busy' }; }, BUSY);
        await page.eval(() => document.querySelector('#oc-config-save').click());
        await page.waitFor(() => /giliran yang berjalan/.test(document.querySelector('#oc-config-error').textContent), { message: 'pesan 409 busy' });
        const busy = await page.eval(() => ({
          error: document.querySelector('#oc-config-error').textContent,
          hint: document.querySelector('#oc-config-reload').classList.contains('needs-reload'),
          saves: window.__ocfake.posts.filter((post) => post.path === '/api/opencode-config/save').length,
        }));
        assert.equal(busy.error, BUSY, 'pesan server saja, tanpa ajakan muat ulang');
        assert.equal(busy.hint, false, 'tidak menandai Muat ulang');
        assert.equal(busy.saves, 3, 'tidak dicoba ulang otomatis');
        page.clearProblems(); // the busy 409 is the point of this step
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });

    test('konsolidasi 409: stale menandai Muat ulang, busy tidak, tanpa percobaan ulang', async () => {
      const page = await configPage(vp);
      try {
        await openConfigEditor(page, { conflict: true });
        await page.waitFor(() => !document.querySelector('#oc-conflict').hidden, { message: 'banner konflik' });
        await page.eval((message) => { window.__ocfake.failNext['/api/opencode-config/consolidate'] = { message, code: 'stale' }; }, STALE);
        await page.eval(() => document.querySelector('#oc-conflict-consolidate').click());
        await page.waitFor(() => /berubah di luar aplikasi/.test(document.querySelector('#oc-config-error').textContent), { message: 'pesan 409 konsolidasi' });
        const state = await page.eval(() => ({
          error: document.querySelector('#oc-config-error').textContent,
          hint: document.querySelector('#oc-config-reload').classList.contains('needs-reload'),
          calls: window.__ocfake.posts.filter((post) => post.path === '/api/opencode-config/consolidate').length,
          conflictHidden: document.querySelector('#oc-conflict').hidden,
          consolidated: window.__ocfake.view.conflict === null,
          toast: [...document.querySelectorAll('.toast')].some((toast) => /digabung/i.test(toast.textContent)),
        }));
        assert.match(state.error, /Klik ↻ Muat ulang, lalu coba lagi/);
        assert.equal(state.hint, true, 'Muat ulang ditandai');
        assert.equal(state.calls, 1, 'tidak dicoba ulang otomatis');
        assert.equal(state.conflictHidden, false, 'banner tetap ada');
        assert.equal(state.consolidated, false, 'tidak ada yang ditulis');
        assert.equal(state.toast, false);
        page.clearProblems(); // the 409 is the point of this step
        await page.eval(() => document.querySelector('#oc-config-reload').click());
        await page.waitFor(() => !document.querySelector('#oc-config-reload').classList.contains('needs-reload'), { message: 'hint hilang setelah muat ulang' });
        assert.equal(await page.eval(() => document.querySelector('#oc-config-error').textContent), '');

        // `busy`: the message only, the reload button is not marked.
        await page.eval((message) => { window.__ocfake.failNext['/api/opencode-config/consolidate'] = { message, code: 'busy' }; }, BUSY);
        await page.eval(() => document.querySelector('#oc-conflict-consolidate').click());
        await page.waitFor(() => /giliran yang berjalan/.test(document.querySelector('#oc-config-error').textContent), { message: 'pesan busy' });
        const busy = await page.eval(() => ({
          error: document.querySelector('#oc-config-error').textContent,
          hint: document.querySelector('#oc-config-reload').classList.contains('needs-reload'),
          calls: window.__ocfake.posts.filter((post) => post.path === '/api/opencode-config/consolidate').length,
          consolidated: window.__ocfake.view.conflict === null,
        }));
        assert.equal(busy.error, BUSY, 'pesan server saja');
        assert.equal(busy.hint, false, 'tidak menandai Muat ulang');
        assert.equal(busy.calls, 2, 'tidak dicoba ulang otomatis');
        assert.equal(busy.consolidated, false, 'tidak ada yang ditulis');
        page.clearProblems(); // the busy 409 is the point of this step
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });

    test('pulihkan 409: stale menandai Muat ulang, busy tidak, tanpa percobaan ulang', async () => {
      const page = await configPage(vp);
      try {
        await openConfigEditor(page, { texts: { b1: '{"model":"dipulihkan"}\n' } });
        await page.eval(() => document.querySelector('#oc-history > summary').click());
        await page.waitFor(() => document.querySelector('[data-backup-restore="b1"]'), { message: 'baris backup' });
        await page.eval((message) => { window.__ocfake.failNext['/api/opencode-config/restore'] = { message, code: 'stale' }; }, STALE);
        await page.eval(() => document.querySelector('[data-backup-restore="b1"]').click());
        await page.waitFor(() => /berubah di luar aplikasi/.test(document.querySelector('#oc-config-error').textContent), { message: 'pesan 409 pulihkan' });
        const state = await page.eval(() => ({
          error: document.querySelector('#oc-config-error').textContent,
          backupError: document.querySelector('#oc-backup-error').textContent,
          hint: document.querySelector('#oc-config-reload').classList.contains('needs-reload'),
          calls: window.__ocfake.posts.filter((post) => post.path === '/api/opencode-config/restore').length,
          historyLoads: window.__ocfake.posts.filter((post) => post.path === '/api/opencode-config/backups').length,
          model: document.querySelector('#oc-model').value,
        }));
        assert.match(state.error, /Klik ↻ Muat ulang, lalu coba lagi/);
        assert.equal(state.backupError, '', 'bukan error riwayat');
        assert.equal(state.hint, true);
        assert.equal(state.calls, 1, 'tidak dicoba ulang otomatis');
        assert.equal(state.historyLoads, 1, 'riwayat tidak dimuat ulang setelah gagal');
        assert.equal(state.model, 'anthropic/claude-lama', 'editor tidak berubah');
        page.clearProblems(); // the 409 is the point of this step
        await page.eval(() => document.querySelector('#oc-config-reload').click());
        await page.waitFor(() => !document.querySelector('#oc-config-reload').classList.contains('needs-reload'), { message: 'hint hilang setelah muat ulang' });

        // `busy`: message only, no reload hint (reloading would drop unsaved edits and does not end the turn).
        await page.eval((message) => { window.__ocfake.failNext['/api/opencode-config/restore'] = { message, code: 'busy' }; }, BUSY);
        await page.eval(() => document.querySelector('[data-backup-restore="b1"]').click());
        await page.waitFor(() => /giliran yang berjalan/.test(document.querySelector('#oc-config-error').textContent), { message: 'pesan busy' });
        const busy = await page.eval(() => ({
          error: document.querySelector('#oc-config-error').textContent,
          backupError: document.querySelector('#oc-backup-error').textContent,
          hint: document.querySelector('#oc-config-reload').classList.contains('needs-reload'),
          calls: window.__ocfake.posts.filter((post) => post.path === '/api/opencode-config/restore').length,
          model: document.querySelector('#oc-model').value,
        }));
        assert.equal(busy.error, BUSY, 'pesan server saja');
        assert.equal(busy.backupError, '');
        assert.equal(busy.hint, false, 'tidak menandai Muat ulang');
        assert.equal(busy.calls, 2, 'tidak dicoba ulang otomatis');
        assert.equal(busy.model, 'anthropic/claude-lama', 'editor tidak berubah');
        page.clearProblems(); // the busy 409 is the point of this step
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });

    test('baseHash null tetap dikirim (file config belum ada) pada simpan dan pulihkan', async () => {
      const page = await configPage(vp);
      try {
        await openConfigEditor(page, { view: configView({ hash: null, exists: false }) });
        assert.match(await page.eval(() => document.querySelector('#oc-config-path').textContent), /file baru/);
        await page.eval(() => document.querySelector('#oc-config-save').click());
        await page.waitFor(() => window.__ocfake.posts.some((post) => post.path === '/api/opencode-config/save'), { message: 'simpan terkirim' });
        const saved = await page.eval(() => window.__ocfake.posts.find((post) => post.path === '/api/opencode-config/save').body);
        assert.ok(Object.hasOwn(saved, 'baseHash'), 'properti baseHash selalu ada');
        assert.equal(saved.baseHash, null);

        // Same for restore when the target file is still missing (null is a valid hash there).
        await page.eval(() => { window.__ocfake.view.hash = null; });
        await page.eval(() => document.querySelector('#oc-config-reload').click());
        await page.waitFor(() => document.querySelector('#oc-config-path').textContent.includes('file baru'), { message: 'muat ulang file baru' });
        await page.eval(() => document.querySelector('#oc-history > summary').click());
        await page.waitFor(() => document.querySelector('[data-backup-restore="b1"]'), { message: 'baris backup' });
        await page.eval(() => document.querySelector('[data-backup-restore="b1"]').click());
        await page.waitFor(() => window.__ocfake.posts.some((post) => post.path === '/api/opencode-config/restore'), { message: 'pulihkan terkirim' });
        const restored = await page.eval(() => window.__ocfake.posts.find((post) => post.path === '/api/opencode-config/restore').body);
        assert.ok(Object.hasOwn(restored, 'baseHash'), 'properti baseHash selalu ada');
        assert.equal(restored.baseHash, null);
      } finally {
        await page.close();
      }
    });
  });
}
