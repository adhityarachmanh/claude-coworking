// Folder layout of a running instance. A source checkout keeps data next to the code; a packaged build keeps it
// in the user's profile (Program Files is not writable) unless it is portable. Deliberately pure: the caller passes
// the environment, platform and filesystem probe, so every combination can be tested without touching the disk.
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * @param {object} [options]
 * @param {string} [options.appDir] folder holding server.js/public (default: the current working directory)
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {(file: string) => boolean} [options.exists]
 * @returns {{ packaged: boolean, portable: boolean, home: string, dataDir: string, runtimeDir: string }}
 */
export function appPaths({ appDir = process.cwd(), env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dir = p.resolve(appDir);
  // Same signals as server.js: a packaged build bundles server.js into the executable, so only public/index.html
  // is left next to it. A `portable` file (or OFFICE_PORTABLE=1) keeps everything in the app folder.
  const packaged = !exists(p.join(dir, 'server.js')) && exists(p.join(dir, 'public', 'index.html'));
  const portable = env.OFFICE_PORTABLE === '1' || exists(p.join(dir, 'portable'));
  const userHome = env.USERPROFILE ?? env.HOME ?? dir;

  let dataDir;
  if (env.OFFICE_DATA_DIR) {
    // Tests and advanced users point the state file somewhere else (same override as server.js).
    dataDir = p.resolve(env.OFFICE_DATA_DIR);
  } else if (packaged && !portable) {
    if (platform === 'win32') dataDir = p.join(env.LOCALAPPDATA ?? p.join(userHome, 'AppData', 'Local'), 'AdhitOffice', 'data');
    else if (platform === 'darwin') dataDir = p.join(userHome, 'Library', 'Application Support', 'AdhitOffice', 'data');
    else dataDir = p.join(env.XDG_DATA_HOME ?? p.join(userHome, '.local', 'share'), 'adhit-office', 'data');
  } else {
    dataDir = p.join(dir, 'data');
  }

  // The setup runtime (Node + npm prefix) is a sibling of data, not part of the user's data folder.
  const home = packaged && !portable ? p.dirname(dataDir) : dir;
  const runtimeDir = env.OFFICE_RUNTIME_DIR ? p.resolve(env.OFFICE_RUNTIME_DIR) : p.join(home, 'runtime');
  return { packaged, portable, home, dataDir, runtimeDir };
}
