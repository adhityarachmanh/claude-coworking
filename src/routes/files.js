// ---------- 🔍 file search and 📄 Lihat file (read-only, inside the project) ----------
// Both are allowed over WiFi; `file` itself refuses likely secrets to every device but the laptop.
import { FileViewError, readProjectFile } from '../file-view.js';
import { searchFiles } from '../files.js';
import { json } from './http.js';
import { withSession } from './project.js';

export function register(router) {
  router.post('/api/projects/:id/files', withSession((ctx, req, res, { project }, body) => json(res, 200, { files: searchFiles(project.path, body.q) })));
  router.post('/api/projects/:id/file', withSession(async ({ isLocal }, req, res, { project }, body) => {
    // 📄 Lihat file: read-only, inside the project only. Likely secrets (.env, keys, credentials) need a click
    // on the laptop (`reveal`) and are never sent to another device, whatever the connection.
    try {
      return json(res, 200, await readProjectFile(project.path, body.path, { allowSecret: isLocal(req), reveal: body.reveal === true }));
    } catch (err) {
      if (err instanceof FileViewError) return json(res, err.status, { error: err.message });
      throw err;
    }
  }));
}
