// Windows auto-start. Two modes, both keeping the SAME interactive desktop session:
//
//   mode 'login' (default, the behaviour people already have)
//     1. a hidden launcher in the Startup folder — runs at login;
//     2. a per-user Task Scheduler watchdog every 5 minutes — restarts the server after
//        sleep/hibernate/Fast Startup (where the Startup folder may not run) or a crash.
//     The launcher first checks /health, so when the server is up it does nothing.
//
//   mode 'boot' — everything above PLUS the bits that make the server start ON THE LOCK SCREEN
//     (so Tailscale remote access survives a reboot the user did from far away):
//     3. a per-user Task Scheduler entry `Adhitron Lock`: 15 s after the logon it runs
//        `rundll32.exe user32.dll,LockWorkStation`. The desktop is never left open after an autologon.
//        1.0.33 used a `adhitron-lock.vbs` in the Startup folder for this, but Windows Defender quarantines
//        an unsigned .vbs with a LockWorkStation payload (ThreatID 2147842389): the screen stayed UNLOCKED
//        while the registry still logged the user in. A leftover file is deleted when the task is installed;
//     4. HKLM\...\Winlogon (AutoAdminLogon + DefaultPassword) itself, written by the GUI flow (POST
//        /api/autologon → src/autologon.js, one UAC prompt). No .cmd files any more: the elevated helper of this
//        very app does it, after proving that the lock task belongs to the account that will be logged in.
//
// Why autologon and not a SYSTEM service (or Task Scheduler "run whether logged on or not")?
// Adhitron lives off the user profile: os.homedir() feeds ~/.claude, ~/.claude.json,
// ~/.config/opencode, transcripts and backups in ~27 places. A SYSTEM or non-interactive session
// changes HOME and breaks the Claude credentials and the terminal dialogs. Autologon keeps the
// very same interactive session we have today, so every feature behaves identically; the lock
// screen keeps the machine physically safe while the server (and Tailscale) stay reachable.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The app was called "Claude Coworking" before it became Adhitron. These ids are already
// installed on people's machines, so they keep the old name: renaming them would orphan installs.
const TASK = 'Claude Coworking';
const LAUNCHER_FILE = 'claude-coworking.vbs';
// Boot mode only: the task's existence IS the mode flag, so it must never be left behind. A scheduled task (not a
// file) because Defender quarantines a .vbs with a LockWorkStation payload.
const LOCK_TASK = 'Adhitron Lock';
// 1.0.33 wrote this into the Startup folder. Kept only so an upgrade can delete the leftover.
const LEGACY_LOCK_FILE = 'adhitron-lock.vbs';
const WINLOGON_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon';
const QUIET = { stdio: 'ignore', windowsHide: true };

/**
 * Everything the module touches the outside world with, injectable for tests:
 * `{ mode, appDir, platform, startupDir, execFileSync, tmpdir, homedir, appData, hostname, username }`.
 * Defaults are production: the real Startup folder, the real `schtasks`/`reg`, the real temp dir.
 */
function context(options = {}) {
  const platform = options.platform ?? process.platform;
  const appData = options.appData ?? process.env.APPDATA ?? path.join(options.homedir ?? homedir(), 'AppData', 'Roaming');
  const startupDir = options.startupDir ?? path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  return {
    supported: platform === 'win32',
    platform,
    startupDir,
    exec: options.execFileSync ?? execFileSync,
    tmpdir: options.tmpdir ?? os.tmpdir(),
    hostname: options.hostname ?? os.hostname(),
    username: options.username ?? process.env.USERNAME ?? currentUser(),
    launcher: path.join(startupDir, LAUNCHER_FILE),
    legacyLock: path.join(startupDir, LEGACY_LOCK_FILE),
  };
}

/**
 * The Startup folder for this user, resolved exactly like the rest of this module. Same `options` as
 * `autostartStatus`; used for the 1.0.33 lock leftovers.
 */
export function startupDirOf(options = {}) {
  return context(options).startupDir;
}

function homedir() {
  try {
    return os.homedir();
  } catch {
    return process.cwd();
  }
}

