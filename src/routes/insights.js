// 📈 Pola kerja (read-only): the usage ledger aggregated per project, model, and hour. Laptop/Tailscale only — the
// names can reveal what someone works on, which a plain-WiFi page must not receive.
import { insightSummary } from '../insights.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/insights', ({ ledger }, req, res, params, body) => {
    const days = Number(body?.days ?? 30);
    if (![7, 30, 90].includes(days)) return json(res, 400, { error: 'Rentang laporan harus 7, 30, atau 90 hari.' });
    const rows = ledger?.query?.({ accountId: 'all', from: Date.now() - days * 86_400_000 }) ?? [];
    return json(res, 200, insightSummary(rows, { days }));
  }, { maxBody: 1024 });
}
