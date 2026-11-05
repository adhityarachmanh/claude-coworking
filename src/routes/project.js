// Per-project routes (/api/projects/:id/...): the project lookup they all start with.
import { DEMO_ID } from '../hub.js';
import { json } from './http.js';

/** Wraps a handler: unknown project (or the demo) → 404; else params.project is the project. */
export const withProject = (fn) => (ctx, req, res, params, body) => {
  const project = ctx.hub.projects.get(params.id);
  if (!project || project.id === DEMO_ID) return json(res, 404, { error: 'project not found' });
  return fn(ctx, req, res, { ...params, project }, body);
};

/** Like withProject, plus params.session: the project's Claude Code session (created on first use). */
export const withSession = (fn) =>
  withProject((ctx, req, res, params, body) => fn(ctx, req, res, { ...params, session: ctx.sessions.get(params.project) }, body));

/**
 * Claude-only routes: refused while the project's engine is OpenCode (its own `settings.engine`; a route without a
 * project falls back to the app-wide default). The UI hides these surfaces with the same cap; this is the
 * server-side last line, so a direct API call can never read or change Claude config by accident.
 */
export const claudeOnly = (fn, feature = 'Fitur ini') => (ctx, req, res, params, body) => {
  const engine = params?.project && ctx.hub?.engineOf ? ctx.hub.engineOf(params.project.id) : (ctx.hub?.engine ?? 'claude');
  if (engine !== 'claude') return json(res, 409, { error: `${feature} hanya tersedia saat mesin Claude Code aktif.` });
  return fn(ctx, req, res, params, body);
};
