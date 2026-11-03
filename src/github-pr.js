// Pull request without the terminal: GitHub CLI (`gh`) status, its browser login (one-time device code shown in the
// app, like `gh auth login --web`) and `gh pr create` after the branch is pushed. Nothing is stored by the app:
// gh keeps its own credentials.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileTree } from './proc.js';

export class PrError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** gh on PATH (or the usual Windows install folder). */
export function findGh() {
  const exe = process.platform === 'win32' ? 'gh.exe' : 'gh';
  if (process.env.OFFICE_GH_BIN) return process.env.OFFICE_GH_BIN;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  const pf = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', exe);
  return existsSync(pf) ? pf : null;
}

const asNode = (bin) => (/\.[cm]?js$/.test(bin) ? { command: process.execPath, pre: [bin] } : { command: bin, pre: [] });

function gh(bin, args, { cwd, timeout = 60_000 } = {}) {
  const { command, pre } = asNode(bin);
  return new Promise((resolve) => {
    execFileTree(command, [...pre, ...args], { cwd, encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' } }, (error, out, err) =>
      resolve({ ok: !error, out: String(out ?? ''), err: String(err ?? '') }),
    );
  });
}

/** { installed, loggedIn, account } — `gh auth status` prints to stderr. */
export async function ghStatus(bin) {
  if (!bin) return { installed: false, loggedIn: false, account: null };
  const r = await gh(bin, ['auth', 'status', '--hostname', 'github.com'], { timeout: 20_000 });
  const text = `${r.out}\n${r.err}`;
  const account = /Logged in to github\.com (?:account|as) ([\w-]+)/i.exec(text)?.[1] ?? null;
  return { installed: true, loggedIn: r.ok && Boolean(account || /Logged in/i.test(text)), account };
}

// ---------- browser login (device code) ----------

let login = null; // { child, state: 'starting'|'waiting'|'done'|'error', code, url, error, timer }

/** The running login's public state (never the token: gh stores it itself). */
export const ghLoginState = () => (login ? { state: login.state, code: login.code ?? null, url: login.url ?? null, error: login.error ?? null } : null);

/** The login as a plain-WiFi (sniffable, read-only) client sees it: the state only, never the device code or link. */
export const wifiGithubLogin = (state) => (state ? { ...state, code: null, url: null } : state);

export function ghLoginStart(bin, { onChange = () => {} } = {}) {
  if (!bin) throw new PrError(404, 'GitHub CLI (gh) belum terpasang. Pasang dari https://cli.github.com lalu muat ulang.');
  if (login?.state === 'waiting' || login?.state === 'starting') return Promise.resolve(ghLoginState());
  const { command, pre } = asNode(bin);
  const child = spawn(command, [...pre, 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'], {
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', BROWSER: 'none' },
  });
  login = { child, state: 'starting' };
  const mine = login;
  let buf = '';
  const read = (d) => {
    buf += d;
    const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(buf)?.[1];
    const url = /(https:\/\/github\.com\/login\/device)/i.exec(buf)?.[1];
    if (code && mine.state === 'starting') {
      Object.assign(mine, { state: 'waiting', code, url: url ?? 'https://github.com/login/device' });
      child.stdin.write('\n'); // "Press Enter to open github.com in your browser…": the app shows the link instead
      onChange();
    }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  child.on('error', (err) => Object.assign(mine, { state: 'error', error: err.message }) && onChange());
  child.on('exit', (code) => {
    clearTimeout(mine.timer);
    if (mine.state === 'cancelled') return;
    Object.assign(mine, code === 0 ? { state: 'done' } : { state: 'error', error: buf.split('\n').map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? `gh keluar (${code})` });
    onChange();
  });
  mine.timer = setTimeout(() => ghLoginCancel(), 15 * 60_000);
  // The answer waits for gh's one-time code (or its failure): the page shows it right away.
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => (mine.state !== 'starting' || Date.now() - started > 15_000 ? resolve(ghLoginState()) : setTimeout(tick, 100));
    tick();
  });
}

