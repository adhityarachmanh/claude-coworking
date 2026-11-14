// 🗂 Parent groups: related repos (web + api + mobile = one product) referenced under one named group. The merged
// session list only READS each member's conversations (the same building blocks the per-project route uses) —
// sessions are never moved. Mutating group routes are laptop-only (LOCAL_ONLY in server.js).
import { json } from './http.js';
import { projectSessions } from './session.js';

export function register(router) {
  // List: groups + the projects each could add (the management dialog's raw material).
  router.post('/api/groups/list', ({ hub }, req, res) => {
    const groups = hub.projectGroups().map((g) => ({ ...g }));
    const taken = new Set(groups.flatMap((g) => g.members));
    const projects = [...hub.projects.values()].filter((p) => p.id !== 'demo').map((p) => ({ id: p.id, name: p.name, inGroup: taken.has(p.id) ? (hub.groupOf(p.id)?.name ?? true) : null }));
    return json(res, 200, { groups, projects });
  });
  // Create: a real name, members that exist. Folder semantics: a member already in another group moves here.
  router.post('/api/groups', ({ hub }, req, res, params, body) => {
    const group = hub.createProjectGroup(body?.name, body?.members);
    if (!group) return json(res, 400, { error: 'Nama grup wajib (maks 60 karakter) dan anggota harus project yang ada.' });
    return json(res, 200, { group });
  });
  // Update: rename, add members (moving them from their previous group) and/or remove members.
  router.post('/api/groups/:id', ({ hub }, req, res, { id }, body) => {
    const group = hub.updateProjectGroup(id, { name: body?.name, add: body?.add, remove: body?.remove });
    if (!group) return json(res, id && hub.projectGroups().some((g) => g.id === id) ? 400 : 404, { error: 'Grup tidak ditemukan, atau anggota/permintaan tidak valid.' });
    return json(res, 200, { group });
  });
  // Dissolve the group only: the members' projects, sessions and data are untouched.
  router.post('/api/groups/:id/dissolve', ({ hub }, req, res, { id }) => {
    if (!hub.dissolveProjectGroup(id)) return json(res, 404, { error: 'Grup tidak ditemukan.' });
    return json(res, 200, { ok: true });
  });
  // The group's merged session list: every member's conversations, newest first, each labelled with its source
  // repo. A reference, never a move: the entries stay in their own repos.
  router.post('/api/groups/:id/sessions', async ({ hub, opencode, ledger }, req, res, { id }) => {
    const group = hub.projectGroups().find((g) => g.id === id);
    if (!group) return json(res, 404, { error: 'Grup tidak ditemukan.' });
    const merged = [];
    for (const memberId of group.members) {
      const project = hub.projects.get(memberId);
      if (!project) continue; // a member that vanished (forgotten elsewhere) contributes nothing
      const { sessions, engine } = await projectSessions({ hub, opencode, ledger }, project);
      for (const s of sessions) merged.push({ ...s, project: memberId, projectName: project.name, engine });
    }
    merged.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    return json(res, 200, { group: id, name: group.name, sessions: merged.slice(0, 200) });
  });
}
