// Full server against a fake Claude Code (test-support/fake-claude.mjs): API, security, chat flow,
// permission prompts and interrupts — no network, no tokens, no access to your real data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'office-server-'));
const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let token;
const seen = [];
const waiters = [];
let stream;

before(async () => {
  const projects = path.join(TMP, 'projects');
  mkdirSync(path.join(projects, 'toko', 'src'), { recursive: true });
  writeFileSync(path.join(projects, 'toko', 'src', 'checkout.ts'), 'export {};\n');
  mkdirSync(path.join(TMP, 'claude-projects'));
  server = spawn(process.execPath, [path.join(APP, 'server.js')], {
    env: {
      ...process.env,
      OFFICE_PORT: String(PORT),
      OFFICE_DATA_DIR: path.join(TMP, 'data'),
      PROJECTS_ROOT: projects,
      CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
      CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
      CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
      OFFICE_OPEN_DRY_RUN: '1', // "open in VS Code / folder" reports the command instead of launching it
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('berjalan di') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  token = (await (await fetch(BASE)).text()).match(/office-token" content="([^"]+)"/)[1];
  stream = listen();
});

after(async () => {
  stream?.abort();
  server?.kill();
  await sleep(500);
  rmSync(TMP, { recursive: true, force: true });
});

function listen() {
  const controller = new AbortController();
  (async () => {
    const res = await fetch(`${BASE}/stream`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = frame.match(/^event: (.*)$/m)?.[1];
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (!type || !data) continue;
        const obj = JSON.parse(data);
        seen.push({ type, obj });
        for (const w of [...waiters]) if (w.pred(type, obj)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(obj));
      }
    }
  })();
  return controller;
}

let mark = 0;
function waitFor(pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    for (let i = mark; i < seen.length; i++) if (pred(seen[i].type, seen[i].obj)) return ((mark = i + 1), resolve(seen[i].obj));
    const timer = setTimeout(() => reject(new Error('timeout waiting for event')), ms);
    waiters.push({ pred, resolve: (o) => (clearTimeout(timer), (mark = seen.length), resolve(o)) });
  });
}

function api(p, body = {}, headers = {}) {
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token, ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

/** Request with a forged Host header (fetch can't set Host). */
function rawRequest(headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', headers: { Connection: 'close', ...headers } }, (res) => {
      res.resume(); // drain so the socket closes cleanly
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

const projectId = async () => (await snapshot()).projects.find((p) => p.name === 'toko').id;
async function snapshot() {
  const res = await fetch(`${BASE}/stream`);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
  reader.cancel();
  return JSON.parse(text.match(/^data: (.*)$/m)[1]);
}

test('security: token, origin, host and path checks', async () => {
  assert.equal((await fetch(`${BASE}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await api('/api/demo', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${BASE}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Office-Token': token }, body: '{}' })).status, 415);
  assert.equal(await rawRequest({ Host: 'evil.example' }), 421); // DNS rebinding
  assert.equal((await fetch(`${BASE}/..%2fserver.js`)).status, 404);
  const page = await fetch(BASE);
  assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'self'", 'other sites cannot frame the office (clickjacking)');
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('projects come from the configured root; bad roots are rejected', async () => {
  const snap = await snapshot();
  assert.ok(snap.projects.some((p) => p.name === 'toko'));
  assert.equal((await api('/api/config', { roots: ['Z:/tidak/ada'] })).status, 400);
  const files = await api(`/api/projects/${await projectId()}/files`, { q: 'check' });
  assert.deepEqual(files.body.files, ['src/checkout.ts']);
});

test('a prompt streams a reply and finishes with token stats', async () => {
  const id = await projectId();
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'halo' });
  const user = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'user');
  assert.equal(user.text, 'halo');
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.streaming === true);
  const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(result.ok, true);
  assert.equal(result.meta.tokensIn, 100);
  const final = seen.filter((s) => s.type === 'chat_update' && s.obj.project === id && s.obj.patch.streaming === false).at(-1);
  assert.equal(final.obj.patch.text, 'Halo dari Claude palsu yang sedang mengetik.');
  const status = await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false);
  assert.ok(status.sessionId, 'session id remembered for --resume');
});

test('permission prompts: allow and deny from the web', async () => {
  const id = await projectId();
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'minta izin tulis file' });
  let approval = await waitFor((t, o) => t === 'approval' && o.project === id && o.status === 'pending');
  assert.equal(approval.tool, 'Write');
  assert.equal(approval.canAlways, true);
  assert.equal((await api(`/api/approvals/${approval.id}`, { allow: true })).status, 200);
  assert.equal((await api(`/api/approvals/${approval.id}`, { allow: true })).status, 409, 'cannot decide twice');
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.status === 'ok' && o.patch.output === 'File created successfully');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result' && o.ok);

  await api(`/api/projects/${id}/prompt`, { text: 'izin lagi' });
  approval = await waitFor((t, o) => t === 'approval' && o.project === id && o.status === 'pending');
  await api(`/api/approvals/${approval.id}`, { allow: false, message: 'Jangan' });
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.status === 'fail');
  const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(result.meta.denials, 1);
});

test('stop interrupts a running turn and the session stays usable', async () => {
  const id = await projectId();
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'tugas lama' });
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.streaming === true);
  await api(`/api/projects/${id}/stop`);
  const result = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal(result.ok, false);
  assert.match(result.text, /Dihentikan/);
  await api(`/api/projects/${id}/prompt`, { text: 'halo lagi' });
  assert.equal((await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result')).ok, true);
});

test('phone access: off by default, pairing required, laptop-only settings, revoke', async (t) => {
  const { lanAddresses } = await import('../src/remote.js');
  const ip = lanAddresses()[0];
  if (!ip) return t.skip('no LAN address on this machine');
  const LAN = `http://${ip}:${PORT}`;
  const lan = (p, opts = {}) => fetch(LAN + p, { redirect: 'manual', ...opts });

  assert.equal((await api('/api/remote/pairing')).status, 400, 'no pairing while disabled');
  await assert.rejects(lan('/health'), 'nothing listens on the LAN while disabled');

  assert.equal((await api('/api/remote', { enabled: true })).status, 200);
  await sleep(300);
  assert.equal((await lan('/')).headers.get('location'), '/pair', 'unpaired device is sent to pairing');
  assert.equal((await lan('/stream')).status, 401);
  assert.match(await (await lan('/pair')).text(), /Hubungkan ke Adhit Office/);
  // the app icon and manifest load before pairing (browsers fetch the manifest without cookies)
  const manifest = await lan('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
  assert.equal((await manifest.json()).name, 'Adhit Office');
  assert.equal((await lan('/icons/icon-192.png')).headers.get('content-type'), 'image/png');
  assert.equal((await lan('/js/app.js')).status, 302, 'everything else still needs pairing');

  // 6-digit code
  let pairing = (await api('/api/remote/pairing')).body;
  assert.match(pairing.code, /^\d{6}$/);
  assert.ok(pairing.qrUrl.startsWith(`http://${lanAddresses()[0]}:${PORT}/pair?k=`));
  const tryCode = (code) => lan('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  const wrong = await tryCode(pairing.code === '000000' ? '111111' : '000000');
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).triesLeft, 4);
  const right = await tryCode(pairing.code);
  assert.equal(right.status, 200);
  const cookie = right.headers.get('set-cookie').split(';')[0];
  assert.match(right.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await tryCode(pairing.code)).status, 400, 'codes are single-use');

  // the paired phone can use the office, but not laptop-only settings
  const page = await lan('/', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const phoneToken = (await page.text()).match(/office-token" content="([^"]+)"/)[1];
  const phoneApi = (p, body = {}) => lan(p, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Office-Token': phoneToken }, body: JSON.stringify(body) });
  assert.equal((await phoneApi(`/api/projects/${await projectId()}/files`, { q: 'check' })).status, 200);
  const laptopOnly = ['/api/config', '/api/autostart', '/api/shutdown', '/api/remote', '/api/remote/pairing', '/api/account/login', '/api/account/logout', `/api/projects/${await projectId()}/open`];
  for (const p of laptopOnly) assert.equal((await phoneApi(p, { enabled: false, roots: [] })).status, 403, p);
  // login/logout from a phone needs Tailscale; over plain WiFi it is refused with a clear reason
  const wifiLogout = await phoneApi('/api/account/logout', { confirm: 'LOGOUT' });
  assert.equal(wifiLogout.status, 403);
  assert.match((await wifiLogout.json()).error, /Tailscale/);

  // QR link: one-time key, redirects home with a cookie
  pairing = (await api('/api/remote/pairing')).body;
  const qrPath = new URL(pairing.qrUrl).pathname + new URL(pairing.qrUrl).search;
  const viaQr = await lan(qrPath);
  assert.equal(viaQr.status, 302);
  assert.equal(viaQr.headers.get('location'), '/');
  assert.match(await (await lan(qrPath)).text(), /kedaluwarsa/, 'QR key cannot be reused');

  // brute force: 5 wrong codes rotate the code
  pairing = (await api('/api/remote/pairing')).body;
  for (let i = 0; i < 5; i++) await tryCode(pairing.code === '000000' ? '111111' : '000000');
  assert.equal((await tryCode(pairing.code)).status, 400, 'old code dead after 5 failures');

  // revoke + disable
  const devices = (await snapshot()).config.remote.devices;
  assert.equal(devices.length, 2);
  assert.ok(!JSON.stringify(devices).includes('hash'), 'no secrets sent to browsers');
  for (const d of devices) await api('/api/remote/revoke', { id: d.id });
  assert.equal((await lan('/stream', { headers: { Cookie: cookie } })).status, 401, 'revoked device is out');
  await api('/api/remote', { enabled: false });
  await sleep(300);
  await assert.rejects(lan('/health'), 'LAN listener closed again');
});

test('settings are validated; the demo runs without Claude', async () => {
  const id = await projectId();
  await api(`/api/projects/${id}/settings`, { mode: 'rm -rf', model: 'gpt', effort: '--dangerously-skip-permissions', team: false });
  const snap = await snapshot();
  assert.equal(snap.statuses[id].mode, 'manual');
  assert.equal(snap.statuses[id].model, '');
  assert.equal(snap.statuses[id].effort, '', 'only known effort levels reach the CLI');
  await api(`/api/projects/${id}/settings`, { effort: 'high' });
  assert.equal((await snapshot()).statuses[id].effort, 'high');
  await api(`/api/projects/${id}/settings`, { effort: '' });
  assert.equal(snap.statuses[id].team, false);
  assert.equal((await api('/api/demo')).status, 202);
  await waitFor((t, o) => t === 'chat' && o.project === 'demo' && o.kind === 'assistant');
});

test('account: profile, plan usage and per-account token report', async () => {
  // tokens from the earlier prompts were tagged with the fake CLI's logged-in account
  const acct = (await api('/api/account', { force: true })).body;
  assert.equal(acct.profile.loggedIn, true);
  assert.equal(acct.profile.email, 'tester@example.com');
  assert.ok(acct.usage.today.total >= 105, 'web turns are counted for the logged-in account');

  const limits = (await api('/api/account/limits', { force: true })).body;
  assert.deepEqual(limits.windows[0], { label: 'Current session', percent: 4, resets: 'Oct 31, 10:40am (Asia/Jakarta)' });

  const { accounts, current } = (await api('/api/report/accounts')).body;
  assert.ok(accounts.some((a) => a.id === current && a.email === 'tester@example.com'));
  const mine = (await api('/api/report/summary', { accountId: current })).body;
  assert.ok(mine.records > 0);
  assert.equal(mine.byModel[0].key, 'fake-model');
  assert.equal(mine.totals.cacheRead, mine.records * 90);
  const other = (await api('/api/report/summary', { accountId: 'someone-else@example.com' })).body;
  assert.equal(other.records, 0, 'another account never sees these tokens');
  assert.equal((await api('/api/report/pdf', { accountId: 'someone-else@example.com' })).status, 404);
});

test('team names: validated, shared through the config, empty = default', async () => {
  const res = await api('/api/team', { names: { qa: '  Sinta  ', claude: 'Bos', pm: '', hacker: 'x', backend: '<img src=x>Budi' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.names, { qa: 'Sinta', claude: 'Bos', backend: 'img src=xBudi' }, 'trimmed, unknown roles dropped, no markup');
  assert.deepEqual((await snapshot()).config.teamNames, res.body.names);
  await api('/api/team', { names: {} });
  assert.deepEqual((await snapshot()).config.teamNames, {});
});

test('favorites are stored server-side; "open in VS Code" stays inside the project', async () => {
  const id = await projectId();
  const isFavorite = async () => (await snapshot()).projects.find((p) => p.id === id).favorite;
  assert.equal((await api(`/api/projects/${id}/favorite`, { on: true })).status, 200);
  assert.equal(await isFavorite(), true);
  await api(`/api/projects/${id}/favorite`, { on: false });
  assert.equal(await isFavorite(), false);

  // OFFICE_OPEN_DRY_RUN: the server reports the command instead of launching anything
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  const folder = await api(`/api/projects/${id}/open`, { app: 'folder' });
  assert.equal(folder.status, 200);
  assert.equal(norm(folder.body.args[0]), norm(path.join(TMP, 'projects', 'toko')));
  assert.equal((await api(`/api/projects/${id}/open`, { app: 'code', file: '../../rahasia.txt' })).status, 400, 'files outside the project are refused');
});
