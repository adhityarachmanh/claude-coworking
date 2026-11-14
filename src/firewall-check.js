// 🧱 Firewall Tailscale (Windows only): can a paired phone actually reach TCP 4317 (HTTP) + 4318 (HTTPS)?
//
// The installer task (installer/Adhitron.iss) and the 📱 dialog's 🔧 button run the SAME fixed elevated
// command, built here — single source of truth; test/firewall-check.test.mjs keeps the .iss byte-for-byte
// in sync. The command is fixed: no user input reaches it, so there is no injection surface.
//
// Design notes:
// - ONE UAC prompt: the outer (non-admin) PowerShell calls `Start-Process powershell -Verb RunAs -Wait`
//   once; the elevated PowerShell runs both netsh commands (add the new rule, delete only the legacy one).
// - The elevated payload travels as base64 (`-EncodedCommand`, UTF-16LE — the same trick scripts/setup.mjs
//   already uses): base64 contains no quotes or spaces, so the string survives the Inno → PowerShell →
//   Start-Process → PowerShell layers untouched.
// - The detector is read-only (`Get-Net*Firewall*` cmdlets need no Administrator) and never throws: any
//   failure is "unknown" (`covered: null`), and the banner must not nag on unknown.

import { execFile } from 'node:child_process';

/** The rule this app installs (NEW name on purpose — never reuse the legacy one). */
export const FIREWALL_RULE_NAME = 'Adhitron (Tailscale)';
/** Pre-rename id that older installs (setup.cmd) still use; only ever deleted, never recreated. */
export const LEGACY_FIREWALL_RULE_NAME = 'Claude Coworking (Tailscale)';
/** TCP ports the phone needs: HTTP + HTTPS (src/tls.js DEFAULT_HTTPS_PORT). */
export const FIREWALL_PORTS = [4317, 4318];
/** Tailscale's CGNAT range: the only source addresses the rule lets in. */
export const TAILSCALE_REMOTE_IP = '100.64.0.0/10';

/** How long the 🔧 route waits for the UAC prompt + the elevated fix before giving up (the user may hesitate). */
export const FIREWALL_FIX_TIMEOUT_MS = 180_000;

/** The elevated payload: add the new rule, delete ONLY the legacy rule (exact name, nothing broader). Fixed. */
export function firewallFixScript() {
  const add = `netsh advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow protocol=TCP localport=${FIREWALL_PORTS.join(',')} remoteip=${TAILSCALE_REMOTE_IP} profile=private`;
  const del = `netsh advfirewall firewall delete rule name="${LEGACY_FIREWALL_RULE_NAME}"`;
  return `${add}; ${del}`;
}

/** The outer, non-admin command: one elevated PowerShell (one UAC prompt) that runs the fixed payload. Fixed. */
export function elevatedFirewallFixCommand() {
  const encoded = Buffer.from(firewallFixScript(), 'utf16le').toString('base64');
  return `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`;
}

/** Arguments for spawning Windows PowerShell so it runs the fix (the 🔧 route; tests inject a fake instead). */
export function firewallFixArgs() {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', elevatedFirewallFixCommand()];
}

/** The installer's [Run] Parameters value: the same line, unquoted after -Command (it contains no `"` at all). */
export function installerFirewallParameters() {
  return firewallFixArgs().join(' ');
}

/** What the user can type manually (PowerShell as Administrator) when the one-click fix does not go through. */
export function manualFirewallCommand() {
  return firewallFixScript();
}

