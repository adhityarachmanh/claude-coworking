// ---------- 🪟 Autologon ("server hidup sebelum login Windows") ----------
//
// Two laptop-only routes (LOCAL_ONLY in server.js): the Windows password is asked for once, and the machine's
// logon behaviour changes. A paired phone — Tailscale included — must never reach them.
//
// Contract:
//   POST /api/autologon            { password: string (1…256) }
//     → 200 { ok: true, autostart }                  Windows will log in by itself, boot mode installed
//     → 400 { error }                                password missing/too long
//     → 401 { error }                                wrong Windows password (helper exit 3)
//     → 409 { error }                                UAC cancelled, or the change did not happen
//     → 429 { error }                                more than 5 attempts in a minute (per process)
//     → 504 { error }                                Windows did not answer (helper timed out)
//   POST /api/autologon/disable
//     → 200 { ok: true, autostart }                  autologon off; boot mode dropped to 'login' when enabled
//     → 409 { error }                                UAC cancelled, or the change did not happen
//
// The password is never returned, broadcast, or written to the log. `autostart` is the same shape
// `autostartStatus()` gives the settings page (it names the two legacy .cmd files; the UI no longer uses them).
//
// The heavy lifting stays in src/autologon.js: `enableAutologon` writes the password to an owner-only temp file and
// runs ONE elevated copy of this app; `disableAutologon` below spawns that copy (never `helperMain` in this process:
// the UAC prompt belongs to a child, and a crashed helper must not take the server down).
import { spawn } from 'node:child_process';
import { enableAutologon, relaunchOf } from '../autologon.js';
import { autostartStatus, setAutostart } from '../autostart.js';
import { json } from './http.js';

export const MAX_PASSWORD_LENGTH = 256;
/** Five rounds of "try the Windows password" per minute is plenty for a person who mistyped; a script gets 429. */
export const MAX_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 60_000;
/** The elevated copy may sit behind one UAC prompt; its own elevation gives up after 120 s, so wait a little longer. */
export const DISABLE_TIMEOUT_MS = 180_000;

const BAD_PASSWORD_MESSAGE = `Sandi Windows wajib diisi (maksimal ${MAX_PASSWORD_LENGTH} karakter).`;
const WRONG_PASSWORD_MESSAGE = 'Sandi Windows salah.';
const CANCELLED_MESSAGE = 'Dibatalkan.';
const TOO_MANY_MESSAGE = 'Terlalu banyak percobaan. Tunggu sebentar.';
const ENABLE_FAILED_MESSAGE = 'Autologon tidak bisa dinyalakan. Coba lagi dari Setelan.';
const DISABLE_FAILED_MESSAGE = 'Autologon tidak bisa dimatikan. Coba lagi dari Setelan.';
const TIMEOUT_MESSAGE = 'Windows tidak menjawab saat menyalakan autologon. Coba lagi dari Setelan.';
/** Errors the helper is known to throw, already worded for the user (src/autologon.js). */
const KNOWN_FAILURES = {
  notAdmin: 'Izin Administrator dibutuhkan untuk menyalakan autologon.',
  registry: 'Registry Windows tidak bisa diubah. Autologon tetap mati.',
  unverified: 'Autologon belum aktif menurut Windows. Coba lagi dari Setelan.',
  unsupported: 'Autologon hanya tersedia di Windows.',
};

/** Timestamps of the accepted enable attempts in THIS process (a restart clears them; there is one server per PC). */
const attempts = [];

/** True when the last `MAX_ATTEMPTS` accepted attempts all happened inside the window. */
function tooManyAttempts(now = Date.now()) {
  while (attempts.length && now - attempts[0] >= ATTEMPT_WINDOW_MS) attempts.shift();
  return attempts.length >= MAX_ATTEMPTS;
}

/**
 * Runs the CLI copy of this app with `--autologon-disable` and waits for its exit code. That copy is the same
 * executable/script (see `relaunchOf`), and it elevates itself once; nothing is run in the server process.
 *
 * @returns {Promise<{ ok: true } | { ok: false, cancelled: true } | { ok: false, message: string }>}
 */
function disableAutologon({ appDir, port, spawn: launch = spawn, timeoutMs = DISABLE_TIMEOUT_MS } = {}) {
  const target = relaunchOf(appDir);
  const args = [...target.args, '--autologon-disable', '--app-dir', appDir, '--port', String(port)];
  return new Promise((resolve) => {
    let child;
    let timer;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      try {
        child?.kill?.();
      } catch {
        // already gone: the verdict stands either way
      }
      finish({ ok: false, message: 'Windows tidak menjawab saat mematikan autologon. Coba lagi dari Setelan.' });
    }, timeoutMs);
    try {
      child = launch(target.file, args, { windowsHide: true, stdio: 'ignore' });
    } catch (err) {
      finish({ ok: false, message: `Tidak bisa menjalankan helper autologon: ${err?.message ?? err}` });
      return;
    }
    child.on('error', (err) => finish({ ok: false, message: `Tidak bisa menjalankan helper autologon: ${err?.message ?? err}` }));
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true });
      else if (code === 6 || code === 1223) finish({ ok: false, cancelled: true });
      else if (code === 5) finish({ ok: false, message: 'Izin Administrator dibutuhkan untuk mematikan autologon.' });
      else finish({ ok: false, message: DISABLE_FAILED_MESSAGE });
    });
  });
}

