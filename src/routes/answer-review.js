// 🧪 Nilai jawaban terakhir: one paid, tool-less review of an answer the browser holds. Laptop/Tailscale only.
import { reviewAnswer } from '../answer-review.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/answer-review', async ({ claude, hub }, req, res, params, body) => {
    const project = body?.project ? hub.projects.get(String(body.project)) : null;
    const cwd = project ? hub.workspacePathFor(project.id) : hub.projects.values().next().value?.path ?? process.cwd();
    try {
      return json(res, 200, await reviewAnswer({ claude, cwd, answer: body?.answer, question: body?.question, focus: body?.focus, model: body?.model }));
    } catch (err) {
      return json(res, Number.isInteger(err?.status) ? err.status : 502, { error: err.message });
    }
  }, { maxBody: 48 * 1024 });
}
