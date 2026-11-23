// ⏰ OpenCode automations: list from laptop/Tailscale; create/pause/resume/delete from the laptop only (an
// automation can run a prompt or Code Mode unattended and spend tokens).
import { createAutomation, deleteAutomation, listAutomations, pauseAutomation, resumeAutomation } from '../opencode-automations.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/opencode-automations', async ({ opencode }, req, res) => {
    if (!opencode) return json(res, 404, { error: 'OpenCode tidak ditemukan.' });
    try {
      return json(res, 200, { automations: await listAutomations(opencode) });
    } catch (err) {
      return json(res, err.status ?? 502, { error: err.message });
    }
  }, { maxBody: 1024 });

  router.post('/api/opencode-automations/save', async ({ opencode, hub }, req, res, params, body) => {
    if (!opencode) return json(res, 404, { error: 'OpenCode tidak ditemukan.' });
    const project = body?.project ? hub.projects.get(String(body.project)) : null;
    try {
      return json(res, 200, await createAutomation(opencode, { ...body, directory: project ? hub.workspacePathFor(project.id) : body?.directory }));
    } catch (err) {
      return json(res, err.status ?? 502, { error: err.message });
    }
  }, { maxBody: 32 * 1024 });

  router.post('/api/opencode-automations/action', async ({ opencode }, req, res, params, body) => {
    if (!opencode) return json(res, 404, { error: 'OpenCode tidak ditemukan.' });
    const action = String(body?.action ?? '');
    const run = action === 'pause' ? pauseAutomation : action === 'resume' ? resumeAutomation : action === 'delete' ? deleteAutomation : null;
    if (!run) return json(res, 400, { error: 'Aksi automation tidak dikenal.' });
    try {
      return json(res, 200, await run(opencode, body?.id));
    } catch (err) {
      return json(res, err.status ?? 502, { error: err.message });
    }
  }, { maxBody: 1024 });
}
