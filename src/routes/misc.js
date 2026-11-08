// Laptop settings and odds and ends: start at login, shut down, the demo, the concurrency limit.
// /api/autostart, /api/concurrency/save and /api/shutdown are laptop only (LOCAL_ONLY in server.js).
import { runDemo } from '../demo.js';
import { setAutostart } from '../autostart.js';
import { MAX_CONCURRENT_CAP } from '../concurrency.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/autostart', ({ hub, appDir, port }, req, res, params, body) => {
    hub.config = { ...hub.config, autostart: setAutostart(Boolean(body.enabled), appDir, port) };
    hub.broadcast('config', hub.config);
    return json(res, 200, hub.config.autostart);
  });
  // Global concurrency governor (src/concurrency.js): 0 = unlimited, 1…8 turns at once.
  router.post('/api/concurrency/save', ({ hub, taskQueue }, req, res, params, body) => {
    const value = body?.maxConcurrent;
    if (!Number.isInteger(value) || value < 0 || value > MAX_CONCURRENT_CAP) {
      return json(res, 400, { error: `Batas giliran bersamaan harus bilangan bulat 0–${MAX_CONCURRENT_CAP} (0 = tanpa batas).` });
    }
    hub.persisted.maxConcurrent = value;
    hub.save();
    hub.config = { ...hub.config, concurrency: { maxConcurrent: value } };
    hub.broadcast('config', hub.config);
    // Queues that were waiting for a free slot may start now.
    taskQueue?.scheduleAll?.();
    return json(res, 200, { maxConcurrent: value });
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