function currentUser() {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

function taskExists(exec) {
  try {
    exec('schtasks', ['/Query', '/TN', TASK], QUIET);
    return true;
  } catch {
    return false;
  }
}

/** Is the boot-mode lock task installed? This — not a file — is the mode flag. */
function lockTaskExists(exec) {
  try {
    exec('schtasks', ['/Query', '/TN', LOCK_TASK], QUIET);
    return true;
  } catch {
    return false;
  }
}

/**
 * `schtasks` can refuse (a locked-down Task Scheduler, a policy, an antivirus holding the temp file). A bare
 * "Command failed: schtasks ..." would reach the UI as a mystery; say what could not be done.
 */
function runSchtasks(exec, args, action) {
  try {
    exec('schtasks', args, QUIET);
  } catch (err) {
    const detail = String(err?.stderr || err?.stdout || '').trim().split(/\r?\n/)[0] ?? '';
    const error = new Error(`Task Scheduler menolak ${action}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    error.cause = err;
    throw error;
  }
}

/**
 * Reads HKLM\...\Winlogon → AutoAdminLogon with `reg query` (read-only, no admin needed).
 * 'unknown' when it cannot be read at all (no value yet, non-Windows, reg missing) — the caller
 * then treats autologon as NOT set up, which is the safe answer.
 */
function readAutologon(exec) {
  try {
    const out = exec('reg', ['query', WINLOGON_KEY, '/v', 'AutoAdminLogon'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const match = /AutoAdminLogon\s+REG_SZ\s+(\S+)/i.exec(String(out ?? ''));
    if (!match) return 'unknown';
    return match[1].trim() === '1' ? 'on' : 'off';
  } catch {
    return 'unknown';
  }
}

function unsupportedStatus() {
  return {
    supported: false,
    enabled: false,
    watchdog: false,
    path: null,
    mode: 'login',
    autologon: 'unknown',
    needsElevation: false,
    unsafeDesktop: false,
  };
}

/**
 * The shape the UI gets (config payload + POST /api/autostart):
 *   mode 'boot'         — the `Adhitron Lock` task is installed (that task is the flag);
 *   autologon 'on'|'off'|'unknown' — what Windows itself says;
 *   needsElevation      — boot mode installed but autologon still not set: the UI must not claim it works;
 *   unsafeDesktop       — autologon is ON but the lock task is NOT installed. Windows would log itself in
 *                         and leave the desktop open: the one state the module must never leave behind (the
 *                         UI shows a hard warning; the GUI's Matikan button, as Administrator, ends it).
 * No file paths: the .cmd files of 1.0.33 are gone (POST /api/autologon replaces them).
 */
export function autostartStatus(options = {}) {
  const ctx = context(options);
  if (!ctx.supported) return unsupportedStatus();
  const boot = lockTaskExists(ctx.exec);
  const autologon = readAutologon(ctx.exec);
  return {
    supported: true,
    enabled: existsSync(ctx.launcher),
    watchdog: taskExists(ctx.exec),
    path: ctx.launcher,
    mode: boot ? 'boot' : 'login',
    // The lock task alone does not start the server before login: the autologon has to be on too.
    autologon,
    needsElevation: boot && autologon !== 'on',
    // Autologon without the lock: every boot would open the desktop for whoever is in front of the PC.
    unsafeDesktop: autologon === 'on' && !boot,
  };
}

/** VBScript: do nothing if the server answers /health, else start `node server.js --background` hidden. */
export function launcherScript(appDir, port = 4317) {
  const q = (s) => s.replace(/"/g, '""'); // VBScript string escaping
  return [
    "' Adhitron: starts the office server (at login and every 5 minutes if it is down).",
    "' Remove with uninstall-autostart.cmd.",
    'On Error Resume Next',
    'Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")',
    'http.setTimeouts 2000, 2000, 2000, 2000',
    `http.Open "GET", "http://127.0.0.1:${port}/health", False`,
    'http.Send',
    'If Err.Number = 0 Then',
    '  If http.Status = 200 Then WScript.Quit 0',
    'End If',
    'On Error GoTo 0',
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${q(appDir)}"`,
    `sh.Run """${q(process.execPath)}"" ""${q(path.join(appDir, 'server.js'))}"" --background", 0, False`,
    '',
  ].join('\r\n');
}

/** XML escaping: an account, a path or a description may contain these. */
const escXml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * The system's real rundll32.exe. Task Scheduler runs the command through CreateProcess, which does NOT expand
 * `%windir%`; an absolute path from SystemRoot (or the bare name, which Windows resolves inside System32) does.
 */
function rundll32() {
  const root = process.env.SystemRoot ?? process.env.windir ?? '';
  return root ? path.join(root, 'System32', 'rundll32.exe') : 'rundll32.exe';
}

/**
 * The account the lock task must belong to (C2), when the caller knows it: `{ user, domain }` from the S1-checked
 * autologon account, or `options.user`/`options.domain`. Null keeps the old behaviour (no `<UserId>`).
 */
function accountOf(options = {}) {
  const account = options.account ?? options;
  const user = account?.user;
  const domain = account?.domain ?? options.hostname;
  return user && domain ? { user, domain } : null;
}

/**
 * Task Scheduler definition for the boot-mode lock: at logon, 15 s later (the interactive session needs a moment to
 * settle), run `rundll32.exe user32.dll,LockWorkStation`. Hidden, least privilege, interactive token: it must lock
 * the very session the autologon opened, and it needs no Administrator rights for that.
 *
 * `<UserId>` (C2) names the account the task belongs to. Without it `schtasks /Create /XML` registers the task under
 * whoever runs it — when the UAC prompt was answered with ANOTHER administrator's credentials the task would be that
 * admin's, `InteractiveToken` would never fire for the autologon account, and the screen would stay unlocked while
 * the status said "safe". The elevated helper always passes the account; the GUI path may omit it (old behaviour).
 *
 * A scheduled task instead of the 1.0.33 `adhitron-lock.vbs`: Defender quarantines an unsigned .vbs containing a
 * LockWorkStation payload (ThreatID 2147842389), and the desktop was then left open after every reboot.
 *
 * @param {number} [port] Server port, only recorded in the description for whoever reads the task later.
 * @param {{ user: string, domain: string } | null} [account] The account that logs in (see above).
 */
export function lockTaskXml(port = 4317, account = null) {
  // M4: the port lands inside XML; only a real port number is ever written.
  const safePort = escXml(Number.isInteger(port) && port > 0 && port < 65536 ? port : 4317);
  const userId = account?.user && account?.domain
    ? `<UserId>${escXml(`${account.domain}\\${account.user}`)}</UserId>`
    : '';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Adhitron: locks the workstation 15 s after the automatic login (server port ${safePort}).</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT15S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals><Principal id="Author">${userId}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${escXml(rundll32())}</Command><Arguments>user32.dll,LockWorkStation</Arguments></Exec></Actions>
</Task>`;
}

/**
 * Installs (or replaces) ONLY the lock task, and removes the 1.0.33 `.vbs` leftover. Exported for
 * src/autologon.js: the elevated helper must have the lock in place BEFORE it writes AutoAdminLogon, otherwise the
 * next reboot logs in by itself and opens the desktop.
 *
 * `options.account` (or `options.user`/`options.domain`) names the principal the task belongs to (C2).
 */
export function installLockTask(port = 4317, options = {}) {
  const ctx = context(options);
  // M4: a bad port must never reach the XML.
  const safePort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 4317;
  const xmlFile = taskXmlFile(ctx.tmpdir, 'lock', lockTaskXml(safePort, accountOf(options)));
  try {
    runSchtasks(ctx.exec, ['/Create', '/F', '/TN', LOCK_TASK, '/XML', xmlFile], 'memasang pengunci layar');
  } finally {
    rmSync(xmlFile, { force: true });
  }
  removeFiles([ctx.legacyLock]);
}

/** Removes the lock task (idempotent). The caller decides whether removing it is safe (`unsafeDesktop`). */
export function removeLockTask(options = {}) {
  const ctx = context(options);
  if (lockTaskExists(ctx.exec)) runSchtasks(ctx.exec, ['/Delete', '/F', '/TN', LOCK_TASK], 'melepas pengunci layar');
}

/** Task Scheduler definition: every 5 minutes, also on battery, never overlapping. */
function watchdogXml(launcher) {
  const start = new Date(Date.now() + 60_000).toISOString().slice(0, 19);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Adhitron: keeps the office server running (starts it if it is down).</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${start}</StartBoundary>
      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"${escXml(launcher)}"</Arguments></Exec></Actions>
</Task>`;
}

/** schtasks /XML wants a UTF-16 file with a byte-order mark; every caller deletes it in a finally. */
function taskXmlFile(tmpdir, tag, xml) {
  const file = path.join(tmpdir, `adhitron-task-${tag}-${process.pid}.xml`);
  writeOrExplain(file, `\uFEFF${xml}`, 'utf16le');
  return file;
}

function removeFiles(files) {
  for (const file of files) {
    if (!file || !existsSync(file)) continue;
    try {
      unlinkSync(file);
    } catch (err) {
      // M6: a raw EPERM after the task was installed would reach the UI as a mystery; name the file and the reason.
      const reason = err?.code === 'EPERM' || err?.code === 'EACCES'
        ? 'tidak ada izin menghapus (mungkin sedang dipakai program lain)'
        : err?.message ?? String(err);
      const error = new Error(`Tidak bisa menghapus ${file}: ${reason}`);
      error.cause = err;
      throw error;
    }
  }
}

/**
 * Writes one generated file, turning a filesystem refusal into something a person can act on. These files go into
 * the Startup folder and next to the app; an install under Program Files is not writable without elevation, and a
 * bare EPERM there would reach the UI as "Terjadi kesalahan di server."
 */
function writeOrExplain(file, text, encoding = 'utf8') {
  try {
    writeFileSync(file, text, encoding);
  } catch (err) {
    const reason = err?.code === 'EPERM' || err?.code === 'EACCES'
      ? 'folder ini tidak bisa ditulis (instalasi di Program Files butuh izin Administrator)'
      : err?.message ?? String(err);
    const error = new Error(`Tidak bisa menulis ${file}: ${reason}`);
    error.cause = err;
    throw error;
  }
}

/**
 * Installs (or removes) the auto-start. `options.mode` is 'login' (default, unchanged behaviour) or
 * 'boot' (the login layer plus the `Adhitron Lock` task).
 *
 * `options.account` / `options.user` + `options.domain` are passed on to the lock task (C2); the GUI may omit them.
 *
 * Switching back to 'login' (or off) normally removes the boot-only pieces. One exception, and it matters more
 * than tidiness: while Windows autologon is ON (`AutoAdminLogon=1` in HKLM, which this module may only READ —
 * clearing it needs an Administrator), the lock task stays. Deleting it would make the next reboot log in by
 * itself and open the desktop, unlocked, with no server: the exact state the boot mode exists to prevent. The
 * status carries `unsafeDesktop` so the UI can say so out loud, and the GUI's Matikan button (as Administrator)
 * ends it.
 */
export function setAutostart(enabled, appDir, port = 4317, options = {}) {
  const ctx = context(options);
  const mode = options.mode === 'boot' ? 'boot' : 'login';
  if (!ctx.supported) return autostartStatus({ ...options, appDir });
  const pinned = readAutologon(ctx.exec) === 'on';
  if (!enabled) {
    // The launcher and the watchdog go (auto-start off); the lock stays while autologon does.
    removeFiles([ctx.launcher, ...(pinned ? [] : [ctx.legacyLock])]);
    if (!pinned) removeLockTask(options);
    if (taskExists(ctx.exec)) runSchtasks(ctx.exec, ['/Delete', '/F', '/TN', TASK], 'melepas penjaga 5 menit');
    return autostartStatus({ ...options, appDir });
  }
  mkdirSync(ctx.startupDir, { recursive: true });
  if (mode === 'boot') {
    // Lock first: from here on every logon locks the screen. The registry itself is written later, by the
    // elevated helper (POST /api/autologon), which refuses to run without this task.
    installLockTask(port, options);
  } else if (!pinned) {
    // Autologon is off: a lock on every logon would only lock a desktop the user just unlocked by hand.
    removeLockTask(options);
    removeFiles([ctx.legacyLock]);
  }
  // The launcher last: once it exists the status says "enabled", so it must be the file that can still fail.
  writeOrExplain(ctx.launcher, launcherScript(appDir, port));
  const xmlFile = taskXmlFile(ctx.tmpdir, 'watchdog', watchdogXml(ctx.launcher));
  try {
    runSchtasks(ctx.exec, ['/Create', '/F', '/TN', TASK, '/XML', xmlFile], 'memasang penjaga 5 menit');
  } finally {
    rmSync(xmlFile, { force: true });
  }
  return autostartStatus({ ...options, appDir });
}

/**
 * Upgrade guard (step 7): a 1.0.33 install may have `AutoAdminLogon=1` while its `adhitron-lock.vbs` was quarantined
 * by Defender — the next reboot would log in and leave the desktop OPEN. Installing the lock task needs no
 * elevation (per-user task, InteractiveToken, LeastPrivilege), so the server does it at start-up.
 *
 * Does nothing unless Windows itself says autologon is on AND the lock task is missing. Returns true when it acted.
 * Throws when the task cannot be installed; the caller only logs that — a PC without Task Scheduler access must
 * still run the office.
 */
export function repairUnsafeAutologon(port = 4317, options = {}) {
  const status = autostartStatus(options);
  if (!status.supported || status.autologon !== 'on' || status.mode === 'boot') return false;
  installLockTask(port, options); // also deletes the 1.0.33 .vbs leftover
  return true;
}
