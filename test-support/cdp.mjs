// Minimal Chrome DevTools Protocol client for UI smoke tests — no Playwright/Puppeteer, no dependencies.
// Launches a locally installed Chrome/Edge/Chromium headless and talks to it over Node's global WebSocket.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Path to a Chromium-family browser, or null. CHROME_PATH wins; then the usual install locations. */
export function findBrowser() {
  if (process.env.CHROME_PATH) return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  const candidates = [];
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      candidates.push(
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(root, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    // Linux: look the usual names up on PATH (GitHub's ubuntu runners ship google-chrome).
    const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const name of names) for (const dir of dirs) candidates.push(path.join(dir, name));
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Why CDP tests can't run here (for test.skip), or null when they can. */
export function cdpUnavailableReason() {
  if (typeof globalThis.WebSocket !== 'function') return `global WebSocket tidak ada di Node ${process.version} (butuh Node 22+)`;
  if (!findBrowser()) return 'Chrome/Edge/Chromium tidak ditemukan — set CHROME_PATH untuk menjalankan UI smoke test';
  return null;
}

/**
 * Starts the browser headless with a throwaway profile and connects to it.
 * Always call `close()` (in an after hook): it shuts the browser and removes the profile dir.
 */
export async function launchBrowser({ executable = findBrowser(), timeoutMs = 15000 } = {}) {
  if (typeof globalThis.WebSocket !== 'function') throw new Error(`global WebSocket tidak ada di Node ${process.version}`);
  if (!executable) throw new Error('browser tidak ditemukan (set CHROME_PATH)');
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'office-cdp-'));
  const proc = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--mute-audio',
      // Linux CI containers often lack the sandbox's kernel features.
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const cleanupDir = async () => {
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
        return;
      } catch {
        await sleep(200); // Windows: child processes may still hold files for a moment
      }
    }
  };
  let conn;
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`browser tidak membuka DevTools dalam ${timeoutMs}ms:\n${buf}`)), timeoutMs);
      proc.stderr.on('data', (d) => {
        buf += d;
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) (clearTimeout(timer), resolve(m[1]));
      });
      proc.on('error', (err) => (clearTimeout(timer), reject(err)));
      proc.on('exit', (code) => (clearTimeout(timer), reject(new Error(`browser keluar (${code}) sebelum siap:\n${buf}`))));
    });
    proc.stderr.resume(); // keep draining so the browser never blocks on a full pipe
    conn = await Connection.open(wsUrl);
  } catch (err) {
    // Never leak the browser or its profile when startup fails half-way.
    const gone = new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
    proc.kill('SIGKILL');
    await Promise.race([gone, sleep(3000)]);
    await cleanupDir();
    throw err;
  }
  const exited = new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
  return {
    executable,
    conn,
    newPage: () => Page.create(conn),
    async close() {
      try {
        await Promise.race([conn.send('Browser.close'), sleep(2000)]);
      } catch {
        // already gone
      }
      conn.close();
      await Promise.race([exited, sleep(3000)]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
      await Promise.race([exited, sleep(2000)]);
      await cleanupDir();
    },
  };
}

/** One WebSocket to the browser; page targets are flattened sessions on it. */
class Connection {
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`CDP WebSocket gagal: ${url}`)), { once: true });
    });
    return new Connection(ws);
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else {
        for (const fn of [...this.listeners]) fn(msg);
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(`CDP ditutup saat menunggu ${p.method}`));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  /** Subscribe to events ({ method, params, sessionId }); returns an unsubscribe function. */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

/** A tab: navigation, JS evaluation and trusted input (mouse, touch, keys). */
export class Page {
  static async create(conn) {
    const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(conn, targetId, sessionId);
    await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'].map((m) => page.send(m)));
    return page;
  }

