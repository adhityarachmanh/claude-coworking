// 💬 Tanya arsip (read-only + one paid Claude answer): search all transcripts, then answer from the excerpts only.
import { askArchive } from '../archive-ask.js';
import { searchSessions } from '../conversation.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/archive/ask', async ({ hub, claude }, req, res, params, body) => {
    const question = String(body?.question ?? '').trim();
    const projects = [...hub.projects.values()].filter((p) => p.id !== 'demo').map((p) => ({ ...p }));
    try {
      const found = searchSessions(projects, question, { limit: 12 });
      const results = found.results.map((r) => ({ ...r, projectName: hub.projects.get(r.projectId)?.name ?? 'project' }));
      const cwd = hub.projects.get(body?.project)?.path ?? projects[0]?.path ?? process.cwd();
      return json(res, 200, await askArchive({ claude, cwd, question, results }));
    } catch (err) {
      return json(res, Number.isInteger(err?.status) ? err.status : 502, { error: err.message });
    }
  }, { maxBody: 8 * 1024 });
}
