// Setup as a background service: probe the tools (src/setup/detect.js), install one target at a time through the
// portable runtime (src/setup/runtime.js, npm.js, tailscale.js), and expose a small view the server can broadcast.
// Nothing here touches the network or the disk until an install/refresh is asked for; every installer, probe and the
// clock are injectable so the state machine can be tested without a real Node download.
import path from 'node:path';
import { findClaude } from '../claude-bin.js';
import { findOpenCode } from '../opencode-bin.js';
import { cleanToolView, probeTools } from './detect.js';
import { openLoginTerminal as openLoginTerminalDefault } from './login.js';
import { installNpmPackage } from './npm.js';
import { SETUP_TARGETS, isSetupTarget } from './packages.js';
import { activeNode, installNodeRuntime, runtimeBinDirs, runtimePaths } from './runtime.js';
import { findTailscale, installTailscale } from './tailscale.js';

/** A normal refresh never starts a new probe sooner than this after the previous one. */
export const MIN_REFRESH_MS = 5000;

/** How long stop() waits for a running installer after aborting it. */
export const STOP_WAIT_MS = 3000;

const DEFAULT_INSTALLERS = Object.freeze({
  node: installNodeRuntime,
  npm: installNpmPackage,
  tailscale: installTailscale,
});

const ITEM_KEYS = Object.freeze(['id', 'label', 'optional', 'state', 'version', 'login', 'origin']);
const ITEM_STATES = new Set(['ready', 'missing', 'unknown']);
const ITEM_ORIGINS = new Set(['runtime', 'system']);
const JOB_STATES = new Set(['running', 'done', 'failed', 'cancelled']);
const TARGETS = new Set(Object.keys(SETUP_TARGETS));
const LOGIN_TARGETS = new Set(['claude', 'opencode']);

/** Only the fixed item shape: a custom probe can never smuggle a path into the snapshot. */
function publicItem(item) {
  if (!item || typeof item !== 'object') return null;
  const out = {};
  for (const key of ITEM_KEYS) if (Object.hasOwn(item, key)) out[key] = item[key];
  out.id = typeof out.id === 'string' ? out.id.slice(0, 40) : null;
  out.label = cleanText(out.label, 80) || null;
  out.state = ITEM_STATES.has(out.state) ? out.state : 'unknown';
  out.origin = ITEM_ORIGINS.has(out.origin) ? out.origin : null;
  out.login = typeof out.login === 'boolean' ? out.login : null;
  out.version = cleanText(out.version, 80) || null;
  out.optional = out.optional === true;
  return out;
}

const cleanCode = (value) => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value) ? value : null);

