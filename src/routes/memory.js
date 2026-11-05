// ---------- 🧠 Memory (/memory): CLAUDE.md / AGENTS.md editor (src/memory-files.js) ----------
// Read from the laptop or Tailscale only: these files steer every session (and the user-level one every project),
// and may hold private notes. A plain-WiFi phone is refused (it can't act anyway). Writing the project's files is
// allowed over Tailscale too; the user-level file (key "user": ~/.claude/CLAUDE.md, ~/.config/opencode/AGENTS.md)
// steers every project on this laptop, so it is written from the laptop only (like plugins and MCP servers).
import { MemoryError, memoryFiles, readMemory, writeMemory } from '../memory-files.js';
import { json } from './http.js';
import { withProject } from './project.js';

/** The project's engine (a fake hub in a test may only carry the app-wide one). */
const engineOf = (hub, id) => (hub.engineOf ? hub.engineOf(id) : (hub.engine ?? 'claude'));

const guard = (fn) => (ctx, req, res, params, body) => {
  if (ctx.isReadOnly?.(req) !== false) return json(res, 403, { error: 'Memory hanya bisa dibuka dari laptop atau lewat Tailscale.' });
  try {
    return fn(ctx, req, res, params, body);
  } catch (err) {
    if (err instanceof MemoryError) return json(res, err.status, { error: err.message });
    throw err;
  }
};

export function register(router) {
  // { key? } → { files: [{ key, label, hint, exists }], file: the chosen one with its content }
  router.post('/api/projects/:id/memory', withProject(guard(({ hub }, req, res, { project }, body) => {
    const engine = engineOf(hub, project.id);
    // One unreadable file (a symlink, a folder) does not hide the others: it is listed with its error.
    const files = memoryFiles(engine, project.path).map((f) => {
      try {
        return readMemory(engine, project.path, f.key);
      } catch (err) {
        if (!(err instanceof MemoryError)) throw err;
        return { ...f, exists: true, content: '', mtime: 0, error: err.message };
      }
    });
    const key = files.some((f) => f.key === body?.key) ? body.key : files[0].key;
    return json(res, 200, { engine, files: files.map(({ key: k, label, hint, exists }) => ({ key: k, label, hint, exists })), file: files.find((f) => f.key === key) });
  })));
  // { key, content, mtime } → the saved file
  router.post('/api/projects/:id/memory/save', withProject(guard(({ hub, isLocal }, req, res, { project }, body) => {
    const key = String(body?.key ?? '');
    if (key === 'user' && !isLocal(req)) return json(res, 403, { error: 'Memory semua project hanya bisa diubah dari laptop.' });
    const file = writeMemory(engineOf(hub, project.id), project.path, key, body?.content, body?.mtime);
    console.log(`Memory disimpan: ${file.path}`);
    return json(res, 200, { file });
  })), { maxBody: 300 * 1024 });
}
