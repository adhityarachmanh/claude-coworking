// Claude account: profile, plan quota, token usage, login/logout.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { fmtShort } from '../core/format.js';
import { state } from '../core/state.js';
import { closeModal, focusablesIn, openModal } from '../ui/modals.js';
import { chime } from './notify.js';
import { accountKeyOf, checkQuota } from './quota.js';
import { openReport } from './report.js';

const LOGIN_TEXT = {
  starting: 'Membuka halaman login di browser…',
  waiting_code: 'Selesaikan login di browser. Kalau diminta, salin kode dari halaman itu lalu tempel di sini.',
  verifying: 'Memverifikasi kode…',
  done: 'Login berhasil.',
  cancelled: 'Login dibatalkan.',
};
const account = { usage: null, loading: false, loginState: null };

function accountName(p) {
  // Profiles can hold blank names (a full name of " "), so take the first field with real text.
  return [p?.fullName, p?.displayName, p?.email].map((v) => v?.trim()).find(Boolean) ?? 'Akun Claude';
}
const accountInitial = (p) => accountName(p)[0].toUpperCase();
/** The label of a logged-in account: its email, or on a read-only (plain WiFi) phone, which gets none, the plan. */
const accountLabel = (p) => p.email ?? `Akun Claude${p.subscriptionType ? ` (${p.subscriptionType})` : ''}`;

export function renderAccountButton() {
  const p = state.account?.profile;
  const btn = $('#btn-account');
  btn.classList.toggle('logged-out', !p?.loggedIn);
  $('#account-avatar').textContent = p?.loggedIn ? accountInitial(p) : '!';
  $('#account-label').textContent = p ? (p.loggedIn ? accountLabel(p) : 'Belum login') : 'Akun';
  btn.title = p?.loggedIn ? `${accountLabel(p)}${p.orgName ? ` · ${p.orgName}` : ''} — profil, kuota & login` : 'Belum login ke Claude — klik untuk login';
  checkQuota(); // after every account change (snapshot, live rate-limit events): warnings + top-bar indicator
}

/** Quota bars: `/usage` text when fetched, else the structured rate-limit info from a running session. */
/** `/usage` prints English labels; show them in the app's language. */
const quotaLabel = (label) =>
  label
    .replace(/^Current session$/i, 'Sesi saat ini (5 jam)')
    .replace(/^Current week \((.+)\)$/i, (_, m) => `Minggu ini (${/^all models$/i.test(m) ? 'semua model' : m})`);

function quotaRows() {
  const limits = state.account?.limits;
  if (limits?.windows?.length) return limits.windows.map((w) => ({ ...w, label: quotaLabel(w.label) }));
  const win = state.account?.rateLimit?.windows ?? state.account?.rateLimit?.unifiedWindows ?? {};
  const label = { five_hour: 'Sesi 5 jam', seven_day: 'Minggu ini' };
  return Object.entries(win)
    .filter(([, w]) => w?.utilization != null)
    .map(([k, w]) => ({ label: label[k] ?? k, percent: Math.round(w.utilization * 100), resets: w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : null }));
}

function usageTable(usage) {
  if (!usage) return '<p class="muted small">Memuat…</p>';
  const row = (label, t) => `<tr><th>${label}</th><td>${fmtShort(t.input)}</td><td>${fmtShort(t.output)}</td><td>${fmtShort(t.cacheRead)}</td><td>${fmtShort(t.cacheWrite)}</td><td><b>${fmtShort(t.total)}</b></td></tr>`;
  return `<table class="usage-table">
    <thead><tr><th></th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Total</th></tr></thead>
    <tbody>${row('Hari ini', usage.today)}${row('7 hari', usage.week)}</tbody>
  </table>`;
}

