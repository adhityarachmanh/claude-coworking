// ---------- 🧩 Ekstensi (plugins, your own subagents, hooks) and ⇡ Pull request (gh) ----------
// Reading: laptop or Tailscale (never a plain-WiFi phone). Installing/removing plugins and the GitHub login: laptop
// only (a plugin runs code on this laptop; gh's login opens a device flow for this machine).
import { AdminError, deleteAgent, listAgents, listHooks, listPlugins, pluginAction, saveAgent } from '../claude-admin.js';
import { gitAction } from '../git.js';
import { createPr, findGh, ghLoginCancel, ghLoginStart, ghLoginState, ghStatus, PrError } from '../github-pr.js';
import { handoffInfo, HandoffError, otherEngine, quickHandoff, smartHandoff } from '../handoff.js';
import { json } from './http.js';
import { withProject, withSession } from './project.js';

const ghBin = findGh();

/** Refuses a read-only (plain WiFi) client; `laptop` also refuses Tailscale phones. Errors → their status. */
const guard = (fn, { laptop = false } = {}) => async (ctx, req, res, params, body) => {
  if (laptop ? !ctx.isLocal(req) : ctx.isReadOnly?.(req) !== false) return json(res, 403, { error: laptop ? 'Hanya dari laptop.' : 'Hanya dari laptop atau lewat Tailscale.' });
  try {
    return json(res, 200, await fn(ctx, req, res, params, body ?? {}));
  } catch (err) {
    if (err instanceof AdminError || err instanceof PrError) return json(res, err.status, { error: err.message });
    if (err?.status) return json(res, err.status, { error: err.message });
    throw err;
  }
};

export function register(router) {
  // plugins (Claude Code)
  router.post('/api/claude/plugins', guard(({ claude }, req, res, params, body) => listPlugins(claude, { force: body.force === true })));
  router.post('/api/claude/plugins/action', guard(async ({ claude, sessions }, req, res, params, body) => {
    const result = await pluginAction(claude, { action: String(body.action ?? ''), id: String(body.id ?? ''), scope: body.scope, acceptCommand: body.acceptCommand ?? null });
    if (result.ok) {
      console.log(`Plugin ${body.action}: ${String(body.id).slice(0, 120)}`);
      sessions.accountChanged(); // idle Claude Code processes restart with the new plugin set; busy ones after their turn
    }
    return result;
  }, { laptop: true }), { maxBody: 4096 });

  // your own subagents (.claude/agents) and hooks (read-only)
  router.post('/api/projects/:id/agents', withProject(guard((ctx, req, res, { project }) => ({ agents: listAgents(project.path) }))));
  router.post('/api/projects/:id/agents/save', withSession(guard((ctx, req, res, { project, session }, body) => {
    const saved = saveAgent(project.path, body);
    session.reloadSettings?.(); // read at the next start
    return saved;
  })), { maxBody: 256 * 1024 });
  router.post('/api/projects/:id/agents/delete', withSession(guard((ctx, req, res, { project, session }, body) => {
    const r = deleteAgent(project.path, body);
    session.reloadSettings?.();
    return r;
  })));
  router.post('/api/projects/:id/hooks', withProject(guard((ctx, req, res, { project }) => ({ hooks: listHooks(project.path) }))));

  // 🔁 Lanjutkan dari mesin lain: the other workspace's context as an opening message (src/handoff.js)
  router.post('/api/projects/:id/handoff/info', withProject(guard(({ hub }, req, res, { project }) => handoffInfo(hub, project, otherEngine(hub.engine)))));
  let smartBusy = false;
  router.post('/api/projects/:id/handoff', withProject(guard(async ({ hub, claude, opencode }, req, res, { project }, body) => {
    const from = otherEngine(hub.engine);
    try {
      if (body.mode !== 'smart') return { mode: 'quick', from, text: await quickHandoff({ hub, project, from }) };
      if (smartBusy) throw new HandoffError(409, 'Catatan handoff lain sedang dibuat. Tunggu sebentar.');
      smartBusy = true;
      try {
        console.log(`Handoff pintar: ${from} → ${hub.engine} (${project.name})`);
        return { mode: 'smart', from, text: await smartHandoff({ hub, project, from, claude, opencode }) };
      } finally {
        smartBusy = false;
      }
    } catch (err) {
      if (err instanceof HandoffError) throw Object.assign(err, { status: err.status });
      throw err;
    }
  })), { maxBody: 1024 });

  // ⇡ Pull request
  router.post('/api/github/status', guard(async () => ({ ...(await ghStatus(ghBin)), login: ghLoginState() })));
  router.post('/api/github/login', guard(({ hub }) => ghLoginStart(ghBin, { onChange: () => hub.broadcast('github-login', ghLoginState()) }), { laptop: true }));
  router.post('/api/github/login/cancel', guard(() => (ghLoginCancel(), { ok: true }), { laptop: true }));
  router.post('/api/projects/:id/pr', withProject(guard(async ({ hub }, req, res, { project }, body) => {
    const st = await ghStatus(ghBin);
    if (!st.installed) throw new PrError(404, 'GitHub CLI (gh) belum terpasang. Pasang dari https://cli.github.com.');
    if (!st.loggedIn) throw new PrError(409, 'Belum login GitHub. Klik "Login GitHub" dulu.');
    await gitAction(project.path, { action: 'push' }); // the branch must be on the remote first (upstream set if new)
    const pr = await createPr(ghBin, project.path, body);
    hub.chat(project.id, { kind: 'info', text: `⇡ Pull request dibuat: ${pr.url ?? '(lihat GitHub)'}` });
    return pr;
  })), { maxBody: 80 * 1024 });
}
