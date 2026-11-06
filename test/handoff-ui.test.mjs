/* global document -- functions passed to page.eval run in the browser */
// "Lanjutkan dari mesin lain" UI: one Terapkan button, no mode/preview, and the context-only trigger immediately
// appears in the session. Phone and desktop.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HANDOFF_TRIGGER_PROMPT } from '../src/handoff.js';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const horizontalOverflow = () => document.documentElement.scrollWidth > document.documentElement.clientWidth;

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

const snapshot = async () => {
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
};
const until = async (pred, message) => {
  for (let i = 0; i < 100; i++) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(message);
};

before(async () => {
  if (SKIP) return;
  TMP = mkdtempSync(path.join(tmpdir(), 'office-handoff-ui-'));
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko'), { recursive: true });
  mkdirSync(path.join(TMP, 'claude-projects'));
  mkdirSync(path.join(TMP, 'acp-store'));
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
      OPENCODE_BIN: path.join(APP, 'test-support', 'fake-acp.mjs'),
      FAKE_ACP_STORE: path.join(TMP, 'acp-store'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
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
  // Seed a stored OpenCode chat directly: the target project stays on Claude, so no engine switch/live turn is needed.
  const source = path.join(TMP, 'data', 'chats-opencode');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    path.join(source, `${projectId}.jsonl`),
    `${[{ id: 'ho-m1', kind: 'user', text: 'pekerjaan dari OpenCode', ts: Date.now() - 20_000 }, { id: 'ho-m2', kind: 'assistant', text: 'konteks OpenCode selesai', ts: Date.now() - 10_000 }].map((m) => JSON.stringify(m)).join('\n')}\n`,
  );
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close();
  server?.kill();
  await sleep(400);
  if (TMP) rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

for (const vp of VIEWPORTS) {
  describe(`Handoff — ${vp.name}`, () => {
    test('one Terapkan button immediately sends the context-only trigger', async () => {
      const page = await browser.newPage({ width: vp.width, height: vp.height, mobile: vp.mobile });
      try {
        page.clearProblems();
        await page.goto(`${BASE}/#${projectId}`);
        await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok') && document.querySelector('[data-more="handoff"]'), { timeoutMs: 10000, message: 'app ready' });
        await page.eval(() => document.querySelector('#more-menu [data-more="handoff"]').click());
        await page.waitFor(() => !document.querySelector('#handoff-modal').hidden && document.querySelector('[data-ho="apply"]'), { timeoutMs: 8000, message: 'dialog handoff' });
        assert.deepEqual(await page.eval(() => ({ apply: document.querySelectorAll('#handoff-body [data-ho="apply"]').length, modes: document.querySelectorAll('#handoff-body .handoff-mode').length, preview: Boolean(document.querySelector('#handoff-text')) })), { apply: 1, modes: 0, preview: false });
        const beforeApply = (await snapshot()).chats[projectId]?.filter((m) => m.kind === 'result').length ?? 0;
        await page.eval(() => document.querySelector('[data-ho="apply"]').click());
        await page.waitFor(() => document.querySelector('#handoff-modal').hidden, { timeoutMs: 8000, message: 'dialog ditutup' });
        await page.waitFor((text) => [...document.querySelectorAll('.msg.user .body')].some((m) => m.textContent === text), { timeoutMs: 10000, message: 'trigger prompt di chat' }, HANDOFF_TRIGGER_PROMPT);
        await until(async () => ((await snapshot()).chats[projectId]?.filter((m) => m.kind === 'result').length ?? 0) > beforeApply, 'context turn done');
        await until(async () => {
          const st = (await snapshot()).statuses[projectId];
          return st && !st.busy;
        }, 'context turn idle');
        assert.deepEqual((await snapshot()).approvals, [], 'no approval left open');
        assert.equal(await page.eval(horizontalOverflow), false);
        assert.deepEqual(page.problems, [], 'no console errors');
      } finally {
        await page.close();
      }
    });
  });
}