/** One line of installer output/error without a stack, an absolute path or control characters. */
function cleanText(value, max = 400) {
  let text = String(value ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  text = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s/.test(line))
    .join(' ');
  text = text.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]*/g, '~path');
  text = text.replace(/(^|[\s("'=])\/(?:[^\s"'<>)]+)/g, '$1~path');
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** An installer hint keeps its lines (npm/winget output) but not a path or a stack. */
function cleanHint(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const lines = value
    .split(/\r?\n/)
    .map((line) => cleanText(line, 300))
    .filter(Boolean)
    .slice(0, 12);
  return lines.length ? lines.join('\n').slice(0, 1500) : null;
}

function isCancelled(err) {
  return err?.code === 'CANCELLED' || err?.code === 'ABORT_ERR' || err?.name === 'AbortError';
}

export class SetupService {
  /**
   * @param {object} options
   * @param {string} options.runtimeDir portable runtime folder (<app>/runtime or OFFICE_RUNTIME_DIR)
   * @param {NodeJS.Platform} [options.platform]
   * @param {(options: {runtimeDir: string, platform: NodeJS.Platform, deep?: boolean}) => object[]|Promise<object[]>} [options.probe]
   * @param {{node?: Function, npm?: Function, tailscale?: Function}} [options.installers]
   * @param {Function} [options.loginTerminal] src/setup/login.js openLoginTerminal
   * @param {(view: object, meta?: {event: string}) => void} [options.onChange]
   * @param {() => boolean} [options.isBusy] a turn or a contract check is running
   * @param {(line: string) => void} [options.log]
   * @param {() => number} [options.now]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor({
    runtimeDir,
    platform = process.platform,
    probe = probeTools,
    installers = {},
    loginTerminal = openLoginTerminalDefault,
    onChange = () => {},
    isBusy = () => false,
    log = () => {},
    now = Date.now,
    fetchImpl,
  } = {}) {
    if (typeof runtimeDir !== 'string' || !runtimeDir) throw new TypeError('runtimeDir wajib diisi.');
    this.runtimeDir = runtimeDir;
    this.platform = platform;
    this.probe = probe;
    this.installers = { ...DEFAULT_INSTALLERS, ...installers };
    this.loginTerminal = loginTerminal;
    this.onChange = onChange;
    this.isBusy = isBusy;
    this.log = log;
    this.now = now;
    this.fetchImpl = fetchImpl;

    this.probing = false;
    this.busy = false;
    this.job = null; // {target, state, step, percent, startedAt, finishedAt, error, code, hint}
    this.items = []; // the last successful probe
    this.at = 0; // when items/job last changed
    this.lastProbeAt = null;
    this.current = null; // the running install promise
    this.controller = null;
    this.deepQueued = false;
    this.stopped = false;
  }

  get supported() {
    return this.platform === 'win32';
  }

  /** The full state for the UI: no absolute paths, no stack traces. */
  snapshot() {
    return {
      supported: this.supported,
      probing: this.probing,
      busy: this.busy,
      job: this.job ? { ...this.job } : null,
      items: this.items.map(publicItem).filter(Boolean),
      at: this.at || this.now(),
    };
  }

  /** What the browser gets through the config: the snapshot, cleaned again, plus the two banner flags. */
  publicView() {
    const snap = this.snapshot();
    const items = cleanToolView(snap.items);
    const byId = new Map(items.map((item) => [item.id, item]));
    const ready = (id) => byId.get(id)?.state === 'ready';
    return {
      ...snap,
      items,
      needsSetup: !ready('node') || !ready('claude'),
      firstRun: !items.some((item) => item.state === 'ready'),
    };
  }

  /** Starts a probe unless one is already running. A normal refresh is throttled to MIN_REFRESH_MS. */
  refresh({ deep = false } = {}) {
    if (this.stopped) return { started: false };
    if (this.probing) {
      // A background probe may still hold the pre-install view. Remember the deep request and run it right after.
      if (deep) this.deepQueued = true;
      return { started: false };
    }
    const at = this.now();
    if (!deep && this.lastProbeAt !== null && at - this.lastProbeAt < MIN_REFRESH_MS) return { started: false };
    this.lastProbeAt = at;
    this.probing = true;
    this.runProbe(deep);
    return { started: true };
  }

  async runProbe(deep) {
    try {
      const items = await this.probe({ runtimeDir: this.runtimeDir, platform: this.platform, deep });
      if (!Array.isArray(items)) throw new TypeError('probe tidak mengembalikan daftar alat.');
      this.items = items;
      this.at = this.now();
    } catch (err) {
      this.log(`Setup: gagal memeriksa alat (${cleanText(err?.message ?? err, 200)})`);
    } finally {
      this.probing = false;
      this.notify('refresh');
      if (this.deepQueued) {
        this.deepQueued = false;
        this.refresh({ deep: true });
      }
    }
  }

  /**
   * Starts an install in the background. Refuses (409) while another install, a turn or a contract check runs;
   * returns {already:true} when the target is already usable. The job itself is visible through snapshot().
   */
  install(target) {
    if (!isSetupTarget(target)) return { started: false, status: 400, error: 'Target setup tidak dikenal.' };
    const id = typeof target === 'string' ? target : target.id;
    if (!TARGETS.has(id)) return { started: false, status: 400, error: 'Target setup tidak dikenal.' };
    if (!this.supported) return { started: false, status: 501, error: 'Setup otomatis hanya tersedia di Windows.' };
    if (this.stopped) return { started: false, status: 409, error: 'Server sedang berhenti.' };
    if (this.busy || this.externallyBusy()) return { started: false, status: 409, error: 'Masih ada pekerjaan yang berjalan. Coba lagi setelah selesai.' };
    if (this.isReady(id)) return { already: true };

    this.controller = new AbortController();
    this.busy = true;
    this.job = {
      target: id,
      state: 'running',
      step: 'menyiapkan',
      percent: 0,
      startedAt: this.now(),
      finishedAt: null,
      error: null,
      code: null,
      hint: null,
    };
    this.at = this.now();
    this.current = this.runJob(id);
    return { started: true, status: 202 };
  }

  /** Aborts the running install. Tailscale (winget) is deliberately not cancellable. */
  cancel() {
    if (!this.busy || !this.job || this.job.state !== 'running' || !this.controller) {
      return { cancelled: false, status: 409, error: 'Tidak ada instalasi yang sedang berjalan.' };
    }
    if (this.job.target === 'tailscale') return { cancelled: false, status: 409, error: 'Instalasi Tailscale tidak bisa dibatalkan.' };
    this.controller.abort();
    return { cancelled: true };
  }

  /**
   * Opens a login window for an installed CLI. `activeNode` is put on the launcher's PATH so the portable npm prefix
   * works even when the app started without it. Returns {ok:true} or {ok:false, code}; no path is exposed.
   */
  openLoginTerminal(target) {
    if (!LOGIN_TARGETS.has(target)) return { ok: false, code: 'BAD_TARGET' };
    if (!this.supported) return { ok: false, code: 'UNSUPPORTED' };
    if (this.stopped) return { ok: false, code: 'BUSY' };
    if (this.busy || this.externallyBusy()) return { ok: false, code: 'BUSY' };
    const installed = target === 'claude' ? findClaude() : findOpenCode();
    if (!installed) return { ok: false, code: 'NOT_INSTALLED' };

    const paths = runtimePaths({ runtimeDir: this.runtimeDir });
    const node = activeNode(this.runtimeDir);
    try {
      const result = this.loginTerminal({ runtime: { ...paths, nodeDir: node?.dir ?? paths.node }, target, platform: this.platform });
      if (result?.ok) return { ok: true };
      return { ok: false, code: cleanCode(result?.code) ?? 'FAILED' };
    } catch (err) {
      return { ok: false, code: cleanCode(err?.code) ?? 'FAILED' };
    }
  }

  /** Aborts a running install and waits (bounded) for it to settle. Timers belong to the installers. */
  async stop() {
    this.stopped = true;
    this.controller?.abort();
    const current = this.current;
    if (!current) return;
    await Promise.race([
      current.then(
        () => {},
        () => {},
      ),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, STOP_WAIT_MS);
        timer.unref?.();
      }),
    ]);
  }

  /**
   * Puts the runtime's npm prefix and Node folder at the front of a PATH-like env, without duplicating an entry
   * already there (the host PATH is kept for child processes). Only folders that exist are added.
   * @returns {string[]} the folders that were prepended
   */
  applyRuntimePath(env = process.env) {
    const dirs = runtimeBinDirs(this.runtimeDir);
    if (!dirs.length) return [];
    const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
    const norm = (value) => (process.platform === 'win32' ? String(value).toLowerCase() : String(value));
    const wanted = [];
    for (const dir of dirs) if (!wanted.some((seen) => norm(seen) === norm(dir))) wanted.push(dir);
    const drop = new Set(wanted.map(norm));
    const kept = String(env[key] ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .filter((entry) => !drop.has(norm(entry)));
    env[key] = [...wanted, ...kept].join(path.delimiter);
    return wanted;
  }

  // ---------- internals ----------

  externallyBusy() {
    try {
      return Boolean(this.isBusy());
    } catch (err) {
      this.log(`Setup: gagal memeriksa kesibukan (${cleanText(err?.message ?? err, 200)})`);
      return true; // do not install while we cannot prove the office is idle
    }
  }

  isReady(target) {
    try {
      if (target === 'node' && activeNode(this.runtimeDir)) return true;
      if (target === 'claude' && findClaude()) return true;
      if (target === 'opencode' && findOpenCode()) return true;
      if (target === 'tailscale' && findTailscale({ platform: this.platform })) return true;
      // The last probe may have found it from somewhere this process cannot see directly (a PATH only the user's
      // shell has, for example); a ready item is still a ready target.
      return this.items.some((item) => item?.id === target && item.state === 'ready');
    } catch {
      return false;
    }
  }

  notify(event) {
    this.at = this.now();
    try {
      this.onChange(this.publicView(), { event });
    } catch (err) {
      this.log(`Setup: onChange gagal (${cleanText(err?.message ?? err, 200)})`);
    }
  }

  setJob(patch) {
    if (!this.job) return;
    Object.assign(this.job, patch);
    if (this.job.state && !JOB_STATES.has(this.job.state)) this.job.state = 'failed';
    this.at = this.now();
  }

  async runJob(target) {
    const signal = this.controller?.signal;
    try {
      if (target === 'node') await this.installNodeJob(signal, 0, 100);
      else if (target === 'claude' || target === 'opencode') await this.installPackageJob(target, signal);
      else if (target === 'tailscale') await this.installTailscaleJob(signal);
      if (signal?.aborted) throw Object.assign(new Error('Dibatalkan.'), { code: 'CANCELLED' });
      this.setJob({ state: 'done', step: 'selesai', percent: 100, finishedAt: this.now(), error: null, code: null, hint: null });
      this.log(`Setup ${target}: selesai.`);
    } catch (err) {
      if (signal?.aborted || isCancelled(err)) {
        this.setJob({ state: 'cancelled', step: 'dibatalkan', finishedAt: this.now(), error: 'Dibatalkan.', code: 'CANCELLED', hint: null });
        this.log(`Setup ${target}: dibatalkan.`);
      } else {
        const error = cleanText(err?.message ?? err, 400) || 'Instalasi gagal.';
        this.setJob({ state: 'failed', step: 'gagal', finishedAt: this.now(), error, code: cleanCode(err?.code), hint: cleanHint(err?.hint) });
        this.log(`Setup ${target} gagal: ${error}`);
      }
    } finally {
      this.busy = false;
      this.current = null;
      this.controller = null;
      this.notify('job');
      this.refresh({ deep: true }); // the UI sees the new tools; never awaited by install()
    }
  }

  /** installNodeRuntime → 0..100 (or 0..40 before an npm package). */
  nodeProgress(from, to) {
    const span = to - from;
    return (info) => {
      if (!info) return;
      if (info.stage === 'extract') {
        const ratio = info.totalEntries ? info.entries / info.totalEntries : info.totalBytes ? info.bytes / info.totalBytes : 0;
        this.setJob({ step: 'mengekstrak', percent: from + Math.round(span * (0.8 + 0.18 * Math.min(1, ratio))) });
        return;
      }
      const total = Number(info.total) || 0;
      const received = Number(info.received) || 0;
      if (total && received >= total) {
        this.setJob({ step: 'memverifikasi', percent: from + Math.round(span * 0.75) });
        return;
      }
      const ratio = total ? Math.min(1, received / total) : 0;
      this.setJob({ step: 'mengunduh', percent: from + Math.round(span * 0.7 * ratio) });
    };
  }

  async installNodeJob(signal, from, to) {
    this.setJob({ step: 'mengunduh', percent: from });
    const options = { runtimeDir: this.runtimeDir, signal, onProgress: this.nodeProgress(from, to) };
    if (typeof this.fetchImpl === 'function') options.fetchImpl = this.fetchImpl;
    await this.installers.node(options);
    this.setJob({ step: 'Node.js siap', percent: to });
  }

  async installPackageJob(target, signal) {
    let node = activeNode(this.runtimeDir);
    if (!node) {
      // npm itself lives inside the runtime: without a portable Node there is nothing to run `npm-cli.js` with.
      this.setJob({ step: 'memasang Node.js', percent: 0 });
      const installed = await this.installers.node({ runtimeDir: this.runtimeDir, signal, onProgress: this.nodeProgress(0, 40), ...(typeof this.fetchImpl === 'function' ? { fetchImpl: this.fetchImpl } : {}) });
      node = activeNode(this.runtimeDir) ?? (installed?.dir ? { dir: installed.dir } : null);
      if (!node?.dir) throw Object.assign(new Error('Node.js terpasang, tetapi folder runtime-nya tidak ditemukan.'), { code: 'NODE_MISSING' });
    }

    this.setJob({ step: 'memasang paket', percent: 40 });
    let lines = 0;
    await this.installers.npm({
      runtime: { ...runtimePaths({ runtimeDir: this.runtimeDir }), node: node.dir },
      spec: SETUP_TARGETS[target].npm,
      signal,
      onLine: () => {
        lines += 1;
        if (lines % 3 === 0) this.setJob({ percent: Math.min(90, 40 + lines) });
      },
    });
    this.setJob({ step: 'memeriksa', percent: 92 });
  }

  async installTailscaleJob(signal) {
    this.setJob({ step: 'memasang Tailscale', percent: 10 });
    let lines = 0;
    await this.installers.tailscale({
      signal,
      platform: this.platform,
      onLine: () => {
        lines += 1;
        if (lines % 3 === 0) this.setJob({ percent: Math.min(90, 10 + lines) });
      },
    });
    this.setJob({ step: 'memeriksa', percent: 92 });
  }
}
