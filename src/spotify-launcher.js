// ♪ Spotify desktop app, started in the background on this laptop (docs/design-spotify.md §2.8) so ▶ works
// without the user opening Spotify first. Only finds and starts the app: waiting for its Connect device, the 30 s
// throttle and who may trigger it live in src/spotify.js. Everything that touches the OS is injected, so tests
// never start a real Spotify.
//
// Strategies, in order (Windows):
//   exe   %APPDATA%\Spotify\Spotify.exe --minimized   (classic installer; starts to the tray, no window)
//   store explorer.exe shell:AppsFolder\SpotifyAB.SpotifyMusic_<publisher>!Spotify   (Microsoft Store; takes no
//         arguments, so it may show a window: a fixed, hidden PowerShell then minimizes it, best effort, optional)
// macOS: `open -g -a Spotify` (-g: in the background). Linux and the rest: not supported (no launch).
// No shell anywhere: execFile with fixed arguments; the only variable part (the Store package name) is validated.
import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync as nodeExistsSync, readdirSync as nodeReaddirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A Store package folder / family name: SpotifyAB.SpotifyMusic_<13-char publisher id>. */
const STORE_FAMILY = /^SpotifyAB\.SpotifyMusic_[a-z0-9]{1,20}$/i;
const MINIMIZE_TIMEOUT_MS = 5000;

// Fixed script, no user input. Minimizes Spotify's visible main window(s) with SW_MINIMIZE (6): the next window
// (whatever the user was working in) gets the focus back. Errors are swallowed: it is a cosmetic extra.
const MINIMIZE_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Add-Type -Namespace AdhitOffice -Name Win -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);'",
  'Get-Process -Name Spotify | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void][AdhitOffice.Win]::ShowWindowAsync($_.MainWindowHandle, 6) }',
].join('; ');

/**
 * @param {object} [o]
 * @param {NodeJS.Platform} [o.platform]
 * @param {Record<string, string|undefined>} [o.env]
 * @param {string} [o.home]
 * @param {typeof nodeExecFile} [o.execFile]
 * @param {(p: string) => boolean} [o.existsSync]
 * @param {(p: string) => string[]} [o.readdirSync]
 * @param {boolean} [o.minimizeStoreWindow] Store version: minimize a window it shows anyway (default true)
 */
export function createSpotifyLauncher(o = {}) {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const home = o.home ?? os.homedir();
  const execFile = o.execFile ?? nodeExecFile;
  const exists = o.existsSync ?? nodeExistsSync;
  const readdir = o.readdirSync ?? ((p) => nodeReaddirSync(p));
  const minimizeStoreWindow = o.minimizeStoreWindow ?? true;
  const win = path.win32;

  /** Starts a program detached, hidden console, no shell; resolves once it started (or rejects: not found). */
  const start = (file, args) =>
    new Promise((resolve, reject) => {
      let child;
      try {
        child = execFile(file, args, { windowsHide: true, detached: true, stdio: 'ignore', shell: false });
      } catch (err) {
        return reject(err);
      }
      let done = false;
      child.once?.('error', (err) => !done && ((done = true), reject(err)));
      child.once?.('spawn', () => !done && ((done = true), child.unref?.(), resolve()));
      if (!child.once) resolve(); // a test double without events
    });

  /** Which strategy would apply on this machine (never starts anything). */
  function detect() {
    if (platform === 'win32') {
      const appData = env.APPDATA;
      if (appData) {
        const exe = win.join(appData, 'Spotify', 'Spotify.exe');
        if (exists(exe)) return { strategy: 'exe', target: exe };
      }
      const local = env.LOCALAPPDATA;
      if (local) {
        let names = [];
        try {
          names = readdir(win.join(local, 'Packages'));
        } catch {
          /* no Packages folder */
        }
        const family = names.find((n) => STORE_FAMILY.test(n));
        if (family) return { strategy: 'store', target: `${family}!Spotify` };
      }
      return { strategy: null, reason: 'no-app' };
    }
    if (platform === 'darwin') {
      const app = ['/Applications/Spotify.app', path.join(home, 'Applications', 'Spotify.app')].find((p) => exists(p));
      return app ? { strategy: 'mac', target: app } : { strategy: null, reason: 'no-app' };
    }
    return { strategy: null, reason: 'unsupported' };
  }

  /**
   * Starts Spotify in the background. Resolves { strategy } once the process started; rejects with
   * { code: 'no-app' | 'unsupported' } when there is nothing to start.
   */
  async function launch() {
    const d = detect();
    if (!d.strategy) throw Object.assign(new Error(d.reason), { code: d.reason });
    try {
      if (d.strategy === 'exe') await start(d.target, ['--minimized']);
      else if (d.strategy === 'store') {
        // explorer.exe hands the AUMID to the shell and exits (often with code 1): only a failed spawn counts.
        await start(win.join(env.SystemRoot || env.windir || 'C:\\Windows', 'explorer.exe'), [`shell:AppsFolder\\${d.target}`]);
      } else await start('open', ['-g', '-a', 'Spotify']);
    } catch {
      throw Object.assign(new Error('no-app'), { code: 'no-app' });
    }
    return { strategy: d.strategy };
  }

  /** Store version only (best effort, bounded, hidden): minimizes a Spotify window that showed up anyway. */
  function minimize(strategy) {
    if (platform !== 'win32' || strategy !== 'store' || !minimizeStoreWindow) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const ps = win.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const child = execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', MINIMIZE_SCRIPT], { windowsHide: true, timeout: MINIMIZE_TIMEOUT_MS, shell: false }, (err) => resolve(!err));
        child?.once?.('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  return { platform, detect, launch, minimize };
}
