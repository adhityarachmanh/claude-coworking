// Claude account: profile (`claude auth status` + ~/.claude.json oauthAccount), plan usage
// (`/usage`, no tokens spent), and login/logout through the CLI's own flows.
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROFILE_TTL_MS = 30_000;
const LIMITS_TTL_MS = 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
// Strip ANSI colours and OSC 8 hyperlinks the CLI prints for terminals.
const ANSI = /\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b\[[0-9;?]*[A-Za-z]|\]8;;[^\s\\]*\\?/g;

/** Runs the claude CLI and resolves { code, out } (stdout + stderr). */
function runClaude(claude, args, { input, cwd = os.tmpdir(), timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(claude.command, [...claude.args, ...args], { cwd, windowsHide: true, env: { ...process.env, OFFICE_MANAGED: '1' } });
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ code: -1, out: err.message }));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    if (input != null) child.stdin.end(input);
  });
}

function oauthAccount() {
  try {
    const config = JSON.parse(readFileSync(process.env.CLAUDE_CONFIG_FILE ?? path.join(os.homedir(), '.claude.json'), 'utf8'));
    return config.oauthAccount ?? {};
  } catch {
    return {};
  }
}

/** "Current session: 4% used · resets Oct 31, 10:40am (Asia/Jakarta)" → { label, percent, resets } */
export function parseUsageText(text) {
  const windows = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(Current [^:]+):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?\s*$/);
    if (m) windows.push({ label: m[1].trim(), percent: Number(m[2]), resets: m[3]?.trim() ?? null });
  }
  return windows;
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What a browser shows of the rate-limit state: a change here is worth a broadcast, anything else is not. */
function rateLimitSignature(rl) {
  if (!rl) return '';
  const windows = Object.entries(rl.windows ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, w]) => [k, w.status, w.utilization == null ? null : Math.round(w.utilization * 100), w.resetsAt]);
  return JSON.stringify(windows);
}

export class AccountService {
  constructor({ claude, onChange }) {
    this.claude = claude;
    this.onChange = onChange; // called with the public state whenever profile or login flow changes
    this.profile = null;
    this.profileAt = 0;
    this.limits = null;
    this.limitsAt = 0;
    this.rateLimit = null; // latest rate_limit_event from a running session
    this.login = null; // { state, url, error, child }
    // Single-flight: the CLI call already running is shared, never a second process for the same answer.
    this.profileLoad = null;
    this.limitsLoad = null;
  }

  /** Account identity used to tag usage records. */
  get current() {
    const p = this.profile;
    return p?.loggedIn ? { id: p.accountUuid ?? p.email, email: p.email, org: p.orgName ?? null } : null;
  }

  /** The profile; `force` skips the cache. Concurrent calls share one `claude auth status`. */
  refreshProfile(force = false) {
    if (!this.claude) return Promise.resolve(null);
    if (!force && this.profile && Date.now() - this.profileAt < PROFILE_TTL_MS) return Promise.resolve(this.profile);
    this.profileLoad ??= this.loadProfile().finally(() => (this.profileLoad = null));
    return this.profileLoad;
  }

  /** After a login/logout: a check started before it may be stale, so wait for it and ask again. */
  async reloadProfile() {
    await this.profileLoad?.catch(() => {});
    return this.refreshProfile(true);
  }

  async loadProfile() {
    const { out } = await runClaude(this.claude, ['auth', 'status', '--json'], { timeout: 20_000 });
    let status = {};
    try {
      status = JSON.parse(out.slice(out.indexOf('{')));
    } catch {
      status = { loggedIn: false };
    }
    const oauth = status.loggedIn ? oauthAccount() : {};
    const previous = this.current?.id;
    this.profile = {
      loggedIn: Boolean(status.loggedIn),
      email: status.email ?? oauth.emailAddress ?? null,
      orgName: status.orgName ?? oauth.organizationName ?? null,
      orgId: status.orgId ?? oauth.organizationUuid ?? null,
      subscriptionType: status.subscriptionType ?? null,
      authMethod: status.authMethod ?? null,
      accountUuid: oauth.accountUuid ?? null,
      displayName: oauth.displayName?.trim() || null, // blank names (" ") occur in real profiles
      fullName: oauth.fullName?.trim() || null,
      role: oauth.organizationRole ?? null,
      seatTier: oauth.seatTier ?? null,
      billingType: oauth.billingType ?? null,
      rateLimitTier: oauth.userRateLimitTier ?? oauth.organizationRateLimitTier ?? null,
    };
    this.profileAt = Date.now();
    if (previous !== this.current?.id) {
      this.limits = null; // different account: old quota numbers no longer apply
      this.rateLimit = null;
    }
    this.emit();
    return this.profile;
  }

