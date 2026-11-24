// 📅 Rekap mingguan: a read-only summary of the ledger's last 7 days (laptop/Tailscale; project names are
// sensitive) plus the weekly schedule stored in state.json. The scheduler lives in src/digest.js.
import { cleanDigestSettings, digestUnread, weeklyDigest } from '../digest.js';
import { json } from './http.js';

const WEEKDAY = (v) => Number.isInteger(v) && v >= 0 && v <= 6;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function register(router) {
  router.post('/api/digest', ({ ledger }, req, res) => {
    const rows = ledger?.query?.({ accountId: 'all', from: Date.now() - 7 * 86_400_000 }) ?? [];
    return json(res, 200, weeklyDigest(rows));
  }, { maxBody: 1024 });

  // The schedule and the last digest; the dialog shows what the scheduler already built (no extra work).
  router.post('/api/digest/settings', ({ hub }, req, res) => {
    const digest = cleanDigestSettings(hub.persisted?.digest);
    return json(res, 200, { digest, unread: digestUnread(digest) });
  }, { maxBody: 1024 });

  router.post('/api/digest/save', ({ hub, device }, req, res, params, body) => {
    const patch = {};
    if ('enabled' in (body ?? {})) patch.enabled = body.enabled === true;
    if ('weekday' in (body ?? {})) {
      if (!WEEKDAY(body.weekday)) return json(res, 400, { error: 'Hari harus 0 (Minggu) sampai 6 (Sabtu).' });
      patch.weekday = body.weekday;
    }
    if ('time' in (body ?? {})) {
      if (!TIME.test(String(body.time ?? ''))) return json(res, 400, { error: 'Jam harus berbentuk HH:MM.' });
      patch.time = String(body.time);
    }
    if (!Object.keys(patch).length) return json(res, 400, { error: 'Tidak ada jadwal yang dikirim.' });
    const digest = hub.setDigest(patch);
    if (device) console.log(`Jadwal rekap mingguan diubah dari HP "${device.name}"`);
    return json(res, 200, { digest, unread: digestUnread(digest) });
  }, { maxBody: 1024 });

  // Opening Pola kerja marks the newest digest as read: the attention board item disappears.
  router.post('/api/digest/seen', ({ hub }, req, res) => {
    return json(res, 200, { digest: hub.markDigestSeen(), unread: false });
  }, { maxBody: 1024 });
}
