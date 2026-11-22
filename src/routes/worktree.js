// ⎇ Worktree: create/list/enter/exit/remove git worktrees of a project. The app runs git itself (src/worktree.js)
// and points the engine's cwd at the active one; a worktree is an attribute of the project (settings.worktree),
// never a project of its own. Writes are laptop-only (LOCAL_ONLY_ACTION in server.js); the list is a read
// (Tailscale only — it is not in the plain-WiFi allowlist, see server.js).
import { basename } from 'node:path';
import { createWorktree, listWorktrees, removeWorktree, validWorktreeName, WorktreeError } from '../worktree.js';
import { json } from './http.js';
import { withProject } from './project.js';

/** Only this project's own running turn blocks a worktree change (other projects are unrelated). */
const hasRunningTurn = (sessions, id) => Boolean(sessions?.sessions?.get(id)?.turnActive?.());
const TURN_RUNNING = 'Tidak bisa mengubah worktree saat masih ada giliran yang berjalan.';

/** The project's live session, if one exists: it is told the workspace moved so the next prompt respawns there. */
const syncSession = (ctx, id) => {
  const session = ctx.sessions?.sessions?.get(id);
  session?.syncSettings?.();
};

/** A worktree as the page sees it: the folder's name, its branch, and whether it is the repo's main worktree. */
const asWorktree = (entry) => ({
  name: entry.isMain ? (entry.branch ?? 'main') : basename(entry.path),
  path: entry.path,
  branch: entry.branch ?? null,
  head: entry.head ?? null,
  isMain: Boolean(entry.isMain),
});

/** The repo's worktrees (main first), the active one's name, and the folder the engine runs in right now. */
async function listing(ctx, project) {
  const worktrees = (await listWorktrees(project.path)).map(asWorktree);
  return { worktrees, active: ctx.hub.worktreeOf(project.id)?.name ?? null, workspace: ctx.hub.workspacePathFor(project.id) };
}

/** A WorktreeError goes back with its status, code and git's own output; anything else is a real bug. */
async function tool(res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WorktreeError) return json(res, err.status, { error: err.message, code: err.code, output: err.output });
    throw err;
  }
}

/** Finds a worktree of `project` by name, or null (main included). */
async function findWorktree(project, name) {
  const wanted = String(name ?? '').trim();
  return (await listWorktrees(project.path)).map(asWorktree).find((w) => w.name === wanted) ?? null;
}

export function register(router) {
  router.post(
    '/api/projects/:id/worktrees',
    withProject(async (ctx, req, res, { project }) => tool(res, async () => json(res, 200, await listing(ctx, project)))),
    { maxBody: 1024 },
  );

  router.post(
    '/api/projects/:id/worktree-create',
    withProject((ctx, req, res, { project }, body) =>
      tool(res, async () => {
        if (hasRunningTurn(ctx.sessions, project.id)) return json(res, 409, { error: TURN_RUNNING, code: 'busy' });
        const created = await createWorktree(project.path, String(body.name ?? ''));
        ctx.hub.chat(project.id, { kind: 'info', text: `⎇ Worktree ${basename(created.path)} dibuat (branch ${created.branch}).` });
        return json(res, 200, { worktree: { name: basename(created.path), path: created.path, branch: created.branch }, workspace: ctx.hub.workspacePathFor(project.id) });
      }),
    ),
    { maxBody: 1024 },
  );

  router.post(
    '/api/projects/:id/worktree-enter',
    withProject((ctx, req, res, { project }, body) =>
      tool(res, async () => {
        if (hasRunningTurn(ctx.sessions, project.id)) return json(res, 409, { error: TURN_RUNNING, code: 'busy' });
        const wt = await findWorktree(project, body.name);
        if (!wt) return json(res, 404, { error: 'Worktree itu tidak ada di project ini.', code: 'not-found' });
        if (wt.isMain) return json(res, 400, { error: 'Repo utama bukan worktree: sesi sudah berjalan di folder project.', code: 'invalid' });
        // A worktree made outside the app (claude -w / git worktree add) may carry a name the app cannot store;
        // say so instead of reporting success and leaving the session in the project folder.
        if (!validWorktreeName(wt.name)) return json(res, 400, { error: `Nama worktree "${wt.name}" tidak bisa dipakai aplikasi (hanya huruf kecil, angka, dan tanda hubung).`, code: 'invalid-name' });
        ctx.hub.setWorktree(project.id, { name: wt.name, path: wt.path, branch: wt.branch ?? `worktree-${wt.name}` });
        syncSession(ctx, project.id);
        ctx.hub.chat(project.id, { kind: 'info', text: `⎇ Worktree ${wt.name} aktif — sesi berikutnya berjalan di sana.` });
        return json(res, 200, { worktree: { name: wt.name, path: wt.path, branch: wt.branch }, workspace: ctx.hub.workspacePathFor(project.id) });
      }),
    ),
    { maxBody: 1024 },
  );

  router.post(
    '/api/projects/:id/worktree-exit',
    withProject((ctx, req, res, { project }) =>
      tool(res, async () => {
        if (hasRunningTurn(ctx.sessions, project.id)) return json(res, 409, { error: TURN_RUNNING, code: 'busy' });
        const before = ctx.hub.worktreeOf(project.id);
        ctx.hub.setWorktree(project.id, null);
        syncSession(ctx, project.id);
        if (before) ctx.hub.chat(project.id, { kind: 'info', text: `⎇ Keluar dari worktree ${before.name} — sesi berikutnya kembali di folder project.` });
        return json(res, 200, { workspace: ctx.hub.workspacePathFor(project.id) });
      }),
    ),
    { maxBody: 1024 },
  );

  router.post(
    '/api/projects/:id/worktree-remove',
    withProject((ctx, req, res, { project }, body) =>
      tool(res, async () => {
        if (hasRunningTurn(ctx.sessions, project.id)) return json(res, 409, { error: TURN_RUNNING, code: 'busy' });
        const wt = await findWorktree(project, body.name);
        if (!wt) return json(res, 404, { error: 'Worktree itu tidak ada di project ini.', code: 'not-found' });
        if (wt.isMain) return json(res, 400, { error: 'Repo utama tidak bisa dihapus.', code: 'invalid' });
        // Leaving first, so the engine is never pointed at a folder that is about to disappear.
        const wasActive = ctx.hub.worktreeOf(project.id)?.name === wt.name;
        const before = wasActive ? ctx.hub.worktreeOf(project.id) : null;
        if (wasActive) {
          ctx.hub.setWorktree(project.id, null);
          syncSession(ctx, project.id);
        }
        try {
          await removeWorktree(project.path, wt.path, { force: body.force === true });
        } catch (err) {
          // The remove did not happen (dirty without force, git error): put the session back where it was,
          // so a cancelled "hapus paksa" leaves the project exactly as the user found it.
          if (wasActive) {
            ctx.hub.setWorktree(project.id, before);
            syncSession(ctx, project.id);
          }
          throw err;
        }
        ctx.hub.chat(project.id, { kind: 'info', text: `⎇ Worktree ${wt.name} dihapus.` });
        return json(res, 200, { workspace: ctx.hub.workspacePathFor(project.id) });
      }),
    ),
    { maxBody: 1024 },
  );
}
