// ---------- 🧩 Skills (/skills): SKILL.md editor for both engines (src/skills.js) ----------
// Reading needs the laptop or Tailscale (never a plain-WiFi phone: a skill steers the model, so it is a tool of the
// person at the laptop). A project skill is written over Tailscale too; a user-scope skill (~/.claude/skills,
// ~/.config/opencode/skills, …) steers every project on this laptop, so it is written from the laptop only (like
// plugins, MCP servers and user agents). Every overwrite leaves a backup in the app's data folder.
import { listSkills, readSkill, saveSkill, deleteSkill, skillRoots, SkillError } from '../skills.js';
import { json } from './http.js';
import { withProject } from './project.js';

/** The project's engine (a fake hub in a test may only carry the app-wide one). */
const engineOf = (hub, id) => (hub.engineOf ? hub.engineOf(id) : (hub.engine ?? 'claude'));

/** A user-scope skill steers every project on this laptop: changed from the laptop only. */
const userScopeFromLaptop = (ctx, req, scope) => {
  if (scope === 'user' && !ctx.isLocal(req)) throw new SkillError(403, 'Skill untuk semua project hanya bisa diubah dari laptop.');
};

/** Drops the laptop's absolute path from a skill before it goes to a phone (Tailscale). */
const publicSkill = ({ file, ...rest }) => rest;

const guard = (fn) => (ctx, req, res, params, body) => {
  if (ctx.isReadOnly?.(req) !== false) return json(res, 403, { error: 'Skills hanya bisa dibuka dari laptop atau lewat Tailscale.' });
  try {
    return fn(ctx, req, res, params, body);
  } catch (err) {
    if (err instanceof SkillError) return json(res, err.status, { error: err.message });
    throw err;
  }
};

export function register(router) {
  // → { engine, roots: [{ scope, source, engine }], skills: [{ id, name, description, scope, source, engine, hasSupport }] }
  router.post('/api/projects/:id/skills', withProject(guard(({ hub }, req, res, { project }) => {
    const engine = engineOf(hub, project.id);
    const roots = skillRoots({ engine, projectPath: project.path }).map(({ scope, source, engine: e }) => ({ scope, source, engine: e }));
    return json(res, 200, { engine, roots, skills: listSkills({ engine, projectPath: project.path }).map(({ dir, file, ...rest }) => rest) });
  })));
  // { scope, source, id } → { skill }
  router.post('/api/projects/:id/skills/read', withProject(guard(({ hub }, req, res, { project }, body) => {
    const engine = engineOf(hub, project.id);
    return json(res, 200, { skill: publicSkill(readSkill({ engine, projectPath: project.path, scope: body?.scope, source: body?.source, id: body?.id })) });
  })));
  // { scope, source, id, previous, name, description, content, mtime } → { skill, backedUp }
  router.post('/api/projects/:id/skills/save', withProject(guard(({ hub, isLocal, dataDir }, req, res, { project }, body) => {
    const scope = body?.scope === 'user' ? 'user' : 'project';
    // A move into or out of the "semua project" scope touches the global root too, so both ends need the laptop.
    userScopeFromLaptop({ isLocal }, req, scope);
    userScopeFromLaptop({ isLocal }, req, body?.previousScope);
    const engine = engineOf(hub, project.id);
    const r = saveSkill({
      engine,
      projectPath: project.path,
      scope,
      source: body?.source,
      id: body?.id,
      previous: body?.previous,
      previousScope: body?.previousScope,
      previousSource: body?.previousSource,
      name: body?.name,
      description: body?.description,
      content: body?.content,
      dataDir: hub?.dataDir ?? dataDir,
      baseMtime: body?.mtime,
    });
    console.log(`Skill disimpan: ${r.scope} ${r.id}`);
    return json(res, 200, { ...r, skill: publicSkill(readSkill({ engine, projectPath: project.path, scope, source: body?.source, id: r.id })) });
  })), { maxBody: 300 * 1024 });
  // { scope, source, id } → { ok, backedUp }
  router.post('/api/projects/:id/skills/delete', withProject(guard(({ hub, isLocal, dataDir }, req, res, { project }, body) => {
    const scope = body?.scope === 'user' ? 'user' : 'project';
    userScopeFromLaptop({ isLocal }, req, scope);
    const r = deleteSkill({ engine: engineOf(hub, project.id), projectPath: project.path, scope, source: body?.source, id: body?.id, dataDir: hub?.dataDir ?? dataDir });
    console.log(`Skill dihapus: ${scope} ${String(body?.id).slice(0, 80)}`);
    return json(res, 200, r);
  })));
}
