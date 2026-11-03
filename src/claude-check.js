// Claude Code update detector: the app speaks Claude Code's internal stream-json protocol, and Claude Code updates
// itself. On server start (after a short delay) and every 6 hours, `claude --version` is read (cheap, bounded); when it
// differs from the last version whose contract check passed — and that version was not checked yet — the LIGHT
// contract check (src/claude-contract.js) runs in the background, once no turn is busy (bounded wait).
//
// State lives in data/claude-check.json (its own file: never in a history backup):
//   { settings: { autoCheck, allowModel }, version, versionAt, lastGoodVersion, check: { version, previousVersion, at,
//     result: ok|warning|failed|skipped, failing: [names], reason, trigger: auto|manual, usedModel, durationMs } }
// The browser gets publicView() through the config (snapshot + `config` event): versions, result, failing check names.
// Never details (they may hold paths or CLI output): those go, sanitised, to the server log only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readClaudeVersion as readVersionDefault, runContract as runContractDefault, sanitize } from './claude-contract.js';

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const START_DELAY_MS = 20_000; // after start-up work (catalog probe, account), never in its way
export const IDLE_POLL_MS = 15_000;
export const IDLE_WAIT_MS = 10 * 60 * 1000; // a busy office defers the check at most this long, then retries later
export const RETRY_MS = 30 * 60 * 1000;
export const STOP_WAIT_MS = 3000; // stop(): how long a running check may take to end after its processes were killed
const RESULTS = new Set(['ok', 'warning', 'failed', 'skipped']);
const DONE = new Set(['ok', 'warning', 'failed']); // a check that actually ran (skipped = not checked)
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const MAX_FAILING = 20;

export const DEFAULT_SETTINGS = Object.freeze({ autoCheck: true, allowModel: true });

const cleanVersion = (v) => (typeof v === 'string' && VERSION.test(v) ? v : null);
const cleanName = (n) => sanitize(n, 80);

/** A stored check record, validated (a hand-edited or old file never reaches the browser unchecked). */
function cleanCheck(c) {
  if (!c || typeof c !== 'object' || !RESULTS.has(c.result)) return null;
  return {
    version: cleanVersion(c.version),
    previousVersion: cleanVersion(c.previousVersion),
    at: Number.isFinite(c.at) ? c.at : 0,
    result: c.result,
    failing: Array.isArray(c.failing) ? c.failing.filter((n) => typeof n === 'string').slice(0, MAX_FAILING).map(cleanName) : [],
    reason: typeof c.reason === 'string' ? sanitize(c.reason, 120) : null,
    trigger: c.trigger === 'manual' ? 'manual' : 'auto',
    usedModel: c.usedModel === true,
    durationMs: Number.isFinite(c.durationMs) ? c.durationMs : null,
  };
}

export class ClaudeCheckService {
  /**
   * @param {{ file: string, claude: {command: string, args: string[]}|null, name?: string, modelLabel?: string, isBusy?: () => boolean,
   *   onChange?: (view: object) => void, log?: (line: string) => void, env?: object,
   *   readVersion?: typeof readVersionDefault, runContract?: typeof runContractDefault,
   *   timing?: Partial<{ startDelayMs: number, intervalMs: number, idlePollMs: number, idleWaitMs: number, retryMs: number }>,
   *   contractTimeouts?: object, now?: () => number }} options
   */
  constructor({ file, claude, name = 'Claude Code', modelLabel = '1 request Haiku', isBusy = () => false, onChange = () => {}, log = (line) => console.log(line), env = process.env, readVersion = readVersionDefault, runContract = runContractDefault, timing = {}, contractTimeouts = {}, now = Date.now }) {
    // name/modelLabel: the same service watches OpenCode too (src/opencode-check.js), with its own readVersion/runContract.
    Object.assign(this, { file, claude, name, modelLabel, isBusy, onChange, log, env, readVersion, runContract, contractTimeouts, now });
    this.timing = { startDelayMs: START_DELAY_MS, intervalMs: CHECK_INTERVAL_MS, idlePollMs: IDLE_POLL_MS, idleWaitMs: IDLE_WAIT_MS, retryMs: RETRY_MS, ...timing };
    this.state = this.load();
    this.running = false; // a contract check is running
    this.waiting = false; // a check is due but waits for the office to be idle
    this.ticking = null; // the current tick (version read + maybe a check), so ticks never overlap
    this.timers = new Set();
  }