/**
 * The real Windows side of these routes: the elevated helper and the auto-start installer. Kept behind one object
 * so the end-to-end test can swap it (see `fakeAutologon`) without a UAC prompt or a real registry write.
 */
export function windowsAutologon() {
  return {
    enable: (options) => enableAutologon(options),
    disable: (options) => disableAutologon(options),
    status: (options) => autostartStatus(options),
    setMode: (enabled, appDir, port, options) => setAutostart(enabled, appDir, port, options),
  };
}

/**
 * Tests only (OFFICE_AUTOLOGON_FAKE=1, selected in server.js; never set in a real install): an in-memory switch.
 * No UAC prompt, no HKLM write, no Startup folder, no scheduled task — the routes, validation and status codes are
 * the real ones. The password picks the scenario:
 *   'batal'  → UAC cancelled  · 'salah' → wrong Windows password  · 'lambat' → Windows does not answer
 *   anything else → success.
 */
export function fakeAutologon() {
  const state = { enabled: false, mode: 'login', autologon: 'off' };
  const status = () => ({
    supported: true,
    enabled: state.enabled,
    watchdog: false,
    path: null,
    mode: state.mode,
    autologon: state.autologon,
    needsElevation: false,
    unsafeDesktop: false,
  });
  return {
    async enable({ password }) {
      if (password === 'batal') return { ok: false, cancelled: true };
      if (password === 'salah') {
        const error = new Error(WRONG_PASSWORD_MESSAGE);
        error.code = 'wrongPassword';
        error.exitCode = 3;
        throw error;
      }
      if (password === 'lambat') return { ok: false, reason: 'timeout', error: TIMEOUT_MESSAGE };
      state.enabled = true;
      state.mode = 'boot';
      state.autologon = 'on';
      return { ok: true, verified: true };
    },
    async disable() {
      state.autologon = 'off';
      if (state.enabled) state.mode = 'login';
      return { ok: true };
    },
    status,
    setMode(enabled, appDir, port, options) {
      state.enabled = enabled;
      state.mode = options?.mode === 'boot' ? 'boot' : 'login';
      return status();
    },
  };
}

/** Registers the POST routes (src/routes/index.js, like every other route group). */
export function register(router) {
  router.post('/api/autologon', async (ctx, req, res, params, body) => {
    const password = body?.password;
    // Validated before the counter: a malformed request is not a password attempt.
    if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      return json(res, 400, { error: BAD_PASSWORD_MESSAGE });
    }
    if (tooManyAttempts()) return json(res, 429, { error: TOO_MANY_MESSAGE });
    attempts.push(Date.now());

    const windows = ctx.autologon ?? windowsAutologon();
    try {
      const result = await windows.enable({ password, appDir: ctx.appDir, port: ctx.port });
      if (!result.ok) {
        if (result.cancelled) return json(res, 409, { error: CANCELLED_MESSAGE });
        if (result.reason === 'timeout') return json(res, 504, { error: result.error ?? TIMEOUT_MESSAGE });
        return json(res, 409, { error: ENABLE_FAILED_MESSAGE });
      }
      // Autologon alone only logs in; boot mode is what starts the server again without anyone in front of the PC.
      try {
        windows.setMode(true, ctx.appDir, ctx.port, { mode: 'boot' });
      } catch (err) {
        console.error(`Autologon: auto-start boot gagal dipasang: ${err?.message ?? err}`);
        return json(res, 409, { error: `Autologon menyala, tetapi auto-start saat boot gagal dipasang: ${err?.message ?? 'tidak diketahui'}` });
      }
      const autostart = windows.status({ appDir: ctx.appDir, port: ctx.port });
      ctx.hub.config = { ...ctx.hub.config, autostart };
      ctx.hub.broadcast('config', ctx.hub.config);
      return json(res, 200, { ok: true, autostart });
    } catch (err) {
      if (err?.code === 'wrongPassword') return json(res, 401, { error: WRONG_PASSWORD_MESSAGE });
      // The password is never in these messages (src/autologon.js), but only the code/known wording leaves the server.
      console.error(`Autologon: ${err?.code ?? 'Error'}: ${err?.message ?? err}`);
      return json(res, 409, { error: KNOWN_FAILURES[err?.code] ?? ENABLE_FAILED_MESSAGE });
    }
  }, { maxBody: 1024 });

  router.post('/api/autologon/disable', async (ctx, req, res) => {
    const windows = ctx.autologon ?? windowsAutologon();
    const result = await windows.disable({ appDir: ctx.appDir, port: ctx.port });
    if (!result.ok) {
      if (result.cancelled) return json(res, 409, { error: CANCELLED_MESSAGE });
      return json(res, 409, { error: result.message ?? DISABLE_FAILED_MESSAGE });
    }
    // Windows will not log in by itself any more: keep auto-start, but downgrade boot mode to "after login" so the
    // page never promises a server that only comes up once someone is in front of the PC.
    const current = windows.status({ appDir: ctx.appDir, port: ctx.port });
    if (current?.enabled) {
      try {
        windows.setMode(true, ctx.appDir, ctx.port, { mode: 'login' });
      } catch (err) {
        console.error(`Autologon: menurunkan mode auto-start gagal: ${err?.message ?? err}`);
      }
    }
    const autostart = windows.status({ appDir: ctx.appDir, port: ctx.port });
    ctx.hub.config = { ...ctx.hub.config, autostart };
    ctx.hub.broadcast('config', ctx.hub.config);
    return json(res, 200, { ok: true, autostart });
  }, { maxBody: 1024 });
}
