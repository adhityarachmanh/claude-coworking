// ---------- history backup (⚙ → Cadangkan riwayat) ----------
// Backup export/import read and write the whole Claude history: laptop only. server.js refuses these paths to
// every paired phone (LOCAL_ONLY, Tailscale too) and each handler checks isLocal again on its own.
// One export, import or scheduled backup at a time: ctx.backupLock (shared with the BackupScheduler in server.js).
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BackupError, isUnderHome, restoreBackup, writeBackup } from '../backup.js';
import { ScheduleError } from '../backup-schedule.js';
import { isDirectory } from '../projects.js';
import { projectId as idOfPath } from '../util.js';
import { ZipError } from '../zip.js';
import { HttpError, json } from './http.js';
import { cleanTeamNames } from './team.js';

const ZIP_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);

export function register(router) {
  router.post('/api/backup/export', exportBackup);
  // The one API whose body is not JSON (a raw .zip, far over MAX_BODY): server.js does not read it as JSON.
  router.post('/api/backup/import', importBackup, { rawBody: true });
  // POST /api/backup/schedule (read), /save (settings), /run (now, in the background). Laptop only (LOCAL_ONLY).
  router.post('/api/backup/schedule', laptopOnly(({ backupScheduler }, req, res) => json(res, 200, backupScheduler.view())));
  router.post('/api/backup/schedule/save', laptopOnly(async ({ backupScheduler }, req, res, params, body) => {
    try {
      return json(res, 200, await backupScheduler.save(body));
    } catch (err) {
      if (err instanceof ScheduleError) return json(res, err.status, { error: err.message });
      throw err;
    }
  }));
  router.post('/api/backup/schedule/run', laptopOnly(({ backupScheduler }, req, res) => {
    if (!backupScheduler.schedule.folder) return json(res, 400, { error: 'Atur folder tujuan dulu.' });
    const run = backupScheduler.run({ trigger: 'manual' });
    if (!run) return json(res, 409, { error: 'Export/import/backup lain sedang berjalan. Tunggu sampai selesai.' });
    return json(res, 202, backupScheduler.view()); // the result arrives as a backup-schedule event (and in /schedule)
  }));
  // Anything else under /api/backup/schedule: the same laptop check, then a 404.
  router.post('/api/backup/schedule*', laptopOnly((ctx, req, res) => json(res, 404, { error: 'not found' })));
}

/** The backup routes' own laptop check (in addition to server.js's LOCAL_ONLY gate). */
const laptopOnly = (fn) => (ctx, req, res, params, body) => {
  if (!ctx.isLocal(req)) return json(res, 403, { error: 'Backup hanya bisa dari laptop.' });
  return fn(ctx, req, res, params, body);
};

/** Session ids a Claude Code process may be writing right now (web sessions alive, CLI turns running). */
function activeSessionIds(hub) {
  const ids = new Set();
  for (const rt of hub.runtime.values()) {
    const st = rt.status;
    if (st.alive && st.sessionId) ids.add(st.sessionId);
    if (st.cliBusy && st.cliSession) ids.add(st.cliSession);
  }
  return ids;
}

/** POST /api/backup/export: the backup .zip, streamed (never held in memory). */
async function exportBackup({ hub, ledger, isLocal, backupLock, appVersion }, req, res) {
  if (!isLocal(req)) return json(res, 403, { error: 'Backup hanya bisa dari laptop.' });
  if (backupLock.busy) return json(res, 409, { error: 'Export/import riwayat lain sedang berjalan. Tunggu sampai selesai.' });
  backupLock.busy = true;
  try {
    hub.save(); // the state file on disk and in the backup agree
    const name = `adhit-office-backup-${new Date().toLocaleDateString('sv-SE')}.zip`; // local date, YYYY-MM-DD
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    const result = await writeBackup(res, { state: hub.exportState(), usageFile: ledger.file, chatsDir: hub.backupChatsDir(), engineChats: hub.backupEngineChats(), appVersion });
    res.end();
    const skipped = result.skipped.length ? `, ${result.skipped.length} dilewati (symlink/nama tidak valid)` : '';
    console.log(`Backup riwayat diekspor: ${result.files} file, ${(result.bytes / 1024 ** 2).toFixed(1)} MB${skipped}`);
  } catch (err) {
    console.error('Export backup gagal:', err?.stack ?? err);
    // Headers are out: cut the connection so the browser reports a failed download, not a broken .zip.
    if (res.headersSent) res.destroy();
    else json(res, 500, { error: 'Export gagal. Lihat log server.' });
  } finally {
    backupLock.busy = false;
  }
}

/** Streams the request body to `file`, refusing it (413) once it passes `limit` bytes. */
async function receiveUpload(req, file, limit) {
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > limit) cb(new HttpError(413, `File backup terlalu besar (maks ${Math.round(limit / 1024 ** 2)} MB).`));
      else cb(null, chunk);
    },
  });
  // A dropped upload must not leave the temp file open.
  req.once('close', () => !req.complete && counter.destroy(new HttpError(400, 'Upload terputus.')));
  req.once('error', (err) => counter.destroy(err));
  req.pipe(counter);
  try {
    await pipeline(counter, createWriteStream(file)); // req stays out of the pipeline, so a 413 can still be answered
  } finally {
    req.unpipe(counter);
  }
  return size;
}

