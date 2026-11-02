// Adhit Office server: runs headless Claude Code per project and serves the office web app.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaude } from './src/claude-bin.js';
import { runDemo } from './src/demo.js';
import { DEMO_ID, Hub, PERMISSION_MODES } from './src/hub.js';
import { discoverProjects, isDirectory, isNetworkPath } from './src/projects.js';
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BackupError, isUnderHome, restoreBackup, writeBackup } from './src/backup.js';
import { ZipError } from './src/zip.js';
import { projectId as idOfPath } from './src/util.js';
import { AccountService } from './src/account.js';
import { autostartStatus, setAutostart } from './src/autostart.js';
import { renderPdf, reportHtml } from './src/report.js';
import { PERIOD_UNITS, UsageLedger, summarize, totals } from './src/usage.js';
import { FileViewError, readProjectFile } from './src/file-view.js';
import { searchFiles } from './src/files.js';
import { moduleGraph, preloadTags } from './src/modules.js';
import { GitError, gitAction, gitBranches, gitCommit, gitDiff, gitStatus } from './src/git.js';
import { PermissionError, editPermission, readPermissions } from './src/permissions.js';
import { openInApp } from './src/open.js';
import { TranscriptMirror } from './src/mirror.js';
import { DEVICE_COOKIE, HTTPS_DEVICE_COOKIE, READ_ONLY_ERROR, RemoteAccess, WIFI_READ_API, isTailscaleConnection, lanAddresses, networkAddresses, wifiAllows } from './src/remote.js';
import { TailscaleCert, httpsPortFrom } from './src/tls.js';
import { listSessions, sessionHistory } from './src/transcripts.js';
import { ConversationError, exportSession, searchSessions } from './src/conversation.js';
import { taskDetail } from './src/task-detail.js';
import { MAX_ACTIVE_ROLES, TeamConfigError, activeAgents, normalizeEnabled, publicCatalog, storedEnabled, teamPrompt } from './src/role-catalog.js';
import { ROLE_IDS, activeRoles, loadAgentDefinitions, setActiveRoles } from './src/roles.js';
import { SessionManager } from './src/session.js';
import { AttachmentError, readAttachments } from './src/attachments.js';
import { TEMPLATE_LIMITS, TemplateError, TemplateStore } from './src/templates.js';
import { QueueError, refuseAttachments, TaskQueue } from './src/queue.js';
import { BackupScheduler, ScheduleError } from './src/backup-schedule.js';

const PORT = Number(process.env.OFFICE_PORT ?? 4317);
const HOST = '127.0.0.1';
// HTTPS for phones over Tailscale (src/tls.js): its own port, bound only to the Tailscale interface.
// null = HTTPS off (the port clashes with OFFICE_PORT); a warning is logged at start.
const { port: HTTPS_PORT, warning: HTTPS_PORT_WARNING } = httpsPortFrom(process.env.OFFICE_HTTPS_PORT, PORT);
// Tests only: bind the https listener to loopback instead of the Tailscale interface (CI has none).
// Loopback only, never another address; a TLS socket is never treated as the laptop (isLocal), so this
// cannot grant anything: such a client is an ordinary paired phone on a non-Tailscale link (read-only).
const HTTPS_TEST_BIND = process.env.OFFICE_HTTPS_TEST_BIND === '127.0.0.1' ? '127.0.0.1' : null;
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
// Used until roots are set in the web UI: env, else the folder this app lives in.
const DEFAULT_ROOT = path.resolve(process.env.PROJECTS_ROOT ?? path.dirname(APP_DIR));
const MAX_BODY = 30 * 1024 * 1024; // prompts may carry 📎 attachments (max 20 MB, base64 in JSON)
// A history backup upload (POST /api/backup/import, raw .zip): large, but not unbounded. Env override for tests.
const MAX_BACKUP_BYTES = Number(process.env.OFFICE_BACKUP_MAX_BYTES) || 4 * 1024 ** 3;
const ZIP_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);
const MAX_PAIR_BODY = 1024; // POST /pair is reachable before pairing: it only carries a 6-digit code
// Built-ins that work headless; the full list (skills, custom commands) arrives from Claude Code itself.
// clear/model/effort/resume/cost/help are handled by the web app itself (see localCommand in public/js/features/commands.js).
const DEFAULT_SLASH = ['clear', 'compact', 'context', 'cost', 'effort', 'help', 'init', 'model', 'resume', 'review'];
// Per-start secret: only pages served by this process can call the API (blocks CSRF from other sites).
const TOKEN = randomBytes(24).toString('hex');

// The Lead's team prompt and the subagents (--agents) follow the active team (👥 Kelola tim): src/role-catalog.js.

// Every response: no inline/foreign scripts, no plugins, nothing but this origin may frame the office
// (clickjacking an "Izinkan" button). style-src keeps 'unsafe-inline': the app and the printable usage
// report set style="" attributes and <style> blocks (an about:blank report window inherits this policy).
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
// Browsers honour COOP only on trustworthy origins (localhost); on http://<LAN/Tailscale IP> they ignore it
// and log a console error, so it is sent to the laptop's own page only.
const LOCAL_SECURITY_HEADERS = { 'Cross-Origin-Opener-Policy': 'same-origin' };

/** An error whose message is meant for the user, sent with its own status (anything else becomes a generic 500). */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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
// Turns the last run left unfinished (stopped mid-turn, cleanly or not): a notice + "Lanjutkan" in their chat.
const cutShort = hub.recoverTurns();
// Leftovers of an import cut short by a crash or shutdown (uploaded .zip files): only this app writes there.
rmSync(path.join(DATA_DIR, 'tmp'), { recursive: true, force: true });
const claude = findClaude();
// Every role's subagent template; only the active team's go to `claude --agents` (saveTeam).
const allAgents = loadAgentDefinitions(path.join(APP_DIR, '.claude', 'agents'));
const initialTeam = storedEnabled(hub.persisted.team);
setActiveRoles(initialTeam);

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
const sessions = new SessionManager({ hub, claude, agents: activeAgents(allAgents, initialTeam), teamPrompt: teamPrompt(initialTeam, Object.keys(allAgents)), ledger, account });
const mirror = new TranscriptMirror(hub, { ledger });
// A device unpaired for being idle loses its open event streams at once, like "Cabut".
const remote = new RemoteAccess(hub, {
  onExpire: (devices) => {
    for (const d of devices) dropDeviceStreams(d.id);
    publishConfig();
  },
});

// The https listener's certificate (Tailscale MagicDNS name). Checked only while phone access is on.
const tls = new TailscaleCert({
  dir: path.join(DATA_DIR, 'tls'),
  enabled: () => remote.enabled,
  // Runs from timers and background refreshes: a failure here must never take the server down.
  onChange: () => {
    try {
      syncListeners();
      publishConfig();
    } catch (err) {
      console.error('HTTPS: listener sync gagal:', err?.stack ?? err);
    }
  },
});

