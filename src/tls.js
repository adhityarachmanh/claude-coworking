// HTTPS for phones on the tailnet: a Let's Encrypt certificate for this machine's MagicDNS name,
// obtained with `tailscale cert` (tailscaled caches it and renews it itself) and kept in data/tls/
// (the app's data folder, OFFICE_DATA_DIR): one `<host>.pem` (private key + chain, written atomically, so
// key and certificate can never disagree) and `last-host` (the name served last, preferred at start).
// The server serves it on its own https listener bound only to the Tailscale interface (server.js),
// and swaps a renewed certificate in without a restart (setSecureContext).
// Nothing here is ever part of a backup: the backup's file list is explicit (src/backup.js).
import { execFile } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Every value of `publicInfo().state`. */
export const HTTPS_STATES = Object.freeze(['off', 'no-tailscale', 'certs-disabled', 'ok', 'expiring', 'expired', 'error']);
// Fewer days left than this: still served, but the 📱 dialog warns.
export const EXPIRING_MS = 14 * 86_400_000;
// tailscaled only re-issues near expiry, so asking twice a day costs nothing (and suits 45-day certificates).
export const REFRESH_MS = 12 * 60 * 60 * 1000;
const CLI_TIMEOUT_MS = 90_000;
// A MagicDNS name (`arh-3.taild0f8a1.ts.net`): also used as a file name and in the Host check, so strict.
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Default port of the https listener. */
export const DEFAULT_HTTPS_PORT = 4318;

/**
 * OFFICE_HTTPS_PORT, validated: an integer 1-65535 that differs from the http port. Anything else falls
 * back to 4318 with a warning; if that (or the given port) is the http port, HTTPS is off (`port: null`).
 * @param {string|undefined} value  the environment variable
 * @param {number} httpPort  OFFICE_PORT
 * @returns {{ port: number|null, warning: string|null }}
 */
export function httpsPortFrom(value, httpPort) {
  let port = DEFAULT_HTTPS_PORT;
  let warning = null;
  if (value !== undefined && value !== '') {
    const n = Number(value);
    if (/^\d+$/.test(String(value).trim()) && n >= 1 && n <= 65535) port = n;
    else warning = `OFFICE_HTTPS_PORT "${value}" tidak valid (harus 1-65535); memakai ${DEFAULT_HTTPS_PORT}.`;
  }
  if (port === httpPort) return { port: null, warning: `OFFICE_HTTPS_PORT ${port} sama dengan OFFICE_PORT; HTTPS dimatikan.` };
  return { port, warning };
}

/** Short, path-free reason for the 📱 dialog (details go to the server log). */
class CertError extends Error {
  constructor(state, message) {
    super(message);
    this.state = state;
  }
}

/**
 * The Tailscale CLI: OFFICE_TAILSCALE_BIN; else (Windows) the default install under %ProgramFiles%;
 * else `tailscale` in an absolute PATH folder (a relative entry such as `.` would resolve against the
 * working directory, where anyone could drop a fake tailscale.exe).
 * @returns {string|null}
 */
export function findTailscale(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.OFFICE_TAILSCALE_BIN) return exists(env.OFFICE_TAILSCALE_BIN) ? env.OFFICE_TAILSCALE_BIN : null;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const file = pathApi.join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
    if (exists(file)) return file;
  }
  const name = platform === 'win32' ? 'tailscale.exe' : 'tailscale';
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir || !pathApi.isAbsolute(dir)) continue;
    const file = pathApi.join(dir, name);
    if (exists(file)) return file;
  }
  if (platform === 'darwin' && exists('/Applications/Tailscale.app/Contents/MacOS/Tailscale')) return '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  return null;
}

/**
 * Best effort: only the current user may read the folder holding the private key. POSIX: mode 0700.
 * Windows: inheritance off, full control for %USERNAME% only (icacls, no shell, hidden window).
 * Never throws; a failure is logged.
 */
export function restrictDir(dir, log = console.error, platform = process.platform) {
  if (platform !== 'win32') return fs.chmod(dir, 0o700).catch((err) => log(`HTTPS: chmod ${dir} gagal: ${err.message}`));
  const user = process.env.USERNAME;
  if (!user) return Promise.resolve(log('HTTPS: USERNAME tidak diketahui; izin folder tls tidak dibatasi'));
  return new Promise((resolve) => {
    execFile('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { windowsHide: true, timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) log(`HTTPS: icacls gagal (izin folder tls tidak dibatasi): ${String(stderr || err.message).trim()}`);
      resolve();
    });
  });
}

