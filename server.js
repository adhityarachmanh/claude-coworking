// Adhit Office server: runs headless Claude Code per project and serves the office web app.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaude } from './src/claude-bin.js';
import { runDemo } from './src/demo.js';
import { DEMO_ID, Hub } from './src/hub.js';
import { discoverProjects, isDirectory } from './src/projects.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { AccountService } from './src/account.js';
import { autostartStatus, setAutostart } from './src/autostart.js';
import { renderPdf, reportHtml } from './src/report.js';
import { UsageLedger, summarize, totals } from './src/usage.js';
import { searchFiles } from './src/files.js';
import { gitCommit, gitDiff, gitStatus } from './src/git.js';
import { openInApp } from './src/open.js';
import { TranscriptMirror } from './src/mirror.js';
import { DEVICE_COOKIE, RemoteAccess, isTailscaleIp, lanAddresses, networkAddresses } from './src/remote.js';
import { listSessions, sessionHistory } from './src/transcripts.js';
import { ROLE_IDS, loadAgentDefinitions } from './src/roles.js';
import { SessionManager } from './src/session.js';

const PORT = Number(process.env.OFFICE_PORT ?? 4317);
const HOST = '127.0.0.1';
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
// Used until roots are set in the web UI: env, else the folder this app lives in.
const DEFAULT_ROOT = path.resolve(process.env.PROJECTS_ROOT ?? path.dirname(APP_DIR));
const MAX_BODY = 30 * 1024 * 1024; // prompts may carry pasted images
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Built-ins that work headless; the full list (skills, custom commands) arrives from Claude Code itself.
const DEFAULT_SLASH = ['compact', 'context', 'cost', 'init', 'review'];
// Per-start secret: only pages served by this process can call the API (blocks CSRF from other sites).
const TOKEN = randomBytes(24).toString('hex');

const TEAM_PROMPT = `You are the Engineering Lead of an IT team that the user watches live in the "Adhit Office" pixel office.
Delegate focused work to the specialist subagents with the Agent tool, but only to the roles a task actually needs:
each delegation costs time and tokens, so do small or trivial work yourself.
- pm: scope, priorities, acceptance criteria, task breakdown
- ba: requirements, business rules, analysis of existing code and documents
- architect: technical design, architecture decisions, code review of diffs
- ui-ux: user flows, UI design, styling, accessibility
- frontend: UI implementation (components, pages, client state)
- backend: APIs, business logic, integrations, server-side fixes
- dba: schema, migrations, queries, data fixes, database performance
- qa: test plans, automated tests, bug reproduction, verification
- security: security review, vulnerabilities, secrets, dependency audit
- devops: build, CI/CD, Docker, deployment, environment and config issues
- writer: README, API docs, changelog, user guides
Typical flows:
- New feature: pm → ba → architect → ui-ux → frontend/backend/dba → qa → security (when auth, input or data is touched) → writer.
- Bug fix: qa reproduces it (ideally a failing test) → the owning frontend/backend/dba fixes the root cause → architect reviews the diff → qa verifies.
- Build/deploy/incident: devops first, then backend or dba as needed, qa verifies.
Run independent pieces in parallel when they do not touch the same files. Reply in the user's language.`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// Started hidden at Windows login: there is no console, so keep a log file instead.
if (process.argv.includes('--background')) {
  const logFile = path.join(APP_DIR, 'data', 'server.log');
  mkdirSync(path.dirname(logFile), { recursive: true });
  const write = (level) => (...args) => appendFileSync(logFile, `[${new Date().toISOString()}] ${level} ${args.map(String).join(' ')}\n`);
  console.log = write('INFO');
  console.error = write('ERROR');
}

// OFFICE_DATA_DIR lets tests run against a throwaway state file.
const DATA_DIR = process.env.OFFICE_DATA_DIR ?? path.join(APP_DIR, 'data');
const hub = new Hub({ dataDir: DATA_DIR });
const claude = findClaude();
const agents = loadAgentDefinitions(path.join(APP_DIR, '.claude', 'agents'));