  load() {
    let raw = {};
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8')) ?? {};
    } catch {
      // first start, or an unreadable file: start over (it only holds a cache of check results)
    }
    const s = raw.settings ?? {};
    return {
      settings: { autoCheck: typeof s.autoCheck === 'boolean' ? s.autoCheck : DEFAULT_SETTINGS.autoCheck, allowModel: typeof s.allowModel === 'boolean' ? s.allowModel : DEFAULT_SETTINGS.allowModel },
      version: cleanVersion(raw.version),
      versionAt: Number.isFinite(raw.versionAt) ? raw.versionAt : null,
      lastGoodVersion: cleanVersion(raw.lastGoodVersion),
      check: cleanCheck(raw.check),
    };
  }

  save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      this.log(`Cek ${this.name}: gagal menyimpan status (${sanitize(err.message)})`);
    }
  }

  /** What the browser sees (config.claudeCheck). No details, paths or CLI output. */
  publicView() {
    const c = this.state.check;
    return {
      available: Boolean(this.claude),
      version: this.state.version,
      lastGoodVersion: this.state.lastGoodVersion,
      checkedVersion: c?.version ?? null,
      previousVersion: c?.previousVersion ?? null,
      lastCheckedAt: c?.at ?? null,
      result: c?.result ?? null,
      failing: c?.failing ?? [],
      reason: c?.reason ?? null,
      trigger: c?.trigger ?? null,
      usedModel: c?.usedModel ?? false,
      running: this.running,
      waiting: this.waiting,
      settings: { ...this.state.settings },
    };
  }

  changed() {
    try {
      this.onChange(this.publicView());
    } catch (err) {
      this.log(`Cek ${this.name}: onChange gagal (${sanitize(err?.message)})`);
    }
  }

  timer(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.timers.add(t);
    return t;
  }

  /** First look shortly after start, then every 6 h. Nothing here blocks start-up. */
  start() {
    if (!this.claude) return;
    this.timer(() => this.tick(), this.timing.startDelayMs);
    this.interval = setInterval(() => this.tick(), this.timing.intervalMs);
    this.interval.unref?.();
  }

  /**
   * Server shutdown: no more ticks, and a running check is aborted (its processes killed, whole tree). Resolves once
   * that check ended, at most STOP_WAIT_MS later. An aborted check is not recorded (it says nothing about the CLI).
   */
  stop() {
    this.stopped = true;
    clearInterval(this.interval);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.abort?.abort();
    if (!this.current) return Promise.resolve();
    return Promise.race([this.current.then(() => {}, () => {}), new Promise((r) => setTimeout(r, STOP_WAIT_MS).unref?.())]);
  }

  /** Not checked yet: differs from the last version that passed, and no finished check for exactly this version. */
  needsCheck(version) {
    if (!version || version === this.state.lastGoodVersion) return false;
    const c = this.state.check;
    return !(c && c.version === version && DONE.has(c.result));
  }

  /** Reads the version and, when it is new, runs the light check (or records "skipped"). Never throws. */
  tick() {
    this.ticking ??= this.doTick()
      .catch((err) => this.log(`Cek ${this.name}: ${sanitize(err?.message ?? err)}`))
      .finally(() => (this.ticking = null));
    return this.ticking;
  }

  async doTick() {
    if (!this.claude || this.running || this.waiting || this.stopped) return;
    const { version, error } = await this.readVersion(this.claude, { env: this.env });
    if (!version) {
      this.log(`Cek ${this.name}: versi tidak terbaca (${sanitize(error)})`);
      return;
    }
    const was = this.state.version;
    this.state.version = version;
    this.state.versionAt = this.now();
    if (was !== version) this.log(was ? `${this.name} berubah: v${was} → v${version}` : `${this.name} v${version}`);
    if (!this.needsCheck(version)) {
      this.save();
      if (was !== version) this.changed();
      return;
    }
    if (!this.state.settings.autoCheck) {
      const c = this.state.check;
      if (!(c?.version === version && c.result === 'skipped')) {
        this.record({ version, result: 'skipped', failing: [], reason: 'Cek otomatis dimatikan', trigger: 'auto', usedModel: false, durationMs: 0 });
        this.log(`Cek ${this.name} v${version}: dilewati (cek otomatis dimatikan)`);
      }
      this.save();
      this.changed();
      return;
    }
    this.save();
    await this.runWhenIdle('auto');
  }

  /** Bounded wait for no busy turn, then the check. Still busy at the bound: deferred, retried in RETRY_MS. */
  async runWhenIdle(trigger) {
    const until = this.now() + this.timing.idleWaitMs;
    if (this.isBusy()) {
      this.waiting = true;
      this.changed();
      while (this.isBusy() && this.now() < until) await new Promise((r) => this.timer(r, this.timing.idlePollMs));
      this.waiting = false;
      if (this.isBusy()) {
        this.log(`Cek ${this.name}: ditunda (ada giliran berjalan), dicoba lagi dalam ${Math.round(this.timing.retryMs / 60000)} menit`);
        this.timer(() => this.tick(), this.timing.retryMs);
        this.changed();
        return { deferred: true };
      }
    }
    return this.run(trigger);
  }

  record(check) {
    this.state.check = cleanCheck({ ...check, previousVersion: this.state.lastGoodVersion, at: this.now() });
    if (check.result === 'ok' && check.version) this.state.lastGoodVersion = check.version;
  }

  /** Runs the light contract now. One at a time; the caller made sure no turn is busy. */
  async run(trigger) {
    if (this.running) return { running: true };
    if (this.stopped) return { stopped: true };
    this.running = true;
    this.changed();
    const allowModel = this.state.settings.allowModel;
    let report;
    try {
      this.abort = new AbortController();
      this.current = this.runContract({ claude: this.claude, profile: 'light', allowModel, env: this.env, timeouts: this.contractTimeouts, signal: this.abort.signal });
      report = await this.current;
    } catch (err) {
      report = { version: null, result: 'failed', failing: ['cek tidak selesai'], checks: [{ name: 'cek tidak selesai', ok: false, detail: sanitize(err?.message ?? err) }], usedModel: false, durationMs: null };
    }
    this.current = null;
    if (this.abort?.signal.aborted) {
      this.running = false;
      this.log(`Cek kontrak ${this.name}: dibatalkan (server berhenti), tidak dicatat`);
      return { aborted: true };
    }
    const version = cleanVersion(report.version) ?? this.state.version;
    if (cleanVersion(report.version)) {
      this.state.version = report.version;
      this.state.versionAt = this.now();
    }
    this.record({ version, result: report.result, failing: report.failing, reason: null, trigger, usedModel: report.usedModel, durationMs: report.durationMs });
    this.running = false;
    this.save();
    // Log lines: names and sanitised details only (src/claude-contract.js sanitize).
    const n = report.checks?.length ?? 0;
    this.log(`Cek kontrak ${this.name} v${version ?? '?'} (${trigger}${report.usedModel ? `, ${this.modelLabel}` : ', tanpa token'}): ${report.result} — ${n - report.failing.length}/${n} lulus`);
    for (const c of report.checks ?? []) if (!c.ok) this.log(`  GAGAL ${cleanName(c.name)}${c.detail ? ` — ${sanitize(c.detail)}` : ''}`);
    this.changed();
    return { report };
  }

  /**
   * ⚙ "Cek kompatibilitas Claude Code" (laptop only). Starts in the background and answers at once.
   * @returns {{ started: boolean, error?: string, status?: number }}
   */
  runManual() {
    if (!this.claude) return { started: false, status: 503, error: `${this.name} tidak ditemukan.` };
    if (this.stopped) return { started: false, status: 503, error: 'Server sedang berhenti.' };
    if (this.running) return { started: false, status: 409, error: 'Cek kompatibilitas sedang berjalan.' };
    if (this.isBusy()) return { started: false, status: 409, error: 'Ada giliran yang sedang berjalan — coba lagi setelah selesai.' };
    this.run('manual').catch((err) => this.log(`Cek ${this.name}: ${sanitize(err?.message ?? err)}`));
    return { started: true };
  }

  /** Validated by the route: booleans only. Turning the auto check on looks at the version again. */
  updateSettings(patch) {
    const before = this.state.settings.autoCheck;
    this.state.settings = { ...this.state.settings, ...patch };
    this.save();
    this.changed();
    if (!before && this.state.settings.autoCheck) this.timer(() => this.tick(), 0);
    return this.publicView();
  }
}
