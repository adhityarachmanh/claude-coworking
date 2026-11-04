// ---------- account (👤 Akun) and the usage report (📊 Laporan token) ----------
// Reading the account, its limits and the report is allowed over WiFi (src/remote.js). Login/logout switch the
// account of every Claude Code on the laptop: server.js lets a phone call them only over Tailscale (ACCOUNT_AUTH).
// `ctx.device` is the paired phone making the request (null on the laptop).
import { randomBytes } from 'node:crypto';
import { accountPrivacyView, billingStatus } from '../account.js';
import { OPENCODE_ACCOUNT } from '../opencode-account.js';
import { openCodeConnectKey, openCodeLogout, openCodeOAuthCancel, openCodeOAuthComplete, openCodeOAuthStart, openCodeOAuthStatus, openCodeProviders } from '../opencode-auth.js';
import { renderPdf, reportHtml } from '../report.js';
import { PERIOD_UNITS, summarize, totals } from '../usage.js';
import { json } from './http.js';

const LOGOUT_CONFIRM = 'LOGOUT';
const DAY_MS = 86_400_000;

/** Local OpenCode usage: the ledger rows from web turns and the terminal mirror. Provider quota is not known. */
function openCodeUsage(ledger) {
  if (!ledger) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const at = (from) => totals(ledger.query({ accountId: OPENCODE_ACCOUNT.id, from }));
  return { today: at(today.getTime()), week: at(Date.now() - 7 * DAY_MS) };
}

/** One headless browser at a time renders report PDFs (each is a full Chrome/Edge process for up to 60 s). */
let pdfRendering = false;

// A ctx without the server's view (a test, a future caller) still never shows who the account is to a read-only client.
const FALLBACK_VIEW = accountPrivacyView(randomBytes(32));
/**
 * The read-only (plain-HTTP WiFi) account view for this request (no email, names, org or real ids), or null when the
 * full one may be sent (laptop, Tailscale). Fail closed: a ctx that can't tell gets the reduced view.
 */
const wifiView = (ctx, req) => (ctx.isReadOnly?.(req) === false ? null : (ctx.accountPrivacy ?? FALLBACK_VIEW));

/** The real account id a report asks for: none = the current one; from a WiFi viewer, its opaque id (null = unknown). */
function requestedAccount({ account, ledger }, view, requested) {
  const current = account.current?.id ?? '';
  if (requested === undefined || requested === null || requested === '') return current;
  if (!view) return String(requested);
  return [current, ...ledger.accounts().map((a) => a.id)].find((id) => id && view.id(id) === String(requested)) ?? null;
}

