// ⬆ Auto-update for a packaged Adhit Office (Windows installer): GitHub Releases + SHA-256, never an unverified
// installer. The UI keeps the same shape as src/app-update.js (behind/commits/check/update), so the existing banner
// and ⚙ section work in both modes. Code signing is still required before this is safe against a compromised repo.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const CHECK_EVERY_MS = 30 * 60_000;
const FIRST_CHECK_MS = 60_000;
const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const ALLOWED_ASSET = /^https:\/\/(?:github\.com|(?:[\w-]+\.)*githubusercontent\.com)\//i;

const versionParts = (v) => String(v ?? '').replace(/^v/i, '').split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
const isNewer = (latest, current) => {
  const a = versionParts(latest);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
};

const shortError = (err) => String(err?.message ?? err ?? 'gagal').replace(/\s+/g, ' ').slice(0, 240);

export class DesktopUpdater {
  /**
   * @param {{ currentVersion: string, dataDir: string, repo?: string, onChange?: Function, busy?: Function,
   *           fetch?: Function, firstCheckMs?: number }} opts
   */
  constructor({ currentVersion, dataDir, repo = 'adhityarachmanh/claude-coworking', onChange = () => {}, busy = () => false, fetch: fetchImpl = globalThis.fetch, firstCheckMs = FIRST_CHECK_MS }) {
    this.currentVersion = currentVersion;
    this.dataDir = dataDir;
    this.repo = repo;
    this.onChange = onChange;
    this.busy = busy;
    this.fetch = fetchImpl;
    this.download = null;
    mkdirSync(path.join(dataDir, 'updates'), { recursive: true });
    this.state = {
      available: true,
      mode: 'desktop',
      currentVersion,
      latestVersion: null,
      behind: 0,
      commits: [],
      branch: 'terpasang',
      upstream: 'GitHub Releases',
      dirty: false,
      checkedAt: null,
      checking: false,
      updating: false,
      installing: false,
      error: null,
      installerUrl: null,
      sha256Url: null,
      size: null,
      notes: null,
    };
    pruneOldDownloads(path.join(dataDir, 'updates'));
    if (firstCheckMs >= 0) {
      this.timer = setTimeout(() => this.check().catch(() => {}), firstCheckMs);
      this.timer.unref?.();
      this.interval = setInterval(() => this.check().catch(() => {}), CHECK_EVERY_MS);
      this.interval.unref?.();
    }
  }

  publicView() {
    const { available, mode, currentVersion, latestVersion, behind, commits, branch, upstream, dirty, checkedAt, checking, updating, installing, error, size, notes } = this.state;
    return { available, mode, currentVersion, latestVersion, behind, commits, branch, upstream, dirty, checkedAt, checking, updating, installing, error, size, notes };
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.onChange(this.publicView());
  }

  async check() {
    if (this.state.checking) return this.publicView();
    this.set({ checking: true, error: null });
    try {
      const response = await this.fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AdhitOffice' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 404) throw new Error('Belum ada rilis GitHub untuk aplikasi ini.');
      if (!response.ok) throw new Error(`GitHub membalas ${response.status}`);
      const release = await response.json();
      const latest = String(release?.tag_name ?? '').replace(/^v/i, '').trim();
      if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error('Rilis terbaru tidak punya tag versi yang valid.');
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const installer = assets.find((asset) => asset?.name === `AdhitOffice-Setup-${latest}.exe`);
      const checksum = assets.find((asset) => asset?.name === `${installer?.name}.sha256`);
      const newer = isNewer(latest, this.currentVersion);
      if (newer && (!installer || !checksum)) throw new Error('Rilis terbaru tidak menyertakan installer + SHA-256.');
      const commits = newer ? [{ hash: latest, subject: `Adhit Office ${latest}` }] : [];
      this.set({
        latestVersion: latest,
        behind: newer ? 1 : 0,
        commits,
        installerUrl: installer?.browser_download_url ?? null,
        sha256Url: checksum?.browser_download_url ?? null,
        size: Number(installer?.size) || null,
        notes: String(release?.body ?? '').slice(0, 2000) || null,
        checkedAt: Date.now(),
      });
    } catch (err) {
      this.set({ error: shortError(err) });
    } finally {
      this.set({ checking: false });
    }
    return this.publicView();
  }

