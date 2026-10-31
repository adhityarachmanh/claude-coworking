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

export async function api(path, body = {}) {
  if (state.readOnly && !readOnlyAllows(path)) throw new Error(`${READ_ONLY_HINT}.`);
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office-Token': auth.token },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function toast(message, tone = 'error') {
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status'); // errors interrupt a screen reader, the rest wait
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 4000);
}