/** The HTTPS status for browsers (no key, no paths); "error" when HTTPS is off by configuration. */
function httpsInfo() {
  if (HTTPS_PORT === null) return { ...tls.publicInfo(0), state: remote.enabled ? 'error' : 'off', host: null, url: null, validTo: null, error: remote.enabled ? 'OFFICE_HTTPS_PORT bentrok dengan OFFICE_PORT; HTTPS dimatikan.' : null };
  return tls.publicInfo(HTTPS_PORT);
}

/** Phone access as browsers see it: devices, addresses, and the HTTPS (Tailscale) status. */
function remoteInfo() {
  return { ...remote.publicInfo(PORT), https: httpsInfo() };
}

const templates = new TemplateStore(hub);
// 📋 Antrian: prompts sent one by one whenever the project's session is idle (src/queue.js).
const taskQueue = new TaskQueue({ hub, sessions });
sessions.onRateLimit = (id, info) => taskQueue.onRateLimit(id, info);

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
    ...hub.catalogConfig(), // models + commands with descriptions, as Claude Code reports them
    autostart: autostartStatus(),
    remote: remoteInfo(),
    teamNames: hub.persisted.teamNames ?? {},
    team: teamConfig(),
  };
  hub.ready = wasReady;
  hub.broadcast('config', hub.config);
  hub.broadcast('projects', hub.listProjects());
}

// ---------- http helpers ----------

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Settings that only the laptop itself may change, never a paired phone.
// Adding a project folder points Claude Code (and git, file search) at any path: laptop only.
// Backup export/import read and write the whole Claude history: laptop only (Tailscale phones too are refused).
const LOCAL_ONLY = new Set(['/api/autostart', '/api/shutdown', '/api/config', '/api/projects', '/api/backup/export', '/api/backup/import', '/api/backup/schedule', '/api/backup/schedule/save', '/api/backup/schedule/run']);
// Login/logout switch the account of every Claude Code on the laptop: from a phone only over
// Tailscale (encrypted), never over plain-HTTP WiFi where the device cookie could be sniffed.
const ACCOUNT_AUTH = new Set(['/api/account/login', '/api/account/login/code', '/api/account/login/cancel', '/api/account/logout']);
const LOGOUT_CONFIRM = 'LOGOUT';
// Opening VS Code / Explorer only makes sense on the laptop itself.
// Changing saved permission rules (🛡️ Aturan izin) changes what Claude Code may do unasked: laptop only (phones may look).
const LOCAL_ONLY_ACTION = /^\/api\/projects\/[\w-]+\/(open|permissions-edit)$/;
const PUBLIC_ASSET = /^\/(manifest\.webmanifest|icons\/[\w.-]+|js\/pair\.js)$/;

// A TLS socket is never the laptop, even from loopback (e.g. someone puts `tailscale serve` in front of it):
// the laptop is plain http on 127.0.0.1 only.
const isLocal = (req) => LOOPBACK.has(req.socket.remoteAddress) && !req.socket.encrypted;
/** Came in on the https listener (Tailscale). */
const isSecure = (req) => Boolean(req.socket.encrypted);
const transportOf = (req) => (isSecure(req) ? 'https' : 'http');
/** The device cookie of this transport: each listener reads only its own (see src/remote.js). */
const deviceToken = (req) => cookies(req)[isSecure(req) ? HTTPS_DEVICE_COOKIE : DEVICE_COOKIE];
/** What this browser may do with the Claude account: laptop, or a paired phone over Tailscale. */
// Tailscale = came in through the laptop's Tailscale interface from a tailnet peer, not just any 100.x address (CGNAT WiFi uses those too).
const canManageAccount = (req) => isLocal(req) || isTailscaleConnection(req.socket.localAddress, req.socket.remoteAddress);
/** A paired phone on plain-HTTP WiFi (not Tailscale): it may look, never act (see wifiAllows). */
const isReadOnly = (req) => !canManageAccount(req);
/** `force` re-runs the Claude CLI; a read-only phone always gets the cached answer so it can't keep spawning processes. */
const allowForce = (req, body) => Boolean(body.force) && !isReadOnly(req);
/** One headless browser at a time renders report PDFs (each is a full Chrome/Edge process for up to 60 s). */
let pdfRendering = false;

/**
 * Host names we answer to (DNS-rebinding guard); LAN addresses only while phone access is on.
 * The https listener answers to the certificate's MagicDNS name only (and the http ones never to it).
 */
function allowedHosts(secure = false) {
  if (secure) {
    const name = remote.enabled && HTTPS_PORT !== null ? tls.host : null;
    if (!name) return [];
    return HTTPS_PORT === 443 ? [name, `${name}:443`] : [`${name}:${HTTPS_PORT}`];
  }
  const hosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  if (remote.enabled) for (const ip of lanAddresses()) hosts.push(`${ip}:${PORT}`);
  return hosts;
}

function cookies(req) {
  const found = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (!key || !value) continue;
    try {
      found[key] = decodeURIComponent(value);
    } catch {
      // malformed %-escape (another site's cookie, or garbage): skipped, never a 500
    }
  }
  return found;
}

function publishConfig() {
  hub.config = { ...hub.config, remote: remoteInfo() };
  hub.broadcast('config', hub.config);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return; // drained, not kept; the socket is closed once the 413 is sent
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Data yang dikirim terlalu besar.'));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'Data JSON tidak valid.'));
      }
    });
    req.on('error', reject);
  });
}

// Every module app.js pulls in, preloaded from index.html so a phone fetches them in parallel instead of in
// a 3–4 level waterfall. Worked out once per start (a new import picked up on restart; until then it simply loads late).
const MODULE_PRELOADS = preloadTags(moduleGraph(PUBLIC_DIR, '/js/app.js'));

/** Strong validator for a static file's bytes. */
const etagOf = (body) => `"${createHash('sha1').update(body).digest('base64url')}"`;