export function register(router) {
  router.post('/api/account', accountState);
  router.post('/api/account/limits', async ({ account, allowForce }, req, res, params, body) => json(res, 200, (await account.refreshLimits(allowForce(req, body))) ?? {}));
  router.post('/api/account/login', ({ hub, account, device }, req, res, params, body) => {
    const flow = account.startLogin({ console: Boolean(body.console) });
    if (device) accountAlert(hub, 'login', device);
    return json(res, 200, flow);
  });
  router.post('/api/account/login/code', ({ account }, req, res, params, body) => {
    const code = String(body.code ?? '').trim();
    if (!code) return json(res, 400, { error: 'Kode kosong.' });
    account.submitCode(code);
    return json(res, 200, { ok: true });
  });
  router.post('/api/account/login/cancel', ({ account }, req, res) => {
    account.cancelLogin();
    return json(res, 200, { ok: true });
  });
  router.post('/api/account/logout', logout);
  // ---------- engine (Claude Code or OpenCode, app-wide) and OpenCode's provider logins ----------
  router.post('/api/engine', ({ hub, sessions, taskQueue, device }, req, res, params, body) => {
    // Projects whose 📋 Antrian still has work (waiting or running items, paused or not).
    const queuedProjects = Object.entries(taskQueue?.queues ?? {})
      .filter(([, q]) => q.items.some((i) => i.status === 'waiting' || i.status === 'running'))
      .map(([id]) => hub.projects.get(id)?.name ?? id);
    const result = sessions.switchEngine(String(body.engine ?? ''), { queuedProjects });
    if (!result.ok) return json(res, 409, result);
    if (hub.config) hub.config.engine = hub.engine;
    if (device) console.log(`Mesin diganti dari HP "${device.name}"`);
    return json(res, 200, result);
  });
  router.post('/api/opencode/providers', openCode((bin, body, ctx) => openCodeProviders(bin).then((view) => ({ ...view, usage: openCodeUsage(ctx.ledger) }))));
  router.post('/api/opencode/login/key', openCode((bin, body, ctx) => openCodeConnectKey(bin, body.provider, body).then(loggedIn(ctx)).then(phoneAlert(ctx, 'login', body.provider))));
  router.post('/api/opencode/login/oauth', openCode((bin, body, ctx) => openCodeOAuthStart(bin, body.provider, body).then(phoneAlert(ctx, 'login', body.provider))));
  router.post('/api/opencode/login/status', openCode((bin, body, ctx) => openCodeOAuthStatus(bin, body.provider, body.attemptID).then((st) => (st.status === 'complete' ? loggedIn(ctx)(st) : st))));
  router.post('/api/opencode/login/code', openCode((bin, body, ctx) => openCodeOAuthComplete(bin, body.provider, body.attemptID, body.code).then(loggedIn(ctx))));
  router.post('/api/opencode/login/cancel', openCode((bin, body) => openCodeOAuthCancel(bin, body.provider, body.attemptID)));
  router.post('/api/opencode/logout', openCode((bin, body, ctx) => openCodeLogout(bin, body.credentialID).then(loggedIn(ctx)).then(phoneAlert(ctx, 'logout'))));
  // ---------- usage report ----------
  router.post('/api/report/accounts', reportAccounts);
  router.post('/api/report/summary', (ctx, req, res, params, body) => report(ctx, req, res, body, { pdf: false }));
  router.post('/api/report/pdf', (ctx, req, res, params, body) => report(ctx, req, res, body, { pdf: true }));
}

/** An OpenCode route: the binary from ctx, errors as JSON (400 for bad input, 502 when OpenCode itself fails). */
const openCode = (fn) => async (ctx, req, res, params, body) => {
  if (!ctx.opencode) return json(res, 404, { error: 'OpenCode belum terpasang di laptop ini.' });
  try {
    return json(res, 200, (await fn(ctx.opencode, body ?? {}, ctx)) ?? { ok: true });
  } catch (err) {
    return json(res, err.status ?? 502, { error: err.message });
  }
};

/** Credentials changed: idle OpenCode processes restart with them on the next prompt (busy ones after their turn). */
const loggedIn = (ctx) => (result) => {
  if (ctx.hub.engine === 'opencode') ctx.sessions.accountChanged();
  return result;
};

/**
 * Tells the laptop that a phone started a login or logged out (shown as a toast + notification). `engine`
 * "opencode": an OpenCode provider (`provider` its id, null when unknown, e.g. a logout); else the Claude account.
 */
function accountAlert(hub, action, device, email = null, { engine = 'claude', provider = null } = {}) {
  const what = engine === 'opencode' ? `OpenCode${provider ? ` (${provider})` : ''} ` : '';
  console.log(`Akun: ${action} ${what}dari HP "${device.name}"${email ? ` (${email})` : ''}`);
  hub.broadcast('account-alert', { action, device: device.name, email, engine, provider, ts: Date.now() });
}

/** After a successful OpenCode provider login (started) or logout from a phone: the same alert as for Claude Code. */
const PROVIDER_ID = /^[\w.-]{1,100}$/;
const phoneAlert = (ctx, action, provider = null) => (result) => {
  if (ctx.device) accountAlert(ctx.hub, action, ctx.device, null, { engine: 'opencode', provider: PROVIDER_ID.test(String(provider ?? '')) ? String(provider) : null });
  return result;
};

/**
 * `account-alert` for a read-only client on plain-HTTP WiFi (sniffable): the alert stays, without the paired
 * device's name (often a person's) or the account email. Registered in server.js (hub.redactors).
 */
