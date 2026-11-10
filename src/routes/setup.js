// 🧰 Setup (src/setup/service.js): status, a fresh probe, and the three actions that change the laptop.
//
// Laptop + Tailscale only: these paths are deliberately absent from wifiAllows (src/remote.js), so a read-only
// phone on plain-HTTP WiFi gets 403 before a handler runs. The three mutations are also in LOCAL_ONLY (server.js):
// installing software, cancelling it and opening a login terminal only make sense on the laptop itself. The status
// is already broadcast to every browser as config.setup; these routes are for the setup screen's own polling.
import { isSetupTarget } from '../setup/packages.js';
import { json } from './http.js';

const LOGIN_TARGETS = new Set(['claude', 'opencode']);
const LOGIN_STATUS = Object.freeze({ BAD_TARGET: 400, NOT_INSTALLED: 404, BUSY: 409, UNSUPPORTED: 501 });

export function register(router) {
  router.post('/api/setup/status', status, { maxBody: 1024 });
  router.post('/api/setup/refresh', refresh, { maxBody: 1024 });
  router.post('/api/setup/install', install, { maxBody: 1024 });
  router.post('/api/setup/cancel', cancel, { maxBody: 1024 });
  router.post('/api/setup/login-terminal', loginTerminal, { maxBody: 1024 });
}

/** A body with exactly one key, `target`, and nothing else: never a URL, package name, argument or path. */
function targetOf(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'target' || typeof body.target !== 'string') return null;
  return body.target;
}

function status({ setup }, req, res) {
  return json(res, 200, { setup: setup.snapshot() });
}

function refresh({ setup }, req, res) {
  setup.refresh();
  return json(res, 202, { setup: setup.snapshot() });
}

function install({ setup, device }, req, res, params, body) {
  const target = targetOf(body);
  if (!target || !isSetupTarget(target)) return json(res, 400, { error: 'Target setup tidak dikenal.' });
  const result = setup.install(target);
  if (result.already) return json(res, 200, { setup: setup.snapshot(), already: true });
  if (!result.started) return json(res, result.status ?? 409, { error: result.error, setup: setup.snapshot() });
  if (device) console.log(`Setup ${target} dimulai dari HP "${device.name}"`);
  return json(res, 202, { setup: setup.snapshot() });
}

function cancel({ setup }, req, res) {
  const result = setup.cancel();
  if (!result.cancelled) return json(res, result.status ?? 409, { error: result.error, setup: setup.snapshot() });
  return json(res, 202, { setup: setup.snapshot() });
}

function loginTerminal({ setup }, req, res, params, body) {
  const target = targetOf(body);
  if (!target || !LOGIN_TARGETS.has(target)) return json(res, 400, { error: 'Target login tidak dikenal.' });
  const result = setup.openLoginTerminal(target);
  if (result.ok) return json(res, 200, { ok: true });
  return json(res, LOGIN_STATUS[result.code] ?? 409, { ok: false, code: result.code });
}
