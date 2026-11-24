// ---------- 🧩 Ekstensi (plugins, your own subagents, hooks) and ⇡ Pull request (gh) ----------
// Reading: laptop or Tailscale (never a plain-WiFi phone). Installing/removing plugins, saving/deleting a user-level
// subagent (~/.claude/agents: every project) and the GitHub login: laptop only (a plugin runs code on this laptop;
// a user agent steers every project, like plugins and MCP servers; gh's login opens a device flow for this
// machine). A project's own agents (.claude/agents) can be edited over Tailscale too.
import { AdminError, claudePurgePlan, claudePurgeProject, deleteAgent, deleteHook, HOOK_EVENTS, listAgents, listHooks, listMarketplaces, listPlugins, marketplaceAction, pluginAction, readAutoMode, saveAgent, saveAutoMode, saveHook } from '../claude-admin.js';
import { gitAction } from '../git.js';
import { checkPrBranch, createPr, findGh, ghLoginCancel, ghLoginStart, ghLoginState, ghStatus, PrError } from '../github-pr.js';
import { json } from './http.js';
import { withProject, withSession } from './project.js';

const ghBin = findGh();

/** Refuses a read-only (plain WiFi) client; `laptop` also refuses Tailscale phones. `claude` follows the project's
 *  engine (a route without a project falls back to the app-wide default). Errors → their status. */
const guard = (fn, { laptop = false, claude = false } = {}) => async (ctx, req, res, params, body) => {
  const engine = params?.project && ctx.hub?.engineOf ? ctx.hub.engineOf(params.project.id) : (ctx.hub?.engine ?? 'claude');
  if (claude && engine !== 'claude') return json(res, 409, { error: 'Ekstensi hanya tersedia saat model Claude aktif.' });
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

  // 🏪 Marketplaces: the list is a read; add/remove/update write configuration and clone from the network.
  router.post(
    '/api/claude/plugins/marketplaces',
    guard(({ claude }) => listMarketplaces(claude).then((marketplaces) => ({ marketplaces })), { claude: true }),
  );
  router.post(
    '/api/claude/plugins/marketplace-action',
    guard(
      async ({ claude, sessions }, req, res, params, body) => {
        const result = await marketplaceAction(claude, { action: String(body.action ?? ''), source: String(body.source ?? ''), name: String(body.name ?? '') });
        if (result.ok) {
          console.log(`Marketplace plugin ${body.action}: ${String(body.source || body.name || 'semua').slice(0, 120)}`);
          sessions.accountChanged(); // idle Claude Code processes restart with the new marketplace set
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
  router.post('/api/projects/:id/hooks', withProject(guard((ctx, req, res, { project }) => ({ hooks: listHooks(project.path), events: [...HOOK_EVENTS] }), { claude: true })));
  router.post('/api/projects/:id/hooks/save', withSession(guard((ctx, req, res, { project, session }, body) => {
    userScopeFromLaptop(ctx, req, body);
    const saved = saveHook({ projectPath: project.path, scope: body.scope, event: body.event, matcher: body.matcher, command: body.command, timeout: body.timeout });
    session.reloadSettings?.(); // hooks are read at the next start
    return saved;
  }, { claude: true })), { maxBody: 8192 });
  router.post('/api/projects/:id/hooks/delete', withSession(guard((ctx, req, res, { project, session }, body) => {
    userScopeFromLaptop(ctx, req, body);
    const removed = deleteHook({ projectPath: project.path, scope: body.scope, event: body.event, matcher: body.matcher, command: body.command });
    session.reloadSettings?.();
    return removed;
  }, { claude: true })), { maxBody: 4096 });

  // 🎛️ Auto mode (classifier rules): user settings only, so the laptop is the only place to change it. Claude reads
  // them when a process starts, so idle Claude processes are closed to pick them up on the next prompt.
  router.post('/api/claude/auto-mode', guard(() => readAutoMode(), { laptop: true }));
  router.post('/api/claude/auto-mode/save', guard((ctx, req, res, params, body) => {
    const saved = saveAutoMode(body);
    ctx.sessions?.accountChanged?.();
    return saved;
  }, { laptop: true }), { maxBody: 64 * 1024 });

  // 🧹 Bersihkan data lokal Claude untuk satu project (`claude purge`): laptop only, never during a turn or with
  // queued work, and the destructive call needs the workspace path typed back as confirmation.
  const purgeBusy = (ctx, session, project) => {
    if (session?.turnActive?.() || session?.busy || session?.inflight?.size) return true;
    return Boolean(ctx.taskQueue?.queues?.[project.id]?.items?.some((i) => i.status === 'waiting' || i.status === 'running'));
  };
  const purgeTarget = (ctx, project) => ctx.hub.workspacePathFor(project.id) ?? project.path;
  router.post('/api/projects/:id/claude-purge/plan', withSession(guard(async (ctx, req, res, { project, session }) => {
    if (purgeBusy(ctx, session, project)) throw new AdminError(409, 'Tidak bisa membersihkan data saat masih ada giliran atau antrian yang berjalan.');
    const target = purgeTarget(ctx, project);
    return { ...(await claudePurgePlan(ctx.claude, target)), path: target };
  }, { laptop: true, claude: true })));
  router.post('/api/projects/:id/claude-purge', withSession(guard(async (ctx, req, res, { project, session }, body) => {
    if (purgeBusy(ctx, session, project)) throw new AdminError(409, 'Tidak bisa membersihkan data saat masih ada giliran atau antrian yang berjalan.');
    const target = purgeTarget(ctx, project);
    if (String(body?.confirm ?? '') !== target) throw new AdminError(400, 'Ketik path folder kerja persis untuk mengonfirmasi.');
    // Close the idle process first so Claude Code cannot write the deleted state back; the chat column in the app stays,
    // but the next prompt starts a new Claude session instead of resuming a transcript that no longer exists.
    session.closeChild();
    const result = await claudePurgeProject(ctx.claude, target);
    ctx.hub.setSessionId(project.id, null);
    ctx.hub.clearInterrupted(project.id);
    return result;
  }, { laptop: true, claude: true })));

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
