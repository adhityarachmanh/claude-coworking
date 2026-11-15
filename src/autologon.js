// Windows autologon - the elevated half of "server hidup sebelum login Windows" (mode 'boot' in src/autostart.js).
//
// Why this module exists: writing HKLM\...\Winlogon (AutoAdminLogon=1 plus DefaultPassword) needs an Administrator
// token, and the old .cmd files asked people to open a terminal and click "Run as administrator". Now the GUI asks
// for the Windows password once:
//
//   1. enableAutologon() runs with the normal token: it writes the password to
//      %TEMP%\adhitron-autologon-<rand>.txt (mode 0600) and re-launches THIS SAME executable through
//      `Start-Process -Verb RunAs` - one UAC prompt, no terminal;
//   2. the elevated child is this same app with `--autologon-enable`, so server.js calls helperMain() before it
//      starts the server;
//   3. the fixed PowerShell script (winlogonScript) destroys that file FIRST, proves the password with LogonUser,
//      checks that the `Adhitron Lock` task exists and belongs to this account, and only then writes the registry —
//      with `AutoAdminLogon=1` as the LAST value, so status never claims "on" for a login Windows cannot do;
//   4. the parent deletes the temp file in a finally, reads the exit code and re-reads the real Windows status.
//
// The password is never in a script, a log line or an error message: it only lives in that one temp file and in the
// registry value Windows itself needs to log in. If anything goes wrong before the validation, the registry is left
// exactly as it was - a wrong DefaultPassword means the machine cannot log in at all.
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autostartStatus, installLockTask, removeLockTask } from './autostart.js';

// Must match src/autostart.js: the `Adhitron Lock` task is the "boot mode" flag, and the elevated helper installs it
// too (before the registry changes) so an autologon can never boot into an open desktop.
const LOCK_TASK = 'Adhitron Lock';
/** A Windows security identifier, the only identity spelling C2 accepts from a command line. */
const SID_PATTERN = /^S-1-[0-9-]+$/;
const POWERSHELL = 'powershell.exe';
// `-ExecutionPolicy Bypass`: the script lives in the per-user temp folder, on machines whose policy would otherwise
// refuse an unsigned .ps1. `-NonInteractive`: helperMain is started by the server, there is nobody to answer a prompt.
const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
// The temp file the parent drops the password in: per-user, gone before the first registry write.
const SECRET_PREFIX = 'adhitron-autologon-';
const SECRET_PATTERN = /^adhitron-autologon-[0-9a-f]+\.txt$/;
// The helper's one-line report back to the parent (I4): exit code + reason, never the password.
const RESULT_PATTERN = /^adhitron-autologon-[0-9a-f]+\.result$/;
// M3: one honest wording for "the lock screen or the registry could not be installed".
const LOCK_FAILED_MESSAGE = 'Pengunci layar atau registry tidak bisa dipasang (izin Administrator / Task Scheduler menolak).';
// I2: a timeout no longer says "Windows did not answer" when nobody knows the real state.
const TIMEOUT_UNKNOWN = 'Status tidak diketahui — buka Setelan untuk memeriksa.';
const WRONG_PASSWORD_MESSAGE = 'Sandi Windows salah.';
// ERROR_CANCELLED: the user pressed "No" on the UAC prompt. Not an error, the feature simply stays off.
const UAC_CANCELLED = 1223;
// A UAC prompt is a human action, but it cannot be an open-ended one: without this, a PowerShell held by an
// antivirus would keep POST /api/autologon (and the UI) waiting for ever.
const PROCESS_TIMEOUT_MS = 120_000;

/**
 * Exit codes of the elevated helper (`helperMain`), shared with the parent side and with server.js:
 *   0 success, 1 unexpected, 3 wrong password, 4 registry not writable, 5 not an Administrator, 6 UAC cancelled.
 */
const EXIT = { ok: 0, failed: 1, wrongPassword: 3, registry: 4, notAdmin: 5, cancelled: 6 };

/** What the helper reports in its result file (I4) when PowerShell gave no detail of its own. */
const RESULT_TEXT = {
  [EXIT.ok]: 'OK',
  [EXIT.wrongPassword]: WRONG_PASSWORD_MESSAGE,
  [EXIT.registry]: LOCK_FAILED_MESSAGE,
  [EXIT.notAdmin]: 'Izin Administrator dibutuhkan.',
  [EXIT.failed]: 'Autologon gagal.',
};

