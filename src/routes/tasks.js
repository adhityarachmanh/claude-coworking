// ---------- /mcp servers and background tasks (/tasks, Ctrl+B, ⧗ Tugas latar) ----------
// task-output and task-detail are reads (allowed over WiFi); the rest act on Claude Code (refused there).
import { taskDetail } from '../task-detail.js';
import { answer, json } from './http.js';
import { withSession } from './project.js';

export function register(router) {
  // /mcp
  router.post('/api/projects/:id/mcp', withSession((ctx, req, res, { session }) => answer(res, session.mcpStatus().then((servers) => ({ servers })))));
  router.post('/api/projects/:id/mcp-action', withSession((ctx, req, res, { session }, body) => {
    const act = String(body.action ?? '');
    const callbackUrl = String(body.callbackUrl ?? '');
    if (act === 'callback' && !/^https?:\/\//.test(callbackUrl)) return json(res, 400, { error: 'Tempel URL lengkap dari address bar setelah login.' });
    return answer(res, session.mcpAction(String(body.server ?? ''), act, callbackUrl));
  }));
  // /tasks, Ctrl+B
  router.post('/api/projects/:id/task-output', withSession((ctx, req, res, { session }, body) => answer(res, session.taskOutput(String(body.taskId ?? '')))));
  router.post('/api/projects/:id/task-detail', withSession(({ hub }, req, res, { project }, body) => {
    // Read-only monitor (⧗ Tugas latar): the task must be one of this session's own; files are found server-side.
    const taskId = String(body.taskId ?? '');
    if (!taskId) return json(res, 400, { error: 'taskId kosong' });
    const task = (hub.rt(project.id).status.tasks ?? []).find((t) => t.id === taskId);
    if (!task) return json(res, 404, { error: 'Tugas tidak ditemukan (mungkin sudah dibersihkan).' });
    return json(res, 200, taskDetail(project.path, hub.sessionIdFor(project.id), task));
  }));
  router.post('/api/projects/:id/task-stop', withSession((ctx, req, res, { session }, body) => answer(res, session.stopTask(String(body.taskId ?? '')))));
  router.post('/api/projects/:id/background', withSession((ctx, req, res, { session }) => answer(res, session.backgroundTasks())));
}