/** POST /api/backup/import: raw .zip body → temp file in <data dir>/tmp → merged restore → JSON summary. */
async function importBackup({ hub, ledger, mirror, isLocal, backupLock, dataDir, maxBackupBytes, projectRoots, refreshProjects }, req, res) {
  if (!isLocal(req)) return json(res, 403, { error: 'Backup hanya bisa dari laptop.' });
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!ZIP_TYPES.has(type)) return json(res, 415, { error: 'Kirim file .zip hasil Export riwayat.' });
  // A backup is Claude Code's history: imported into another engine's workspace it would mix with that engine's chats.
  if (hub.engine !== 'claude') {
    res.on('finish', () => req.destroy());
    return json(res, 409, { error: 'Import riwayat hanya saat mesin Claude Code aktif. Pindah ke Claude Code di 👤 Akun dulu.' });
  }
  if (Number(req.headers['content-length']) > maxBackupBytes) throw new HttpError(413, `File backup terlalu besar (maks ${Math.round(maxBackupBytes / 1024 ** 2)} MB).`);
  if (backupLock.busy) {
    res.on('finish', () => req.destroy()); // don't read an upload that is refused
    return json(res, 409, { error: 'Export/import riwayat lain sedang berjalan. Tunggu sampai selesai.' });
  }
  backupLock.busy = true;
  const tmpDir = path.join(dataDir, 'tmp');
  const file = path.join(tmpDir, `import-${Date.now()}-${randomBytes(4).toString('hex')}.zip`);
  try {
    await mkdir(tmpDir, { recursive: true });
    await receiveUpload(req, file, maxBackupBytes);
    const running = [...hub.runtime.values()].some((rt) => rt.status.busy || rt.status.cliBusy);
    const result = await restoreBackup(file, { activeSessions: activeSessionIds(hub), ledger, onFileWritten: (f) => mirror.markSeen(f) });
    const { summary, state: imported, remap } = result;
    if (running) summary.warnings.unshift('Ada sesi Claude yang sedang berjalan saat import: file sesinya tidak ditimpa. Import lagi setelah selesai bila perlu.');

    // Office state: folders first (they decide which projects exist here), then per-project data by id.
    // A backup names folders (roots, added folders, project paths): only ones below this home are used.
    const home = os.homedir();
    const outside = (p) => `Folder dari backup dilewati (di luar folder home ${home}, atau tidak ada): ${p}. Tambahkan manual bila perlu.`;
    summary.state = { roots: 0, custom: 0, favorites: 0, settings: 0, chats: 0, teamNames: 0 };
    if (imported) {
      const { skipped, ...added } = hub.mergeFolders(imported, { mapPath: remap.mapPath, roots: projectRoots(), accept: (p) => isUnderHome(p, home) && isDirectory(p) });
      Object.assign(summary.state, added);
      for (const p of skipped) summary.warnings.push(outside(p));
    }
    refreshProjects();
    // Projects whose history came back are listed when their folder exists on this machine.
    summary.projectsAdded = [];
    for (const p of result.projects) {
      if (!p.cwd || !p.sessions || hub.projects.has(idOfPath(p.cwd))) continue;
      if (!isUnderHome(p.cwd, home)) {
        summary.warnings.push(outside(p.cwd));
      } else if (isDirectory(p.cwd)) {
        hub.addCustomProject(p.cwd);
        summary.projectsAdded.push(p.cwd);
      } else {
        summary.warnings.push(`Folder project belum ada di laptop ini: ${p.cwd}. Riwayatnya sudah dipulihkan; project muncul setelah foldernya ada (clone/salin, lalu ⚙ → tambah folder).`);
      }
    }
    if (imported) {
      const idMap = new Map();
      for (const p of hub.projects.values()) {
        if (!p.path) continue;
        idMap.set(p.id, p.id);
        idMap.set(idOfPath(remap.unmapPath(path.resolve(p.path))), p.id); // the id this folder had on the old machine
      }
      Object.assign(summary.state, hub.mergeProjectData(imported, idMap, result.chats));
      for (const [engine, chats] of Object.entries(result.engineChats ?? {})) summary.state.chats += hub.importEngineChats(engine, idMap, chats);
      // Team names: only roles this machine has not renamed itself.
      const own = hub.persisted.teamNames ?? {};
      const names = { ...cleanTeamNames(imported.teamNames), ...own };
      summary.state.teamNames = Object.keys(names).length - Object.keys(own).length;
      hub.persisted.teamNames = names;
    }
    hub.save();
    refreshProjects(); // broadcasts config + projects: every open page shows the restored history
    if (!mirror.running) mirror.start(); // ~/.claude/projects may only exist since this import
    console.log(`Backup riwayat diimpor: ${summary.projects} project, sesi +${summary.sessions.added} diperbarui ${summary.sessions.updated}`);
    return json(res, 200, summary);
  } catch (err) {
    if (err instanceof ZipError) return json(res, 400, { error: `File backup tidak valid: ${err.message}` });
    if (err instanceof BackupError) return json(res, err.status, { error: err.message });
    throw err;
  } finally {
    // Unlocked first: the answer is already out, and the next import must not see a lock held only by the temp
    // file's cleanup (Windows retries rm for a while). The file name is unique, so nothing else uses it.
    backupLock.busy = false;
    await rm(file, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