  /** Plan usage from `/usage` (a local command: no model call, nothing saved). */
  refreshLimits(force = false) {
    if (!this.claude || !this.profile?.loggedIn) return Promise.resolve(null);
    if (!force && this.limits && Date.now() - this.limitsAt < LIMITS_TTL_MS) return Promise.resolve(this.limits);
    this.limitsLoad ??= this.loadLimits().finally(() => (this.limitsLoad = null));
    return this.limitsLoad;
  }

  async loadLimits() {
    const { out } = await runClaude(this.claude, ['-p', '--output-format', 'json', '--no-session-persistence'], { input: '/usage', timeout: 45_000 });
    let text = '';
    try {
      text = JSON.parse(out.slice(out.indexOf('{'))).result ?? '';
    } catch {
      text = out;
    }
    this.limits = { windows: parseUsageText(text), text: text.trim(), at: Date.now() };
    this.limitsAt = Date.now();
    this.emit();
    return this.limits;
  }

  /**
   * Called by sessions on every rate_limit_event (structured 5-hour / 7-day utilization). Each event reports one
   * window (`rateLimitType`), so they are kept per window in `windows` ({ five_hour: { status, utilization,
   * resetsAt, at } }). Browsers are told only when something they show changed (status, whole percent, reset):
   * these events come free with every turn, the quota warnings are built from them instead of re-running `/usage`.
   */
  noteRateLimit(info) {
    if (!info || typeof info !== 'object') return;
    const now = Date.now();
    const prev = this.rateLimit;
    const windows = { ...(prev?.windows ?? {}) };
    const put = (key, w) => {
      if (!key || !w || typeof w !== 'object') return;
      const old = windows[key];
      const resetsAt = finite(w.resetsAt) ?? finite(info.resetsAt);
      // An event without utilization (plain "allowed") keeps the number already known for the same period.
      const samePeriod = old && (resetsAt == null || old.resetsAt === resetsAt);
      windows[key] = { status: w.status ?? info.status ?? null, utilization: finite(w.utilization) ?? (samePeriod ? old.utilization : null), resetsAt: resetsAt ?? (samePeriod ? old.resetsAt : null), at: now };
    };
    put(info.rateLimitType, info);
    for (const [key, w] of Object.entries(info.unifiedWindows ?? {})) put(key, w);
    this.rateLimit = { ...info, windows, at: now };
    if (rateLimitSignature(prev) !== rateLimitSignature(this.rateLimit)) this.emit();
  }

  // ---------- login / logout ----------

