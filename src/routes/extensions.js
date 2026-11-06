// ---------- 🧩 Ekstensi (plugins, your own subagents, hooks) and ⇡ Pull request (gh) ----------
// Reading: laptop or Tailscale (never a plain-WiFi phone). Installing/removing plugins, saving/deleting a user-level
// subagent (~/.claude/agents: every project) and the GitHub login: laptop only (a plugin runs code on this laptop;
// a user agent steers every project, like plugins and MCP servers; gh's login opens a device flow for this
// machine). A project's own agents (.claude/agents) can be edited over Tailscale too.
import { AdminError, deleteAgent, listAgents, listHooks, listPlugins, pluginAction, saveAgent } from '../claude-admin.js';
import { budgetStop } from '../budget.js';
import { gitAction } from '../git.js';
import { checkPrBranch, createPr, findGh, ghLoginCancel, ghLoginStart, ghLoginState, ghStatus, PrError } from '../github-pr.js';
import { HANDOFF_TRIGGER_PROMPT, handoffInfo, HandoffError, otherEngine, quickHandoff, smartHandoff } from '../handoff.js';
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

  // 🔁 Lanjutkan dari mesin lain: the other workspace's context as an opening message (src/handoff.js)
  router.post('/api/projects/:id/handoff/info', withProject(guard(({ hub }, req, res, { project }) => handoffInfo(hub, project, otherEngine(hub.engineOf(project.id))))));
  let smartBusy = false;
  router.post('/api/projects/:id/handoff', withProject(guard(async ({ hub, claude, opencode }, req, res, { project }, body) => {
    const to = hub.engineOf(project.id);
    const from = otherEngine(to);
    try {
      if (body.mode !== 'smart') return { mode: 'quick', from, text: await quickHandoff({ hub, project, from }) };
      if (smartBusy) throw new HandoffError(409, 'Catatan handoff lain sedang dibuat. Tunggu sebentar.');
      smartBusy = true;
      try {
        console.log(`Handoff pintar: ${from} → ${to} (${project.name})`);
        return { mode: 'smart', from, text: await smartHandoff({ hub, project, from, claude, opencode }) };
      } finally {
        smartBusy = false;
      }
    } catch (err) {
      if (err instanceof HandoffError) throw Object.assign(err, { status: err.status });
      throw err;
    }
  })), { maxBody: 1024 });

  // One-button handoff: put the free context into the session and immediately send a context-only trigger prompt.
  router.post(
    '/api/projects/:id/handoff/apply',
    withSession(
      guard(async ({ hub, ledger }, req, res, { project, session }) => {
        const stop = budgetStop(hub, ledger);
        if (stop) throw new HandoffError(409, stop.message);
        if (session.turnActive?.() || session.busy || session.inflight?.size || session.rewinding) throw new HandoffError(409, 'Tunggu giliran yang sedang berjalan selesai dulu.');
        if ([...hub.approvals.values()].some(({ approval }) => approval.project === project.id)) throw new HandoffError(409, 'Jawab permintaan izin yang masih terbuka dulu.');
        const to = hub.engineOf(project.id);
        const from = otherEngine(to);
        const text = await quickHandoff({ hub, project, from });
        session.setHandoffContext(text);
        try {
          session.prompt(HANDOFF_TRIGGER_PROMPT, [], { handoffTrigger: true });
        } catch (err) {
          session.clearHandoffContext();
          throw err;
        }
        return { ok: true, from, to };
      }),
    ),
    { maxBody: 1024 },
  );

  // Session-only handoff memory: no turn, no file, no prompt. It rides with the next prompt once.
  router.post('/api/projects/:id/handoff/context', withSession(guard((ctx, req, res, { project, session }, body) => {
    if (body?.clear === true) {
      session.clearHandoffContext();
      return { ok: true, ready: false };
    }
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HandoffError(400, 'Catatan handoff kosong.');
    if (text.length > 20_000) throw new HandoffError(413, 'Catatan handoff terlalu panjang.');
    session.setHandoffContext(text);
    return { ok: true, ready: true };
  })));

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