/** Splits a combined PEM into the private key and the certificate chain. */
export function splitPem(pem) {
  const text = String(pem);
  const key = text.match(/-----BEGIN (?:EC |RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:EC |RSA )?PRIVATE KEY-----\s*/)?.[0] ?? '';
  const cert = (text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\s*/g) ?? []).join('');
  return { key, cert };
}

/**
 * Runs the CLI without a shell and without a console window. A `.js`/`.mjs` "binary" runs under this
 * Node (lets tests point OFFICE_TAILSCALE_BIN at a fake CLI script on every platform).
 * @returns {(args: string[]) => Promise<string>} stdout
 */
export function cliRunner(bin) {
  const [command, prefix] = /\.m?js$/i.test(bin) ? [process.execPath, [bin]] : [bin, []];
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(command, [...prefix, ...args], { windowsHide: true, timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          err.stderr = String(stderr ?? '').trim();
          return reject(err);
        }
        resolve(String(stdout));
      });
    });
}

/**
 * Validates a cert/key pair for `host` at `now`.
 * @returns {{ cert: string, key: string, host: string, validTo: number, fingerprint: string }}
 * @throws {CertError}
 */
export function inspectCert(certPem, keyPem, host, now = Date.now()) {
  let x509;
  try {
    x509 = new X509Certificate(certPem); // the first certificate of the chain: the server's own
  } catch {
    throw new CertError('error', 'File sertifikat rusak.');
  }
  try {
    if (!x509.checkPrivateKey(createPrivateKey(keyPem))) throw new Error('mismatch');
  } catch {
    throw new CertError('error', 'Kunci tidak cocok dengan sertifikat.');
  }
  if (!x509.checkHost(host)) throw new CertError('error', `Sertifikat bukan untuk ${host}.`);
  const validTo = Date.parse(x509.validTo);
  const validFrom = Date.parse(x509.validFrom);
  if (!(validTo > now)) throw new CertError('expired', 'Sertifikat sudah kedaluwarsa.');
  if (validFrom > now + 5 * 60_000) throw new CertError('error', 'Sertifikat belum berlaku (jam laptop salah?).');
  return { cert: String(certPem), key: String(keyPem), host, validTo, fingerprint: x509.fingerprint256 };
}

export class TailscaleCert {
  /**
   * @param {object} options
   * @param {string} options.dir  where certificates are written (data/tls)
   * @param {() => boolean} [options.enabled]  phone access on? (no CLI runs while it is off)
   * @param {string|null} [options.bin]  CLI path; default findTailscale(). null = not installed
   * @param {(args: string[]) => Promise<string>} [options.run]  runs the CLI (tests inject a fake)
   * @param {() => number} [options.now]
   * @param {(info: object) => void} [options.onChange]  state or certificate changed
   * @param {(...args: any[]) => void} [options.log]
   * @param {(dir: string) => Promise<void>} [options.secureDir]  restricts the folder's permissions (tests inject a no-op)
   */
  constructor({ dir, enabled = () => true, bin, run, now = Date.now, onChange = () => {}, log = console.error, secureDir }) {
    this.dir = dir;
    this.secureDir = secureDir ?? ((d) => restrictDir(d, log));
    this.enabled = enabled;
    const cli = bin === undefined ? findTailscale() : bin;
    this.run = run ?? (cli ? cliRunner(cli) : null);
    this.now = now;
    this.onChange = onChange;
    this.log = log;
    this.material = null; // { cert, key, host, validTo, fingerprint } while usable
    // { state, error } of the last refresh that brought no usable certificate (before the first one: still checking)
    this.problem = this.run ? { state: 'error', error: 'Sedang diperiksa…' } : { state: 'no-tailscale', error: 'Tailscale tidak terpasang di laptop ini.' };
    this.lastError = null; // last refresh failure, shown even while an older certificate is still served
    this.checkedAt = 0;
    this.inFlight = null;
    this.timer = null;
  }

  /** The MagicDNS name the https listener answers to, or null (no usable certificate). */
  get host() {
    return this.usable ? this.material.host : null;
  }

