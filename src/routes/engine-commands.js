// 🔁 A small, pinned set of Claude session commands from UI buttons (plugins/skills reload, /init). The command is
// forwarded as a normal prompt, so its output lands in the chat like any other turn; the allowlist keeps this from
// becoming a free-form remote shell.
import { ENGINE_COMMANDS, normalizeEngineCommand } from '../engine-commands.js';
import { json } from './http.js';
import { claudeOnly, withSession } from './project.js';

export function register(router) {
  router.post('/api/projects/:id/engine-command', withSession(claudeOnly(({ hub }, req, res, { project, session }, body) => {
    const command = normalizeEngineCommand(body?.command);
    if (!command) {
      return json(res, 400, { error: `Command tidak dikenal. Pilihan: ${Object.keys(ENGINE_COMMANDS).join(', ')}.` });
    }
    if (!session) return json(res, 409, { error: 'Sesi Claude belum siap. Kirim satu pesan dulu, lalu coba lagi.' });
    if (hub.statusFor(project.id)?.busy) return json(res, 409, { error: 'Tunggu giliran ini selesai, lalu muat ulang.' });
    session.prompt(command);
    return json(res, 200, { ok: true, command, label: ENGINE_COMMANDS[command] });
  }, 'Command mesin')), { maxBody: 1024 });
}