function renderLoginFlow() {
  const box = $('#acct-login');
  if (!box) return;
  const login = state.account?.login;
  const active = login && ['starting', 'waiting_code', 'verifying'].includes(login.state);
  account.loginState = login?.state ?? null;
  if (!active) {
    box.innerHTML = login?.state === 'error' ? `<p class="warn">Login gagal: ${escapeHtml(login.error ?? 'tidak diketahui')}</p>` : '';
    return;
  }
  box.innerHTML = `<div class="login-flow">
      <p>${LOGIN_TEXT[login.state]}</p>
      ${login.url ? `<a class="primary link-btn" href="${escapeHtml(login.url)}" target="_blank" rel="noopener noreferrer">🔑 Buka halaman login Claude</a>` : '<span class="spinner"></span>'}
      <form id="login-code" class="login-code">
        <input id="login-code-input" placeholder="Tempel kode dari browser (jika diminta)" aria-label="Kode login dari browser" autocomplete="off" spellcheck="false" ${login.state === 'verifying' ? 'disabled' : ''} />
        <button class="primary" ${login.state === 'verifying' ? 'disabled' : ''}>Kirim</button>
      </form>
      <button type="button" class="ghost" data-act="cancel-login">Batal</button>
    </div>`;
}

/** The laptop is told whenever a phone starts a login or logs out. */
export function onAccountAlert({ action, device, email }) {
  if (!state.local) return;
  const text = action === 'logout' ? `HP "${device}" me-logout Claude Code${email ? ` (${email})` : ''}.` : `HP "${device}" memulai login/ganti akun Claude Code.`;
  toast(text, 'warn');
  chime('ask', 100); // a security alert: always full volume, whatever the 🔔 volume setting
  if ('Notification' in window && Notification.permission === 'granted') new Notification('Adhit Office: akun Claude', { body: text, tag: 'account-alert' });
}

// renderAccount() rebuilds #account-body (up to 3× while account + quota load), which would drop keyboard focus
// to <body>. Remember the focused action button and put focus back on its replacement — or keep it in the dialog.
function renderAccount() {
  const body = $('#account-body');
  const active = document.activeElement;
  const hadFocus = body.contains(active);
  const act = hadFocus ? active.closest('[data-act]')?.dataset.act : null;
  try {
    renderAccountBody(body);
  } finally {
    if (hadFocus && !body.contains(document.activeElement)) {
      const target = (act && body.querySelector(`[data-act="${CSS.escape(act)}"]`)) || focusablesIn($('#account-modal'))[0];
      target?.focus({ preventScroll: true });
    }
  }
}

function renderAccountBody(body) {
  const p = state.account?.profile;
  if (!p) {
    body.innerHTML = '<p class="muted">Memeriksa akun Claude Code…</p>';
    return;
  }
  const actions = state.accountAuth
    ? p.loggedIn
      ? `<button class="ghost" data-act="login">⇄ Ganti akun</button><button class="danger" data-act="logout">⏻ Logout</button>`
      : `<button class="primary" data-act="login">🔑 Login dengan akun Claude</button><button class="ghost" data-act="login-console">Login via Console (API)</button>`
    : '<p class="muted small">Login/logout dari HP hanya lewat Tailscale (koneksi terenkripsi). Buka kantor lewat alamat Tailscale, atau lakukan dari laptop.</p>';
  if (!p.loggedIn) {
    body.innerHTML = `<div class="acct-empty"><p>Claude Code di laptop ini <b>belum login</b>. Login membuka halaman claude.ai di browser, sama seperti <code>claude auth login</code>.</p></div>
      <div class="acct-actions">${actions}</div><div id="acct-login"></div>`;
    renderLoginFlow();
    return;
  }
  const facts = [
    ['Email', p.email],
    ['Organisasi', p.orgName],
    ['Paket', p.subscriptionType],
    ['Peran', p.role],
    ['Seat', p.seatTier],
    ['Metode login', p.authMethod],
    ['Tier rate limit', p.rateLimitTier],
    ['ID akun', p.accountUuid],
  ].filter(([, v]) => v);
  const quota = quotaRows();
  const quotaHtml = quota.length
    ? quota
        .map((w) => {
          const tone = w.percent >= 90 ? 'bad' : w.percent >= 70 ? 'warn' : 'ok';
          return `<div class="quota"><div class="quota-head"><span>${escapeHtml(w.label)}</span><b>${w.percent}%</b></div>
            <div class="bar"><i class="${tone}" style="width:${Math.min(100, w.percent)}%"></i></div>
            ${w.resets ? `<small class="muted">reset ${escapeHtml(w.resets)}</small>` : ''}</div>`;
        })
        .join('')
    : `<p class="muted small">${account.loading ? 'Mengambil kuota…' : 'Belum ada data kuota.'}</p>`;
  body.innerHTML = `<div class="acct-head">
      <span class="avatar big">${escapeHtml(accountInitial(p))}</span>
      <div><b>${escapeHtml(accountName(p))}</b><small>${escapeHtml(p.email ?? '')}</small></div>
      ${p.subscriptionType ? `<span class="plan-badge">${escapeHtml(p.subscriptionType)}</span>` : ''}
    </div>
    <dl class="acct-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
    <div class="acct-section"><div class="acct-title"><b>Kuota paket</b><button class="ghost icon" data-act="limits" title="Cek ulang kuota">↻</button></div>${quotaHtml}</div>
    <div class="acct-section"><div class="acct-title"><b>Pemakaian token akun ini</b><button class="ghost" data-act="report">📊 Laporan</button></div>${usageTable(account.usage)}
      <p class="muted small">Dihitung dari sesi web & CLI sejak fitur ini aktif, hanya untuk akun yang sedang login.</p></div>
    <div class="acct-actions">${actions}</div>
    <div id="acct-login"></div>`;
  renderLoginFlow();
}