  /** A certificate exists, matches the host and has not expired: the https listener may run. */
  get usable() {
    return Boolean(this.material) && this.material.validTo > this.now();
  }

  /** @returns {'off'|'no-tailscale'|'certs-disabled'|'ok'|'expiring'|'expired'|'error'} */
  get state() {
    if (!this.enabled()) return 'off';
    if (this.usable) return this.material.validTo - this.now() <= EXPIRING_MS ? 'expiring' : 'ok';
    if (this.material) return 'expired'; // it was valid, the clock passed validTo since
    return this.problem?.state ?? 'error';
  }

  /** Safe for browsers: no key, no file paths. */
  publicInfo(port) {
    const state = this.state;
    const serving = state === 'ok' || state === 'expiring';
    return {
      state,
      host: serving ? this.material.host : null,
      url: serving ? `https://${this.material.host}${port === 443 ? '' : `:${port}`}` : null,
      validTo: serving ? this.material.validTo : null,
      error: state === 'off' ? null : serving ? this.lastError : (this.problem?.error ?? this.lastError),
      checkedAt: this.checkedAt || null,
    };
  }

  /** Re-evaluates expiry without running anything (cheap; the server calls it with its 30 s listener sync). */
  tick() {
    const state = this.state;
    if (state === this.lastTickState) return;
    if (state === 'expired' && this.lastTickState) this.log(`HTTPS: sertifikat ${this.material.host} kedaluwarsa`);
    const changed = this.lastTickState !== undefined;
    this.lastTickState = state;
    if (changed) this.onChange(this.publicInfo());
  }

  /**
   * At start: a certificate already on disk is used right away (HTTPS works offline), then the CLI is
   * asked in the background, and again every REFRESH_MS.
   */
  async start() {
    await this.loadFromDisk().catch((err) => this.log(`HTTPS: ${err.message}`));
    this.timer ??= setInterval(() => this.enabled() && this.refresh(), REFRESH_MS);
    this.timer.unref?.();
    if (this.enabled()) this.refresh();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The certificate on disk: the one for `last-host` if it is still valid, else the newest valid `<host>.pem`.
   * Leftover temp files (`*.new`, from a write cut short) are removed.
   */
  async loadFromDisk() {
    let names;
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return null; // never fetched
    }
    for (const name of names) if (name.endsWith('.new')) await fs.rm(path.join(this.dir, name), { force: true }).catch(() => {});
    const lastHost = (await fs.readFile(path.join(this.dir, 'last-host'), 'utf8').catch(() => '')).trim();
    let best = null;
    for (const name of names) {
      const host = name.endsWith('.pem') ? name.slice(0, -4) : null;
      if (!host || !HOST_NAME.test(host)) continue;
      try {
        const { cert, key } = splitPem(await fs.readFile(path.join(this.dir, name), 'utf8'));
        const found = inspectCert(cert, key, host, this.now());
        const preferred = (c) => c.host === lastHost;
        if (!best || (preferred(found) && !preferred(best)) || (preferred(found) === preferred(best) && found.validTo > best.validTo)) best = found;
      } catch {
        // stale or broken file: ignored (the CLI writes a fresh one)
      }
    }
    if (best) this.#adopt(best);
    this.lastTickState = this.state;
    return best;
  }

  /** Asks the CLI (single flight). Never throws; the outcome is in `state` / `publicInfo()`. */
  refresh() {
    this.inFlight ??= this.#refresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async #refresh() {
    // What browsers see, minus the check time: an unchanged answer tells nobody.
    const seen = () => JSON.stringify({ ...this.publicInfo(0), checkedAt: null });
    const before = seen();
    const fingerprint = this.material?.fingerprint;
    try {
      if (!this.enabled()) return;
      const fresh = await this.#fetch();
      this.#adopt(fresh);
      this.problem = null;
      this.lastError = null;
    } catch (err) {
      const state = err instanceof CertError ? err.state : 'error';
      const error = err instanceof CertError ? err.message : 'Tailscale CLI gagal.';
      if (!(err instanceof CertError)) this.log(`HTTPS: tailscale gagal: ${err.stderr || err.message}`);
      else this.log(`HTTPS: ${err.message}`);
      this.problem = { state, error };
      this.lastError = error;
      // A renamed machine/tailnet: the old certificate no longer names us, stop serving it.
      if (err.host && this.material && this.material.host !== err.host) this.material = null;
    } finally {
      this.checkedAt = this.now();
      this.lastTickState = this.state;
      if (fingerprint !== this.material?.fingerprint || before !== seen()) this.onChange(this.publicInfo());
    }
  }