  startLogin({ console = false } = {}) {
    if (!this.claude) throw new Error('Claude Code tidak ditemukan.');
    this.cancelLogin();
    const child = spawn(this.claude.command, [...this.claude.args, 'auth', 'login', console ? '--console' : '--claudeai'], { windowsHide: true, env: { ...process.env, OFFICE_MANAGED: '1' } });
    const flow = { state: 'starting', url: null, error: null, child, output: '' };
    this.login = flow;
    const onData = (d) => {
      flow.output = (flow.output + String(d).replace(ANSI, '')).slice(-4000);
      const url = flow.output.match(/https:\/\/\S+/)?.[0];
      if (url && !flow.url) flow.url = url.replace(/[\u0007\\]+$/, '');
      if (/paste code/i.test(flow.output) && flow.state === 'starting') flow.state = 'waiting_code';
      this.emit();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      flow.state = 'error';
      flow.error = err.message;
      this.emit();
    });
    child.on('exit', async (code) => {
      clearTimeout(flow.timer);
      if (this.login !== flow) return;
      if (code === 0) {
        flow.state = 'done';
        await this.reloadProfile();
      } else if (flow.state !== 'cancelled') {
        flow.state = 'error';
        const lastLine = flow.output.trim().split('\n').filter(Boolean).at(-1) ?? '';
        flow.error = /paste code/i.test(lastLine) ? 'Login tidak selesai.' : lastLine || `Login gagal (exit ${code}).`;
      }
      flow.child = null;
      this.emit();
    });
    flow.timer = setTimeout(() => this.cancelLogin(), LOGIN_TIMEOUT_MS);
    this.emit();
    return this.publicLogin();
  }

  submitCode(code) {
    const flow = this.login;
    if (!flow?.child) throw new Error('Tidak ada proses login yang sedang berjalan.');
    flow.child.stdin.write(`${String(code).trim()}\n`);
    flow.state = 'verifying';
    this.emit();
  }

  cancelLogin() {
    const flow = this.login;
    if (!flow?.child) return;
    flow.state = 'cancelled';
    flow.child.kill();
    this.emit();
  }

  async logout() {
    if (!this.claude) throw new Error('Claude Code tidak ditemukan.');
    const { code, out } = await runClaude(this.claude, ['auth', 'logout'], { timeout: 30_000 });
    await this.reloadProfile();
    if (code !== 0) throw new Error(out.replace(ANSI, '').trim() || 'Logout gagal.');
    return this.profile;
  }

  // ---------- state for browsers ----------

  publicLogin() {
    if (!this.login) return null;
    const { state, url, error } = this.login;
    return { state, url, error };
  }

  publicState() {
    return { profile: this.profile, limits: this.limits, rateLimit: this.rateLimit, login: this.publicLogin() };
  }

  emit() {
    this.onChange?.(this.publicState());
  }
}

// ---------- privacy: read-only (plain-HTTP WiFi) viewers ----------

// What a sniffable WiFi viewer may see of the profile: plan and tier facts, never who the account is.
const WIFI_PROFILE_FIELDS = ['loggedIn', 'subscriptionType', 'authMethod', 'role', 'seatTier', 'billingType', 'rateLimitTier'];

/**
 * The key behind the opaque account ids, kept in the data dir so an id stays the same across restarts (a phone's
 * quota warnings are remembered per account). Unreadable or missing: a new one (ids change once, nothing breaks).
 */
export function accountViewKey(file) {
  try {
    const key = readFileSync(file);
    if (key.length >= 32) return key;
  } catch {
    // first start (or unreadable): make one below
  }
  const key = randomBytes(32);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, key, { mode: 0o600 });
  } catch {
    // read-only data dir: this run's ids are still stable, only not across restarts
  }
  return key;
}

/**
 * Views of the account for read-only clients, keyed by `key` (accountViewKey).
 * - `id(realId)`: an opaque, stable, non-reversible account id (HMAC), the same in every event and route.
 * - `state(publicState)`: the SSE `account` event / snapshot `.account` / `/api/account` without email, names,
 *   organisation or ids (`profile.accountKey` replaces them as the client's per-account key) and without the login URL.
 * - `accounts(list)`: `/api/report/accounts` entries without email/org, ids opaque.
 */
export function accountPrivacyView(key) {
  const id = (realId) => (realId ? `acct-${createHmac('sha256', key).update(String(realId)).digest('hex').slice(0, 16)}` : null);
  const profile = (p) => {
    if (!p) return p;
    const view = Object.fromEntries(WIFI_PROFILE_FIELDS.map((k) => [k, p[k] ?? null]));
    return { ...view, accountKey: p.loggedIn ? id(p.accountUuid ?? p.email) : null };
  };
  const state = (s) => {
    if (!s || typeof s !== 'object') return s;
    const view = { ...s, profile: profile(s.profile) };
    if (s.login) view.login = { state: s.login.state, url: null, error: s.login.error ?? null };
    return view;
  };
  const accounts = (list) => list.map((a) => ({ id: id(a.id), email: null, org: null, tokens: a.tokens ?? 0, ...(a.first ? { first: a.first, last: a.last } : {}) }));
  return { id, state, accounts };
}
