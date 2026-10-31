// Full server against a fake Claude Code (test-support/fake-claude.mjs): API, security, chat flow,
// permission prompts and interrupts — no network, no tokens, no access to your real data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
    // On timeout, say what did arrive: the last events since the mark.
    const recent = () => seen.slice(Math.max(mark, seen.length - 8)).map((s) => `${s.type}:${JSON.stringify(s.obj).slice(0, 160)}`).join('\n  ');
    const timer = setTimeout(() => reject(new Error(`timeout waiting for event; last events:\n  ${recent()}`)), ms);
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
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('security headers: strict CSP (no inline script), no referrer, isolated opener — on pages, assets and API', async () => {
  const csp = (h) => Object.fromEntries(h.get('content-security-policy').split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  const apiRes = await fetch(`${BASE}/api/report/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: '{}' });
  for (const res of [await fetch(BASE), await fetch(`${BASE}/pair`), await fetch(`${BASE}/js/app.js`), await fetch(`${BASE}/health`), apiRes]) {
    const policy = csp(res.headers);
    assert.equal(policy['script-src'], "'self'", 'no inline or foreign scripts');
    assert.equal(policy['default-src'], "'self'");
    assert.equal(policy['object-src'], "'none'");
    assert.equal(policy['base-uri'], "'none'");
    assert.equal(policy['connect-src'], "'self'");
    assert.equal(policy['frame-ancestors'], "'self'", 'other sites cannot frame the office (clickjacking)');
    assert.equal(policy['style-src'], "'self' 'unsafe-inline'", 'style="" attributes and the report <style> keep working');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
  // CSP blocks inline scripts, so no page may carry one (the token <meta> is fine)
  for (const p of ['/', '/pair']) {
    const html = await (await fetch(BASE + p)).text();
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${p}: inline <script>`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${p}: inline event handler`);
  }
  assert.equal((await fetch(`${BASE}/js/pair.js`)).status, 200);
});

test('errors: bad JSON is a 400 with a clear message, never a stack or path', async () => {
  const res = await fetch(`${BASE}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: '{bukan json' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Data JSON tidak valid.' });
});

test('project folders: UNC / device paths are refused before the file system is touched', async () => {
  for (const p of ['\\\\127.0.0.1\\c$', '//127.0.0.1/c$', '\\\\?\\C:\\Windows', '\\\\.\\C:\\', '\\??\\UNC\\server\\share']) {
    const res = await api('/api/projects', { path: p });
    assert.equal(res.status, 400, p);
    assert.match(res.body.error, /jaringan/, p);
  }
  assert.equal((await api('/api/config', { roots: ['\\\\127.0.0.1\\share'] })).status, 400);
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

test('! shell commands run in the project folder and show their output', async () => {
  const id = await projectId();
  mark = seen.length;
  assert.equal((await api(`/api/projects/${id}/shell`, { command: '   ' })).status, 400);
  assert.equal((await api(`/api/projects/${id}/shell`, { command: 'echo halo-shell' })).status, 200);
  const row = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'shell');
  assert.equal(row.text, 'echo halo-shell');
  const done = await waitFor((t, o) => t === 'chat_update' && o.project === id && o.id === row.id && o.patch.status);
  assert.equal(done.patch.status, 'ok');
  assert.match(done.patch.output, /halo-shell/);
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
  assert.equal((await lan('/js/pair.js')).status, 200, 'the pairing page script loads before pairing (no inline script under CSP)');
  const lanPage = await lan('/pair');
  assert.match(lanPage.headers.get('content-security-policy'), /script-src 'self'/, 'the phone gets the same CSP');
  assert.equal(lanPage.headers.get('cross-origin-opener-policy'), null, 'no COOP over plain http://<ip> (ignored there, with a console error)');
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

  // the paired phone can look at the office, but not laptop-only settings
  const page = await lan('/', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const phoneToken = (await page.text()).match(/office-token" content="([^"]+)"/)[1];
  const phoneApi = (p, body = {}) => lan(p, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Office-Token': phoneToken }, body: JSON.stringify(body) });
  const id = await projectId();
  assert.equal((await phoneApi(`/api/projects/${id}/files`, { q: 'check' })).status, 200);
  const laptopOnly = ['/api/config', '/api/autostart', '/api/shutdown', '/api/remote', '/api/remote/pairing', '/api/account/login', '/api/account/logout', '/api/projects', `/api/projects/${id}/open`];
  for (const p of laptopOnly) assert.equal((await phoneApi(p, { enabled: false, roots: [] })).status, 403, p);
  // login/logout from a phone needs Tailscale; over plain WiFi it is refused with a clear reason
  const wifiLogout = await phoneApi('/api/account/logout', { confirm: 'LOGOUT' });
  assert.equal(wifiLogout.status, 403);
  assert.match((await wifiLogout.json()).error, /Tailscale/);

  // plain WiFi (this test connects from a LAN address, not Tailscale) is read-only:
  // the snapshot says so, reading works, every action is refused by the one gate in handler()
  const phoneSnap = await (async () => {
    const res = await lan('/stream', { headers: { Cookie: cookie } });
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value);
    reader.cancel();
    return JSON.parse(text.match(/^data: (.*)$/m)[1]);
  })();
  const { readOnlyApi, ...access } = phoneSnap.client;
  assert.deepEqual(access, { local: false, accountAuth: false, readOnly: true });
  // the UI's guard uses the server's own allowlist from the snapshot (no copy of the rules in app code)
  assert.ok(readOnlyApi.paths.length && readOnlyApi.patterns.length, 'snapshot carries the read-only allowlist');
  const uiAllows = (p) => readOnlyApi.paths.includes(p) || readOnlyApi.patterns.some((source) => new RegExp(source).test(p));
  assert.equal((await snapshot()).client.readOnly, false, 'the laptop is never read-only');
  const reads = ['/api/account', '/api/account/limits', '/api/report/accounts', '/api/report/summary', `/api/projects/${id}/changes`, `/api/projects/${id}/diff`, `/api/projects/${id}/sessions`, `/api/projects/${id}/rewind-points`, `/api/projects/${id}/task-output`];
  for (const p of reads) assert.notEqual((await phoneApi(p, { taskId: 'x' })).status, 403, `read ${p}`);
  for (const p of reads) assert.ok(uiAllows(p), `UI lets ${p} through`);
  // a read-only phone can't make the laptop re-run the Claude CLI: `force` is ignored, the cached answer comes back
  const cachedLimits = await (await phoneApi('/api/account/limits', {})).json();
  assert.ok(cachedLimits.at, 'limits were loaded');
  await new Promise((r) => setTimeout(r, 5)); // a fresh CLI run would get a later `at`
  assert.equal((await (await phoneApi('/api/account/limits', { force: true })).json()).at, cachedLimits.at, 'force from WiFi reuses the cache');
  const actions = [
    ...['prompt', 'shell', 'settings', 'commit', 'rewind', 'rewind-preview', 'mcp', 'mcp-action', 'task-stop', 'background', 'stop', 'reset', 'resume', 'forget', 'favorite', 'rename'].map((a) => `/api/projects/${id}/${a}`),
    '/api/approvals/abc',
    '/api/team',
    '/api/demo',
    '/api/projects/refresh',
    '/api/account/login/code',
    '/api/account/login/cancel',
    '/api/not-yet-written', // default deny: an endpoint nobody listed is refused too
  ];
  for (const p of actions) {
    const res = await phoneApi(p, { text: 'rm -rf /', command: 'whoami', allow: true, mode: 'dontAsk', message: 'x', uuid: 'x', on: true, names: { qa: 'X' } });
    assert.equal(res.status, 403, p);
    const body = await res.json();
    assert.ok(body.readOnly || /laptop|Tailscale/.test(body.error), `${p}: ${body.error}`);
  }
  for (const p of actions) assert.ok(!uiAllows(p), `UI holds back ${p}`);
  const refused = await (await phoneApi(`/api/projects/${id}/prompt`, { text: 'halo' })).json();
  assert.equal(refused.error, 'Lewat WiFi hanya bisa melihat. Pakai laptop atau Tailscale untuk mengirim perintah.');
  assert.equal((await snapshot()).projects.find((p) => p.id === id).favorite, false, 'nothing changed');

  // QR link: one-time key, redirects home with a cookie
  pairing = (await api('/api/remote/pairing')).body;
  const qrPath = new URL(pairing.qrUrl).pathname + new URL(pairing.qrUrl).search;
  const viaQr = await lan(qrPath);
  assert.equal(viaQr.status, 302);
  assert.equal(viaQr.headers.get('location'), '/');
  assert.match(await (await lan(qrPath)).text(), /kedaluwarsa/, 'QR key cannot be reused');

  // POST /pair is reachable unpaired: a tiny body limit, not the 30 MB of prompts
  const huge = await lan('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '1'.repeat(4096) }) }).catch((err) => err);
  assert.equal(huge.status, 413, `oversized pairing body refused (${huge})`);

  // brute force: 5 wrong codes rotate the code, the laptop is told at once, and the guessing IP waits
  pairing = (await api('/api/remote/pairing')).body;
  mark = seen.length;
  for (let i = 0; i < 5; i++) await tryCode(pairing.code === '000000' ? '111111' : '000000');
  await waitFor((t) => t === 'pairing-reset', 3000); // the laptop's 📱 dialog fetches a new code right away
  const locked = await tryCode(pairing.code);
  assert.equal(locked.status, 429, 'this IP is locked out after 5 failures');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.match((await locked.json()).error, /Coba lagi dalam \d+ detik/);
  const fresh = (await api('/api/remote/pairing')).body;
  assert.notEqual(fresh.code + fresh.key, pairing.code + pairing.key, 'a new code after the old one died');
  assert.equal((await tryCode(fresh.code)).status, 429, 'even the right new code waits out the lockout');

  // revoke: the phone's open event stream is cut right away, not at its next reconnect
  const live = await lan('/stream', { headers: { Cookie: cookie } });
  assert.equal(live.status, 200);
  const liveReader = live.body.getReader();
  await liveReader.read(); // snapshot
  const devices = (await snapshot()).config.remote.devices;
  assert.equal(devices.length, 2);
  assert.ok(!JSON.stringify(devices).includes('hash'), 'no secrets sent to browsers');
  for (const d of devices) await api('/api/remote/revoke', { id: d.id });
  const cut = await Promise.race([
    (async () => {
      for (;;) {
        const { done } = await liveReader.read().catch(() => ({ done: true }));
        if (done) return 'closed';
      }
    })(),
    sleep(3000).then(() => 'still open'),
  ]);
  assert.equal(cut, 'closed', 'revoked device stops receiving the office immediately');
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

// ---------- Claude Code's control protocol (what the IDE extensions use) ----------

/** The final text of the next assistant reply in this project. */
const nextReply = (id, pattern) => waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.streaming === false && pattern.test(o.patch.text ?? ''));

test('catalog: the models of /model and the described slash commands come from Claude Code', async () => {
  let config;
  for (let i = 0; i < 50 && !config?.models?.length; i++) {
    config = (await snapshot()).config;
    if (!config.models?.length) await sleep(100);
  }
  assert.ok(config.models.some((m) => m.value === 'fable' && m.displayName === 'Fable 5.1'), 'Fable is offered');
  assert.ok(config.commands.some((c) => c.name === 'fake-skill' && c.description === 'Skill palsu untuk tes'));
  assert.equal(config.cliVersion, '9.9.9-fake');
});

test('mode, model and effort switch live in the running Claude Code, without a restart', async () => {
  const id = await projectId();
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'status?' });
  const pid = (await nextReply(id, /pid=\d+/)).patch.text.match(/pid=(\d+)/)[1];
  await api(`/api/projects/${id}/settings`, { mode: 'acceptEdits', model: 'fable', effort: 'high' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'status?' });
  const reply = (await nextReply(id, /pid=\d+/)).patch.text;
  assert.match(reply, /mode=acceptEdits model=fable effort=high/);
  assert.equal(reply.match(/pid=(\d+)/)[1], pid, 'same process: nothing restarted');

  // Claude Code refuses an unknown model: the app goes back to the one that works, as /model does.
  mark = seen.length;
  await api(`/api/projects/${id}/settings`, { model: 'claude-tidak-ada' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'error' && /Gagal mengganti model/.test(o.text));
  assert.equal((await snapshot()).statuses[id].model, 'fable', 'back to the model that works');
  assert.equal((await api(`/api/projects/${id}/settings`, { model: '--dangerously-skip-permissions' })).status, 200);
  assert.equal((await snapshot()).statuses[id].model, 'fable', 'flags never pass as a model');
});

test("a prompt sent mid-turn waits in Claude Code's queue; Esc drops it and stops the turn", async () => {
  const id = await projectId();
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'tugas lama' });
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.patch.streaming === true);
  await api(`/api/projects/${id}/prompt`, { text: 'pesan susulan' });
  const followUp = await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'user' && o.text === 'pesan susulan');
  assert.equal(followUp.queued, true);
  assert.match(followUp.uuid, /^[0-9a-f-]{36}$/, 'prompts carry the uuid Claude Code knows them by');
  await api(`/api/projects/${id}/stop`);
  await waitFor((t, o) => t === 'chat_update' && o.project === id && o.id === followUp.id && o.patch.cancelled === true);
  assert.equal((await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result')).ok, false);
  await waitFor((t, o) => t === 'status' && o.project === id && o.busy === false && o.queue === 0);
});

test('approving a plan picks the mode the work continues in, like the CLI plan dialog', async () => {
  const id = await projectId();
  await api(`/api/projects/${id}/settings`, { mode: 'plan' });
  mark = seen.length;
  await api(`/api/projects/${id}/prompt`, { text: 'buat rencana' });
  const approval = await waitFor((t, o) => t === 'approval' && o.project === id && o.kind === 'plan' && o.status === 'pending');
  await api(`/api/approvals/${approval.id}`, { allow: true, mode: 'acceptEdits' });
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'result');
  assert.equal((await snapshot()).statuses[id].mode, 'acceptEdits');
});

test('rewind: points from the transcript chain, code via checkpoints, conversation via --resume-session-at', async () => {
  const id = await projectId();
  const snap = await snapshot();
  const sessionId = snap.statuses[id].sessionId;
  const project = snap.projects.find((p) => p.id === id);
  const dir = path.join(TMP, 'claude-projects', path.resolve(project.path).replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const [u1, a1, u2, a2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const entry = (type, uuid, parentUuid, content) => JSON.stringify({ type, uuid, parentUuid, sessionId, timestamp: new Date().toISOString(), message: { role: type, content } });
  writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `${[entry('user', u1, null, 'pertama'), entry('assistant', a1, u1, [{ type: 'text', text: 'ok' }]), entry('user', u2, a1, 'kedua'), entry('assistant', a2, u2, [{ type: 'text', text: 'ok' }])].join('\n')}\n`,
  );
  const { points } = (await api(`/api/projects/${id}/rewind-points`)).body;
  assert.deepEqual(points.map((p) => p.text), ['kedua', 'pertama'], 'newest first');
  assert.deepEqual((await api(`/api/projects/${id}/rewind-preview`, { uuid: u2 })).body.filesChanged, ['catatan.txt']);
  assert.equal((await api(`/api/projects/${id}/rewind`, { uuid: randomUUID(), code: true })).status, 400, 'only prompts of this conversation');

  mark = seen.length;
  const done = (await api(`/api/projects/${id}/rewind`, { uuid: u2, code: true, conversation: true })).body;
  assert.equal(done.text, 'kedua', 'the prompt comes back to edit');
  await waitFor((t, o) => t === 'chat' && o.project === id && o.kind === 'divider' && /Kode & percakapan/.test(o.text));
  assert.deepEqual((await api(`/api/projects/${id}/rewind-points`)).body.points.map((p) => p.text), ['pertama'], 'the conversation now ends before "kedua"');
  await api(`/api/projects/${id}/prompt`, { text: 'status?' });
  assert.match((await nextReply(id, /resumeAt=/)).patch.text, new RegExp(`resumeAt=${a1}`), 'resumed at the entry before the prompt');
});

test('MCP servers, background tasks and rename are Claude Code control requests', async () => {
  const id = await projectId();
  const { servers } = (await api(`/api/projects/${id}/mcp`)).body;
  assert.deepEqual(servers.map((s) => [s.name, s.status, s.tools]), [['fake-mcp', 'connected', 2], ['auth-mcp', 'needs-auth', null]]);
  assert.equal((await api(`/api/projects/${id}/mcp-action`, { server: 'fake-mcp', action: 'reconnect' })).status, 200);
  assert.equal((await api(`/api/projects/${id}/mcp-action`, { server: 'fake-mcp', action: 'hapus' })).status, 400);
  assert.equal((await api(`/api/projects/${id}/mcp-action`, { server: 'auth-mcp', action: 'login' })).body.authUrl, 'https://example.com/oauth');
  assert.equal((await api(`/api/projects/${id}/mcp-action`, { server: 'auth-mcp', action: 'callback', callbackUrl: 'javascript:alert(1)' })).status, 400);
  assert.match((await api(`/api/projects/${id}/task-output`, { taskId: 't1' })).body.output, /3000/);
  assert.equal((await api(`/api/projects/${id}/rename`, { title: '  ' })).status, 400);
  assert.equal((await api(`/api/projects/${id}/rename`, { title: 'Sesi uji' })).status, 200);
});
