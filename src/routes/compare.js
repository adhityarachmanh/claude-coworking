// ⚖️ Bandingkan dua model Claude pada pertanyaan yang sama. Laptop only: it spawns two paid, tool-less runs.
import { compareModels } from '../compare.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/compare', async ({ claude, hub }, req, res, params, body) => {
    const project = body?.project ? hub.projects.get(String(body.project)) : null;
    const cwd = project ? hub.workspacePathFor(project.id) : hub.projects.values().next().value?.path ?? process.cwd();
    try {
      return json(res, 200, await compareModels({ claude, cwd, prompt: body?.prompt, models: body?.models }));
    } catch (err) {
      return json(res, Number.isInteger(err?.status) ? err.status : 502, { error: err.message });
    }
  }, { maxBody: 32 * 1024 });
}
