/* global document, window, location, history, navigator -- functions passed to page.eval run in the browser */
// 📱 Notifikasi HP (Web Push), client side: public/sw.js, core/push-rules.js, core/push-client.js, features/push.js.
// The real https Tailscale origin can't run here, so:
//   - sw.js runs in a Node vm with a stubbed `self` / `clients` / `fetch` (its handlers are plain globals);
//   - push-client.js gets stubbed navigator.serviceWorker / PushManager / Notification and a fake API;
//   - the DOM parts (deep link, the 🔔 section on http, no service worker on http) run in headless Chrome
//     against the real server on http://localhost (skipped when no browser is found).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createPushClient } from '../public/js/core/push-client.js';
import {
  answeredByText,
  approvalMessageId,
  b64urlToBytes,
  httpsHint,
  isIos,
  parseDeepLink,
  pushAvailability,
  pushSettings,
  pushStatusText,
  stripDeepLink,
} from '../public/js/core/push-rules.js';
import { cleanNotifySettings } from '../public/js/core/notify-rules.js';
import { cdpUnavailableReason, launchBrowser } from '../test-support/cdp.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW_SOURCE = readFileSync(path.join(APP, 'public', 'sw.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Values made inside the vm are from another realm: compare them as plain JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---------- the service worker in a vm ----------

/** Loads sw.js with stubs; returns the captured listeners and every call the worker made. */
function loadSw({ fetchImpl, windows = [] } = {}) {
  const calls = { shown: [], closed: [], fetches: [], opened: [], posted: [], focused: 0, skipWaiting: 0, claim: 0 };
  const listeners = {};
  const shown = []; // notifications currently "on screen"
  const registration = {
    async showNotification(title, options) {
      calls.shown.push({ title, options });
      shown.push({ title, data: options.data, tag: options.tag, close() { calls.closed.push(this); } });
    },
    async getNotifications({ tag } = {}) {
      return shown.filter((n) => !tag || n.tag === tag);
    },
  };
  const clients = {
    async matchAll() {
      return windows.map((url) => ({
        url,
        postMessage: (m) => calls.posted.push(m),
        focus: async () => void calls.focused++,
      }));
    },
    async openWindow(url) {
      calls.opened.push(url);
      return null;
    },
    async claim() {
      calls.claim++;
    },
  };
  const self = {
    location: { origin: 'https://laptop.tail.ts.net:4318' },
    registration,
    clients,
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting: async () => void calls.skipWaiting++,
  };
  const fetch = async (url, init) => {
    calls.fetches.push({ url, init });
    if (!fetchImpl) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return fetchImpl(url, init);
  };
  const ctx = vm.createContext({ self, clients, fetch, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, JSON, console });
  vm.runInContext(SW_SOURCE, ctx, { filename: 'sw.js' });
  return { ctx, listeners, calls, shown };
}

/** Fires an event at a captured listener and waits for what it passed to waitUntil. */
async function dispatch(listener, event) {
  let work = Promise.resolve();
  listener({ ...event, waitUntil: (p) => (work = p) });
  return work;
}

const pushEvent = (payload) => ({ data: { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) } });

const ASK = { type: 'ask', project: 'p1', projectName: 'toko', role: 'Backend', label: 'Bash', approvalId: 'a1', t: 'tok-123', allowAllowed: true };

