/* global document, window -- functions passed to page.eval run in the browser */
// 🎭 Output style dialog: built-in + custom styles, select, create/edit/delete, and the "active style" guard.
// Real server with a throwaway project and CLAUDE_CONFIG_DIR, fake Claude binary, no network.
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
  const card = document.querySelector('#output-style-modal .modal-card');
  return card ? card.scrollWidth > card.clientWidth + 1 : false;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

const waitFile = async (file, re, message) => {
  for (let i = 0; i < 80; i++) {
    if (existsSync(file) && re.test(readFileSync(file, 'utf8'))) return;
    await sleep(100);
  }
  throw new Error(message);
};
const waitGone = async (file, message) => {
  for (let i = 0; i < 80; i++) {
    if (!existsSync(file)) return;
    await sleep(100);
  }
  throw new Error(message);
};

let TMP;
let BASE;
let server;
let browser;
let projectId;
let projectDir;

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-os-ui-'));
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

const settingsFile = () => path.join(projectDir, '.claude', 'settings.local.json');
const styleFile = (slug) => path.join(projectDir, '.claude', 'output-styles', `${slug}.md`);

// Both viewports share one project and one project-local setting, so they run in ONE test, one after the other,
// each starting from a clean `.claude` folder (two concurrent suites would fight over the same outputStyle).
test('pilih, buat, edit, tolak hapus gaya aktif, lalu hapus setelah ganti — mobile & desktop', async () => {
  for (const vp of VIEWPORTS) {
    rmSync(path.join(projectDir, '.claude'), { recursive: true, force: true });
    const page = await browser.newPage({ width: vp.width, height: vp.height, mobile: vp.mobile });
    try {
      page.clearProblems();
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 10000, message: 'app ready' });

      // The /output-style command opens the same dialog (no argument).
      await page.eval(() => {
        const box = document.querySelector('#prompt');
        box.focus();
        box.value = '/output-style';
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.press('Enter');
      await page.press('Enter');
      await page.waitFor(() => !document.querySelector('#output-style-modal').hidden, { message: 'dialog from /output-style' });
      await page.eval(() => document.querySelector('#output-style-modal [data-close]').click());
      await page.waitFor(() => document.querySelector('#output-style-modal').hidden, { message: 'dialog closed' });

      // The menu item opens the dialog; the built-in five styles are always offered.
      await page.eval(() => document.querySelector('[data-more="style"]').click());
      await page.waitFor(() => !document.querySelector('#output-style-modal').hidden && document.querySelectorAll('#os-list li').length === 5, { message: 'dialog + 5 built-in styles' });
      assert.equal(await page.eval(() => document.querySelectorAll('#os-list [data-os-edit]').length), 0, 'built-ins are not editable');

      // Selecting a built-in writes the project's local setting only.
      await page.eval(() => document.querySelector('[data-os-use="Concise"]').click());
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Output style: Concise/.test(t.textContent)), { message: 'select toast' });
      await waitFile(settingsFile(), /"outputStyle": "Concise"/, 'settings.local.json');
      assert.equal(JSON.parse(readFileSync(settingsFile(), 'utf8')).outputStyle, 'Concise');

      // Create a custom style; the server writes the Markdown file with frontmatter.
      await page.eval(() => document.querySelector('#os-new').click());
      await page.waitFor(() => document.querySelector('#os-form') && !document.querySelector('#os-form').hidden, { message: 'new style form' });
      await page.eval(() => {
        const set = (id, value) => {
          const el = document.querySelector(id);
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('#os-name', 'Diagram dulu');
        set('#os-description', 'Mulai dengan diagram');
        document.querySelector('#os-keep').checked = true;
        set('#os-instructions', 'Mulai penjelasan dengan diagram.\n');
        document.querySelector('#os-save').click();
      });
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Gaya "Diagram dulu" tersimpan/.test(t.textContent)), { message: 'create toast' });
      await waitFile(styleFile('diagram-dulu'), /keep-coding-instructions: true/, 'style file');
      const created = readFileSync(styleFile('diagram-dulu'), 'utf8');
      assert.match(created, /^---\nname: "Diagram dulu"\ndescription: "Mulai dengan diagram"\nkeep-coding-instructions: true\n---\n\nMulai penjelasan dengan diagram\.\n$/);
      await page.waitFor(() => document.querySelectorAll('#os-list [data-os-edit]').length === 1, { message: 'custom row' });

      // Edit it: the form is filled from the file, and saving updates the same file.
      await page.eval(() => document.querySelector('[data-os-edit="diagram-dulu"]').click());
      await page.waitFor(() => document.querySelector('#os-name')?.value === 'Diagram dulu', { message: 'edit form loaded' });
      await page.eval(() => {
        const body = document.querySelector('#os-instructions');
        body.value = 'Selalu mulai dengan diagram mermaid.\n';
        body.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#os-save').click();
      });
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Gaya "Diagram dulu" tersimpan/.test(t.textContent)), { message: 'edit toast' });
      await waitFile(styleFile('diagram-dulu'), /Selalu mulai dengan diagram mermaid/, 'edited style file');

      // A style that is in use cannot be deleted: pick it first, then try.
      await page.waitFor(() => document.querySelector('[data-os-use="Diagram dulu"]'), { message: 'custom row after edit' });
      await page.eval(() => document.querySelector('[data-os-use="Diagram dulu"]').click());
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Output style: Diagram dulu/.test(t.textContent)), { message: 'use custom toast' });
      await page.eval(() => {
        window.confirm = () => true;
        document.querySelector('[data-os-delete="diagram-dulu"]').click();
      });
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Ganti dulu gaya yang sedang dipakai/.test(t.textContent)), { message: 'active delete refused' });
      assert.ok(existsSync(styleFile('diagram-dulu')), 'the active style is still there');
      page.clearProblems(); // the 409 above is the point of this step

      // Switch back to Default, then the delete goes through (with a backup on the server).
      await page.eval(() => document.querySelector('[data-os-use="default"]').click());
      await page.waitFor(() => [...document.querySelectorAll('.toast')].some((t) => /Output style: Default/.test(t.textContent)), { message: 'default toast' });
      await page.waitFor(() => document.querySelector('[data-os-delete="diagram-dulu"]'), { message: 'delete button after reload' });
      await page.eval(() => document.querySelector('[data-os-delete="diagram-dulu"]').click());
      await waitGone(styleFile('diagram-dulu'), 'style file deleted');
      assert.equal(JSON.parse(readFileSync(settingsFile(), 'utf8')).outputStyle, undefined, 'default removes the key');

      assert.equal(await page.eval(horizontalOverflow), false);
      assert.equal(await page.eval(modalOverflow), false);
      assert.deepEqual(page.problems, [], 'no console errors');
    } finally {
      await page.close();
    }
  }
});
