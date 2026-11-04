/* global document -- functions passed to page.eval run in the browser */
// UI of the OpenCode config/agent editor: phone and desktop. Throwaway HOME + project, fake OpenCode binary.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        assert.ok(readdirSync(path.dirname(projectFile)).some((f) => /^opencode\.json\.bak-/.test(f)), 'backup written');

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
  });
}
