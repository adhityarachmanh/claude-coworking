// bridge/netlify/functions/scheduled.mjs — cron jembatan: tiap menit mengeksekusi jadwal mati yang jatuh tempo
// (lihat scheduledSweep di src/bridge.mjs). Limit eksekusi scheduled function Netlify = 30 dtk:
// sweep sengaja satu pass per tick tanpa loop, jadi aman.
// Juga menjalankan retensi Chat Web (sesi kedaluwarsa + jejak tool_run tua) bila DATABASE_URL diset.
import { getStore } from '@netlify/blobs';
import { scheduledSweep } from '../../src/bridge.mjs';
import { createNeonDb } from '../../src/db.mjs';
import { makeSqlRepo } from '../../src/repo.mjs';
import { sweepChatRetention } from '../../src/retention.mjs';

export const config = { schedule: '* * * * *' };

/** Retensi Chat Web best-effort: kegagalan DB tidak boleh menggagalkan sweep jembatan. */
async function chatRetention() {
  if (!process.env.DATABASE_URL) return;
  try {
    const repo = makeSqlRepo(await createNeonDb(process.env.DATABASE_URL));
    await sweepChatRetention(repo);
  } catch (err) {
    // Jangan gagalkan sweep jembatan, tetapi jangan telan diam-diam: retensi yang tak jalan berarti
    // data hidup melebihi janji kebijakan. Catat agar terlihat di log fungsi Netlify.
    console.error('[retention] sweep gagal:', err?.message ?? err);
  }
}

export default async () => {
  const store = getStore({ name: 'adhitron-bridge', consistency: 'strong' });
  await scheduledSweep({ store, encryptionKey: process.env.ENCRYPTION_KEY });
  await chatRetention();
};