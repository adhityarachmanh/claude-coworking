// ---------- 🧩 Ekstensi (plugins, your own subagents, hooks) and ⇡ Pull request (gh) ----------
// Reading: laptop or Tailscale (never a plain-WiFi phone). Installing/removing plugins, saving/deleting a user-level
// subagent (~/.claude/agents: every project) and the GitHub login: laptop only (a plugin runs code on this laptop;
// a user agent steers every project, like plugins and MCP servers; gh's login opens a device flow for this
// machine). A project's own agents (.claude/agents) can be edited over Tailscale too.
import { AdminError, deleteAgent, listAgents, listHooks, listPlugins, pluginAction, saveAgent } from '../claude-admin.js';
import { gitAction } from '../git.js';
import { checkPrBranch, createPr, findGh, ghLoginCancel, ghLoginStart, ghLoginState, ghStatus, PrError } from '../github-pr.js';
import { json } from './http.js';
import { withProject, withSession } from './project.js';

const ghBin = findGh();

/** Refuses a read-only (plain WiFi) client; `laptop` also refuses Tailscale phones. `claude` follows the project's
 *  engine (a route without a project falls back to the app-wide default). Errors → their status. */
const guard = (fn, { laptop = false, claude = false } = {}) => async (ctx, req, res, params, body) => {
  const engine = params?.project && ctx.hub?.engineOf ? ctx.hub.engineOf(params.project.id) : (ctx.hub?.engine ?? 'claude');
  if (claude && engine !== 'claude') return json(res, 409, { error: 'Ekstensi hanya tersedia saat mesin Claude Code aktif.' });
  if (laptop ? !ctx.isLocal(req) : ctx.isReadOnly?.(req) !== false) return json(res, 403, { error: laptop ? 'Hanya dari laptop.' : 'Hanya dari laptop atau lewat Tailscale.' });
  try {
    return json(res, 200, await fn(ctx, req, res, params, body ?? {}));
  } catch (err) {
    if (err instanceof AdminError || err instanceof PrError) return json(res, err.status, { error: err.message });
    if (err?.status) return json(res, err.status, { error: err.message });
    throw err;
  }
};

/** A user-level agent (scope "user", ~/.claude/agents) is changed from the laptop only. */
function userScopeFromLaptop(ctx, req, body) {
  if (body.scope === 'user' && !ctx.isLocal(req)) throw new AdminError(403, 'Agent untuk semua project (scope user) hanya bisa diubah dari laptop.');
}

export function register(router) {
  // plugins (Claude Code)
  // force (a fresh `claude plugin list --available`, up to 2 min): laptop only, like the other refresh endpoints.
  router.post(
    '/api/claude/plugins',
    guard(({ claude, isLocal, allowForce }, req, res, params, body) => listPlugins(claude, { force: isLocal(req) && allowForce(req, body) }), { claude: true }),
  );
  router.post(
    '/api/claude/plugins/action',
    guard(
      async ({ claude, sessions }, req, res, params, body) => {
        const result = await pluginAction(claude, { action: String(body.action ?? ''), id: String(body.id ?? ''), scope: body.scope, acceptCommand: body.acceptCommand ?? null });
        if (result.ok) {
          console.log(`Plugin ${body.action}: ${String(body.id).slice(0, 120)}`);
          sessions.accountChanged(); // idle Claude Code processes restart with the new plugin set; busy ones after their turn
        }
        return result;
      },
      { laptop: true, claude: true },
    ),
    { maxBody: 4096 },
  );

  // your own subagents (.claude/agents) and hooks (read-only)
  router.post('/api/projects/:id/agents', withProject(guard((ctx, req, res, { project }) => ({ agents: listAgents(project.path) }), { claude: true })));
  router.post('/api/projects/:id/agents/save', withSession(guard((ctx, req, res, { project, session }, body) => {
    userScopeFromLaptop(ctx, req, body);
    const saved = saveAgent(project.path, body);
    session.reloadSettings?.(); // read at the next start
    return saved;
  }, { claude: true })), { maxBody: 256 * 1024 });
  router.post('/api/projects/:id/agents/delete', withSession(guard((ctx, req, res, { project, session }, body) => {
    userScopeFromLaptop(ctx, req, body);
    const r = deleteAgent(project.path, body);
    session.reloadSettings?.();
    return r;
  }, { claude: true })));
  router.post('/api/projects/:id/hooks', withProject(guard((ctx, req, res, { project }) => ({ hooks: listHooks(project.path) }), { claude: true })));

  // ⇡ Pull request
  router.post('/api/github/status', guard(async () => ({ ...(await ghStatus(ghBin)), login: ghLoginState() })));
  router.post('/api/github/login', guard(({ hub }) => ghLoginStart(ghBin, { onChange: () => hub.broadcast('github-login', ghLoginState()) }), { laptop: true }));
  router.post('/api/github/login/cancel', guard(() => (ghLoginCancel(), { ok: true }), { laptop: true }));
  router.post('/api/projects/:id/pr', withProject(guard(async ({ hub }, req, res, { project }, body) => {
    const st = await ghStatus(ghBin);
    if (!st.installed) throw new PrError(404, 'GitHub CLI (gh) belum terpasang. Pasang dari https://cli.github.com.');
    if (!st.loggedIn) throw new PrError(409, 'Belum login GitHub. Klik "Login GitHub" dulu.');
    await checkPrBranch(ghBin, project.path, body); // never push a PR from main / into itself
    await gitAction(project.path, { action: 'push' }); // the branch must be on the remote first (upstream set if new)
    const pr = await createPr(ghBin, project.path, body);
    hub.chat(project.id, { kind: 'info', text: `⇡ Pull request dibuat: ${pr.url ?? '(lihat GitHub)'}` });
    hub.ciWatch?.(project.id);
    return pr;
  })), { maxBody: 80 * 1024 });
}
