// Adhit Office server: runs headless Claude Code per project and serves the office web app.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaude } from './src/claude-bin.js';
import { findOpenCode, openCodeVersion } from './src/opencode-bin.js';
import { OPENCODE_CAPS } from './src/acp-session.js';
import { ClaudeCheckService } from './src/claude-check.js';
import { OpenCodeCheckService } from './src/opencode-check.js';
import { AppUpdater } from './src/app-update.js';
import { Hub } from './src/hub.js';
import { discoverProjects, isDirectory } from './src/projects.js';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { writeBackup } from './src/backup.js';
import { AccountService, accountPrivacyView, accountViewKey } from './src/account.js';
import { autostartStatus } from './src/autostart.js';
import { UsageLedger } from './src/usage.js';
import { moduleGraph, preloadTags } from './src/modules.js';
import { TranscriptMirror } from './src/mirror.js';
import { DEVICE_COOKIE, HTTPS_DEVICE_COOKIE, READ_ONLY_ERROR, RemoteAccess, WIFI_READ_API, isTailscaleConnection, lanAddresses, networkAddresses, wifiAllows, wifiConfig } from './src/remote.js';
import { TailscaleCert, httpsPortFrom, restrictDir } from './src/tls.js';
import { PushService, wifiApproval } from './src/push.js';
import { activeAgents, storedEnabled, teamPrompt } from './src/role-catalog.js';
import { loadAgentDefinitions, setActiveRoles, setRoleMemory } from './src/roles.js';
import { engineClassifier, RoleMemory } from './src/role-memory.js';
import { SessionManager } from './src/session.js';
import { TemplateStore } from './src/templates.js';
import { TaskQueue } from './src/queue.js';
import { BackupScheduler } from './src/backup-schedule.js';
import { SpotifyService, wifiSpotifyState } from './src/spotify.js';
import { trustSystemCertificates } from './src/system-ca.js';
import { createSpotifyLauncher } from './src/spotify-launcher.js';
import { callback as spotifyCallback } from './src/routes/spotify.js';
import { wifiAccountAlert } from './src/routes/account.js';
import { wifiGithubLogin } from './src/github-pr.js';
import { HttpError, json, readJson } from './src/routes/http.js';
import { buildRouter } from './src/routes/index.js';
import { teamConfig } from './src/routes/team.js';

const PORT = Number(process.env.OFFICE_PORT ?? 4317);
const HOST = '127.0.0.1';
// HTTPS for phones over Tailscale (src/tls.js): its own port, bound only to the Tailscale interface.
// null = HTTPS off (the port clashes with OFFICE_PORT); a warning is logged at start.
const { port: HTTPS_PORT, warning: HTTPS_PORT_WARNING } = httpsPortFrom(process.env.OFFICE_HTTPS_PORT, PORT);
// Tests only: bind the https listener to loopback instead of the Tailscale interface (CI has none).
// Loopback only, never another address; a TLS socket is never treated as the laptop (isLocal), so this
// cannot grant anything: such a client is an ordinary paired phone on a non-Tailscale link (read-only).
const HTTPS_TEST_BIND = process.env.OFFICE_HTTPS_TEST_BIND === '127.0.0.1' ? '127.0.0.1' : null;
// Tests only: point ♪ Spotify at test-support/fake-spotify.mjs. Loopback only; tokens are bound to the origin that
// issued them (src/spotify.js), so this can never send a real token anywhere else.
const SPOTIFY_TEST_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(process.env.OFFICE_SPOTIFY_TEST_ORIGIN ?? '') ? process.env.OFFICE_SPOTIFY_TEST_ORIGIN : null;
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
// Used until roots are set in the web UI: env, else the folder this app lives in.
const DEFAULT_ROOT = path.resolve(process.env.PROJECTS_ROOT ?? path.dirname(APP_DIR));
const MAX_BODY = 30 * 1024 * 1024; // prompts may carry 📎 attachments (max 20 MB, base64 in JSON)
// A history backup upload (POST /api/backup/import, raw .zip): large, but not unbounded. Env override for tests.
const MAX_BACKUP_BYTES = Number(process.env.OFFICE_BACKUP_MAX_BYTES) || 4 * 1024 ** 3;
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
// The https (Tailscale) origin also runs the push service worker and offers the manifest for install: explicit
// rather than through the default-src fallback (docs/design-web-push.md §A3, §D).
const SECURE_CSP = `${SECURITY_HEADERS['Content-Security-Policy']}; worker-src 'self'; manifest-src 'self'`;
// Browsers honour COOP only on trustworthy origins (localhost); on http://<LAN/Tailscale IP> they ignore it
// and log a console error, so it is sent to the laptop's own page only.
const LOCAL_SECURITY_HEADERS = { 'Cross-Origin-Opener-Policy': 'same-origin' };

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