  constructor(conn, targetId, sessionId) {
    Object.assign(this, { conn, targetId, sessionId, touch: false });
    /** Console errors, uncaught exceptions, HTTP >= 400 and failed loads seen since the last `clearProblems()`. */
    this.problems = [];
    const requests = new Map(); // requestId -> url, for loadingFailed (which carries no url)
    conn.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      const p = msg.params;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails;
        this.problems.push({ kind: 'exception', text: `${d.exception?.description ?? d.text} @ ${d.url ?? ''}:${d.lineNumber}` });
      } else if (msg.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) {
        this.problems.push({ kind: 'console', text: p.args.map((a) => a.value ?? a.description ?? '').join(' ') });
      } else if (msg.method === 'Log.entryAdded' && p.entry.level === 'error') {
        this.problems.push({ kind: `log:${p.entry.source}`, text: `${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}` });
      } else if (msg.method === 'Network.requestWillBeSent') {
        requests.set(p.requestId, p.request.url);
      } else if (msg.method === 'Network.responseReceived' && p.response.status >= 400) {
        // Chrome logs only some failed subresources to Log; the network layer sees them all.
        this.problems.push({ kind: 'http', text: `${p.response.status} ${p.response.url}` });
      } else if (msg.method === 'Network.loadingFailed' && !p.canceled) {
        // canceled = aborted by navigation (e.g. the /stream EventSource when leaving the page): not an error
        this.problems.push({ kind: 'network', text: `${p.errorText} ${requests.get(p.requestId) ?? p.requestId}` });
      }
    });
  }

  send(method, params) {
    return this.conn.send(method, params, this.sessionId);
  }

  clearProblems() {
    this.problems = [];
  }

  waitForEvent(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (off(), reject(new Error(`timeout menunggu ${method}`))), timeoutMs);
      const off = this.conn.on((msg) => {
        if (msg.sessionId === this.sessionId && msg.method === method) (clearTimeout(timer), off(), resolve(msg.params));
      });
    });
  }

  /** Mobile = touch + DPR 3 + mobile layout; desktop = plain viewport. */
  async setViewport({ width, height, mobile = false }) {
    this.touch = mobile;
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
    await this.send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  }

  /** Full navigation (a hash-only change fires no load event, so leave the document first). */
  async goto(url, timeoutMs = 15000) {
    const current = await this.eval('location.href');
    if (current !== 'about:blank' && current.split('#')[0] === url.split('#')[0]) await this.goto('about:blank', timeoutMs);
    const loaded = this.waitForEvent('Page.loadEventFired', timeoutMs);
    const { errorText } = await this.send('Page.navigate', { url });
    if (errorText) throw new Error(`navigasi gagal ${url}: ${errorText}`);
    await loaded;
  }

  /** Evaluates an expression (or `(${fn})(...args)`) in the page and returns its JSON value. */
  async eval(fnOrExpr, ...args) {
    const expression = typeof fnOrExpr === 'function' ? `(${fnOrExpr})(...${JSON.stringify(args)})` : fnOrExpr;
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (exceptionDetails) throw new Error(`eval gagal: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  }

  /** Polls `fn` in the page until it returns truthy. */
  async waitFor(fn, { timeoutMs = 5000, message = 'kondisi' } = {}, ...args) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.eval(fn, ...args);
      if (value) return value;
      if (Date.now() > end) throw new Error(`timeout menunggu ${message}`);
      await sleep(50);
    }
  }

  /** Trusted click (mouse) or tap (touch emulation) on the centre of the first match. */
  async click(selector) {
    const box = await this.eval((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }, selector);
    if (!box) throw new Error(`elemen tidak ada: ${selector}`);
    if (!box.w || !box.h) throw new Error(`elemen tidak terlihat: ${selector}`);
    if (this.touch) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    }
  }

  /** Trusted key press; the browser performs the default action (Tab moves focus, etc.). */
  async press(key, { shift = false } = {}) {
    const codes = { Tab: 9, Escape: 27, Enter: 13 };
    const params = { key, code: key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key], modifiers: shift ? 8 : 0 };
    // Enter must carry text so Chrome also emits keypress — that is what activates a focused <button>.
    const down = key === 'Enter' ? { type: 'keyDown', text: '\r', unmodifiedText: '\r' } : { type: 'rawKeyDown' };
    await this.send('Input.dispatchKeyEvent', { ...down, ...params });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  }

  /** PNG of the viewport (or a `clip` {x, y, width, height} in CSS px) as a Buffer. */
  async screenshot({ clip } = {}) {
    const params = { format: 'png', captureBeyondViewport: false };
    if (clip) params.clip = { ...clip, scale: 1 };
    const { data } = await this.send('Page.captureScreenshot', params);
    return Buffer.from(data, 'base64');
  }

  async close() {
    await this.conn.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}
