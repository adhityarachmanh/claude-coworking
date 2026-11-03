// ---------- 🧠 Memory (/memory): CLAUDE.md / AGENTS.md editor (src/memory-files.js) ----------
// Read and write from the laptop or Tailscale only: these files steer every session (and the user-level one
// every project), and may hold private notes. A plain-WiFi phone is refused (it can't act anyway).
import { MemoryError, memoryFiles, readMemory, writeMemory } from '../memory-files.js';
import { json } from './http.js';
import { withProject } from './project.js';

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
    const engine = hub.engine;
    const files = memoryFiles(engine, project.path).map((f) => readMemory(engine, project.path, f.key));
    const key = files.some((f) => f.key === body?.key) ? body.key : files[0].key;
    return json(res, 200, { engine, files: files.map(({ key: k, label, hint, exists }) => ({ key: k, label, hint, exists })), file: files.find((f) => f.key === key) });
  })));
  // { key, content, mtime } → the saved file
  router.post('/api/projects/:id/memory/save', withProject(guard(({ hub }, req, res, { project }, body) => {
    const file = writeMemory(hub.engine, project.path, String(body?.key ?? ''), body?.content, body?.mtime);
    console.log(`Memory disimpan: ${file.path}`);
    return json(res, 200, { file });
  })), { maxBody: 300 * 1024 });
}
