// Adhitron server: runs headless Claude Code per project and serves the office web app.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants as zlibConstants, createGzip } from 'node:zlib';
import { findClaude } from './src/claude-bin.js';
import { findOpenCode, openCodeVersion } from './src/opencode-bin.js';
import { appPaths } from './src/app-paths.js';
import { SetupService } from './src/setup/service.js';
import { probeTools } from './src/setup/detect.js';
import { runtimeBinDirs } from './src/setup/runtime.js';
import { OPENCODE_CAPS } from './src/acp-session.js';
import { ClaudeCheckService } from './src/claude-check.js';
import { OpenCodeCheckService } from './src/opencode-check.js';
import { AppUpdater } from './src/app-update.js';
import { DesktopUpdater } from './src/desktop-update.js';
import { Hub } from './src/hub.js';
import { pruneAuth } from './src/auth-audit.js';
import { recordAudit } from './src/audit-log.js';
import { discoverProjects, isDirectory, isInside, isMissing } from './src/projects.js';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { writeBackup } from './src/backup.js';
import { AccountService, accountPrivacyView, accountViewKey } from './src/account.js';
import { autostartStatus, repairUnsafeAutologon } from './src/autostart.js';
import { helperMainSync, sweepLeftoverSecrets } from './src/autologon.js';
import { UsageLedger } from './src/usage.js';
import { moduleGraph, preloadTags } from './src/modules.js';
import { GzipCache, MIN_GZIP_BYTES, acceptsGzip, compressibleType, etagOf } from './src/compress.js';
import { TranscriptMirror } from './src/mirror.js';
import { OpenCodeMirror } from './src/opencode-mirror.js';
import { CiWatcher } from './src/github-ci.js';
import { findGh } from './src/github-pr.js';
import { DEVICE_COOKIE, HTTPS_DEVICE_COOKIE, READ_ONLY_ERROR, RemoteAccess, WIFI_READ_API, isTailscaleConnection, lanAddresses, networkAddresses, wifiAllows, wifiConfig } from './src/remote.js';
import { AccessPin, PinError, pinCooldownMs, pinMaxPerIpPerHour, pinMessage } from './src/access-pin.js';
import { WaLink, WaLinkError, pairStatus } from './src/wa-link.js';
import { EncryptedAuthStore } from './src/wa-auth-store.js';
import { TailscaleCert, httpsPortFrom, restrictDir } from './src/tls.js';
import { eligibleTailnetPeer } from './src/tailnet.js';
import { purgeTrash, TRASH_RETENTION_DAYS } from './src/session-admin.js';
import { PushService, wifiApproval } from './src/push.js';
import { activeAgents, storedEnabled, teamPrompt } from './src/role-catalog.js';
import { loadAgentDefinitions, setActiveRoles, setRoleMemory } from './src/roles.js';
import { engineClassifier, RoleMemory } from './src/role-memory.js';
import { SessionManager } from './src/session.js';
import { TemplateStore } from './src/templates.js';
import { TaskQueue } from './src/queue.js';
import { autoContext, classifyEffort } from './src/effort-classifier.js';
import { classifierModelFor } from './src/model-auto.js';
import { maxConcurrentOf } from './src/concurrency.js';
import { applyRetention, retentionOf } from './src/retention.js';
import { Metrics } from './src/metrics.js';
import { RoutineScheduler } from './src/routines.js';
import { BackupScheduler } from './src/backup-schedule.js';
import { SpotifyService, wifiSpotifyState } from './src/spotify.js';
import { trustSystemCertificates } from './src/system-ca.js';
import { createSpotifyLauncher } from './src/spotify-launcher.js';
import { callback as spotifyCallback } from './src/routes/spotify.js';
import { wifiAccountAlert } from './src/routes/account.js';
import { wifiGithubLogin } from './src/github-pr.js';
import { HttpError, json, readJson } from './src/routes/http.js';
import { buildRouter } from './src/routes/index.js';
import { fakeAutologon, windowsAutologon } from './src/routes/autologon.js';
import { status as waStatus } from './src/routes/wa.js';
import { POWER_SECURE_ERROR } from './src/power.js';
import { RemotePowerBeat } from './src/power-beat.js';
import { teamConfig } from './src/routes/team.js';
import { projectId } from './src/util.js';

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
const APP_DIR = process.env.OFFICE_APP_DIR
  ? path.resolve(process.env.OFFICE_APP_DIR)
  : (() => {
      // Packaged builds bundle this file into one executable: import.meta is empty there, so the files next to
      // the .exe are the app folder. Running from source keeps the repo folder.
      try {
        return path.dirname(fileURLToPath(import.meta.url));
      } catch {
        return path.dirname(process.execPath);
      }
    })();
// Resolvers (src/claude-bin.js, src/opencode-bin.js) look for the portable runtime through this: a packaged build
// runs from a folder that is not the cwd, and its CLI installs live beside the data folder, not on PATH.
process.env.OFFICE_APP_DIR ??= APP_DIR;
const APP_VERSION = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
// Optional Ed25519 public key (PEM) shipped next to the app: when present, every update needs a valid .sig asset.
const UPDATE_PUBKEY = (() => {
  try {
    return readFileSync(path.join(APP_DIR, 'update-pubkey.pem'), 'utf8');
  } catch {
    return null;
  }
})();
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const AI_LOGOS_DIR = path.join(APP_DIR, 'ai_logos'); // model logos shown in the office/brain (public, no data)
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
// A narrower token for the local CLI (`office claude` hook + `office pair`): it may only ask for an approval
// decision and read the pairing snapshot, never control the office.
const CLI_TOKEN = randomBytes(24).toString('hex');

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

// A packaged build keeps data outside the install folder (Program Files is not writable), a `portable` file next to
// the executable (or OFFICE_PORTABLE=1) keeps everything in .\data, and OFFICE_DATA_DIR/OFFICE_RUNTIME_DIR override
// either. src/app-paths.js is the single definition of that layout (the setup runtime lives beside data).
const APP_PATHS = appPaths({ appDir: APP_DIR });
const DATA_DIR = APP_PATHS.dataDir;
const RUNTIME_DIR = APP_PATHS.runtimeDir;