/** If-None-Match (a list, possibly weak validators or "*") matches this ETag. */
function notModified(req, etag) {
  const header = String(req.headers['if-none-match'] ?? '');
  return header.trim() === '*' || header.split(',').some((v) => v.trim().replace(/^W\//, '') === etag);
}

async function serveStatic(pathname, res, req) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'not found' });
  try {
    let body = await readFile(file);
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    if (rel === 'index.html') {
      // Carries the per-start API token: never stored by the browser.
      body = body.toString('utf8').replace('__OFFICE_TOKEN__', TOKEN).replace(/<!-- module-preloads:.*?-->/, MODULE_PRELOADS);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    // Plain files (JS, CSS, icons): kept by the browser but revalidated on every use, so a reload is a
    // round of tiny 304s instead of full downloads, and an edited file is still picked up at once.
    const etag = etagOf(body);
    const headers = { 'Cache-Control': 'no-cache', ETag: etag };
    if (notModified(req, etag)) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Type': type });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const STREAM_HEARTBEAT_MS = 15000;
const deviceStreams = new Map(); // event stream (res) -> id of the paired phone holding it

/** Ends an event stream now, socket included (a revoked phone must stop receiving the office at once). */
function dropStream(res) {
  hub.clients.delete(res);
  deviceStreams.delete(res);
  res.end();
  res.socket?.destroy();
}

/** Every open event stream of one paired device (after "Cabut"). */
function dropDeviceStreams(deviceId) {
  for (const [res, owner] of deviceStreams) if (owner === deviceId) dropStream(res);
}

function openStream(req, res, local, device = null, token = null) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  // readOnlyApi: what a read-only phone may still call, so the UI doesn't keep its own copy of wifiAllows.
  const client = { local, accountAuth: canManageAccount(req), readOnly: isReadOnly(req), readOnlyApi: WIFI_READ_API };
  res.write(`event: snapshot\ndata: ${JSON.stringify({ ...hub.snapshot(), account: account.publicState(), client })}\n\n`);
  hub.clients.add(res);
  if (device) deviceStreams.set(res, device.id);
  const heartbeat = setInterval(() => {
    // Revoked, or phone access switched off since the stream opened: the device is out.
    if (device && !remote.verify(token, { transport: transportOf(req) })) return dropStream(res);
    res.write(': ping\n\n');
  }, STREAM_HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    hub.clients.delete(res);
    deviceStreams.delete(res);
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
  // The one API whose body is not JSON (a raw .zip, far over MAX_BODY): handled before readJson.
  if (pathname === '/api/backup/import') return importBackup(req, res);
  if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'json only' });
  const body = await readJson(req);

  if (pathname === '/api/projects') {
    const dir = String(body.path ?? '').trim();
    if (isNetworkPath(dir)) return json(res, 400, { error: 'Folder jaringan (\\\\server\\share) tidak didukung. Pakai folder di laptop ini.' });
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
  if (pathname === '/api/backup/export') return exportBackup(req, res);
  if (pathname.startsWith('/api/backup/schedule')) return backupSchedule(req, res, pathname, body);
  if (pathname === '/api/team') {
    const names = cleanTeamNames(body.names);
    hub.persisted.teamNames = names;
    hub.scheduleSave();
    hub.config = { ...hub.config, teamNames: names };
    hub.broadcast('config', hub.config);
    return json(res, 200, { names });
  }
  // 👥 Kelola tim: reading the team is allowed over WiFi (src/remote.js); saving it is an action.
  if (pathname === '/api/team/roster') return json(res, 200, teamConfig());
  if (pathname === '/api/team/roster/save') {
    try {
      return json(res, 200, saveTeam(normalizeEnabled(body.enabled)));
    } catch (err) {
      if (err instanceof TeamConfigError) return json(res, err.status, { error: err.message });
      throw err;
    }
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
  // ---------- prompt templates (⚡ Template) ----------
  // Reading the list is allowed over WiFi (src/remote.js); save/delete are actions, refused there by the gate.
  if (pathname === '/api/templates') return json(res, 200, { templates: templates.list(), limits: TEMPLATE_LIMITS });
  if (pathname === '/api/templates/save' || pathname === '/api/templates/delete') {
    try {
      if (pathname === '/api/templates/save') {
        const template = templates.save({ id: body.id, name: body.name, text: body.text });
        return json(res, 200, { template, templates: templates.list() });
      }
      templates.remove(body.id);
      return json(res, 200, { templates: templates.list() });
    } catch (err) {
      if (err instanceof TemplateError) throw new HttpError(400, err.message);
      throw err;
    }
  }
  // ---------- account ----------
  if (pathname === '/api/account') {
    await account.refreshProfile(allowForce(req, body));
    const id = account.current?.id;
    const since = (ms) => totals(id ? ledger.query({ accountId: id, from: Date.now() - ms }) : []);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return json(res, 200, { ...account.publicState(), usage: { today: totals(id ? ledger.query({ accountId: id, from: today.getTime() }) : []), week: since(7 * 86_400_000) } });
  }
  if (pathname === '/api/account/limits') return json(res, 200, (await account.refreshLimits(allowForce(req, body))) ?? {});
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
    const groupBy = PERIOD_UNITS.includes(body.groupBy) ? body.groupBy : 'day';
    const summary = summarize(rows, { from: from || (rows[0]?.ts ?? to), to, groupBy });
    if (pathname === '/api/report/summary') return json(res, 200, summary);
    const who = ledger.accounts().find((a) => a.id === accountId) ?? (account.current?.id === accountId ? account.current : null);
    if (!who) return json(res, 404, { error: 'Akun tidak dikenal.' });
    const isCurrent = account.current?.id === accountId;
    const html = reportHtml({ account: who, profile: isCurrent ? account.profile : null, limits: isCurrent ? account.limits : null, summary });
    if (pdfRendering) return json(res, 429, { error: 'Laporan PDF lain sedang dibuat. Coba lagi sebentar.' });
    pdfRendering = true;
    try {
      const pdf = await renderPdf(html);
      // Local date (sv-SE = YYYY-MM-DD): toISOString is UTC, a day behind in the Jakarta morning.
      const name = `laporan-token-${who.email.replace(/[^\w.-]+/g, '_')}-${new Date().toLocaleDateString('sv-SE')}.pdf`;
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
      return res.end(pdf);
    } catch (err) {
      // No headless browser available: hand back the HTML so the page can print it to PDF.
      return json(res, 501, { error: err.message, html });
    } finally {
      pdfRendering = false;
    }
  }

  if (pathname === '/api/remote') {
    remote.setEnabled(Boolean(body.enabled));
    syncListeners();
    if (remote.enabled) tls.refresh(); // in the background; a certificate brings the https listener up (onChange)
    publishConfig();
    return json(res, 200, remoteInfo());
  }
  // "Periksa lagi" in the phone dialog: ask Tailscale for the certificate now (laptop only, like all of /api/remote).
  if (pathname === '/api/remote/https-check') {
    if (!remote.enabled) return json(res, 400, { error: 'Nyalakan akses dari HP dulu.' });
    if (HTTPS_PORT !== null) await tls.refresh();
    return json(res, 200, httpsInfo());
  }
  if (pathname === '/api/remote/pairing') {
    if (!remote.enabled) return json(res, 400, { error: 'Nyalakan akses dari HP dulu.' });
    // Virtual adapters (WSL, Docker) are unreachable from a phone, so they never go in the QR.
    const usable = networkAddresses().filter((a) => a.kind !== 'virtual');
    if (!usable.length) return json(res, 400, { error: 'Laptop tidak terhubung ke jaringan (WiFi/LAN atau Tailscale).' });
    const chosen = usable.find((a) => a.ip === body.ip) ?? usable[0];
    // { https: true }: the QR opens the https (Tailscale) origin, which pairs separately (its own cookie).
    const secureUrl = httpsInfo().url;
    if (body.https === true && !secureUrl) return json(res, 400, { error: 'HTTPS lewat Tailscale belum tersedia.' });
    const { code, key, expires } = remote.currentPairing();
    const base = body.https === true ? secureUrl : `http://${chosen.ip}:${PORT}`;
    return json(res, 200, {
      code,
      expires,
      ip: chosen.ip,
      url: base,
      qrUrl: `${base}/pair?k=${key}`,
      addresses: usable.map(({ ip, kind, name }) => ({ ip, kind, name })),
      https: secureUrl ? { url: secureUrl, qrUrl: `${secureUrl}/pair?k=${key}` } : null,
    });
  }
  if (pathname === '/api/remote/revoke') {
    const id = String(body.id ?? '');
    remote.revoke(id);
    dropDeviceStreams(id); // its open event streams end now, not at the next reconnect
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
      mode: PERMISSION_MODES.includes(body.mode) ? body.mode : undefined, // plan approved: how the work continues
    });
    return json(res, ok ? 200 : 409, { ok });
  }

  // ⎇ git branches / remotes and 🛡️ permission rules (handled in projectTools, below).
  const tool = pathname.match(/^\/api\/projects\/([\w-]+)\/(git-branches|git-action|permissions|permissions-edit)$/);
  if (tool) return projectTools(req, res, tool[1], tool[2], body);

  // 📋 Antrian: `queue` reads (allowed over WiFi), every queue-* is a change (refused there by the gate).
  const queueRoute = pathname.match(/^\/api\/projects\/([\w-]+)\/queue(?:-(add|update|remove|reorder|pause|retry|clear|budget))?$/);
  if (queueRoute) return queueApi(res, queueRoute[1], queueRoute[2] ?? 'list', body);

  const action = pathname.match(
    /^\/api\/projects\/([\w-]+)\/(prompt|settings|stop|reset|forget|files|sessions|resume|continue|changes|diff|file|commit|favorite|open|shell|rewind-points|rewind-preview|rewind|mcp|mcp-action|task-output|task-detail|task-stop|background|rename|search|export-session)$/,
  );
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
      const line = Number.isInteger(body.line) && body.line > 0 && body.line < 1e7 ? body.line : null;
      return json(res, 200, { ok: true, ...openInApp(app, project.path, { file, line }) });
    }
    case 'files':
      return json(res, 200, { files: searchFiles(project.path, body.q) });
    case 'file':
      // 📄 Lihat file: read-only, inside the project only. Likely secrets (.env, keys, credentials) need a click
      // on the laptop (`reveal`) and are never sent to another device, whatever the connection.
      try {
        return json(res, 200, await readProjectFile(project.path, body.path, { allowSecret: isLocal(req), reveal: body.reveal === true }));
      } catch (err) {
        if (err instanceof FileViewError) return json(res, err.status, { error: err.message });
        throw err;
      }
    case 'sessions':
      return json(res, 200, { sessions: listSessions(project.path), current: hub.sessionIdFor(project.id) });
    // 🔎 Cari percakapan / ⬇ Export .md: read-only, bounded reads of this project's transcripts (src/conversation.js).
    case 'search':
    case 'export-session':
      try {
        if (action[2] === 'export-session') return json(res, 200, exportSession(project.path, body.sessionId, { tools: body.tools === true, projectName: project.name }));
        // all: every listed project, the active one first.
        const scope = body.all === true ? [project, ...[...hub.projects.values()].filter((p) => p.id !== project.id && p.id !== DEMO_ID && p.path)] : [project];
        return json(res, 200, searchSessions(scope, body.q, { limit: body.limit }));
      } catch (err) {
        if (err instanceof ConversationError) return json(res, err.status, { error: err.message });
        throw err;
      }
    case 'resume': {
      const sessionId = String(body.sessionId ?? '');
      const known = listSessions(project.path, 200).some((s) => s.id === sessionId);
      if (!known) return json(res, 404, { error: 'Sesi tidak ditemukan' });
      session.resume(sessionId, sessionHistory(project.path, sessionId));
      return json(res, 200, { ok: true });
    }
    case 'continue': {
      // A turn cut short by a server restart: continue it in the same session, or just drop the notice.
      if (body.dismiss === true) {
        hub.clearInterrupted(project.id);
        return json(res, 200, { ok: true });
      }
      try {
        return json(res, 200, session.continueInterrupted());
      } catch (err) {
        if (err.status) return json(res, err.status, { error: err.message });
        throw err;
      }
    }
    case 'forget':
      taskQueue.forget(project.id);
      session.reset();
      session.kill();
      sessions.sessions.delete(project.id);
      return json(res, hub.forgetProject(project.id) ? 200 : 400, { ok: true });
    case 'prompt': {
      const text = String(body.text ?? '').trim();
      let attachments;
      try {
        attachments = readAttachments(body); // type, magic bytes/UTF-8, size, count, name: never trust the browser
      } catch (err) {
        if (err instanceof AttachmentError) return json(res, err.status, { error: err.message });
        throw err;
      }
      if (!text && !attachments.length) return json(res, 400, { error: 'prompt kosong' });
      session.prompt((text || 'Lihat file terlampir.').slice(0, 50000), attachments);
      break;
    }
    case 'shell': {
      // A shell skips Claude's permission checks: plain-HTTP WiFi is already refused in handler() (read-only).
      const command = String(body.command ?? '').trim();
      if (!command) return json(res, 400, { error: 'Perintah kosong' });
      session.shell(command.slice(0, 4000));
      break;
    }
    case 'settings':
      hub.updateSettings(project.id, body);
      session.syncSettings(); // switches the running Claude Code live (mid-turn too, like Shift+Tab)
      break;
    case 'stop':
      session.stop();
      break;
    case 'reset':
      session.reset();
      break;
    // Esc Esc / /rewind
    case 'rewind-points':
      return json(res, 200, { points: session.rewindPoints() });
    case 'rewind-preview':
      return answer(res, session.rewindPreview(String(body.uuid ?? '')));
    case 'rewind':
      return answer(res, session.rewind(String(body.uuid ?? ''), { code: Boolean(body.code), conversation: Boolean(body.conversation) }));
    // /mcp
    case 'mcp':
      return answer(res, session.mcpStatus().then((servers) => ({ servers })));
    case 'mcp-action': {
      const act = String(body.action ?? '');
      const callbackUrl = String(body.callbackUrl ?? '');
      if (act === 'callback' && !/^https?:\/\//.test(callbackUrl)) return json(res, 400, { error: 'Tempel URL lengkap dari address bar setelah login.' });
      return answer(res, session.mcpAction(String(body.server ?? ''), act, callbackUrl));
    }
    // /tasks, Ctrl+B
    case 'task-output':
      return answer(res, session.taskOutput(String(body.taskId ?? '')));
    case 'task-detail': {
      // Read-only monitor (⧗ Tugas latar): the task must be one of this session's own; files are found server-side.
      const taskId = String(body.taskId ?? '');
      if (!taskId) return json(res, 400, { error: 'taskId kosong' });
      const task = (hub.rt(project.id).status.tasks ?? []).find((t) => t.id === taskId);
      if (!task) return json(res, 404, { error: 'Tugas tidak ditemukan (mungkin sudah dibersihkan).' });
      return json(res, 200, taskDetail(project.path, hub.sessionIdFor(project.id), task));
    }
    case 'task-stop':
      return answer(res, session.stopTask(String(body.taskId ?? '')));
    case 'background':
      return answer(res, session.backgroundTasks());
    case 'rename': {
      const title = String(body.title ?? '').trim().slice(0, 200);
      if (!title) return json(res, 400, { error: 'Nama sesi kosong' });
      return answer(res, session.rename(title));
    }
  }
  return json(res, 200, { ok: true });
}

