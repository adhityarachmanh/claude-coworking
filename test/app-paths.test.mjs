// src/app-paths.js: the folder layout a packaged app, a portable copy and a source checkout each use.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { appPaths } from '../src/app-paths.js';

const WIN = path.win32;
const POSIX = path.posix;

/** An `exists` predicate that only knows the paths listed (never touches the real disk). */
function existsOnly(...present) {
  const known = new Set(present);
  return (file) => known.has(file);
}

test('source checkout: data and runtime live in the app folder', () => {
  const appDir = WIN.join('C:\\', 'Apps', 'adhitron');
  const got = appPaths({
    appDir,
    env: {},
    platform: 'win32',
    exists: existsOnly(WIN.join(appDir, 'server.js'), WIN.join(appDir, 'public', 'index.html')),
  });
  assert.deepEqual(got, {
    packaged: false,
    portable: false,
    home: appDir,
    dataDir: WIN.join(appDir, 'data'),
    runtimeDir: WIN.join(appDir, 'runtime'),
  });
});

test('packaged Windows: data under %LOCALAPPDATA%/AdhitOffice, runtime beside it', () => {
  const appDir = WIN.join('C:\\', 'Program Files', 'Adhitron');
  const localAppData = WIN.join('C:\\', 'Users', 'ani', 'AppData', 'Local');
  const got = appPaths({
    appDir,
    env: { LOCALAPPDATA: localAppData, USERPROFILE: WIN.join('C:\\', 'Users', 'ani') },
    platform: 'win32',
    exists: existsOnly(WIN.join(appDir, 'public', 'index.html')),
  });
  assert.deepEqual(got, {
    packaged: true,
    portable: false,
    home: WIN.join(localAppData, 'AdhitOffice'),
    dataDir: WIN.join(localAppData, 'AdhitOffice', 'data'),
    runtimeDir: WIN.join(localAppData, 'AdhitOffice', 'runtime'),
  });
});

test('packaged Windows without LOCALAPPDATA falls back to the user profile', () => {
  const appDir = WIN.join('C:\\', 'Program Files', 'Adhitron');
  const userProfile = WIN.join('C:\\', 'Users', 'ani');
  const got = appPaths({
    appDir,
    env: { USERPROFILE: userProfile },
    platform: 'win32',
    exists: existsOnly(WIN.join(appDir, 'public', 'index.html')),
  });
  assert.equal(got.home, WIN.join(userProfile, 'AppData', 'Local', 'AdhitOffice'));
  assert.equal(got.dataDir, WIN.join(userProfile, 'AppData', 'Local', 'AdhitOffice', 'data'));
  assert.equal(got.runtimeDir, WIN.join(userProfile, 'AppData', 'Local', 'AdhitOffice', 'runtime'));
});

test('a portable marker next to the executable keeps everything in the app folder', () => {
  const appDir = WIN.join('C:\\', 'Usb', 'Adhitron');
  const got = appPaths({
    appDir,
    env: { LOCALAPPDATA: WIN.join('C:\\', 'Users', 'ani', 'AppData', 'Local') },
    platform: 'win32',
    exists: existsOnly(WIN.join(appDir, 'public', 'index.html'), WIN.join(appDir, 'portable')),
  });
  assert.equal(got.packaged, true);
  assert.equal(got.portable, true);
  assert.equal(got.home, appDir);
  assert.equal(got.dataDir, WIN.join(appDir, 'data'));
  assert.equal(got.runtimeDir, WIN.join(appDir, 'runtime'));
});

test('OFFICE_PORTABLE=1 is enough to be portable (source or packaged)', () => {
  const appDir = POSIX.join('/home', 'ani', 'adhitron');
  const got = appPaths({
    appDir,
    env: { OFFICE_PORTABLE: '1', HOME: '/home/ani' },
    platform: 'linux',
    exists: existsOnly(POSIX.join(appDir, 'server.js'), POSIX.join(appDir, 'public', 'index.html')),
  });
  assert.equal(got.packaged, false);
  assert.equal(got.portable, true);
  assert.equal(got.home, appDir);
  assert.equal(got.dataDir, POSIX.join(appDir, 'data'));
});

