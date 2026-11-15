// Talking to the server: JSON API calls (with the WiFi read-only guard) and toasts.
import { auth, LAPTOP_ONLY_HINT, READ_ONLY_HINT, state } from './state.js';

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

// What only the machine itself may do (UAC, installs, opening a folder, the WhatsApp QR). The server sends its own list
// in the snapshot (`client.laptopOnly`) so a phone hides those controls instead of offering a button that answers 403.
// The laptop ignores it: the server never gates the laptop either.
let laptopOnly = null; // { paths: string[], patterns: RegExp[] }

/** Takes the laptop-only list from the snapshot. Anything malformed blocks nothing extra (the server still refuses). */
export function setLaptopOnly(rules) {
  try {
    laptopOnly = {
      paths: Array.isArray(rules?.paths) ? rules.paths.filter((p) => typeof p === 'string') : [],
      patterns: Array.isArray(rules?.patterns) ? rules.patterns.filter((p) => typeof p === 'string').map((source) => new RegExp(source)) : [],
    };
  } catch {
    laptopOnly = null; // a pattern that doesn't compile
  }
}

/** True on a phone for a path only the laptop may call (`state.local === false`: the snapshot said so). */
export const laptopBlocked = (path) => state.local === false && Boolean(laptopOnly && (laptopOnly.paths.includes(path) || laptopOnly.patterns.some((re) => re.test(path))));

/** Whether this page may call `path` at all (false only for a read-only phone on WiFi and a path off its allowlist). */
export const canCall = (path) => !state.readOnly || readOnlyAllows(path);

/**
 * Whether this page may run an administrative action: the laptop always can, a paired phone only over Tailscale
 * HTTPS (`state.secure`), never a plain-WiFi phone. Mirrors the server's SECURE_ADMIN gate, so a button is offered
 * exactly where the request would be accepted.
 */
export const mayAdmin = () => state.local !== false || (state.secure === true && !state.readOnly);

/** The server refused a call: an Error with the HTTP `status` and the parsed JSON body (`error`, `code`, …). */
function apiError(res, data) {
  const err = new Error(typeof data.error === 'string' && data.error ? data.error : `HTTP ${res.status}`);
  err.status = res.status;
  err.data = data;
  return err;
}

/**
 * POSTs JSON to the server. Resolves with the parsed JSON, or with a Blob when `raw` (images: ♪ album art).
 * A refused call throws an Error carrying `status` and the server's JSON (`data`: e.g. `code`, `retryAfter`).
 */
export async function api(path, body = {}, { raw = false } = {}) {
  if (laptopBlocked(path)) throw new Error(LAPTOP_ONLY_HINT);
  if (!canCall(path)) throw new Error(`${READ_ONLY_HINT}.`);
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office-Token': auth.token },
    body: JSON.stringify(body),
  });
  if (raw && res.ok) return res.blob();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data);
  return data;
}

/**
 * GETs JSON from the server (reads that are not an action, e.g. polling /api/wa/status). Same token, same refusals
 * as `api()`: a read-only phone is stopped here exactly like the POSTs are.
 */
export async function apiGet(path) {
  if (laptopBlocked(path)) throw new Error(LAPTOP_ONLY_HINT);
  if (!canCall(path)) throw new Error(`${READ_ONLY_HINT}.`);
  const res = await fetch(path, { headers: { 'X-Office-Token': auth.token } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res, data);
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
      clearTimeout(old.timer);
      old.remove();
    }
  }
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.dataset.tone = tone;
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status'); // errors interrupt a screen reader, the rest wait
  node.textContent = message;
  // Reading time: the pointer over a toast pauses its dismissal (the layer itself stays pointer-events:none —
  // toasts never swallow a click — so the pause is wired on a document listener with a geometric hit test).
  node.left = TOAST_MS;
  node.startedAt = Date.now();
  node.finish = () => {
    clearTimeout(node.timer);
    node.remove();
    if (!box.children.length) box.remove(); // no empty fixed layer left over the page
  };
  node.pause = () => {
    clearTimeout(node.timer);
    node.left -= Date.now() - node.startedAt;
  };
  node.resume = () => {
    node.startedAt = Date.now();
    clearTimeout(node.timer);
    node.timer = setTimeout(node.finish, Math.max(600, node.left));
  };
  node.timer = setTimeout(node.finish, node.left);
  wireToastHover(box);
  box.append(node);
  while (box.children.length > TOAST_MAX) {
    box.firstElementChild.finish?.();
    box.firstElementChild.remove();
  }
}

/** One document-level mousemove pauses/resumes every visible toast whose box is under the pointer. */
let toastHoverWired = false;
function wireToastHover(box) {
  if (toastHoverWired) return;
  toastHoverWired = true;
  document.addEventListener('mousemove', (e) => {
    for (const t of box.querySelectorAll('.toast')) {
      const r = t.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside && !t.paused) {
        t.paused = true;
        t.pause();
      } else if (!inside && t.paused) {
        t.paused = false;
        t.resume();
      }
    }
  }, { passive: true });
}
