// ---------- /mcp servers and background tasks (/tasks, Ctrl+B, ⧗ Tugas latar) ----------
// task-output and task-detail are reads (allowed over WiFi); the rest act on Claude Code (refused there).
import { taskDetail } from '../task-detail.js';
import { answer, json } from './http.js';
import { withSession } from './project.js';

export function register(router) {
  // /mcp
  // ＋ Tambah server MCP (laptop only: it writes the engine's config and the server's command runs on this laptop)
  router.post('/api/projects/:id/mcp-add', withSession(async ({ hub, claude, opencode }, req, res, { project, session }, body) => {
    const { addMcpServer, McpAdminError } = await import('../mcp-admin.js');
    try {
      const engine = hub.engine;
      const result = await addMcpServer({ engine, bin: engine === 'opencode' ? opencode : claude, projectPath: project.path, request: body });
      console.log(`MCP ditambahkan (${engine}): ${String(body.name).slice(0, 60)} · ${project.name}`);
      session.reloadSettings?.(); // the next prompt starts with the new server (a running turn finishes first)
      return json(res, 200, result);
    } catch (err) {
      if (err instanceof McpAdminError) return json(res, err.status, { error: err.message });
      throw err;
    }
  }), { maxBody: 16 * 1024 });
  router.post('/api/projects/:id/mcp', withSession((ctx, req, res, { session }) => answer(res, session.mcpStatus().then((servers) => ({ servers })))));
  router.post('/api/projects/:id/mcp-action', withSession(({ hub }, req, res, { session }, body) => {
    const act = String(body.action ?? '');
    const callbackUrl = String(body.callbackUrl ?? '');
    // Claude Code wants the full redirect URL; OpenCode also takes the bare code some providers show
    if (act === 'callback' && !/^https?:\/\//.test(callbackUrl) && !(hub.engine === 'opencode' && /^[\w.~-]{4,2048}$/.test(callbackUrl))) return json(res, 400, { error: 'Tempel URL lengkap dari address bar setelah login.' });
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