let lastAccountId;
const account = new AccountService({
  claude,
  onChange: (state) => {
    hub.broadcast('account', state);
    // Switched or logged out: idle Claude processes still hold the old credentials.
    const id = account.current?.id ?? null;
    if (lastAccountId !== undefined && id !== lastAccountId) sessions.accountChanged();
    lastAccountId = id;
  },
});
const ledger = new UsageLedger({ file: path.join(DATA_DIR, 'usage.jsonl'), account: () => account.current });
const sessions = new SessionManager({ hub, claude, agents, teamPrompt: TEAM_PROMPT, ledger, account });
const mirror = new TranscriptMirror(hub, { ledger });
const remote = new RemoteAccess(hub);

const projectRoots = () => (hub.persisted.roots.length ? hub.persisted.roots : [DEFAULT_ROOT]);

/** Rescans all sources. Folders no longer under any root drop out (unless Claude Code or the user added them). */
function refreshProjects() {
  const wasReady = hub.ready;
  hub.ready = false; // one broadcast at the end instead of one per folder
  for (const project of hub.projects.values()) project.sources = project.sources.filter((s) => s !== 'folder' && s !== 'claude');
  for (const [dir, source] of discoverProjects({ roots: projectRoots() })) hub.upsertProject(dir, source);
  for (const dir of hub.persisted.custom) if (isDirectory(dir)) hub.upsertProject(dir, 'custom');
  for (const [id, project] of hub.projects) if (!project.sources.length && !hub.runtime.get(id)?.status.busy) hub.projects.delete(id);
  hub.config = {
    roots: projectRoots(),
    defaultRoot: DEFAULT_ROOT,
    usingDefault: !hub.persisted.roots.length,
    slashCommands: [...new Set([...DEFAULT_SLASH, ...(hub.persisted.slashCommands ?? [])])].sort(),
    autostart: autostartStatus(),
    remote: remote.publicInfo(PORT),
    teamNames: hub.persisted.teamNames ?? {},
  };
  hub.ready = wasReady;
  hub.broadcast('config', hub.config);
  hub.broadcast('projects', hub.listProjects());
}

// ---------- http helpers ----------

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Settings that only the laptop itself may change, never a paired phone.
const LOCAL_ONLY = new Set(['/api/autostart', '/api/shutdown', '/api/config']);
// Login/logout switch the account of every Claude Code on the laptop: from a phone only over
// Tailscale (encrypted), never over plain-HTTP WiFi where the device cookie could be sniffed.
const ACCOUNT_AUTH = new Set(['/api/account/login', '/api/account/login/code', '/api/account/login/cancel', '/api/account/logout']);
const LOGOUT_CONFIRM = 'LOGOUT';
// Opening VS Code / Explorer only makes sense on the laptop itself.
const LOCAL_ONLY_ACTION = /^\/api\/projects\/[\w-]+\/open$/;
const PUBLIC_ASSET = /^\/(manifest\.webmanifest|icons\/[\w.-]+)$/;

const isLocal = (req) => LOOPBACK.has(req.socket.remoteAddress);
/** What this browser may do with the Claude account: laptop, or a paired phone over Tailscale. */
const canManageAccount = (req) => isLocal(req) || isTailscaleIp(req.socket.remoteAddress);

/** Host names we answer to (DNS-rebinding guard); LAN addresses only while phone access is on. */
function allowedHosts() {
  const hosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  if (remote.enabled) for (const ip of lanAddresses()) hosts.push(`${ip}:${PORT}`);
  return hosts;
}

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value)
      .map(([key, ...rest]) => [key, decodeURIComponent(rest.join('='))]),
  );
}

function publishConfig() {
  hub.config = { ...hub.config, remote: remote.publicInfo(PORT) };
  hub.broadcast('config', hub.config);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'not found' });
  try {
    let body = await readFile(file);
    if (rel === 'index.html') body = body.toString('utf8').replace('__OFFICE_TOKEN__', TOKEN);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

function openStream(req, res, local) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`event: snapshot\ndata: ${JSON.stringify({ ...hub.snapshot(), account: account.publicState(), client: { local, accountAuth: canManageAccount(req) } })}\n\n`);
  hub.clients.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    hub.clients.delete(res);
  });
}

// ---------- api ----------

