// 📝 Commands OpenCode (`<project>/.opencode/commands`, `<config>/opencode/commands`): list/read on laptop or
// Tailscale; project files written over Tailscale too, global ones from the laptop only (they steer every project).
// Commands are read by OpenCode on demand, so no process restart follows a save. Nothing here starts OpenCode.
import { CommandError, commandRoots, deleteCommand, listCommands, readCommand, saveCommand } from '../opencode-commands.js';
import { json } from './http.js';
import { openCodeOnly, withProject } from './project.js';

const READ_DENIED = 'Commands OpenCode hanya bisa dibuka dari laptop atau lewat Tailscale.';
const LAPTOP_ONLY = 'Command untuk semua project hanya bisa diubah dari laptop.';

const tool = async (res, fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CommandError) return json(res, err.status, { error: err.message });
    throw err;
  }
};
const userScopeFromLaptop = (ctx, req, scope) => {
  if (scope === 'user' && !ctx.isLocal?.(req)) throw new CommandError(403, LAPTOP_ONLY);
};
const scopeOf = (body) => (body?.scope === 'user' ? 'user' : 'project');
const sourceOf = (body) => (typeof body?.source === 'string' && body.source ? body.source : undefined);
const dataDirOf = (ctx) => ctx.hub?.dataDir ?? ctx.dataDir;

export function register(router) {
  router.post(
    '/api/projects/:id/opencode-commands',
    withProject(
      openCodeOnly(
        (ctx, req, res, { project }) =>
          tool(res, () => {
            if (ctx.isReadOnly?.(req) !== false) return json(res, 403, { error: READ_DENIED });
            const roots = commandRoots({ projectPath: project.path }).map(({ scope, source }) => ({ scope, source }));
            return json(res, 200, { commands: listCommands({ projectPath: project.path }), roots });
          }),
        'Commands',
      ),
    ),
    { maxBody: 1024 },
  );

  router.post(
    '/api/projects/:id/opencode-commands/read',
    withProject(
      openCodeOnly(
        (ctx, req, res, { project }, body) =>
          tool(res, () => {
            if (ctx.isReadOnly?.(req) !== false) return json(res, 403, { error: READ_DENIED });
            return json(res, 200, { command: readCommand({ projectPath: project.path, scope: scopeOf(body), source: sourceOf(body), id: body?.id }) });
          }),
        'Commands',
      ),
    ),
    { maxBody: 1024 },
  );

  router.post(
    '/api/projects/:id/opencode-commands/save',
    withProject(
      openCodeOnly(
        (ctx, req, res, { project }, body) =>
          tool(res, () => {
            const scope = scopeOf(body);
            userScopeFromLaptop(ctx, req, scope);
            const result = saveCommand({
              projectPath: project.path,
              dataDir: dataDirOf(ctx),
              scope,
              source: sourceOf(body),
              id: body?.id,
              previous: body?.previous ?? null,
              description: body?.description,
              agent: body?.agent,
              model: body?.model,
              subagent: body?.subagent === true ? true : body?.subagent === false ? false : null,
              template: body?.template,
              mtime: body?.mtime,
            });
            ctx.hub.chat(project.id, { kind: 'info', text: `📝 Command OpenCode "${result.command.id}" disimpan (${scope === 'user' ? 'semua project' : 'project ini'}).` });
            return json(res, 200, result);
          }),
        'Commands',
      ),
    ),
    { maxBody: 256 * 1024 },
  );

  router.post(
    '/api/projects/:id/opencode-commands/delete',
    withProject(
      openCodeOnly(
        (ctx, req, res, { project }, body) =>
          tool(res, () => {
            const scope = scopeOf(body);
            userScopeFromLaptop(ctx, req, scope);
            const result = deleteCommand({ projectPath: project.path, dataDir: dataDirOf(ctx), scope, source: sourceOf(body), id: body?.id, mtime: body?.mtime });
            ctx.hub.chat(project.id, { kind: 'info', text: `📝 Command OpenCode "${body?.id}" dihapus (${scope === 'user' ? 'semua project' : 'project ini'}).` });
            return json(res, 200, result);
          }),
        'Commands',
      ),
    ),
    { maxBody: 1024 },
  );
}
