/* global document -- fungsi page.eval berjalan di dalam browser */
// 🧩 UI Skills: the dialog lists a project's SKILL.md files, opens one for editing, and creates a new one
// (public/js/features/skills.js). Standalone on purpose (like test/worktree-ui.test.mjs): `npm run test:ui:area`
// only selects blocks of test/ui.test.mjs, so this file is run directly with `node --test test/skills-ui.test.mjs`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';
import { describeArea } from '../test-support/ui-area-select.mjs';

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

/** What the dialog actually draws: the DOM is the contract. */
function listView() {
  const modal = document.querySelector('#skills-modal');
  const rows = [...document.querySelectorAll('#skills-list li[data-id]')];
  return {
    visible: Boolean(modal?.getClientRects().length),
    rows: rows.map((li) => ({
      id: li.dataset.id,
      scope: li.dataset.scope,
      description: li.querySelector('p')?.textContent.trim() ?? '',
      canEdit: Boolean(li.querySelector('[data-sk="edit"]')),
    })),
    formVisible: Boolean(document.querySelector('#skills-form')?.getClientRects().length),
  };
}

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-skills-ui-'));
  const projects = path.join(TMP, 'projects');
  const dir = path.join(projects, 'app', '.claude', 'skills', 'hello');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Hello\ndescription: Skill contoh\n---\n\nHalo\n');
  mkdirSync(path.join(TMP, 'claude-projects'));
  mkdirSync(path.join(TMP, 'acp-store'));
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENCODE_')));
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    windowsHide: true,
    env: {
      ...cleanEnv,
      OFFICE_APP_DIR: APP,
      OFFICE_PORT: String(port),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
      OFFICE_GH_BIN: path.join(TMP, 'no-such-gh.exe'),
      OFFICE_UPDATE_CHECK: '0',
      OFFICE_CLAUDE_CHECK_DELAY_MS: '600000',
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      FAKE_ACP_STORE: path.join(TMP, 'acp-store'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 20_000);
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && (clearTimeout(timer), resolve()));
    server.on('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}`))));
  });
  server.stdout.resume();
  server.stderr.resume();
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  projectId = JSON.parse(text.match(/^data: (.*)$/m)[1]).projects.find((p) => p.name === 'app').id;
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill();
    await sleep(500);
  }
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('🧩 UI Skills', { skip: SKIP ?? false }, () => {
  describeArea('UI Skills', { skip: SKIP ?? false }, () => {
    let page;

    before(async () => {
      if (SKIP) return;
      page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900, mobile: false });
      page.clearProblems();
      await page.goto(`${BASE}/#${projectId}`);
      await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok'), { timeoutMs: 20_000, message: 'app terhubung' });
    });

    after(async () => page?.close().catch(() => {}));

    it('dialog: skill project tampil; buat skill baru → muncul di daftar', async () => {
      await page.eval(async () => {
        document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
        (await import('/js/features/skills.js')).openSkills();
      });
      await page.waitFor(() => document.querySelector('#skills-list li[data-id]'), { timeoutMs: 10_000, message: 'daftar skills tampil' });
      let view = await page.eval(listView);
      assert.equal(view.visible, true, 'dialog Skills terbuka');
      const hello = view.rows.find((r) => r.id === 'hello');
      assert.ok(hello, 'skill hello terdaftar');
      assert.equal(hello.description, 'Skill contoh');
      assert.equal(hello.scope, 'project');

      await page.click('#skills-new');
      await page.waitFor(() => document.querySelector('#skills-form')?.getClientRects().length, { timeoutMs: 5_000, message: 'form skill baru tampil' });
      await page.eval(() => {
        document.querySelector('#skills-form [name="skillId"]').value = 'demo';
        document.querySelector('#skills-form [name="description"]').value = 'Skill demo';
        document.querySelector('#skills-form [name="content"]').value = 'Langkah demo\n';
      });
      await page.eval(() => document.querySelector('#skills-form').requestSubmit());
      await page.waitFor(() => [...document.querySelectorAll('#skills-list li[data-id]')].some((li) => li.dataset.id === 'demo'), { timeoutMs: 10_000, message: 'baris demo muncul' });
      view = await page.eval(listView);
      assert.ok(view.rows.find((r) => r.id === 'demo'), 'skill demo tersimpan');
      assert.deepEqual(page.problems, [], 'tanpa error konsol');
    });
  });
});