/** Tells the laptop that a phone started a login or logged out (shown as a toast + notification). */
function accountAlert(action, device, email = null) {
  console.log(`Akun: ${action} dari HP "${device.name}"${email ? ` (${email})` : ''}`);
  hub.broadcast('account-alert', { action, device: device.name, email, ts: Date.now() });
}

async function handleApi(req, res, pathname, device = null) {
  if (req.headers['x-office-token'] !== TOKEN) return json(res, 403, { error: 'forbidden' });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'json only' });
  const body = await readJson(req);

  if (pathname === '/api/projects') {
    const dir = String(body.path ?? '').trim();
    if (!path.isAbsolute(dir) || !isDirectory(dir)) return json(res, 400, { error: 'Folder tidak ditemukan' });
    return json(res, 200, hub.addCustomProject(dir));
  }
  if (pathname === '/api/config') {
    const roots = [...new Set((Array.isArray(body.roots) ? body.roots : []).map((r) => String(r).trim()).filter(Boolean))];
    const invalid = roots.filter((r) => !path.isAbsolute(r) || !isDirectory(r));
    if (invalid.length) return json(res, 400, { error: `Folder tidak ditemukan: ${invalid.join(', ')}` });
    hub.persisted.roots = roots.map((r) => path.resolve(r));
    hub.save();
    refreshProjects();
    return json(res, 200, hub.config);
  }
  if (pathname === '/api/team') {
    // Custom display names per role ("claude" = the lead). Empty → back to the default name.
    const names = {};
    for (const [role, value] of Object.entries(body.names ?? {})) {
      if (role !== 'claude' && !ROLE_IDS.includes(role)) continue;
      const name = String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
      if (name) names[role] = name;
    }
    hub.persisted.teamNames = names;
    hub.scheduleSave();
    hub.config = { ...hub.config, teamNames: names };
    hub.broadcast('config', hub.config);
    return json(res, 200, { names });
  }
  if (pathname === '/api/autostart') {
    hub.config = { ...hub.config, autostart: setAutostart(Boolean(body.enabled), APP_DIR, PORT) };
    hub.broadcast('config', hub.config);
    return json(res, 200, hub.config.autostart);
  }
  if (pathname === '/api/shutdown') {
    json(res, 200, { ok: true });
    setTimeout(shutdown, 300);
    return;
  }
  // ---------- account ----------
  if (pathname === '/api/account') {
    await account.refreshProfile(Boolean(body.force));
    const id = account.current?.id;
    const since = (ms) => totals(id ? ledger.query({ accountId: id, from: Date.now() - ms }) : []);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return json(res, 200, { ...account.publicState(), usage: { today: totals(id ? ledger.query({ accountId: id, from: today.getTime() }) : []), week: since(7 * 86_400_000) } });
  }
  if (pathname === '/api/account/limits') return json(res, 200, (await account.refreshLimits(Boolean(body.force))) ?? {});
  if (pathname === '/api/account/login') {
    const flow = account.startLogin({ console: Boolean(body.console) });
    if (device) accountAlert('login', device);
    return json(res, 200, flow);
  }
  if (pathname === '/api/account/login/code') {
    const code = String(body.code ?? '').trim();
    if (!code) return json(res, 400, { error: 'Kode kosong.' });
    account.submitCode(code);
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/account/login/cancel') {
    account.cancelLogin();
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/account/logout') {
    // Second step for phones: the user must type LOGOUT, so a stray tap can't sign the laptop out.
    if (device && body.confirm !== LOGOUT_CONFIRM) return json(res, 400, { error: `Ketik ${LOGOUT_CONFIRM} untuk konfirmasi logout dari HP.` });
    const email = account.current?.email ?? null;
    const profile = await account.logout();
    if (device) accountAlert('logout', device, email);
    return json(res, 200, { profile });
  }

  // ---------- usage report ----------
  if (pathname === '/api/report/accounts') {
    const known = ledger.accounts();
    const current = account.current;
    if (current && !known.some((a) => a.id === current.id)) known.unshift({ ...current, tokens: 0 });
    return json(res, 200, { accounts: known, current: current?.id ?? null });
  }
  if (pathname === '/api/report/summary' || pathname === '/api/report/pdf') {
    const accountId = String(body.accountId ?? account.current?.id ?? '');
    const to = Number(body.to) || Date.now();
    const from = Number(body.from) || 0;
    const rows = ledger.query({ accountId, from, to });
    const summary = summarize(rows, { from: from || (rows[0]?.ts ?? to), to });
    if (pathname === '/api/report/summary') return json(res, 200, summary);
    const who = ledger.accounts().find((a) => a.id === accountId) ?? (account.current?.id === accountId ? account.current : null);
    if (!who) return json(res, 404, { error: 'Akun tidak dikenal.' });
    const isCurrent = account.current?.id === accountId;
    const html = reportHtml({ account: who, profile: isCurrent ? account.profile : null, limits: isCurrent ? account.limits : null, summary });
    try {
      const pdf = await renderPdf(html);
      // Local date (sv-SE = YYYY-MM-DD): toISOString is UTC, a day behind in the Jakarta morning.
      const name = `laporan-token-${who.email.replace(/[^\w.-]+/g, '_')}-${new Date().toLocaleDateString('sv-SE')}.pdf`;
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
      return res.end(pdf);
    } catch (err) {
      // No headless browser available: hand back the HTML so the page can print it to PDF.
      return json(res, 501, { error: err.message, html });
    }
  }

  if (pathname === '/api/remote') {
    remote.setEnabled(Boolean(body.enabled));
    syncLanServers();
    publishConfig();
    return json(res, 200, remote.publicInfo(PORT));
  }
  if (pathname === '/api/remote/pairing') {
    if (!remote.enabled) return json(res, 400, { error: 'Nyalakan akses dari HP dulu.' });
    // Virtual adapters (WSL, Docker) are unreachable from a phone, so they never go in the QR.
    const usable = networkAddresses().filter((a) => a.kind !== 'virtual');
    if (!usable.length) return json(res, 400, { error: 'Laptop tidak terhubung ke jaringan (WiFi/LAN atau Tailscale).' });
    const chosen = usable.find((a) => a.ip === body.ip) ?? usable[0];
    const { code, key, expires } = remote.currentPairing();
    const base = `http://${chosen.ip}:${PORT}`;
    return json(res, 200, {
      code,
      expires,
      ip: chosen.ip,
      url: base,
      qrUrl: `${base}/pair?k=${key}`,
      addresses: usable.map(({ ip, kind, name }) => ({ ip, kind, name })),
    });
  }
  if (pathname === '/api/remote/revoke') {
    remote.revoke(String(body.id ?? ''));
    publishConfig();
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/projects/refresh') {
    refreshProjects();
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/demo') {
    runDemo(hub);
    return json(res, 202, { ok: true });
  }

  const approval = pathname.match(/^\/api\/approvals\/([\w-]+)$/);
  if (approval) {
    const ok = hub.resolveApproval(approval[1], {
      allow: Boolean(body.allow),
      always: Boolean(body.always),
      allowAll: Boolean(body.allowAll),
      answers: body.answers && typeof body.answers === 'object' ? body.answers : undefined,
      message: typeof body.message === 'string' ? body.message.slice(0, 2000) : undefined,
    });
    return json(res, ok ? 200 : 409, { ok });
  }

  const action = pathname.match(/^\/api\/projects\/([\w-]+)\/(prompt|settings|stop|reset|forget|files|sessions|resume|changes|diff|commit|favorite|open)$/);
  const project = action && hub.projects.get(action[1]);
  if (!project || project.id === DEMO_ID) return json(res, 404, { error: 'project not found' });
  const session = sessions.get(project);
  switch (action[2]) {
    case 'changes':
      return json(res, 200, await gitStatus(project.path));
    case 'diff':
      return json(res, 200, await gitDiff(project.path, String(body.file ?? '')));
    case 'commit': {
      const message = String(body.message ?? '').trim();
      if (!message) return json(res, 400, { error: 'Pesan commit kosong' });
      const result = await gitCommit(project.path, message.slice(0, 2000));
      if (result.ok) hub.chat(project.id, { kind: 'info', text: `Commit dibuat: ${message.split('\n')[0]}` });
      return json(res, result.ok ? 200 : 400, result.ok ? result : { error: result.output });
    }
    case 'favorite':
      hub.setFavorite(project.id, Boolean(body.on));
      return json(res, 200, { ok: true, favorite: Boolean(body.on) });
    case 'open': {
      const app = body.app === 'folder' ? 'folder' : 'code';
      // A file must resolve inside the project: never open arbitrary paths sent by a client.
      const file = body.file ? path.resolve(project.path, String(body.file)) : null;
      if (file && !file.startsWith(path.resolve(project.path) + path.sep)) return json(res, 400, { error: 'File di luar project.' });
      return json(res, 200, { ok: true, ...openInApp(app, project.path, { file }) });
    }
    case 'files':
      return json(res, 200, { files: searchFiles(project.path, body.q) });
    case 'sessions':
      return json(res, 200, { sessions: listSessions(project.path), current: hub.sessionIdFor(project.id) });
    case 'resume': {
      const sessionId = String(body.sessionId ?? '');
      const known = listSessions(project.path, 200).some((s) => s.id === sessionId);
      if (!known) return json(res, 404, { error: 'Sesi tidak ditemukan' });
      session.resume(sessionId, sessionHistory(project.path, sessionId));
      return json(res, 200, { ok: true });
    }
    case 'forget':
      session.reset();
      session.kill();
      sessions.sessions.delete(project.id);
      return json(res, hub.forgetProject(project.id) ? 200 : 400, { ok: true });
    case 'prompt': {
      const text = String(body.text ?? '').trim();
      const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES).map((img) => ({ mediaType: String(img?.mediaType), data: String(img?.data ?? '') }));
      if (images.some((img) => !IMAGE_TYPES.has(img.mediaType) || !/^[A-Za-z0-9+/=]+$/.test(img.data) || img.data.length * 0.75 > MAX_IMAGE_BYTES)) {
        return json(res, 400, { error: 'Gambar harus PNG/JPEG/GIF/WebP, maks 5 MB per gambar' });
      }
      if (!text && !images.length) return json(res, 400, { error: 'prompt kosong' });
      session.prompt((text || 'Lihat gambar terlampir.').slice(0, 50000), images);
      break;
    }
    case 'settings':
      hub.updateSettings(project.id, body);
      break;
    case 'stop':
      session.stop();
      break;
    case 'reset':
      session.reset();
      break;
  }
  return json(res, 200, { ok: true });
}

