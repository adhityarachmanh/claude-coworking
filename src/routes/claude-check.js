// ⚙ Cek kompatibilitas Claude Code (src/claude-check.js). Both routes are laptop only (LOCAL_ONLY in server.js):
// a phone never starts a check (it spawns Claude Code, maybe a model call) nor changes its settings. The status
// itself reaches every browser through the config (config.claudeCheck).
import { json } from './http.js';

const SETTING_KEYS = ['autoCheck', 'allowModel'];

export function register(router) {
  // Starts the light check in the background: 202 + the view (running: true); 409 while one runs or a turn is busy.
  router.post('/api/claude-check/run', ({ claudeCheck }, req, res) => {
    const { started, status, error } = claudeCheck.runManual();
    if (!started) return json(res, status, { error });
    return json(res, 202, claudeCheck.publicView());
  }, { maxBody: 1024 });

  // { autoCheck?: boolean, allowModel?: boolean } → the view.
  router.post('/api/claude-check/settings', ({ claudeCheck }, req, res, params, body) => {
    const patch = {};
    for (const [key, value] of Object.entries(body ?? {})) {
      if (!SETTING_KEYS.includes(key)) return json(res, 400, { error: `Pengaturan tidak dikenal: ${key.slice(0, 40)}` });
      if (typeof value !== 'boolean') return json(res, 400, { error: `${key} harus true atau false.` });
      patch[key] = value;
    }
    if (!Object.keys(patch).length) return json(res, 400, { error: 'Tidak ada pengaturan yang diubah.' });
    return json(res, 200, claudeCheck.updateSettings(patch));
  }, { maxBody: 1024 });
}
