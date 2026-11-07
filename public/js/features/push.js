// 🔔 → "Notifikasi HP (push)": Web Push on a phone opened over https (Tailscale), and the deep link a
// notification opens (?p=<project>&ap=<approvalId>). The subscription logic is core/push-client.js; what
// to show and what to send is core/push-rules.js. On http (WiFi, Tailscale-http) and on the laptop nothing
// here touches the service worker or /api/push/*: the section only says where push works.
import { api, toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { createPushClient } from '../core/push-client.js';
import { answeredByText, approvalMessageId, httpsHint, isIos, parseDeepLink, pushSettings, pushStatusText, stripDeepLink } from '../core/push-rules.js';
import { state } from '../core/state.js';
import { setMobileView } from '../ui/layout.js';
import { isNotifyOn, notifySettings, setNotifyOn } from './notify.js';
import { revealChatMessage } from './chat.js';
import { selectProject } from './picker.js';

const LOCKSCREEN_KEY = 'office.pushLockscreen'; // "Tombol Izinkan di layar kunci" (per device, default on)
const SYNC_DELAY_MS = 400; // several fields saved in a row → one POST /api/push/settings
const FOCUS_FLASH_MS = 2500;
const VISIBLE_EVERY_MS = 30_000; // the server forgets a "visible" report after 90 s

const push = { client: null, syncTimer: 0, favorites: null, busy: false, resynced: false, visibleTimer: 0 };
const TAB_ID = Math.random().toString(36).slice(2, 12) || 'tab'; // this page, for /api/push/visible

/** Tells the server whether this page is in view (it then holds pushes back); repeated while visible. */
function reportVisibility() {
  clearTimeout(push.visibleTimer);
  if (!push.client?.isActive()) return;
  const visible = document.visibilityState === 'visible';
  push.client.reportVisible(TAB_ID, visible).catch(() => {}); // best effort: worst case one notification twice
  if (visible) push.visibleTimer = setTimeout(reportVisibility, VISIBLE_EVERY_MS);
}

function lockscreenAllow() {
  try {
    return localStorage.getItem(LOCKSCREEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function setLockscreenAllow(on) {
  try {
    localStorage.setItem(LOCKSCREEN_KEY, on ? '1' : '0');
  } catch {
    // not remembered; the server still gets this value now
  }
}

const favoriteIds = () => state.projects.filter((p) => p.favorite).map((p) => p.id);

/** What the server applies before pushing to this device. */
function currentSettings() {
  let tz = '';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    tz = '';
  }
  return pushSettings(notifySettings(), {
    on: isNotifyOn(),
    favorites: favoriteIds(),
    tzOffsetMin: -new Date().getTimezoneOffset(),
    tz,
    lockscreenAllow: lockscreenAllow(),
  });
}

/** Browser facts for pushAvailability() (read each time: permission and display mode can change). */
function browserEnv() {
  return {
    protocol: location.protocol,
    secure: window.isSecureContext === true, // (snapshot client.secure says the same from the server side)
    local: state.local !== false, // before the first snapshot: assume the laptop (nothing to show)
    readOnly: state.readOnly === true,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : 'default',
    ios: isIos({ userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints }),
    standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  };
}

/** True when this device gets its notifications from the service worker (notify.js then skips its own popup). */
export const isPushActive = () => Boolean(push.client?.isActive());

// ---------- the section in 🔔 Pengaturan notifikasi ----------

function show(id, visible) {
  $(id).hidden = !visible;
}

/** Draws the section for this page; async because the subscription is looked up in the service worker. */
export async function renderPushSection() {
  const section = $('#ns-push');
  if (!section || !push.client) return;
  const avail = push.client.availability();
  section.hidden = avail === 'laptop';
  if (avail === 'laptop') return;
  const hint = $('#ns-push-hint');
  if (avail === 'http') {
    const h = httpsHint(state.config?.remote?.https?.url);
    hint.replaceChildren(h.text);
    if (h.url) {
      const link = document.createElement('a');
      link.href = h.url;
      link.textContent = `${h.url}`;
      link.rel = 'noopener';
      hint.append(' ', link, ` ${h.after}`);
    }
  }
  show('#ns-push-hint', avail === 'http');
  const subscribed = avail === 'ready' ? await push.client.subscribed() : false;
  $('#ns-push-status').textContent = pushStatusText(avail, subscribed);
  show('#ns-push-status', avail !== 'http');
  show('#ns-push-on', avail === 'ready' && !subscribed);
  show('#ns-push-test', subscribed);
  show('#ns-push-off', subscribed);
  show('#ns-push-lock-row', avail === 'ready');
  $('#ns-push-lock').checked = lockscreenAllow();
  for (const id of ['#ns-push-on', '#ns-push-test', '#ns-push-off', '#ns-push-lock']) $(id).disabled = push.busy;
}

/** Runs one button's work with the buttons disabled, then redraws; errors become a toast. */
async function busy(work) {
  if (push.busy) return;
  push.busy = true;
  renderPushSection();
  try {
    await work();
  } catch (err) {
    toast(`Notifikasi HP: ${err.message}`);
  } finally {
    push.busy = false;
    renderPushSection();
  }
}

async function enablePush() {
  if (!isNotifyOn()) await setNotifyOn(true); // 🔔 off means "no notifications on this device", push included
  const result = await push.client.enable();
  if (result.ok) {
    reportVisibility();
    return toast('Notifikasi HP aktif.', 'ok');
  }
  if (result.reason === 'denied') toast('Izin notifikasi ditolak browser — izinkan di pengaturan situs.');
  else if (result.reason === 'dismissed') toast('Izin notifikasi belum diberikan.', 'ok');
}

/** Called by notify.js whenever the 🔔 settings or the on/off switch change. Debounced; silent when not subscribed. */
export function pushSettingsChanged() {
  if (!push.client || push.client.availability() !== 'ready') return;
  clearTimeout(push.syncTimer);
  push.syncTimer = setTimeout(() => {
    push.client.syncSettings().catch((err) => toast(`Pengaturan notifikasi HP gagal disimpan: ${err.message}`));
  }, SYNC_DELAY_MS);
}

/** The project list changed: the favourites go to the server only when they did change. */
export function pushProjectsChanged() {
  const signature = favoriteIds().sort().join('\n');
  if (push.favorites === null || push.favorites === signature) return void (push.favorites = signature);
  push.favorites = signature;
  pushSettingsChanged();
}

/** stream.js, live `approval` event: on the laptop, say so when a phone answered it from a notification. */
export function onApprovalUpdate(prev, approval) {
  if (!state.local || prev?.status !== 'pending') return; // once, on the pending → answered edge
  const text = answeredByText(approval);
  if (text) toast(text, 'ok');
}

// ---------- deep link: a notification opens the approval card ----------

/**
 * Selects `project` and brings the card of `approvalId` into view (focused, flashed). An approval that is
 * no longer pending still shows its card (answered); an unknown project changes nothing.
 * @returns {boolean} whether the project was found
 */
export function openApproval(project, approvalId) {
  if (!state.projects.some((p) => p.id === project)) {
    toast('Project dari notifikasi tidak ditemukan.');
    return false;
  }
  if (state.active !== project) selectProject(project);
  setMobileView('chat');
  if (!approvalId) return true;
  const msgId = approvalMessageId(state.chats[project], approvalId);
  const node = msgId ? revealChatMessage(msgId) : null;
  if (!node) {
    toast('Permintaan izin itu sudah tidak ada.', 'ok');
    return true;
  }
  node.scrollIntoView({ block: 'center' });
  node.tabIndex = -1;
  node.focus({ preventScroll: true });
  node.classList.add('ap-focus');
  setTimeout(() => node.classList.remove('ap-focus'), FOCUS_FLASH_MS);
  const status = state.approvals.get(approvalId)?.status;
  if (status && status !== 'pending') toast('Izin ini sudah dijawab.', 'ok');
  return true;
}

/** `?p=&ap=` in the address bar (a notification tap opened a new window): consumed once, then removed. */
export function openDeepLink() {
  const link = parseDeepLink(location.search);
  if (!link) return false;
  history.replaceState(history.state, '', stripDeepLink(location.href)); // a reload must not jump there again
  return openApproval(link.project, link.approvalId);
}

/** After each snapshot (stream.js): the deep link, and the subscription sent again once per page load. */
export function onPushSnapshot() {
  push.favorites = favoriteIds().sort().join('\n');
  openDeepLink();
  if (!push.resynced && push.client?.availability() === 'ready') {
    push.resynced = true;
    push.client.resync().then(reportVisibility, () => {}); // best effort: the app works without push
  }
}

export function initPush() {
  push.client = createPushClient({
    env: browserEnv,
    serviceWorker: navigator.serviceWorker,
    Notification: window.Notification,
    post: (path, body) => api(path, body),
    settings: currentSettings,
  });
  // https only (push-client refuses anything else): the worker shows pushes even while no tab is open.
  push.client.register()?.catch((err) => console.warn('Service worker gagal didaftarkan:', err));
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // A notification tapped while a tab is open: the worker focuses it and says which card to show.
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.origin && e.origin !== location.origin) return;
      const { type, project, approvalId } = e.data ?? {};
      if (type === 'office-open' && typeof project === 'string' && project) openApproval(project, typeof approvalId === 'string' ? approvalId : '');
    });
  }
  document.addEventListener('visibilitychange', reportVisibility);
  $('#ns-push-on').addEventListener('click', () => busy(enablePush));
  $('#ns-push-off').addEventListener('click', () =>
    busy(async () => {
      await push.client.disable();
      toast('Notifikasi HP dimatikan.', 'ok');
    }),
  );
  $('#ns-push-test').addEventListener('click', () =>
    busy(async () => {
      await push.client.sendTest();
      toast('Notifikasi tes dikirim — cek HP.', 'ok');
    }),
  );
  $('#ns-push-lock').addEventListener('change', (e) => {
    setLockscreenAllow(e.target.checked);
    pushSettingsChanged();
  });
}
