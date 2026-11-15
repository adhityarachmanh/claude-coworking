// ---------- 📱 WhatsApp (src/wa-link.js) ----------
//
// Every route here is laptop-only (LOCAL_ONLY in server.js): a paired phone — Tailscale included — can never link,
// unlink, or read the QR. The QR is a session credential: scanning it is exactly what turns a new device into the
// owner's WhatsApp. So it leaves the laptop by ONE way only, `GET /api/wa/status`, which the laptop page polls; the
// `wa` event carries `{ state }` and nothing else (server.js). server.js also registers the `wa` redactor, a second
// layer that reduces the stream a read-only (plain-WiFi) client receives to `{ state }`.
//
// Contract (GET for polling, POST because the app's API helper only speaks POST):
//   GET|POST /api/wa/status → 200 { state: 'off'|'qr'|'connecting'|'linked', qr: string|null,
//                                   me: { number, name }|null }
//                                   event `wa` → { state } only
//   POST /api/wa/link       → 200 the same status (idempotent; `connecting` until the first QR arrives)
//   POST /api/wa/unlink     → 200 { ok: true }; 504 when the phone does not answer within 5 s
//   POST /api/wa/test       → 200 { ok: true }; 409 when not linked; 503 when the send fails
// Every error body is `{ error }` with Indonesian text. A QR never appears in an error message.
import { WaAuthStoreError } from '../wa-auth-store.js';
import { WaLinkError } from '../wa-link.js';
import { json } from './http.js';

/** A phone that is offline must not hang the request: 5 s, then a 504 the settings card can show. */
export const UNLINK_TIMEOUT_MS = 5000;
export const NOT_LINKED_MESSAGE = 'WhatsApp belum ditautkan.';
const UNLINK_TIMEOUT_MESSAGE = 'WhatsApp tidak merespons saat dilepas. Periksa jaringan di laptop lalu coba lagi.';
const SEND_FAILED_MESSAGE = 'WhatsApp tidak bisa dihubungi. Coba lagi.';
/** The test message only proves the link works; it goes to the owner's own number, like the PIN does. */
const TEST_MESSAGE = 'Adhitron terhubung ke WhatsApp ini (pesan uji).';
const TIMED_OUT = Symbol('timed out');

/**
 * `GET /api/wa/status` (and its POST spelling): the state the settings card polls. The router only dispatches POST
 * (src/routes/router.js), so server.js calls this for the GET — behind the same per-start token as every other API.
 * @returns {Promise<import('node:http').ServerResponse>}
 */
export const status = async ({ waLink, device }, req, res) => {
  const current = await waLink.status();
  // The QR is a session credential (a phone that sees it could link its owner's WhatsApp): the laptop shows it, a
  // paired phone gets the state only. Remote linking uses the pairing code, never the QR.
  if (device && current?.qr) return json(res, 200, { ...current, qr: null });
  return json(res, 200, current);
};

/** Registers the POST routes (src/routes/index.js, like every other route group). */
export function register(router) {
  router.post('/api/wa/status', status, { maxBody: 1024 });
  router.post(
    '/api/wa/link',
    async ({ waLink }, req, res) => {
      try {
        // The same shape as GET /api/wa/status, so the page can render the answer without a second call. A store that
        // cannot be read (tampered session, lost key) rejects here with its own Indonesian wording.
        return json(res, 200, await waLink.link());
      } catch (err) {
        return fail(res, err);
      }
    },
    { maxBody: 1024 },
  );
  router.post(
    '/api/wa/unlink',
    async ({ waLink }, req, res) => {
      const result = await within(waLink.unlink(), UNLINK_TIMEOUT_MS);
      // An offline phone can keep baileys waiting on logout forever; the page gets an answer either way.
      if (result === TIMED_OUT) return json(res, 504, { error: UNLINK_TIMEOUT_MESSAGE });
      if (!result.ok) return fail(res, result.error);
      return json(res, 200, { ok: true });
    },
    { maxBody: 1024 },
  );
  router.post(
    '/api/wa/test',
    async ({ waLink }, req, res) => {
      // Checked first so a page that is not linked gets the plain reason instead of a send failure.
      const current = await waLink.status();
      if (current.state !== 'linked') return json(res, 409, { error: NOT_LINKED_MESSAGE });
      try {
        await waLink.sendText(TEST_MESSAGE);
      } catch (err) {
        return fail(res, err);
      }
      return json(res, 200, { ok: true });
    },
    { maxBody: 1024 },
  );
}

/**
 * Runs `work` with a deadline. After `ms` it resolves with TIMED_OUT; the work keeps running in the background, so
 * its handlers are attached here — a late rejection must never become an unhandled one.
 * @template T
 * @param {Promise<T>} work
 * @param {number} ms
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: unknown } | typeof TIMED_OUT>}
 */
function within(work, ms) {
  let timer;
  const settled = Promise.resolve(work).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  return Promise.race([settled, deadline]).finally(() => clearTimeout(timer));
}

/**
 * A typed WhatsApp failure keeps its Indonesian wording (never credentials). Anything else gets a generic 503: its
 * message may carry JIDs or message text, so only the error's name goes to the log.
 * @returns {import('node:http').ServerResponse}
 */
function fail(res, err) {
  if (err instanceof WaLinkError) return json(res, err.code === 'not_linked' ? 409 : 503, { error: err.message });
  if (err instanceof WaAuthStoreError) return json(res, 503, { error: err.message });
  console.error(`WhatsApp: permintaan gagal (${err?.name ?? 'Error'})`);
  return json(res, 503, { error: SEND_FAILED_MESSAGE });
}