  /** Download + verify the installer; nothing is executed here. */
  async prepare() {
    if (!this.state.behind) throw new Error('Sudah versi terbaru.');
    if (this.state.installing || this.state.updating) throw new Error('Update sedang berjalan.');
    if (this.download) return this.download;
    this.download = this.downloadInstaller().finally(() => { this.download = null; });
    return this.download;
  }

  async downloadInstaller() {
    const version = this.state.latestVersion;
    const installerUrl = this.state.installerUrl;
    const shaUrl = this.state.sha256Url;
    if (!ALLOWED_ASSET.test(String(installerUrl)) || !ALLOWED_ASSET.test(String(shaUrl))) throw new Error('URL installer bukan dari GitHub.');
    this.set({ downloading: true, error: null });
    try {
      const shaResponse = await this.fetch(shaUrl, { signal: AbortSignal.timeout(30_000) });
      if (!shaResponse.ok) throw new Error(`Checksum tidak bisa diunduh (${shaResponse.status}).`);
      const expected = /^([a-f0-9]{64})\b/i.exec((await shaResponse.text()).trim())?.[1]?.toLowerCase();
      if (!expected) throw new Error('File SHA-256 tidak valid.');

      const response = await this.fetch(installerUrl, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Installer tidak bisa diunduh (${response.status}).`);
      if (!ALLOWED_ASSET.test(String(response.url))) throw new Error('Installer dialihkan ke host yang tidak dikenal.');
      const length = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(length) && length > MAX_INSTALLER_BYTES) throw new Error('Installer terlalu besar.');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_INSTALLER_BYTES) throw new Error('Installer terlalu besar.');
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected) throw new Error('SHA-256 installer tidak cocok; unduhan dibatalkan.');

      const dir = path.join(this.dataDir, 'updates');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `AdhitOffice-Setup-${version}.exe`);
      writeFileSync(file, bytes, { mode: 0o600 });
      this.setStateSafe({ downloaded: { file, version, sha256: actual, at: Date.now() } });
      return this.state.downloaded;
    } finally {
      this.set({ downloading: false });
    }
  }

  /** Download (if needed), then run the signed/verified installer detached and let it replace this executable. */
  async update() {
    if (process.platform !== 'win32') return { ok: false, error: 'Update otomatis build terpasang baru tersedia di Windows.' };
    if (this.busy()) return { ok: false, error: 'Masih ada giliran yang berjalan. Update setelah selesai (server akan di-restart).' };
    if (this.state.downloading || this.state.installing) return { ok: false, error: 'Update sedang berjalan.' };
    if (!this.state.behind) await this.check();
    if (!this.state.behind) return { ok: false, error: 'Sudah versi terbaru.' };
    let file = this.state.downloaded?.version === this.state.latestVersion ? this.state.downloaded.file : null;
    if (!file || !existsSync(file)) {
      try {
        file = (await this.prepare()).file;
      } catch (err) {
        this.set({ error: shortError(err) });
        return { ok: false, error: this.state.error };
      }
    }
    this.set({ updating: true, installing: true, error: null });
    try {
      const child = spawn(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/TASKS='], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      // The installer closes this process (PrepareToInstall taskkill); exiting here releases the exe for replacement.
      setTimeout(() => process.exit(0), 1500).unref?.();
      return { ok: true, pulled: 1, version: this.state.latestVersion };
    } catch (err) {
      this.set({ updating: false, installing: false, error: shortError(err) });
      return { ok: false, error: this.state.error };
    }
  }

  setStateSafe(patch) {
    Object.assign(this.state, patch);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
  }
}

/** Only the newest verified installer is kept; older files are safe to remove. */
function pruneOldDownloads(dir) {
  try {
    for (const name of readdirSync(dir)) {
      if (/^AdhitOffice-Setup-.*\.exe$/i.test(name)) rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    // no updates folder yet
  }
}
