// ---------- 🛡️ Aturan izin: Claude Code's saved permission rules ----------
// `permissions` reads (Tailscale/laptop only: rules can hold exact commands, tokens included, so not over WiFi);
// `permissions-edit` changes what Claude Code may do unasked: laptop only (LOCAL_ONLY_ACTION in server.js).
import { PermissionError, editPermission, readPermissions } from '../permissions.js';
import { appliedOf, json } from './http.js';
import { claudeOnly, withProject } from './project.js';

/** The permission dialog edits Claude Code settings; OpenCode has its own rules in opencode.json. */
const withClaudeProject = (fn) => withProject(claudeOnly(fn, 'Aturan izin'));

export function register(router) {
  router.post('/api/projects/:id/permissions', withClaudeProject((ctx, req, res, { project }) => permissionTool(res, async () => json(res, 200, await readPermissions(project.path)))));
  router.post('/api/projects/:id/permissions-edit', withClaudeProject(({ hub, sessions }, req, res, { project }, body) =>
    permissionTool(res, async () => {
      const edit = { scope: String(body.scope ?? ''), action: String(body.action ?? ''), list: String(body.list ?? ''), rule: body.rule, to: body.to == null ? undefined : String(body.to) };
      const result = await editPermission(project.path, edit);
      // Claude Code reads its rules at start: idle processes restart, busy ones after their turn.
      // A user-level rule applies to every project.
      const affected = edit.scope === 'user' ? [...sessions.sessions.values()] : [sessions.get(project)];
      const applied = affected.map((s) => s.reloadSettings());
      const rule = String(edit.rule ?? '').trim();
      const what = { add: `ditambahkan ke ${edit.list}`, remove: `dihapus dari ${edit.list}`, move: `dipindah ${edit.list} → ${edit.to}` }[edit.action];
      hub.chat(project.id, { kind: 'info', text: `🛡️ Aturan izin "${rule}" ${what} (${result.file}).` });
      return json(res, 200, { ...result, applied: appliedOf(applied) });
    }),
  ));
}

async function permissionTool(res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PermissionError) return json(res, err.status, { error: err.message });
    throw err;
  }
}
