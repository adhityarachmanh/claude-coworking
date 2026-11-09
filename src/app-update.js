// ⬆ Adhitron's own updates: every 30 minutes `git fetch` (no merge) and count the commits the branch is behind its
// upstream. The page shows a banner with what is new; "Update sekarang" (laptop only) does `git pull --ff-only` and
// restarts the server the clean way (scripts/restart.mjs: a running turn is recorded and offered to continue).
// Local changes are never touched: with uncommitted changes or a diverged branch the update is refused.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CHECK_EVERY_MS = 30 * 60_000;
const FIRST_CHECK_MS = 60_000;

function git(cwd, args, timeout = 60_000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', LC_ALL: 'C' } }, (err, out, errOut) =>
      resolve({ ok: !err, out: String(out ?? '').trim(), err: String(errOut ?? '').trim() }),
    );
  });
}

export class AppUpdater {
  /**
   * @param {{ appDir: string, onChange?: (view: object) => void, busy?: () => boolean, firstCheckMs?: number }} opts
   *   busy: true while a turn runs (the update waits: a restart would cut it off)
   */
  constructor({ appDir, onChange = () => {}, busy = () => false, firstCheckMs = FIRST_CHECK_MS }) {
    this.appDir = appDir;
    this.onChange = onChange;
    this.busy = busy;
    this.state = { available: existsSync(path.join(appDir, '.git')), behind: 0, commits: [], branch: null, upstream: null, dirty: false, checkedAt: null, checking: false, updating: false, error: null };
    if (this.state.available && firstCheckMs >= 0) {
      this.timer = setTimeout(() => this.check().catch(() => {}), firstCheckMs);
      this.timer.unref?.();
      this.interval = setInterval(() => this.check().catch(() => {}), CHECK_EVERY_MS);
      this.interval.unref?.();
    }
  }

  publicView() {
    const { available, behind, commits, branch, upstream, dirty, checkedAt, checking, updating, error } = this.state;
    return { available, behind, commits, branch, upstream, dirty, checkedAt, checking, updating, error };
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.onChange(this.publicView());
  }

  /** git fetch + how far behind the upstream; nothing is merged. */
  async check() {
    if (!this.state.available || this.state.checking) return this.publicView();
    this.set({ checking: true, error: null });
    try {
      const branch = await git(this.appDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const upstream = await git(this.appDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      if (!upstream.ok) return this.set({ branch: branch.out, upstream: null, behind: 0, commits: [], error: 'Branch ini tidak punya upstream (git push -u belum pernah dijalankan).' }), this.publicView();
      const fetched = await git(this.appDir, ['fetch', '--quiet', '--no-tags'], 90_000);
      if (!fetched.ok) return this.set({ error: `git fetch gagal: ${fetched.err.split('\n').at(-1) ?? ''}`.slice(0, 300) }), this.publicView();
      const count = await git(this.appDir, ['rev-list', '--count', 'HEAD..@{u}']);
      const ahead = await git(this.appDir, ['rev-list', '--count', '@{u}..HEAD']);
      const log = await git(this.appDir, ['log', '--format=%h%x09%s', '-n', '15', 'HEAD..@{u}']);
      const status = await git(this.appDir, ['status', '--porcelain', '--untracked-files=no']);
      const commits = log.out
        ? log.out.split('\n').map((l) => {
            const [hash, ...subject] = l.split('\t');
            return { hash, subject: subject.join('\t').slice(0, 200) };
          })
        : [];
      this.set({ branch: branch.out, upstream: upstream.out, behind: Number(count.out) || 0, ahead: Number(ahead.out) || 0, commits, dirty: Boolean(status.out), checkedAt: Date.now() });
    } finally {
      this.set({ checking: false });
    }
    return this.publicView();
  }

  /**
   * git pull --ff-only, then a clean restart (detached, so it outlives this process). Refused with local changes,
   * a diverged branch, nothing to pull, or while a turn runs.
   * @returns {Promise<{ ok: boolean, error?: string, pulled?: number }>}
   */
  async update({ restart = true } = {}) {
    if (!this.state.available) return { ok: false, error: 'Folder aplikasi bukan repo git.' };
    if (this.state.updating) return { ok: false, error: 'Update sedang berjalan.' };
    if (this.busy()) return { ok: false, error: 'Masih ada giliran yang berjalan. Update setelah selesai (server akan di-restart).' };
    await this.check();
    if (this.state.dirty) return { ok: false, error: 'Ada perubahan lokal di folder aplikasi yang belum di-commit. Commit/stash dulu.' };
    if (!this.state.behind) return { ok: false, error: 'Sudah versi terbaru.' };
    if (this.state.ahead) return { ok: false, error: 'Branch lokal punya commit yang belum di-push (bercabang dari upstream). Selesaikan dulu dengan git.' };
    this.set({ updating: true, error: null });
    const pulled = this.state.behind;
    const r = await git(this.appDir, ['pull', '--ff-only', '--no-rebase'], 180_000);
    if (!r.ok) {
      this.set({ updating: false, error: `git pull gagal: ${r.err.split('\n').at(-1) ?? ''}`.slice(0, 300) });
      return { ok: false, error: this.state.error };
    }
    console.log(`Update aplikasi: ${pulled} commit ditarik; restart…`);
    this.set({ updating: false, behind: 0, commits: [] }); // pulled: nothing pending (the restart follows)
    if (restart) {
      // Detached + delayed: this request is answered first, then restart.mjs asks this server to shut down cleanly.
      const child = spawn(process.execPath, [path.join(this.appDir, 'scripts', 'restart.mjs')], { cwd: this.appDir, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    }
    return { ok: true, pulled };
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
  }
}
