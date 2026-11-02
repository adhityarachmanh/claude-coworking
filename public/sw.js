// Adhit Office service worker: Web Push notifications only (docs/design-web-push.md §C, §D).
//
// - Registered only on the https (Tailscale) origin; the http listeners answer /sw.js with 404. Note: a 404 on an
//   update check does NOT unregister an installed worker (the spec keeps the registration). A real kill switch
//   would serve an sw.js whose install/activate calls self.registration.unregister().
// - NO fetch handler and NO Cache Storage: the API, /stream and index.html (which carries the per-start token)
//   never pass through here, so nothing stale or secret can be served from a cache.
// - Classic script (not a module SW) for older Firefox / iOS. The handlers are plain functions on the global
//   scope so test/push-ui.test.mjs can run this file in a Node vm with a stubbed `self`.
'use strict';

const SW_VERSION = '2'; // bump on every change: a byte-different sw.js is what makes browsers update it

const ICON = '/icons/icon-192.png';
const BADGE = '/icons/icon-192.png';
const ACT_TIMEOUT_MS = 8000; // the laptop may be asleep or Tailscale off: never hang the click handler

const PUSH_TYPES = ['ask', 'answered', 'done', 'error', 'queue', 'test'];

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
    approvalId: text(p.approvalId, 200),
    t: typeof p.t === 'string' && p.t.length <= 200 ? p.t : '',
    allowAllowed: p.allowAllowed === true,
    silent: p.silent === true, // quiet hours etc. are decided by the server; it may ask for no sound
    // Only the "Kirim tes" push brings its own text; every other title is built here from the fields above.
    title: p.type === 'test' ? text(p.title, 80) : '',
    body: p.type === 'test' ? text(p.body, 120) : '',
  };
}

/** One notification per project and kind: a newer one replaces the older (the ask/answered pair shares one). */
function tagFor(p) {
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
    queue: `⏸ ${p.projectName}: antrian dijeda`,
    test: p.title || '🔔 Tes notifikasi',
  };
  const bodies = {
    // Izinkan withheld (execution/network tool, or switched off on this device): look at it in the app first.
    ask: p.t && !p.allowAllowed ? 'Buka app untuk melihat perintahnya' : 'Ketuk untuk melihat detail',
    done: `${p.role} sudah menyelesaikan permintaanmu`,
    error: 'Ketuk untuk melihat di aplikasi',
    queue: 'Ketuk untuk melihat antrian',
    test: p.body || 'Notifikasi dari Adhit Office berfungsi.',
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

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('install', () => self.skipWaiting()); // no cache to fill: take over right away
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener('push', (event) => event.waitUntil(onPush(event)));
  self.addEventListener('notificationclick', (event) => event.waitUntil(onNotificationClick(event)));
}
