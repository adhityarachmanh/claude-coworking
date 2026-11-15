// Laptop settings and odds and ends: start at login, shut down, the demo, the concurrency limit.
// /api/autostart and /api/concurrency/save are laptop only (LOCAL_ONLY in server.js).
// ⏻ /api/shutdown and /api/power/status are SECURE_ONLY: the laptop, or a phone over the https (Tailscale)
// link — never a plain-HTTP WiFi phone (src/power.js holds the rule).
import { spawn } from 'node:child_process';
import { runDemo } from '../demo.js';
import { setAutostart } from '../autostart.js';
import { MAX_CONCURRENT_CAP } from '../concurrency.js';
import { POWER_SECURE_ERROR, powerAllowed, powerStatus } from '../power.js';
import { json } from './http.js';

/** ⏻ OS shutdown, delayed: the server shuts down gracefully first; the bridge cuts power later (its cron). */
const spawnPcShutdown = () => (process.platform === 'win32'
  ? spawn('shutdown', ['/s', '/t', '45'], { windowsHide: true })
  : spawn('shutdown', ['-h', '+1'], { windowsHide: true }));

export function register(router) {
  router.post('/api/autostart', ({ hub, appDir, port }, req, res, params, body) => {
    // 'login' = after the user logs in (the old behaviour); 'boot' = autologon + a locked screen, so a
    // PC rebooted from far away serves again over Tailscale without anyone in front of it.
    const mode = body?.mode ?? 'login';
    if (mode !== 'login' && mode !== 'boot') {
      return json(res, 400, { error: 'Mode auto-start harus "login" (setelah login Windows) atau "boot" (sebelum login, dengan autologon).' });
    }
    // A generated file can refuse to be written (Program Files without elevation). Say which file and why instead
    // of the generic 500, and leave the previous setting in place.
    try {
      hub.config = { ...hub.config, autostart: setAutostart(Boolean(body.enabled), appDir, port, { mode }) };
    } catch (err) {
      return json(res, 409, { error: err?.message ?? 'Auto-start tidak bisa diubah.' });
    }
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
  // ⚡ What the UI needs before offering the power button: configured?, bridge URL, delay. Never the token.
  router.post('/api/power/status', ({ hub }, req, res) => json(res, 200, powerStatus(hub)));
  router.post('/api/shutdown', async ({ shutdown, hub, device, pcShutdown = spawnPcShutdown, isLocal, isSecure, isReadOnly }, req, res, params, body) => {
    // Defence in depth: server.js already refuses this before the route (SECURE_ONLY), but the rule lives in
    // src/power.js so it can be unit-tested — a phone on plain-HTTP WiFi may never power the PC off. Test
    // contexts without transport signals (no isLocal/isSecure) skip it and rely on the server gate.
    if (typeof isLocal === 'function' && typeof isSecure === 'function') {
      const access = { local: isLocal(req), secure: isSecure(req), readOnly: isReadOnly?.(req) };
      if (!powerAllowed(access)) return json(res, 403, { error: POWER_SECURE_ERROR });
    }
    let handoffUrl;
    if (body?.pc === true) {
      const rp = hub.remotePower();
      if (rp.bridgeUrl && rp.token) {
        // ⚡ Separation of concerns: the app shuts WINDOWS down; cutting the Bardi power is the bridge page's
        // job. We only ask the bridge for a one-time status-page link (handoff) — no schedule, no plug command.
        // The bridge replies with a relative path: read it BEFORE json() so the UI can open it.
        try {
          const off = await fetch(`${rp.bridgeUrl}/api/handoff?delay=${rp.offDelaySec}`, {
            method: 'POST',
            headers: { 'X-Bridge-Token': rp.token },
            signal: AbortSignal.timeout(3000),
          });
          const data = await off.json().catch(() => ({}));
          const url = data?.handoffUrl;
          // Guard open redirect: relative path only — '/s/…' or any path, but never protocol-relative '//host',
          // and never another scheme; max 500 chars.
          const safe = typeof url === 'string' && url.length <= 500
            && (url.startsWith('/s/') || (url.startsWith('/') && !url.startsWith('//')));
          if (safe) handoffUrl = url;
        } catch (err) {
          console.error('Remote power handoff:', err.message); // jembatan tak terjangkau: tetap matikan, tanpa handoff
        }
        if (device) console.log(`Halaman status jembatan disiapkan (permintaan shutdown Windows dari "${device.name}")`);
      }
      json(res, 200, handoffUrl ? { ok: true, pc: true, handoffUrl } : { ok: true, pc: true });
      pcShutdown(); // OS shutdown only (Windows: /t 45 s); the Bardi power stays on until cut from the bridge page
      console.log('PC dimatikan oleh OS (shutdown tertunda) — server dimatikan lebih dulu dengan rapi');
      setTimeout(shutdown, 300);
      return;
    }
    json(res, 200, { ok: true, pc: false });
    setTimeout(shutdown, 300);
  });
  router.post('/api/remote-power/get', ({ hub }, req, res) => json(res, 200, { remotePower: hub.remotePower() }));
  router.post('/api/remote-power/settings', ({ hub }, req, res, params, body) => {
    const clean = hub.setRemotePower({ bridgeUrl: body?.bridgeUrl, token: body?.token, offDelaySec: body?.offDelaySec });
    if (!clean) return json(res, 400, { error: 'URL jembatan harus https://, token maks 200 karakter, jeda 0–600 detik.' });
    return json(res, 200, { remotePower: clean });
  });
  router.post('/api/remote-power/test', async ({ hub, appVersion }, req, res) => {
    const rp = hub.remotePower();
    if (!rp.bridgeUrl || !rp.token) return json(res, 400, { error: 'Remote power belum diset.' });
    const beat = await fetch(`${rp.bridgeUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'X-Bridge-Token': rp.token, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ts: Date.now(), version: String(appVersion ?? '') }),
    }).catch((err) => ({ ok: false, error: err.message }));
    if (!beat.ok) return json(res, 502, { ok: false, error: `Jembatan tidak terjangkau: ${beat.error ?? beat.status}` });
    const st = await fetch(`${rp.bridgeUrl}/api/status`, { headers: { 'X-Bridge-Token': rp.token } }).catch((err) => ({ ok: false, error: err.message }));
    const stBody = await st.json().catch(() => ({}));
    if (!st.ok) return json(res, 502, { ok: false, error: `Jembatan tidak terjangkau: ${st.error ?? st.status}` });
    return json(res, 200, { ok: true, plug: stBody.plug ?? null, lastHeartbeat: stBody.lastHeartbeat ?? null });
  });
  router.post('/api/demo', ({ hub }, req, res) => {
    runDemo(hub);
    return json(res, 202, { ok: true });
  });
}