// Before any outgoing HTTPS: also trust the OS certificate store (TLS-inspecting proxies such as Zscaler).
const SYSTEM_CERTS = trustSystemCertificates();

// OFFICE_DATA_DIR lets tests run against a throwaway state file.
const DATA_DIR = process.env.OFFICE_DATA_DIR ?? path.join(APP_DIR, 'data');
const hub = new Hub({ dataDir: DATA_DIR });
// state.json holds the VAPID private key and push subscriptions: owner-only folder, like data/tls (best effort,
// in the background; a failure is only logged).
mkdirSync(DATA_DIR, { recursive: true });
restrictDir(DATA_DIR, (msg) => console.error(`Folder data: ${msg}`));
// Turns the last run left unfinished (stopped mid-turn, cleanly or not): a notice + "Lanjutkan" in their chat.
const cutShort = hub.recoverTurns();
// Leftovers of an import cut short by a crash or shutdown (uploaded .zip files): only this app writes there.
rmSync(path.join(DATA_DIR, 'tmp'), { recursive: true, force: true });
const claude = findClaude();
const opencode = findOpenCode(); // optional second engine (src/acp-session.js); null when not installed
let opencodeVersion = ''; // filled shortly after start (opencode --version), then sent with the config
// Every role's subagent template; only the active team's go to `claude --agents` (saveTeam).
const allAgents = loadAgentDefinitions(path.join(APP_DIR, '.claude', 'agents'));
const initialTeam = storedEnabled(hub.persisted.team);
setActiveRoles(initialTeam);
// 🧭 Learned role mappings: corrections, the project's .office-roles.json and (optional) the AI's answers.
const roleMemory = new RoleMemory({
  hub,
  classify: engineClassifier({ engine: () => hub.engine, claude, opencode, dataDir: DATA_DIR }),
  aiDelayMs: Number(process.env.OFFICE_ROLE_AI_DELAY_MS ?? 20_000),
});
setRoleMemory({ lookup: (key, projectPath) => roleMemory.lookup(key, projectPath), unknown: (key, hint, projectPath) => roleMemory.noteUnknown(key, hint, projectPath) });

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
const sessions = new SessionManager({ hub, claude, opencode, agents: activeAgents(allAgents, initialTeam), teamPrompt: teamPrompt(initialTeam, Object.keys(allAgents)), ledger, account });
const mirror = new TranscriptMirror(hub, { ledger });
// A device unpaired for being idle loses its open event streams at once, like "Cabut".
const remote = new RemoteAccess(hub, {
  onExpire: (devices) => {
    for (const d of devices) {
      dropDeviceStreams(d.id);
      push.forgetDevice(d.id); // its subscription went with the record; its notification buttons go too
    }
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
// ♪ Spotify (src/spotify.js): polls only while an event stream is open; tokens stay in data/spotify.json (not in backups).
const spotify = new SpotifyService({
  file: path.join(DATA_DIR, 'spotify.json'),
  redirectUri: `http://127.0.0.1:${PORT}/spotify/callback`,
  viewers: () => hub.clients.size,
  onChange: (state) => hub.broadcast('spotify', state),
  envClientId: process.env.SPOTIFY_CLIENT_ID,
  // ▶ with no device may start the desktop app in the background (never in test mode: no real Spotify from tests).
  launcher: SPOTIFY_TEST_ORIGIN ? null : createSpotifyLauncher(),
  ...(SPOTIFY_TEST_ORIGIN ? { accountsOrigin: SPOTIFY_TEST_ORIGIN, apiOrigin: SPOTIFY_TEST_ORIGIN, artHosts: new Set([new URL(SPOTIFY_TEST_ORIGIN).host]) } : {}),
});
// "Kecilkan saat izin": counted on the server, so it works with no page open.
hub.observers.add((type, data) => spotify.observeApproval(type, data, hub.approvals.size));
// Plain-HTTP WiFi can be sniffed: read-only streams get these events (and snapshot keys) without device names or
// the account email (hub.broadcast per-client view; openStream applies the same to the snapshot).
hub.redactors.set('spotify', wifiSpotifyState);
hub.redactors.set('account-alert', wifiAccountAlert);
hub.redactors.set('config', wifiConfig);
hub.redactors.set('github-login', wifiGithubLogin); // gh's one-time device code: whoever reads it can approve the login
// 👤 Akun on WiFi: plan and quota only, never the email/name/org; ids opaque but stable (key in the data dir).
const accountPrivacy = accountPrivacyView(accountViewKey(path.join(DATA_DIR, 'account-view.key')));
hub.redactors.set('account', accountPrivacy.state);
// 📋 Antrian: prompts sent one by one whenever the project's session is idle (src/queue.js).
const taskQueue = new TaskQueue({ hub, sessions });
sessions.onRateLimit = (id, info) => taskQueue.onRateLimit(id, info);
// 🔔 Web Push to paired https phones (src/push.js): permission requests, turn done/error, queue paused.
const push = new PushService({
  hub,
  remote,
  queueSummary: (id) => taskQueue.summary(id),
  hasStream: (deviceId) => [...deviceStreams.values()].includes(deviceId),
  onChange: () => publishConfig(),
});
push.seedQueues(Object.keys(taskQueue.queues)); // a pause from before this start is not news
hub.observers.add((type, data) => push.observe(type, data));
hub.redactors.set('approval', wifiApproval); // "answered from <phone name>": not over sniffable WiFi

// Claude Code update detector (src/claude-check.js): `claude --version` at start and every 6 h; a new version gets
// the light contract check in the background once no turn is busy. Its own file (not in history backups).
// OFFICE_CLAUDE_CHECK_DELAY_MS: tests only, how long after start the first look happens (default 20 s).
const CHECK_DELAY = Number(process.env.OFFICE_CLAUDE_CHECK_DELAY_MS);
// ⬆ Adhit Office's own updates (git fetch every 30 min, banner, "Update sekarang"). Off for test servers (a fake
// CLAUDE_BIN) unless OFFICE_UPDATE_CHECK=1; OFFICE_UPDATE_CHECK=0 turns it off anywhere.
const updateCheck = process.env.OFFICE_UPDATE_CHECK ? process.env.OFFICE_UPDATE_CHECK !== '0' : !process.env.CLAUDE_BIN;
const appUpdater = new AppUpdater({
  appDir: APP_DIR,
  firstCheckMs: updateCheck ? Number(process.env.OFFICE_UPDATE_FIRST_CHECK_MS ?? 60_000) : -1,
  busy: () => [...sessions.sessions.values()].some((s) => s.turnActive()),
  onChange: (view) => {
    if (!hub.config) return;
    hub.config.appUpdate = view;
    hub.broadcast('config', hub.config);
  },
});
const claudeCheck = new ClaudeCheckService({
  file: path.join(DATA_DIR, 'claude-check.json'),
  claude,
  isBusy: () => [...hub.runtime.values()].some((rt) => rt.status.busy),
  onChange: (view) => {
    hub.config = { ...hub.config, claudeCheck: view };
    hub.broadcast('config', hub.config);
  },
  ...(Number.isInteger(CHECK_DELAY) && CHECK_DELAY >= 0 && CHECK_DELAY <= 600_000 ? { timing: { startDelayMs: CHECK_DELAY } } : {}),
});
// OpenCode update detector (src/opencode-check.js): the same, for `opencode --version`; its light contract never calls
// a model. Silent when OpenCode is not installed. OFFICE_OPENCODE_CHECK_DELAY_MS: first look after start (default
// 45 s). A fake OPENCODE_BIN (a .js/.mjs file: tests) gets no automatic check unless that delay is set.
const OC_CHECK_DELAY_RAW = process.env.OFFICE_OPENCODE_CHECK_DELAY_MS;
const OC_CHECK_DELAY = Number(OC_CHECK_DELAY_RAW);
const OC_CHECK_AUTO = OC_CHECK_DELAY_RAW !== undefined || !/\.[cm]?js$/.test(process.env.OPENCODE_BIN ?? '');
const opencodeCheck = new OpenCodeCheckService({
  file: path.join(DATA_DIR, 'opencode-check.json'),
  opencode,
  isBusy: () => [...hub.runtime.values()].some((rt) => rt.status.busy),
  onChange: (view) => {
    hub.config = { ...hub.config, opencodeCheck: view };
    // The version the check read is the installed one: the engine button in Akun shows it too.
    // opencodeVersion too: refreshProjects rebuilds the config from it and must not bring back the old version.
    if (view.version) opencodeVersion = view.version;
    if (view.version && hub.config.engines?.opencode) hub.config.engines.opencode.version = view.version;
    hub.broadcast('config', hub.config);
  },
  ...(Number.isInteger(OC_CHECK_DELAY) && OC_CHECK_DELAY >= 0 && OC_CHECK_DELAY <= 600_000 ? { timing: { startDelayMs: OC_CHECK_DELAY } } : {}),
});

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
    spotify: { redirectUri: spotify.redirectUri }, // shown (with a copy button) in ⚙ → Spotify
    claudeCheck: claudeCheck.publicView(), // versions + last contract check result (no details)
    opencodeCheck: opencodeCheck.publicView(), // the same for OpenCode (available: false when not installed)
    appUpdate: appUpdater.publicView(), // ⬆ a newer Adhit Office on GitHub (src/app-update.js)
    // The engines a project can run on (docs/design-opencode.md §6.1): Claude Code's caps are the UI's defaults.
    engine: hub.engine, // the app-wide engine (Akun): each one is its own workspace (Hub.switchEngine)
    engines: {
      claude: { available: Boolean(claude), version: hub.catalogConfig().version ?? '' },
      opencode: { available: Boolean(opencode), version: opencodeVersion, caps: OPENCODE_CAPS },
    },
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
// Spotify's Client ID, login and logout: laptop only (the redirect URI is the laptop's 127.0.0.1).
// ⚙ Cek kompatibilitas Claude Code (run, settings): laptop only (it spawns Claude Code, maybe a model call).
// ⚙ Kompatibilitas OpenCode (run, settings): laptop only too (it spawns `opencode acp`).
const LOCAL_ONLY = new Set(['/api/app-update/check', '/api/app-update/run', '/api/claude-check/run', '/api/claude-check/settings', '/api/claude-check/doctor', '/api/claude-check/update', '/api/opencode-check/run', '/api/opencode-check/settings', '/api/autostart', '/api/shutdown', '/api/config', '/api/projects', '/api/backup/export', '/api/backup/import', '/api/backup/schedule', '/api/backup/schedule/save', '/api/backup/schedule/run', '/api/spotify/config', '/api/spotify/login', '/api/spotify/logout']);
// Login/logout switch the account of every Claude Code on the laptop: from a phone only over
// Tailscale (encrypted), never over plain-HTTP WiFi where the device cookie could be sniffed.
// The same for switching engines and OpenCode's provider logins (API keys travel in these requests).
const ACCOUNT_AUTH = new Set(['/api/account/login', '/api/account/login/code', '/api/account/login/cancel', '/api/account/logout', '/api/engine', '/api/opencode/providers', '/api/opencode/login/key', '/api/opencode/login/oauth', '/api/opencode/login/status', '/api/opencode/login/code', '/api/opencode/login/cancel', '/api/opencode/logout']);
// Opening VS Code / Explorer only makes sense on the laptop itself.
// Changing saved permission rules (🛡️ Aturan izin) changes what Claude Code may do unasked: laptop only (phones may look).
const LOCAL_ONLY_ACTION = /^\/api\/projects\/[\w-]+\/(open|permissions-edit|mcp-add)$/;
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

async function serveStatic(pathname, res, req, extraHeaders = {}) {
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
    const headers = { 'Cache-Control': 'no-cache', ETag: etag, ...extraHeaders };
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
  const readOnly = isReadOnly(req);
  // secure: the https (Tailscale) origin. push: this phone's subscription state (https devices only, else null).
  const client = { local, accountAuth: canManageAccount(req), readOnly, readOnlyApi: WIFI_READ_API, secure: isSecure(req), push: isSecure(req) ? push.clientInfo(device) : null };
  const snap = { ...hub.snapshot(), account: account.publicState(), spotify: spotify.publicState() };
  // A snapshot key named like an event (config, spotify, …) gets that event's per-client view.
  for (const key of Object.keys(snap)) snap[key] = hub.viewFor(key, snap[key], readOnly);
  res.write(`event: snapshot\ndata: ${JSON.stringify({ ...snap, client })}\n\n`);
  if (readOnly) hub.redacted.add(res); // before it joins: no broadcast can reach it unredacted
  hub.clients.add(res);
  spotify.wake(); // the poller sleeps while nobody watches
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

async function handleApi(req, res, pathname, device = null) {
  const route = router.match(req.method, pathname);
  // Every API needs this start's token, except a route that carries its own (only /api/push/act: src/routes/push.js).
  if (!route?.route.noToken && req.headers['x-office-token'] !== TOKEN) return json(res, 403, { error: 'forbidden' });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  // Per request: the paired phone making it (null on the laptop).
  const reqCtx = { ...ctx, device };
  // The one API whose body is not JSON (a raw .zip, far over MAX_BODY, /api/backup/import): handled before readJson.
  if (route?.route.rawBody) return route.route.handler(reqCtx, req, res, route.params, null);
  if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'json only' });
  const body = await readJson(req, route?.route.maxBody ?? MAX_BODY);
  if (route) return route.route.handler(reqCtx, req, res, route.params, body);
  // Unknown path (also an unknown action under /api/projects/:id/): the same 404 as an unknown project.
  return json(res, 404, { error: 'project not found' });
}

// ---------- history backup (⚙ → Cadangkan riwayat) ----------

const backupLock = { busy: false }; // one export, import or scheduled backup at a time (src/routes/backup.js)

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
    return writeBackup(out, { state: hub.exportState(), usageFile: ledger.file, chatsDir: hub.backupChatsDir(), engineChats: hub.backupEngineChats(), appVersion: APP_VERSION });
  },
  lock: () => !backupLock.busy && (backupLock.busy = true),
  unlock: () => (backupLock.busy = false),
  onChange: (view) => hub.broadcast('backup-schedule', view),
  log: (msg) => console.log(msg),
});

