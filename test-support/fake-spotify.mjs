#!/usr/bin/env node
// Test-only stand-in for Spotify (accounts + Web API + image CDN) on 127.0.0.1:<random port>. Never talks to the
// real Spotify. Used by test/spotify*.test.mjs, and by server/UI tests through OFFICE_SPOTIFY_TEST_ORIGIN.
//
//   const fake = await startFakeSpotify({ scenario: { noDevice: true } });
//   fake.origin  → http://127.0.0.1:<port>   (accounts origin, API origin and art host at once)
//   fake.log     → [{ method, path, auth }]   every request (auth: an Authorization header was sent)
//   fake.set({ rateLimit: { retryAfter: 2 } }) changes the scenario while running; fake.player is the live state
//   await fake.close()
//
// As a child process (`node test-support/fake-spotify.mjs`) it prints one JSON line {"origin": "..."} and runs
// until killed. Scenarios: deny, invalidGrant, rateLimit {retryAfter}, premiumRequired, noDevice, expiresIn (s),
// unauthorizedOnce, hang, badImageType, bigImage, noRotation, apiDown (500), visible [ids] (only these devices are
// listed and accept a transfer), appearAfter { polls, ids } (after that many GET /me/player/devices, those ids become
// visible: a desktop app that was just started; counted from fake.set). fake.devicePolls counts the device list requests.
//
// Tokens and codes carry fixed prefixes (fake-access-, fake-refresh-, fake-code-) so tests can scan logs for them.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const S256 = (v) => createHash('sha256').update(v).digest('base64url');
const rand = () => randomBytes(9).toString('base64url');
// A tiny valid JPEG header + padding: the service checks only the magic bytes.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]), Buffer.alloc(64, 1), Buffer.from([0xff, 0xd9])]);
export const FAKE_PLAYLIST_ID = '37i9dQZF1DXcBWIGoYBM5M';
export const FAKE_DEVICE_ID = 'fake-device-laptop-01';

