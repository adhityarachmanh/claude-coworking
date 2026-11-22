// Git worktrees for a project: the app runs `git worktree add/list/remove` itself (there is no engine CLI for it —
// see docs/design-opencode.md → Catatan upstream), then points the engine's cwd at the worktree folder. A worktree
// is an ATTRIBUTE of the project (settings.worktree), never a project of its own.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { childEnv } from './child-env.js';
import { isInside, isWorktreeDir } from './projects.js';

const GIT_TIMEOUT = 15 * 1000;
const MAX_NAME = 64;

/** A worktree action was refused or failed; `code` tells the UI what happened, `output` is git's own message. */
export class WorktreeError extends Error {
  constructor(message, { code = 'failed', status = 400, output = '' } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.output = output;
  }
}

const gitEnv = () => childEnv({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C', LANGUAGE: 'C' });

function git(cwd, args, { timeout = GIT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, env: gitEnv(), windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout, err: (stderr || err?.message || '').trim(), timedOut: Boolean(err?.killed) });
    });
  });
}

/** A worktree name is a lowercase kebab slug: 1–64 chars, starts with a letter or digit. */
export const validWorktreeName = (name) => new RegExp(`^[a-z0-9][a-z0-9-]{0,${MAX_NAME - 1}}$`).test(String(name ?? ''));

/** The folder a worktree lives in: `<project>/.claude/worktrees/<name>`. */
export const worktreePath = (projectPath, name) => path.join(projectPath, '.claude', 'worktrees', name);

/** The branch created for a worktree: `worktree-<name>`. */
export const worktreeBranch = (name) => `worktree-${name}`;

/**
 * Is this path (absolute or relative) a worktree folder, i.e. under `.claude/worktrees/`? Used to keep worktrees
 * out of the project list and the CLI-session mirror: Claude Code records their cwd in ~/.claude.json.
 */
export { isWorktreeDir };

/** `git worktree list --porcelain` output → [{ path, branch, head, isMain }]; the first block is the main worktree. */
export function parseWorktreeList(text) {
  const list = [];
  for (const block of String(text ?? '').split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (!lines.length) continue;
    const entry = {};
    for (const line of lines) {
      if (line.startsWith('worktree ')) entry.path = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) entry.head = line.slice('HEAD '.length).trim();
      else if (line.startsWith('branch refs/heads/')) entry.branch = line.slice('branch refs/heads/'.length).trim();
      else if (line === 'detached') entry.branch = null;
    }
    if (!entry.path) continue;
    entry.branch ??= null;
    entry.head ??= null;
    entry.isMain = list.length === 0;
    list.push(entry);
  }
  return list;
}

/** Is `cwd` inside a git working tree? False when git is missing or the folder is not a repo. */
export async function isGitRepo(cwd) {
  const res = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.out.trim() === 'true';
}

/** Every worktree of the repo at `cwd` (main first); non-repo → []. */
export async function listWorktrees(cwd) {
  if (!(await isGitRepo(cwd))) return [];
  const res = await git(cwd, ['worktree', 'list', '--porcelain']);
  return res.ok ? parseWorktreeList(res.out) : [];
}

/**
 * Creates `<cwd>/.claude/worktrees/<name>` on its own branch `worktree-<name>`.
 * Rejects with `invalid-name` before touching git when the name is bad, `no-repo` when `cwd` is not a git repo.
 */
export async function createWorktree(cwd, name) {
  if (!validWorktreeName(name)) throw new WorktreeError('Nama worktree hanya huruf kecil, angka, dan tanda hubung (1–64 karakter).', { code: 'invalid-name' });
  if (!(await isGitRepo(cwd))) throw new WorktreeError('Folder project ini bukan repository git, jadi belum bisa punya worktree.', { code: 'no-repo' });
  const target = worktreePath(cwd, name);
  const branch = worktreeBranch(name);
  let res = await git(cwd, ['worktree', 'add', target, '-b', branch]);
  if (!res.ok) {
    const first = [res.out, res.err].filter(Boolean).join('\n').trim();
    // Removing a worktree does not delete its branch: reusing the same name would fail with a misleading
    // "branch already exists". Attach the existing branch instead of creating a new one.
    if (/already exists/i.test(first) && /branch/i.test(first)) res = await git(cwd, ['worktree', 'add', target, branch]);
    else if (/already exists|already registered|sudah ada/i.test(first)) throw new WorktreeError(`Worktree "${name}" sudah ada.`, { code: 'exists', status: 409, output: first });
  }
  if (res.ok) return { path: target, branch };
  const output = [res.out, res.err].filter(Boolean).join('\n').trim();
  if (/already exists|already registered|sudah ada/i.test(output)) throw new WorktreeError(`Worktree "${name}" sudah ada.`, { code: 'exists', status: 409, output });
  if (res.timedOut) throw new WorktreeError('Gagal membuat worktree: git tidak menjawab dalam waktu 15 detik.', { code: 'failed', output });
  throw new WorktreeError(`Gagal membuat worktree: ${output || 'git menolak.'}`, { code: 'failed', output });
}

/**
 * Removes a worktree folder. `force` is required to throw away uncommitted changes; without it git refuses and the
 * error becomes `code: 'dirty'` (409). A path that is not a worktree under `cwd` is refused as `invalid`.
 */
export async function removeWorktree(cwd, dirPath, { force = false } = {}) {
  if (!isWorktreeDir(dirPath) || !isInside(dirPath, [cwd])) throw new WorktreeError('Bukan worktree milik project ini.', { code: 'invalid' });
  const res = await git(cwd, ['worktree', 'remove', ...(force ? ['--force'] : []), dirPath]);
  if (res.ok) return;
  const output = [res.out, res.err].filter(Boolean).join('\n').trim();
  // The folder was deleted by hand: git's registration is stale, and `worktree remove` refuses it ("is not a
  // working tree"). Prune the registration so the row can be cleared and the engine stops falling back to it.
  if (/is not a working tree|not a working tree/i.test(output)) {
    await git(cwd, ['worktree', 'prune']);
    return;
  }
  if (!force && /modified or untracked|--force|contains changes|ada perubahan/i.test(output)) {
    throw new WorktreeError('Worktree ini masih punya perubahan yang belum disimpan. Hapus tetap akan membuang perubahan itu.', { code: 'dirty', status: 409, output });
  }
  if (res.timedOut) throw new WorktreeError('Gagal menghapus worktree: git tidak menjawab dalam waktu 15 detik.', { code: 'failed', output });
  throw new WorktreeError(`Gagal menghapus worktree: ${output || 'git menolak.'}`, { code: 'failed', output });
}