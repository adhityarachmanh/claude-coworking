// Read-mostly git helpers for the "Perubahan" (changes) panel: status, per-file diff, commit.
import { execFile } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

const MAX_DIFF = 200 * 1024;
const STATUS_LABEL = { M: 'diubah', A: 'baru', D: 'dihapus', R: 'diganti nama', C: 'disalin', U: 'konflik', '?': 'baru' };

function git(cwd, args, { timeout = 15000, env } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout, err: (stderr || err?.message || '').trim(), timedOut: Boolean(err?.killed) });
    });
  });
}

export async function gitStatus(cwd) {
  const res = await git(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=all']);
  if (!res.ok) return { repo: false, error: /not a git repository/i.test(res.err) ? null : res.err };
  const lines = res.out.split('\n').filter(Boolean);
  const head = lines[0]?.startsWith('## ') ? lines.shift().slice(3) : '';
  const branch = head.split('...')[0].replace(/^No commits yet on /, '');
  const ahead = Number(head.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(head.match(/behind (\d+)/)?.[1] ?? 0);
  const upstream = head.split('...')[1]?.split(' ')[0] || null;
  const files = lines.map((line) => {
    const code = line.slice(0, 2);
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ')[1];
    file = file.replace(/^"(.*)"$/, '$1');
    const key = code.trim()[0] ?? '?';
    return { path: file, code, status: STATUS_LABEL[key] ?? code.trim(), untracked: code === '??' };
  });
  return { repo: true, branch, ahead, behind, upstream, files };
}

/** Diff of one changed file against HEAD (untracked files are shown as all-new). */
export async function gitDiff(cwd, file) {
  const status = await gitStatus(cwd);
  const entry = status.files?.find((f) => f.path === file);
  if (!entry) return { diff: '', error: 'File tidak ada di daftar perubahan' }; // only files git reports
  if (entry.untracked) {
    try {
      const full = path.join(cwd, file);
      // A new symlink may point anywhere (~/.ssh/id_rsa…): show where it points, never what it points at.
      if ((await lstat(full)).isSymbolicLink()) return { diff: `--- /dev/null\n+++ b/${file}\n+symlink → ${await readlink(full)}` };
      const content = await readFile(full, 'utf8');
      const body = content.slice(0, MAX_DIFF).split('\n').map((l) => `+${l}`).join('\n');
      return { diff: `--- /dev/null\n+++ b/${file}\n${body}` };
    } catch (err) {
      return { diff: '', error: err.message };
    }
  }
  let res = await git(cwd, ['diff', 'HEAD', '--', file]);
  if (!res.ok) res = await git(cwd, ['diff', '--cached', '--', file]); // repo without commits yet
  return { diff: res.out.slice(0, MAX_DIFF), truncated: res.out.length > MAX_DIFF, error: res.ok ? undefined : res.err };
}

export async function gitCommit(cwd, message) {
  const add = await git(cwd, ['add', '-A']);
  if (!add.ok) return { ok: false, output: add.err };
  const commit = await git(cwd, ['commit', '-m', message]);
  return { ok: commit.ok, output: (commit.out || commit.err).trim() };
}

// ---------- branches & remotes (Perubahan → ⎇): list, switch, create, fetch, pull, push ----------

/** A git action refused or failed; `code` tells the UI what happened, `output` is git's own (short) message. */
export class GitError extends Error {
  constructor(message, { code = 'failed', status = 409, output = '' } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.output = output;
  }
}

const NET_TIMEOUT = 90 * 1000; // fetch/pull/push talk to a remote
const LOCAL_TIMEOUT = 30 * 1000; // switch/create (hooks may run)
// Never ask for credentials: no terminal prompt, no Git Credential Manager window, no ssh askpass —
// a remote that needs a login fails fast with a message instead of hanging. Messages in English (C locale)
// so they can be recognised below. Nothing here ever reads, asks for or stores a password.
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never', LC_ALL: 'C', LANGUAGE: 'C' });

/** git's stderr/stdout made short and safe to show: no colour codes, no progress redraws, no tokens in URLs. */
export function compactOutput(text, maxLines = 30) {
  const lines = String(text ?? '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .map((l) => l.split('\r').filter(Boolean).pop() ?? '') // progress lines redraw with \r: keep the last state
    .map((l) => l.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@').trimEnd())
    .filter(Boolean);
  const kept = lines.length > maxLines ? ['…', ...lines.slice(-maxLines)] : lines;
  return kept.join('\n').slice(-4000);
}

const AUTH_FAILED = /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|returned error: 40[13]|Invalid username or password|Could not read from remote repository/i;
const NOT_FF_PULL = /Not possible to fast-forward|diverging branches|fatal: Need to specify how to reconcile/i;
const PUSH_REJECTED = /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i;
const WOULD_OVERWRITE = /would be overwritten|Please commit your changes or stash them|untracked working tree files would be/i;
const LOGIN_HINT = 'Remote butuh login. Jalankan sekali dari terminal laptop (mis. git fetch) atau atur credential helper / SSH key, lalu coba lagi. Adhitron tidak pernah meminta atau menyimpan password.';

/**
 * A branch name the user typed, checked before git sees it: never an option (`--upload-pack=…`), no
 * whitespace/control characters, no `..` or `@{`, then `git check-ref-format --branch` has the last word.
 */
export async function checkBranchName(cwd, input) {
  const name = String(input ?? '').trim();
  if (!name) throw new GitError('Nama branch kosong.', { code: 'invalid', status: 400 });
  if (name.length > 200) throw new GitError('Nama branch terlalu panjang (maks 200 karakter).', { code: 'invalid', status: 400 });
  if (name.startsWith('-') || /[\s\u0000-\u001f\u007f~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{') || name === 'HEAD' || name === '@') {
    throw new GitError(`Nama branch "${name}" tidak valid. Pakai huruf, angka, - _ . / (tanpa spasi, tanpa diawali -, tanpa "..").`, { code: 'invalid', status: 400 });
  }
  const res = await git(cwd, ['check-ref-format', '--branch', name]);
  if (!res.ok) throw new GitError(`Nama branch "${name}" ditolak git (check-ref-format).`, { code: 'invalid', status: 400 });
  return name;
}

const TRACK = (track) => ({ ahead: Number(track.match(/ahead (\d+)/)?.[1] ?? 0), behind: Number(track.match(/behind (\d+)/)?.[1] ?? 0), gone: track === 'gone' });

/**
 * Branch overview: current branch + upstream with ahead/behind, the local branches (newest first),
 * remotes, and how many files are uncommitted (switching asks first when there are any).
 */
export async function gitBranches(cwd) {
  const format = '%(HEAD)%00%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(upstream:remotename)%00%(committerdate:unix)';
  const refs = await git(cwd, ['for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/heads']);
  if (!refs.ok) return { repo: false, error: /not a git repository/i.test(refs.err) ? null : compactOutput(refs.err) };
  const branches = refs.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [head, ref, upstream, track, remote, date] = line.split('\0');
      return { name: ref.replace(/^refs\/heads\//, ''), current: head === '*', upstream: upstream || null, remote: remote || null, ...TRACK(track ?? ''), date: Number(date) * 1000 || null };
    });
  const [symbolic, remotes, status] = await Promise.all([
    git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(cwd, ['remote']),
    git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  const current = branches.find((b) => b.current);
  // No commits yet: the branch exists only as HEAD's name; detached: no symbolic ref at all.
  const branch = current?.name ?? (symbolic.ok ? symbolic.out.trim() : null);
  return {
    repo: true,
    branch,
    detached: !symbolic.ok,
    upstream: current?.upstream ?? null,
    ahead: current?.ahead ?? 0,
    behind: current?.behind ?? 0,
    gone: current?.gone ?? false,
    remotes: remotes.out.split('\n').map((r) => r.trim()).filter(Boolean),
    dirty: status.out.split('\n').filter(Boolean).length,
    branches,
  };
}

// One git action per repository at a time (two taps on "Pull" must not race on .git/index.lock).
const busy = new Set();
async function exclusive(cwd, fn) {
  const key = path.resolve(cwd).toLowerCase();
  if (busy.has(key)) throw new GitError('Aksi git lain masih berjalan di project ini. Tunggu sampai selesai.', { code: 'busy' });
  busy.add(key);
  try {
    return await fn();
  } finally {
    busy.delete(key);
  }
}

/** Runs a mutating/network git command; a failure becomes a GitError with a clear reason. */
async function run(cwd, args, { timeout, failed, classify = [] }) {
  const res = await git(cwd, args, { timeout, env: gitEnv() });
  const output = compactOutput([res.out, res.err].filter(Boolean).join('\n'));
  if (res.ok) return output;
  if (res.timedOut) throw new GitError(`${failed}: git tidak selesai dalam ${Math.round(timeout / 1000)} detik (jaringan lambat, atau remote menunggu login).`, { code: 'timeout', output });
  if (AUTH_FAILED.test(output)) throw new GitError(`${failed}: ${LOGIN_HINT}`, { code: 'auth', output });
  for (const [pattern, code, message] of classify) if (pattern.test(output)) throw new GitError(`${failed}: ${message}`, { code, output });
  throw new GitError(`${failed}.`, { code: 'failed', output });
}

const repoInfo = async (cwd) => {
  const info = await gitBranches(cwd);
  if (!info.repo) throw new GitError('Folder ini bukan repository git.', { code: 'no-repo' });
  return info;
};
const DETACHED = () => new GitError('HEAD sedang detached (tidak di branch mana pun). Pindah ke sebuah branch dulu.', { code: 'detached' });
const NO_REMOTE = () => new GitError('Belum ada remote. Tambahkan dulu: git remote add origin <url>.', { code: 'no-remote' });

/**
 * Switch to a local branch. Uncommitted changes: refused (code 'dirty') unless `carry` — then git takes them
 * along, and still refuses by itself when they would be overwritten. Never --force / --discard-changes.
 */
export function gitSwitch(cwd, input, { carry = false } = {}) {
  return exclusive(cwd, async () => {
    const name = await checkBranchName(cwd, input);
    const info = await repoInfo(cwd);
    if (!info.branches.some((b) => b.name === name)) throw new GitError(`Branch "${name}" tidak ada di repository ini.`, { code: 'not-found', status: 404 });
    if (info.branch === name && !info.detached) return { ok: true, branch: name, output: `Sudah di branch ${name}.` };
    if (info.dirty && !carry) {
      throw new GitError(`Ada ${info.dirty} file belum di-commit. Commit dulu, atau pilih "bawa perubahan" (git menolak bila perubahan itu bertabrakan dengan branch tujuan).`, { code: 'dirty' });
    }
    const output = await run(cwd, ['switch', '--no-guess', name], {
      timeout: LOCAL_TIMEOUT,
      failed: `Gagal pindah ke ${name}`,
      classify: [[WOULD_OVERWRITE, 'conflict', 'perubahan yang belum di-commit akan tertimpa oleh branch tujuan. Commit atau stash dulu.']],
    });
    return { ok: true, branch: name, output };
  });
}

/** New branch from the current commit, switched to right away (uncommitted changes come along, as `git switch -c`). */
export function gitCreateBranch(cwd, input) {
  return exclusive(cwd, async () => {
    const name = await checkBranchName(cwd, input);
    const info = await repoInfo(cwd);
    if (info.branches.some((b) => b.name === name)) throw new GitError(`Branch "${name}" sudah ada. Pilih dari daftar untuk pindah ke sana.`, { code: 'exists' });
    const output = await run(cwd, ['switch', '-c', name], { timeout: LOCAL_TIMEOUT, failed: `Gagal membuat branch ${name}` });
    return { ok: true, branch: name, output };
  });
}

export function gitFetch(cwd) {
  return exclusive(cwd, async () => {
    const info = await repoInfo(cwd);
    if (!info.remotes.length) throw NO_REMOTE();
    const output = await run(cwd, ['fetch', '--all', '--prune'], { timeout: NET_TIMEOUT, failed: 'Fetch gagal' });
    return { ok: true, output: output || 'Fetch selesai, tidak ada yang baru.' };
  });
}

/** Pull, fast-forward only (never a surprise merge commit or rebase): diverged branches are reported. */
export function gitPull(cwd) {
  return exclusive(cwd, async () => {
    const info = await repoInfo(cwd);
    if (info.detached) throw DETACHED();
    if (!info.upstream) throw new GitError(`Branch ${info.branch} belum punya upstream. Push dulu (upstream dipasang otomatis).`, { code: 'no-upstream' });
    const output = await run(cwd, ['pull', '--no-rebase', '--ff-only'], {
      timeout: NET_TIMEOUT,
      failed: 'Pull ditolak',
      classify: [
        [NOT_FF_PULL, 'non-ff', 'branch lokal dan remote sudah bercabang (tidak bisa fast-forward). Selesaikan dengan merge/rebase di terminal, atau minta Claude.'],
        [WOULD_OVERWRITE, 'conflict', 'perubahan lokal yang belum di-commit akan tertimpa. Commit atau stash dulu.'],
        [/CONFLICT|unmerged/i, 'conflict', 'ada konflik. Selesaikan di terminal.'],
      ],
    });
    return { ok: true, output: output || 'Sudah up to date.' };
  });
}

/**
 * Push the current branch. Without an upstream: `--set-upstream` to origin (or the only remote).
 * Never --force: a rejected push is reported ("pull dulu").
 */
export function gitPush(cwd) {
  return exclusive(cwd, async () => {
    const info = await repoInfo(cwd);
    if (info.detached || !info.branch) throw DETACHED();
    if (!info.branches.some((b) => b.name === info.branch)) throw new GitError('Belum ada commit untuk di-push.', { code: 'empty' });
    const classify = [[PUSH_REJECTED, 'non-ff', 'remote punya commit yang belum ada di sini. Pull dulu, lalu push lagi (tidak pernah --force).']];
    if (info.upstream && !info.gone) return { ok: true, output: await run(cwd, ['push'], { timeout: NET_TIMEOUT, failed: 'Push gagal', classify }) };
    if (!info.remotes.length) throw NO_REMOTE();
    const remote = info.remotes.includes('origin') ? 'origin' : info.remotes.length === 1 ? info.remotes[0] : null;
    if (!remote || remote.startsWith('-')) {
      throw new GitError(`Ada beberapa remote (${info.remotes.join(', ')}) tanpa "origin". Atur upstream sekali di terminal: git push -u <remote> ${info.branch}.`, { code: 'no-upstream' });
    }
    const name = await checkBranchName(cwd, info.branch);
    const output = await run(cwd, ['push', '--set-upstream', remote, name], { timeout: NET_TIMEOUT, failed: 'Push gagal', classify });
    return { ok: true, upstream: `${remote}/${name}`, output };
  });
}

/** POST /api/projects/:id/git-action: { action: switch|create|fetch|pull|push, name?, carry? }. */
export function gitAction(cwd, { action, name, carry } = {}) {
  switch (action) {
    case 'switch':
      return gitSwitch(cwd, name, { carry: carry === true });
    case 'create':
      return gitCreateBranch(cwd, name);
    case 'fetch':
      return gitFetch(cwd);
    case 'pull':
      return gitPull(cwd);
    case 'push':
      return gitPush(cwd);
    default:
      return Promise.reject(new GitError('Aksi git tidak dikenal.', { code: 'invalid', status: 400 }));
  }
}