describe('sw.js: push → notification', () => {
  test('ask with an action token and Izinkan allowed: [Izinkan, Tolak], per-project tag, renotify, deep link', async () => {
    const { listeners, calls } = loadSw();
    await dispatch(listeners.push, pushEvent(ASK));
    assert.equal(calls.shown.length, 1);
    const { title, options } = calls.shown[0];
    assert.equal(title, '✋ toko: Backend minta izin — Bash');
    assert.deepEqual(plain(options.actions.map((a) => [a.action, a.title])), [['allow', 'Izinkan'], ['deny', 'Tolak']]);
    assert.equal(options.tag, 'ask:p1');
    assert.equal(options.renotify, true);
    assert.equal(options.icon, '/icons/icon-192.png');
    assert.equal(options.badge, '/icons/icon-192.png');
    assert.equal(options.data.url, '/?p=p1&ap=a1');
    assert.equal(options.data.t, 'tok-123');
  });

  test('Izinkan not allowed on the lock screen: only [Tolak]; no token: no buttons', async () => {
    const { listeners, calls } = loadSw();
    await dispatch(listeners.push, pushEvent({ ...ASK, allowAllowed: false }));
    await dispatch(listeners.push, pushEvent({ ...ASK, t: undefined }));
    await dispatch(listeners.push, pushEvent({ ...ASK, t: undefined, allowAllowed: true })); // no token: never actions
    assert.deepEqual(plain(calls.shown[0].options.actions.map((a) => a.action)), ['deny']);
    assert.equal(calls.shown[0].options.body, 'Buka app untuk melihat perintahnya', 'Bash etc.: no Izinkan, look first');
    assert.equal(calls.shown[1].options.body, 'Ketuk untuk melihat detail');
    assert.deepEqual(plain(calls.shown[1].options.actions), []);
    assert.deepEqual(plain(calls.shown[2].options.actions), []);
  });

  test('done / error / queue: no buttons, own topic per project, no renotify', async () => {
    const { listeners, calls } = loadSw();
    for (const type of ['done', 'error', 'queue']) await dispatch(listeners.push, pushEvent({ type, project: 'p1', projectName: 'toko', role: 'Backend', t: 'x', allowAllowed: true }));
    assert.deepEqual(calls.shown.map((n) => n.title), ['✓ toko: tugas selesai', '■ toko: tugas berhenti', '⏸ toko: antrian dijeda']);
    assert.deepEqual(calls.shown.map((n) => n.options.tag), ['done:p1', 'error:p1', 'queue:p1']);
    for (const n of calls.shown) {
      assert.deepEqual(plain(n.options.actions), []);
      assert.equal(n.options.renotify, false);
      assert.equal(n.options.data.url, '/?p=p1');
    }
  });

  test('answered: closes that approval\'s notification silently (not a newer one of the same project)', async () => {
    const { listeners, calls } = loadSw();
    await dispatch(listeners.push, pushEvent(ASK));
    await dispatch(listeners.push, pushEvent({ type: 'answered', project: 'p1', approvalId: 'other' }));
    assert.equal(calls.closed.length, 0, 'another approval: kept');
    await dispatch(listeners.push, pushEvent({ type: 'answered', project: 'p1', approvalId: 'a1' }));
    assert.equal(calls.closed.length, 1);
    assert.equal(calls.shown.length, 1, 'nothing new shown');
  });

  test('test push: the server text; silent honoured; other types never take a server title', async () => {
    const { listeners, calls } = loadSw();
    await dispatch(listeners.push, pushEvent({ type: 'test', project: '', title: '🔔 Tes notifikasi', body: 'Notifikasi dari Adhit Office berfungsi.', silent: false }));
    await dispatch(listeners.push, pushEvent({ ...ASK, type: 'done', title: 'spoof', silent: true }));
    assert.equal(calls.shown[0].title, '🔔 Tes notifikasi');
    assert.equal(calls.shown[0].options.body, 'Notifikasi dari Adhit Office berfungsi.');
    assert.equal(calls.shown[0].options.silent, false);
    assert.equal(calls.shown[0].options.data.url, '/');
    assert.equal(calls.shown[1].title, '✓ toko: tugas selesai');
    assert.equal(calls.shown[1].options.silent, true);
  });

  test('an unreadable payload still shows a notification (browsers punish silent pushes)', async () => {
    const { listeners, calls } = loadSw();
    await dispatch(listeners.push, { data: { json: () => { throw new SyntaxError('bad'); } } });
    await dispatch(listeners.push, { data: null });
    assert.equal(calls.shown.length, 2);
  });

  test('long / odd strings are capped; the type is whitelisted', async () => {
    const { listeners, calls } = loadSw();
    await dispatch(listeners.push, pushEvent({ ...ASK, projectName: 'x'.repeat(100), label: 'Bash\n\n$ rm -rf /'.padEnd(200, 'y'), type: 'evil' }));
    const { title } = calls.shown[0];
    assert.ok(title.length < 120, title);
    assert.ok(!title.includes('\n'));
    assert.match(title, /^✓ /, 'unknown type falls back to a plain "done" notification');
  });
});

