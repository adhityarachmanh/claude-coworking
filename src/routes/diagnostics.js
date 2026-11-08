// 🩺 Bundel diagnostik: one .zip with versions, health, project summary and the tail of server.log.
// Laptop only (server.js LOCAL_ONLY): the log can name local folders, so it never goes to a paired phone.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { buildHealth } from '../health.js';
import { ZipWriter } from '../zip.js';
import { json } from './http.js';

const MAX_LOG = 512 * 1024;
/** Keep the user's home folder out of an archive that is meant to be shared. */
const redact = (text) => String(text).split(homedir()).join('~');

export function register(router) {
  router.post(
    '/api/diagnostics/export',
    async (ctx, req, res) => {
      if (!ctx.isLocal(req)) return json(res, 403, { error: 'Bundel diagnostik hanya bisa diunduh dari laptop.' });
      const { hub, ledger, dataDir, appVersion } = ctx;
      const now = new Date();
      const info = {
        app: appVersion ?? null,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        time: now.toISOString(),
        uptimeSec: Math.round(process.uptime()),
        projects: [...hub.projects.values()]
          .filter((p) => p.path)
          .map((p) => ({ id: p.id, name: p.name, engine: hub.engineOf(p.id), folder: path.basename(p.path) })),
        usageRecords: typeof ledger?.query === 'function' ? ledger.query({ accountId: 'all' }).length : null,
      };
      let health;
      try {
        health = buildHealth(ctx);
      } catch {
        health = { status: 'unknown' };
      }
      let log;
      try {
        log = readFileSync(path.join(dataDir, 'server.log'), 'utf8').slice(-MAX_LOG);
      } catch {
        log = '(server.log belum ada)';
      }
      const files = [
        ['info.json', JSON.stringify(info, null, 2)],
        ['health.json', JSON.stringify(health, null, 2)],
        ['server.log', log],
        ['README.txt', 'Bundel diagnostik Adhit Office.\n\n- info.json: versi, platform, jumlah project dan catatan pemakaian\n- health.json: hasil Kesehatan sistem\n- server.log: 512 KB terakhir log server (folder home disamarkan sebagai ~)\n\nTidak berisi isi percakapan, token, atau kunci push.'],
      ];
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="adhit-office-diagnostik-${now.toLocaleDateString('sv-SE')}.zip"`,
        'Cache-Control': 'no-store',
      });
      const zip = new ZipWriter(res);
      try {
        for (const [name, text] of files) await zip.add(name, Buffer.from(redact(text), 'utf8'));
        await zip.finish();
      } catch {
        res.destroy(); // the browser reports a failed download, not a broken .zip
        return;
      }
      res.end();
    },
    { maxBody: 1024 },
  );
}