export function ghLoginCancel() {
  if (!login) return;
  clearTimeout(login.timer);
  if (login.state === 'waiting' || login.state === 'starting') {
    login.state = 'cancelled';
    login.child.kill();
  }
}

// ---------- pull request ----------

/** A branch name gh may get as --base: starts with a letter or digit (never an option), git ref characters only. */
const BASE = /^[A-Za-z0-9][\w./-]{0,199}$/;

/** git in the project; the trimmed stdout, null on failure. */
function git(cwd, args) {
  return new Promise((resolve) => {
    execFileTree('git', args, { cwd, encoding: 'utf8', timeout: 15_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, out) =>
      resolve(error ? null : String(out ?? '').trim()),
    );
  });
}

/** The remote's default branch: <remote>/HEAD as git knows it, else what GitHub says through gh; '' when unknown. */
async function defaultBranch(bin, cwd, remote) {
  const ref = await git(cwd, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
  if (ref?.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
  if (!bin) return '';
  const r = await gh(bin, ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], { cwd, timeout: 20_000 });
  return r.ok ? r.out.trim() : '';
}

/**
 * Checked before anything is pushed: no PR from the target branch into itself, none from the repository's default
 * branch (a PR needs its own branch; pushing main from here would publish its commits right away).
 * @returns {Promise<{ branch: string, defaultBranch: string|null }>}
 */
export async function checkPrBranch(bin, cwd, { base = '' } = {}) {
  const wanted = String(base ?? '').trim();
  if (wanted && !BASE.test(wanted)) throw new PrError(400, 'Branch tujuan tidak valid.');
  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) throw new PrError(409, 'Tidak sedang di sebuah branch (detached HEAD). Pindah ke branch fitur dulu.');
  if (wanted === branch) throw new PrError(409, `Branch saat ini (${branch}) sama dengan branch tujuan. Pindah ke (atau buat) branch fitur dulu, lalu buat PR.`);
  const remote = (await git(cwd, ['config', '--get', `branch.${branch}.remote`])) || 'origin';
  const main = /^[\w.-]+$/.test(remote) ? await defaultBranch(bin, cwd, remote) : '';
  if (main && main === branch) throw new PrError(409, `Kamu sedang di branch utama (${branch}). Pull request harus dari branch lain: buat branch baru dulu (mis. fitur/nama-perubahan), commit di sana, lalu buat PR.`);
  return { branch, defaultBranch: main || null };
}

/**
 * `gh pr create` for the current branch (pushed first by the caller). Returns the PR's URL.
 * @param {{ title: string, body?: string, base?: string, draft?: boolean }} pr
 */
export async function createPr(bin, cwd, { title, body = '', base = '', draft = false }) {
  if (!bin) throw new PrError(404, 'GitHub CLI (gh) belum terpasang.');
  const t = String(title ?? '').trim();
  if (!t || t.length > 256) throw new PrError(400, 'Judul PR wajib (maks 256 karakter).');
  if (String(body).length > 60_000) throw new PrError(413, 'Deskripsi terlalu panjang.');
  if (base && !BASE.test(base)) throw new PrError(400, 'Branch tujuan tidak valid.');
  // --flag=value: a title or body starting with "-" is never read as another option.
  const args = ['pr', 'create', `--title=${t}`, `--body=${String(body ?? '')}`];
  if (base) args.push(`--base=${base}`);
  if (draft) args.push('--draft');
  const r = await gh(bin, args, { cwd, timeout: 120_000 });
  const url = /https:\/\/\S+\/pull\/\d+/.exec(`${r.out}\n${r.err}`)?.[0];
  if (!r.ok && !url) throw new PrError(502, `${r.err || r.out}`.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 400) || 'gh pr create gagal.');
  return { url: url ?? null, output: `${r.out}`.trim().slice(0, 2000) };
}