async function loadAccount(force = false) {
  try {
    const data = await api('/api/account', { force });
    account.usage = data.usage;
    state.account = { ...state.account, ...data };
    renderAccountButton();
    renderAccount();
    if (!data.profile?.loggedIn) return;
    account.loading = true;
    renderAccount();
    state.account.limits = await api('/api/account/limits', { force });
    checkQuota(); // a fresh `/usage` (fetched for this dialog anyway) may cross a threshold
  } catch (err) {
    toast(err.message);
  } finally {
    account.loading = false;
    if (!$('#account-modal').hidden) renderAccount();
  }
}

export function onAccountState(next) {
  const prevId = accountKeyOf(state.account?.profile);
  state.account = { ...state.account, ...next };
  renderAccountButton();
  const id = accountKeyOf(next.profile);
  if (next.login?.state === 'done' && account.loginState !== 'done') toast(`Login berhasil sebagai ${next.profile?.email ?? 'akun baru'}.`, 'ok');
  if ($('#account-modal').hidden) return;
  if (prevId !== id) return loadAccount(true); // switched account: usage & quota belong to the new one
  // Keep what the user is typing in the code box: only redraw the flow when its state changes.
  if ((next.login?.state ?? null) !== account.loginState) renderLoginFlow();
  if (!$('#login-code-input')) renderAccount();
}

export function initAccount() {
  $('#btn-account').addEventListener('click', () => {
    openModal('account-modal');
    renderAccount();
    loadAccount();
  });
  $('#account-body').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    try {
      if (act === 'login' || act === 'login-console') {
        state.account = { ...state.account, login: await api('/api/account/login', { console: act === 'login-console' }) };
        renderLoginFlow();
      } else if (act === 'cancel-login') {
        await api('/api/account/login/cancel');
      } else if (act === 'logout') {
        const email = state.account?.profile?.email ?? 'akun ini';
        if (!window.confirm(`Logout dari ${email}?\n\nClaude Code di laptop ini (termasuk terminal/CLI) ikut logout. Giliran yang sedang berjalan di web dibiarkan selesai dulu.`)) return;
        // From a phone, a second step: type LOGOUT (the server checks it too).
        let confirm;
        if (!state.local) {
          confirm = window.prompt('Logout dari HP akan mengeluarkan Claude Code di laptop.\nKetik LOGOUT untuk melanjutkan:')?.trim().toUpperCase();
          if (confirm !== 'LOGOUT') return toast('Logout dibatalkan.', 'ok');
        }
        await api('/api/account/logout', { confirm });
        account.usage = null;
        toast('Sudah logout.', 'ok');
        loadAccount(true);
      } else if (act === 'limits') {
        account.loading = true;
        renderAccount();
        state.account.limits = await api('/api/account/limits', { force: true });
        checkQuota();
        account.loading = false;
        renderAccount();
      } else if (act === 'report') {
        closeModal('account-modal');
        openReport();
      }
    } catch (err) {
      account.loading = false;
      toast(err.message);
    }
  });
  $('#account-body').addEventListener('submit', async (e) => {
    if (e.target.id !== 'login-code') return;
    e.preventDefault();
    const code = $('#login-code-input').value.trim();
    if (!code) return;
    await api('/api/account/login/code', { code }).catch((err) => toast(err.message));
  });
}