  #adopt(found) {
    if (found.fingerprint !== this.material?.fingerprint) this.log(`HTTPS: sertifikat ${found.host} berlaku s/d ${new Date(found.validTo).toISOString().slice(0, 10)}`);
    this.material = found;
  }

  async #fetch() {
    if (!this.run) throw new CertError('no-tailscale', 'Tailscale tidak terpasang di laptop ini.');
    let status;
    try {
      status = JSON.parse(await this.run(['status', '--json']));
    } catch (err) {
      if (err.code === 'ENOENT') throw new CertError('no-tailscale', 'Tailscale tidak terpasang di laptop ini.');
      if (err instanceof SyntaxError) throw new CertError('error', 'Jawaban Tailscale tidak dikenali.');
      throw new CertError('no-tailscale', 'Tailscale belum berjalan atau belum login.');
    }
    if (status.BackendState && status.BackendState !== 'Running') throw new CertError('no-tailscale', 'Tailscale belum tersambung (buka aplikasi Tailscale lalu Connect).');
    const host = String(status.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
    if (!HOST_NAME.test(host)) throw Object.assign(new CertError('certs-disabled', 'Mesin ini tidak punya nama MagicDNS (nyalakan MagicDNS di admin console Tailscale).'), { host: null });
    const domains = (Array.isArray(status.CertDomains) ? status.CertDomains : []).map((d) => String(d).replace(/\.$/, '').toLowerCase());
    if (!domains.includes(host)) throw Object.assign(new CertError('certs-disabled', 'HTTPS Certificates belum dinyalakan di admin console Tailscale (DNS → HTTPS Certificates).'), { host });

    // Written next to the live file first, checked, then moved over it in one rename: a bad answer never
    // replaces a good certificate, and key and certificate can never come from two different answers.
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.secureDir(this.dir);
    const pemFile = path.join(this.dir, `${host}.pem`);
    const tmpCert = path.join(this.dir, `${host}.crt.new`);
    const tmpKey = path.join(this.dir, `${host}.key.new`);
    try {
      // Never --force: tailscaled re-issues only near expiry (Let's Encrypt rate limits).
      await this.run(['cert', '--cert-file', tmpCert, '--key-file', tmpKey, host]);
    } catch (err) {
      await Promise.all([fs.rm(tmpCert, { force: true }), fs.rm(tmpKey, { force: true })]);
      this.log(`HTTPS: tailscale cert gagal: ${err.stderr || err.message}`);
      const denied = /access denied|permission|elevat|administrator/i.test(String(err.stderr ?? ''));
      throw Object.assign(new CertError('error', denied ? 'tailscale cert ditolak (butuh hak admin?).' : 'tailscale cert gagal (lihat server.log).'), { host });
    }
    let found;
    try {
      const [cert, key] = await Promise.all([fs.readFile(tmpCert, 'utf8'), fs.readFile(tmpKey, 'utf8')]);
      found = inspectCert(cert, key, host, this.now());
    } catch (err) {
      throw Object.assign(err instanceof CertError ? err : new CertError('error', 'Tailscale tidak menulis sertifikat.'), { host });
    } finally {
      await Promise.all([fs.rm(tmpCert, { force: true }), fs.rm(tmpKey, { force: true })]);
    }
    const tmpPem = `${pemFile}.new`;
    await fs.writeFile(tmpPem, `${found.key.trim()}\n${found.cert.trim()}\n`, { mode: 0o600 });
    await fs.rename(tmpPem, pemFile);
    await fs.writeFile(path.join(this.dir, 'last-host'), `${host}\n`);
    // Only the current name is kept: certificates for old names (renamed machine/tailnet) go.
    for (const name of await fs.readdir(this.dir)) {
      if (name === `${host}.pem` || name === 'last-host') continue;
      if (/\.(pem|crt|key|new)$/.test(name)) await fs.rm(path.join(this.dir, name), { force: true }).catch(() => {});
    }
    return found;
  }
}