/**
 * Perubahan → ⎇ git (git-branches: read; git-action: switch/create/fetch/pull/push — the WiFi gate refuses it)
 * and 🛡️ Aturan izin (permissions: read; permissions-edit: laptop only, see LOCAL_ONLY_ACTION).
 */
async function projectTools(req, res, id, kind, body) {
  const project = hub.projects.get(id);
  if (!project || project.id === DEMO_ID) return json(res, 404, { error: 'project not found' });
  try {
    switch (kind) {
      case 'git-branches':
        return json(res, 200, await gitBranches(project.path));
      case 'git-action': {
        const act = String(body.action ?? '');
        const result = await gitAction(project.path, { action: act, name: body.name == null ? undefined : String(body.name), carry: body.carry === true });
        const label = { switch: `Pindah ke branch ${result.branch}`, create: `Branch baru ${result.branch}`, fetch: 'git fetch', pull: 'git pull', push: 'git push' }[act];
        hub.chat(project.id, { kind: 'info', text: `⎇ ${label} berhasil.` });
        return json(res, 200, result);
      }
      case 'permissions':
        return json(res, 200, await readPermissions(project.path));
      case 'permissions-edit': {
        const edit = { scope: String(body.scope ?? ''), action: String(body.action ?? ''), list: String(body.list ?? ''), rule: body.rule, to: body.to == null ? undefined : String(body.to) };
        const result = await editPermission(project.path, edit);
        // Claude Code reads its rules at start: idle processes restart, busy ones after their turn.
        // A user-level rule applies to every project.
        const affected = edit.scope === 'user' ? [...sessions.sessions.values()] : [sessions.get(project)];
        const applied = affected.map((s) => s.reloadSettings());
        const rule = String(edit.rule ?? '').trim();
        const what = { add: `ditambahkan ke ${edit.list}`, remove: `dihapus dari ${edit.list}`, move: `dipindah ${edit.list} → ${edit.to}` }[edit.action];
        hub.chat(project.id, { kind: 'info', text: `🛡️ Aturan izin "${rule}" ${what} (${result.file}).` });
        return json(res, 200, { ...result, applied: applied.includes('pending') ? 'pending' : applied.includes('restarted') ? 'restarted' : 'none' });
      }
    }
  } catch (err) {
    if (err instanceof GitError) return json(res, err.status, { error: err.output ? `${err.message}\n\n${err.output}` : err.message, code: err.code, output: err.output });
    if (err instanceof PermissionError) return json(res, err.status, { error: err.message });
    throw err;
  }
  return json(res, 404, { error: 'not found' });
}

