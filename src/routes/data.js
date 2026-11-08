// 🕵️ "Data saya": what the app keeps on this laptop, where, and two safe things to clear.
// Laptop only (server.js LOCAL_ONLY): sizes and paths are device-specific.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { TRASH_RETENTION_DAYS } from '../session-admin.js';
import { readAudit, recordAudit } from '../audit-log.js';
import { json } from './http.js';

/** Recursive byte count of a file or folder (missing = 0). */
function sizeOf(target) {
  let st;
  try {
    st = statSync(target);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names;
  try {
    names = readdirSync(target);
  } catch {
    return 0;
  }
  for (const name of names) total += sizeOf(path.join(target, name));
  return total;
}

function countFiles(target) {
  let names;
  try {
    names = readdirSync(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  return names.reduce((n, entry) => n + (entry.isDirectory() ? countFiles(path.join(target, entry.name)) : 1), 0);
}

function fileBytes(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export function register(router) {
  router.post('/api/data', ({ hub, ledger, push, dataDir }, req, res) => {
    const chats = sizeOf(path.join(dataDir, 'chats'));
    const chatsOpenCode = sizeOf(path.join(dataDir, 'chats-opencode'));
    const trash = path.join(dataDir, 'trash');
    return json(res, 200, {
      data: {
        state: { bytes: fileBytes(hub.file ?? path.join(dataDir, 'state.json')) },
        chats: { files: countFiles(path.join(dataDir, 'chats')) + countFiles(path.join(dataDir, 'chats-opencode')), bytes: chats + chatsOpenCode },
        usage: { bytes: fileBytes(ledger?.file ?? path.join(dataDir, 'usage.jsonl')) },
        pushHistory: { entries: push?.history?.length ?? 0, bytes: fileBytes(path.join(dataDir, 'push-history.json')) },
        trash: { files: countFiles(trash), bytes: sizeOf(trash), retentionDays: TRASH_RETENTION_DAYS },
        backups: { bytes: sizeOf(path.join(dataDir, 'backup-schedule')), files: countFiles(path.join(dataDir, 'backup-schedule')) },
      },
      note: 'Riwayat chat dan laporan pemakaian tidak dihapus dari sini. Mengosongkan trash bersifat permanen; cadangkan dulu bila perlu.',
      audit: readAudit(dataDir, 20),
    });  }, { maxBody: 1024 });

  router.post('/api/data/purge', async ({ push, dataDir }, req, res, params, body) => {
    const target = String(body?.target ?? '');
    if (target === 'push-history') {
      push?.clearHistory?.();
      recordAudit(dataDir, { action: 'data-purge', detail: 'riwayat notifikasi' });
      return json(res, 200, { ok: true, target });
    }
    if (target === 'trash') {
      try {
        if (existsSync(path.join(dataDir, 'trash'))) await rm(path.join(dataDir, 'trash'), { recursive: true, force: true });
      } catch (err) {
        return json(res, 500, { error: `Gagal mengosongkan trash: ${err.message}` });
      }
      recordAudit(dataDir, { action: 'data-purge', detail: 'trash sesi' });
      return json(res, 200, { ok: true, target });
    }
    return json(res, 400, { error: 'Target pembersihan tidak dikenal.' });
  }, { maxBody: 1024 });
}
