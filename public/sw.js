// Adhitron service worker: Web Push notifications only (docs/design-web-push.md §C, §D).
//
// - Registered only on the https (Tailscale) origin; the http listeners answer /sw.js with 404. Note: a 404 on an
//   update check does NOT unregister an installed worker (the spec keeps the registration). A real kill switch
//   would serve an sw.js whose install/activate calls self.registration.unregister().
// - One fetch handler, for page loads only: when the tunnel/laptop is unreachable a reload would otherwise end on the
//   browser's own error page. It answers with a small built-in "not connected" page — never a cached app shell, so no
//   stale token or data can be served. API calls, /stream and every other request never pass through here: still NO
//   Cache Storage anywhere.
// - Classic script (not a module SW) for older Firefox / iOS. The handlers are plain functions on the global
//   scope so test/push-ui.test.mjs can run this file in a Node vm with a stubbed `self`.
'use strict';

const SW_VERSION = '4'; // bump on every change: a byte-different sw.js is what makes browsers update it

const ICON = '/icons/icon-192.png';
const BADGE = '/icons/icon-192.png';
const ACT_TIMEOUT_MS = 8000; // the laptop may be asleep or Tailscale off: never hang the click handler

const PUSH_TYPES = ['ask', 'answered', 'done', 'error', 'queue', 'test', 'pairing', 'paired'];
// Types whose title/body text is built by the server (Indonesian, like the rest) instead of here.
const SERVER_TEXT_TYPES = ['test', 'pairing', 'paired'];

/** Text from the payload, trimmed and capped (it ends up on the lock screen). */
function text(value, max) {
  const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The decrypted push payload → a clean object (anything unexpected becomes a harmless default). */
function parsePayload(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    type: PUSH_TYPES.includes(p.type) ? p.type : 'done',
    project: text(p.project, 200),
    projectName: text(p.projectName, 40) || 'project',
    role: text(p.role, 40) || 'Tim',
    label: text(p.label, 60),
    started: p.started === true,
    approvalId: text(p.approvalId, 200),
    t: typeof p.t === 'string' && p.t.length <= 200 ? p.t : '',
    allowAllowed: p.allowAllowed === true,
    silent: p.silent === true, // quiet hours etc. are decided by the server; it may ask for no sound
    // Server-built text travels only for the whitelisted types above; every other title is built here from the fields.
    title: SERVER_TEXT_TYPES.includes(p.type) ? text(p.title, 80) : '',
    body: SERVER_TEXT_TYPES.includes(p.type) ? text(p.body, 120) : '',
  };
}

/** One notification per project and kind: a newer one replaces the older (the ask/answered pair shares one). */
function tagFor(p) {
  // Pairing pushes belong to no project: one fixed tag, so a new code/notice replaces the previous one.
  if (p.type === 'pairing') return 'pairing-code';
  if (p.type === 'paired') return 'device-paired';
  const topic = p.type === 'answered' ? 'ask' : p.type;
  return `${topic}:${p.project}`;
}

/** Where a tap opens the app: the project, and the approval card when there is one. */
function deepLink(p) {
  const params = new URLSearchParams();
  if (p.project) params.set('p', p.project);
  if (p.approvalId) params.set('ap', p.approvalId);
  const q = params.toString();
  return q ? `/?${q}` : '/';
}

/**
 * Title + options for showNotification (null for 'answered': that one only removes the ask).
 * Action buttons only with an action token; "Izinkan" only when the server allows it on this device
 * (setting "Tombol Izinkan di layar kunci"), otherwise just "Tolak".
 */
function buildNotification(p) {
  if (p.type === 'answered') return null;
  const titles = {
    ask: `✋ ${p.projectName}: ${p.role} minta izin${p.label ? ` — ${p.label}` : ''}`,
    done: `✓ ${p.projectName}: tugas selesai`,
    error: `■ ${p.projectName}: tugas berhenti`,
    queue: p.started ? `▶ ${p.projectName}: antrian mulai` : `⏸ ${p.projectName}: antrian dijeda`,
    test: p.title || '🔔 Tes notifikasi',
    pairing: p.title || '🔑 Kode pasangan baru',
    paired: p.title || '✅ Perangkat baru terpasang',
  };
  const bodies = {
    // Izinkan withheld (execution/network tool, or switched off on this device): look at it in the app first.
    ask: p.t && !p.allowAllowed ? 'Buka app untuk melihat perintahnya' : 'Ketuk untuk melihat detail',
    done: p.label ? `Tugas latar selesai — ${p.label}` : `${p.role} sudah menyelesaikan permintaanmu`,
    error: 'Ketuk untuk melihat di aplikasi',
    queue: p.started ? 'Item yang menunggu mulai berjalan' : 'Ketuk untuk melihat antrian',
    test: p.body || 'Notifikasi dari Adhitron berfungsi.',
    pairing: p.body || 'Ketik kodenya di halaman pasang.',
    paired: p.body || 'Perangkat itu kini bisa membuka kantor ini.',
  };
  const ask = p.type === 'ask';
  const actions = [];
  if (ask && p.t) {
    if (p.allowAllowed) actions.push({ action: 'allow', title: 'Izinkan' });
    actions.push({ action: 'deny', title: 'Tolak' });
  }
  return {
    title: titles[p.type],
    options: {
      body: bodies[p.type],
      tag: tagFor(p),
      renotify: ask, // a new request for the same project buzzes again even though it replaces the old one
      silent: p.silent,
      requireInteraction: ask,
      icon: ICON,
      badge: BADGE,
      lang: 'id',
      actions,
      data: { v: SW_VERSION, type: p.type, project: p.project, approvalId: p.approvalId, t: p.t, url: deepLink(p) },
    },
  };
}

