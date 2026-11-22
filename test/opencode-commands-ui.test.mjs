/* global document, window, location -- functions passed to page.eval run in the browser */
// 📝 OpenCode commands dialog: list, create, edit, delete real files under <project>/.opencode/commands.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = cdpUnavailableReason();
const VIEWPORTS = [
  { name: 'mobile 390x844', width: 390, height: 844, mobile: true },
  { name: 'desktop 1440x900', width: 1440, height: 900, mobile: false },
];

const horizontalOverflow = () => document.documentElement.scrollWidth > document.documentElement.clientWidth;
const modalOverflow = () => {
  const card = document.querySelector('#oc-commands-modal .modal-card');
  return card ? card.scrollWidth > card.clientWidth + 1 : false;
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

let TMP;
let BASE;
let server;
let browser;
let projectId;
let projectDir;

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-occ-ui-'));
  const projects = path.join(TMP, 'projects');
  projectDir = path.join(projects, 'toko');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...process.env,
      OFFICE_APP_DIR: APP,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
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

const commandFile = (id) => path.join(projectDir, '.opencode', 'commands', ...id.split('/')) + '.md';
const waitFile = async (file, re, message) => {
  for (let i = 0; i < 80; i++) {
    if (existsSync(file) && re.test(readFileSync(file, 'utf8'))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(message);
};
const waitGone = async (file, message) => {
  for (let i = 0; i < 80; i++) {
    if (!existsSync(file)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(message);
};

/** ⚙ → Sistem → Config OpenCode, after switching this project to the OpenCode engine. */
async function openConfig(page) {
  await page.goto(`${BASE}/#${projectId}`);
  await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000, message: 'app ready' });
  await page.eval(async () => {
    const token = document.querySelector('meta[name="office-token"]').content;
    await fetch(`/api/projects/${location.hash.slice(1)}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Office-Token': token },
      body: JSON.stringify({ engine: 'opencode' }),
    });
  });
  await page.eval(() => document.querySelector('#btn-settings').click());
  await page.eval(() => document.querySelector('[data-settings-tab="sistem"]')?.click());
  await page.waitFor(() => !document.querySelector('#settings-modal').hidden && document.querySelector('#oc-config-open')?.getClientRects().length, { message: 'settings loaded' });
  await page.eval(() => document.querySelector('#oc-config-open').click());
  await page.waitFor(() => !document.querySelector('#oc-config-modal').hidden, { message: 'config modal' });
}

test('kelola command OpenCode: buat, edit, hapus — mobile & desktop', async () => {
  for (const vp of VIEWPORTS) {
    rmSync(path.join(projectDir, '.opencode'), { recursive: true, force: true });
    const page = await browser.newPage({ width: vp.width, height: vp.height, mobile: vp.mobile });
    try {
      page.clearProblems();
      await openConfig(page);
      await page.eval(() => document.querySelector('#oc-commands-open').click());
      await page.waitFor(() => !document.querySelector('#oc-commands-modal').hidden, { message: 'commands modal' });
      await page.waitFor(() => /Belum ada command/.test(document.querySelector('#oc-commands-body').textContent), { message: 'empty list' });

      await page.eval(() => document.querySelector('#oc-command-new').click());
      await page.waitFor(() => document.querySelector('#oc-command-id'), { message: 'new form' });
      await page.eval(() => {
        const set = (id, value) => {
          const el = document.querySelector(id);
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('#oc-command-id', 'review');
        set('#oc-command-description', 'Review perubahan');
        set('#oc-command-agent', 'build');
        set('#oc-command-template', 'Review $ARGUMENTS\n');
        document.querySelector('#oc-command-save').click();
      });
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Command "review" tersimpan/.test(t.textContent)), { message: 'create toast' });
      await waitFile(commandFile('review'), /description: Review perubahan/, 'created command file');
      await page.waitFor(() => document.querySelector('[data-cmd-edit="review"]'), { message: 'row after create' });

      await page.eval(() => document.querySelector('[data-cmd-edit="review"]').click());
      await page.waitFor(() => document.querySelector('#oc-command-template')?.value.includes('Review $ARGUMENTS'), { message: 'edit form' });
      await page.eval(() => {
        const template = document.querySelector('#oc-command-template');
        template.value = 'Review dengan teliti.\n';
        template.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#oc-command-save').click();
      });
      await waitFile(commandFile('review'), /Review dengan teliti/, 'edited command file');

      await page.waitFor(() => document.querySelector('[data-cmd-delete="review"]'), { message: 'row after edit' });
      await page.eval(() => {
        window.confirm = () => true;
        document.querySelector('[data-cmd-delete="review"]').click();
      });
      await waitGone(commandFile('review'), 'deleted command file');
      await page.waitFor(() => /Belum ada command/.test(document.querySelector('#oc-commands-body').textContent), { message: 'empty again' });

      assert.equal(await page.eval(horizontalOverflow), false);
      assert.equal(await page.eval(modalOverflow), false);
      assert.deepEqual(page.problems, [], 'no console errors');
    } finally {
      await page.close();
    }
  }
});
