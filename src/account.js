// Claude account: profile (`claude auth status` + ~/.claude.json oauthAccount), plan usage
// (`/usage`, no tokens spent), and login/logout through the CLI's own flows.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  }

  /** Account identity used to tag usage records. */
  get current() {
    const p = this.profile;
    return p?.loggedIn ? { id: p.accountUuid ?? p.email, email: p.email, org: p.orgName ?? null } : null;
  }

  async refreshProfile(force = false) {
    if (!this.claude) return null;
    if (!force && this.profile && Date.now() - this.profileAt < PROFILE_TTL_MS) return this.profile;
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
  async refreshLimits(force = false) {
    if (!this.claude || !this.profile?.loggedIn) return null;
    if (!force && this.limits && Date.now() - this.limitsAt < LIMITS_TTL_MS) return this.limits;
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

  /** Called by sessions on every rate_limit_event (structured 5-hour / 7-day utilization). */
  noteRateLimit(info) {
    this.rateLimit = { ...info, at: Date.now() };
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
        await this.refreshProfile(true);
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
    await this.refreshProfile(true);
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