// ---------- pairing a phone ----------

async function servePairPage(res, message = '') {
  const html = (await readFile(path.join(PUBLIC_DIR, 'pair.html'), 'utf8')).replace('__MESSAGE__', message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function deviceCookie(token) {
  return `${DEVICE_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
}

/** GET /pair?k=… (QR link), GET /pair (code form), POST /pair {code}. */
async function handlePair(req, res, url) {
  const userAgent = String(req.headers['user-agent'] ?? '');
  const key = url.searchParams.get('k');
  if (req.method === 'GET' && key) {
    const result = remote.pair({ key }, userAgent);
    if (!result.token) return servePairPage(res, result.error);
    publishConfig();
    res.writeHead(302, { 'Set-Cookie': deviceCookie(result.token), Location: '/' }); // drop the key from the address bar
    return res.end();
  }
  if (req.method === 'GET') return servePairPage(res);
  if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) return json(res, 405, { error: 'method not allowed' });
  const result = remote.pair({ code: (await readJson(req)).code }, userAgent);
  if (!result.token) return json(res, 400, result);
  publishConfig();
  res.writeHead(200, { 'Set-Cookie': deviceCookie(result.token), 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ ok: true }));
}

// ---------- request handling (shared by the localhost and LAN listeners) ----------

async function handler(req, res) {
  // No other site may frame the office (clickjacking an "Izinkan" button); same-origin frames are fine.
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // DNS-rebinding guard: only answer to our own host names.
  const host = String(req.headers.host).toLowerCase();
  const hosts = allowedHosts();
  if (!hosts.includes(host)) return json(res, 421, { error: 'bad host' });
  if (req.headers.origin && !hosts.some((h) => req.headers.origin === `http://${h}`)) return json(res, 403, { error: 'bad origin' });
  const { pathname, searchParams } = new URL(req.url, `http://${host}`);
  const local = isLocal(req);
  let device = null; // the paired phone making this request (null on the laptop)
  try {
    if (!local) {
      // Another device on the network: it must be paired, and some settings stay laptop-only.
      if (!remote.enabled) return json(res, 403, { error: 'Akses dari perangkat lain sedang dimatikan.' });
      if (pathname === '/pair') return await handlePair(req, res, new URL(req.url, `http://${host}`));
      // App icon + manifest hold no data, and browsers fetch the manifest without cookies.
      if (req.method === 'GET' && PUBLIC_ASSET.test(pathname)) return await serveStatic(pathname, res);
      device = remote.verify(cookies(req)[DEVICE_COOKIE]);
      if (!device) {
        if (req.method === 'GET' && pathname !== '/stream' && !pathname.startsWith('/api/')) {
          res.writeHead(302, { Location: '/pair' });
          return res.end();
        }
        return json(res, 401, { error: 'Perangkat belum dipasangkan.' });
      }
      if (LOCAL_ONLY.has(pathname) || pathname.startsWith('/api/remote') || LOCAL_ONLY_ACTION.test(pathname)) return json(res, 403, { error: 'Pengaturan ini hanya bisa diubah dari laptop.' });
      if (ACCOUNT_AUTH.has(pathname) && !canManageAccount(req)) return json(res, 403, { error: 'Login/logout dari HP hanya lewat Tailscale (koneksi terenkripsi), bukan WiFi biasa.' });
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, device);
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    if (pathname === '/stream') return openStream(req, res, local);
    if (pathname === '/health') return json(res, 200, { ok: true, claude: Boolean(claude) });
    if (pathname === '/pair' && searchParams.size === 0) return servePairPage(res);
    return await serveStatic(pathname, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: String(err.message ?? err) });
    else res.end();
  }
}

const server = http.createServer(handler);

// One extra listener per LAN address while phone access is on (never 0.0.0.0).
const lanServers = new Map(); // ip -> { server, sockets }
function syncLanServers() {
  const wanted = new Set(remote.enabled ? lanAddresses() : []);
  for (const [ip, entry] of lanServers) {
    if (wanted.has(ip)) continue;
    entry.server.close();
    for (const socket of entry.sockets) socket.destroy(); // also ends open event streams
    lanServers.delete(ip);
  }
  for (const ip of wanted) {
    if (lanServers.has(ip)) continue;
    const lan = http.createServer(handler);
    const sockets = new Set();
    lan.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    lan.on('error', (err) => {
      console.error(`Akses HP di ${ip} gagal: ${err.message}`);
      lanServers.delete(ip);
    });
    lan.listen(PORT, ip, () => console.log(`Akses HP aktif: http://${ip}:${PORT}`));
    lanServers.set(ip, { server: lan, sockets });
  }
}
// WiFi changes (new IP) are picked up without a restart.
setInterval(() => remote.enabled && syncLanServers(), 30000).unref();

refreshProjects();
hub.ready = true;
const mirroring = mirror.start();
// Know who is logged in (usage is tagged with it); notice logins/logouts done in a terminal too.
account.refreshProfile(true).catch(() => {});
setInterval(() => account.refreshProfile(true).catch(() => {}), 60_000).unref();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} sudah dipakai — Adhit Office mungkin sudah berjalan.`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Adhit Office berjalan di ${url}`);
  console.log(claude ? `Claude Code: ${claude.command}` : 'PERINGATAN: Claude Code tidak ditemukan (set env CLAUDE_BIN).');
  console.log(`Folder projects: ${projectRoots().join('; ')}  ·  Role agents: ${Object.keys(agents).join(', ') || '-'}`);
  console.log(mirroring ? 'Mirror CLI: aktif (membaca ~/.claude/projects)' : 'Mirror CLI: nonaktif (~/.claude/projects tidak ada)');
  console.log('Tekan Ctrl+C untuk berhenti.');
  syncLanServers();
  if (process.argv.includes('--open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  }
});

function shutdown() {
  mirror.stop();
  sessions.shutdown();
  hub.save();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