describe('sw.js: notificationclick', () => {
  const click = (action, data) => {
    const n = { data, closed: false, close() { this.closed = true; } };
    return { notification: n, action };
  };
  const dataOf = async (payload) => {
    const { listeners, calls } = loadSw();
    await dispatch(listeners.push, pushEvent(payload));
    return calls.shown[0].options.data;
  };

  test('Izinkan → POST /api/push/act {t, a: allow} with credentials, no x-office-token; closes, opens nothing', async () => {
    const data = await dataOf(ASK);
    const { listeners, calls } = loadSw();
    const ev = click('allow', data);
    await dispatch(listeners.notificationclick, ev);
    assert.equal(ev.notification.closed, true);
    assert.equal(calls.fetches.length, 1);
    const { url, init } = calls.fetches[0];
    assert.equal(url, '/api/push/act');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'include');
    assert.deepEqual(JSON.parse(init.body), { t: 'tok-123', a: 'allow' });
    assert.ok(!Object.keys(init.headers).some((h) => h.toLowerCase() === 'x-office-token'));
    assert.deepEqual(calls.opened, []);
  });

  test('Tolak → a: deny', async () => {
    const data = await dataOf(ASK);
    const { listeners, calls } = loadSw();
    await dispatch(listeners.notificationclick, click('deny', data));
    assert.deepEqual(JSON.parse(calls.fetches[0].init.body), { t: 'tok-123', a: 'deny' });
    assert.deepEqual(calls.opened, []);
  });

  test('the server refuses (401/409/410) → opens the app at the deep link', async () => {
    for (const status of [401, 409, 410]) {
      const data = await dataOf(ASK);
      const { listeners, calls } = loadSw({ fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }) });
      await dispatch(listeners.notificationclick, click('allow', data));
      assert.deepEqual(calls.opened, ['/?p=p1&ap=a1'], `status ${status}`);
    }
  });

  test('offline (fetch throws: Tailscale off, laptop asleep) → opens the app at the deep link', async () => {
    const data = await dataOf(ASK);
    const { listeners, calls } = loadSw({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await dispatch(listeners.notificationclick, click('deny', data));
    assert.deepEqual(calls.opened, ['/?p=p1&ap=a1']);
  });

  test('a plain tap: an open tab is focused and told which card; no tab → opens the deep link; no fetch', async () => {
    const data = await dataOf(ASK);
    const withTab = loadSw({ windows: ['https://laptop.tail.ts.net:4318/#p1'] });
    await dispatch(withTab.listeners.notificationclick, click('', data));
    assert.deepEqual(plain(withTab.calls.posted), [{ type: 'office-open', project: 'p1', approvalId: 'a1' }]);
    assert.equal(withTab.calls.focused, 1);
    assert.deepEqual(withTab.calls.opened, []);
    assert.equal(withTab.calls.fetches.length, 0);

    const noTab = loadSw({ windows: ['https://elsewhere.example/'] }); // another origin's window: never used
    await dispatch(noTab.listeners.notificationclick, click('', data));
    assert.deepEqual(noTab.calls.opened, ['/?p=p1&ap=a1']);
    assert.deepEqual(noTab.calls.posted, []);
  });

  test('an action button without a token (stale notification) just opens the app', async () => {
    const data = await dataOf({ ...ASK, t: undefined });
    const { listeners, calls } = loadSw();
    await dispatch(listeners.notificationclick, click('allow', data));
    assert.equal(calls.fetches.length, 0);
    assert.deepEqual(calls.opened, ['/?p=p1&ap=a1']);
  });
});