export function startFakeSpotify({ scenario = {} } = {}) {
  const s = { ...scenario };
  const log = [];
  const codes = new Map(); // code -> { challenge, redirectUri, clientId }
  const access = new Set();
  const refresh = new Set();
  const sockets = new Set();
  const issued = { access: [], refresh: [], codes: [] };
  let origin = '';
  let unauthorizedServed = false;
  let devicePolls = 0;
  const devices = [
    { id: FAKE_DEVICE_ID, is_active: true, is_private_session: false, is_restricted: false, name: 'Laptop Adhit', type: 'Computer', volume_percent: 60, supports_volume: true },
    { id: 'fake-device-phone-02', is_active: false, is_private_session: false, is_restricted: false, name: 'HP Adhit', type: 'Smartphone', volume_percent: 40, supports_volume: true },
  ];
  const tracks = ['Lagu Satu', 'Lagu Dua', 'Lagu Tiga'];
  const listed = () => (s.visible ? devices.filter((d) => s.visible.includes(d.id)) : devices);
  const player = { isPlaying: true, index: 0, progressMs: 30_000, device: devices[0], title: null, context: null };

  const track = () => ({
    type: 'track',
    id: '4uLU6hMCjMI75M1A2tKUQC',
    uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    name: player.title ?? tracks[player.index % tracks.length],
    duration_ms: 200_000,
    artists: [{ name: 'Artis Fake', id: 'artist123', uri: 'spotify:artist:artist123' }],
    album: { name: 'Album Fake', id: 'album123', images: [{ url: `${origin}/img/640.jpg`, width: 640, height: 640 }, { url: `${origin}/img/300.jpg`, width: 300, height: 300 }, { url: `${origin}/img/64.jpg`, width: 64, height: 64 }, { url: 'https://evil.example/x.jpg', width: 100 }] },
  });

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const apiError = (res, status, message, reason) => send(res, status, { error: { status, message, ...(reason ? { reason } : {}) } });
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  const issue = () => {
    const a = `fake-access-${rand()}`;
    const r = `fake-refresh-${rand()}`;
    access.add(a);
    refresh.add(r);
    issued.access.push(a);
    issued.refresh.push(r);
    return { a, r };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const p = url.pathname;
    log.push({ method: req.method, path: p, auth: Boolean(req.headers.authorization) });
    if (s.hang && p !== '/authorize') return; // never answers (the socket is destroyed on close)

    // ---------- accounts ----------
    if (req.method === 'GET' && p === '/authorize') {
      const q = url.searchParams;
      const ok = q.get('response_type') === 'code' && q.get('code_challenge_method') === 'S256' && /^[0-9a-f]{32}$/.test(q.get('client_id') ?? '') && q.get('redirect_uri') && q.get('state') && /^[\w-]{43}$/.test(q.get('code_challenge') ?? '');
      if (!ok) return send(res, 400, { error: 'invalid_request' });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('state', q.get('state'));
      if (s.deny) back.searchParams.set('error', 'access_denied');
      else {
        const code = `fake-code-${rand()}`;
        issued.codes.push(code);
        back.searchParams.set('code', code);
        codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri'), clientId: q.get('client_id') });
      }
      res.writeHead(302, { Location: back.href });
      return res.end();
    }
    if (req.method === 'POST' && p === '/api/token') {
      if (req.headers.authorization) return send(res, 400, { error: 'invalid_client', error_description: 'PKCE: no Basic header expected' });
      const f = new URLSearchParams(await readBody(req));
      if (s.invalidGrant) return send(res, 400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code'));
        codes.delete(f.get('code')); // single use
        if (!c || c.clientId !== f.get('client_id') || c.redirectUri !== f.get('redirect_uri') || S256(f.get('code_verifier') ?? '') !== c.challenge) return send(res, 400, { error: 'invalid_grant' });
        const { a, r } = issue();
        return send(res, 200, { access_token: a, token_type: 'Bearer', scope: 'user-read-playback-state user-modify-playback-state playlist-read-private', expires_in: s.expiresIn ?? 3600, refresh_token: r });
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (!refresh.has(f.get('refresh_token'))) return send(res, 400, { error: 'invalid_grant' });
        const { a, r } = issue();
        if (s.noRotation) {
          refresh.delete(r);
          return send(res, 200, { access_token: a, token_type: 'Bearer', expires_in: s.expiresIn ?? 3600 });
        }
        refresh.delete(f.get('refresh_token')); // rotation: the old refresh token dies
        return send(res, 200, { access_token: a, token_type: 'Bearer', expires_in: s.expiresIn ?? 3600, refresh_token: r });
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    // ---------- image CDN ----------
    if (req.method === 'GET' && p.startsWith('/img/')) {
      if (s.bigImage) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        return res.end(Buffer.concat([JPEG, Buffer.alloc(600 * 1024)]));
      }
      res.writeHead(200, { 'Content-Type': s.badImageType ? 'text/html' : 'image/jpeg' });
      return res.end(s.badImageType ? Buffer.from('<script>alert(1)</script>') : JPEG);
    }

    // ---------- Web API ----------
    if (!p.startsWith('/v1/')) return send(res, 404, { error: 'not found' });
    if (s.rateLimit) return send(res, 429, { error: { status: 429, message: 'API rate limit exceeded' } }, s.rateLimit.retryAfter !== undefined ? { 'Retry-After': String(s.rateLimit.retryAfter) } : {});
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!access.has(token)) return apiError(res, 401, 'Invalid access token');
    if (s.unauthorizedOnce && !unauthorizedServed) {
      unauthorizedServed = true;
      access.delete(token);
      return apiError(res, 401, 'The access token expired');
    }
    if (s.apiDown) return apiError(res, 500, 'Server error');
    const write = req.method === 'PUT' || req.method === 'POST';
    if (write && s.premiumRequired) return apiError(res, 403, 'Player command failed: Premium required', 'PREMIUM_REQUIRED');

    if (req.method === 'GET' && p === '/v1/me') return send(res, 200, { display_name: 'Adhit Test', id: 'user-fake-123', uri: 'spotify:user:user-fake-123' });
    if (req.method === 'GET' && p === '/v1/me/player') {
      if (s.noDevice || !player.device) return send(res, 204);
      if (s.ad) return send(res, 200, { device: player.device, is_playing: true, progress_ms: 1000, currently_playing_type: 'ad', item: null });
      return send(res, 200, { device: player.device, is_playing: player.isPlaying, progress_ms: player.progressMs, currently_playing_type: 'track', item: track(), context: player.context });
    }
    if (req.method === 'GET' && p === '/v1/me/player/devices') {
      devicePolls++;
      if (s.appearAfter && devicePolls - (s.appearAfter.base ?? 0) >= s.appearAfter.polls) {
        s.visible = [...new Set([...(s.visible ?? []), ...s.appearAfter.ids])];
        delete s.appearAfter;
      }
      return send(res, 200, { devices: s.noDevice ? [] : listed() });
    }
    if (req.method === 'GET' && p === '/v1/me/playlists') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return send(res, 200, {
        items: offset === 0 ? [{ id: FAKE_PLAYLIST_ID, name: 'Fokus Ngoding', uri: `spotify:playlist:${FAKE_PLAYLIST_ID}`, items: { total: 42 }, images: [{ url: `${origin}/img/pl.jpg`, width: 300 }] }, { id: 'bad id!', name: 'x' }] : [],
        next: offset === 0 ? `${origin}/v1/me/playlists?offset=50` : null,
      });
    }
    // A transfer (PUT /me/player) or a play aimed at a device needs no active device, like the real service.
    const targeted = (req.method === 'PUT' && p === '/v1/me/player') || (p === '/v1/me/player/play' && url.searchParams.has('device_id'));
    if (write && (s.noDevice || (!player.device && !targeted)) && p.startsWith('/v1/me/player')) return apiError(res, 404, 'Player command failed: No active device found', 'NO_ACTIVE_DEVICE');
    if (req.method === 'PUT' && p === '/v1/me/player/play') {
      const body = (await readBody(req)) || '{}';
      const ctx = JSON.parse(body).context_uri;
      const target = url.searchParams.get('device_id');
      if (target) {
        const d = listed().find((x) => x.id === target);
        if (!d) return apiError(res, 404, 'Device not found');
        for (const x of devices) x.is_active = x === d;
        player.device = d;
      }
      if (ctx) {
        player.context = { uri: ctx };
        player.index = 0;
        player.progressMs = 0;
      }
      player.isPlaying = true;
      return send(res, 204);
    }
    if (req.method === 'PUT' && p === '/v1/me/player/pause') {
      player.isPlaying = false;
      return send(res, 204);
    }
    if (req.method === 'POST' && (p === '/v1/me/player/next' || p === '/v1/me/player/previous')) {
      player.index += p.endsWith('next') ? 1 : tracks.length - 1;
      player.title = null;
      player.progressMs = 0;
      return send(res, 204);
    }
    if (req.method === 'PUT' && p === '/v1/me/player/volume') {
      player.device.volume_percent = Number(url.searchParams.get('volume_percent'));
      return send(res, 204);
    }
    if (req.method === 'PUT' && p === '/v1/me/player') {
      const { device_ids: ids, play } = JSON.parse((await readBody(req)) || '{}');
      const d = listed().find((x) => x.id === ids?.[0]);
      if (!d) return apiError(res, 404, 'Device not found');
      for (const x of devices) x.is_active = x === d;
      player.device = d;
      if (play !== undefined) player.isPlaying = play;
      return send(res, 204);
    }
    return apiError(res, 404, 'Service not found');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        origin,
        host: new URL(origin).host,
        log,
        issued,
        player,
        devices,
        get devicePolls() {
          return devicePolls;
        },
        set(patch) {
          Object.assign(s, patch);
          if (patch.appearAfter) s.appearAfter = { ...patch.appearAfter, base: devicePolls }; // counted from now
          for (const [k, v] of Object.entries(patch)) if (v === undefined || v === false) delete s[k];
        },
        /** Expire every access token now (the next API call answers 401). */
        expireAccess: () => access.clear(),
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fake = await startFakeSpotify({ scenario: process.env.FAKE_SPOTIFY_SCENARIO ? JSON.parse(process.env.FAKE_SPOTIFY_SCENARIO) : {} });
  process.stdout.write(`${JSON.stringify({ origin: fake.origin })}\n`);
}