/** Windows PowerShell 5.1 — present on every supported Windows, no .NET/PowerShell 7 dependency. */
export function powershellPath(env = process.env) {
  return `${env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * The read-only detector (no admin needed): an inbound Allow rule, Private/Any profile, from the Tailscale
 * range, that covers BOTH ports (possibly two different rules). LocalPort 'Any' covers every port.
 */
export function firewallCheckScript() {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$legacy = [bool](Get-NetFirewallRule -DisplayName '${LEGACY_FIREWALL_RULE_NAME}')
$c17 = $false
$c18 = $false
$rules = Get-NetFirewallPortFilter | Where-Object { ($_.Protocol -eq 'TCP') -and (($_.LocalPort -contains '4317') -or ($_.LocalPort -contains '4318') -or (($_.LocalPort -join ',') -eq 'Any')) } | Get-NetFirewallRule | Where-Object { ($_.Enabled -eq 'True') -and ($_.Direction -eq 'Inbound') -and ($_.Action -eq 'Allow') -and ($_.Profile -match 'Private|Any') }
foreach ($r in $rules) {
  $addr = $r | Get-NetFirewallAddressFilter
  if ($addr.RemoteAddress -notcontains '${TAILSCALE_REMOTE_IP}') { continue }
  $p = $r | Get-NetFirewallPortFilter
  if (($p.LocalPort -contains '4317') -or (($p.LocalPort -join ',') -eq 'Any')) { $c17 = $true }
  if (($p.LocalPort -contains '4318') -or (($p.LocalPort -join ',') -eq 'Any')) { $c18 = $true }
}
[pscustomobject]@{ covered = [bool]($c17 -and $c18); p4317 = [bool]$c17; p4318 = [bool]$c18; legacy = [bool]$legacy } | ConvertTo-Json -Compress
`.trim();
}

/**
 * Parses the detector's stdout. Pure. Unknown output / no JSON line / malformed JSON → covered: null
 * (never an assumed false — a "maybe" must not produce a nagging banner).
 * @returns {{ platforms: 'windows', covered: boolean|null, legacyRule: boolean }}
 */
export function parseFirewallCheck(stdout) {
  const line = String(stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'))
    .pop();
  if (!line) return { platforms: 'windows', covered: null, legacyRule: false };
  try {
    const j = JSON.parse(line);
    return { platforms: 'windows', covered: typeof j.covered === 'boolean' ? j.covered : null, legacyRule: j.legacy === true };
  } catch {
    return { platforms: 'windows', covered: null, legacyRule: false };
  }
}

const execPowerShell = (script, timeoutMs) =>
  new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    execFile(powershellPath(), args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout ?? '')));
  });

/** Runs the elevated fix through Windows PowerShell (its own -Command layer, no cmd.exe). Fixed string only. */
const execFirewallFix = (timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(powershellPath(), firewallFixArgs(), { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout ?? '')));
  });

/**
 * The read-only check for the 🔧 route. Never throws; every failure is `covered: null`.
 * Non-Windows: no check at all (and no banner).
 * @returns {{ platforms: 'windows'|'other', covered: boolean|null, legacyRule: boolean }}
 */
export async function checkFirewallRules(exec = execPowerShell, platform = process.platform) {
  if (platform !== 'win32') return { platforms: 'other', covered: null, legacyRule: false };
  try {
    return parseFirewallCheck(await exec(firewallCheckScript(), 15_000));
  } catch {
    return { platforms: 'windows', covered: null, legacyRule: false };
  }
}

/**
 * Runs the SAME fixed elevated command the installer task runs — only ever after an explicit click (the 🔧
 * button; fail-closed, never automatic). Waits for the elevated PowerShell (`-Wait`), then the route re-checks.
 * @returns {{ platforms: 'other' } | { platforms: 'windows', ok: boolean, reason?: 'declined'|'timeout'|'error' }}
 */
export async function runFirewallFix(exec = execFirewallFix, platform = process.platform, timeoutMs = FIREWALL_FIX_TIMEOUT_MS) {
  if (platform !== 'win32') return { platforms: 'other' };
  try {
    await exec(elevatedFirewallFixCommand(), timeoutMs);
    return { platforms: 'windows', ok: true };
  } catch (err) {
    return { platforms: 'windows', ok: false, reason: err?.killed ? 'timeout' : 'declined' };
  }
}
