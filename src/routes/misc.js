// Laptop settings and odds and ends: start at login, shut down, the demo, the concurrency limit.
// /api/autostart and /api/concurrency/save are laptop only (LOCAL_ONLY in server.js).
// ⏻ /api/shutdown and /api/power/status are SECURE_ONLY: the laptop, or a phone over the https (Tailscale)
// link — never a plain-HTTP WiFi phone (src/power.js holds the rule).
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { runDemo } from '../demo.js';
import { setAutostart } from '../autostart.js';
import { MAX_CONCURRENT_CAP } from '../concurrency.js';
import { autoCutPlan, PC_SHUTDOWN_SECONDS, POWER_SECURE_ERROR, pcShutdownPlan, powerAllowed, powerStatus } from '../power.js';
import { pairBridge, scheduleBridgeCut } from '../power-bridge.js';
import { json } from './http.js';

// How long the OS shutdown command may take to answer. shutdown.exe returns as soon as Windows accepts the request;
// a process still running after this never reached the OS (a dialog, a policy, a wrong binary), so it is a failure.
const SHUTDOWN_WAIT_MS = 5000;
const firstLine = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 300) ?? '';

/**
 * ⏻ Runs the OS shutdown and WAITS for its exit code. Windows quitting with 0 means the shutdown is scheduled;
 * anything else (exit 5 "Access is denied", a spawn error, no answer) means Windows never accepted it. The old
 * fire-and-forget call discarded exactly that information, so a failed request looked like a successful one while
 * the PC stayed on. Never throws.
 * @returns {Promise<{ ok: boolean, code: number|null, message: string }>}
 */
export const spawnPcShutdown = () => runShutdown(pcShutdownPlan());

/**
 * Runs one shutdown command and waits for it (see spawnPcShutdown). Exported so tests can exercise the exit-code
 * handling with a harmless process instead of shutting the machine down.
 * @param {{ command: string, args: string[] }} plan
 */
