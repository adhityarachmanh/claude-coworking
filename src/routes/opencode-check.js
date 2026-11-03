// ⚙ Kompatibilitas OpenCode (src/opencode-check.js). Both routes are laptop only (LOCAL_ONLY in server.js): a phone
// never starts a check (it spawns `opencode acp`) nor changes its settings. The status itself reaches every browser
// through the config (config.opencodeCheck); WiFi read-only phones are refused by the default-deny allowlist.
import { OPENCODE_SETTING_KEYS } from '../opencode-check.js';
import { json } from './http.js';

export function register(router) {
  // Starts the light (token-free) check in the background: 202 + the view (running: true); 409 while one runs or a
  // turn is busy; 503 when OpenCode is not installed.
  router.post('/api/opencode-check/run', ({ opencodeCheck }, req, res) => {
    const { started, status, error } = opencodeCheck.runManual();
    if (!started) return json(res, status, { error });
    return json(res, 202, opencodeCheck.publicView());
  }, { maxBody: 1024 });

  // { autoCheck: boolean } → the view.
  router.post('/api/opencode-check/settings', ({ opencodeCheck }, req, res, params, body) => {
    const patch = {};
    for (const [key, value] of Object.entries(body ?? {})) {
      if (!OPENCODE_SETTING_KEYS.includes(key)) return json(res, 400, { error: `Pengaturan tidak dikenal: ${key.slice(0, 40)}` });
      if (typeof value !== 'boolean') return json(res, 400, { error: `${key} harus true atau false.` });
      patch[key] = value;
    }
    if (!Object.keys(patch).length) return json(res, 400, { error: 'Tidak ada pengaturan yang diubah.' });
    return json(res, 200, opencodeCheck.updateSettings(patch));
  }, { maxBody: 1024 });
}
