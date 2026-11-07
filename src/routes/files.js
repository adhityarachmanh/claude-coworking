// ---------- 🔍 file search and 📄 Lihat file (read-only, inside the project) ----------
// Both are allowed over WiFi; `file` itself refuses likely secrets to every device but the laptop.
import { DEMO_ID } from '../hub.js';
import { FileViewError, readProjectFile } from '../file-view.js';
import { searchFiles } from '../files.js';
import { json } from './http.js';
import { withSession } from './project.js';

const CROSS_PROJECTS = 8; // one search covers at most this many projects (each with its own short index)
const CROSS_PER_PROJECT = 3;
const CROSS_TOTAL = 24;

export function register(router) {
  router.post('/api/projects/:id/files', withSession((ctx, req, res, { project }, body) => json(res, 200, { files: searchFiles(project.path, body.q) })));
  // 🔎 The same file index across every real project (Ctrl+P `@query`): names only, never contents.
  router.post('/api/files/search', ({ hub }, req, res, params, body) => {
    const q = String(body?.q ?? '').trim().slice(0, 200);
    if (q.length < 2) return json(res, 200, { files: [] });
    const files = [];
    let seen = 0;
    for (const project of hub.projects.values()) {
      if (project.id === DEMO_ID || !project.path || seen >= CROSS_PROJECTS) continue;
      seen += 1;
      for (const filePath of searchFiles(project.path, q, CROSS_PER_PROJECT)) {
        files.push({ projectId: project.id, projectName: project.name, path: filePath });
        if (files.length >= CROSS_TOTAL) return json(res, 200, { files });
      }
    }
    return json(res, 200, { files });
  });
  router.post('/api/projects/:id/file', withSession(async ({ isLocal }, req, res, { project }, body) => {
    // 📄 Lihat file: read-only, inside the project only. Likely secrets (.env, keys, credentials) need a click
    // on the laptop (`reveal`) and are never sent to another device, whatever the connection.
    // A link to a screenshot/temp file outside the project: laptop only, explicit `outside` from the confirmed UI,
    // and file-view still limits it to home/temp (never an arbitrary drive or UNC path).
    if (body.outside === true && !isLocal(req)) return json(res, 403, { error: 'File di luar project hanya bisa dibuka dari laptop.' });
    try {
      return json(res, 200, await readProjectFile(project.path, body.path, { allowSecret: isLocal(req), reveal: body.reveal === true, allowOutside: isLocal(req) && body.outside === true }));
    } catch (err) {
      if (err instanceof FileViewError) return json(res, err.status, { error: err.message });
      throw err;
    }
  }));
}
