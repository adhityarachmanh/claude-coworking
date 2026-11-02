// Laptop settings and odds and ends: start at login, shut down, the demo.
// /api/autostart and /api/shutdown are laptop only (LOCAL_ONLY in server.js).
import { runDemo } from '../demo.js';
import { setAutostart } from '../autostart.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/autostart', ({ hub, appDir, port }, req, res, params, body) => {
    hub.config = { ...hub.config, autostart: setAutostart(Boolean(body.enabled), appDir, port) };
    hub.broadcast('config', hub.config);
    return json(res, 200, hub.config.autostart);
  });
  router.post('/api/shutdown', ({ shutdown }, req, res) => {
    json(res, 200, { ok: true });
    setTimeout(shutdown, 300);
  });
  router.post('/api/demo', ({ hub }, req, res) => {
    runDemo(hub);
    return json(res, 202, { ok: true });
  });
}