export const runShutdown = (plan) => new Promise((resolve) => {
  let child;
  try {
    child = spawn(plan.command, plan.args, { windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return resolve({ ok: false, code: null, message: String(err?.message ?? err) });
  }
  let stderr = '';
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.unref?.(); // the OS keeps it after this server exits
    resolve(result);
  };
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // already gone
    }
    finish({ ok: false, code: null, message: `shutdown tidak menjawab dalam ${SHUTDOWN_WAIT_MS / 1000} detik.` });
  }, SHUTDOWN_WAIT_MS);
  timer.unref?.();
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-800);
  });
  child.on('error', (err) => finish({ ok: false, code: null, message: String(err?.message ?? err) })); // ENOENT etc.
  child.on('close', (code) => finish(code === 0 ? { ok: true, code: 0, message: '' } : { ok: false, code, message: firstLine(stderr) || `shutdown keluar dengan kode ${code}.` }));
});

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
  // 🧭 Claude Code on/off (OpenCode stays): one persisted flag hides its models/account and stops its turns, nothing
  // is deleted. Refused while a Claude project is working — a turn must never be cut by a settings switch.
  router.post('/api/engines/claude', ({ hub, refreshProjects }, req, res, params, body) => {
    const enabled = body?.enabled;
    if (typeof enabled !== 'boolean') return json(res, 400, { error: 'Kirim { enabled: true|false }.' });
    if (!enabled) {
      const busy = [];
      for (const [id, rt] of hub.runtime ?? []) {
        const st = rt?.status ?? {};
        if (hub.engineOf(id) !== 'claude') continue;
        if (st.busy || st.cliBusy || st.pending || st.queue) busy.push(hub.projects?.get(id)?.name ?? id);
      }
      if (busy.length) return json(res, 409, { error: `Masih ada pekerjaan Claude di ${busy.join(', ')}. Tunggu giliran selesai, lalu nonaktifkan.` });
    }
    const now = hub.setClaudeEnabled(enabled);
    refreshProjects?.(); // rebuilds config (engines.claude.enabled) and tells every page
    console.log(`Claude Code ${now ? 'diaktifkan' : 'dinonaktifkan'} dari aplikasi`);
    return json(res, 200, { enabled: now });
  });
  router.post('/api/shutdown', async ({ shutdown, hub, device, pcShutdown = spawnPcShutdown, isLocal, isSecure, isReadOnly }, req, res, params, body) => {
    // Defence in depth: server.js already refuses this before the route (SECURE_ONLY), but the rule lives in
    // src/power.js so it can be unit-tested — a phone on plain-HTTP WiFi may never power the PC off. Test
    // contexts without transport signals (no isLocal/isSecure) skip it and rely on the server gate.
    if (typeof isLocal === 'function' && typeof isSecure === 'function') {
      const access = { local: isLocal(req), secure: isSecure(req), readOnly: isReadOnly?.(req) };
      if (!powerAllowed(access)) return json(res, 403, { error: POWER_SECURE_ERROR });
    }
    let handoffUrl;
    let cutDelay = null;
    if (body?.pc === true) {
      const rp = hub.remotePower();
      cutDelay = autoCutPlan(rp.autoCut, rp.offDelaySec);
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
      // The OS must accept the request BEFORE the server goes away: otherwise the user is left with no app and a
      // PC that never shuts down (exactly the production report). Anything but exit 0 is reported and changes nothing.
      let result;
      try {
        result = await pcShutdown();
      } catch (err) {
        result = { ok: false, code: null, message: String(err?.message ?? err) };
      }
      if (result && result.ok === false) {
        console.error(`⏻ Shutdown Windows ditolak: ${result.message}`);
        return json(res, 502, { error: `Windows tidak bisa dimatikan: ${result.message}. Server tetap hidup — coba lagi, atau matikan langsung dari laptop.` });
      }
      // ⚡ Auto-cut: the bridge cuts the plug itself after the delay (the status page shows the countdown). Called
      // only after Windows accepted the shutdown; a failure is logged and the user still has the manual button.
      let autoCut = false;
      if (cutDelay) {
        const cut = await scheduleBridgeCut({ bridgeUrl: rp.bridgeUrl, token: rp.token, delay: cutDelay });
        if (cut.ok) {
          autoCut = true;
          if (!handoffUrl && cut.handoffUrl) handoffUrl = cut.handoffUrl;
        } else {
          console.error(`⏻ Putus arus otomatis gagal: ${cut.error}`);
        }
      }
      json(res, 200, { ok: true, pc: true, ...(handoffUrl ? { handoffUrl } : {}), ...(autoCut ? { autoCut: true, offDelaySec: cutDelay } : {}) });
      console.log(`PC dimatikan oleh OS (shutdown ${PC_SHUTDOWN_SECONDS} dtk, exit ${result?.code ?? 0}) — server dimatikan lebih dulu dengan rapi${autoCut ? ` · listrik diputus otomatis dalam ${cutDelay} dtk` : ''}`);
      setTimeout(shutdown, 300);
      return;
    }
    json(res, 200, { ok: true, pc: false });
    setTimeout(shutdown, 300);
  });
  router.post('/api/remote-power/get', ({ hub }, req, res) => json(res, 200, { remotePower: hub.remotePower() }));
  router.post('/api/remote-power/settings', ({ hub }, req, res, params, body) => {
    // Partial save: the dialog sends every field, but a single control (e.g. the ⏻ checkbox) must never wipe the
    // bridge URL/token it did not send.
    const current = hub.remotePower();
    const clean = hub.setRemotePower({
      bridgeUrl: body?.bridgeUrl ?? current.bridgeUrl,
      token: body?.token ?? current.token,
      offDelaySec: body?.offDelaySec ?? current.offDelaySec,
      shutdownPc: body?.shutdownPc ?? current.shutdownPc,
      autoCut: body?.autoCut ?? current.autoCut,
    });
    if (!clean) return json(res, 400, { error: 'URL jembatan harus https://, token maks 200 karakter, jeda 0–600 detik; putus arus otomatis minimal 90 detik.' });
    return json(res, 200, { remotePower: clean });
  });
  // 📲 The phone gets the bridge page without typing the token: an 8-character one-time code (the bridge owns its
  // TTL/claims). The long-term token never leaves this server.
  router.post('/api/remote-power/pair', async ({ hub }, req, res) => {
    const rp = hub.remotePower();
    if (!rp.bridgeUrl || !rp.token) return json(res, 400, { error: 'Remote power belum diset.' });
    const pair = await pairBridge({ bridgeUrl: rp.bridgeUrl, token: rp.token });
    if (!pair.ok) return json(res, 502, { error: pair.error });
    // The QR only carries the bridge URL (no token). The code is shown as text next to it.
    const qr = await QRCode.toDataURL(rp.bridgeUrl, { margin: 1, width: 240 }).catch(() => null);
    return json(res, 200, { code: pair.code, expiresAt: pair.expiresAt, bridgeUrl: rp.bridgeUrl, qr });
  }, { maxBody: 1024 });
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
