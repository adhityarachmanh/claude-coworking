// 🎭 Output style Claude (src/output-styles.js): read on laptop/Tailscale, select/save/delete with the same gates as
// the permission-rules editor. The choice lives in .claude/settings.local.json; Claude Code reads it at start, so an
// idle process is closed and the next prompt opens one with the new style (a busy turn is refused outright).
import { OutputStyleError, currentOutputStyle, deleteStyle, listOutputStyles, readStyle, saveSelection, saveStyle } from '../output-styles.js';
import { appliedOf, json } from './http.js';
import { claudeOnly, withProject } from './project.js';

const TURN_RUNNING = 'Tidak bisa mengubah output style saat masih ada giliran yang berjalan.';
const READ_DENIED = 'Output style hanya bisa dibuka dari laptop atau lewat Tailscale.';
const LAPTOP_ONLY = 'Gaya untuk semua project hanya bisa diubah dari laptop.';

const sessionOf = (ctx, project) => ctx.sessions?.get?.(project) ?? ctx.sessions?.sessions?.get?.(project.id) ?? null;
const reload = (session) => appliedOf([session?.reloadSettings?.() ?? 'none']);
const tool = async (res, fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OutputStyleError) return json(res, err.status, { error: err.message });
    throw err;
  }
};
const userScopeFromLaptop = (ctx, req, scope) => {
  if (scope === 'user' && !ctx.isLocal?.(req)) throw new OutputStyleError(403, LAPTOP_ONLY);
};
const scopeOf = (body) => (body?.scope === 'user' ? 'user' : 'project');
const guardTurn = (session) => {
  if (session?.turnActive?.()) throw new OutputStyleError(409, TURN_RUNNING);
};

/** The picker's payload: no absolute path (it may be a phone over Tailscale), and the style that applies here. */
const view = (project) => ({
  styles: listOutputStyles({ projectPath: project.path }).map((style) => {
    const { file, ...rest } = style;
    return rest;
  }),
  current: currentOutputStyle({ projectPath: project.path }),
});

export function register(router) {
  router.post(
    '/api/projects/:id/output-styles',
    withProject(
      claudeOnly(
        (ctx, req, res, { project }) =>
          tool(res, () => {
            if (ctx.isReadOnly?.(req) !== false) return json(res, 403, { error: READ_DENIED });
            return json(res, 200, view(project));
          }),
        'Output style',
      ),
    ),
    { maxBody: 1024 },
  );

  router.post(
    '/api/projects/:id/output-styles/select',
    withProject(
      claudeOnly(
        (ctx, req, res, { project }, body) =>
          tool(res, () => {
            const name = String(body?.name ?? '').trim();
            const picked = name === 'default' ? 'default' : listOutputStyles({ projectPath: project.path }).find((style) => style.name === name)?.name;
            if (!picked) return json(res, 400, { error: `Gaya "${name}" tidak dikenal.` });
            const session = sessionOf(ctx, project);
            guardTurn(session);
            const result = saveSelection({ projectPath: project.path, name: picked });
            const applied = reload(session);
            ctx.hub.chat(project.id, { kind: 'info', text: `🎭 Output style: ${picked === 'default' ? 'Default' : picked} (berlaku pada pesan berikutnya).` });
            return json(res, 200, { current: currentOutputStyle({ projectPath: project.path }), file: result.file, applied });
          }),
        'Output style',
      ),
    ),
    { maxBody: 2048 },
  );

  router.post(
    '/api/projects/:id/output-styles/save',
    withProject(
      claudeOnly(
        (ctx, req, res, { project }, body) =>
          tool(res, () => {
            const scope = scopeOf(body);
            userScopeFromLaptop(ctx, req, scope);
            const session = sessionOf(ctx, project);
            guardTurn(session);
            const name = String(body?.name ?? '').trim();
            if (body?.slug) {
              // Renaming or deleting the style that is in use would leave the local choice pointing at nothing.
              const before = readStyle({ projectPath: project.path, scope, slug: body.slug });
              if (before.name !== name && currentOutputStyle({ projectPath: project.path }).name === before.name) {
                return json(res, 409, { error: 'Ganti dulu gaya yang sedang dipakai sebelum mengganti namanya.' });
              }
            }
            const result = saveStyle({
              projectPath: project.path,
              dataDir: ctx.hub.dataDir,
              scope,
              slug: body?.slug,
              name,
              description: body?.description,
              keepCodingInstructions: body?.keepCodingInstructions === true,
              body: body?.body,
              mtime: body?.mtime,
            });
            const applied = reload(session);
            ctx.hub.chat(project.id, { kind: 'info', text: `🎭 Gaya "${result.style.name}" disimpan (${scope === 'user' ? 'semua project' : 'project ini'}).` });
            return json(res, 200, { ...result, current: currentOutputStyle({ projectPath: project.path }), applied });
          }),
        'Output style',
      ),
    ),
    { maxBody: 256 * 1024 },
  );

  router.post(
    '/api/projects/:id/output-styles/delete',
    withProject(
      claudeOnly(
        (ctx, req, res, { project }, body) =>
          tool(res, () => {
            const scope = scopeOf(body);
            userScopeFromLaptop(ctx, req, scope);
            const session = sessionOf(ctx, project);
            guardTurn(session);
            const before = readStyle({ projectPath: project.path, scope, slug: body?.slug });
            if (currentOutputStyle({ projectPath: project.path }).name === before.name) {
              return json(res, 409, { error: 'Ganti dulu gaya yang sedang dipakai sebelum menghapusnya.' });
            }
            const result = deleteStyle({ projectPath: project.path, dataDir: ctx.hub.dataDir, scope, slug: body?.slug, mtime: body?.mtime });
            const applied = reload(session);
            ctx.hub.chat(project.id, { kind: 'info', text: `🎭 Gaya "${before.name}" dihapus (${scope === 'user' ? 'semua project' : 'project ini'}).` });
            return json(res, 200, { ...result, current: currentOutputStyle({ projectPath: project.path }), applied });
          }),
        'Output style',
      ),
    ),
    { maxBody: 1024 },
  );
}