// ---------- the active team (👥 Kelola tim) ----------

/** What the browser gets: the active role ids (catalog order, Lead excluded) and the built-in catalog. */
function teamConfig() {
  return { enabled: activeRoles(), catalog: publicCatalog(), max: MAX_ACTIVE_ROLES, lead: 'claude' };
}

/**
 * Switches the team: role mapping, the subagents sent with --agents and the Lead's prompt. Claude Code reads
 * those when it starts, so idle team-mode sessions restart now and busy ones after their turn (reloadSettings).
 */
function saveTeam(enabled) {
  const same = enabled.join() === activeRoles().join();
  hub.persisted.team = { enabled };
  hub.scheduleSave();
  if (same) return { ...teamConfig(), applied: 'none' };
  setActiveRoles(enabled);
  sessions.agents = activeAgents(allAgents, enabled);
  sessions.teamPrompt = teamPrompt(enabled, Object.keys(allAgents));
  const applied = [...sessions.sessions.values()].filter((s) => hub.settingsFor(s.id).team).map((s) => s.reloadSettings());
  hub.config = { ...hub.config, team: teamConfig() };
  hub.broadcast('config', hub.config);
  console.log(`Tim diubah: ${enabled.length} role aktif (${enabled.join(', ')})`);
  return { ...teamConfig(), applied: applied.includes('pending') ? 'pending' : applied.includes('restarted') ? 'restarted' : 'none' };
}

/** Custom display names per role ("claude" = the lead), validated. Empty → back to the default name. */
function cleanTeamNames(input) {
  const names = {};
  for (const [role, value] of Object.entries(input && typeof input === 'object' ? input : {})) {
    if (role !== 'claude' && !ROLE_IDS.includes(role)) continue;
    const name = String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
    if (name) names[role] = name;
  }
  return names;
}

// ---------- history backup (⚙ → Cadangkan riwayat) ----------

let backupBusy = false; // one export or import at a time

// Backup otomatis (⚙ → Cadangkan riwayat): the same .zip as Export, written on a schedule (src/backup-schedule.js).
// It takes the same one-at-a-time flag, so a scheduled run never overlaps an export or import.
const backupScheduler = new BackupScheduler({
  store: {
    get schedule() {
      return hub.persisted.backupSchedule;
    },
    set schedule(value) {
      hub.persisted.backupSchedule = value;
    },
    get runs() {
      return hub.persisted.backupRuns;
    },
    set runs(value) {
      hub.persisted.backupRuns = value;
    },
    save: () => hub.save(),
  },
  backup: (out) => {
    hub.save(); // the state file on disk and in the backup agree
    return writeBackup(out, { state: hub.exportState(), usageFile: ledger.file, appVersion: APP_VERSION });
  },
  lock: () => !backupBusy && (backupBusy = true),
  unlock: () => (backupBusy = false),
  onChange: (view) => hub.broadcast('backup-schedule', view),
  log: (msg) => console.log(msg),
});

/** POST /api/backup/schedule (read), /save (settings), /run (now, in the background). Laptop only (LOCAL_ONLY). */
async function backupSchedule(req, res, pathname, body) {
  if (!isLocal(req)) return json(res, 403, { error: 'Backup hanya bisa dari laptop.' });
  if (pathname === '/api/backup/schedule') return json(res, 200, backupScheduler.view());
  if (pathname === '/api/backup/schedule/save') {
    try {
      return json(res, 200, await backupScheduler.save(body));
    } catch (err) {
      if (err instanceof ScheduleError) return json(res, err.status, { error: err.message });
      throw err;
    }
  }
  if (pathname === '/api/backup/schedule/run') {
    if (!backupScheduler.schedule.folder) return json(res, 400, { error: 'Atur folder tujuan dulu.' });
    const run = backupScheduler.run({ trigger: 'manual' });
    if (!run) return json(res, 409, { error: 'Export/import/backup lain sedang berjalan. Tunggu sampai selesai.' });
    return json(res, 202, backupScheduler.view()); // the result arrives as a backup-schedule event (and in /schedule)
  }
  return json(res, 404, { error: 'not found' });
}

