// OpenCode config/agent editor (src/opencode-config.js): laptop only, one file at a time. The route never starts
// OpenCode; it validates, writes with a backup, and lets idle OpenCode processes pick the new config up next time.
import { OpenCodeConfigError, readOpenCodeConfig, saveOpenCodeConfig } from '../opencode-config.js';
import { json } from './http.js';

const hasRunningTurn = (sessions) => [...(sessions?.sessions?.values() ?? [])].some((s) => s.turnActive?.());

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
    if (err instanceof OpenCodeConfigError) return json(res, err.status, { error: err.message });
    throw err;
  }
};

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
      if (hasRunningTurn(ctx.sessions)) return json(res, 409, { error: 'Tidak bisa mengubah config OpenCode saat masih ada giliran yang berjalan.' });
      return reply(res, () => {
        const where = target(ctx, body);
        const saved = saveOpenCodeConfig({ ...where, mode: body.mode, text: body.text, form: body.form });
        const restarted = ctx.sessions.openCodeConfigChanged(where.scope === 'project' ? where.projectId : null);
        return { ...saved, restarted };
      });
    },
    { maxBody: 1024 * 1024 },
  );
}
