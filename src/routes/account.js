// ---------- account (👤 Akun) and the usage report (📊 Laporan token) ----------
// Reading the account, its limits and the report is allowed over WiFi (src/remote.js). Login/logout switch the
// account of every Claude Code on the laptop: server.js lets a phone call them only over Tailscale (ACCOUNT_AUTH).
// `ctx.device` is the paired phone making the request (null on the laptop).
import { randomBytes } from 'node:crypto';
import { accountPrivacyView, billingStatus } from '../account.js';
import { recordAuth, recentAuth } from '../auth-audit.js';
import { ENGINES } from '../hub.js';
import { readModelPrices } from '../model-prices.js';
import { OPENCODE_ACCOUNT } from '../opencode-account.js';
import { openCodeConnectKey, openCodeLogout, openCodeOAuthCancel, openCodeOAuthComplete, openCodeOAuthStart, openCodeOAuthStatus, openCodeProviders } from '../opencode-auth.js';
import { GO_PLANS, goAllowance } from '../opencode-go.js';
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

/** The Go plan has no cost in the session messages, so its allowance is estimated from the ledger and the catalog. */
const GO_PRICES_DAYS = 30;

/**
 * The estimated Go allowance for 👤 Akun: ledger rows of the OpenCode engine (every account, last 30 days) priced with
 * the catalog's Go list prices, compared to the published monthly limits. Without a catalog (no cache, fetch failed)
 * the answer says so instead of pretending the plan is untouched. Never throws: readModelPrices never does either.
 */
async function goView({ hub, ledger, dataDir }, now = Date.now()) {
  const plan = hub?.goPlan?.() ?? 'go';
  const catalog = await readModelPrices({ dataDir: hub?.dataDir ?? dataDir });
  if (!catalog || !Object.keys(catalog.models ?? {}).length) return { plan, available: false, models: [], note: 'Harga model belum tersedia.' };
  const rows = ledger ? ledger.query({ accountId: 'all', from: now - GO_PRICES_DAYS * DAY_MS }) : [];
  return { available: true, ...goAllowance({ rows, prices: catalog.models, now, plan }) };
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

/**
 * The real account id a report asks for: none = the current one; `'all'` = every account (the combined report,
 * for both the laptop and a WiFi viewer — it carries no identity); from a WiFi viewer, its opaque id (null = unknown).
 */
function requestedAccount({ account, ledger }, view, requested) {
  const current = account.current?.id ?? '';
  if (requested === 'all') return 'all'; // never mapped through the opaque WiFi ids
  if (requested === undefined || requested === null || requested === '') return current;
  if (!view) return String(requested);
  return [current, ...ledger.accounts().map((a) => a.id)].find((id) => id && view.id(id) === String(requested)) ?? null;
}

export function register(router) {
  router.post('/api/account', accountState);
  router.post('/api/account/limits', async ({ account, allowForce }, req, res, params, body) => json(res, 200, (await account.refreshLimits(allowForce(req, body))) ?? {}));
  router.post('/api/account/login', loginStart);
  router.post('/api/account/login/code', loginCode);
  router.post('/api/account/login/cancel', loginCancel);
  router.post('/api/account/logout', logout);
  // 📜 Riwayat perubahan akun: the last auth actions, newest first (laptop + Tailscale, never plain WiFi).
  router.post('/api/account/audit', ({ dataDir }, req, res, params, body) => {
    const raw = Number(body?.limit);
    const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, Math.trunc(raw))) : 50;
    return json(res, 200, { entries: recentAuth(limit, { dataDir }) });
  });
  // ---------- engine (the DEFAULT for new projects) and OpenCode's provider logins ----------
  // Stage 1: this no longer switches anything. Every project keeps its own engine (POST
  // /api/projects/:id/engine); this only decides which engine a project seen for the first time starts on.
  router.post('/api/engine', ({ hub, device }, req, res, params, body) => {
    const engine = String(body.engine ?? '');
    if (!ENGINES.includes(engine)) return json(res, 400, { error: 'Mesin tidak dikenal.' });
    if (engine === 'opencode' && !hub.config?.engines?.opencode?.available) return json(res, 409, { error: 'OpenCode belum terpasang di laptop ini.' });
    hub.setDefaultEngine(engine);
    if (hub.config) {
      hub.config.engine = hub.engine;
      hub.broadcast('config', hub.config);
    }
    if (device) console.log(`Mesin default diganti dari HP "${device.name}"`);
    return json(res, 200, { ok: true, engine: hub.engine });
  });
  // The user's Go plan: OpenCode does not report it, so the estimate needs it spelled out. Go Teams limits are per
  // member. A plain-WiFi phone is read-only (this route is not on its allowlist), like the other settings.
  router.post('/api/account/go-plan', ({ hub, device }, req, res, params, body) => {
    const plan = String(body?.plan ?? '');
    if (!Object.hasOwn(GO_PLANS, plan)) return json(res, 400, { error: 'Paket OpenCode Go tidak dikenal.' });
    hub.setGoPlan(plan);
    if (device) console.log(`Paket OpenCode Go diganti ke ${plan} dari HP "${device.name}"`);
    return json(res, 200, { ok: true, plan });
  });
  // Providers plus the estimated Go allowance (the catalog fetch and the provider list run side by side).
  router.post('/api/opencode/providers', openCode(async (bin, body, ctx) => {
    const [view, go] = await Promise.all([openCodeProviders(bin), goView(ctx)]);
    return { ...view, usage: openCodeUsage(ctx.ledger), go };
  }));
  router.post('/api/opencode/login/key', audited('login-key', (body) => body.provider, (bin, body, ctx) => openCodeConnectKey(bin, body.provider, body).then(loggedIn(ctx)).then(phoneAlert(ctx, 'login', body.provider))));
  router.post('/api/opencode/login/oauth', audited('oauth-start', (body) => body.provider, (bin, body, ctx) => openCodeOAuthStart(bin, body.provider, body).then(phoneAlert(ctx, 'login', body.provider))));
  router.post('/api/opencode/login/status', openCode(oAuthStatus));
  router.post('/api/opencode/login/code', audited('oauth-complete', (body) => body.provider, (bin, body, ctx) => openCodeOAuthComplete(bin, body.provider, body.attemptID, body.code).then(loggedIn(ctx))));
  router.post('/api/opencode/login/cancel', audited('cancel', (body) => body.provider, (bin, body) => openCodeOAuthCancel(bin, body.provider, body.attemptID)));
  router.post('/api/opencode/logout', openCode(openCodeLogoutRoute));
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

