// 🔔 Web Push (docs/design-web-push.md §B–§C): subscription of a paired phone on the https (Tailscale) origin, and the
// Izinkan / Tolak buttons of its notifications. The policy lives in src/push.js (ctx.push).
//
// Gates, on top of server.js's (Host/Origin, pairing, laptop-only paths, the WiFi read-only allowlist, which none of
// these paths is in): an encrypted socket, a Tailscale connection, and a device paired over https (its __Host- cookie).
// /api/push/act is the one API path without x-office-token (a service worker has no per-start token): its
// single-use action token replaces it, and it also requires an Origin header equal to the https origin.
import { PushError } from '../push.js';
import { json } from './http.js';

const MAX_SUBSCRIBE_BODY = 4096;
const MAX_SMALL_BODY = 1024;

/** Why this request may not use /api/push/* (null = fine). */
function refusal({ device, isTailscale }, req) {
  if (!req.socket.encrypted || !isTailscale(req)) return [403, 'Notifikasi HP hanya lewat HTTPS Tailscale.'];
  if (!device || device.transport !== 'https') return [401, 'Perangkat belum dipasangkan lewat HTTPS.'];
  return null;
}

/** A route body behind the push gate; PushError becomes its status, anything else stays a 500. */
const gated = (fn) => async (ctx, req, res, params, body) => {
  const refused = refusal(ctx, req);
  if (refused) return json(res, refused[0], { error: refused[1] });
  try {
    return json(res, 200, await fn(ctx, body ?? {}, req));
  } catch (err) {
    if (err instanceof PushError) {
      if (err.extra.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter)); // 429 (test cooldown)
      return json(res, err.status, { error: err.message, ...err.extra });
    }
    throw err;
  }
};

export function register(router) {
  router.post('/api/push/vapid', gated(({ push }) => ({ publicKey: push.publicKey() })), { maxBody: MAX_SMALL_BODY });
  router.post('/api/push/subscribe', gated(({ push, device }, body) => push.subscribe(device, body)), { maxBody: MAX_SUBSCRIBE_BODY });
  router.post('/api/push/settings', gated(({ push, device }, body) => push.updateSettings(device, body)), { maxBody: MAX_SUBSCRIBE_BODY });
  router.post('/api/push/unsubscribe', gated(({ push, device }) => push.unsubscribe(device)), { maxBody: MAX_SMALL_BODY });
  router.post('/api/push/visible', gated(({ push, device }, body) => push.setVisible(device.id, body.tab, body.visible)), { maxBody: MAX_SMALL_BODY });
  router.post('/api/push/test', gated(({ push, device }) => push.test(device)), { maxBody: MAX_SMALL_BODY });
  // The laptop's view of what was sent (in-memory); LOCAL_ONLY in server.js, so no paired phone sees it.
  router.post('/api/push/history', ({ push, isLocal }, req, res) => {
    if (!isLocal(req)) return json(res, 403, { error: 'Riwayat notifikasi hanya dari laptop.' });
    return json(res, 200, { entries: push.historyView() });
  }, { maxBody: MAX_SMALL_BODY });
  router.post('/api/push/act', act, { maxBody: MAX_SMALL_BODY, noToken: true });
}

/** POST /api/push/act {t, a: 'allow'|'deny'} from the service worker (notificationclick). */
function act(ctx, req, res, params, body) {
  const refused = refusal(ctx, req);
  if (refused) return json(res, refused[0], { error: refused[1] });
  // No x-office-token here: the request must come from our own https page/worker (Origin present and exact).
  const origin = ctx.httpsInfo().url;
  if (!origin || req.headers.origin !== origin) return json(res, 403, { error: 'bad origin' });
  const { status, body: out } = ctx.push.act({ device: ctx.device, t: body?.t, a: body?.a, ip: String(req.socket.remoteAddress ?? '') });
  return json(res, status, out);
}