describe('sw.js: lifecycle', () => {
  test('no fetch handler (no cache); skipWaiting on install, clients.claim on activate; a version constant', async () => {
    const { ctx, listeners, calls } = loadSw();
    assert.equal(listeners.fetch, undefined, 'never intercepts requests');
    assert.doesNotMatch(SW_SOURCE, /caches\.|addEventListener\(\s*['"]fetch/);
    listeners.install({});
    await dispatch(listeners.activate, {});
    assert.equal(calls.skipWaiting, 1);
    assert.equal(calls.claim, 1);
    assert.match(String(vm.runInContext('SW_VERSION', ctx)), /\S/);
  });
});

// ---------- pure rules ----------

const ENV = {
  protocol: 'https:',
  secure: true,
  local: false,
  readOnly: false,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: 'default',
  ios: false,
  standalone: false,
};

describe('push-rules', () => {
  test('availability: laptop, http (WiFi read-only and Tailscale-http), iOS, unsupported, denied, ready', () => {
    assert.equal(pushAvailability({ ...ENV, local: true }), 'laptop');
    assert.equal(pushAvailability({ ...ENV, protocol: 'http:', secure: false, readOnly: true }), 'http');
    assert.equal(pushAvailability({ ...ENV, protocol: 'http:', secure: false }), 'http');
    assert.equal(pushAvailability({ ...ENV, ios: true, hasPushManager: false }), 'ios-install');
    assert.equal(pushAvailability({ ...ENV, ios: true, standalone: true }), 'ready');
    assert.equal(pushAvailability({ ...ENV, hasPushManager: false }), 'unsupported');
    assert.equal(pushAvailability({ ...ENV, permission: 'denied' }), 'denied');
    assert.equal(pushAvailability(ENV), 'ready');
  });

  test('status texts (Indonesian), iOS asks for the home screen', () => {
    assert.match(pushStatusText('ios-install'), /Tambahkan ke Layar Utama dulu/);
    assert.match(pushStatusText('denied'), /Ditolak browser/);
    assert.match(pushStatusText('unsupported'), /Tidak didukung/);
    assert.equal(pushStatusText('ready', true), 'Aktif di HP ini.');
    assert.equal(pushStatusText('ready', false), 'Belum aktif di HP ini.');
  });

  test('isIos: iPhone, iPadOS (Mac + touch), not a real Mac / Android', () => {
    assert.equal(isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }), true);
    assert.equal(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }), true);
    assert.equal(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }), false);
    assert.equal(isIos({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), false);
  });

  test('https hint: the url from config.remote.https.url, or a fallback without one', () => {
    assert.deepEqual(httpsHint('https://arh-3.taild0f8a1.ts.net:4318'), { text: 'Buka lewat', url: 'https://arh-3.taild0f8a1.ts.net:4318', after: '(Tailscale) untuk notifikasi push.' });
    for (const bad of [null, '', 'http://x:4318', 'javascript:alert(1)', 'https://x/<script>']) {
      const h = httpsHint(bad);
      assert.equal(h.url, '', String(bad));
      assert.match(h.text, /HTTPS Tailscale/);
    }
  });

  test('settings: same shape as the 🔔 dialog + favourites, tz offset, lock-screen switch; 🔔 off = nothing', () => {
    const notify = cleanNotifySettings({ events: { done: { popup: false, sound: true } }, quiet: { enabled: true, from: '23:00', to: '06:30', allowAsk: false }, favoritesOnly: true });
    const s = pushSettings(notify, { on: true, favorites: ['b', 'a', 'a', '', 7], tzOffsetMin: 420, tz: 'Asia/Jakarta', lockscreenAllow: false });
    assert.deepEqual(s.events, { ask: { popup: true, sound: true }, done: { popup: false, sound: true }, error: { popup: true, sound: true }, queue: { popup: false, sound: false } });
    assert.deepEqual(s.quiet, { enabled: true, from: '23:00', to: '06:30', allowAsk: false });
    assert.equal(s.favoritesOnly, true);
    assert.deepEqual(s.favorites, ['a', 'b']);
    assert.deepEqual(pushSettings(cleanNotifySettings({ muted: { p1: true, p2: false } })).muted, { p1: true }, '🔇 ikut terkirim');
    assert.equal(s.tzOffsetMin, 420);
    assert.equal(s.tz, 'Asia/Jakarta');
    assert.equal(s.lockscreenAllow, false);
    assert.equal(s.enabled, true);
    assert.equal(pushSettings(notify).lockscreenAllow, true, 'Izinkan on the lock screen: on by default');
    assert.ok(Object.hasOwn(pushSettings(null), 'lockscreenAllow'), 'always sent explicitly (server is fail-closed)');
    const off = pushSettings(notify, { on: false });
    assert.equal(off.enabled, false);
    for (const k of ['ask', 'done', 'error']) assert.deepEqual(off.events[k], { popup: false, sound: false });
  });

  test('deep link: parse, strip (keeps the rest), find the card', () => {
    assert.deepEqual(parseDeepLink('?p=abc&ap=ap-1'), { project: 'abc', approvalId: 'ap-1' });
    assert.deepEqual(parseDeepLink('?p=abc'), { project: 'abc', approvalId: '' });
    assert.equal(parseDeepLink('?ap=x'), null);
    assert.equal(parseDeepLink(''), null);
    assert.equal(stripDeepLink('https://h:4318/?p=abc&ap=1&x=2#abc'), '/?x=2#abc');
    assert.equal(stripDeepLink('https://h:4318/?p=abc&ap=1'), '/');
    const chat = [{ id: 1, approvalId: 'a' }, { id: 2 }, { id: 3, approvalId: 'b' }];
    assert.equal(approvalMessageId(chat, 'b'), 3);
    assert.equal(approvalMessageId(chat, 'zzz'), null);
    assert.equal(approvalMessageId(undefined, 'b'), null);
  });

  test('laptop toast text for an approval answered from a phone notification', () => {
    assert.equal(answeredByText({ status: 'allowed', answeredBy: { via: 'push', device: 'Android · Chrome' } }), 'Diizinkan dari HP (Android · Chrome) lewat notifikasi.');
    assert.equal(answeredByText({ status: 'denied', answeredBy: { via: 'push' } }), 'Ditolak dari HP lewat notifikasi.', 'WiFi: no device name');
    assert.equal(answeredByText({ status: 'allowed', answeredBy: { via: 'web' } }), null);
    assert.equal(answeredByText({ status: 'allowed' }), null);
    assert.equal(answeredByText({ status: 'pending', answeredBy: { via: 'push' } }), null);
  });

  test('b64url VAPID key → bytes', () => {
    const raw = Buffer.from([4, ...Array.from({ length: 64 }, (_, i) => i * 3)]);
    assert.deepEqual([...b64urlToBytes(raw.toString('base64url'))], [...raw]);
  });
});

// ---------- push-client with stubbed browser APIs ----------

const VAPID = Buffer.from([4, ...Array.from({ length: 64 }, (_, i) => 255 - i)]).toString('base64url');

