// 📲 Pasang sebagai aplikasi (PWA): Chromium fires `beforeinstallprompt` when the manifest/service worker allow
// it; iOS has no such event (the Panduan shows the manual Add to Home Screen steps instead). There is deliberately
// no offline cache: index.html carries the per-start API token (see public/sw.js).
import { toast } from '../core/api.js';
import { $ } from '../core/dom.js';

let prompt = null; // the deferred beforeinstallprompt event
const listeners = new Set();

const notify = () => {
  const available = Boolean(prompt);
  const btn = $('#install-app');
  if (btn) btn.hidden = !available;
  for (const fn of listeners) fn(available);
};

/** Subscribes to availability changes (the Panduan button); returns the unsubscribe function. */
export function onInstallChange(fn) {
  listeners.add(fn);
  fn(Boolean(prompt));
  return () => listeners.delete(fn);
}

/** Shows the browser's install dialog. True when the user accepted. */
export async function installApp() {
  if (!prompt) return false;
  const event = prompt;
  prompt = null;
  event.prompt();
  const choice = await event.userChoice.catch(() => null);
  notify();
  return choice?.outcome === 'accepted';
}

/** 🔢 The installed app's icon badge (Chromium, Android): pending approvals. Silently ignored elsewhere. */
export function syncAppBadge(count) {
  try {
    const n = Number(count);
    const pending = Number.isFinite(n) && n > 0 ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.();
    pending?.catch?.(() => {});
  } catch {
    // unsupported or not installed as an app
  }
}

export function initInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // show our own button in Panduan instead of the browser's mini-infobar
    prompt = event;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    prompt = null;
    notify();
  });
  $('#install-app')?.addEventListener('click', async () => {
    const accepted = await installApp();
    toast(accepted ? 'Aplikasi dipasang.' : 'Pemasangan dibatalkan.', accepted ? 'ok' : 'warn');
  });
  notify();
}
