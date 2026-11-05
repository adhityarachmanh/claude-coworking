// 🩺 Kesehatan sistem (src/health.js): one POST returns `{ health: buildHealth(ctx) }`.
// Laptop + Tailscale only: there is deliberately no entry for this path in the plain-HTTP WiFi read allowlist
// (src/remote.js wifiAllows), so server.js refuses a read-only phone with 403 before the handler runs. The report
// is sync and cheap (no CLI, no model) and never throws: an unavailable service becomes a warn line in it.
import { buildHealth } from '../health.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/health', (ctx, req, res) => json(res, 200, { health: buildHealth(ctx) }), { maxBody: 1024 });
}
