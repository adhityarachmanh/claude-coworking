// bridge/netlify/functions/scheduled.mjs — cron jembatan: tiap menit mengeksekusi jadwal mati yang jatuh tempo
// (lihat scheduledSweep di src/bridge.mjs). Limit eksekusi scheduled function Netlify = 30 dtk:
// sweep sengaja satu pass per tick tanpa loop, jadi aman.
import { getStore } from '@netlify/blobs';
import { scheduledSweep } from '../../src/bridge.mjs';

export const config = { schedule: '* * * * *' };

export default async () => {
  const store = getStore({ name: 'adhitron-bridge', consistency: 'strong' });
  await scheduledSweep({ store, encryptionKey: process.env.ENCRYPTION_KEY });
};