/** Who did it, for the audit: the paired phone's name, or the laptop itself. */
const actorOf = (device) => (device?.name ? String(device.name) : 'laptop');
/** The provider an audit line names: only a real provider id (the request body is untrusted). */
const auditProvider = (value) => (PROVIDER_ID.test(String(value ?? '')) ? String(value) : null);
/** One audit line (data/auth-audit.jsonl); a bad entry only logs, it never changes the answer to the client. */
const audit = (ctx, entry) => recordAuth(entry, { dataDir: ctx.dataDir });

/**
 * An OpenCode route that records the attempt (ok or not) and then answers exactly as before. The provider in the
 * entry is the one the body names, so a failed login still says which provider it was for.
 */
const audited = (action, providerOf, fn) => openCode(async (bin, body, ctx) => {
  const actor = actorOf(ctx.device);
  const provider = auditProvider(providerOf(body));
  try {
    const result = await fn(bin, body, ctx);
    audit(ctx, { action, engine: 'opencode', provider, actor, ok: true, detail: null });
    return result;
  } catch (err) {
    audit(ctx, { action, engine: 'opencode', provider, actor, ok: false, detail: err.message });
    throw err; // openCode() turns it into the same JSON status as before
  }
});

/** The OAuth attempt's state; only the moment it completes is an auth action worth an audit line. */
async function oAuthStatus(bin, body, ctx) {
  const st = await openCodeOAuthStatus(bin, body.provider, body.attemptID);
  if (st.status !== 'complete') return st;
  audit(ctx, { action: 'oauth-complete', engine: 'opencode', provider: auditProvider(body.provider), actor: actorOf(ctx.device), ok: true, detail: null });
  return loggedIn(ctx)(st);
}

