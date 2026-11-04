// ---------- the project list: folders to scan, added folders, per-project settings ----------
// /api/projects and /api/config point Claude Code (and git, file search) at any path: laptop only (LOCAL_ONLY in
// server.js). Opening VS Code / Explorer (`open`) is laptop only too (LOCAL_ONLY_ACTION).
import { modelsOffered, openCodeModelEfforts, openCodeModels } from '../opencode-bin.js';
import path from 'node:path';
import { isDirectory, isNetworkPath } from '../projects.js';
import { openInApp } from '../open.js';
import { json } from './http.js';
import { withSession } from './project.js';

export function register(router) {
  router.post('/api/projects', ({ hub }, req, res, params, body) => {
    const dir = String(body.path ?? '').trim();
    if (isNetworkPath(dir)) return json(res, 400, { error: 'Folder jaringan (\\server\share) tidak didukung. Pakai folder di laptop ini.' });
    if (!path.isAbsolute(dir) || !isDirectory(dir)) return json(res, 400, { error: 'Folder tidak ditemukan' });
    return json(res, 200, hub.addCustomProject(dir));
  });
  router.post('/api/config', ({ hub, refreshProjects }, req, res, params, body) => {
    const roots = [...new Set((Array.isArray(body.roots) ? body.roots : []).map((r) => String(r).trim()).filter(Boolean))];
    const invalid = roots.filter((r) => !path.isAbsolute(r) || !isDirectory(r));
    if (invalid.length) return json(res, 400, { error: `Folder tidak ditemukan: ${invalid.join(', ')}` });
    hub.persisted.roots = roots.map((r) => path.resolve(r));
    hub.save();
    refreshProjects();
    return json(res, 200, hub.config);
  });
  router.post('/api/projects/refresh', ({ refreshProjects }, req, res) => {
    refreshProjects();
    return json(res, 200, { ok: true });
  });
}

/** Per-project actions; registered with the other /api/projects/:id routes (see index.js). */
export function registerProjectActions(router) {
  router.post('/api/projects/:id/settings', withSession(({ hub }, req, res, { project, session }, body) => {
    // The engine is app-wide (POST /api/engine, Akun): a project's settings never change it.
    hub.updateSettings(project.id, body);
    session.syncSettings(); // switches the running Claude Code live (mid-turn too, like Shift+Tab)
    return json(res, 200, { ok: true });
  }));
  // The model picker of a non-Claude engine (OpenCode: `opencode models` for the providers set up on this laptop).
  router.post('/api/projects/:id/models', withSession(async ({ hub, opencode, sessions }, req, res, { project }) => {
    const s = hub.settingsFor(project.id);
    if (s.engine !== 'opencode') return json(res, 200, { engine: s.engine, models: [], current: s.model, needsStart: false });
    let values = await openCodeModels(opencode);
    // `opencode models` empty (its service just started, catalog still loading): the models a running ACP session of
    // any project offers (configOptions "model") are the same list, so the picker isn't left empty meanwhile.
    if (!values.length) values = modelsOffered(sessions.sessions.values());
    // each model's own effort levels (null = unknown: the picker offers the generic list and the nearest is used)
    const efforts = await openCodeModelEfforts(opencode);
    const models = values.map((value) => ({ value, name: `${value.slice(value.indexOf('/') + 1)}${/free/i.test(value) ? ' (gratis)' : ''}`, efforts: efforts.has(value) ? efforts.get(value) : null }));
    // An empty list (OpenCode still starting, or `opencode models` failed): the picker asks again shortly.
    return json(res, 200, { engine: 'opencode', models, current: s.model, needsStart: !models.length });
  }));
  router.post('/api/projects/:id/favorite', withSession(({ hub }, req, res, { project }, body) => {
    hub.setFavorite(project.id, Boolean(body.on));
    return json(res, 200, { ok: true, favorite: Boolean(body.on) });
  }));
  router.post('/api/projects/:id/forget', withSession(({ hub, sessions, taskQueue }, req, res, { project, session }) => {
    taskQueue.forget(project.id);
    session.reset();
    session.kill();
    sessions.sessions.delete(project.id);
    return json(res, hub.forgetProject(project.id) ? 200 : 400, { ok: true });
  }));
  router.post('/api/projects/:id/open', withSession((ctx, req, res, { project }, body) => {
    const app = body.app === 'folder' ? 'folder' : 'code';
    // A file must resolve inside the project: never open arbitrary paths sent by a client.
    const file = body.file ? path.resolve(project.path, String(body.file)) : null;
    if (file && !file.startsWith(path.resolve(project.path) + path.sep)) return json(res, 400, { error: 'File di luar project.' });
    const line = Number.isInteger(body.line) && body.line > 0 && body.line < 1e7 ? body.line : null;
    return json(res, 200, { ok: true, ...openInApp(app, project.path, { file, line }) });
  }));
}