/** Registry values and command lines survive quotes badly, and an account name never needs them. */
const clean = (value) => String(value ?? '').replace(/["\r\n]/g, '').trim();

function currentUserName() {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

/**
 * The app folder the elevated copy has to re-launch (so `Adhitron.exe --autologon-enable` works from source too):
 * an explicit `appDir`, then OFFICE_APP_DIR (set by server.js), then this file's parent folder, then the .exe folder
 * (a packaged build bundles this file into one executable, where import.meta has no URL).
 */
function appDirOf(options = {}) {
  if (options.appDir) return path.resolve(options.appDir);
  if (process.env.OFFICE_APP_DIR) return path.resolve(process.env.OFFICE_APP_DIR);
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return path.dirname(process.execPath);
  }
}

/** The folder THIS copy of the app lives in — never taken from argv or the environment. */
function ownAppDir() {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return path.dirname(process.execPath);
  }
}

const samePath = (a, b) => {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};

/**
 * I3 - `--app-dir` must never decide which code runs as Administrator.
 *
 * Whoever can start the CLI can put any folder there; behind an UAC prompt that says "Adhitron" the elevated copy
 * would then launch THEIR `server.js` as Administrator. Only the folder this copy already runs from is accepted;
 * anything else is ignored (`undefined` → `appDirOf()` resolves the real one).
 */
function trustedAppDir(requested) {
  if (!requested) return undefined;
  const candidate = path.resolve(requested);
  return samePath(candidate, ownAppDir()) ? candidate : undefined;
}

/**
 * Which Windows account the autologon logs in: `{ user, domain }` - the pair Windows writes to
 * DefaultUserName/DefaultDomainName.
 *
 * A Microsoft account (an email as the user name) is NOT a local `COMPUTER\user`: Windows requires the literal
 * domain `MicrosoftAccount` for it, otherwise every boot fails back to the login screen. A local/domain account uses
 * this computer's name, exactly like the .cmd scripts did.
 *
 * @param {string} [user] Local account name (default: the USERNAME of this process).
 * @param {string} [upn] The Microsoft account email, when the caller knows it.
 * @returns {{ user: string, domain: string }}
 */
export function windowsAccount(user = process.env.USERNAME, upn = '') {
  const account = clean(upn);
  if (account.includes('@')) return { user: account, domain: 'MicrosoftAccount' };
  const name = clean(user) || clean(currentUserName());
  if (!name) throw new Error('Nama akun Windows tidak diketahui, autologon tidak bisa disiapkan.');
  let host = '';
  try {
    host = clean(os.hostname());
  } catch {
    host = '';
  }
  return { user: name, domain: host };
}

/**
 * The fixed PowerShell body that turns autologon on. It NEVER contains the password: the password arrives through
 * `-PasswordFile`, a per-user temp file this script destroys before it writes anything.
 *
 * Order guarantees (the reason this is one script and not three commands):
 *   1. no Administrator token -> exit 5, nothing touched;
 *   2. no `Adhitron Lock` task, or a task owned by another account -> exit 4, nothing touched (autologon must never
 *      open the desktop);
 *   3. read the file, delete the file, then validate with LogonUser -> a wrong password exits 3 with the registry
 *      exactly as it was;
 *   4. DefaultUserName, DefaultDomainName, DefaultPassword FIRST and `AutoAdminLogon=1` LAST, as the switch: a
 *      failure halfway through - or the process being killed - leaves Windows with the account/password in place
 *      but still logging in normally, never an "on" switch with a password it cannot use (M2).
 *
 * Arguments: `-PasswordFile`, `-User`, `-Domain`.
 *
 * @returns {string} The PowerShell script (run elevated with `-EncodedCommand`).
 */
export function winlogonScript() {
  return [
    '# Adhitron: turns Windows autologon on so the office server runs before anyone logs in.',
    '# No password in here: it arrives through -PasswordFile, which this script deletes first.',
    'param(',
    '  [Parameter(Mandatory = $true)][string]$PasswordFile,',
    '  [Parameter(Mandatory = $true)][string]$User,',
    '  [Parameter(Mandatory = $true)][string]$Domain',
    ')',
    "$ErrorActionPreference = 'Stop'",
    '',
    '# 5: HKLM\Winlogon is Administrator-only. Stop before touching anything.',
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$principal = New-Object Security.Principal.WindowsPrincipal($identity)',
    'if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 5 }',
    '',
    '# 4: without the lock task an autologon boots to an OPEN desktop. Refuse, registry untouched.',
    '$lockTask = $null',
    `try { $lockTask = Get-ScheduledTask -TaskName '${LOCK_TASK}' -ErrorAction SilentlyContinue } catch { }`,
    'if ($null -eq $lockTask) { exit 4 }',
    '',
    '# The password exists only in this variable, and the file is gone before the first registry write.',
    'if (-not (Test-Path -LiteralPath $PasswordFile)) { exit 1 }',
    '$plain = [IO.File]::ReadAllText($PasswordFile)',
    'Remove-Item -LiteralPath $PasswordFile -Force -ErrorAction SilentlyContinue',
    'if ([string]::IsNullOrEmpty($plain)) { exit 3 }',
    '',
    '# 3: LogonUser is the only honest test. A wrong DefaultPassword means nobody can log in after a reboot.',
    '$logonSig = @"',
    '[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
    'public static extern bool LogonUser(string user, string domain, string password, int logonType, int logonProvider, out IntPtr token);',
    '"@',
    "$logon = Add-Type -MemberDefinition $logonSig -Name 'AdhitronLogonUser' -Namespace 'Adhitron' -PassThru",
    '$token = [IntPtr]::Zero',
    '# LOGON32_LOGON_INTERACTIVE = 2, LOGON32_PROVIDER_DEFAULT = 0 (the same logon Windows does at boot).',
    'if (-not $logon::LogonUser($User, $Domain, $plain, 2, 0, [ref]$token)) { $plain = $null; exit 3 }',
    '',
    '$handleSig = @"',
    '[DllImport("kernel32.dll", SetLastError = true)]',
    'public static extern bool CloseHandle(IntPtr handle);',
    '"@',
    "$handle = Add-Type -MemberDefinition $handleSig -Name 'AdhitronCloseHandle' -Namespace 'Adhitron' -PassThru",
    'if ($token -ne [IntPtr]::Zero) { [void]$handle::CloseHandle($token) }',
    '',
    '# 4: registry write. AutoAdminLogon is the SWITCH and goes LAST (M2): killed halfway, Windows keeps logging',
    '#    in normally instead of reading "on" with a password it cannot use. There is nothing to roll back - a',
    '#    failure before the switch leaves the earlier values unused, and the switch itself is the last write.',
    'try {',
    "$key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', $true)",
    'if ($null -eq $key) { $plain = $null; exit 4 }',
    'try {',
    "  $key.SetValue('DefaultUserName', $User, 'String')",
    "  $key.SetValue('DefaultDomainName', $Domain, 'String')",
    "  $key.SetValue('DefaultPassword', $plain, 'String')",
    "  $key.SetValue('AutoAdminLogon', '1', 'String')",
    '} catch {',
    '  $plain = $null',
    '  exit 4',
    '} finally { $key.Close() }',
    '} catch { $plain = $null; exit 4 }',
    '$plain = $null',
    'exit 0',
    '',
  ].join('\r\n');
}

/**
 * The elevated counterpart of disableAutologonScript (src/autostart.js): AutoAdminLogon=0, the stored password
 * deleted, and the lock task removed - with autologon off it would only lock the desktop right after the user
 * logged in by hand.
 */
function disableWinlogonScript() {
  return [
    '# Adhitron: turns Windows autologon off (AutoAdminLogon=0, DefaultPassword removed).',
    "$ErrorActionPreference = 'Stop'",
    '',
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$principal = New-Object Security.Principal.WindowsPrincipal($identity)',
    'if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 5 }',
    '',
    'try {',
    "$key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', $true)",
    'if ($null -eq $key) { exit 4 }',
    'try {',
    "  $key.SetValue('AutoAdminLogon', '0', 'String')",
    "  $key.DeleteValue('DefaultPassword', $false)",
    '} finally { $key.Close() }',
    '} catch { exit 4 }',
    '',
    '# The lock task only made sense while Windows logged in by itself.',
    `try { Unregister-ScheduledTask -TaskName '${LOCK_TASK}' -Confirm:$false -ErrorAction Stop } catch { }`,
    'exit 0',
    '',
  ].join('\r\n');
}

/** A PowerShell single-quoted literal: only `'` needs doubling, no interpolation happens inside it. */
const psQuote = (value) => String(value ?? '').replace(/'/g, "''");

/**
 * One argument of a Windows command line, quoted the way CommandLineToArgvW parses it back.
 *
 * A run of backslashes immediately before the closing quote is an ESCAPE SEQUENCE for that quote: `"C:\Program
 * Files\"` would swallow the quote and glue the next argument onto this one. Doubling the trailing backslashes keeps
 * the value intact (`"C:\Program Files\\"` = `C:\Program Files\`). Values never need an embedded quote here (account
 * names and paths), and `clean()` has already removed any.
 */
function winArg(value) {
  const text = String(value ?? '').replace(/"/g, '');
  if (!/\s/.test(text)) return text;
  return `"${text.replace(/(\\+)$/, '$1$1')}"`;
}

/** A usable regular file? A missing entry or a permission error both mean "no" here. */
function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The executable + arguments that re-launch THIS app:
 *   - from source: `node <appDir>/server.js`; `process.argv[1]` is only used when it lives in `<appDir>` too, so a
 *     stray `node C:\temp\x.js` can never be the code an Administrator approves in the UAC prompt;
 *   - packaged as a single executable: `process.execPath` alone. There `process.argv[1]` is the first USER argument
 *     (`--autologon-enable`), not a script, so it is not mistaken for one.
 * Exported for the disable route (src/routes/autologon.js): it must spawn the same copy the user is running.
 *
 * @param {string} appDir The app folder (the packaged executable's folder, or the repo when running from source).
 * @returns {{ file: string, args: string[] }}
 */
export function relaunchOf(appDir) {
  const entry = path.join(appDir, 'server.js');
  const fromAppDir = isFile(entry);
  // `process.argv[1]` is only trusted when it IS this app's own entry point: running `node C:\temp\x.js` must not
  // get x.js executed as Administrator behind an Adhitron UAC prompt (I3).
  const script = fromAppDir
    ? entry
    : [process.argv[1]].find((file) => file && /\.[cm]?js$/i.test(file) && isFile(file)
      && sameDir(path.dirname(path.resolve(file)), appDir));
  return { file: process.execPath, args: script ? [path.resolve(script)] : [] };
}

/** Case-insensitive folder comparison (Windows paths). */
function sameDir(a, b) {
  const norm = (value) => path.resolve(String(value)).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * `Start-Process -Verb RunAs -Wait -PassThru`: one UAC prompt, the elevated copy's exit code comes back.
 * A cancelled prompt is normalised to 1223 (ERROR_CANCELLED) instead of PowerShell's generic error text.
 */
function elevationCommand(file, argumentLine) {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $p = Start-Process -FilePath '${psQuote(file)}' -ArgumentList '${psQuote(argumentLine)}' -Verb RunAs -Wait -PassThru`,
    '  exit $p.ExitCode',
    '} catch {',
    '  $native = 0',
    '  if ($_.Exception.NativeErrorCode) { $native = [int]$_.Exception.NativeErrorCode }',
    '  elseif ($_.Exception.InnerException.NativeErrorCode) { $native = [int]$_.Exception.InnerException.NativeErrorCode }',
    "  elseif (\"$($_.Exception.Message)\" -match '1223|canceled by the user|dibatalkan oleh pengguna') { $native = 1223 }",
    '  if ($native -eq 1223) { exit 1223 }',
    '  Write-Error $_',
    '  exit 1',
    '}',
  ].join('\r\n');
}

/**
 * Runs a process and resolves with `{ code, signal, timedOut, stderr }` (never rejects on a non-zero exit): the caller
 * decides what a code means. An injected `spawn` keeps the tests away from the real UAC prompt.
 *
 * `code` is `null` when the child died without a code (killed, crashed): that is a FAILURE, never a success (G4).
 * A child that never answers (an antivirus holding powershell.exe) is killed at `timeoutMs` and reported as
 * `timedOut`, so `POST /api/autologon` can never hang for ever (S6).
 */
function runProcess(spawn, file, args, options = {}) {
  const { timeoutMs: limit = PROCESS_TIMEOUT_MS, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    let timer = null;
    let child;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], ...spawnOptions });
    } catch (err) {
      finish(null, err);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {
        // already gone: the timeout verdict stands either way
      }
      finish({ code: null, signal: 'timeout', timedOut: true, stderr });
    }, limit);
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => finish(null, err));
    child.on('close', (code, signal) => finish({
      code: typeof code === 'number' ? code : null,
      signal: signal ?? null,
      timedOut: false,
      stderr,
    }));
  });
}

/** Launches this app again, elevated, with `args`; resolves with PowerShell's exit code (`null` when it never ran). */
async function elevate(spawn, { appDir, args, timeoutMs }) {
  const target = relaunchOf(appDir);
  const argumentLine = [...target.args, ...args].map(winArg).join(' ');
  const outcome = await runProcess(spawn, POWERSHELL, [
    ...PS_FLAGS,
    '-Command',
    elevationCommand(target.file, argumentLine),
  ], { timeoutMs });
  return logElevation(outcome, timeoutMs);
}

/**
 * The blocking twin of `elevate` (used by `helperMainSync`): `execFileSync` waits for PowerShell, which waits for
 * the elevated copy (`-Wait -PassThru`), so its exit code comes back without a promise.
 */
function elevateSync({ appDir, args, timeoutMs }, options = {}) {
  const exec = options.execFileSync ?? execFileSync;
  const limit = timeoutMs ?? PROCESS_TIMEOUT_MS;
  const target = relaunchOf(appDir);
  const argumentLine = [...target.args, ...args].map(winArg).join(' ');
  try {
    exec(POWERSHELL, [...PS_FLAGS, '-Command', elevationCommand(target.file, argumentLine)], {
      timeout: limit,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return logElevation({ code: EXIT.ok, timedOut: false, stderr: '' }, limit);
  } catch (err) {
    // A killed child (timeout) has no status; UAC cancelled/failed has the PowerShell exit code.
    const timedOut = err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT';
    const code = typeof err?.status === 'number' ? err.status : null;
    return logElevation({ code, timedOut, stderr: String(err?.stderr ?? '') }, limit);
  }
}

/** Prints WHY the UAC round trip failed (never the password) and returns the outcome unchanged. */
function logElevation(outcome, timeoutMs) {
  if (outcome.timedOut) {
    console.error(`Autologon: permintaan izin Administrator tidak dijawab dalam ${Math.round((timeoutMs ?? PROCESS_TIMEOUT_MS) / 1000)} detik.`);
  } else if (outcome.code !== EXIT.ok) {
    const detail = String(outcome.stderr ?? '').trim().split(/\r?\n/)[0] ?? '';
    if (detail) console.error(`Autologon: permintaan izin Administrator gagal (kode ${outcome.code}) ${detail.slice(0, 300)}`);
  }
  return outcome;
}

/** The raw exit code of a failed `execFileSync`, as a number (ENOENT and friends become EXIT.failed). */
function exitCodeOf(err) {
  const raw = err?.status ?? err?.code;
  return typeof raw === 'number' ? raw : EXIT.failed;
}

/**
 * 1223 and 6 both mean "the user said no to UAC". Everything unknown is an unexpected failure, never success:
 * a `null` code (killed, crashed, no code at all) is NOT `0` (G4).
 */
function normalizeExit(code) {
  if (typeof code !== 'number' || !Number.isInteger(code)) return EXIT.failed;
  if (code === UAC_CANCELLED || code === EXIT.cancelled) return EXIT.cancelled;
  return [EXIT.ok, EXIT.failed, EXIT.wrongPassword, EXIT.registry, EXIT.notAdmin].includes(code) ? code : EXIT.failed;
}

/** `--flag value` or `--flag=value` anywhere in argv (the server passes extra flags of its own). */
function flagValue(args, name) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

/** An Error the routes can map to a status code: `code` is one of the EXIT keys above. */
function autologonError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = EXIT[code] ?? EXIT.failed;
  return error;
}

/**
 * Deletes the password file, and SAYS SO when Windows refuses (S7): a leftover secret file is a finding, not a
 * detail to swallow. Only the path and the reason are logged - never the content.
 */
function removeSecret(file, remove = rmSync) {
  if (!file) return true;
  try {
    remove(file, { force: true });
    return true;
  } catch (err) {
    const reason = err?.code ?? err?.message ?? String(err);
    console.error(`Autologon: PERINGATAN file sandi sementara ${file} tidak bisa dihapus (${reason}). Hapus manual.`);
    return false;
  }
}

/** One line, bounded: what goes into the result file and into an error message. */
const oneLine = (text) => String(text ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);

/**
 * I4 - the elevated child's own verdict: `<exit code>` then one line of reason, in
 * `%TEMP%\adhitron-autologon-<hex>.result`. Never the password; a write failure is ignored (the exit code is the
 * contract, the file only adds the detail the parent would otherwise lose).
 */
function writeResult(file, code, message) {
  if (!file) return;
  try {
    writeFileSync(file, `${code}\r\n${oneLine(message) || RESULT_TEXT[code] || 'Autologon gagal.'}\r\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // the parent still gets the exit code
  }
}

/** Reads the child's result file and deletes it, whatever happens. `null` when it never wrote one. */
function readResult(file, remove = rmSync) {
  if (!file) return null;
  try {
    const text = readFileSync(file, 'utf8').slice(0, 2048);
    const [first, ...rest] = text.split(/\r?\n/);
    const code = Number(first);
    return { code: Number.isInteger(code) ? code : null, message: oneLine(rest.join(' ')) };
  } catch {
    return null;
  } finally {
    try {
      remove(file, { force: true });
    } catch {
      // a harmless leftover (no secret): never worth failing the enable over
    }
  }
}

/** The result file must be one of ours in the per-user temp folder (it may not exist yet). */
function isOwnResultFile(file, tmpdir) {
  if (!file) return false;
  try {
    return RESULT_PATTERN.test(path.basename(file)) && path.dirname(path.resolve(file)) === path.resolve(tmpdir);
  } catch {
    return false;
  }
}

/**
 * The PowerShell the C2 check runs. Exported so the real script can be exercised against a real task instead of
 * trusting a string that only a fixture ever reads.
 */
export function lockTaskCheckScript({ user, domain, sid = '' }) {
  const wanted = `${domain}\\${user}`;
  const wantedSid = SID_PATTERN.test(String(sid ?? '')) ? String(sid) : '';
  return [
    "$ErrorActionPreference = 'Stop'",
    `$want = '${psQuote(wanted)}'`,
    `$wantSid = '${psQuote(wantedSid)}'`,
    `try { $task = Get-ScheduledTask -TaskName '${LOCK_TASK}' -ErrorAction Stop } catch { exit 4 }`,
    'if ($null -eq $task) { exit 4 }',
    '$owner = [string]$task.Principal.UserId',
    'if ([string]::IsNullOrWhiteSpace($owner)) { exit 4 }',
    '$resolve = {',
    '  param([string]$name)',
    '  if ([string]::IsNullOrWhiteSpace($name)) { return \'\' }',
    "  if ($name -match '^S-1-[0-9-]+$') { return $name }",
    '  try { return ([Security.Principal.NTAccount]$name).Translate([Security.Principal.SecurityIdentifier]).Value } catch { return \'\' }',
    '}',
    // The SID comes from the parent's argv: it must BE this account, or a tampered/foreign value would verify someone
    // else's task. `$want` that cannot be resolved (MicrosoftAccount\email) is checked by the owner comparison below.
    'if ($wantSid) { $wantResolved = & $resolve $want; if ($wantResolved -and $wantResolved -ne $wantSid) { exit 4 } }',
    'if ($owner -ieq $want) { exit 0 }',
    '$ownerSid = & $resolve $owner',
    "if (-not $ownerSid -and $owner -notmatch '\\\\') { $ownerSid = & $resolve ($env:COMPUTERNAME + '\\' + $owner) }",
    'if ($ownerSid -and $wantSid) { if ($ownerSid -ieq $wantSid) { exit 0 } else { exit 4 } }',
    // The parent could not report its SID (no `--account-sid`): accept the elevated session's own account, which is
    // what the check did before. Only reachable for an elevated copy running as the very account that logs in.
    'if ($ownerSid -and ($ownerSid -ieq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) { exit 0 }',
    'exit 4',
  ].join('\r\n');
}

/**
 * C2 - after `schtasks /Create`, does the lock task really belong to the account Windows will log in as?
 *
 * The elevated helper may have been started with ANOTHER administrator's credentials (common in an office): the
 * task would then be that admin's, `InteractiveToken` would never fire for the autologon account, and the screen
 * would stay unlocked while the status said "safe". `lockTaskCheckScript` compares IDENTITIES (SIDs), not spellings:
 * `Principal.UserId` comes back as the short name (`adhit`), as `ARH\adhit`, or as the SID, depending on the Windows
 * build - string comparison alone rejected a perfectly good task and turned "Aktifkan" into a 409.
 *
 * Fail closed: no task, no owner, an unresolvable owner, a locked-down Task Scheduler - all mean "not verified"
 * (exit 4, registry untouched).
 */
function lockTaskBelongsTo(exec, account) {
  try {
    exec(POWERSHELL, [...PS_FLAGS, '-Command', lockTaskCheckScript(account)], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (err) {
    const detail = oneLine(String(err?.stderr ?? '').split(/\r?\n/)[0] ?? '');
    console.error(`Autologon: identitas task pengunci layar tidak cocok${detail ? `: ${detail}` : ''}.`);
    return false;
  }
}

/**
 * The real user principal name of this session (`whoami /upn`). A Microsoft account reports its email; a local
 * account answers with an error, which means "unknown" here.
 */
function upnOf(exec) {
  try {
    const out = String(exec('whoami', ['/upn'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) ?? '');
    const upn = clean(out.split(/\r?\n/)[0]);
    return upn.includes('@') ? upn : '';
  } catch {
    return '';
  }
}

/**
 * The SID of this session's account (`whoami /user /fo csv /nh` → `"ARH\adhit","S-1-5-21-…"`): the identity the
 * lock task must belong to. '' when Windows does not answer.
 */
function sidOf(exec) {
  try {
    const out = String(exec('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) ?? '');
    const match = /"(S-1-[0-9-]+)"/.exec(out);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

/**
 * S1 - the account in argv must be THIS session's Windows account, case-insensitively.
 *
 * `--user`/`--domain` end up in DefaultUserName/DefaultDomainName, i.e. WHO Windows logs in as: accepting them from
 * argv would let anyone who can start the CLI (and get one UAC click) point the autologon at another account.
 *
 *   - `MicrosoftAccount`: the user must be a upn; compared with the real upn when Windows reports one, otherwise its
 *     local part must be this session's account name (Windows does not always expose an MSA's email);
 *   - a local account: never a upn, same name, same computer name (exactly what windowsAccount() returns).
 *
 * @returns {boolean} true only for the current account.
 */
function accountMatches({ user, domain }, real, realUpn) {
  const name = String(user ?? '').toLowerCase();
  const host = String(domain ?? '').toLowerCase();
  if (!name || !host) return false;
  if (host === 'microsoftaccount') {
    if (!name.includes('@')) return false;
    if (realUpn) return name === String(realUpn).toLowerCase();
    return name.split('@')[0] === String(real?.user ?? '').toLowerCase();
  }
  if (name.includes('@')) return false;
  return name === String(real?.user ?? '').toLowerCase() && host === String(real?.domain ?? '').toLowerCase();
}

/** A cancelled UAC prompt also shows up as an ordinary PowerShell error text on stderr. */
const looksCancelled = (stderr) => /1223|canceled by the user|cancelled by the user|dibatalkan oleh pengguna/i.test(String(stderr ?? ''));

/**
 * Turns Windows autologon on, from the GUI, with exactly one UAC prompt.
 *
 * The password travels only through the temp file: this function writes it with mode 0600, re-launches the app
 * elevated (`--autologon-enable`), and deletes the file in a `finally`, whether the child succeeded, failed or the
 * prompt was cancelled. Nothing is written to the registry by this (non-elevated) process.
 *
 * @param {object} options
 * @param {string} options.password  The Windows password. Never stored, never logged, never returned.
 * @param {string} [options.appDir]  The app folder to re-launch elevated (defaults to this install).
 * @param {number} [options.port]    Server port, recorded in the `Adhitron Lock` task description.
 * @param {number} [options.timeoutMs] How long the elevated copy may take before the answer is 'timeout' (120 s).
 * @param {Function} [options.exec]  execFileSync (only used to re-read the status with `reg query`).
 * @param {Function} [options.spawn] child_process.spawn, injected so tests never raise a real UAC prompt.
 * @param {Function} [options.status] autostartStatus, injectable for tests.
 * @param {Function} [options.removeFile] rmSync, injectable so a refused deletion (S7) can be tested.
 * @returns {Promise<{ ok: true, verified: true } | { ok: false, cancelled: true } |
 *   { ok: false, reason: 'timeout', error: string }>}
 *   Rejects with an Error whose `code` is 'wrongPassword' (3), 'notAdmin' (5), 'registry' (4),
 *   'unverified' or 'unsupported' when the change did not happen.
 */
export async function enableAutologon({
  password,
  appDir,
  port = 4317,
  timeoutMs = PROCESS_TIMEOUT_MS,
  exec = execFileSync,
  spawn = spawnProcess,
  platform = process.platform,
  user,
  upn = '',
  tmpdir = os.tmpdir(),
  status = autostartStatus,
  removeFile = rmSync,
} = {}) {
  if (platform !== 'win32') throw autologonError('Autologon hanya tersedia di Windows.', 'unsupported');
  if (typeof password !== 'string' || password.length === 0) throw autologonError('Sandi Windows wajib diisi.', 'wrongPassword');

  const dir = appDirOf({ appDir });
  const account = windowsAccount(user, upn);
  // C2: read the SID of THIS session (the account Windows will log in as) before elevating; the elevated copy may
  // run as another administrator, whose identity must not be the one the task is checked against.
  const accountSid = sidOf(exec);
  const token = randomBytes(8).toString('hex');
  const secretFile = path.join(tmpdir, `${SECRET_PREFIX}${token}.txt`);
  // I4: the elevated child leaves its verdict here (exit code + one line, never the password). Deleted in every path.
  const resultFile = path.join(tmpdir, `${SECRET_PREFIX}${token}.result`);
  const statusOf = () => {
    try {
      return status({ appDir: dir, port, platform, execFileSync: exec }) ?? null;
    } catch {
      return null;
    }
  };
  // I5: remember whether a lock task existed BEFORE the helper ran. One installed on the way to a wrong password
  // belongs to nobody and would lock the screen at every logon.
  const before = statusOf();

  // Owner-only, and created before the elevated process starts: the utility only ever reads it once.
  writeFileSync(secretFile, password, { encoding: 'utf8', mode: 0o600 });

  const args = [
    '--autologon-enable',
    '--password-file', secretFile,
    // The elevated copy may run under ANOTHER administrator's account (cross-account UAC): its %TEMP% differs, so
    // the folder the file really lives in has to be declared — `isOwnSecretFile` accepts only a per-user Temp.
    '--password-dir', path.dirname(secretFile),
    '--result-file', resultFile,
    '--user', account.user,
    '--domain', account.domain,
    '--app-dir', dir,
    '--port', String(port),
    // C2: the identity the lock task must belong to, read from THIS (the account that will log in) session.
    ...(accountSid ? ['--account-sid', accountSid] : []),
    // This copy is already elevated (Start-Process -Verb RunAs): no second prompt, no `net session` probe.
    '--elevated',
  ];

  let outcome;
  let report = null;
  const relaunch = relaunchOf(dir);
  const argumentLine = [...relaunch.args, ...args].map(winArg).join(' ');
  try {
    outcome = await runProcess(spawn, POWERSHELL, [
      ...PS_FLAGS,
      '-Command',
      elevationCommand(relaunch.file, argumentLine),
    ], { timeoutMs, windowsHide: true });
  } catch (err) {
    // PowerShell itself could not be started (missing, blocked by policy): the registry is untouched.
    throw autologonError(`Tidak bisa meminta izin Administrator: ${err?.message ?? err}`, 'registry');
  } finally {
    // The script deletes it too; this is the guarantee, including when PowerShell never started.
    removeSecret(secretFile, removeFile);
    // I4: read (and delete) the child's report on every path, including a PowerShell that never started.
    report = readResult(resultFile, removeFile);
  }

  if (outcome.timedOut) {
    // I2: the elevated child may have finished after this process stopped waiting. Ask Windows, not the clock.
    const after = statusOf();
    if (after?.autologon === 'on' && after?.mode === 'boot') return { ok: true, verified: true };
    return { ok: false, reason: 'timeout', error: TIMEOUT_UNKNOWN };
  }

  const { code, stderr } = outcome;
  const exit = normalizeExit(code);
  // I4: the child's own one-line reason, when it managed to write one.
  const detail = oneLine(report?.message);
  if (exit === EXIT.cancelled || (exit === EXIT.failed && looksCancelled(stderr))) {
    return { ok: false, cancelled: true };
  }
  if (exit === EXIT.wrongPassword) {
    // I5: the helper installs the lock task before it can discover a wrong password; undo that (best effort).
    if (before && before.mode !== 'boot') {
      try {
        removeLockTask({ execFileSync: exec, tmpdir, platform });
      } catch (err) {
        console.error(`Autologon: pengunci layar sisa tidak bisa dilepas: ${err?.message ?? err}`);
      }
    }
    throw autologonError(detail || WRONG_PASSWORD_MESSAGE, 'wrongPassword');
  }
  if (exit === EXIT.notAdmin) throw autologonError(detail || 'Izin Administrator dibutuhkan untuk menyalakan autologon.', 'notAdmin');
  if (exit === EXIT.registry) {
    // M3: one honest sentence; I4's detail is appended only when the child had a more specific reason.
    throw autologonError(detail && detail !== LOCK_FAILED_MESSAGE ? `${LOCK_FAILED_MESSAGE} (${detail})` : LOCK_FAILED_MESSAGE, 'registry');
  }
  if (exit !== EXIT.ok) throw autologonError(`Autologon gagal (kode ${code ?? 'tidak ada'}).`, 'registry');

  // M8: trust Windows, not the exit code: autologon ON and the lock task really installed (`reg query` + `schtasks`
  // are read-only and need no elevation).
  const after = statusOf();
  if (!(after?.autologon === 'on' && after?.mode === 'boot' && !after.unsafeDesktop)) {
    throw autologonError('Autologon belum aktif atau pengunci layar belum terpasang menurut Windows. Coba lagi dari Setelan.', 'unverified');
  }
  return { ok: true, verified: true };
}

/**
 * Everything the CLI decides before it waits for anything: the flags, the platform, the password file, the account
 * (S1), and the arguments the elevated copy gets. Returns `{ code }` when the run is already over.
 *
 * Shared by `helperMain` (promise) and `helperMainSync` (blocking, for server.js): every rule lives here once, and
 * only the UAC wait differs.
 *
 * `--user`/`--domain` are re-checked against this session's account (S1): they become DefaultUserName and
 * DefaultDomainName, so anything else than the user who is logged in now is refused with exit 1 before any UAC.
 */
function planHelper(argv, options = {}) {
  const args = argv.map(String);
  const enable = args.includes('--autologon-enable');
  const disable = args.includes('--autologon-disable');
  if (enable === disable) {
    throw new Error('helperMain: gunakan tepat satu dari --autologon-enable atau --autologon-disable.');
  }
  const platform = options.platform ?? process.platform;
  const tmpdir = options.tmpdir ?? os.tmpdir();
  // I4: the parent may ask for a one-line report; anything outside the per-user temp folder is ignored.
  const requestedResult = clean(flagValue(args, '--result-file'));
  const resultFile = requestedResult && isOwnResultFile(requestedResult, tmpdir) ? requestedResult : null;
  const fail = (message) => ({ code: EXIT.failed, message, resultFile });

  if (platform !== 'win32') {
    console.error('Autologon hanya tersedia di Windows.');
    return fail('Autologon hanya tersedia di Windows.');
  }

  const exec = options.execFileSync ?? execFileSync;
  const spawn = options.spawn ?? spawnProcess;
  const removeFile = options.removeFile ?? rmSync;
  const timeoutMs = options.timeoutMs ?? PROCESS_TIMEOUT_MS;
  // I3: argv (or an inherited environment) may not choose which code runs as Administrator; only this app's own
  // folder is accepted, and the elevated copy always resolves it from its own location.
  const appDir = trustedAppDir(flagValue(args, '--app-dir')) ?? ownAppDir();
  const port = numberOr(flagValue(args, '--port'), 4317);

  // The temp file is the only input: refuse anything that is not one of ours in the per-user temp folder, so a
  // malformed request cannot make this (Administrator) process read or delete somebody else's file.
  const passwordFile = clean(flagValue(args, '--password-file'));
  // The parent's own %TEMP%: needed when the elevated copy runs under a DIFFERENT account (cross-account UAC).
  const passwordDir = clean(flagValue(args, '--password-dir'));
  if (enable && !isOwnSecretFile(passwordFile, tmpdir, passwordDir)) {
    console.error('Autologon: file sandi sementara tidak valid.');
    return fail('File sandi sementara tidak valid.');
  }

  // S1: --user/--domain decide WHO Windows logs in as. Whoever can start this CLI must not be able to point the
  // autologon at another account (one UAC click is not consent for that): only this session's account is accepted.
  let real;
  try {
    real = options.account ?? windowsAccount();
  } catch (err) {
    console.error(`Autologon: ${err?.message ?? err}`);
    if (enable) removeSecret(passwordFile, removeFile);
    return fail(err?.message ?? 'Nama akun Windows tidak diketahui.');
  }

  // I6: only ENABLING needs the S1 check. Disabling clears whatever is there and logs nobody in, so a machine whose
  // account cannot be read (or a stale --user/--domain) must still be able to turn the autologon off.
  let user = real.user;
  let domain = real.domain;
  if (enable) {
    const wanted = {
      user: clean(flagValue(args, '--user')) || real.user,
      domain: clean(flagValue(args, '--domain')) || real.domain,
    };
    const microsoft = wanted.domain.toLowerCase() === 'microsoftaccount';
    // `whoami /upn` is only asked for a Microsoft account: a local account never has one.
    const realUpn = microsoft ? clean(options.upn ?? upnOf(exec)) : '';
    if (!accountMatches(wanted, real, realUpn)) {
      console.error('Autologon: akun Windows di argumen bukan akun yang sedang login. Dibatalkan.');
      removeSecret(passwordFile, removeFile);
      return fail('Akun Windows di argumen bukan akun yang sedang login. Dibatalkan.');
    }
    user = wanted.user;
    domain = wanted.domain;
  }

  // C2: the lock task is verified against the SID of the account that will log in. Prefer the SID the parent passed
  // (it runs as that account); `whoami /user` is the fallback for a direct CLI call. A supplied value that is not a
  // SID is refused instead of silently replaced: falling back to this (elevated, possibly another admin) session's
  // identity is the cross-account mistake C2 exists to catch.
  const requestedSid = clean(flagValue(args, '--account-sid'));
  if (enable && requestedSid && !SID_PATTERN.test(requestedSid)) {
    console.error('Autologon: SID akun di argumen tidak valid. Dibatalkan.');
    removeSecret(passwordFile, removeFile);
    return fail('SID akun di argumen tidak valid.');
  }
  const accountSid = enable ? (requestedSid || sidOf(exec)) : '';

  const selfArgs = [
    enable ? '--autologon-enable' : '--autologon-disable',
    ...(enable ? ['--password-file', passwordFile] : []),
    // Where that file lives, so an elevated copy under another administrator's account still accepts (and deletes) it.
    ...(enable && passwordFile ? ['--password-dir', path.dirname(path.resolve(passwordFile))] : []),
    ...(enable && accountSid ? ['--account-sid', accountSid] : []),
    ...(resultFile ? ['--result-file', resultFile] : []),
    '--user', user,
    '--domain', domain,
    // The elevated copy resolves its own folder (I3); the flag is only there for older copies and for readability.
    '--app-dir', appDir,
    '--port', String(port),
    '--elevated',
  ];
  const elevated = options.elevated ?? (args.includes('--elevated') || isElevated(exec));
  return {
    enable, appDir, port, passwordFile, resultFile, user, domain, accountSid, selfArgs, elevated, exec, removeFile, tmpdir, timeoutMs, spawn,
  };
}

/**
 * The elevated entry point, called by server.js BEFORE the server starts (like `--background`):
 *   Adhitron.exe --autologon-enable --password-file <file> --user <u> --domain <d> [--account-sid <SID>] [--app-dir] [--port]
 *   Adhitron.exe --autologon-disable [--app-dir]
 *
 * Returns the exit code; it never calls `process.exit` (server.js does). When it is not already elevated it
 * re-launches itself through UAC once (`--elevated` marks that copy, so a wrong detection cannot loop) and always
 * deletes the password file afterwards, cancelled prompt included (S5).
 *
 * @param {string[]} [argv]     Defaults to process.argv.
 * @param {object} [options]    Injection seams for tests: execFileSync, spawn, platform, tmpdir, startupDir (the
 *                              folder the 1.0.33 lock leftovers are cleaned from), elevated (skip the `net session`),
 *                              account/upn (the real account, for the S1 check), timeoutMs, removeFile (rmSync).
 * @returns {Promise<number>}   0, 3, 4, 5 or 6 as documented in EXIT (1 = unexpected).
 */
export async function helperMain(argv = process.argv, options = {}) {
  const plan = planHelper(argv, options);
  if ('code' in plan) {
    writeResult(plan.resultFile, plan.code, plan.message);
    return plan.code;
  }
  if (!plan.elevated) return awaitElevation(plan);
  return runElevated(plan, options);
}

/**
 * The same entry point, BLOCKING: server.js uses this one so the Windows build keeps compiling.
 * scripts/build-windows.mjs bundles server.js to CommonJS (`format: 'cjs'`), where esbuild refuses a top-level
 * `await`; the UAC wait therefore has to happen inside `execFileSync` instead of a promise. Everything else —
 * validation, the S1 account check, the S5 cleanup, the script, the exit codes — is the shared code above, not a copy.
 *
 * @param {string[]} [argv]     Defaults to process.argv.
 * @param {object} [options]    Same seams as `helperMain`.
 * @returns {number}            The exit code (0, 3, 4, 5 or 6; 1 = unexpected).
 */
export function helperMainSync(argv = process.argv, options = {}) {
  const plan = planHelper(argv, options);
  if ('code' in plan) {
    writeResult(plan.resultFile, plan.code, plan.message);
    return plan.code;
  }
  if (!plan.elevated) return syncElevation(plan, options);
  return runElevated(plan, options);
}

/** Not elevated yet (`helperMain`): one UAC prompt, the elevated copy's exit code, and S5's cleanup either way. */
async function awaitElevation(plan) {
  let code = EXIT.failed;
  try {
    const outcome = await elevate(plan.spawn, { appDir: plan.appDir, args: plan.selfArgs, timeoutMs: plan.timeoutMs });
    code = normalizeExit(outcome.timedOut ? null : outcome.code);
    writeResult(plan.resultFile, code, outcome.timedOut ? 'Permintaan izin Administrator tidak dijawab.' : String(outcome.stderr ?? ''));
  } catch (err) {
    console.error(`Autologon: tidak bisa meminta izin Administrator: ${err?.message ?? err}`);
    writeResult(plan.resultFile, code, err?.message);
  } finally {
    // S5: the elevated copy needs the file; once it has exited (or the prompt was cancelled) it must not survive.
    if (plan.enable) removeSecret(plan.passwordFile, plan.removeFile);
  }
  return code;
}

/** The same, blocking (`helperMainSync`): `execFileSync` waits for PowerShell, which waits for the elevated copy. */
function syncElevation(plan, options) {
  let code = EXIT.failed;
  try {
    const outcome = elevateSync({ appDir: plan.appDir, args: plan.selfArgs, timeoutMs: plan.timeoutMs }, options);
    code = normalizeExit(outcome.timedOut ? null : outcome.code);
    writeResult(plan.resultFile, code, outcome.timedOut ? 'Permintaan izin Administrator tidak dijawab.' : String(outcome.stderr ?? ''));
  } catch (err) {
    console.error(`Autologon: tidak bisa meminta izin Administrator: ${err?.message ?? err}`);
    writeResult(plan.resultFile, code, err?.message);
  } finally {
    if (plan.enable) removeSecret(plan.passwordFile, plan.removeFile);
  }
  return code;
}

/** Everything an elevated helper does, already synchronous (see `planHelper` for the shared decisions). */
function elevatedWork(plan, options) {
  const { enable, user, domain, port, tmpdir, exec, removeFile, passwordFile, resultFile, accountSid } = plan;
  if (enable) {
    // C2: the task must belong to the account Windows will log in as — the helper passes the S1-checked account.
    try {
      installLockTask(port, { execFileSync: exec, tmpdir, startupDir: options.startupDir, account: { user, domain } });
    } catch (err) {
      console.error(`Autologon: ${err?.message ?? err}`);
      writeResult(resultFile, EXIT.registry, LOCK_FAILED_MESSAGE);
      return EXIT.registry;
    }
    // C2: and the owner is VERIFIED before the registry changes; a task belonging to another administrator means
    // no lock at boot, which must never be sold as success.
    if (!lockTaskBelongsTo(exec, { user, domain, sid: accountSid })) {
      // Fail closed AND leave nothing behind: an unverified lock would lock the screen 15 s after every logon while
      // the registry stays untouched. Removing it is only safe when the registry provably does NOT log anybody in:
      // with AutoAdminLogon already on, dropping the lock is exactly the open desktop this module exists to prevent.
      // `'unknown'` (reg missing, policy, odd PATH) therefore keeps the task - only an explicit 'off' removes it.
      let autologon = 'unknown';
      try {
        autologon = autostartStatus({
          execFileSync: exec, startupDir: options.startupDir, platform: options.platform,
        }).autologon;
      } catch {
        // autostartStatus does not throw, but a broken seam here must not remove the lock: keep 'unknown'.
      }
      if (autologon === 'off') {
        try {
          removeLockTask({
            execFileSync: exec, tmpdir, startupDir: options.startupDir, platform: options.platform,
          });
        } catch (err) {
          console.error(`Autologon: pengunci layar sisa tidak bisa dilepas: ${err?.message ?? err}`);
        }
      }
      writeResult(resultFile, EXIT.registry, LOCK_FAILED_MESSAGE);
      return EXIT.registry;
    }
  }
  // M5: a 128-bit random name, so another process of the same user cannot swap the script before `-File` reads it.
  const scriptFile = path.join(tmpdir, `${SECRET_PREFIX}${randomBytes(16).toString('hex')}.ps1`);
  try {
    writeFileSync(scriptFile, enable ? winlogonScript() : disableWinlogonScript(), { encoding: 'utf8', mode: 0o600 });
    const scriptArgs = enable ? ['-PasswordFile', passwordFile, '-User', user, '-Domain', domain] : [];
    const outcome = runPowerShell(exec, scriptFile, scriptArgs);
    writeResult(resultFile, outcome.code, outcome.detail);
    return outcome.code;
  } finally {
    removeSecret(scriptFile, removeFile);
  }
}

/** The elevated half, with the password file removed on EVERY path (wrong password, lock refused, crash). */
function runElevated(plan, options = {}) {
  try {
    return elevatedWork(plan, options);
  } catch (err) {
    console.error(`Autologon: ${err?.message ?? err}`);
    writeResult(plan.resultFile, EXIT.failed, err?.message);
    return EXIT.failed;
  } finally {
    // Belt and braces: the script already removed it before writing the registry.
    if (plan.enable) removeSecret(plan.passwordFile, plan.removeFile);
  }
}

/** Runs the fixed script elevated (this process is the elevated one): `{ code, detail }`, detail in one line. */
function runPowerShell(exec, scriptFile, scriptArgs) {
  try {
    exec(POWERSHELL, [...PS_FLAGS, '-File', scriptFile, ...scriptArgs], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: EXIT.ok, detail: '' };
  } catch (err) {
    const detail = oneLine(String(err?.stderr ?? '').split(/\r?\n/)[0] ?? '');
    if (detail) console.error(`Autologon: ${detail}`);
    return { code: exitCodeOf(err), detail };
  }
}

/** `net session` needs the Administrators group: the same probe the .cmd scripts used (`net session >nul`). */
function isElevated(exec) {
  try {
    exec('net', ['session'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * `...\AppData\Local\Temp` for some user: the one place the password file may live, whoever created it.
 */
function isPerUserTempDir(dir) {
  return /[\\/]AppData[\\/]Local[\\/]Temp$/i.test(dir);
}

/**
 * The password file must be a regular file this module created, inside the per-user temp folder.
 *
 * Cross-account elevation is the reason for `passwordDir`: a standard user who approves the UAC prompt with ANOTHER
 * administrator's credentials gives that elevated copy a different `%TEMP%`, so the file the installer (or the
 * non-elevated copy) just wrote would look foreign. The parent declares its own temp directory with `--password-dir`,
 * and only a per-user `AppData\Local\Temp` is accepted — never a folder of the caller's choosing. Nothing is gained
 * by forking that file: `LogonUser` still has to accept the password for THIS session's account (S1).
 */
function isOwnSecretFile(file, tmpdir, passwordDir = '') {
  if (!file) return false;
  try {
    const dir = path.dirname(path.resolve(file));
    if (!SECRET_PATTERN.test(path.basename(file)) || !statSync(file).isFile()) return false;
    if (dir === path.resolve(tmpdir)) return true;
    return Boolean(passwordDir) && dir === path.resolve(passwordDir) && isPerUserTempDir(dir);
  } catch {
    return false;
  }
}

/**
 * Cleans up the password/result files a crashed Setup wizard or a refused delete left in `%TEMP%`. Windows keeps the
 * user's password inside those files, so a leftover is a privacy problem, not just clutter. Only names this module
 * itself writes are touched, only when they are older than `maxAgeMs` (a live helper's file is still in use), and a
 * file that cannot be removed is left for the next start instead of failing the server.
 *
 * @returns {number} How many files were removed.
 */
export function sweepLeftoverSecrets(tmpdir = os.tmpdir(), { now = Date.now(), maxAgeMs = 60 * 60_000, remove = rmSync } = {}) {
  let names;
  try {
    names = readdirSync(tmpdir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!SECRET_PATTERN.test(name) && !RESULT_PATTERN.test(name)) continue;
    const file = path.join(tmpdir, name);
    try {
      if (now - statSync(file).mtimeMs < maxAgeMs) continue;
      remove(file, { force: true });
      removed += 1;
    } catch {
      // Still open (a helper mid-write) or held by an antivirus: try again on the next start.
    }
  }
  return removed;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number < 65536 ? number : fallback;
}