const OPENCODE_LOGOUT_CONFIRM = 'LOGOUT';
const CREDENTIAL_ID = /^[\w.-]{1,100}$/;

/** The provider a stored credential belongs to, from the providers list; null when unknown or already gone. */
async function providerOfCredential(bin, credentialID) {
  if (!CREDENTIAL_ID.test(credentialID)) return null;
  try {
    const { connected } = await openCodeProviders(bin);
    return connected.find((p) => p.connections.some((c) => c.type === 'credential' && c.id === credentialID))?.id ?? null;
  } catch {
    return null; // the logout itself reports what is wrong
  }
}

const MODEL_STALE_TEXT = (model, provider) => `⚠ Model aktif (${model}) berasal dari provider ${provider} yang baru logout. Pilih model lain atau Default.`;

/**
 * A provider was logged out: every OpenCode project with one of its models active is marked stale (and told in its
 * chat). The model is deliberately left as it is: the next prompt is refused (routes/session.js) until the user
 * picks another model or Default, so a dead provider is never replaced silently.
 */
function markModelStale(hub, provider) {
  if (!provider) return;
  for (const project of hub.projects.values()) {
    if (project.virtual) continue;
    if (hub.settingsFor(project.id).engine !== 'opencode') continue;
    // Only a project whose session is (or was) running has an active model; reading it never opens a runtime.
    const model = String(hub.runtime.get(project.id)?.status?.activeModel ?? '');
    if (!model.startsWith(`${provider}/`)) continue;
    hub.setStatus(project.id, { modelStale: true });
    hub.chat(project.id, { kind: 'info', level: 'warning', modelStale: true, text: MODEL_STALE_TEXT(model, provider) });
  }
}

/**
 * POST /api/opencode/logout: drops one stored provider credential. `confirm: "LOGOUT"` is required from every
 * client (the laptop too): a single tap must never leave the projects without a provider.
 */
async function openCodeLogoutRoute(bin, body, ctx) {
  const actor = actorOf(ctx.device);
  if (body.confirm !== OPENCODE_LOGOUT_CONFIRM) {
    audit(ctx, { action: 'logout', engine: 'opencode', provider: null, actor, ok: false, detail: `butuh konfirmasi ${OPENCODE_LOGOUT_CONFIRM}` });
    throw Object.assign(new Error(`Ketik ${OPENCODE_LOGOUT_CONFIRM} untuk konfirmasi logout provider dari HP.`), { status: 400 });
  }
  const credentialID = String(body.credentialID ?? '');
  // Which provider it was: only known before the logout (afterwards the credential is gone from the list).
  const provider = await providerOfCredential(bin, credentialID);
  try {
    await openCodeLogout(bin, credentialID);
  } catch (err) {
    audit(ctx, { action: 'logout', engine: 'opencode', provider, actor, ok: false, detail: err.message });
    throw err;
  }
  audit(ctx, { action: 'logout', engine: 'opencode', provider, actor, ok: true, detail: null });
  markModelStale(ctx.hub, provider);
  return phoneAlert(ctx, 'logout')(loggedIn(ctx)({ ok: true }));
}

