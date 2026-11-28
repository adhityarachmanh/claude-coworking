// 🖥 Opens the pinned CLI in Windows Terminal for the TUI-only features. Laptop/Tailscale only: the window is a real
// console on this machine, never exposed to the browser.
import { json } from './http.js';
import { withProject } from './project.js';
import { openTerminal, terminalArgv } from '../terminal-launch.js';

export function register(router) {
  router.post('/api/projects/:id/terminal', withProject(async (ctx, req, res, { project }, body) => {
    if (ctx.isReadOnly?.(req) !== false) return json(res, 403, { error: 'Terminal hanya bisa dibuka dari laptop atau lewat Tailscale.' });
    const mode = body?.mode;
    const engine = ctx.hub?.engineOf?.(project.id);
    if ((mode === 'claude' || mode === 'attach') && engine !== 'claude') return json(res, 409, { error: 'Terminal Claude hanya untuk project Claude.' });
    if (mode === 'opencode' && engine !== 'opencode') return json(res, 409, { error: 'Terminal OpenCode hanya untuk project OpenCode.' });
    const argv = terminalArgv({ mode, agentId: body?.id }, { claude: ctx.claude, opencode: ctx.opencode });
    if (!argv) return json(res, 400, { error: 'Mode terminal tidak dikenal.' });
    const opened = await openTerminal({ cwd: project.path, argv });
    return opened ? json(res, 200, { ok: true }) : json(res, 502, { error: 'Windows Terminal (wt.exe) tidak ditemukan. Pasang Windows Terminal, lalu coba lagi.' });
  }), { maxBody: 1024 });
}
