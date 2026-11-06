// Talking to the server: JSON API calls (with the WiFi read-only guard) and toasts.
import { auth, READ_ONLY_HINT, state } from './state.js';

// The server is the gate for a phone on plain WiFi (wifiAllows in src/remote.js). It sends that same allowlist in the
// snapshot (`client.readOnlyApi`), so the UI never sends what would be refused, without keeping its own copy of the rules.
let readOnlyApi = null; // { paths: string[], patterns: RegExp[] }

/** Takes the allowlist from the snapshot. Anything malformed allows nothing (the server refuses it anyway). */
export function setReadOnlyApi(rules) {
  try {
    readOnlyApi = {
      paths: Array.isArray(rules?.paths) ? rules.paths.filter((p) => typeof p === 'string') : [],
      patterns: Array.isArray(rules?.patterns) ? rules.patterns.filter((p) => typeof p === 'string').map((source) => new RegExp(source)) : [],
    };
  } catch {
    readOnlyApi = null; // a pattern that doesn't compile
  }
}

const readOnlyAllows = (path) => Boolean(readOnlyApi && (readOnlyApi.paths.includes(path) || readOnlyApi.patterns.some((re) => re.test(path))));

/** Whether this page may call `path` at all (false only for a read-only phone on WiFi and a path off its allowlist). */
export const canCall = (path) => !state.readOnly || readOnlyAllows(path);

/**
 * POSTs JSON to the server. Resolves with the parsed JSON, or with a Blob when `raw` (images: ♪ album art).
 * A refused call throws an Error carrying `status` and the server's JSON (`data`: e.g. `code`, `retryAfter`).
 */
export async function api(path, body = {}, { raw = false } = {}) {
  if (!canCall(path)) throw new Error(`${READ_ONLY_HINT}.`);
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office-Token': auth.token },
    body: JSON.stringify(body),
  });
  if (raw && res.ok) return res.blob();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(typeof data.error === 'string' && data.error ? data.error : `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const TOAST_MS = 4000;
const TOAST_MAX = 3;

/** The stack that holds toasts (created on first use): newest at the bottom, never more than three. */
function toastStack() {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.className = 'toasts';
    document.body.append(box);
  }
  return box;
}

export function toast(message, tone = 'error') {
  const box = toastStack();
  // The same message already on screen moves to the newest slot instead of stacking twice: "Tersambung lagi"
  // after a short reconnect reads as one event, not three.
  for (const old of box.querySelectorAll('.toast')) {
    if (old.dataset.tone === tone && old.textContent === message) {
      clearTimeout(old.toastTimer);
      old.remove();
    }
  }
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.dataset.tone = tone;
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status'); // errors interrupt a screen reader, the rest wait
  node.textContent = message;
  box.append(node);
  while (box.children.length > TOAST_MAX) {
    clearTimeout(box.firstElementChild.toastTimer);
    box.firstElementChild.remove();
  }
  node.toastTimer = setTimeout(() => {
    node.remove();
    if (!box.children.length) box.remove(); // no empty fixed layer left over the page
  }, TOAST_MS);
}