/** Credentials changed: idle OpenCode processes restart with them on the next prompt (busy ones after their turn). */
const loggedIn = (ctx) => (result) => {
  ctx.sessions.openCodeAccountChanged?.(); // only OpenCode sessions: an ACP process is unchanged by a Claude login
  // A provider came or went: every queue pauses until the user has checked the model (never a silent replacement).
  ctx.taskQueue?.pauseAll('account');
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

/** POST /api/account/login: the login flow starts; a phone is announced on the laptop; every queue pauses. */
function loginStart({ hub, account, device, taskQueue, dataDir }, req, res, params, body) {
  const actor = actorOf(device);
  let flow;
  try {
    flow = account.startLogin({ console: Boolean(body.console) });
    recordAuth({ action: 'login-start', engine: 'claude', provider: null, actor, ok: true, detail: null }, { dataDir });
  } catch (err) {
    recordAuth({ action: 'login-start', engine: 'claude', provider: null, actor, ok: false, detail: err.message }, { dataDir });
    throw err; // the same 500 as before
  }
  taskQueue?.pauseAll('account'); // the account (and so the model) is about to change: nothing runs meanwhile
  if (device) accountAlert(hub, 'login', device);
  return json(res, 200, flow);
}

/** POST /api/account/login/code: the pasted code goes to the running login; the code itself is never audited. */
function loginCode({ account, device, dataDir }, req, res, params, body) {
  const actor = actorOf(device);
  const code = String(body.code ?? '').trim();
  if (!code) {
    recordAuth({ action: 'login-code', engine: 'claude', provider: null, actor, ok: false, detail: 'Kode kosong.' }, { dataDir });
    return json(res, 400, { error: 'Kode kosong.' });
  }
  try {
    account.submitCode(code);
    recordAuth({ action: 'login-code', engine: 'claude', provider: null, actor, ok: true, detail: null }, { dataDir });
    return json(res, 200, { ok: true });
  } catch (err) {
    recordAuth({ action: 'login-code', engine: 'claude', provider: null, actor, ok: false, detail: err.message }, { dataDir });
    throw err;
  }
}

/** POST /api/account/login/cancel: the login the user started is dropped (nothing is signed in). */
function loginCancel({ account, device, dataDir }, req, res) {
  const actor = actorOf(device);
  try {
    account.cancelLogin();
    recordAuth({ action: 'login-cancel', engine: 'claude', provider: null, actor, ok: true, detail: null }, { dataDir });
    return json(res, 200, { ok: true });
  } catch (err) {
    recordAuth({ action: 'login-cancel', engine: 'claude', provider: null, actor, ok: false, detail: err.message }, { dataDir });
    throw err;
  }
}

async function logout({ hub, account, device, taskQueue, dataDir }, req, res, params, body) {
  const actor = actorOf(device);
  // Second step for phones: the user must type LOGOUT, so a stray tap can't sign the laptop out.
  if (device && body.confirm !== LOGOUT_CONFIRM) {
    recordAuth({ action: 'logout', engine: 'claude', provider: null, actor, ok: false, detail: `butuh konfirmasi ${LOGOUT_CONFIRM}` }, { dataDir });
    return json(res, 400, { error: `Ketik ${LOGOUT_CONFIRM} untuk konfirmasi logout dari HP.` });
  }
  const email = account.current?.email ?? null;
  let profile;
  try {
    profile = await account.logout();
    recordAuth({ action: 'logout', engine: 'claude', provider: null, actor, ok: true, detail: null }, { dataDir });
  } catch (err) {
    recordAuth({ action: 'logout', engine: 'claude', provider: null, actor, ok: false, detail: err.message }, { dataDir });
    throw err;
  }
  taskQueue?.pauseAll('account'); // every queue stops: the account that ran them just left
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
  const all = accountId === 'all';
  const to = Number(body.to) || Date.now();
  const from = Number(body.from) || 0;
  const rows = ledger.query({ accountId, from, to });
  const groupBy = PERIOD_UNITS.includes(body.groupBy) ? body.groupBy : 'day';
  const summary = summarize(rows, { from: from || (rows[0]?.ts ?? to), to, groupBy });
  // The summary is aggregated only (engine/model/project/source/period/sessions): no email, org or account id.
  if (!wantPdf) return json(res, 200, summary);
  // Combined report: a fixed label without personal data, and no per-account profile, limits or billing.
  const found = all
    ? { email: 'Semua akun', org: null }
    : (ledger.accounts().find((a) => a.id === accountId) ?? (account.current?.id === accountId ? account.current : null));
  if (!found) return json(res, 404, { error: 'Akun tidak dikenal.' });
  const isCurrent = !all && account.current?.id === accountId;
  // WiFi: the PDF (and its file name) says "Akun Claude", never the email, name or organisation.
  const who = all || !view ? found : { ...found, email: 'Akun Claude', org: null };
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
