// ---------- Perubahan → git (changes, diff, commit) and ⎇ branches / remotes ----------
// Reads (changes, diff, git-branches) are allowed over WiFi; commit and git-action (switch/create/fetch/pull/push)
// are actions, refused there by the gate in server.js.
import { GitError, gitAction, gitBranches, gitCommit, gitDiff, gitStatus } from '../git.js';
import { json } from './http.js';
import { withProject, withSession } from './project.js';

export function register(router) {
  router.post('/api/projects/:id/changes', withSession(async (ctx, req, res, { project }) => json(res, 200, await gitStatus(project.path))));
  router.post('/api/projects/:id/diff', withSession(async (ctx, req, res, { project }, body) => json(res, 200, await gitDiff(project.path, String(body.file ?? '')))));
  router.post('/api/projects/:id/commit', withSession(async ({ hub }, req, res, { project }, body) => {
    const message = String(body.message ?? '').trim();
    if (!message) return json(res, 400, { error: 'Pesan commit kosong' });
    const result = await gitCommit(project.path, message.slice(0, 2000));
    if (result.ok) hub.chat(project.id, { kind: 'info', text: `Commit dibuat: ${message.split('\n')[0]}` });
    return json(res, result.ok ? 200 : 400, result.ok ? result : { error: result.output });
  }));
  router.post('/api/projects/:id/git-branches', withProject((ctx, req, res, { project }) => gitTool(res, async () => json(res, 200, await gitBranches(project.path)))));
  router.post('/api/projects/:id/git-action', withProject(({ hub }, req, res, { project }, body) =>
    gitTool(res, async () => {
      const act = String(body.action ?? '');
      const result = await gitAction(project.path, { action: act, name: body.name == null ? undefined : String(body.name), carry: body.carry === true });
      const label = { switch: `Pindah ke branch ${result.branch}`, create: `Branch baru ${result.branch}`, fetch: 'git fetch', pull: 'git pull', push: 'git push' }[act];
      hub.chat(project.id, { kind: 'info', text: `⎇ ${label} berhasil.` });
      if (act === 'push') hub.ciWatch?.(project.id); // ✅ GitHub's checks of the pushed commit
      return json(res, 200, result);
    }),
  ));
}

/** A GitError (branches / remotes) goes back with its status, code and git's own output. */
async function gitTool(res, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GitError) return json(res, err.status, { error: err.output ? `${err.message}\n\n${err.output}` : err.message, code: err.code, output: err.output });
    throw err;
  }
}