/** 📋 Antrian of one project: list, or a change (add/update/remove/reorder/pause/retry/clear/budget). */
function queueApi(res, id, op, body) {
  const project = hub.projects.get(id);
  if (!project || project.id === DEMO_ID) return json(res, 404, { error: 'project not found' });
  try {
    switch (op) {
      case 'add': {
        refuseAttachments(body); // 📎 never stored in state.json (src/queue.js)
        const item = taskQueue.add(id, body.text);
        return json(res, 200, { item, queue: taskQueue.view(id) });
      }
      case 'update':
        refuseAttachments(body);
        taskQueue.update(id, body.itemId, body.text);
        break;
      case 'remove':
        taskQueue.remove(id, body.itemId);
        break;
      case 'reorder':
        taskQueue.reorder(id, body.order);
        break;
      case 'pause':
        taskQueue.setPaused(id, body.paused === true);
        break;
      case 'retry':
        taskQueue.retry(id, body.itemId);
        break;
      case 'clear':
        taskQueue.clearFinished(id);
        break;
      case 'budget':
        taskQueue.setBudget(id, body);
        break;
    }
  } catch (err) {
    if (err instanceof QueueError) return json(res, err.status, { error: err.message });
    throw err;
  }
  return json(res, 200, { queue: taskQueue.view(id) });
}

/** Session ids a Claude Code process may be writing right now (web sessions alive, CLI turns running). */
function activeSessionIds() {
  const ids = new Set();
  for (const rt of hub.runtime.values()) {
    const st = rt.status;
    if (st.alive && st.sessionId) ids.add(st.sessionId);
    if (st.cliBusy && st.cliSession) ids.add(st.cliSession);
  }
  return ids;
}

/** POST /api/backup/export: the backup .zip, streamed (never held in memory). */
async function exportBackup(req, res) {
  if (!isLocal(req)) return json(res, 403, { error: 'Backup hanya bisa dari laptop.' });
  if (backupBusy) return json(res, 409, { error: 'Export/import riwayat lain sedang berjalan. Tunggu sampai selesai.' });
  backupBusy = true;
  try {
    hub.save(); // the state file on disk and in the backup agree
    const name = `adhit-office-backup-${new Date().toLocaleDateString('sv-SE')}.zip`; // local date, YYYY-MM-DD
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    const result = await writeBackup(res, { state: hub.exportState(), usageFile: ledger.file, appVersion: APP_VERSION });
    res.end();
    const skipped = result.skipped.length ? `, ${result.skipped.length} dilewati (symlink/nama tidak valid)` : '';
    console.log(`Backup riwayat diekspor: ${result.files} file, ${(result.bytes / 1024 ** 2).toFixed(1)} MB${skipped}`);
  } catch (err) {
    console.error('Export backup gagal:', err?.stack ?? err);
    // Headers are out: cut the connection so the browser reports a failed download, not a broken .zip.
    if (res.headersSent) res.destroy();
    else json(res, 500, { error: 'Export gagal. Lihat log server.' });
  } finally {
    backupBusy = false;
  }
}

/** Streams the request body to `file`, refusing it (413) once it passes `limit` bytes. */
async function receiveUpload(req, file, limit) {
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > limit) cb(new HttpError(413, `File backup terlalu besar (maks ${Math.round(limit / 1024 ** 2)} MB).`));
      else cb(null, chunk);
    },
  });
  // A dropped upload must not leave the temp file open.
  req.once('close', () => !req.complete && counter.destroy(new HttpError(400, 'Upload terputus.')));
  req.once('error', (err) => counter.destroy(err));
  req.pipe(counter);
  try {
    await pipeline(counter, createWriteStream(file)); // req stays out of the pipeline, so a 413 can still be answered
  } finally {
    req.unpipe(counter);
  }
  return size;
}

/** POST /api/backup/import: raw .zip body → temp file in DATA_DIR/tmp → merged restore → JSON summary. */
async function importBackup(req, res) {
  if (!isLocal(req)) return json(res, 403, { error: 'Backup hanya bisa dari laptop.' });
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!ZIP_TYPES.has(type)) return json(res, 415, { error: 'Kirim file .zip hasil Export riwayat.' });
  if (Number(req.headers['content-length']) > MAX_BACKUP_BYTES) throw new HttpError(413, `File backup terlalu besar (maks ${Math.round(MAX_BACKUP_BYTES / 1024 ** 2)} MB).`);
  if (backupBusy) {
    res.on('finish', () => req.destroy()); // don't read an upload that is refused
    return json(res, 409, { error: 'Export/import riwayat lain sedang berjalan. Tunggu sampai selesai.' });
  }
  backupBusy = true;
  const tmpDir = path.join(DATA_DIR, 'tmp');
  const file = path.join(tmpDir, `import-${Date.now()}-${randomBytes(4).toString('hex')}.zip`);
  try {
    await mkdir(tmpDir, { recursive: true });
    await receiveUpload(req, file, MAX_BACKUP_BYTES);
    const running = [...hub.runtime.values()].some((rt) => rt.status.busy || rt.status.cliBusy);
    const result = await restoreBackup(file, { activeSessions: activeSessionIds(), ledger, onFileWritten: (f) => mirror.markSeen(f) });
    const { summary, state: imported, remap } = result;
    if (running) summary.warnings.unshift('Ada sesi Claude yang sedang berjalan saat import: file sesinya tidak ditimpa. Import lagi setelah selesai bila perlu.');

    // Office state: folders first (they decide which projects exist here), then per-project data by id.
    // A backup names folders (roots, added folders, project paths): only ones below this home are used.
    const home = os.homedir();
    const outside = (p) => `Folder dari backup dilewati (di luar folder home ${home}, atau tidak ada): ${p}. Tambahkan manual bila perlu.`;
    summary.state = { roots: 0, custom: 0, favorites: 0, settings: 0, teamNames: 0 };
    if (imported) {
      const { skipped, ...added } = hub.mergeFolders(imported, { mapPath: remap.mapPath, roots: projectRoots(), accept: (p) => isUnderHome(p, home) && isDirectory(p) });
      Object.assign(summary.state, added);
      for (const p of skipped) summary.warnings.push(outside(p));
    }
    refreshProjects();
    // Projects whose history came back are listed when their folder exists on this machine.
    summary.projectsAdded = [];
    for (const p of result.projects) {
      if (!p.cwd || !p.sessions || hub.projects.has(idOfPath(p.cwd))) continue;
      if (!isUnderHome(p.cwd, home)) {
        summary.warnings.push(outside(p.cwd));
      } else if (isDirectory(p.cwd)) {
        hub.addCustomProject(p.cwd);
        summary.projectsAdded.push(p.cwd);
      } else {
        summary.warnings.push(`Folder project belum ada di laptop ini: ${p.cwd}. Riwayatnya sudah dipulihkan; project muncul setelah foldernya ada (clone/salin, lalu ⚙ → tambah folder).`);
      }
    }
    if (imported) {
      const idMap = new Map();
      for (const p of hub.projects.values()) {
        if (!p.path) continue;
        idMap.set(p.id, p.id);
        idMap.set(idOfPath(remap.unmapPath(path.resolve(p.path))), p.id); // the id this folder had on the old machine
      }
      Object.assign(summary.state, hub.mergeProjectData(imported, idMap));
      // Team names: only roles this machine has not renamed itself.
      const own = hub.persisted.teamNames ?? {};
      const names = { ...cleanTeamNames(imported.teamNames), ...own };
      summary.state.teamNames = Object.keys(names).length - Object.keys(own).length;
      hub.persisted.teamNames = names;
    }
    hub.save();
    refreshProjects(); // broadcasts config + projects: every open page shows the restored history
    if (!mirror.running) mirror.start(); // ~/.claude/projects may only exist since this import
    console.log(`Backup riwayat diimpor: ${summary.projects} project, sesi +${summary.sessions.added} diperbarui ${summary.sessions.updated}`);
    return json(res, 200, summary);
  } catch (err) {
    if (err instanceof ZipError) return json(res, 400, { error: `File backup tidak valid: ${err.message}` });
    if (err instanceof BackupError) return json(res, err.status, { error: err.message });
    throw err;
  } finally {
    await rm(file, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    backupBusy = false;
  }
}