function fakeBrowser({ env = {}, permission = 'default', grant = 'granted', existing = null, failPost = {} } = {}) {
  const log = { register: [], posts: [], subscribe: [], unsubscribed: 0, asked: 0 };
  let current = existing;
  const makeSub = (key) => ({
    options: { applicationServerKey: key },
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => {
      log.unsubscribed++;
      current = null;
      return true;
    },
  });
  if (existing === 'other-key') current = makeSub(new Uint8Array([4, 1, 2, 3]).buffer);
  if (existing === 'same-key') current = makeSub(b64urlToBytes(VAPID).buffer);
  const pushManager = {
    getSubscription: async () => current,
    subscribe: async (opts) => {
      log.subscribe.push(opts);
      current = makeSub(opts.applicationServerKey.buffer);
      return current;
    },
  };
  const Notification = {
    permission,
    requestPermission: async () => {
      log.asked++;
      Notification.permission = grant;
      return grant;
    },
  };
  const serviceWorker = {
    register: async (url, opts) => {
      log.register.push([url, opts]);
      return { pushManager };
    },
  };
  const settings = { enabled: true, marker: 'settings' };
  const client = createPushClient({
    env: () => ({ ...ENV, permission: Notification.permission, ...env }),
    serviceWorker,
    Notification,
    post: async (p, body) => {
      log.posts.push([p, body]);
      if (failPost[p]) throw Object.assign(new Error(failPost[p]), { status: 500 });
      if (p === '/api/push/vapid') return { publicKey: VAPID };
      return { ok: true };
    },
    settings: () => settings,
  });
  return { client, log, Notification };
}

describe('push-client (stubbed navigator.serviceWorker / PushManager / Notification)', () => {
  test('http page (WiFi read-only or Tailscale-http): no service worker, no permission prompt, no /api/push call', async () => {
    for (const env of [{ protocol: 'http:', secure: false, readOnly: true }, { protocol: 'http:', secure: false }, { local: true }]) {
      const { client, log } = fakeBrowser({ env });
      assert.equal(client.register(), null);
      assert.deepEqual(await client.enable(), { ok: false, reason: client.availability() });
      assert.equal(await client.syncSettings(), false);
      assert.equal(await client.resync(), false);
      assert.deepEqual(log.register, []);
      assert.deepEqual(log.posts, []);
      assert.equal(log.asked, 0);
    }
  });

  test('iOS Safari tab: no prompt, reason ios-install', async () => {
    const { client, log } = fakeBrowser({ env: { ios: true, standalone: false, hasPushManager: false } });
    assert.deepEqual(await client.enable(), { ok: false, reason: 'ios-install' });
    assert.equal(log.asked, 0);
  });

  test('Aktifkan: permission → VAPID key → subscribe(userVisibleOnly, key) → POST subscribe {subscription, settings}', async () => {
    const { client, log } = fakeBrowser();
    assert.deepEqual(await client.enable(), { ok: true });
    assert.equal(log.asked, 1);
    assert.deepEqual(log.register, [['/sw.js', { scope: '/', updateViaCache: 'none' }]]);
    assert.equal(log.subscribe.length, 1);
    assert.equal(log.subscribe[0].userVisibleOnly, true);
    assert.deepEqual([...log.subscribe[0].applicationServerKey], [...b64urlToBytes(VAPID)]);
    assert.deepEqual(log.posts.map(([p]) => p), ['/api/push/vapid', '/api/push/subscribe']);
    assert.deepEqual(log.posts[1][1], { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } }, settings: { enabled: true, marker: 'settings' } });
    assert.equal(client.isActive(), true);
    assert.equal(await client.subscribed(), true);
  });

  test('permission refused: nothing subscribed, nothing sent', async () => {
    const { client, log } = fakeBrowser({ grant: 'denied' });
    assert.deepEqual(await client.enable(), { ok: false, reason: 'denied' });
    assert.deepEqual(log.posts, []);
    assert.equal(log.subscribe.length, 0);
    const dismissed = fakeBrowser({ grant: 'default' });
    assert.deepEqual(await dismissed.client.enable(), { ok: false, reason: 'dismissed' });
  });

  test('blocked in the browser: Aktifkan does not prompt', async () => {
    const { client, log } = fakeBrowser({ permission: 'denied' });
    assert.equal(client.availability(), 'denied');
    assert.deepEqual(await client.enable(), { ok: false, reason: 'denied' });
    assert.equal(log.asked, 0);
  });

  test('an old subscription made with another VAPID key is renewed; the same key is reused', async () => {
    const other = fakeBrowser({ permission: 'granted', existing: 'other-key' });
    await other.client.enable();
    assert.equal(other.log.unsubscribed, 1);
    assert.equal(other.log.subscribe.length, 1);
    const same = fakeBrowser({ permission: 'granted', existing: 'same-key' });
    await same.client.enable();
    assert.equal(same.log.unsubscribed, 0);
    assert.equal(same.log.subscribe.length, 0);
    assert.equal(same.log.asked, 0, 'already granted: no prompt');
  });

  test('settings sync: POST /api/push/settings {settings} only while subscribed', async () => {
    const none = fakeBrowser({ permission: 'granted' });
    assert.equal(await none.client.syncSettings(), false);
    assert.deepEqual(none.log.posts, []);
    const { client, log } = fakeBrowser({ permission: 'granted', existing: 'same-key' });
    assert.equal(await client.syncSettings(), true);
    assert.deepEqual(log.posts, [['/api/push/settings', { settings: { enabled: true, marker: 'settings' } }]]);
  });

  test('resync on open: the existing subscription is sent again; never prompts', async () => {
    const { client, log } = fakeBrowser({ permission: 'granted', existing: 'same-key' });
    assert.equal(await client.resync(), true);
    assert.deepEqual(log.posts.map(([p]) => p), ['/api/push/subscribe']);
    const fresh = fakeBrowser();
    assert.equal(await fresh.client.resync(), false);
    assert.equal(fresh.log.asked, 0);
  });

  test('Matikan: server unsubscribe + browser unsubscribe; a server error still unsubscribes here', async () => {
    const { client, log } = fakeBrowser({ permission: 'granted', existing: 'same-key' });
    await client.disable();
    assert.deepEqual(log.posts.map(([p]) => p), ['/api/push/unsubscribe']);
    assert.equal(log.unsubscribed, 1);
    assert.equal(client.isActive(), false);
    const failing = fakeBrowser({ permission: 'granted', existing: 'same-key', failPost: { '/api/push/unsubscribe': 'boom' } });
    await assert.rejects(failing.client.disable(), /boom/);
    assert.equal(failing.log.unsubscribed, 1);
  });

  test('visibility report (anti-double) only from a subscribed device', async () => {
    const none = fakeBrowser();
    assert.equal(await none.client.reportVisible('tab1', true), false);
    assert.deepEqual(none.log.posts, []);
    const { client, log } = fakeBrowser({ permission: 'granted', existing: 'same-key' });
    await client.subscribed();
    assert.equal(await client.reportVisible('tab1', false), true);
    assert.deepEqual(log.posts, [['/api/push/visible', { tab: 'tab1', visible: false }]]);
  });

  test('Kirim tes → POST /api/push/test', async () => {
    const { client, log } = fakeBrowser({ permission: 'granted', existing: 'same-key' });
    await client.sendTest();
    assert.deepEqual(log.posts, [['/api/push/test', {}]]);
  });
});

