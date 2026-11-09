// ⬆ Auto-update for a packaged Adhitron (Windows installer): GitHub Releases + SHA-256, never an unverified
// installer. The UI keeps the same shape as src/app-update.js (behind/commits/check/update), so the existing banner
// and ⚙ section work in both modes. Code signing is still required before this is safe against a compromised repo.
import { createHash, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const CHECK_EVERY_MS = 30 * 60_000;
const FIRST_CHECK_MS = 60_000;
const MAX_INSTALLER_BYTES = 300 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const ALLOWED_ASSET = /^https:\/\/(?:github\.com|(?:[\w-]+\.)*githubusercontent\.com)\//i;
// Installer asset name. The app was renamed Adhit Office → Adhitron, so the installer is "Adhitron-Setup-<v>.exe"
// while an installed 1.0.9 only looks for "AdhitOffice-Setup-<v>.exe". The release that renames publishes the same
// file under both names (see .github/workflows/release.yml); the new name is read first, the legacy one is a fallback.
const INSTALLER_BASE_NAMES = ['Adhitron', 'AdhitOffice'];
const installerAssetNames = (version) => INSTALLER_BASE_NAMES.map((base) => `${base}-Setup-${version}.exe`);
const LOCAL_INSTALLER = /^(?:Adhitron|AdhitOffice)-Setup-.*\.exe(?:\.part)?$/i;

const versionParts = (v) => String(v ?? '').replace(/^v/i, '').split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
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
  constructor({ currentVersion, dataDir, repo = 'adhityarachmanh/claude-coworking', publicKey = null, onChange = () => {}, busy = () => false, onBeforeExit = null, fetch: fetchImpl = globalThis.fetch, firstCheckMs = FIRST_CHECK_MS }) {
    this.currentVersion = currentVersion;
    this.dataDir = dataDir;
    this.repo = /^[\w.-]+\/[\w.-]+$/.test(String(repo)) ? String(repo) : 'adhityarachmanh/claude-coworking';
    this.publicKey = publicKey || null; // PEM Ed25519; when set, a valid .sig asset is mandatory
    this.onChange = onChange;
    this.busy = busy;
    this.onBeforeExit = onBeforeExit;
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
      signatureUrl: null,
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
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Adhitron' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 404) throw new Error('Belum ada rilis GitHub untuk aplikasi ini.');
      if (!response.ok) throw new Error(`GitHub membalas ${response.status}`);
      const release = await response.json();
      const latest = String(release?.tag_name ?? '').replace(/^v/i, '').trim();
      if (!STABLE_VERSION.test(latest)) throw new Error('Rilis terbaru tidak punya tag versi stabil (x.y.z).');
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const installer = installerAssetNames(latest).map((name) => assets.find((asset) => asset?.name === name)).find(Boolean);
      const checksum = assets.find((asset) => asset?.name === `${installer?.name}.sha256`);
      const signature = assets.find((asset) => asset?.name === `${installer?.name}.sig`);
      const newer = isNewer(latest, this.currentVersion);
      if (newer && (!installer || !checksum)) throw new Error('Rilis terbaru tidak menyertakan installer + SHA-256.');
      if (newer && this.publicKey && !signature) throw new Error('Rilis terbaru tidak ditandatangani (butuh .sig).');
      const commits = newer ? [{ hash: latest, subject: `Adhitron ${latest}` }] : [];
      this.set({
        latestVersion: latest,
        behind: newer ? 1 : 0,
        commits,
        installerUrl: installer?.browser_download_url ?? null,
        sha256Url: checksum?.browser_download_url ?? null,
        signatureUrl: signature?.browser_download_url ?? null,
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
    if (this.state.installing) throw new Error('Update sedang berjalan.');
    if (this.download) return this.download;
    this.download = this.downloadInstaller().finally(() => { this.download = null; });
    return this.download;
  }

  async downloadInstaller() {
    const version = this.state.latestVersion;
    const installerUrl = this.state.installerUrl;
    const shaUrl = this.state.sha256Url;
    const sigUrl = this.state.signatureUrl;
    if (!ALLOWED_ASSET.test(String(installerUrl)) || !ALLOWED_ASSET.test(String(shaUrl))) throw new Error('URL installer bukan dari GitHub.');
    if (this.publicKey && !ALLOWED_ASSET.test(String(sigUrl))) throw new Error('Rilis tidak menyertakan tanda tangan yang valid.');
    this.set({ downloading: true, error: null });
    try {
      const shaResponse = await this.fetch(shaUrl, { signal: AbortSignal.timeout(30_000) });
      if (!shaResponse.ok) throw new Error(`Checksum tidak bisa diunduh (${shaResponse.status}).`);
      const shaText = await shaResponse.text();
      if (shaText.length > 4096) throw new Error('File SHA-256 terlalu besar.');
      const expected = /^([a-f0-9]{64})\b/i.exec(shaText.trim())?.[1]?.toLowerCase();
      if (!expected) throw new Error('File SHA-256 tidak valid.');

      let signature = null;
      if (this.publicKey) {
        const sigResponse = await this.fetch(sigUrl, { signal: AbortSignal.timeout(30_000) });
        if (!sigResponse.ok) throw new Error(`Tanda tangan tidak bisa diunduh (${sigResponse.status}).`);
        const sigText = await sigResponse.text();
        if (sigText.length > 4096) throw new Error('File tanda tangan terlalu besar.');
        signature = Buffer.from(sigText.trim(), 'base64');
      }

      const response = await this.fetch(installerUrl, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Installer tidak bisa diunduh (${response.status}).`);
      if (!ALLOWED_ASSET.test(String(response.url))) throw new Error('Installer dialihkan ke host yang tidak dikenal.');
      const length = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(length) && length > MAX_INSTALLER_BYTES) throw new Error('Installer terlalu besar.');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_INSTALLER_BYTES) throw new Error('Installer terlalu besar.');
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected) throw new Error('SHA-256 installer tidak cocok; unduhan dibatalkan.');
      if (this.publicKey && !verify(null, bytes, this.publicKey, signature)) throw new Error('Tanda tangan installer tidak valid.');

      const dir = path.join(this.dataDir, 'updates');
      mkdirSync(dir, { recursive: true });
      // Always stored under the new name: the legacy alias is only an upload-side transition, see the comment above.
      const file = path.join(dir, `Adhitron-Setup-${version}.exe`);
      if (!path.resolve(file).startsWith(`${path.resolve(dir)}${path.sep}`)) throw new Error('Path installer tidak valid.');
      const part = `${file}.part`;
      writeFileSync(part, bytes, { mode: 0o600 });
      renameSync(part, file);
      this.setStateSafe({ downloaded: { file, version, sha256: actual, signed: Boolean(this.publicKey), at: Date.now() } });
      return this.state.downloaded;
    } finally {
      this.set({ downloading: false });
    }
  }

  /** Download (if needed), then run the signed/verified installer detached and let it replace this executable. */
  async update() {
    if (process.platform !== 'win32') return { ok: false, error: 'Update otomatis build terpasang baru tersedia di Windows.' };
    if (this.busy()) return { ok: false, error: 'Masih ada giliran yang berjalan. Update setelah selesai (server akan di-restart).' };
    if (this.state.downloading || this.state.installing || this.state.updating) return { ok: false, error: 'Update sedang berjalan.' };
    this.set({ updating: true, error: null });
    try {
      if (!this.state.behind) await this.check();
      if (!this.state.behind) return { ok: false, error: 'Sudah versi terbaru.' };
      let downloaded = this.state.downloaded?.version === this.state.latestVersion ? this.state.downloaded : null;
      if (!downloaded || !existsSync(downloaded.file)) downloaded = await this.prepare();
      if (this.busy()) return { ok: false, error: 'Giliran baru mulai saat update disiapkan. Coba lagi setelah selesai.' };
      // TOCTOU: re-hash the exact file right before running it, after the download wait.
      const stat = statSync(downloaded.file);
      if (!stat.isFile()) throw new Error('Installer bukan file biasa.');
      const bytes = readFileSync(downloaded.file);
      if (createHash('sha256').update(bytes).digest('hex') !== downloaded.sha256) throw new Error('Installer berubah setelah diverifikasi; dibatalkan.');
      this.set({ installing: true });
      const child = spawn(downloaded.file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', (err) => {
        this.set({ updating: false, installing: false, error: shortError(err) });
      });
      child.unref();
      // The installer closes this process; the graceful shutdown releases state/children instead of a hard exit.
      setTimeout(() => {
        if (typeof this.onBeforeExit === 'function') this.onBeforeExit();
        else process.exit(0);
      }, 1500).unref?.();
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
      if (LOCAL_INSTALLER.test(name)) rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    // no updates folder yet
  }
}
