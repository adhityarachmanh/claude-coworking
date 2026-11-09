// Windows auto-start, two layers:
//   1. a hidden launcher in the Startup folder — runs at login;
//   2. a per-user Task Scheduler watchdog every 5 minutes — restarts the server after
//      sleep/hibernate/Fast Startup (where the Startup folder may not run) or a crash.
// The launcher first checks /health, so when the server is up it does nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUPPORTED = process.platform === 'win32';
const STARTUP_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
// The app was called "Claude Coworking" before it became Adhitron. These ids are already
// installed on people's machines, so they keep the old name: renaming them would orphan installs.
const LAUNCHER = path.join(STARTUP_DIR, 'claude-coworking.vbs');
const TASK = 'Claude Coworking';

function taskExists() {
  try {
    execFileSync('schtasks', ['/Query', '/TN', TASK], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function autostartStatus() {
  if (!SUPPORTED) return { supported: false, enabled: false, watchdog: false, path: null };
  return { supported: true, enabled: existsSync(LAUNCHER), watchdog: taskExists(), path: LAUNCHER };
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

/** Task Scheduler definition: every 5 minutes, also on battery, never overlapping. */
function watchdogXml() {
  const start = new Date(Date.now() + 60_000).toISOString().slice(0, 19);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
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
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"${esc(LAUNCHER)}"</Arguments></Exec></Actions>
</Task>`;
}

export function setAutostart(enabled, appDir, port = 4317) {
  if (!SUPPORTED) return autostartStatus();
  if (!enabled) {
    if (existsSync(LAUNCHER)) unlinkSync(LAUNCHER);
    if (taskExists()) execFileSync('schtasks', ['/Delete', '/F', '/TN', TASK], { stdio: 'ignore', windowsHide: true });
    return autostartStatus();
  }
  mkdirSync(STARTUP_DIR, { recursive: true });
  writeFileSync(LAUNCHER, launcherScript(appDir, port), 'utf8');
  // schtasks /XML wants a UTF-16 file with a byte-order mark.
  const xmlFile = path.join(os.tmpdir(), `claude-coworking-task-${process.pid}.xml`);
  writeFileSync(xmlFile, `﻿${watchdogXml()}`, 'utf16le');
  try {
    execFileSync('schtasks', ['/Create', '/F', '/TN', TASK, '/XML', xmlFile], { stdio: 'ignore', windowsHide: true });
  } finally {
    rmSync(xmlFile, { force: true });
  }
  return autostartStatus();
}
