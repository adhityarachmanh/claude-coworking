// 🕵️ "Data saya": what the app keeps on this laptop, where, and two safe things to clear.
// Laptop only (server.js LOCAL_ONLY): sizes and paths are device-specific.
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { TRASH_RETENTION_DAYS } from '../session-admin.js';
import { readAudit, recordAudit } from '../audit-log.js';
import { DEMO_ID } from '../hub.js';
import { removeProjectBundles } from '../redo.js';
import { applyRetention, isRetentionDays, retentionOf, retentionPreview, setRetention } from '../retention.js';
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
  router.post('/api/data', ({ hub, ledger, push, dataDir }, req, res, params, body) => {
    const chats = sizeOf(path.join(dataDir, 'chats'));
    const chatsOpenCode = sizeOf(path.join(dataDir, 'chats-opencode'));
    const trash = path.join(dataDir, 'trash');
    const wanted = typeof body?.auditAction === 'string' ? body.auditAction : '';
    const audit = readAudit(dataDir, 200).filter((e) => !wanted || e.action === wanted).slice(0, 30);
    return json(res, 200, {
      data: {
        state: { bytes: fileBytes(hub.file ?? path.join(dataDir, 'state.json')) },
        chats: { files: countFiles(path.join(dataDir, 'chats')) + countFiles(path.join(dataDir, 'chats-opencode')), bytes: chats + chatsOpenCode },
        usage: { bytes: fileBytes(ledger?.file ?? path.join(dataDir, 'usage.jsonl')) },
        usageArchive: { files: countFiles(path.join(dataDir, 'usage-archive')), bytes: sizeOf(path.join(dataDir, 'usage-archive')) },
        queueFiles: { files: countFiles(path.join(dataDir, 'queue-files')), bytes: sizeOf(path.join(dataDir, 'queue-files')) },
        redo: { files: countFiles(path.join(dataDir, 'redo')), bytes: sizeOf(path.join(dataDir, 'redo')) },
        configBackups: { files: countFiles(path.join(dataDir, 'opencode-config-backups')), bytes: sizeOf(path.join(dataDir, 'opencode-config-backups')) },
        metrics: { bytes: fileBytes(path.join(dataDir, 'metrics.json')) },
        logs: { bytes: fileBytes(path.join(dataDir, 'server.log')) },
        pushHistory: { entries: push?.history?.length ?? 0, bytes: fileBytes(path.join(dataDir, 'push-history.json')) },
        trash: { files: countFiles(trash), bytes: sizeOf(trash), retentionDays: TRASH_RETENTION_DAYS },
        backups: { bytes: sizeOf(path.join(dataDir, 'backup-schedule')), files: countFiles(path.join(dataDir, 'backup-schedule')) },
      },
      note: 'Retensi di bawah menghapus pesan chat aplikasi dan baris laporan pemakaian yang lebih lama dari batas; transkrip sesi dan backup tidak disentuh. Hapus data project juga menghapus redo dan lampiran antrian project itu. Backup yang sudah dibuat tidak bisa dihapus per project.',
      audit,
      retention: retentionOf(hub),
    });
  }, { maxBody: 1024 });

  // 🗓 Retensi: preview (count only), save, and run. Laptop only (LOCAL_ONLY in server.js).
  router.post('/api/data/retention/preview', ({ hub, ledger }, req, res, params, body) => {
    const stored = retentionOf(hub);
    const retention = {
      chatsDays: isRetentionDays(body?.chatsDays) ? body.chatsDays : stored.chatsDays,
      usageDays: isRetentionDays(body?.usageDays) ? body.usageDays : stored.usageDays,
    };
    return json(res, 200, { ...retentionPreview(hub, ledger, Date.now(), retention), retention });
  }, { maxBody: 1024 });

  router.post('/api/data/retention/save', ({ hub }, req, res, params, body) => {
    try {
      return json(res, 200, { retention: setRetention(hub, body) });
    } catch (err) {
      if (Number.isInteger(err?.status)) return json(res, err.status, { error: err.message });
      throw err;
    }
  }, { maxBody: 1024 });

  router.post('/api/data/retention/run', ({ hub, ledger, dataDir }, req, res, params, body) => {
    const target = body?.target === undefined ? 'all' : String(body.target);
    if (target !== 'chats' && target !== 'usage' && target !== 'all') return json(res, 400, { error: 'Target retensi tidak dikenal.' });
    const stored = retentionOf(hub);
    // Applying one half keeps the other's setting untouched (it is simply not part of this run).
    const settings = {
      chatsDays: target === 'usage' ? 0 : stored.chatsDays,
      usageDays: target === 'chats' ? 0 : stored.usageDays,
    };
    try {
      const result = applyRetention(hub, ledger, Date.now(), settings);
      recordAudit(dataDir, {
        action: 'retention-run',
        detail: `target ${target}: chat ${result.chats.removed} pesan (${result.chats.projects} project), ledger ${result.usage.removed} baris (${result.usage.files} file)`,
      });
      return json(res, 200, { target, ...result });
    } catch (err) {
      console.error(`Retensi data gagal: ${err.message}`);
      return json(res, 500, { error: `Retensi data gagal: ${err.message}` });
    }
  }, { maxBody: 1024 });

  // 🧹 Hapus data satu project (chat, ledger, pengaturan, redo, antrian) tanpa menghapus project/folder-nya.
  router.post('/api/data/project', async ({ hub, ledger, taskQueue, dataDir }, req, res, params, body) => {
    if (body?.confirm !== 'HAPUS') return json(res, 400, { error: 'Konfirmasi tidak cocok. Ketik HAPUS untuk melanjutkan.' });
    const id = String(body?.projectId ?? '');
    const project = hub.projects.get(id);
    if (!project || id === DEMO_ID || project.virtual) return json(res, 404, { error: 'Project tidak ditemukan.' });
    taskQueue?.forget?.(id);
    ledger?.removeProject?.(id);
    hub.clearProjectData(id);
    try {
      await removeProjectBundles(dataDir, id);
    } catch (err) {
      console.error(`Redo project ${id} tidak bisa dihapus: ${err?.message ?? err}`);
    }
    recordAudit(dataDir, { action: 'data-purge', detail: `project ${project.name} (chat, ledger, pengaturan, redo, antrian)` });
    return json(res, 200, { ok: true });
  }, { maxBody: 1024 });

  // ⬇ CSV of the audit trail (laptop only, no conversation content).
  router.post('/api/data/audit-export', ({ dataDir }, req, res) => {
    const rows = readAudit(dataDir, 500).reverse();
    const csv = ['waktu,aksi,detail', ...rows.map((e) => [new Date(e.at).toISOString(), e.action, String(e.detail ?? '').replace(/"/g, '""')].map((v) => `"${v}"`).join(','))].join('\r\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="adhit-office-audit-${new Date().toLocaleDateString('sv-SE')}.csv"`, 'Cache-Control': 'no-store' });
    res.end(`\uFEFF${csv}\r\n`);
  }, { maxBody: 1024 });

  router.post('/api/data/purge', async ({ push, metrics, dataDir }, req, res, params, body) => {
    const target = String(body?.target ?? '');
    const purgeDir = async (name, label, detail) => {
      try {
        const dir = path.join(dataDir, name);
        if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
      } catch (err) {
        return json(res, 500, { error: `Gagal menghapus ${label}: ${err.message}` });
      }
      recordAudit(dataDir, { action: 'data-purge', detail });
      return json(res, 200, { ok: true, target });
    };
    if (target === 'push-history') {
      push?.clearHistory?.();
      recordAudit(dataDir, { action: 'data-purge', detail: 'riwayat notifikasi' });
      return json(res, 200, { ok: true, target });
    }
    if (target === 'trash') return purgeDir('trash', 'trash', 'trash sesi');
    if (target === 'redo') return purgeDir('redo', 'redo', 'bundel redo');
    if (target === 'config-backups') return purgeDir('opencode-config-backups', 'backup config OpenCode', 'backup config OpenCode');
    if (target === 'metrics') {
      try {
        metrics?.reset?.();
        if (existsSync(path.join(dataDir, 'metrics.json'))) await rm(path.join(dataDir, 'metrics.json'), { force: true });
      } catch (err) {
        return json(res, 500, { error: `Gagal menghapus riwayat kesehatan: ${err.message}` });
      }
      recordAudit(dataDir, { action: 'data-purge', detail: 'riwayat kesehatan' });
      return json(res, 200, { ok: true, target });
    }
    if (target === 'logs') {
      try {
        if (existsSync(path.join(dataDir, 'server.log'))) writeFileSync(path.join(dataDir, 'server.log'), '');
      } catch (err) {
        return json(res, 500, { error: `Gagal mengosongkan log server: ${err.message}` });
      }
      recordAudit(dataDir, { action: 'data-purge', detail: 'log server' });
      return json(res, 200, { ok: true, target });
    }
    return json(res, 400, { error: 'Target pembersihan tidak dikenal.' });
  }, { maxBody: 1024 });
}
