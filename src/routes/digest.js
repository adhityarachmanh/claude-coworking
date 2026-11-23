// 📅 Rekap mingguan: read-only summary of the ledger's last 7 days (laptop/Tailscale; project names are sensitive).
import { weeklyDigest } from '../digest.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/digest', ({ ledger }, req, res) => {
    const rows = ledger?.query?.({ accountId: 'all', from: Date.now() - 7 * 86_400_000 }) ?? [];
    return json(res, 200, weeklyDigest(rows));
  }, { maxBody: 1024 });
}