describe('manifest: installable PWA on the https origin', () => {
  test('id/start_url/scope "/", standalone, 192 + 512 PNG icons that exist', () => {
    const manifest = JSON.parse(readFileSync(path.join(APP, 'public', 'manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.id, '/');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    for (const size of ['192x192', '512x512']) {
      const icon = manifest.icons.find((i) => i.sizes === size && i.type === 'image/png');
      assert.ok(icon, size);
      readFileSync(path.join(APP, 'public', icon.src)); // throws when missing
    }
  });
});

// ---------- in the browser (real server on http://localhost) ----------

const SKIP = cdpUnavailableReason();

describe('push UI in the browser (http://localhost)', { skip: SKIP ?? false }, () => {
  let TMP;
  let BASE;
  let server;
  let browser;
  let page;
  let projectId;

  const freePort = () =>
    new Promise((resolve, reject) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });

  before(async () => {
    TMP = mkdtempSync(path.join(tmpdir(), 'office-push-'));
    mkdirSync(path.join(TMP, 'projects', 'toko', 'src'), { recursive: true });
    writeFileSync(path.join(TMP, 'projects', 'toko', 'src', 'a.ts'), 'export {};\n');
    mkdirSync(path.join(TMP, 'claude-projects'));
    const port = await freePort();
    BASE = `http://localhost:${port}`;
    server = spawn(process.execPath, [path.join(APP, 'server.js')], {
      windowsHide: true,
      env: {
        ...process.env,
        OFFICE_PORT: String(port),
        OFFICE_DATA_DIR: path.join(TMP, 'data'),
        OFFICE_TAILSCALE_BIN: path.join(TMP, 'no-tailscale.exe'),
        PROJECTS_ROOT: path.join(TMP, 'projects'),
        CLAUDE_BIN: path.join(APP, 'test-support', 'fake-claude.mjs'),
        CLAUDE_PROJECTS_DIR: path.join(TMP, 'claude-projects'),
        CLAUDE_CONFIG_FILE: path.join(TMP, 'no-such-claude.json'),
        CLAUDE_CONFIG_DIR: path.join(TMP, 'claude-config'),
        OFFICE_OPEN_DRY_RUN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.resume();
    // Bounded: the server says it runs, exits, or 20 s pass.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server tidak start dalam 20 detik')), 20_000);
      server.stdout.on('data', (d) => String(d).includes('berjalan di') && (clearTimeout(timer), resolve()));
      server.on('exit', (code) => (clearTimeout(timer), reject(new Error(`server exited ${code}`))));
    });
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, mobile: true });
    await page.goto(`${BASE}/`);
    await page.waitFor(() => document.querySelector('#conn')?.classList.contains('ok') && document.querySelector('#crumb')?.textContent.trim(), { timeoutMs: 15000, message: 'app terhubung' });
    projectId = await page.eval(async () => (await import('/js/core/state.js')).state.projects.find((p) => p.name === 'toko')?.id);
    assert.ok(projectId, 'project toko');
  });

  after(async () => {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (server && server.exitCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill();
      await Promise.race([exited, sleep(3000)]);
    }
    for (let i = 0; i < 10 && TMP; i++) {
      try {
        rmSync(TMP, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  });

  test('http: no service worker registered, the laptop sees no push section', async () => {
    const r = await page.eval(async () => {
      const { openNotifySettings } = await import('/js/features/notify.js');
      openNotifySettings();
      await new Promise((res) => setTimeout(res, 100));
      const out = {
        registrations: (await navigator.serviceWorker.getRegistrations()).length,
        sectionHidden: document.querySelector('#ns-push').hidden,
      };
      document.querySelector('#notify-modal').hidden = true;
      return out;
    });
    assert.deepEqual(r, { registrations: 0, sectionHidden: true });
  });

  test('a phone on http (WiFi read-only): the https hint with config.remote.https.url, no buttons, no /api/push call', async () => {
    const r = await page.eval(async () => {
      const { state } = await import('/js/core/state.js');
      const { renderPushSection } = await import('/js/features/push.js');
      const saved = { local: state.local, readOnly: state.readOnly, config: state.config };
      const calls = [];
      const realFetch = window.fetch;
      window.fetch = (url, init) => (calls.push(String(url)), realFetch(url, init));
      try {
        Object.assign(state, { local: false, readOnly: true, config: { ...state.config, remote: { ...state.config?.remote, https: { state: 'ok', url: 'https://arh-3.taild0f8a1.ts.net:4318' } } } });
        await renderPushSection();
        const vis = (sel) => !document.querySelector(sel).hidden;
        return {
          section: vis('#ns-push'),
          hint: document.querySelector('#ns-push-hint').textContent,
          link: document.querySelector('#ns-push-hint a')?.getAttribute('href'),
          buttons: ['#ns-push-on', '#ns-push-test', '#ns-push-off', '#ns-push-lock-row', '#ns-push-status'].filter(vis),
          pushCalls: calls.filter((u) => u.includes('/api/push')),
          registrations: (await navigator.serviceWorker.getRegistrations()).length,
        };
      } finally {
        window.fetch = realFetch;
        Object.assign(state, saved);
        await renderPushSection();
      }
    });
    assert.equal(r.section, true);
    assert.match(r.hint, /Buka lewat https:\/\/arh-3\.taild0f8a1\.ts\.net:4318 \(Tailscale\) untuk notifikasi push/);
    assert.equal(r.link, 'https://arh-3.taild0f8a1.ts.net:4318');
    assert.deepEqual(r.buttons, []);
    assert.deepEqual(r.pushCalls, []);
    assert.equal(r.registrations, 0);
  });

  test('deep link ?p=&ap=: selects the project, shows the chat, focuses the approval card, cleans the URL', async () => {
    const r = await page.eval(async (pid) => {
      const { state, DEMO_ID } = await import('/js/core/state.js');
      const { selectProject } = await import('/js/features/picker.js');
      const { openDeepLink } = await import('/js/features/push.js');
      const { setMobileView } = await import('/js/ui/layout.js');
      selectProject(DEMO_ID);
      setMobileView('office');
      const approval = { id: 'push-ap-1', project: pid, status: 'pending', kind: 'tool', role: 'backend', tool: 'Bash', label: '$ ls', input: { command: 'ls' } };
      const msg = { id: 'push-msg-1', project: pid, ts: Date.now(), kind: 'approval', role: 'backend', approvalId: approval.id, text: '$ ls', status: 'pending' };
      state.approvals.set(approval.id, approval);
      (state.chats[pid] ??= []).push(msg);
      history.replaceState(null, '', `/?p=${encodeURIComponent(pid)}&ap=${approval.id}`);
      const ok = openDeepLink();
      const active = document.activeElement;
      const out = {
        ok,
        active: state.active,
        view: document.body.dataset.view,
        tab: document.body.dataset.tab,
        focused: active?.dataset?.id ?? null,
        flashed: active?.classList.contains('ap-focus') ?? false,
        search: location.search,
        again: openDeepLink(), // consumed: a reload must not jump again
      };
      state.approvals.delete(approval.id);
      state.chats[pid].splice(state.chats[pid].indexOf(msg), 1);
      return out;
    }, projectId);
    assert.deepEqual(r, { ok: true, active: projectId, view: 'panel', tab: 'chat', focused: 'push-msg-1', flashed: true, search: '', again: false });
  });

  test('laptop: an approval answered from a phone notification shows a toast (once, on the edge)', async () => {
    const r = await page.eval(async () => {
      const { onApprovalUpdate } = await import('/js/features/push.js');
      const toasts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent);
      const before = toasts().length;
      const answered = { id: 'x', status: 'allowed', answeredBy: { via: 'push', device: 'Android · Chrome' } };
      onApprovalUpdate({ id: 'x', status: 'pending' }, answered);
      onApprovalUpdate(answered, answered); // a repeat of the same state: no second toast
      return toasts().slice(before);
    });
    assert.deepEqual(r, ['Diizinkan dari HP (Android · Chrome) lewat notifikasi.']);
  });

  test('📱 dialog: HTTPS status and a 🔒 Tailscale (HTTPS) QR when the pairing response has one', async () => {
    const r = await page.eval(async () => {
      const { state } = await import('/js/core/state.js');
      const { httpsStatus } = await import('/js/features/phone.js');
      const ok = httpsStatus({ state: 'ok', host: 'arh-3.t.ts.net', url: 'https://arh-3.t.ts.net:4318', validTo: Date.UTC(2027, 0, 30), error: null });
      const disabled = httpsStatus({ state: 'certs-disabled', error: 'x' });
      const err = httpsStatus({ state: 'error', error: '<b>CLI gagal</b>' });
      return { ok, disabled, err, off: httpsStatus({ state: 'off' }), none: httpsStatus(null), local: state.local };
    });
    assert.equal(r.ok.tone, 'ok');
    assert.match(r.ok.html, /HTTPS aktif: <code>https:\/\/arh-3\.t\.ts\.net:4318<\/code> · berlaku s\/d 30/);
    assert.match(r.disabled.html, /HTTPS Certificates/);
    assert.doesNotMatch(r.err.html, /<b>CLI/, 'server text escaped');
    assert.match(r.err.html, /CLI gagal/);
    assert.equal(r.off, null);
    assert.equal(r.none, null);

    // The dialog itself, with a stubbed pairing response that carries the https QR (backend contract).
    const d = await page.eval(async () => {
      const { state } = await import('/js/core/state.js');
      const saved = state.config;
      const realFetch = window.fetch;
      const pairing = {
        code: '123456', expires: Date.now() + 120_000, ip: '192.168.1.5', url: 'http://192.168.1.5:4317', qrUrl: 'http://192.168.1.5:4317/pair?k=K',
        addresses: [{ ip: '192.168.1.5', kind: 'lan', name: 'Wi-Fi' }, { ip: '100.64.0.9', kind: 'tailscale', name: 'Tailscale' }],
        https: { url: 'https://arh-3.t.ts.net:4318', qrUrl: 'https://arh-3.t.ts.net:4318/pair?k=K' },
      };
      window.fetch = async (url, init) => (String(url).endsWith('/api/remote/pairing') ? new Response(JSON.stringify(pairing), { headers: { 'Content-Type': 'application/json' } }) : realFetch(url, init));
      const wait = async (fn) => {
        for (let i = 0; i < 50 && !fn(); i++) await new Promise((res) => setTimeout(res, 50));
        return fn();
      };
      try {
        state.config = { ...saved, remote: { enabled: true, urls: [], devices: [{ id: 'd1', name: 'Android · Chrome', created: Date.now(), lastSeen: Date.now(), transport: 'https', push: { since: Date.now(), lastOk: Date.now(), failing: false } }], tailscale: true, idleDays: 30, https: { state: 'ok', host: 'arh-3.t.ts.net', url: 'https://arh-3.t.ts.net:4318', validTo: Date.now() + 60 * 86_400_000, error: null } } };
        document.querySelector('#btn-phone').hidden = false;
        document.querySelector('#btn-phone').click();
        await wait(() => document.querySelector('#phone-body .addr-tabs'));
        const tabs = [...document.querySelectorAll('#phone-body .addr-tabs button')].map((b) => ({ text: b.textContent, active: b.classList.contains('active') }));
        const httpsOpen = document.querySelector('#phone-body .pair-info code')?.textContent;
        const mode = document.querySelector('#phone-body .access-mode')?.textContent;
        const status = document.querySelector('#phone-https .https-status')?.textContent;
        const badges = document.querySelector('#phone-body .devices li')?.textContent;
        document.querySelector('#phone-body [data-ip="100.64.0.9"]').click();
        await wait(() => document.querySelector('#phone-body .pair-info code')?.textContent.startsWith('http://'));
        const httpOpen = document.querySelector('#phone-body .pair-info code')?.textContent;
        return { tabs, httpsOpen, mode, status, badges, httpOpen };
      } finally {
        document.querySelector('#phone-close').click();
        window.fetch = realFetch;
        state.config = saved;
      }
    });
    assert.equal(d.tabs[0].text, '🔒 Tailscale (HTTPS)arh-3.t.ts.net:4318');
    assert.equal(d.tabs[0].active, true, 'HTTPS is the default when available');
    assert.equal(d.tabs.filter((t) => t.active).length, 1);
    assert.equal(d.httpsOpen, 'https://arh-3.t.ts.net:4318');
    assert.match(d.mode, /notifikasi push/);
    assert.match(d.status, /HTTPS aktif/);
    assert.match(d.status, /Periksa lagi/);
    assert.match(d.badges, /🔒 HTTPS/);
    assert.match(d.badges, /🔔 Push/);
    assert.equal(d.httpOpen, 'http://192.168.1.5:4317', 'another address: back to its http QR (stub returns the LAN one)');
  });
});