// ---------- API routes (src/routes/*.js) ----------

// What every route handler gets as `ctx`: the services and the few server functions they call.
const ctx = {
  hub,
  sessions,
  claude, // ⚙ claude doctor / update (src/routes/claude-check.js)
  opencode,
  account,
  ledger,
  mirror,
  remote,
  tls,
  templates,
  taskQueue,
  push,
  spotify,
  backupScheduler,
  backupLock,
  claudeCheck,
  opencodeCheck,
  appUpdater,
  allAgents,
  roleMemory,
  appDir: APP_DIR,
  appVersion: APP_VERSION,
  dataDir: DATA_DIR,
  port: PORT,
  httpsPort: HTTPS_PORT,
  maxBackupBytes: MAX_BACKUP_BYTES,
  isLocal,
  canManageAccount, // laptop or Tailscale (♪ control: may start the Spotify app)
  isTailscale: (req) => isTailscaleConnection(req.socket.localAddress, req.socket.remoteAddress), // 🔔 push routes
  isReadOnly, // plain-HTTP WiFi phone (♪ state, 👤 account, report: reduced view)
  accountPrivacy, // that reduced account view (src/account.js accountPrivacyView)
  allowForce,
  projectRoots,
  refreshProjects,
  publishConfig,
  remoteInfo,
  httpsInfo,
  syncListeners,
  dropDeviceStreams,
  shutdown,
};
const router = buildRouter();

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
  if (secure) res.setHeader('Content-Security-Policy', SECURE_CSP);
  // COOP: honoured on trustworthy origins only (localhost, https). No HSTS on purpose: it would apply to the
  // MagicDNS name on every port (docs/design-web-push.md D4).
  if (isLocal(req) || secure) for (const [name, value] of Object.entries(LOCAL_SECURITY_HEADERS)) res.setHeader(name, value);
  // DNS-rebinding guard: only answer to our own host names, per scheme (https: the MagicDNS name only).
  const host = String(req.headers.host).toLowerCase();
  const hosts = allowedHosts(secure);
  if (!hosts.includes(host)) return json(res, 421, { error: 'bad host' });
  // Origin must match scheme and host: an http page can't call the https origin, nor the other way round.
  if (req.headers.origin && !hosts.some((h) => req.headers.origin === `${scheme}://${h}`)) return json(res, 403, { error: 'bad origin' });
  // A request target the URL parser refuses (e.g. `GET http://[ HTTP/1.1`): a 400, never an unhandled rejection.
  let pathname, searchParams;
  try {
    ({ pathname, searchParams } = new URL(req.url, `${scheme}://${host}`));
  } catch {
    return json(res, 400, { error: 'bad request' });
  }
  const local = isLocal(req);
  let device = null; // the paired phone making this request (null on the laptop)
  // The push service worker exists only on the https origin; http (laptop included) answers 404. A 404 on the update
  // check does NOT unregister an installed worker (the browser keeps the old one): a real kill switch would serve an
  // sw.js that calls self.registration.unregister(). Server-side, deleting device.push already stops every push.
  if (pathname === '/sw.js' && !(secure && req.method === 'GET')) return json(res, 404, { error: 'not found' });
  try {
    if (!local) {
      // Another device on the network: it must be paired, and some settings stay laptop-only.
      if (!remote.enabled) return json(res, 403, { error: 'Akses dari perangkat lain sedang dimatikan.' });
      if (pathname === '/spotify/callback') return json(res, 404, { error: 'not found' }); // the laptop's own login only
      if (pathname === '/pair') return await handlePair(req, res, new URL(req.url, `${scheme}://${host}`));
      // App icon + manifest hold no data, and browsers fetch the manifest without cookies.
      if (req.method === 'GET' && PUBLIC_ASSET.test(pathname)) return await serveStatic(pathname, res, req);
      // The worker script holds no data, and its update check must not depend on the cookie (design §D).
      if (pathname === '/sw.js') return await serveStatic(pathname, res, req, { 'Service-Worker-Allowed': '/' });
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
    // Spotify's redirect after login (laptop only). Handles its own errors: its URL holds the code and state.
    if (local && req.method === 'GET' && pathname === '/spotify/callback') return await spotifyCallback(ctx, req, res, new URL(req.url, `${scheme}://${host}`));
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
  if (opencode) {
    console.log(`OpenCode: ${opencode.command}`);
    openCodeVersion(opencode).then((v) => {
      opencodeVersion = v;
      if (!v || !hub.config?.engines?.opencode) return;
      hub.config.engines.opencode.version = v;
      hub.broadcast('config', hub.config);
    });
  }
  console.log(`Folder projects: ${projectRoots().join('; ')}  ·  Role agents: ${Object.keys(sessions.agents).join(', ') || '-'}`);
  console.log(mirroring ? 'Mirror CLI: aktif (membaca ~/.claude/projects)' : 'Mirror CLI: nonaktif (~/.claude/projects tidak ada)');
  if (SYSTEM_CERTS) console.log(`TLS: ${SYSTEM_CERTS} sertifikat dari sistem ikut dipercaya (proxy/antivirus yang memeriksa HTTPS).`);
  console.log('Tekan Ctrl+C untuk berhenti.');
  if (cutShort.length) console.log(`Giliran terputus saat server berhenti: ${cutShort.length} project (tombol "Lanjutkan" di chat).`);
  if (HTTPS_PORT_WARNING) console.error(`PERINGATAN: ${HTTPS_PORT_WARNING}`);
  if (process.env.OFFICE_TAILSCALE_BIN) console.error(`PERINGATAN: OFFICE_TAILSCALE_BIN dipakai (${process.env.OFFICE_TAILSCALE_BIN}) — Tailscale CLI bukan dari lokasi bawaan.`);
  if (HTTPS_TEST_BIND) console.error('PERINGATAN: OFFICE_HTTPS_TEST_BIND aktif — listener HTTPS di 127.0.0.1 (hanya untuk test).');
  if (SPOTIFY_TEST_ORIGIN) console.error(`PERINGATAN: OFFICE_SPOTIFY_TEST_ORIGIN aktif — Spotify: MODE TEST (${SPOTIFY_TEST_ORIGIN}).`);
  else if (process.env.OFFICE_SPOTIFY_TEST_ORIGIN) console.error('PERINGATAN: OFFICE_SPOTIFY_TEST_ORIGIN diabaikan (hanya http://127.0.0.1:<port>).');
  spotify.start();
  syncListeners();
  tls.start(); // a certificate on disk is used at once; Tailscale is asked in the background
  sessions.probeCatalog(); // what /model offers and the slash commands' descriptions (no model call)
  claudeCheck.start(); // Claude Code updated? First look after a delay, in the background
  if (OC_CHECK_AUTO) opencodeCheck.start(); // OpenCode updated? Same, later (no-op when OpenCode is not installed)
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
  // A running contract check is aborted (its processes killed, whole tree) and not recorded; waited for ≤ 3 s.
  const checksStopped = Promise.allSettled([claudeCheck.stop(), opencodeCheck.stop()]);
  spotify.stop();
  try {
    await sessions.shutdown();
  } catch (err) {
    console.error('Shutdown:', err?.stack ?? err);
  }
  await checksStopped; // each stop() is itself bounded (STOP_WAIT_MS)
  hub.save();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
