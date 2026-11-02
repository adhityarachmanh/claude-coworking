// ---------- the project list: folders to scan, added folders, per-project settings ----------
// /api/projects and /api/config point Claude Code (and git, file search) at any path: laptop only (LOCAL_ONLY in
// server.js). Opening VS Code / Explorer (`open`) is laptop only too (LOCAL_ONLY_ACTION).
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
    hub.updateSettings(project.id, body);
    session.syncSettings(); // switches the running Claude Code live (mid-turn too, like Shift+Tab)
    return json(res, 200, { ok: true });
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
