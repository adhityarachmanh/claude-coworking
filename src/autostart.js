// Windows auto-start: a hidden launcher script in the user's Startup folder.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUPPORTED = process.platform === 'win32';
const STARTUP_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const LAUNCHER = path.join(STARTUP_DIR, 'claude-coworking.vbs');

export function autostartStatus() {
  return { supported: SUPPORTED, enabled: SUPPORTED && existsSync(LAUNCHER), path: SUPPORTED ? LAUNCHER : null };
}

/** VBScript that runs `node server.js --background` with no window (logs go to data/server.log). */
export function launcherScript(appDir) {
  const q = (s) => s.replace(/"/g, '""'); // VBScript string escaping
  return [
    "' Claude Coworking: starts the office server at Windows login. Delete this file to stop.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${q(appDir)}"`,
    `sh.Run """${q(process.execPath)}"" ""${q(path.join(appDir, 'server.js'))}"" --background", 0, False`,
    '',
  ].join('\r\n');
}

export function setAutostart(enabled, appDir) {
  if (!SUPPORTED) return autostartStatus();
  if (!enabled) {
    if (existsSync(LAUNCHER)) unlinkSync(LAUNCHER);
    return autostartStatus();
  }
  mkdirSync(STARTUP_DIR, { recursive: true });
  writeFileSync(LAUNCHER, launcherScript(appDir), 'utf8');
  return autostartStatus();
}