/** 'answered': close the ask notification of that approval (not a newer one for another approval). */
async function closeAnswered(p) {
  const shown = await self.registration.getNotifications({ tag: tagFor(p) });
  for (const n of shown) if (!p.approvalId || !n.data?.approvalId || n.data.approvalId === p.approvalId) n.close();
}

async function onPush(event) {
  let raw = null;
  try {
    raw = event.data ? event.data.json() : null;
  } catch {
    raw = null; // unreadable: still show something (browsers revoke push for silent pushes)
  }
  const p = parsePayload(raw);
  if (p.type === 'answered') return closeAnswered(p);
  const n = buildNotification(p);
  return self.registration.showNotification(n.title, n.options);
}

/** POST /api/push/act with the one-time action token. Resolves true only on a 2xx. */
async function answer(data, action) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ACT_TIMEOUT_MS) : 0;
  try {
    const res = await fetch('/api/push/act', {
      method: 'POST',
      credentials: 'include', // the __Host- device cookie; no x-office-token (the action token replaces it)
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: data.t, a: action }),
      signal: controller?.signal,
    });
    return res.ok;
  } catch {
    return false; // offline / Tailscale off / laptop asleep
  } finally {
    clearTimeout(timer);
  }
}

/** Focus an open tab of the app and point it at the approval, or open a new one at the deep link. */
async function openApp(data) {
  const url = data?.url || '/';
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
  if (client) {
    client.postMessage({ type: 'office-open', project: data?.project ?? '', approvalId: data?.approvalId ?? '' });
    if (typeof client.focus === 'function') return client.focus();
    return client;
  }
  return clients.openWindow(url);
}

async function onNotificationClick(event) {
  const { notification, action } = event;
  const data = notification.data ?? {};
  notification.close();
  if ((action === 'allow' || action === 'deny') && data.t) {
    if (await answer(data, action)) return undefined; // answered: the laptop and other devices see it live
  }
  return openApp(data); // a plain tap, or the action could not be delivered: decide in the app
}

// The page a reload lands on while the laptop/Tailscale is unreachable. Deliberately tiny and self-contained: no app
// markup, no token, nothing cached. Light/dark via the system preference, like the app's own default.
const OFFLINE_HTML = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Adhitron — belum tersambung</title><style>
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;font:16px/1.5 system-ui,sans-serif;background:#0f1115;color:#e6e8ee}
main{max-width:26rem}h1{font-size:1.15rem;margin:0 0 8px}p{margin:0 0 12px;color:#a9b0c0}
button{font:inherit;padding:10px 16px;border-radius:10px;border:1px solid #3a4050;background:#1b1f29;color:inherit}
@media (prefers-color-scheme:light){body{background:#f6f7f9;color:#1a1c22}p{color:#555c6b}button{background:#fff;border-color:#d5d8e0}}
</style></head><body><main><h1>Tidak tersambung ke laptop</h1>
<p>Nyalakan Tailscale di HP (dan pastikan laptop menyala), lalu muat ulang halaman ini.</p>
<button onclick="location.reload()">Muat ulang</button></main></body></html>`;

/**
 * A page load with the laptop unreachable: fetch normally, and only when that fails answer with the built-in notice.
 * Guarded by `mode === 'navigate'`, so no module, API or event-stream response is ever replaced.
 */
async function onFetch(event) {
  try {
    return await fetch(event.request);
  } catch {
    return new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('install', () => self.skipWaiting()); // no cache to fill: take over right away
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener('push', (event) => event.waitUntil(onPush(event)));
  self.addEventListener('notificationclick', (event) => event.waitUntil(onNotificationClick(event)));
  self.addEventListener('fetch', (event) => {
    if (event.request.mode === 'navigate') event.respondWith(onFetch(event));
  });
}
