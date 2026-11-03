// ✅ Pemeriksaan CI GitHub setelah push: after a push (⬆ Push, a pull request, or a `git push` the team ran), the
// GitHub Actions runs of the pushed commit are followed with `gh run list` until they finish. The project's status
// carries `ci` ({ state: 'running'|'success'|'failure'|'none'|'login', runs, sha, url }) for the chip in the Changes tab;
// the chat gets one line when they finish. Read-only: nothing is re-run or changed on GitHub.
import { execFileTree } from './proc.js';

const POLL_MS = 20_000;
const FIRST_MS = 8000; // GitHub needs a moment to register the runs of a fresh push
const NO_RUNS_MS = 3 * 60_000; // no run for the commit by then: the repo has no workflow for it
const MAX_MS = 45 * 60_000;

const asNode = (bin) => (/\.[cm]?js$/.test(bin) ? { command: process.execPath, pre: [bin] } : { command: bin, pre: [] });

function exec(command, args, cwd, timeout = 30_000) {
  return new Promise((resolve) => {
    execFileTree(command, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' } }, (err, out, errOut) =>
      resolve({ ok: !err, out: String(out ?? ''), err: String(errOut ?? '') }),
    );
  });
}

/** The pushed commit's runs: { state, runs: [{ name, status, conclusion, url }], sha, url } (state 'pending' = none yet). */
export async function ciRuns(bin, cwd) {
  const head = await exec('git', ['rev-parse', 'HEAD'], cwd, 10_000);
  const branch = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 10_000);
  const sha = head.out.trim();
  if (!head.ok || !/^[0-9a-f]{40}$/.test(sha)) return { state: 'none', runs: [], sha: null, url: null };
  const { command, pre } = asNode(bin);
  const r = await exec(command, [...pre, 'run', 'list', '--branch', branch.out.trim(), '--limit', '20', '--json', 'databaseId,name,workflowName,status,conclusion,headSha,url'], cwd);
  if (!r.ok) {
    if (/auth login|not logged|authentication/i.test(r.err)) return { state: 'login', runs: [], sha, url: null };
    return { state: 'error', runs: [], sha, url: null, error: r.err.trim().split('\n').at(-1)?.slice(0, 160) ?? '' };
  }
  let list = [];
  try {
    list = JSON.parse(r.out);
  } catch {
    list = [];
  }
  const runs = (Array.isArray(list) ? list : [])
    .filter((x) => x?.headSha === sha)
    .map((x) => ({ name: String(x.workflowName || x.name || 'CI').slice(0, 80), status: String(x.status ?? ''), conclusion: String(x.conclusion ?? ''), url: typeof x.url === 'string' && x.url.startsWith('https://github.com/') ? x.url : null }));
  if (!runs.length) return { state: 'pending', runs, sha, url: null };
  const running = runs.some((x) => x.status !== 'completed');
  const failed = runs.find((x) => x.status === 'completed' && !['success', 'skipped', 'neutral'].includes(x.conclusion));
  return { state: running ? 'running' : failed ? 'failure' : 'success', runs, sha, url: (failed ?? runs[0]).url };
}

export class CiWatcher {
  /** @param {{ hub: object, gh: string|null, check?: typeof ciRuns, pollMs?: number, firstMs?: number }} options */
  constructor({ hub, gh, check = ciRuns, pollMs = POLL_MS, firstMs = FIRST_MS }) {
    this.hub = hub;
    this.gh = gh;
    this.check = check;
    this.pollMs = pollMs;
    this.firstMs = firstMs;
    this.watching = new Map(); // project id -> { timer, since }
    this.loginNoted = false;
  }

  /** Follows the runs of the project's current commit (restarts when already following an older push). */
  watch(projectId) {
    const project = this.hub.projects.get(projectId);
    if (!this.gh || !project?.path) return false;
    clearTimeout(this.watching.get(projectId)?.timer);
    const w = { since: Date.now(), timer: null };
    this.watching.set(projectId, w);
    this.hub.setStatus(projectId, { ci: { state: 'pending', runs: [], sha: null, url: null } });
    w.timer = setTimeout(() => this.poll(projectId, w), this.firstMs);
    w.timer.unref?.();
    return true;
  }

  async poll(projectId, w) {
    if (this.watching.get(projectId) !== w) return;
    const project = this.hub.projects.get(projectId);
    if (!project) return this.watching.delete(projectId);
    const ci = await this.check(this.gh, project.path).catch((err) => ({ state: 'error', runs: [], error: err.message }));
    if (this.watching.get(projectId) !== w) return;
    const age = Date.now() - w.since;
    if (ci.state === 'pending' && age >= NO_RUNS_MS) ci.state = 'none';
    this.hub.setStatus(projectId, { ci });
    const done = ['success', 'failure', 'none', 'login', 'error'].includes(ci.state) || age >= MAX_MS;
    if (!done) {
      w.timer = setTimeout(() => this.poll(projectId, w), this.pollMs);
      w.timer.unref?.();
      return;
    }
    this.watching.delete(projectId);
    const names = ci.runs?.map((r) => r.name).join(', ');
    if (ci.state === 'success') this.hub.chat(projectId, { kind: 'info', text: `✅ CI GitHub lulus: ${names}` });
    else if (ci.state === 'failure') this.hub.chat(projectId, { kind: 'error', text: `❌ CI GitHub gagal: ${ci.runs.filter((r) => r.conclusion && r.conclusion !== 'success').map((r) => `${r.name} (${r.conclusion})`).join(', ')}${ci.url ? ` — ${ci.url}` : ''}` });
    else if (ci.state === 'login' && !this.loginNoted) {
      this.loginNoted = true;
      this.hub.chat(projectId, { kind: 'info', text: 'Pemeriksaan CI GitHub butuh login GitHub CLI: tab Perubahan → 🔀 Buat PR → Login GitHub.' });
    } else if (age >= MAX_MS && ci.state === 'running') this.hub.chat(projectId, { kind: 'info', text: `⏳ CI GitHub masih berjalan setelah 45 menit${ci.url ? `: ${ci.url}` : ''}.` });
  }

  stop() {
    for (const w of this.watching.values()) clearTimeout(w.timer);
    this.watching.clear();
  }
}