/** Replies with what a Claude Code control request answered, or its error as a 400. */
async function answer(res, promise) {
  try {
    return json(res, 200, (await promise) ?? {});
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
}

// ---------- pairing a phone ----------

async function servePairPage(res, message = '') {
  const html = (await readFile(path.join(PUBLIC_DIR, 'pair.html'), 'utf8')).replace('__MESSAGE__', message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function deviceCookie(token, secure) {
  // __Host-: browsers only accept it with Secure, Path=/ and no Domain.
  if (secure) return `${HTTPS_DEVICE_COOKIE}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
  return `${DEVICE_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
}

/** GET /pair?k=… (QR link), GET /pair (code form), POST /pair {code}. */
async function handlePair(req, res, url) {
  const userAgent = String(req.headers['user-agent'] ?? '');
  const ip = String(req.socket.remoteAddress ?? '');
  const key = url.searchParams.get('k');
  const secure = isSecure(req);
  const transport = { transport: transportOf(req) }; // the token works only over the transport it was paired on
  if (req.method === 'GET' && key) {
    const result = remote.pair({ key }, userAgent, ip, transport);
    if (!result.token) return servePairPage(res, result.error);
    publishConfig();
    res.writeHead(302, { 'Set-Cookie': deviceCookie(result.token, secure), Location: '/' }); // drop the key from the address bar
    return res.end();
  }
  if (req.method === 'GET') return servePairPage(res);
  if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) return json(res, 405, { error: 'method not allowed' });
  const result = remote.pair({ code: (await readJson(req, MAX_PAIR_BODY)).code }, userAgent, ip, transport);
  if (result.retryAfter) {
    res.setHeader('Retry-After', String(result.retryAfter));
    return json(res, 429, result);
  }
  if (!result.token) return json(res, 400, result);
  publishConfig();
  res.writeHead(200, { 'Set-Cookie': deviceCookie(result.token, secure), 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ ok: true }));
}

// ---------- request handling (shared by the localhost, LAN and https listeners) ----------

async function handler(req, res) {
  const secure = isSecure(req);
  const scheme = secure ? 'https' : 'http';
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  // COOP: honoured on trustworthy origins only (localhost, https). No HSTS on purpose: it would apply to the
  // MagicDNS name on every port (docs/design-web-push.md D4).
  if (isLocal(req) || secure) for (const [name, value] of Object.entries(LOCAL_SECURITY_HEADERS)) res.setHeader(name, value);
  // DNS-rebinding guard: only answer to our own host names, per scheme (https: the MagicDNS name only).
  const host = String(req.headers.host).toLowerCase();
  const hosts = allowedHosts(secure);
  if (!hosts.includes(host)) return json(res, 421, { error: 'bad host' });
  // Origin must match scheme and host: an http page can't call the https origin, nor the other way round.
  if (req.headers.origin && !hosts.some((h) => req.headers.origin === `${scheme}://${h}`)) return json(res, 403, { error: 'bad origin' });
  const { pathname, searchParams } = new URL(req.url, `${scheme}://${host}`);
  const local = isLocal(req);
  let device = null; // the paired phone making this request (null on the laptop)
  try {
    if (!local) {
      // Another device on the network: it must be paired, and some settings stay laptop-only.
      if (!remote.enabled) return json(res, 403, { error: 'Akses dari perangkat lain sedang dimatikan.' });
      if (pathname === '/pair') return await handlePair(req, res, new URL(req.url, `${scheme}://${host}`));
      // App icon + manifest hold no data, and browsers fetch the manifest without cookies.
      if (req.method === 'GET' && PUBLIC_ASSET.test(pathname)) return await serveStatic(pathname, res, req);
      device = remote.verify(deviceToken(req), { transport: transportOf(req) });
      if (!device) {
        if (req.method === 'GET' && pathname !== '/stream' && !pathname.startsWith('/api/')) {
          res.writeHead(302, { Location: '/pair' });
          return res.end();
        }
        return json(res, 401, { error: 'Perangkat belum dipasangkan.' });
      }
      if (LOCAL_ONLY.has(pathname) || pathname.startsWith('/api/remote') || LOCAL_ONLY_ACTION.test(pathname)) return json(res, 403, { error: 'Pengaturan ini hanya bisa diubah dari laptop.' });
      if (ACCOUNT_AUTH.has(pathname) && !canManageAccount(req)) return json(res, 403, { error: 'Login/logout dari HP hanya lewat Tailscale (koneksi terenkripsi), bukan WiFi biasa.' });
      // The one gate for plain-HTTP WiFi: read-only, by allowlist (a new endpoint is refused until listed there).
      if (pathname.startsWith('/api/') && isReadOnly(req) && !wifiAllows(pathname)) return json(res, 403, { error: READ_ONLY_ERROR, readOnly: true });
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, device);
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    if (pathname === '/stream') return openStream(req, res, local, device, device ? deviceToken(req) : null);
    // pid: for scripts/restart.mjs on this laptop (its fallback when a clean shutdown hangs).
    if (pathname === '/health') return json(res, 200, { ok: true, claude: Boolean(claude), ...(local ? { pid: process.pid } : {}) });
    if (pathname === '/pair' && searchParams.size === 0) return servePairPage(res);
    return await serveStatic(pathname, res, req);
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 413) res.on('finish', () => req.destroy()); // stop reading the rest of an oversized body
      if (!res.headersSent) return json(res, err.status, { error: err.message });
      return res.end();
    }
    // Details (paths, stack) stay in the server log; the browser only gets a generic message.
    console.error(`${req.method} ${req.url}:`, err?.stack ?? err);
    if (!res.headersSent) json(res, 500, { error: 'Terjadi kesalahan di server.' });
    else res.end();
  }
}

