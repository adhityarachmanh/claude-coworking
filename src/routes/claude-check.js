// ⚙ Cek kompatibilitas Claude Code (src/claude-check.js). Both routes are laptop only (LOCAL_ONLY in server.js):
// a phone never starts a check (it spawns Claude Code, maybe a model call) nor changes its settings. The status
// itself reaches every browser through the config (config.claudeCheck).
import { execFileTree } from '../proc.js';
import { json } from './http.js';

/** `claude doctor` / `claude update` without a terminal (both print and exit); output cut to 20 KB. */
function runClaude(bin, args, timeout) {
  return new Promise((resolve) => {
    execFileTree(bin.command, [...bin.args, ...args], { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CI: '1', NO_COLOR: '1' } }, (err, out, errOut) => {
      const text = `${out ?? ''}${errOut ? `\n${errOut}` : ''}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().slice(0, 20_000);
      resolve({ ok: !err, timedOut: Boolean(err?.killed), output: text || (err ? err.message.split('\n')[0] : '') });
    });
  });
}
let maintenanceBusy = false;

const SETTING_KEYS = ['autoCheck', 'allowModel'];

export function register(router) {
  // Starts the light check in the background: 202 + the view (running: true); 409 while one runs or a turn is busy.
  router.post('/api/claude-check/run', ({ claudeCheck }, req, res) => {
    const { started, status, error } = claudeCheck.runManual();
    if (!started) return json(res, status, { error });
    return json(res, 202, claudeCheck.publicView());
  }, { maxBody: 1024 });

  // 🩺 `claude doctor` (read-only health check) and ⬆ `claude update` (installs a newer Claude Code): laptop only.
  for (const [name, args, timeout] of [['doctor', ['doctor'], 60_000], ['update', ['update'], 300_000]]) {
    router.post(`/api/claude-check/${name}`, async ({ claude, sessions }, req, res) => {
      if (!claude) return json(res, 404, { error: 'Claude Code tidak ditemukan.' });
      if (maintenanceBusy) return json(res, 409, { error: 'Doctor/update lain sedang berjalan.' });
      if (name === 'update' && [...(sessions?.sessions?.values() ?? [])].some((s) => s.turnActive?.())) return json(res, 409, { error: 'Masih ada giliran yang berjalan. Update setelah selesai.' });
      maintenanceBusy = true;
      try {
        const result = await runClaude(claude, args, timeout);
        if (name === 'update') console.log(`claude update: ${result.ok ? 'selesai' : 'gagal'}`);
        return json(res, 200, result);
      } finally {
        maintenanceBusy = false;
      }
    }, { maxBody: 1024 });
  }

  // ⬆ Adhitron's own update (src/app-update.js): check now / pull + restart. Laptop only (LOCAL_ONLY).
  router.post('/api/app-update/check', async ({ appUpdater }, req, res) => json(res, 200, await appUpdater.check()), { maxBody: 1024 });
  router.post('/api/app-update/run', async ({ appUpdater }, req, res) => {
    const r = await appUpdater.update();
    return json(res, r.ok ? 200 : 409, r);
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
