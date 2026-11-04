// ⚙ Kompatibilitas OpenCode (src/opencode-check.js). These routes are laptop only (LOCAL_ONLY in server.js): a phone
// never starts a check (it spawns `opencode acp`), updates OpenCode, restarts its service, nor changes its settings.
// The status itself reaches every browser through the config (config.opencodeCheck); WiFi read-only phones are refused
// by the default-deny allowlist.
import { OPENCODE_SETTING_KEYS } from '../opencode-check.js';
import { addOpenCodePlugin, checkOpenCodePlugins, listOpenCodePlugins, OpenCodeAdminError, removeOpenCodePlugin, restartOpenCodeService, updateOpenCode, updateOpenCodePlugins } from '../opencode-admin.js';
import { json } from './http.js';

let maintenanceBusy = false;
const hasRunningTurn = (sessions) => [...(sessions?.sessions?.values() ?? [])].some((s) => s.turnActive?.());

export function register(router) {
  // Starts the light (token-free) check in the background: 202 + the view (running: true); 409 while one runs or a
  // turn is busy; 503 when OpenCode is not installed.
  router.post('/api/opencode-check/run', ({ opencodeCheck }, req, res) => {
    const { started, status, error } = opencodeCheck.runManual();
    if (!started) return json(res, status, { error });
    return json(res, 202, opencodeCheck.publicView());
  }, { maxBody: 1024 });

  // ⬆ `opencode upgrade` and ↻ `opencode service restart`: laptop only, one maintenance action at a time, never
  // while a turn is running (the updater/restart can replace the binary the running ACP child is using).
  for (const [name, run, busyMessage] of [
    ['update', updateOpenCode, 'Update OpenCode tidak bisa saat masih ada giliran yang berjalan.'],
    ['restart-service', restartOpenCodeService, 'Restart layanan OpenCode tidak bisa saat masih ada giliran yang berjalan.'],
  ]) {
    router.post(`/api/opencode-check/${name}`, async ({ opencode, opencodeCheck, sessions }, req, res) => {
      if (!opencode) return json(res, 404, { error: 'OpenCode tidak ditemukan.' });
      if (maintenanceBusy) return json(res, 409, { error: 'Maintenance OpenCode lain sedang berjalan.' });
      if (opencodeCheck.publicView().running) return json(res, 409, { error: 'Cek kompatibilitas OpenCode sedang berjalan. Tunggu sebentar.' });
      if (hasRunningTurn(sessions)) return json(res, 409, { error: busyMessage });
      maintenanceBusy = true;
      try {
        return json(res, 200, await run(opencode));
      } finally {
        maintenanceBusy = false;
      }
    }, { maxBody: 1024 });
  }

  // 🧩 Plugin OpenCode: list is read-only; add/remove/update/check are maintenance actions (one at a time).
  router.post('/api/opencode-plugins/list', async ({ opencode }, req, res) => {
    if (!opencode) return json(res, 404, { error: 'OpenCode tidak ditemukan.' });
    try {
      return json(res, 200, { plugins: await listOpenCodePlugins(opencode) });
    } catch (err) {
      if (err instanceof OpenCodeAdminError) return json(res, err.status, { error: err.message });
      throw err;
    }
  }, { maxBody: 1024 });

  const pluginAction = async (ctx, res, fn) => {
    if (!ctx.opencode) return json(res, 404, { error: 'OpenCode tidak ditemukan.' });
    if (maintenanceBusy) return json(res, 409, { error: 'Maintenance OpenCode lain sedang berjalan.' });
    if (ctx.opencodeCheck.publicView().running) return json(res, 409, { error: 'Cek kompatibilitas OpenCode sedang berjalan. Tunggu sebentar.' });
    if (hasRunningTurn(ctx.sessions)) return json(res, 409, { error: 'Tidak bisa mengubah plugin saat masih ada giliran yang berjalan.' });
    maintenanceBusy = true;
    try {
      return json(res, 200, await fn(ctx.opencode));
    } catch (err) {
      if (err instanceof OpenCodeAdminError) return json(res, err.status, { error: err.message });
      throw err;
    } finally {
      maintenanceBusy = false;
    }
  };

  router.post('/api/opencode-plugins/add', (ctx, req, res, params, body) => pluginAction(ctx, res, (bin) => addOpenCodePlugin(bin, body.spec)), { maxBody: 1024 });
  router.post('/api/opencode-plugins/remove', (ctx, req, res, params, body) => pluginAction(ctx, res, (bin) => removeOpenCodePlugin(bin, body.spec)), { maxBody: 1024 });
  router.post('/api/opencode-plugins/update', (ctx, req, res, params, body) => pluginAction(ctx, res, (bin) => updateOpenCodePlugins(bin, body.spec)), { maxBody: 1024 });
  router.post('/api/opencode-plugins/check', (ctx, req, res) => pluginAction(ctx, res, (bin) => checkOpenCodePlugins(bin)), { maxBody: 1024 });

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