const server = http.createServer(handler);

// While phone access is on: one extra http listener per LAN address (never 0.0.0.0), and one https
// listener per Tailscale address once a certificate is usable (src/tls.js).
const lanServers = new Map(); // ip -> { server, sockets }
const httpsServers = new Map(); // ip -> { server, sockets, fingerprint }

function closeListener(map, ip) {
  const entry = map.get(ip);
  entry.server.close();
  for (const socket of entry.sockets) socket.destroy(); // also ends open event streams
  map.delete(ip);
}

function openListener(map, ip, port, server, label, extra = {}) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('error', (err) => {
    console.error(`Akses HP di ${ip}:${port} gagal: ${err.message}`);
    if (map.get(ip)?.server === server) map.delete(ip);
  });
  server.listen(port, ip, () => console.log(`Akses HP aktif: ${label}`));
  map.set(ip, { server, sockets, ...extra });
}

/** Tailscale interface addresses the https listener binds to (loopback only under OFFICE_HTTPS_TEST_BIND). */
const httpsAddresses = () => (HTTPS_TEST_BIND ? [HTTPS_TEST_BIND] : networkAddresses().filter((a) => a.kind === 'tailscale').map((a) => a.ip));

function syncListeners() {
  const wanted = new Set(remote.enabled ? lanAddresses() : []);
  for (const ip of [...lanServers.keys()]) if (!wanted.has(ip)) closeListener(lanServers, ip);
  for (const ip of wanted) if (!lanServers.has(ip)) openListener(lanServers, ip, PORT, http.createServer(handler), `http://${ip}:${PORT}`);

  // https: only with a usable certificate; a renewed one is swapped in without dropping connections.
  const cert = remote.enabled && HTTPS_PORT !== null && tls.usable ? tls.material : null;
  const wantedHttps = new Set(cert ? httpsAddresses() : []);
  for (const ip of [...httpsServers.keys()]) if (!wantedHttps.has(ip)) closeListener(httpsServers, ip);
  for (const ip of wantedHttps) {
    const entry = httpsServers.get(ip);
    if (entry) {
      if (entry.fingerprint !== cert.fingerprint) {
        entry.server.setSecureContext({ cert: cert.cert, key: cert.key });
        entry.fingerprint = cert.fingerprint;
      }
      continue;
    }
    const server = https.createServer({ cert: cert.cert, key: cert.key, minVersion: 'TLSv1.2' }, handler);
    // Slow-loris guard for the phone-facing listener (event streams are responses, not affected).
    server.headersTimeout = 15_000;
    server.requestTimeout = 120_000;
    openListener(httpsServers, ip, HTTPS_PORT, server, `https://${cert.host}:${HTTPS_PORT} (${ip})`, { fingerprint: cert.fingerprint });
  }
}
// WiFi changes (new IP) are picked up without a restart; so is a certificate passing its expiry date.
setInterval(() => {
  try {
    tls.tick();
    if (remote.enabled) syncListeners();
  } catch (err) {
    console.error('Sinkronisasi listener gagal:', err?.stack ?? err); // retried in 30 s; never crashes the server
  }
}, 30000).unref();

refreshProjects();
hub.ready = true;
taskQueue.start();
backupScheduler.start();
const mirroring = mirror.start();
// Know who is logged in (usage is tagged with it); notice logins/logouts done in a terminal too.
account.refreshProfile(true).catch(() => {});
setInterval(() => account.refreshProfile(true).catch(() => {}), 60_000).unref();
// Phones unused for DEVICE_IDLE_MS are unpaired: now (after a long shutdown) and every hour.
remote.pruneIdle();
setInterval(() => remote.pruneIdle(), 60 * 60 * 1000).unref();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} sudah dipakai — Adhit Office mungkin sudah berjalan.`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Adhit Office berjalan di ${url}`);
  console.log(claude ? `Claude Code: ${claude.command}` : 'PERINGATAN: Claude Code tidak ditemukan (set env CLAUDE_BIN).');
  console.log(`Folder projects: ${projectRoots().join('; ')}  ·  Role agents: ${Object.keys(sessions.agents).join(', ') || '-'}`);
  console.log(mirroring ? 'Mirror CLI: aktif (membaca ~/.claude/projects)' : 'Mirror CLI: nonaktif (~/.claude/projects tidak ada)');
  console.log('Tekan Ctrl+C untuk berhenti.');
  if (cutShort.length) console.log(`Giliran terputus saat server berhenti: ${cutShort.length} project (tombol "Lanjutkan" di chat).`);
  if (HTTPS_PORT_WARNING) console.error(`PERINGATAN: ${HTTPS_PORT_WARNING}`);
  if (process.env.OFFICE_TAILSCALE_BIN) console.error(`PERINGATAN: OFFICE_TAILSCALE_BIN dipakai (${process.env.OFFICE_TAILSCALE_BIN}) — Tailscale CLI bukan dari lokasi bawaan.`);
  if (HTTPS_TEST_BIND) console.error('PERINGATAN: OFFICE_HTTPS_TEST_BIND aktif — listener HTTPS di 127.0.0.1 (hanya untuk test).');
  syncListeners();
  tls.start(); // a certificate on disk is used at once; Tailscale is asked in the background
  sessions.probeCatalog(); // what /model offers and the slash commands' descriptions (no model call)
  if (process.argv.includes('--open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  }
});

// Clean stop (Ctrl+C, SIGTERM, ⚙ → Matikan server, scripts/restart.mjs): running turns are recorded as cut short
// and interrupted so Claude Code closes them in its transcript (see SessionManager.shutdown), then the process ends.
// A second Ctrl+C, or a shutdown that hangs, ends it at once; the turn records are already on disk by then.
const SHUTDOWN_HARD_LIMIT_MS = 10_000;
let stopping = false;
async function shutdown() {
  if (stopping) {
    hub.save();
    process.exit(1);
  }
  stopping = true;
  setTimeout(() => {
    hub.save();
    process.exit(1);
  }, SHUTDOWN_HARD_LIMIT_MS).unref();
  server.close(); // no new connections; open event streams end with the process
  for (const { server: lan } of [...lanServers.values(), ...httpsServers.values()]) lan.close();
  tls.stop();
  mirror.stop();
  try {
    await sessions.shutdown();
  } catch (err) {
    console.error('Shutdown:', err?.stack ?? err);
  }
  hub.save();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
