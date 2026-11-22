// 📂 Folder tambahan: extra folders Claude Code may read and write outside the project folder. Stored as an
// attribute of the project (settings.additionalDirectories) and passed to the CLI as `--add-dir`. The list is a
// read (Tailscale allowed, plain WiFi is not in the read allowlist); add/remove are laptop-only
// (LOCAL_ONLY_ACTION in server.js). A change reaches the next Claude process (restartKey in src/session.js).
import { ADD_DIR_LIMIT, AddDirError, addDirViews, addDirectory, removeDirectory } from '../add-dirs.js';
import { json } from './http.js';
import { claudeOnly, withProject } from './project.js';

/** Only this project's own running turn blocks a change (other projects are unrelated). */
const hasRunningTurn = (sessions, id) => Boolean(sessions?.sessions?.get(id)?.turnActive?.());
const TURN_RUNNING = 'Tidak bisa mengubah folder tambahan saat masih ada giliran yang berjalan.';
const LAPTOP_ONLY = 'Folder tambahan hanya bisa diubah dari laptop.';

/** The project's live session, if any: it respawns with the new list on the next prompt. */
const syncSession = (ctx, id) => {
  ctx.sessions?.sessions?.get(id)?.syncSettings?.();
};

const fromLaptop = (ctx, req) => {
  if (ctx.isLocal?.(req) !== true) throw new AddDirError(403, LAPTOP_ONLY);
};

/** What the dialog draws: each stored path and whether its folder is still there. */
const listing = (hub, id) => ({ dirs: addDirViews(hub.settingsFor(id).additionalDirectories), max: ADD_DIR_LIMIT });

/** An AddDirError goes back with its status and message; anything else is a real bug. */
async function guarded(res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AddDirError) return json(res, err.status, { error: err.message });
    throw err;
  }
}

/** Wraps a write: Claude projects only, from the laptop, and never during a running turn. */
const write = (fn) =>
  withProject(
    claudeOnly(
      (ctx, req, res, params, body) =>
        guarded(res, async () => {
          fromLaptop(ctx, req);
          if (hasRunningTurn(ctx.sessions, params.project.id)) return json(res, 409, { error: TURN_RUNNING, code: 'busy' });
          return fn(ctx, res, params.project, body);
        }),
      'Folder tambahan',
    ),
  );

export function register(router) {
  router.post(
    '/api/projects/:id/dirs',
    withProject(claudeOnly((ctx, req, res, params) => guarded(res, () => json(res, 200, listing(ctx.hub, params.project.id))), 'Folder tambahan')),
    { maxBody: 1024 },
  );

  router.post(
    '/api/projects/:id/dirs-add',
    write((ctx, res, project, body) => {
      const next = addDirectory({ list: ctx.hub.settingsFor(project.id).additionalDirectories, value: body.path });
      ctx.hub.updateSettings(project.id, { additionalDirectories: next });
      syncSession(ctx, project.id);
      ctx.hub.chat(project.id, { kind: 'info', text: `📂 Folder tambahan ditambahkan: ${next.at(-1)} (berlaku pada pesan berikutnya).` });
      return json(res, 200, listing(ctx.hub, project.id));
    }),
    { maxBody: 1024 },
  );

  router.post(
    '/api/projects/:id/dirs-remove',
    write((ctx, res, project, body) => {
      const before = ctx.hub.settingsFor(project.id).additionalDirectories;
      const next = removeDirectory({ list: before, value: body.path });
      const removed = before.find((dir) => !next.includes(dir)) ?? body.path;
      ctx.hub.updateSettings(project.id, { additionalDirectories: next });
      syncSession(ctx, project.id);
      ctx.hub.chat(project.id, { kind: 'info', text: `📂 Folder tambahan dilepas: ${removed}.` });
      return json(res, 200, listing(ctx.hub, project.id));
    }),
    { maxBody: 1024 },
  );
}