export const wifiAccountAlert = ({ action, engine, ts }) => ({ action, device: 'Perangkat lain', email: null, ...(engine ? { engine } : {}), ts });

async function accountState(ctx, req, res, params, body) {
  const { account, ledger, allowForce } = ctx;
  await account.refreshProfile(allowForce(req, body));
  const view = wifiView(ctx, req);
  const id = account.current?.id;
  const since = (ms) => totals(id ? ledger.query({ accountId: id, from: Date.now() - ms }) : []);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const state = view ? view.state(account.publicState()) : account.publicState();
  return json(res, 200, { ...state, usage: { today: totals(id ? ledger.query({ accountId: id, from: today.getTime() }) : []), week: since(7 * 86_400_000) } });
}

async function logout({ hub, account, device }, req, res, params, body) {
  // Second step for phones: the user must type LOGOUT, so a stray tap can't sign the laptop out.
  if (device && body.confirm !== LOGOUT_CONFIRM) return json(res, 400, { error: `Ketik ${LOGOUT_CONFIRM} untuk konfirmasi logout dari HP.` });
  const email = account.current?.email ?? null;
  const profile = await account.logout();
  if (device) accountAlert(hub, 'logout', device, email);
  return json(res, 200, { profile });
}

function reportAccounts(ctx, req, res) {
  const { account, ledger } = ctx;
  const known = ledger.accounts();
  const current = account.current;
  if (current && !known.some((a) => a.id === current.id)) known.unshift({ ...current, tokens: 0 });
  const view = wifiView(ctx, req);
  if (view) return json(res, 200, { accounts: view.accounts(known), current: view.id(current?.id) });
  return json(res, 200, { accounts: known, current: current?.id ?? null });
}

/** POST /api/report/summary (JSON) and /api/report/pdf (a PDF download, or the HTML to print when no browser renders it). */
async function report(ctx, req, res, body, { pdf: wantPdf }) {
  const { account, ledger } = ctx;
  const view = wifiView(ctx, req);
  const accountId = requestedAccount(ctx, view, body.accountId);
  if (accountId === null) return json(res, 404, { error: 'Akun tidak dikenal.' });
  const to = Number(body.to) || Date.now();
  const from = Number(body.from) || 0;
  const rows = ledger.query({ accountId, from, to });
  const groupBy = PERIOD_UNITS.includes(body.groupBy) ? body.groupBy : 'day';
  const summary = summarize(rows, { from: from || (rows[0]?.ts ?? to), to, groupBy });
  if (!wantPdf) return json(res, 200, summary);
  const found = ledger.accounts().find((a) => a.id === accountId) ?? (account.current?.id === accountId ? account.current : null);
  if (!found) return json(res, 404, { error: 'Akun tidak dikenal.' });
  const isCurrent = account.current?.id === accountId;
  // WiFi: the PDF (and its file name) says "Akun Claude", never the email, name or organisation.
  const who = view ? { ...found, email: 'Akun Claude', org: null } : found;
  const profile = isCurrent ? (view ? view.state({ profile: account.profile }).profile : account.profile) : null;
  // billing (usage-based seats): only a limit status and a reset date, nothing personal, so WiFi gets it too
  const billing = isCurrent ? billingStatus(account.profile, account.rateLimit) : null;
  const html = reportHtml({ account: who, profile, limits: isCurrent ? account.limits : null, billing, summary });
  if (pdfRendering) return json(res, 429, { error: 'Laporan PDF lain sedang dibuat. Coba lagi sebentar.' });
  pdfRendering = true;
  try {
    const pdf = await renderPdf(html);
    // Local date (sv-SE = YYYY-MM-DD): toISOString is UTC, a day behind in the Jakarta morning.
    const name = `laporan-token-${who.email.replace(/[^\w.-]+/g, '_')}-${new Date().toLocaleDateString('sv-SE')}.pdf`;
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    return res.end(pdf);
  } catch (err) {
    // No headless browser available: hand back the HTML so the page can print it to PDF.
    return json(res, 501, { error: err.message, html });
  } finally {
    pdfRendering = false;
  }
}
