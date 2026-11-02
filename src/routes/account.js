// ---------- account (👤 Akun) and the usage report (📊 Laporan token) ----------
// Reading the account, its limits and the report is allowed over WiFi (src/remote.js). Login/logout switch the
// account of every Claude Code on the laptop: server.js lets a phone call them only over Tailscale (ACCOUNT_AUTH).
// `ctx.device` is the paired phone making the request (null on the laptop).
import { renderPdf, reportHtml } from '../report.js';
import { PERIOD_UNITS, summarize, totals } from '../usage.js';
import { json } from './http.js';

const LOGOUT_CONFIRM = 'LOGOUT';

/** One headless browser at a time renders report PDFs (each is a full Chrome/Edge process for up to 60 s). */
let pdfRendering = false;

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
  // ---------- usage report ----------
  router.post('/api/report/accounts', reportAccounts);
  router.post('/api/report/summary', (ctx, req, res, params, body) => report(ctx, res, body, { pdf: false }));
  router.post('/api/report/pdf', (ctx, req, res, params, body) => report(ctx, res, body, { pdf: true }));
}

/** Tells the laptop that a phone started a login or logged out (shown as a toast + notification). */
function accountAlert(hub, action, device, email = null) {
  console.log(`Akun: ${action} dari HP "${device.name}"${email ? ` (${email})` : ''}`);
  hub.broadcast('account-alert', { action, device: device.name, email, ts: Date.now() });
}

async function accountState({ account, ledger, allowForce }, req, res, params, body) {
  await account.refreshProfile(allowForce(req, body));
  const id = account.current?.id;
  const since = (ms) => totals(id ? ledger.query({ accountId: id, from: Date.now() - ms }) : []);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return json(res, 200, { ...account.publicState(), usage: { today: totals(id ? ledger.query({ accountId: id, from: today.getTime() }) : []), week: since(7 * 86_400_000) } });
}

async function logout({ hub, account, device }, req, res, params, body) {
  // Second step for phones: the user must type LOGOUT, so a stray tap can't sign the laptop out.
  if (device && body.confirm !== LOGOUT_CONFIRM) return json(res, 400, { error: `Ketik ${LOGOUT_CONFIRM} untuk konfirmasi logout dari HP.` });
  const email = account.current?.email ?? null;
  const profile = await account.logout();
  if (device) accountAlert(hub, 'logout', device, email);
  return json(res, 200, { profile });
}

function reportAccounts({ account, ledger }, req, res) {
  const known = ledger.accounts();
  const current = account.current;
  if (current && !known.some((a) => a.id === current.id)) known.unshift({ ...current, tokens: 0 });
  return json(res, 200, { accounts: known, current: current?.id ?? null });
}

/** POST /api/report/summary (JSON) and /api/report/pdf (a PDF download, or the HTML to print when no browser renders it). */
async function report({ account, ledger }, res, body, { pdf: wantPdf }) {
  const accountId = String(body.accountId ?? account.current?.id ?? '');
  const to = Number(body.to) || Date.now();
  const from = Number(body.from) || 0;
  const rows = ledger.query({ accountId, from, to });
  const groupBy = PERIOD_UNITS.includes(body.groupBy) ? body.groupBy : 'day';
  const summary = summarize(rows, { from: from || (rows[0]?.ts ?? to), to, groupBy });
  if (!wantPdf) return json(res, 200, summary);
  const who = ledger.accounts().find((a) => a.id === accountId) ?? (account.current?.id === accountId ? account.current : null);
  if (!who) return json(res, 404, { error: 'Akun tidak dikenal.' });
  const isCurrent = account.current?.id === accountId;
  const html = reportHtml({ account: who, profile: isCurrent ? account.profile : null, limits: isCurrent ? account.limits : null, summary });
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