// Started hidden at Windows login: there is no console, so keep a log file instead.
if (process.argv.includes('--background')) {
  const logFile = path.join(DATA_DIR, 'server.log');
  mkdirSync(path.dirname(logFile), { recursive: true });
  // Keep the log bounded: at start, rotate a file over 5 MB (one previous copy is enough for diagnostics).
  try {
    if (statSync(logFile).size > 5 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
  } catch {
    // no log yet
  }
  const write = (level) => (...args) => appendFileSync(logFile, `[${new Date().toISOString()}] ${level} ${args.map(String).join(' ')}\n`);
  console.log = write('INFO');
  console.error = write('ERROR');
}

// 🪟 The elevated autologon helper (`--autologon-enable` / `--autologon-disable`) is a ONE-SHOT CLI: it writes
// HKLM\Winlogon (or clears it), reports through its exit code, and must never start a server, a listener or the
// event loops below. server.js calls it before anything else, then exits with exactly the code it returned.
// `helperMainSync` (src/autologon.js) is the blocking form of `helperMain`: the Windows build bundles this file to
// CommonJS (scripts/build-windows.mjs), where esbuild refuses a top-level `await`.
if (process.argv.includes('--autologon-enable') || process.argv.includes('--autologon-disable')) {
  process.exit(helperMainSync(process.argv));
}

// Before any outgoing HTTPS: also trust the OS certificate store (TLS-inspecting proxies such as Zscaler).
const SYSTEM_CERTS = trustSystemCertificates();

const hub = new Hub({ dataDir: DATA_DIR });
// 📈 Operational history for 🩺 Kesehatan (aggregate only, never conversation content). Counts this start, then the
// rolling seven days from data/metrics.json.
const metrics = new Metrics({ file: path.join(DATA_DIR, 'metrics.json') });
metrics.restart();
// state.json holds the VAPID private key and push subscriptions: owner-only folder, like data/tls (best effort,
// in the background; a failure is only logged).
mkdirSync(DATA_DIR, { recursive: true });
restrictDir(DATA_DIR, (msg) => console.error(`Folder data: ${msg}`));
// The audit's documented retention holds even on a quiet install (recordAuth only compacts on a new action).
pruneAuth(DATA_DIR, Date.now(), { force: true });
// Turns the last run left unfinished (stopped mid-turn, cleanly or not): a notice + "Lanjutkan" in their chat.
const cutShort = hub.recoverTurns();
// Leftovers of an import cut short by a crash or shutdown (uploaded .zip files): only this app writes there.
rmSync(path.join(DATA_DIR, 'tmp'), { recursive: true, force: true });
// The portable setup runtime comes before the host PATH, so a fresh machine that installed Node/Claude/OpenCode from
// the setup screen finds them in this process and in every child. The host PATH is kept, not replaced; a folder
// already present is not added twice.
const RUNTIME_BIN_DIRS = runtimeBinDirs(RUNTIME_DIR);
if (RUNTIME_BIN_DIRS.length) {
  const norm = (value) => (process.platform === 'win32' ? String(value).toLowerCase() : String(value));
  const wanted = [...new Set(RUNTIME_BIN_DIRS.map(norm))].map((key) => RUNTIME_BIN_DIRS.find((dir) => norm(dir) === key));
  const drop = new Set(wanted.map(norm));
  const host = String(process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => !drop.has(norm(entry)));
  process.env.PATH = [...wanted, ...host].join(path.delimiter);
}
let claude = findClaude();
let opencode = findOpenCode(); // optional second engine (src/acp-session.js); null when not installed
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
  sharedFile: path.join(APP_DIR, 'src', 'role-map.shared.json'), // 🌐 shipped with the app (and its updates)
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
// 📜 A terminal Claude Code session in a project that runs on OpenCode has no place in that project's Claude
// workspace: the mirror skips it (the project is listed from its folder, and OpenCode's terminal sessions are
// shown by openCodeMirror instead).
const onClaudeCode = (dir) => hub.engineOf(projectId(dir)) === 'claude';
const mirror = new TranscriptMirror(hub, { ledger, skipDir: (dir) => !insideKnownProjectDir(dir) || !onClaudeCode(dir) });
// 🖥 OpenCode sessions opened in a terminal (same background service): shown like Claude's CLI sessions.
const openCodeMirror = new OpenCodeMirror(hub, {
  bin: process.env.CLAUDE_BIN && !process.env.OFFICE_OPENCODE_MIRROR ? null : opencode, // test servers: only when asked
  ownSessions: () =>
    new Set(
      [
        ...[...sessions.sessions.values()].map((s) => s.acpSessionId),
        ...Object.values(hub.persisted.sessions ?? {}), // compatibility mirror
        ...Object.values(hub.persisted.sessionsByEngine ?? {}).flatMap((per) => Object.values(per ?? {})), // per engine
      ].filter(Boolean),
    ),
  skipDir: (dir) => dir.toLowerCase().startsWith(path.resolve(DATA_DIR).toLowerCase()) || !insideKnownProjectDir(dir), // the app's own helper runs / a foreign folder
  pollMs: Number(process.env.OFFICE_OPENCODE_MIRROR_MS ?? 5000),
  ledger,
});
// A project that moves to OpenCode may have sessions the mirror ignored earlier (its folder was a Claude project):
// clear that cache so those terminal sessions are picked up on the next poll.
sessions.onProjectEngineChange = () => openCodeMirror.clearIgnored();
// A device unpaired for being idle loses its open event streams at once, like "Cabut".
const remote = new RemoteAccess(hub, {
  onExpire: (devices) => {
    for (const d of devices) {
      dropDeviceStreams(d.id);
      push.forgetDevice(d.id); // its subscription went with the record; its notification buttons go too
    }
    publishConfig();
  },
  // A BRAND-NEW pairing code goes to the owner's already-paired phones by push (they cannot see this screen).
  // `push` is created below: the callback only runs once an API route asks for a code, never during startup.
  onNewCode: ({ code, expiresAt }) => {
    // Best effort (docs/design-web-push.md §B4): a push failure must never break pairing, and the code
    // never lands in the log — error messages of the push path carry no payload text.
    Promise.resolve(push.sendPairingCode({ code, expiresAt })).catch((err) => console.error('Push kode pasangan gagal:', err?.message ?? err));
  },
});

// 📱 WhatsApp runs INSIDE this process (src/wa-link.js): pairing is a QR scanned from the Settings page, and the
// session on disk is sealed (src/wa-auth-store.js). This replaces the old local sidecar and its four environment
// variables — nothing here reads a URL, a number, or an API key from the environment.
const WA_FAKE = process.env.OFFICE_WA_FAKE === '1';
// Tests only (never set in a real install): the autologon routes answer from an in-memory switch (src/routes/
// autologon.js), so the end-to-end test never raises a UAC prompt or writes HKLM/Startup. Warned about at start.
const AUTOLOGON_FAKE = process.env.OFFICE_AUTOLOGON_FAKE === '1';
// Tests only (never set in a real install): the fake socket below writes what it "sent" here, so the end-to-end test
// can read the PIN it delivered without a WhatsApp account. Nothing is written while the flag is off.
const WA_FAKE_SENT = WA_FAKE ? process.env.OFFICE_WA_FAKE_SENT : null;
// The sealed session is also read directly by the PIN transport below: without a session on disk there is nothing
// to reconnect, and a PIN request must not wait for a socket that will never exist.
const waStore = new EncryptedAuthStore({ dir: path.join(DATA_DIR, 'wa') });
const waLink = new WaLink({
  store: waStore,
  ...(WA_FAKE ? { socketFactory: fakeWaSocket } : {}),
  // An event carries the STATE only, never `qr` or `me`: a broadcast reaches every open client, and a socket that
  // was paired from a phone is not "read-only", so the redactor below cannot be the only line of defence. The QR is a
  // session credential and lives only in the laptop-only GET /api/wa/status; the laptop page polls that.
  onChange: (status) => hub.broadcast('wa', { state: status.state }),
});
// Second layer, the same rule as `config`/`spotify`: whatever the `wa` event grows into, a read-only (plain-WiFi)
// client is handed the state and nothing else — no key for the code, no key for the paired number.
hub.redactors.set('wa', (status) => ({ state: status.state }));

// 🔌 A restart must not quietly forget WhatsApp: the encrypted session on disk IS the login, so it is reconnected in
// the background (start-up never waits for the network, and a failure is only a log line). With no session there is
// nothing to restore — and restore() opens no socket in that case, so a credential-carrying QR never appears at boot.
void waLink
  .restore()
  .then((status) => {
    if (status.state === 'linked') console.log('WhatsApp: sesi tersambung ulang');
    else if (status.state === 'connecting') console.log('WhatsApp: menyambung di latar belakang');
    // A stored session can be unknown to WhatsApp any more (the phone removed this device): baileys then offers a
    // new QR. Nothing is lost — the QR stays laptop-only and the settings card asks for a re-link.
    else if (status.state === 'qr') console.error('WhatsApp: sesi tidak valid — perlu tautkan ulang dari laptop');
    else if (waLink.lastError) console.error('WhatsApp: sesi tidak bisa disambungkan ulang');
    else console.log('WhatsApp: sesi belum ada');
  })
  .catch(() => console.error('WhatsApp: sesi gagal disambungkan ulang'));

/**
 * How long a PIN send waits for WhatsApp to finish reconnecting. Opening the stored session takes a few seconds, and
 * the owner tapping "Kirim PIN" right after a restart must not be told to reload a page that cannot help; the PIN
 * lives 5 minutes, so waiting a little is harmless.
 */
const WA_LINK_WAIT_MS = 10_000;

/**
 * Polls until the link is 'linked' or the deadline passes. A link showing a QR needs the owner in front of the laptop,
 * and one that failed carries its reason in `lastError`: neither becomes 'linked' by waiting.
 * @param {import('./src/wa-link.js').WaLink} link
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
async function waitForLinked(link, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const status = await link.status(); // never throws
    if (status.state === 'linked') return true;
    if (status.state === 'qr' || (status.state === 'off' && link.lastError) || Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// The access PIN (src/access-pin.js) is delivered over WhatsApp to the linked account itself: the owner does not have
// to be in front of the laptop to let a new phone in. The PIN only exists inside the WhatsApp message — it is never
// logged, never returned by an endpoint, and only its HMAC is kept.
const accessPin = new AccessPin({
  send: async (pin) => {
    try {
      // A restart leaves the link 'off' while its encrypted session is still on disk. Reconnect it (and give the
      // socket a few seconds) before sending, so the PIN heals itself instead of sending the owner to a page reload.
      // With no session there is nothing to wait for: the 503 below is the answer.
      if ((await waLink.status()).state !== 'linked' && waStore.hasSession()) {
        await waLink.restore();
        await waitForLinked(waLink, WA_LINK_WAIT_MS);
      }
      return await waLink.sendText(pinMessage(pin));
    } catch (err) {
      // The pair page shows this wording and falls back to the code on the laptop screen. The PIN itself never leaks.
      throw new PinError('wa_failed', err?.code === 'not_linked' ? 'WhatsApp belum ditautkan.' : 'Kode tidak terkirim ke WhatsApp. Coba lagi.', { status: 503 });
    }
  },
  cooldownMs: pinCooldownMs(),
  maxPerIpPerHour: pinMaxPerIpPerHour(),
});

/**
 * Tests only (OFFICE_WA_FAKE=1): a stand-in for baileys' socket that emits a QR and then reports itself linked to a
 * fixed number, so the end-to-end tests can drive /api/wa/* and the PIN path without a WhatsApp account. Everything
 * else stays real — the encrypted store, the states, the routes — so the flag changes nothing but the socket.
 * @param {{ auth?: { creds?: object } }} [config] what WaLink hands baileys (the session it just loaded)
 */
function fakeWaSocket({ auth } = {}) {
  const handlers = new Map();
  const emit = (type, payload) => {
    for (const fn of handlers.get(type) ?? []) {
      try {
        fn(payload);
      } catch {
        // A broken listener must not break the fake socket.
      }
    }
  };
  const socket = {
    ev: {
      on: (type, fn) => {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(fn);
      },
    },
    async sendMessage(jid, message) {
      if (WA_FAKE_SENT) {
        try {
          appendFileSync(WA_FAKE_SENT, `${JSON.stringify({ jid, text: String(message?.text ?? '') })}\n`);
        } catch {
          // Test-only bookkeeping: it must never change the outcome.
        }
      }
      return { key: { id: 'fake' } };
    },
    async logout() {},
    async end() {},
  };
  // A restored session (the saved credentials already name the account) logs in directly; only a fresh one shows a
  // QR, exactly like baileys. This keeps a restart test faithful: no QR appears for a session that is already linked.
  const restored = Boolean(auth?.creds?.me);
  if (!restored) setTimeout(() => emit('connection.update', { qr: 'ADHITRON-FAKE-QR' }), 0).unref?.();
  setTimeout(() => {
    if (auth?.creds) {
      auth.creds.me = { id: '628123456789:1@s.whatsapp.net', name: 'WhatsApp Uji' };
      emit('creds.update', {});
    }
    emit('connection.update', { connection: 'open' });
  }, 600).unref?.();
  return socket;
}

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

// 🗑 Trash retention (data/trash): sessions deleted from Riwayat sesi stay for a while, then a daily purge removes
// them. OFFICE_TRASH_DAYS overrides the 30 days (0 = keep forever). Never touches files that are not transcripts.
const TRASH_DAYS = (() => {
  const n = Number(process.env.OFFICE_TRASH_DAYS);
  return Number.isInteger(n) && n >= 0 ? n : TRASH_RETENTION_DAYS;
})();
function purgeOldTrash() {
  try {
    const { removed } = purgeTrash({ dataDir: DATA_DIR, days: TRASH_DAYS });
    if (removed) console.log(`Retensi trash: ${removed} sesi lebih lama dari ${TRASH_DAYS} hari dihapus.`);
  } catch (err) {
    console.error('Retensi trash gagal:', err?.message ?? err);
  }
}
purgeOldTrash();
setInterval(purgeOldTrash, 24 * 60 * 60 * 1000).unref?.();

// 🗓 Chat/ledger retention (state.json → persisted.retention). 0 = keep forever, so nothing is deleted until the
// user picks days in Data saya. Runs once at start and then daily; a failure is logged and never stops the server.
function runRetention() {
  try {
    const { chatsDays, usageDays } = retentionOf(hub);
    if (!chatsDays && !usageDays) return;
    const result = applyRetention(hub, ledger, Date.now());
    const chats = result.chats.removed;
    const rows = result.usage.removed;
    if (chats || rows) {
      recordAudit(DATA_DIR, { action: 'retention-run', detail: `otomatis: chat ${chats} pesan (${result.chats.projects} project), ledger ${rows} baris (${result.usage.files} file)` });
      console.log(`Retensi data: ${chats} pesan chat (${result.chats.projects} project) dan ${rows} baris ledger (${result.usage.files} file) dihapus.`);
    }
  } catch (err) {
    console.error('Retensi data gagal:', err?.message ?? err);
  }
}
runRetention();
setInterval(runRetention, 24 * 60 * 60 * 1000).unref?.();

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
// `classify` is Effort/Model Auto for a prompt queued at the global turn limit: it runs once, at dispatch.
const taskQueue = new TaskQueue({
  hub,
  sessions,
  ledger,
  metrics,
  classify: (id, text, attachments) => {
    const settings = hub.settingsFor(id);
    const engine = hub.engineOf(id);
    return classifyEffort({ engine, claude, opencode, classifierModel: classifierModelFor(engine, settings.modelTiers), text, attachments, context: autoContext(hub, id) });
  },
});
const routines = new RoutineScheduler({ hub, taskQueue });
sessions.taskQueue = taskQueue; // a project's waiting queue item blocks its engine switch (Stage 1)
sessions.onRateLimit = (id, info) => taskQueue.onRateLimit(id, info);
// 🔔 Web Push to paired https phones (src/push.js): permission requests, turn done/error, queue paused.
const push = new PushService({
  hub,
  remote,
  dataDir: DATA_DIR,
  queueSummary: (id) => taskQueue.summary(id),
  hasStream: (deviceId) => [...deviceStreams.values()].includes(deviceId),
  onChange: () => publishConfig(),
});
push.seedQueues(Object.keys(taskQueue.queues)); // a pause from before this start is not news
hub.observers.add((type, data) => push.observe(type, data));
// Every finished app turn feeds the health history (CLI mirrors are not run by this server).
hub.observers.add((type, data) => {
  if (type === 'chat' && data?.kind === 'result' && data.source !== 'cli' && data.source !== 'demo') {
    metrics.turn({ ok: data.ok !== false, durationMs: data.meta?.durationMs });
  }
});
hub.redactors.set('approval', wifiApproval); // "answered from <phone name>": not over sniffable WiFi

// Claude Code update detector (src/claude-check.js): `claude --version` at start and every 6 h; a new version gets
// the light contract check in the background once no turn is busy. Its own file (not in history backups).
// OFFICE_CLAUDE_CHECK_DELAY_MS: tests only, how long after start the first look happens (default 20 s).
const CHECK_DELAY = Number(process.env.OFFICE_CLAUDE_CHECK_DELAY_MS);
// ⬆ Adhitron's own updates (git fetch every 30 min, banner, "Update sekarang"). Off for test servers (a fake
// CLAUDE_BIN) unless OFFICE_UPDATE_CHECK=1; OFFICE_UPDATE_CHECK=0 turns it off anywhere.
const updateCheck = process.env.OFFICE_UPDATE_CHECK ? process.env.OFFICE_UPDATE_CHECK !== '0' : !process.env.CLAUDE_BIN;
const appUpdater = APP_PATHS.packaged && process.platform === 'win32'
  ? new DesktopUpdater({
      currentVersion: APP_VERSION,
      dataDir: DATA_DIR,
      repo: process.env.OFFICE_UPDATE_REPO,
      publicKey: UPDATE_PUBKEY,
      firstCheckMs: updateCheck ? Number(process.env.OFFICE_UPDATE_FIRST_CHECK_MS ?? 60_000) : -1,
      busy: () => [...sessions.sessions.values()].some((s) => s.turnActive()),
      onBeforeExit: () => shutdown(),
      onChange: (view) => {
        if (!hub.config) return;
        hub.config.appUpdate = view;
        hub.broadcast('config', hub.config);
      },
    })
  : new AppUpdater({
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

// 🧰 Setup (src/setup/service.js): what the laptop still needs (Node, Claude Code, OpenCode, Tailscale) and the
// one-at-a-time installer. status/refresh are laptop+Tailscale only; install/cancel/login-terminal are LOCAL_ONLY.
const setupBusy = () =>
  Boolean(sessions.anyBusy?.()) ||
  [...sessions.sessions.values()].some((s) => s.turnActive?.() || s.busy || s.inflight?.size) ||
  Boolean(claudeCheck.running || opencodeCheck.running);
let lastSetupDoneAt = null;
const setup = new SetupService({
  runtimeDir: RUNTIME_DIR,
  platform: process.platform,
  probe: (options) => probeTools({ ...options, account }),
  isBusy: setupBusy,
  log: (line) => console.log(line),
  onChange: (view) => {
    // A finished install can bring a new binary: re-resolve it before the config advertises the engines.
    if (view.job?.state === 'done' && view.job.finishedAt !== lastSetupDoneAt) {
      lastSetupDoneAt = view.job.finishedAt;
      try {
        refreshTools();
      } catch (err) {
        console.error('Setup: gagal memuat ulang alat:', err?.stack ?? err);
      }
    }
    if (!hub.config) return;
    hub.config = { ...hub.config, setup: view };
    hub.broadcast('config', hub.config);
  },
});

/**
 * Re-resolves the CLIs after an install and gives every holder of a {command, args} pair the new object. Existing
 * turns keep their process; the next spawn (and every check/classifier) uses the new binary.
 */
function refreshTools() {
  setup.applyRuntimePath(process.env);
  const previousClaude = claude;
  const previousOpenCode = opencode;
  claude = findClaude();
  opencode = findOpenCode();

  ctx.claude = claude;
  ctx.opencode = opencode;
  sessions.claude = claude;
  sessions.opencode = opencode;
  account.claude = claude;
  claudeCheck.claude = claude;
  opencodeCheck.claude = opencode; // the base class calls its binary `claude`
  roleMemory.classify = engineClassifier({ engine: () => hub.engine, claude, opencode, dataDir: DATA_DIR });
  // The mirror reads terminal OpenCode sessions; it only polls once it has a binary (start() is idempotent).
  const mirrorBin = process.env.CLAUDE_BIN && !process.env.OFFICE_OPENCODE_MIRROR ? null : opencode;
  const hadMirrorBin = Boolean(openCodeMirror.bin);
  openCodeMirror.bin = mirrorBin;
  if (!hadMirrorBin && mirrorBin) openCodeMirror.start();

  if (!previousClaude && claude) {
    // claudeCheck.start() did nothing while no binary existed; give it the new one and an immediate first look.
    claudeCheck.start();
    claudeCheck.tick?.();
  } else if (claude && previousClaude?.command !== claude.command) {
    claudeCheck.tick?.();
  }
  if (!previousOpenCode && opencode) {
    if (OC_CHECK_AUTO) opencodeCheck.start();
    opencodeCheck.tick?.();
  } else if (opencode && previousOpenCode?.command !== opencode.command) {
    opencodeCheck.tick?.();
  }
  if (opencode && previousOpenCode?.command !== opencode.command) refreshOpenCodeVersion();

  account.refreshProfile(true).catch(() => {});
  refreshProjects();
}

/** `opencode --version` for config.engines.opencode; called after start and after a successful install. */
function refreshOpenCodeVersion() {
  if (!opencode) return;
  openCodeVersion(opencode)
    .then((version) => {
      opencodeVersion = version;
      if (!version || !hub.config?.engines?.opencode) return;
      hub.config.engines.opencode.version = version;
      hub.broadcast('config', hub.config);
    })
    .catch(() => {});
}

const projectRoots = () => (hub.persisted.roots.length ? hub.persisted.roots : [DEFAULT_ROOT]);

/** Folders that may appear as projects: under a configured root, or explicitly added via "Tambah project". */
function insideKnownProjectDir(dir) {
  return isInside(dir, [...projectRoots(), ...(hub.persisted.custom ?? [])]);
}

/** Rescans all sources. Folders no longer under any root drop out (unless Claude Code or the user added them). */
function refreshProjects() {
  const wasReady = hub.ready;
  hub.ready = false; // one broadcast at the end instead of one per folder
  for (const project of hub.projects.values()) project.sources = project.sources.filter((s) => s !== 'folder' && s !== 'claude');
  for (const [dir, source] of discoverProjects({ roots: projectRoots(), extra: hub.persisted.custom })) hub.upsertProject(dir, source);
  // A custom folder that is gone stays listed as an orphan (missing: true) so its app data can be purged. A folder
  // that is merely unreadable/offline is not missing: isMissing only accepts ENOENT/ENOTDIR.
  for (const dir of hub.persisted.custom) if (isDirectory(dir) || isMissing(dir)) hub.upsertProject(dir, 'custom');
  for (const [id, project] of hub.projects) if (!project.sources.length && !hub.runtime.get(id)?.status.busy) hub.projects.delete(id);
  hub.config = {
    roots: projectRoots(),
    defaultRoot: DEFAULT_ROOT,
    usingDefault: !hub.persisted.roots.length,
    // Where this server keeps its data (settings, WhatsApp session, chats). Shown in ⚙ → Sistem: the installed app
    // and a dev checkout use different folders, which is the usual reason a linked WhatsApp looks "unlinked" on the
    // other one. It lives in this literal (not a patch after it) because every refresh REPLACES hub.config.
    dataDir: DATA_DIR,
    slashCommands: [...new Set([...DEFAULT_SLASH, ...(hub.persisted.slashCommands ?? [])])].sort(),
    ...hub.catalogConfig(), // models + commands with descriptions, as Claude Code reports them
    autostart: autostartStatus({ appDir: APP_DIR }), // mode/autologon/needsElevation/unsafeDesktop (no script paths)
    remote: remoteInfo(),
    teamNames: hub.persisted.teamNames ?? {},
    team: teamConfig(),
    spotify: { redirectUri: spotify.redirectUri }, // shown (with a copy button) in ⚙ → Spotify
    claudeCheck: claudeCheck.publicView(), // versions + last contract check result (no details)
    opencodeCheck: opencodeCheck.publicView(), // the same for OpenCode (available: false when not installed)
    setup: setup.publicView(), // 🧰 Node/Claude/OpenCode/Tailscale: needsSetup/firstRun + the running job
    appUpdate: appUpdater.publicView(), // ⬆ a newer Adhitron on GitHub (src/app-update.js)
    // The engines a project can run on (docs/design-opencode.md §6.1): Claude Code's caps are the UI's defaults.
    engine: hub.defaultEngine(), // the app-wide DEFAULT for new projects; each project carries its own `settings.engine`
    concurrency: { maxConcurrent: maxConcurrentOf(hub) }, // global turn limit (src/concurrency.js)
    engines: {
      claude: { available: Boolean(claude), enabled: hub.claudeEnabled(), version: hub.catalogConfig().version ?? '' },
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
// 🧰 Setup mutations (install/cancel/login-terminal): laptop only; status/refresh stay readable over Tailscale.
// 📱 WhatsApp link: laptop only — pairing needs the QR, and the QR is a session credential (status/unlink/test are
// SECURE_ADMIN, so a phone can read, unlink and test but never link).
// 🪟 Autologon/autostart: laptop only — it asks for the Windows password and changes how the PC logs in (UAC).
// 🧩 Memasang/menghapus plugin Claude Code (routes/extensions.js guard laptop) dan login GitHub: laptop only.
// 🎵 Spotify tetap laptop-only DI UI karena redirect OAuth-nya 127.0.0.1 di laptop (server: SECURE_ADMIN).
// Semua setelan lain boleh diubah dari HP lewat Tailscale (SECURE_ADMIN) — itu yang membuat aplikasi ini nyaman
// diremote.
const LOCAL_ONLY = new Set(['/api/setup/install', '/api/setup/cancel', '/api/setup/login-terminal', '/api/cli-bridge/ask', '/api/cli-bridge/token', '/api/autostart', '/api/autologon', '/api/autologon/disable', '/api/pairing/code/push', '/api/wa/link']);
// Admin biasa: boleh dari HP, tetapi hanya lewat Tailscale HTTPS (terenkripsi + perangkat terpasang). WiFi biasa
// tetap hanya-lihat; gate read-only di bawah menolak sisanya.
const SECURE_ADMIN = new Set(['/api/app-update/check', '/api/engines/claude', '/api/app-update/run', '/api/budget/override', '/api/budget/audit', '/api/routines', '/api/routines/save', '/api/routines/delete', '/api/routines/toggle', '/api/routines/run', '/api/claude-check/run', '/api/claude-check/settings', '/api/claude-check/doctor', '/api/claude-check/update', '/api/opencode-check/run', '/api/opencode-check/settings', '/api/opencode-check/update', '/api/opencode-check/restart-service', '/api/opencode-service', '/api/opencode-reload', '/api/opencode-info', '/api/opencode-stats', '/api/opencode-plugins/list', '/api/opencode-plugins/add', '/api/opencode-plugins/remove', '/api/opencode-plugins/update', '/api/opencode-plugins/check', '/api/opencode-config', '/api/opencode-config/save', '/api/opencode-config/backups', '/api/opencode-config/backup', '/api/opencode-config/restore', '/api/opencode-config/consolidate', '/api/config', '/api/concurrency/save', '/api/projects', '/api/groups', '/api/backup/export', '/api/backup/import', '/api/backup/preview', '/api/backup/verify', '/api/backup/rekey', '/api/backup/schedule', '/api/backup/schedule/save', '/api/backup/schedule/run', '/api/backup/schedule/history', '/api/backup/schedule/restore', '/api/push/history', '/api/diagnostics/export', '/api/data', '/api/data/purge', '/api/data/project', '/api/data/audit-export', '/api/data/retention/preview', '/api/data/retention/save', '/api/data/retention/run', '/api/remote-power/get', '/api/remote-power/settings', '/api/remote-power/test', '/api/remote-power/pair', '/api/remote/revoke', '/api/wa/status', '/api/wa/pair-code', '/api/wa/unlink', '/api/wa/test', '/api/spotify/config', '/api/spotify/login', '/api/spotify/logout']);
// ⚡ Power actions (⏻ Matikan PC) from a phone: ONLY over the https (Tailscale) listener, where the link is
// encrypted end-to-end. A phone paired on plain-HTTP WiFi stays refused — it is read-only anyway, but this
// gate answers with the real reason ("aksi daya hanya lewat Tailscale") instead of the generic read-only text.
// NOT laptop-only (a phone must be able to switch the PC off); the laptop itself never reaches this gate.
const SECURE_ONLY = new Set(['/api/power/status', '/api/shutdown']);
// Login/logout switch the account of every Claude Code on the laptop: from a phone only over
// Tailscale (encrypted), never over plain-HTTP WiFi where the device cookie could be sniffed.
// The same for switching engines and OpenCode's provider logins (API keys travel in these requests).
// 📜 /api/account/audit names the devices that changed an account (personal data): never over plain WiFi.
// Provider kustom OpenAI-compatible too (custom/check, custom/add, custom/remove): the API key travels in these
// requests, and a remove is as destructive as a logout.
const ACCOUNT_AUTH = new Set(['/api/account/login', '/api/account/login/code', '/api/account/login/cancel', '/api/account/logout', '/api/account/audit', '/api/engine', '/api/opencode/providers', '/api/opencode/login/key', '/api/opencode/login/oauth', '/api/opencode/login/status', '/api/opencode/login/code', '/api/opencode/login/cancel', '/api/opencode/logout', '/api/opencode/custom/check', '/api/opencode/custom/add', '/api/opencode/custom/remove']);
// Opening VS Code / Explorer only makes sense on the laptop itself.
// Changing saved permission rules (🛡️ Aturan izin) changes what Claude Code may do unasked: laptop only (phones may look).
const LOCAL_ONLY_ACTION = /^\/api\/projects\/[\w-]+\/(open|permissions-edit|mcp-add|session-import-json|checklist-scaffold|archive)$/;
// Rename/add/remove members only. `/api/groups/list` and `/api/groups/:id/sessions` are reads and stay available to a
// paired phone; without the lookahead the id pattern swallowed `list` and the group dialog showed nothing but 403.
const LOCAL_ONLY_GROUP = /^\/api\/groups\/(?!list$)[\w-]+$/;
const LOCAL_ONLY_GROUP_DISSOLVE = /^\/api\/groups\/[\w-]+\/dissolve$/;
/**
 * The same laptop-only rule as JSON for the settings dialog (`client.laptopOnly`): a phone hides those controls
 * instead of offering a button the server answers with 403. Built from the constants above, so a new laptop-only
 * route reaches the UI without a second list to keep in sync. The laptop itself is never restricted — it ignores this
 * (public/js/core/api.js), exactly like the server does.
 */
const LAPTOP_ONLY_API = {
  paths: [
    ...LOCAL_ONLY,
    '/api/remote',
    // Route-level laptop guards (routes/extensions.js `guard(..., { laptop: true })`), so the UI can hide them too.
    '/api/claude/plugins/action',
    '/api/github/login',
    '/api/github/login/cancel',
    // Route-level laptop guard (routes/diagnostics.js): the bundle carries logs that may name local folders.
    '/api/diagnostics/export',
  ],
  patterns: ['^/api/remote/(?!revoke$)', LOCAL_ONLY_ACTION.source, LOCAL_ONLY_GROUP.source, LOCAL_ONLY_GROUP_DISSOLVE.source],
};
const PUBLIC_ASSET = /^\/(manifest\.webmanifest|icons\/[\w.-]+|js\/pair\.js)$/;

// A TLS socket is never the laptop, even from loopback (e.g. someone puts `tailscale serve` in front of it):
// the laptop is plain http on 127.0.0.1 only.
const isLocal = (req) => LOOPBACK.has(req.socket.remoteAddress) && !req.socket.encrypted;
/** Came in on the https listener (Tailscale). */
const isSecure = (req) => Boolean(req.socket.encrypted);
const transportOf = (req) => (isSecure(req) ? 'https' : 'http');
/** The device cookie of this transport: each listener reads only its own (see src/remote.js). */
const deviceToken = (req) => cookies(req)[isSecure(req) ? HTTPS_DEVICE_COOKIE : DEVICE_COOKIE];
// 🔐 The PIN is bound to the browser that asked for it (src/access-pin.js): this cookie carries the requester token,
// the only thing that may spend that PIN. Without it, anyone on the same WiFi could burn a live PIN with three wrong
// digits. It never leaves the server as JSON — it is not the PIN, but it is the right to use it.
const PIN_COOKIE = 'office_pin';
const HTTPS_PIN_COOKIE = '__Host-office_pin';
const pinCookieName = (secure) => (secure ? HTTPS_PIN_COOKIE : PIN_COOKIE);
const pinToken = (req) => cookies(req)[pinCookieName(isSecure(req))];
/** Sets the requester token cookie — or, with an empty token, CLEARS it (Max-Age=0; a short Max-Age would leave an
 *  empty cookie behind for 10 more minutes, and docs/pairing-whatsapp.md promises it is removed). */
const pinCookie = (token, secure) => {
  const base = `${pinCookieName(secure)}=${token}; ${secure ? 'Secure; ' : ''}HttpOnly; SameSite=Strict; Path=/`;
  return token ? `${base}; Max-Age=600` : `${base}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
};
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

/** If-None-Match (a list, possibly weak validators or "*") matches this ETag. */
function notModified(req, etag) {
  const header = String(req.headers['if-none-match'] ?? '');
  return header.trim() === '*' || header.split(',').some((v) => v.trim().replace(/^W\//, '') === etag);
}

/**
 * `/ai-logos/index.json` (the SVG names) and `/ai-logos/<name>.svg` from the repo's ai_logos folder. Public: a logo
 * says which model is active, never project data. The name pattern is the whole path check (no traversal).
 */
async function serveAiLogos(pathname, res) {
  const rel = pathname.slice('/ai-logos/'.length);
  if (rel === 'index.json') {
    let logos = [];
    try {
      logos = readdirSync(AI_LOGOS_DIR).filter((name) => /^[a-z0-9][a-z0-9._-]{0,80}\.svg$/i.test(name)).sort();
    } catch {
      // no folder: an empty list, the UI falls back to a monogram
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ logos }));
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,80}\.svg$/i.test(rel)) return json(res, 404, { error: 'not found' });
  try {
    const body = await readFile(path.join(AI_LOGOS_DIR, rel));
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    return res.end(body);
  } catch {
    return json(res, 404, { error: 'not found' });
  }
}

/** gzip bodies of the static files already compressed once (keyed by their plain ETag, bounded). */
const staticGzip = new GzipCache();

async function serveStatic(pathname, res, req, extraHeaders = {}) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'not found' });
  try {
    let body = await readFile(file);
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    // A phone away from home pays for every byte: text assets go out gzipped when the client asks for it. `Vary` keeps
    // a shared cache from handing a gzip body to a client that did not ask for one.
    const wantGzip = acceptsGzip(req.headers['accept-encoding']) && compressibleType(type);
    if (rel === 'index.html') {
      // Carries the per-start API token: never stored by the browser, so no ETag and no cache to revalidate.
      body = Buffer.from(body.toString('utf8').replace('__OFFICE_TOKEN__', TOKEN).replace(/<!-- module-preloads:.*?-->/, MODULE_PRELOADS));
      const gz = wantGzip && body.length >= MIN_GZIP_BYTES ? staticGzip.encode(body, `index:${TOKEN}`) : null;
      const out = gz?.body ?? body;
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        Vary: 'Accept-Encoding',
        ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
        'Content-Length': out.length,
      });
      return res.end(out);
    }
    // Plain files (JS, CSS, icons): kept by the browser but revalidated on every use, so a reload is a
    // round of tiny 304s instead of full downloads, and an edited file is still picked up at once.
    const plainEtag = etagOf(body);
    // The gzip entry is keyed by the plain ETag, so an edited file is compressed again on its next request.
    const gz = wantGzip && body.length >= MIN_GZIP_BYTES ? staticGzip.encode(body, plainEtag) : null;
    const etag = gz?.etag ?? plainEtag;
    const headers = { 'Cache-Control': 'no-cache', ETag: etag, Vary: 'Accept-Encoding', ...extraHeaders };
    if (notModified(req, etag)) {
      res.writeHead(304, headers);
      return res.end();
    }
    const out = gz?.body ?? body;
    res.writeHead(200, { ...headers, 'Content-Type': type, ...(gz ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': out.length });
    res.end(out);
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
  const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
  // A phone away from home reconnects often (sleep, WiFi↔cellular, Tailscale): the first snapshot is large JSON, so
  // the whole stream is gzipped when the client asks. EventSource decompresses transparently; a client that does not
  // ask for gzip gets exactly the plain stream it always got. Z_SYNC_FLUSH keeps each event usable on arrival, so
  // streaming never waits for a full buffer.
  const gz = acceptsGzip(req.headers['accept-encoding']) ? createGzip({ flush: zlibConstants.Z_SYNC_FLUSH }) : null;
  if (gz) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  res.writeHead(200, headers);
  if (gz) {
    const rawWrite = res.write.bind(res);
    const rawEnd = res.end.bind(res);
    gz.on('data', (chunk) => rawWrite(chunk));
    gz.on('end', () => rawEnd());
    res.on('close', () => gz.destroy());
    res.write = (chunk) => {
      gz.write(chunk);
      return true;
    };
    res.end = () => {
      gz.end();
      return res;
    };
  }
  // readOnlyApi: what a read-only phone may still call, so the UI doesn't keep its own copy of wifiAllows.
  const readOnly = isReadOnly(req);
  // secure: the https (Tailscale) origin. push: this phone's subscription state (https devices only, else null).
  // laptopOnly: the controls that need this machine itself (UAC, install, the WhatsApp QR): a phone hides them, and
  // the page is reachable from that phone now that ⚙ is not laptop-only (public/js/core/stream.js).
  const client = {
    local,
    accountAuth: canManageAccount(req),
    readOnly,
    readOnlyApi: WIFI_READ_API,
    secure: isSecure(req),
    push: isSecure(req) ? push.clientInfo(device) : null,
    laptopOnly: LAPTOP_ONLY_API,
  };
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
    // A real event, not an SSE comment: the phone can tell "the server is still there" from "the socket froze"
    // (a half-open connection used to look connected while nothing new ever arrived).
    res.write('event: ping\ndata: {}\n\n');
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
  // Every API needs this start's token. The CLI bridge carries a narrower one (x-cli-token), and /api/push/act
  // carries its own single-use proof instead (src/routes/push.js).
  const tokenKind = route?.route.token ?? 'office';
  if (tokenKind === 'office' && req.headers['x-office-token'] !== TOKEN) return json(res, 403, { error: 'forbidden' });
  if (tokenKind === 'cli' && req.headers['x-cli-token'] !== CLI_TOKEN) return json(res, 403, { error: 'forbidden' });
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
  setup, // 🧰 setup status/install/cancel/login-terminal (src/routes/setup.js)
  account,
  ledger,
  mirror,
  remote,
  accessPin, // 🔐 PIN WhatsApp: dropped when phone access goes off or a device is revoked (src/routes/remote.js)
  waLink, // 📱 WhatsApp in-process: /api/wa/* (src/routes/wa.js) and the PIN transport
  tls,
  templates,
  taskQueue,
  metrics,
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
  autologon: AUTOLOGON_FAKE ? fakeAutologon() : windowsAutologon(), // 🪟 /api/autologon* (src/routes/autologon.js)
  cliToken: CLI_TOKEN,
  dataDir: DATA_DIR,
  runtimeDir: RUNTIME_DIR,
  port: PORT,
  httpsPort: HTTPS_PORT,
  maxBackupBytes: MAX_BACKUP_BYTES,
  isLocal,
  isSecure, // https listener (Tailscale): power actions from a phone need it (src/power.js, src/routes/misc.js)
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
// Named explicitly too: refreshTools() replaces claude/opencode on this object after a successful install.
ctx.setup = setup;
ctx.runtimeDir = RUNTIME_DIR;
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

/**
 * GET /pair auto-pairs only for a real top-level navigation. A subresource request (fetch, image, …) can
 * be fired by a page on another site; pairing there would mint records the owner never asked for. Missing
 * headers count as navigation (older browsers and the tests' plain requests send none).
 */
function isTopLevelNavigation(req) {
  const mode = req.headers['sec-fetch-mode'];
  const dest = req.headers['sec-fetch-dest'];
  return (mode === undefined || mode === 'navigate') && (dest === undefined || dest === 'document');
}

/**
 * 🔓 Pasang otomatis dari perangkat tailnet (src/tailnet.js): only over the https (Tailscale) listener,
 * only for a device of the laptop owner's OWN tailnet user, and only while the setting is on — the
 * tailnet login already proves who it is, so no code is needed. Plain http (WiFi/LAN) never auto-pairs,
 * even when the IP is a 100.x tailnet address; another user's device, a missing CLI, or a broken
 * `status --json` returns null (fail closed). Fresh status per attempt (cached a few seconds upstream).
 * Shared by GET /pair (a phone that was redirected here) and POST /pair (the form); on success the caller
 * only writes the response. The per-IP pace and the device cap live in src/remote.js autoPair().
 * @param {object} req the incoming request (its peer address selects the tailnet peer)
 * @param {boolean} secure whether the request came over the https (Tailscale) listener
 * @param {{ transport: 'http'|'https' }} transport
 * @param {() => Promise<{ peer?: object, name?: string }|null>} [peerOf] the tailnet peer lookup, memoized by the
 *   caller (handlePair): the code/PIN path of the same request reuses it instead of running the CLI twice
 * @returns {Promise<{ token: string, device: object }|null>} null = the normal code flow continues
 */
async function autoPairTailnet(req, secure, transport, peerOf = () => eligibleTailnetPeer(req.socket.remoteAddress)) {
  if (!secure || !remote.enabled || !remote.autoPairTailnet) return null;
  const found = await peerOf();
  if (!found) return null;
  const ip = String(req.socket.remoteAddress ?? '');
  const nodeId = String(found.peer?.ID ?? '');
  // The same phone coming back: a known tailnet node gets a fresh cookie on its EXISTING record, so a lost cookie
  // (another origin, cleared site data, a pruned record) does not ask the owner for a code again and the device
  // list does not grow one record per visit. A node never seen before becomes a new record.
  const adopted = remote.adopt(nodeId, found.name, { ...transport, ip });
  const auto = adopted ?? remote.autoPair(found.name, { ...transport, ip, nodeId });
  if (!auto) return null;
  // Only a brand-new record is announced: an adopted one is the same phone coming back with a fresh cookie, and the
  // other phones should not get a "device paired" notification for it.
  if (!adopted) announcePairedDevice(auto.device);
  publishConfig();
  return auto;
}

/**
 * The machine-readable "why" behind pin-status, so /pair can pick the right Indonesian sentence instead of guessing
 * from `configured`/`status` (that guessing is what mislabelled a failed tailnet peer check as "phone access off").
 * @param {'connected'|'qr_ready'|'connecting'|'disconnected'} status the pairStatus() answer
 * @returns {'ready'|'wa-off'|'wa-qr'|'wa-connecting'}
 */
function pinReason(status) {
  if (status === 'connected') return 'ready';
  if (status === 'qr_ready') return 'wa-qr';
  if (status === 'connecting') return 'wa-connecting';
  return 'wa-off';
}

/**
 * The WhatsApp PIN (src/access-pin.js). Reachable BEFORE pairing — that is the whole point — but only while phone
 * access is on, and every route keeps its own hard limit:
 *   GET  /api/auth/pin-status    → is WhatsApp configured/connected, and is this device already paired? (`paired`,
 *                                  `reason`; never the PIN; "active" only for the browser that asked for it)
 *   POST /api/auth/request-pin   → mint a PIN and send it to the owner's WhatsApp (1/min, 5/hour, 3/hour per address)
 *   POST /api/auth/verify-pin    → one use on success, 3 wrong attempts burn it, only from the asking browser
 * None of these ever returns the PIN or puts it in a log. The transport is the in-process link (src/wa-link.js).
 */
async function handleAuthPin(req, res, pathname, { secure, local }) {
  // The master gate: with phone access off nothing here does anything — including a verify that would otherwise
  // burn the owner's live PIN or answer "the list is full" for a switch that is simply off.
  if (!remote.enabled) return json(res, 403, { error: 'Akses dari perangkat lain sedang dimatikan.', reason: 'phone-access-off' });
  // Over the Tailscale listener the peer must be proven to be the OWNER'S OWN device (src/tailnet.js), exactly like
  // auto-pair: without this, another tailnet user's node could pair itself with a PIN and get a full-control device
  // (isReadOnly() only looks at the network path, not at who the peer is). Fail closed, and the laptop's own
  // localhost requests skip it.
  const peer = !local && secure ? await eligibleTailnetPeer(req.socket.remoteAddress) : null;
  if (!local && secure && !peer) {
    // Not "phone access is off": the switch is on, but this device is not (or not provably) one of the owner's.
    return json(res, 403, {
      error: 'Perangkat Tailscale ini bukan milik pemilik laptop, atau Tailscale di HP belum tersambung. Masuk dengan akun Tailscale pemilik laptop, atau pakai kode 6 digit dari layar laptop.',
      reason: 'not-owner-tailnet',
    });
  }
  const transport = { transport: transportOf(req) };
  if (pathname === '/api/auth/pin-status' && req.method === 'GET') {
    // configured/status are the mapping /pair already speaks (src/wa-link.js pairStatus): WhatsApp counts as
    // configured once a QR is showing or the account is linked, and as disconnected while the link is off.
    const wa = pairStatus(await waLink.status());
    const pin = accessPin.status({ token: pinToken(req) });
    return json(res, 200, {
      // A device with a valid cookie is already paired: the /pair page hides its PIN form for it. That is the normal
      // case on the owner's tailnet (auto-pair), and a PIN form there reads as "any PIN gets in".
      paired: Boolean(remote.verify(deviceToken(req), transport)),
      configured: wa.configured,
      status: wa.status,
      reason: pinReason(wa.status),
      active: pin.active,
      expiresInSec: pin.expiresInSec,
      canRequestInSec: pin.canRequestInSec,
    });
  }
  if (pathname === '/api/auth/request-pin') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    try {
      const issued = await accessPin.request({ ip: String(req.socket.remoteAddress ?? ''), userAgent: String(req.headers['user-agent'] ?? '') });
      // The token binds this PIN to this browser (the pair page keeps it as an HttpOnly cookie, never as JSON).
      res.setHeader('Set-Cookie', pinCookie(issued.token, secure));
      return json(res, 200, { ok: true, expiresInSec: issued.expiresInSec, attemptsLeft: issued.attemptsLeft });
    } catch (err) {
      return pinError(res, err);
    }
  }
  if (pathname === '/api/auth/verify-pin') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 405, { error: 'method not allowed' });
    const body = (await readJson(req, MAX_PAIR_BODY)) ?? {};
    const pin = typeof body === 'object' ? body.pin : undefined;
    if (remote.verify(deviceToken(req), transport)) return json(res, 200, { ok: true, already: true });
    // Capacity BEFORE spending the PIN: a one-time PIN thrown away on a full list forces a second request.
    if (!remote.hasRoom()) return json(res, 403, { error: 'Daftar perangkat sudah penuh. Cabut satu perangkat dari laptop dulu.' });
    let result;
    try {
      result = accessPin.verify(pin, { token: pinToken(req) });
    } catch (err) {
      return pinError(res, err);
    }
    if (!result.ok) return json(res, 400, { ok: false, error: 'PIN salah.', triesLeft: result.triesLeft });
    // A paired-by-PIN phone over Tailscale is stored with its tailnet node id, so a lost cookie is adopted later
    // (src/remote.js adopt) instead of creating a second record for the same phone.
    const paired = remote.pairTrusted(String(req.headers['user-agent'] ?? ''), { ...transport, nodeId: String(peer?.peer?.ID ?? '') });
    if (!paired) return json(res, 403, { error: 'Daftar perangkat sudah penuh. Cabut satu perangkat dari laptop dulu.' });
    announcePairedDevice(paired.device);
    publishConfig();
    res.setHeader('Set-Cookie', [deviceCookie(paired.token, secure), pinCookie('', secure)]);
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  return json(res, 404, { error: 'not found' });
}

/** A PIN/WhatsApp failure → the status and wording the pair page shows. Never the PIN, never a JID or a message body. */
function pinError(res, err) {
  if (err instanceof PinError) {
    if (err.retryAfterSec) res.setHeader('Retry-After', String(err.retryAfterSec));
    return json(res, err.status, { ok: false, error: err.message, retryAfter: err.retryAfterSec || undefined });
  }
  // A failed send reaches the page as a PinError (the transport wrapper in this file); this is the fallback.
  if (err instanceof WaLinkError) return json(res, 503, { ok: false, error: err.message });
  console.error('PIN WhatsApp:', err?.message ?? err);
  return json(res, 500, { ok: false, error: 'Terjadi kesalahan di server.' });
}

/** GET /pair?k=… (QR link), GET /pair (code form), POST /pair {code}. */
async function handlePair(req, res, url) {
  const userAgent = String(req.headers['user-agent'] ?? '');
  const ip = String(req.socket.remoteAddress ?? '');
  const key = url.searchParams.get('k');
  const secure = isSecure(req);
  const transport = { transport: transportOf(req) }; // the token works only over the transport it was paired on
  // One tailnet peer lookup per request (the CLI answer is cached a few seconds upstream): the auto-pair attempt and
  // the code/PIN pairing below share it. Over plain http nothing proves the peer, so it stays null — no CLI call at
  // all — and the record simply has no node id (fail closed, like before).
  let peerLookup = null;
  const peerOf = () => (peerLookup ??= secure ? eligibleTailnetPeer(ip) : Promise.resolve(null));
  const nodeIdOf = (found) => String(found?.peer?.ID ?? '');
  if (req.method === 'GET' && key) {
    // The QR/6-digit link over Tailscale: stored with its node id so a lost cookie is adopted later (adopt()).
    const result = remote.pair({ key }, userAgent, ip, { ...transport, nodeId: nodeIdOf(await peerOf()) });
    if (!result.token) return servePairPage(res, result.error);
    announcePairedDevice(result.device); // the other phones hear about the new device (see below)
    publishConfig();
    res.writeHead(302, { 'Set-Cookie': deviceCookie(result.token, secure), Location: '/' }); // drop the key from the address bar
    return res.end();
  }
  if (req.method === 'GET') {
    // A valid cookie means this browser is already paired: going home must never mint another record
    // (otherwise every cross-site navigation to /pair would keep growing the device list).
    if (remote.verify(deviceToken(req), transport)) {
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    // A phone that lands on /pair without a code is paired right away when its tailnet login says it is the
    // owner's: it never has to read the PIN off the laptop. Same cookie as a code pairing, then straight
    // home. Only a top-level navigation may pair (a subresource can come from another site).
    if (!isTopLevelNavigation(req)) return servePairPage(res);
    const auto = await autoPairTailnet(req, secure, transport, peerOf);
    if (auto) {
      res.writeHead(302, { 'Set-Cookie': deviceCookie(auto.token, secure), Location: '/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return servePairPage(res);
  }
  if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json')) return json(res, 405, { error: 'method not allowed' });
  const body = await readJson(req, MAX_PAIR_BODY);
  // Already paired (valid cookie): say so instead of minting a second record for the same browser.
  if (remote.verify(deviceToken(req), transport)) return json(res, 200, { ok: true, already: true });
  const auto = await autoPairTailnet(req, secure, transport, peerOf);
  if (auto) {
    res.writeHead(200, { 'Set-Cookie': deviceCookie(auto.token, secure), 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, auto: true }));
  }
  // The code/PIN over Tailscale: the peer lookup above already ran for the auto-pair attempt (memoized), so the
  // record also gets its node id and a later lost cookie is adopted instead of asking for a code again (adopt()).
  const result = remote.pair({ code: body.code }, userAgent, ip, { ...transport, nodeId: nodeIdOf(await peerOf()) });
  if (result.retryAfter) {
    res.setHeader('Retry-After', String(result.retryAfter));
    return json(res, 429, result);
  }
  if (!result.token) return json(res, 400, result);
  announcePairedDevice(result.device);
  publishConfig();
  res.writeHead(200, { 'Set-Cookie': deviceCookie(result.token, secure), 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ ok: true }));
}

/** A device just paired: a ✅ push to the OTHER phones (the new one has no subscription yet). Best effort. */
function announcePairedDevice(device) {
  if (!device) return;
  Promise.resolve(push.sendPairedNotice(device)).catch((err) => console.error('Push pemberitahuan pasangan gagal:', err?.message ?? err));
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
  // Model logos (🧠 Mode Otak / ruangan Lead): plain public images, so a paired phone can load them too.
  if (req.method === 'GET' && pathname.startsWith('/ai-logos/')) return serveAiLogos(pathname, res);
  let device = null; // the paired phone making this request (null on the laptop)
  // The push service worker exists only on the https origin; http (laptop included) answers 404. A 404 on the update
  // check does NOT unregister an installed worker (the browser keeps the old one): a real kill switch would serve an
  // sw.js that calls self.registration.unregister(). Server-side, deleting device.push already stops every push.
  if (pathname === '/sw.js' && !(secure && req.method === 'GET')) return json(res, 404, { error: 'not found' });
  try {
    // Access PIN (WhatsApp): handled before the pairing gate — an unpaired phone is exactly who calls it.
    if (pathname.startsWith('/api/auth/')) return await handleAuthPin(req, res, pathname, { secure, local });
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
      // Revoking a device is the one /api/remote action a paired phone may run (a lost phone is often noticed while
      // away from the laptop); everything else under the prefix stays laptop-only, as does switching phone access off.
      const remoteLocked = pathname === '/api/remote' || (pathname.startsWith('/api/remote/') && pathname !== '/api/remote/revoke');
      if (
        LOCAL_ONLY.has(pathname) ||
        remoteLocked ||
        LOCAL_ONLY_ACTION.test(pathname) ||
        LOCAL_ONLY_GROUP.test(pathname) ||
        LOCAL_ONLY_GROUP_DISSOLVE.test(pathname)
      )
        return json(res, 403, { error: 'Pengaturan ini hanya bisa diubah dari laptop.' });
      // Setelan/admin biasa dari HP: wajib jalur Tailscale (https), bukan WiFi biasa.
      if (SECURE_ADMIN.has(pathname) && !isSecure(req)) return json(res, 403, { error: 'Pengaturan ini dari HP hanya lewat Tailscale (koneksi terenkripsi), bukan WiFi biasa.' });
      // ⚡ Power actions from a phone need the encrypted Tailscale (https) link. Checked BEFORE the read-only
      // gate so a WiFi phone gets the real reason; a https phone that is not on the tailnet (read-only) still
      // falls through to that gate below and is refused there.
      if (SECURE_ONLY.has(pathname) && !isSecure(req)) return json(res, 403, { error: POWER_SECURE_ERROR });
      if (ACCOUNT_AUTH.has(pathname) && !canManageAccount(req)) return json(res, 403, { error: 'Login/logout dari HP hanya lewat Tailscale (koneksi terenkripsi), bukan WiFi biasa.' });
      // The one gate for plain-HTTP WiFi: read-only, by allowlist (a new endpoint is refused until listed there).
      if (pathname.startsWith('/api/') && isReadOnly(req) && !wifiAllows(pathname)) return json(res, 403, { error: READ_ONLY_ERROR, readOnly: true });
    }
    // GET /api/wa/status: the settings card polls it. The router only dispatches POST (src/routes/router.js), so this
    // read is served here — behind the same per-start token as every other API, after the LOCAL_ONLY gate above (which
    // is what keeps the QR away from phones).
    if (pathname === '/api/wa/status' && req.method === 'GET') {
      if (req.headers['x-office-token'] !== TOKEN) return json(res, 403, { error: 'forbidden' });
      return await waStatus(ctx, req, res);
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, device);
    // Spotify's redirect after login (laptop only). Handles its own errors: its URL holds the code and state.
    if (local && req.method === 'GET' && pathname === '/spotify/callback') return await spotifyCallback(ctx, req, res, new URL(req.url, `${scheme}://${host}`));
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    if (pathname === '/stream') return openStream(req, res, local, device, device ? deviceToken(req) : null);
    // pid: for scripts/restart.mjs on this laptop (its fallback when a clean shutdown hangs).
    if (pathname === '/health') return json(res, 200, { ok: true, claude: Boolean(claude), ...(local ? { pid: process.pid } : {}) });
    // Some browsers still ask for /favicon.ico even with <link rel="icon">; point them at the real icon.
    if (pathname === '/favicon.ico') {
      res.writeHead(302, { Location: '/icons/icon.svg', 'Cache-Control': 'no-cache' });
      return res.end();
    }
    if (pathname === '/pair' && searchParams.size === 0) return servePairPage(res);
    return await serveStatic(pathname, res, req);
  } catch (err) {
    if (err instanceof HttpError) {
      // Stop reading the rest of an oversized body, but let the 413 response leave first: a hard destroy here
      // sends RST while the client is still uploading, which can discard the response and hide the rejection.
      if (err.status === 413) res.on('finish', () => (typeof req.socket?.destroySoon === 'function' ? req.socket.destroySoon() : req.destroy()));
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
setup.refresh({ deep: true }); // does not block start-up; config.setup is refreshed when the probe ends
taskQueue.start();
routines.start();
backupScheduler.start();
const mirroring = mirror.start();
openCodeMirror.start();
// ✅ GitHub checks after every push (test servers: only with OFFICE_GH_BIN, i.e. a fake gh)
const ciWatcher = new CiWatcher({ hub, gh: process.env.CLAUDE_BIN && !process.env.OFFICE_GH_BIN ? null : findGh(), pollMs: Number(process.env.OFFICE_CI_POLL_MS ?? 20_000), firstMs: Number(process.env.OFFICE_CI_FIRST_MS ?? 8000) });
hub.ciWatch = (projectId) => ciWatcher.watch(projectId);
// Know who is logged in (usage is tagged with it); notice logins/logouts done in a terminal too.
account.refreshProfile(true).catch(() => {});
setInterval(() => account.refreshProfile(true).catch(() => {}), 60_000).unref();
// Phones unused for DEVICE_IDLE_MS are unpaired: now (after a long shutdown) and every hour.
remote.pruneIdle();
// ⚡ Remote power: a fresh heartbeat tells the bridge "PC hidup" (its status page shows 🟢 and unlocks the
// waiting flow). Halts while a scheduled power-off exists — a heartbeat landing after /api/off would
// cancel that schedule (the bridge's rule: PC alive again → don't cut power). The halt is time-based:
// 10 minutes after the last halt request it resumes on its own (see src/power-beat.js).
const powerBeat = new RemotePowerBeat({
  getConfig: () => hub.remotePower(),
  appVersion: APP_VERSION,
  onError: (err) => console.error('Remote power heartbeat:', err.message), // retried next tick; never crashes
});
powerBeat.start(); // the first beat goes out at once, then every 2 minutes (OFFICE_POWER_BEAT_MS overrides)
ctx.powerBeat = powerBeat; // 🩺 "Remote power": last successful beat, without exposing the URL or token
setInterval(() => remote.pruneIdle(), 60 * 60 * 1000).unref();
// Rows a lost process left "running" in an idle project (no turn, no CLI session, no ⧗ task) are closed live, so a
// spinner never survives when nothing is actually working — the boot sweep only covers restarts.
setInterval(() => hub.reconcileStaleToolRows(), 30_000).unref();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} sudah dipakai — Adhitron mungkin sudah berjalan.`);
  else console.error(err);
  process.exit(1);
});

// 🪟 Upgrade guard (1.0.33 → now): that version wrote `AutoAdminLogon=1` while its `adhitron-lock.vbs` was being
// quarantined by Defender, so the next boot logged in and left the desktop OPEN. The replacement lock task needs no
// elevation (per-user, InteractiveToken, LeastPrivilege): put it back before serving, and never let a refused Task
// Scheduler take the office down. No-op when Windows says autologon is off (or already has the lock task).
if (!AUTOLOGON_FAKE) {
  try {
    if (repairUnsafeAutologon(PORT)) console.log('Pengunci layar dipasang ulang: autologon aktif tanpa task pengunci.');
  } catch (err) {
    console.error(`Pengunci layar tidak bisa dipasang ulang: ${err?.message ?? err}`);
  }
  // A Setup wizard killed mid-way (or a helper that could not delete its temp file) leaves the Windows password in
  // %TEMP%: sweep the leftovers even if nothing else needs repairing.
  try {
    if (sweepLeftoverSecrets() > 0) console.log('File sandi sementara yang tertinggal dibersihkan.');
  } catch (err) {
    console.error(`File sandi sementara tidak bisa dibersihkan: ${err?.message ?? err}`);
  }
}

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Adhitron berjalan di ${url}`);
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
  if (WA_FAKE) console.error('PERINGATAN: OFFICE_WA_FAKE aktif — WhatsApp memakai soket palsu (hanya untuk test).');
  if (AUTOLOGON_FAKE) console.error('PERINGATAN: OFFICE_AUTOLOGON_FAKE aktif — autologon memakai saklar palsu (hanya untuk test).');
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
    metrics.flush();
    process.exit(1);
  }
  stopping = true;
  setTimeout(() => {
    hub.save();
    metrics.flush();
    process.exit(1);
  }, SHUTDOWN_HARD_LIMIT_MS).unref();
  server.close(); // no new connections; open event streams end with the process
  for (const { server: lan } of [...lanServers.values(), ...httpsServers.values()]) lan.close();
  tls.stop();
  mirror.stop();
  openCodeMirror.stop();
  ciWatcher.stop();
  powerBeat.stop();
  // A running contract check is aborted (its processes killed, whole tree) and not recorded; waited for ≤ 3 s.
  // The same for a running setup install (npm/winget children are killed by their own abort handling).
  const checksStopped = Promise.allSettled([claudeCheck.stop(), opencodeCheck.stop()]);
  spotify.stop();
  waLink.stop(); // closes the WhatsApp socket without touching the encrypted session (a restart reconnects)
  routines.stop();
  try {
    await sessions.shutdown();
  } catch (err) {
    console.error('Shutdown:', err?.stack ?? err);
  }
  await checksStopped; // each stop() is itself bounded (STOP_WAIT_MS)
  await setup.stop(); // bounded by SetupService.STOP_WAIT_MS; aborts a running install first
  hub.save();
  metrics.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
