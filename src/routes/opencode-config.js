// OpenCode config/agent editor (src/opencode-config.js): laptop only, one file at a time. The route never starts
// OpenCode; it validates, writes with a backup, and lets idle OpenCode processes pick the new config up next time.
// Backups live in the app's data folder (ctx.hub.dataDir); a save/restore/consolidate is refused while a turn runs.
import { OpenCodeConfigError, consolidateProjectConfig, listBackups, readBackup, readOpenCodeConfig, restoreBackup, saveOpenCodeConfig } from '../opencode-config.js';
import { json } from './http.js';

const hasRunningTurn = (sessions) => [...(sessions?.sessions?.values() ?? [])].some((s) => s.turnActive?.());
const TURN_RUNNING = 'Tidak bisa mengubah config OpenCode saat masih ada giliran yang berjalan.';
/** The lock the editor read; absent (not sent) is different from `null` (the file did not exist yet). */
const baseHashOf = (body) => (body && Object.hasOwn(body, 'baseHash') ? body.baseHash : undefined);

const target = (ctx, body) => {
  if (body?.scope === 'global') return { scope: 'global' };
  if (body?.scope !== 'project') throw new OpenCodeConfigError(400, 'Cakupan config harus global atau project.');
  const project = ctx.hub.projects.get(String(body.projectId ?? ''));
  if (!project || project.virtual) throw new OpenCodeConfigError(404, 'Project tidak ditemukan.');
  return { scope: 'project', projectPath: project.path, projectId: project.id };
};

const reply = (res, fn) => {
  try {
    return json(res, 200, fn());
  } catch (err) {
    if (err instanceof OpenCodeConfigError) return json(res, err.status, err.code ? { error: err.message, code: err.code } : { error: err.message }); // 409s carry a code
    throw err;
  }
};

const busy = (res) => json(res, 409, { error: TURN_RUNNING, code: 'busy' });

export function register(router) {
  router.post(
    '/api/opencode-config',
    (ctx, req, res, params, body) => {
      if (!ctx.opencode) return json(res, 404, { error: 'OpenCode belum terpasang di laptop ini.' });
      return reply(res, () => readOpenCodeConfig(target(ctx, body)));
    },
    { maxBody: 1024 },
  );

  router.post(
    '/api/opencode-config/save',
    (ctx, req, res, params, body) => {
      if (!ctx.opencode) return json(res, 404, { error: 'OpenCode belum terpasang di laptop ini.' });
      if (hasRunningTurn(ctx.sessions)) return busy(res);
      return reply(res, () => {
        const where = target(ctx, body);
        const saved = saveOpenCodeConfig({ ...where, dataDir: ctx.hub.dataDir, mode: body.mode, text: body.text, form: body.form, baseHash: baseHashOf(body) });
        const restarted = ctx.sessions.openCodeConfigChanged(where.scope === 'project' ? where.projectId : null);
        return { ...saved, restarted };
      });
    },
    { maxBody: 1024 * 1024 },
  );

  // The backups of one scope, newest first (also prunes old ones).
  router.post(
    '/api/opencode-config/backups',
    (ctx, req, res, params, body) => {
      if (!ctx.opencode) return json(res, 404, { error: 'OpenCode belum terpasang di laptop ini.' });
      return reply(res, () => ({ backups: listBackups(target(ctx, body), ctx.hub.dataDir) }));
    },
    { maxBody: 1024 },
  );

  // One backup's text, for the preview before a restore.
  router.post(
    '/api/opencode-config/backup',
    (ctx, req, res, params, body) => {
      if (!ctx.opencode) return json(res, 404, { error: 'OpenCode belum terpasang di laptop ini.' });
      return reply(res, () => readBackup(target(ctx, body), ctx.hub.dataDir, body?.id));
    },
    { maxBody: 1024 },
  );

  router.post(
    '/api/opencode-config/restore',
    (ctx, req, res, params, body) => {
      if (!ctx.opencode) return json(res, 404, { error: 'OpenCode belum terpasang di laptop ini.' });
      if (hasRunningTurn(ctx.sessions)) return busy(res);
      return reply(res, () => {
        const where = target(ctx, body);
        const restored = restoreBackup(where, ctx.hub.dataDir, body?.id, { baseHash: baseHashOf(body) });
        const restarted = ctx.sessions.openCodeConfigChanged(where.scope === 'project' ? where.projectId : null);
        return { ...restored, restarted };
      });
    },
    { maxBody: 1024 },
  );

  // Root opencode.json + .opencode/opencode.json into one file (project scope only).
  router.post(
    '/api/opencode-config/consolidate',
    (ctx, req, res, params, body) => {
      if (!ctx.opencode) return json(res, 404, { error: 'OpenCode belum terpasang di laptop ini.' });
      if (hasRunningTurn(ctx.sessions)) return busy(res);
      return reply(res, () => {
        const where = target(ctx, { ...body, scope: 'project' });
        const result = consolidateProjectConfig({ projectPath: where.projectPath, projectId: where.projectId, dataDir: ctx.hub.dataDir, baseHash: baseHashOf(body) });
        const restarted = ctx.sessions.openCodeConfigChanged(where.projectId);
        return { ...result, restarted };
      });
    },
    { maxBody: 1024 },
  );
}

