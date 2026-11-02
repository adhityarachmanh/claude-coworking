// ---------- Spotify (♪) — docs/design-spotify.md ----------
// state/art: reads, allowed over WiFi (src/remote.js). devices/playlists/control/settings: laptop + Tailscale phones.
// config/login/logout: laptop only (LOCAL_ONLY in server.js). GET /spotify/callback: laptop only, not under /api/,
// dispatched by server.js to `callback` below.
import { SpotifyError } from '../spotify.js';
import { json } from './http.js';

/** SpotifyError code → HTTP status for the browser. */
const STATUS = {
  unconfigured: 409,
  disconnected: 409,
  revoked: 409,
  premium: 403,
  restricted: 403,
  'no-device': 404,
  'not-found': 404,
  'bad-request': 400,
  'rate-limited': 503,
  network: 502,
};

/** Runs a handler; a SpotifyError becomes `{ error, code, retryAfter? }` with its status (other errors: server.js → 500). */
const guard = (fn) => async (ctx, req, res, params, body) => {
  try {
    return await fn(ctx, req, res, body ?? {});
  } catch (err) {
    if (!(err instanceof SpotifyError)) throw err;
    const status = STATUS[err.code] ?? 502;
    if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    return json(res, status, { error: err.message, code: err.code, ...(err.retryAfter ? { retryAfter: err.retryAfter, until: err.until } : {}) });
  }
};

/** Where the "back to the office" link of the callback page points: the laptop page that started the login. */
function returnOriginOf(req, port) {
  const origin = String(req.headers.origin ?? '');
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}` ? origin : `http://localhost:${port}`;
}

export function register(router) {
  router.post('/api/spotify/state', guard(async ({ spotify }, req, res) => json(res, 200, await spotify.refreshState())));
  router.post(
    '/api/spotify/art',
    guard(async ({ spotify }, req, res, body) => {
      const { type, bytes } = await spotify.art(body.id);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=86400' });
      return res.end(bytes);
    }),
  );
  router.post('/api/spotify/devices', guard(async ({ spotify }, req, res) => json(res, 200, await spotify.devices())));
  router.post('/api/spotify/playlists', guard(async ({ spotify }, req, res, body) => json(res, 200, await spotify.playlists({ offset: body.offset ?? 0 }))));
  router.post('/api/spotify/control', guard(async ({ spotify }, req, res, body) => json(res, 200, await spotify.control(body))));
  // "Saat ada permintaan izin" only (duck/duckVolume): a Tailscale phone may change it too (Lead, Q5).
  router.post('/api/spotify/settings', guard(async ({ spotify }, req, res, body) => json(res, 200, { settings: spotify.setConfig({ settings: body.settings ?? {} }, { settingsOnly: true }).settings })));
  // Laptop only (server.js LOCAL_ONLY): empty body = read.
  router.post(
    '/api/spotify/config',
    guard(async ({ spotify }, req, res, body) => {
      const change = body.clientId !== undefined || body.settings !== undefined;
      return json(res, 200, change ? spotify.setConfig({ clientId: body.clientId, settings: body.settings }) : spotify.config());
    }),
  );
  router.post('/api/spotify/login', guard(async ({ spotify, port }, req, res, body) => json(res, 200, spotify.startLogin({ returnOrigin: returnOriginOf(req, port), switchAccount: body.switchAccount === true }))));
  router.post('/api/spotify/logout', guard(async ({ spotify }, req, res) => json(res, 200, spotify.logout())));
}

// ---------- GET /spotify/callback ----------

const PAGES = {
  ok: [200, 'Spotify terhubung', 'Spotify sudah terhubung ke Adhit Office. Tab ini boleh ditutup.'],
  denied: [200, 'Dibatalkan', 'Login Spotify dibatalkan. Tidak ada yang berubah.'],
  'invalid-state': [400, 'Tautan login tidak valid', 'Tautan login tidak valid atau sudah kedaluwarsa. Mulai lagi dari ⚙ Pengaturan.'],
  exchange: [502, 'Login gagal', 'Spotify tidak menyelesaikan login. Coba lagi dari ⚙ Pengaturan.'],
  error: [500, 'Terjadi kesalahan', 'Terjadi kesalahan di server. Coba lagi dari ⚙ Pengaturan.'],
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A static result page: no script (CSP), never cached; the link goes back to the office tab's origin. */
function page(res, kind, returnOrigin) {
  const [status, title, text] = PAGES[kind] ?? PAGES.error;
  const link = returnOrigin ? `<p><a href="${escapeHtml(returnOrigin)}/">Kembali ke Adhit Office</a></p>` : '';
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Adhit Office</title><style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}</style></head><body><h1>♪ ${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${link}</body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/**
 * GET /spotify/callback?code&state (or ?error). server.js calls it for a laptop (isLocal) GET only.
 * Never throws: the URL holds the authorization code and state, and server.js's generic error path logs req.url.
 */
export async function callback(ctx, req, res, url) {
  try {
    // The registered redirect URI is http://127.0.0.1:<PORT>/…: a callback on any other host name is not ours.
    if (String(req.headers.host ?? '').toLowerCase() !== `127.0.0.1:${ctx.port}`) return json(res, 404, { error: 'not found' });
    const q = url.searchParams;
    // After a successful login the browser lands here (303 below): no code/state left in the address bar or history,
    // and a reload shows the result instead of replaying a used code. Only claims success while actually connected.
    if (q.get('done') === 'ok' && !q.has('code') && !q.has('state')) {
      const { spotify } = ctx;
      return spotify.connected ? page(res, 'ok', spotify.lastLogin?.returnOrigin ?? `http://localhost:${ctx.port}`) : page(res, 'invalid-state', null);
    }
    const value = (k) => (q.get(k) ?? '').slice(0, 4096);
    const result = await ctx.spotify.finishLogin({ code: value('code'), state: value('state'), error: value('error') });
    if (result.ok) {
      res.writeHead(303, { Location: '/spotify/callback?done=ok', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return page(res, result.error, result.returnOrigin);
  } catch (err) {
    // Fixed text only: no URL, no message (it could quote the code).
    console.error(`Spotify: callback gagal (0/${err?.name ?? 'Error'})`);
    try {
      if (!res.headersSent) page(res, 'error', null);
      else res.end();
    } catch {
      /* the socket is gone */
    }
  }
}
