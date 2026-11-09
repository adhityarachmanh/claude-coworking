// 🖥 Adhit Office Desktop: a thin Electron window over the existing local server. It never embeds or replaces the
// server; if 127.0.0.1:4317 is already healthy it just connects, otherwise it starts AdhitOffice.exe and waits.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, Menu, Tray } from 'electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = `http://127.0.0.1:${Number(process.env.OFFICE_PORT ?? 4317)}`;
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

let win = null;
let tray = null;
let quitting = false;

const iconPath = (name) => {
  const packaged = path.join(process.resourcesPath, name);
  return app.isPackaged ? packaged : path.join(ROOT, 'assets', name);
};

async function healthy(timeoutMs = 1200) {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** The installed server next to the Electron folder; in development, the repo's server.js via Node. */
function serverLaunch() {
  if (process.env.OFFICE_SERVER_BIN) return { command: process.env.OFFICE_SERVER_BIN, args: ['--background'] };
  if (!app.isPackaged) return { command: process.env.OFFICE_NODE_BIN ?? 'node', args: [path.join(ROOT, 'server.js'), '--background'] };
  const exe = isWin ? 'AdhitOffice.exe' : 'AdhitOffice';
  return { command: path.join(path.dirname(process.execPath), '..', exe), args: ['--background'] };
}

async function ensureServer() {
  if (await healthy()) return true;
  const { command, args } = serverLaunch();
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(command) });
    child.unref();
  } catch {
    // handled by the health wait below
  }
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await healthy()) return true;
  }
  return false;
}

async function api(pathname, body = {}) {
  const html = await (await fetch(`${BASE}/`, { signal: AbortSignal.timeout(3000) })).text();
  const token = /<meta name="office-token" content="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error('Token kantor tidak ditemukan.');
  const response = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office-Token': token, Origin: BASE },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return response.json().catch(() => ({}));
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  try {
    tray = new Tray(iconPath(isWin ? 'icon.ico' : 'icon.png'));
  } catch {
    return; // no tray: the window still works
  }
  tray.setToolTip('Adhit Office');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Buka kantor', click: showWindow },
    {
      label: 'Cek update',
      click: async () => {
        try {
          const view = await api('/api/app-update/check');
          const text = view?.mode === 'desktop'
            ? view.behind ? `Versi ${view.latestVersion} tersedia (terpasang ${view.currentVersion}).` : `Versi terbaru: ${view.currentVersion}.`
            : view?.behind ? `${view.behind} perubahan tersedia.` : 'Tidak ada update.';
          dialog.showMessageBox({ type: 'info', title: 'Cek update', message: text, buttons: ['OK'] });
        } catch (err) {
          dialog.showMessageBox({ type: 'warning', title: 'Cek update', message: String(err?.message ?? err), buttons: ['OK'] });
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Hentikan server',
      click: async () => {
        try {
          await api('/api/shutdown');
          dialog.showMessageBox({ type: 'info', title: 'Adhit Office', message: 'Server dihentikan. Jendela akan ditutup.', buttons: ['OK'] });
          app.quit();
        } catch (err) {
          dialog.showMessageBox({ type: 'warning', title: 'Adhit Office', message: `Server tidak bisa dihentikan: ${err?.message ?? err}`, buttons: ['OK'] });
        }
      },
    },
    {
      label: 'Keluar',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('double-click', showWindow);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#1d1f24',
    title: 'Adhit Office',
    icon: iconPath('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.removeMenu();
  win.loadURL(BASE);
  win.once('ready-to-show', showWindow);
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(BASE)) event.preventDefault();
  });
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    if (isMac) app.dock?.show?.();
    const ready = await ensureServer();
    if (!ready) {
      dialog.showMessageBoxSync({ type: 'error', title: 'Adhit Office', message: 'Server lokal tidak bisa dijalankan di 127.0.0.1:4317.\n\nJalankan Adhit Office dari menu Start, lalu coba lagi.', buttons: ['Keluar'] });
      app.quit();
      return;
    }
    createWindow();
    createTray();
    app.on('activate', showWindow);
    if (process.env.OFFICE_DESKTOP_TEST === '1') setTimeout(() => { quitting = true; app.quit(); }, 2500);
  }).catch((err) => {
    dialog.showMessageBoxSync({ type: 'error', title: 'Adhit Office', message: String(err?.message ?? err), buttons: ['Keluar'] });
    app.quit();
  });
  app.on('window-all-closed', () => {
    // Keep running in the tray: the local server is still available for the website/PWA.
  });
  app.on('before-quit', () => {
    quitting = true;
  });
}