test('packaged macOS: Application Support/AdhitOffice', () => {
  const appDir = POSIX.join('/Applications', 'Adhitron.app', 'Contents', 'Resources', 'app');
  const home = '/Users/ani';
  const got = appPaths({
    appDir,
    env: { HOME: home },
    platform: 'darwin',
    exists: existsOnly(POSIX.join(appDir, 'public', 'index.html')),
  });
  assert.equal(got.packaged, true);
  assert.equal(got.portable, false);
  assert.equal(got.home, POSIX.join(home, 'Library', 'Application Support', 'AdhitOffice'));
  assert.equal(got.dataDir, POSIX.join(home, 'Library', 'Application Support', 'AdhitOffice', 'data'));
  assert.equal(got.runtimeDir, POSIX.join(home, 'Library', 'Application Support', 'AdhitOffice', 'runtime'));
});

test('packaged Linux: XDG_DATA_HOME (or ~/.local/share), folder adhit-office', () => {
  const appDir = POSIX.join('/opt', 'adhitron');
  const withXdg = appPaths({
    appDir,
    env: { HOME: '/home/ani', XDG_DATA_HOME: '/var/lib/ani' },
    platform: 'linux',
    exists: existsOnly(POSIX.join(appDir, 'public', 'index.html')),
  });
  assert.equal(withXdg.dataDir, '/var/lib/ani/adhit-office/data');
  assert.equal(withXdg.home, '/var/lib/ani/adhit-office');
  assert.equal(withXdg.runtimeDir, '/var/lib/ani/adhit-office/runtime');

  const fallback = appPaths({
    appDir,
    env: { HOME: '/home/ani' },
    platform: 'linux',
    exists: existsOnly(POSIX.join(appDir, 'public', 'index.html')),
  });
  assert.equal(fallback.dataDir, '/home/ani/.local/share/adhit-office/data');
  assert.equal(fallback.home, '/home/ani/.local/share/adhit-office');
});

test('OFFICE_DATA_DIR wins; packaged keeps home as its parent, source keeps the app folder', () => {
  const appDir = WIN.join('C:\\', 'Program Files', 'Adhitron');
  const localAppData = WIN.join('C:\\', 'Users', 'ani', 'AppData', 'Local');
  const override = WIN.join('C:\\', 'Temp', 'adhitron-test');

  const packaged = appPaths({
    appDir,
    env: { LOCALAPPDATA: localAppData, OFFICE_DATA_DIR: override },
    platform: 'win32',
    exists: existsOnly(WIN.join(appDir, 'public', 'index.html')),
  });
  assert.equal(packaged.dataDir, override);
  assert.equal(packaged.home, WIN.dirname(override));
  assert.equal(packaged.runtimeDir, WIN.join(WIN.dirname(override), 'runtime'));

  const sourceDir = WIN.join('C:\\', 'src', 'adhitron');
  const source = appPaths({
    appDir: sourceDir,
    env: { OFFICE_DATA_DIR: override },
    platform: 'win32',
    exists: existsOnly(WIN.join(sourceDir, 'server.js'), WIN.join(sourceDir, 'public', 'index.html')),
  });
  assert.equal(source.dataDir, override);
  assert.equal(source.home, sourceDir);
  assert.equal(source.runtimeDir, WIN.join(sourceDir, 'runtime'));
});

test('OFFICE_RUNTIME_DIR overrides the runtime folder everywhere', () => {
  const appDir = POSIX.join('/home', 'ani', 'adhitron');
  const got = appPaths({
    appDir,
    env: { HOME: '/home/ani', OFFICE_RUNTIME_DIR: '/mnt/fast/adhitron-runtime' },
    platform: 'linux',
    exists: existsOnly(POSIX.join(appDir, 'server.js'), POSIX.join(appDir, 'public', 'index.html')),
  });
  assert.equal(got.runtimeDir, '/mnt/fast/adhitron-runtime');
  assert.equal(got.dataDir, POSIX.join(appDir, 'data'));
});

test('packaged but portable ignores LOCALAPPDATA and OFFICE_DATA_DIR keeps app home', () => {
  const appDir = WIN.join('D:\\', 'Adhitron');
  const got = appPaths({
    appDir,
    env: { LOCALAPPDATA: WIN.join('C:\\', 'Users', 'ani', 'AppData', 'Local'), OFFICE_PORTABLE: '1', OFFICE_DATA_DIR: WIN.join('D:\\', 'state') },
    platform: 'win32',
    exists: existsOnly(WIN.join(appDir, 'public', 'index.html')),
  });
  assert.equal(got.packaged, true);
  assert.equal(got.portable, true);
  assert.equal(got.home, appDir);
  assert.equal(got.dataDir, WIN.join('D:\\', 'state'));
  assert.equal(got.runtimeDir, WIN.join(appDir, 'runtime'));
});
