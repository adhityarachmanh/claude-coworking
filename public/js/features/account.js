// 👤 Akun: one page with both login sources — Claude (subscription, quota, login) and the OpenCode providers. The
// page never asks which "engine" a project uses: a model picks it (features/opencode-account.js).
import { accountImpactText } from '../core/account-impact.js';
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { engineLabel } from '../core/engine-caps.js';
import { fmtShort } from '../core/format.js';
import { state } from '../core/state.js';
import { closeModal, focusablesIn, openModal } from '../ui/modals.js';
import { chime } from './notify.js';
import { renderComposer } from './composer.js';
import { accountKeyOf, checkQuota } from './quota.js';
import { openReport } from './report.js';
import { ensureOpenCodeLoaded, loadOpenCode, onOpenCodeAction, onOpenCodeInput, onOpenCodeSubmit, openCodeBodyHtml, openCodeButton } from './opencode-account.js';

const LOGIN_TEXT = {
  starting: 'Membuka halaman login di browser…',
  waiting_code: 'Selesaikan login di browser. Kalau diminta, salin kode dari halaman itu lalu tempel di sini.',
  verifying: 'Memverifikasi kode…',
  done: 'Login berhasil.',
  cancelled: 'Login dibatalkan.',
};
const account = { usage: null, loading: false, loginState: null };
/** "Riwayat perubahan akun" (laptop/Tailscale only): whether it is open, what the server last sent, its error. */
const audit = { open: false, loading: false, entries: null, error: null };

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
  if (state.accountAuth) ensureOpenCodeLoaded(renderAccountButton);
  const oc = openCodeButton();
  // Claude is the subscription; the OpenCode providers are the fallback indicator when it is not logged in.
  const claudeIn = Boolean(p?.loggedIn);
  btn.classList.toggle('logged-out', !claudeIn && !oc.loggedIn);
  if (claudeIn) {
    $('#account-avatar').textContent = accountInitial(p);
    $('#account-label').textContent = accountLabel(p);
    btn.title = `${accountLabel(p)}${p.orgName ? ` · ${p.orgName}` : ''} — profil, kuota & login`;
  } else if (oc.loggedIn && oc.label !== 'OpenCode') {
    $('#account-avatar').textContent = oc.avatar;
    $('#account-label').textContent = oc.label;
    btn.title = 'Provider OpenCode — login & daftar model';
  } else {
    $('#account-avatar').textContent = '!';
    $('#account-label').textContent = 'Belum login';
    btn.title = 'Belum login ke Claude atau provider OpenCode — klik untuk login';
  }
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

// Usage-based seats (Enterprise): no "% used" windows, only "still within the organisation's limit?" + the reset.
const BILLING_STATUS = {
  allowed: ['ok', '✅ Masih dalam batas organisasi'],
  allowed_warning: ['warn', '⚠️ Mendekati batas yang diatur admin'],
  rejected: ['bad', '⛔ Batas organisasi tercapai: minta admin menambah limit'],
};

function billingHtml(billing) {
  const [tone, text] = BILLING_STATUS[billing.status] ?? ['', 'Status muncul setelah Claude menjawab satu giliran'];
  const reset = billing.resetsAt ? new Date(billing.resetsAt * 1000).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : null;
  return `<div class="billing ${tone}"><b>${text}</b>${reset ? `<small class="muted">Periode tagihan reset ${escapeHtml(reset)}</small>` : ''}</div>
    <p class="muted small" title="Pemakaian ditagih ke organisasi dengan batas yang diatur admin, dan Claude Code tidak mengirim sisa batasnya.">Paket berbasis pemakaian (usage-based): tidak ada kuota dalam persen — pemakaian ditagih ke organisasi.</p>`;
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
export function onAccountAlert({ action, device, email, engine, provider }) {
  if (!state.local) return;
  const target = engine === 'opencode' ? `OpenCode${provider ? ` (${provider})` : ''}` : 'Claude Code';
  const text = action === 'logout' ? `HP "${device}" me-logout ${target}${email ? ` (${email})` : ''}.` : `HP "${device}" memulai login/ganti akun ${target}.`;
  toast(text, 'warn');
  chime('ask', 100); // a security alert: always full volume, whatever the 🔔 volume setting
  if ('Notification' in window && Notification.permission === 'granted') new Notification(`Adhitron: akun ${engine === 'opencode' ? 'OpenCode' : 'Claude'}`, { body: text, tag: 'account-alert' });
}

/** Laptop or a phone over Tailscale only: a plain-WiFi phone never sees the audit (the server refuses it too). */
const auditVisible = () => Boolean(state.accountAuth) && !state.readOnly;

/** The server sends an ISO time or epoch (seconds or ms); anything else is shown as a dash, never as "Invalid Date". */
function auditMs(ts) {
  const raw = typeof ts === 'number' ? ts : typeof ts === 'string' && ts.trim() ? (/^\d+$/.test(ts.trim()) ? Number(ts.trim()) : Date.parse(ts)) : NaN;
  const ms = raw < 1e11 ? raw * 1000 : raw; // epoch seconds (before 1973 in ms) vs milliseconds
  return Number.isFinite(ms) && ms <= 8.64e15 ? ms : NaN; // outside Date's range: show a dash, not "Invalid Date"
}

const AUDIT_ACTION = (action) => {
  const text = typeof action === 'string' ? action.trim().slice(0, 60) : '';
  const a = text.toLowerCase();
  if (!a) return '—';
  if (a.includes('logout') || a.includes('keluar')) return 'Keluar';
  if (a.includes('login') || a.includes('masuk')) return 'Masuk';
  return text; // a future action still shows, escaped
};

/** Only the fields the list shows, validated and newest first (the server's order is not trusted). */
function auditRows() {
  return (Array.isArray(audit.entries) ? audit.entries : [])
    .filter((e) => e && typeof e === 'object')
    .map((e) => {
      const ms = auditMs(e.ts);
      return {
        ms: Number.isFinite(ms) ? ms : 0,
        time: Number.isFinite(ms) ? new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '',
        action: AUDIT_ACTION(e.action),
        engine: typeof e.engine === 'string' ? e.engine.trim().slice(0, 40) : '',
        provider: typeof e.provider === 'string' ? e.provider.trim().slice(0, 120) : '',
        actor: typeof e.actor === 'string' ? e.actor.trim().slice(0, 120) : '',
        ok: e.ok !== false,
      };
    })
    .sort((a, b) => b.ms - a.ms);
}

function auditRowHtml(e) {
  const where = [e.engine ? engineLabel(e.engine) : '', e.provider].filter(Boolean).join(' · ');
  const actor = e.actor === 'laptop' ? 'laptop ini' : e.actor;
  return `<li class="audit-item${e.ok ? '' : ' bad'}">
    <time class="audit-when">${escapeHtml(e.time || '—')}</time>
    <div class="audit-main"><b>${escapeHtml(e.action)}</b>${where ? ` <span>${escapeHtml(where)}</span>` : ''}${e.ok ? '' : ' <span class="audit-bad">⚠ gagal</span>'}</div>
    ${actor ? `<small class="audit-actor">${escapeHtml(actor)}</small>` : ''}
  </li>`;
}

function auditBodyHtml() {
  if (audit.error) return `<p class="warn small" role="alert">${escapeHtml(audit.error)}</p>`;
  if (audit.entries === null) return '<p class="muted small">Memuat riwayat…</p>';
  const rows = auditRows();
  if (!rows.length) return '<p class="muted small">Belum ada perubahan akun.</p>';
  return `<ol class="audit-list">${rows.map(auditRowHtml).join('')}</ol>`;
}

/** A disclosure with `hidden` (not <details>: the modal Tab trap skips [hidden] content while closed). */
function auditHtml() {
  if (!auditVisible()) return '';
  return `<div class="acct-section audit-section">
    <div class="acct-title"><b>Riwayat perubahan akun</b><button type="button" class="ghost" data-act="audit-toggle" aria-expanded="${audit.open}" aria-controls="audit-body">${audit.open ? 'Tutup' : 'Lihat'}</button></div>
    <div id="audit-body"${audit.open ? '' : ' hidden'}>${audit.open ? auditBodyHtml() : ''}</div>
  </div>`;
}

async function toggleAudit() {
  audit.open = !audit.open;
  renderAccount();
  if (!audit.open) return;
  if (audit.loading) return;
  audit.loading = true;
  audit.error = null;
  audit.entries = null; // a fresh answer, never mixed with an older one
  renderAccount();
  try {
    const data = await api('/api/account/audit', { limit: 20 });
    audit.entries = Array.isArray(data?.entries) ? data.entries : [];
  } catch (err) {
    audit.entries = null;
    audit.error = err?.status === 404 ? 'Server ini belum punya riwayat perubahan akun.' : `Gagal memuat riwayat: ${err.message}`;
  } finally {
    audit.loading = false;
    if (!$('#account-modal').hidden) renderAccount();
  }
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

/**
 * Only the Claude half of the page. The quota load re-renders up to three times after the dialog opens; rebuilding the
 * whole page each time used to detach the provider buttons under the user's finger (a click racing a re-render landed
 * on nothing) and could wipe a half-filled provider form. Each source now owns its own container.
 */
function renderClaudeSection() {
  const box = $('#acct-claude');
  if (!box) return renderAccount(); // first paint: build the shell, which renders both sections
  const active = document.activeElement;
  const hadFocus = box.contains(active);
  const act = hadFocus ? active.closest('[data-act]')?.dataset.act : null;
  box.innerHTML = claudeBodyHtml();
  renderLoginFlow();
  // ↻ Cek ulang kuota rebuilds this half: keyboard focus must stay on the button (or inside the dialog), never <body>.
  if (hadFocus && !box.contains(document.activeElement)) {
    const target = (act && box.querySelector(`[data-act="${CSS.escape(act)}"]`)) || focusablesIn($('#account-modal'))[0];
    target?.focus({ preventScroll: true });
  }
  renderAuditSection();
  renderAccountButton();
}

/** Only the OpenCode providers half. `openCodeAccount`'s own rerender callback is this function. */
function renderOpenCodeSection() {
  const box = $('#acct-opencode');
  if (!box) return renderAccount();
  box.innerHTML = openCodeBodyHtml();
  renderAccountButton();
}

/** 🔒 The audit block (laptop/Tailscale only): its visibility follows the account state, which can change while open. */
function renderAuditSection() {
  const box = $('#acct-audit');
  if (box) box.innerHTML = auditHtml();
}

function renderAccountBody(body) {
  $('#account-title').textContent = '👤 Akun';
  // One page, two login sources — no "engine" selector. Claude first (the subscription), then the OpenCode
  // providers used by every non-Claude model. Each section has its own container so a background refresh of one
  // never detaches a control the user is clicking in the other.
  const note = '<div class="acct-sources-note"><b>Sumber model</b><small class="muted">Satu daftar untuk semua model yang bisa dipakai. Yang kamu pilih di Pengaturan giliran yang menentukan sumbernya.</small></div>';
  body.innerHTML = `<div id="acct-claude"></div>${note}<div id="acct-opencode"></div><div id="acct-audit">${auditHtml()}</div>`;
  renderClaudeSection();
  renderOpenCodeSection();
  renderAuditSection();
}

/** Is Claude Code switched on in the app? Off = OpenCode only; the Claude half of Akun collapses to a note. */
const claudeOn = () => state.config?.engines?.claude?.enabled !== false;

function claudeBodyHtml() {
  if (!claudeOn()) {
    return `<div class="acct-section"><div class="acct-title"><b>Claude</b><button type="button" class="ghost" data-act="claude-enable">Aktifkan</button></div>
      <p class="muted small">Claude Code <b>dinonaktifkan</b> di aplikasi ini: model Claude disembunyikan dan project yang masih memakainya diminta memilih model OpenCode. Riwayat, sesi, dan login Claude tidak dihapus — aktifkan lagi kapan saja.</p></div>`;
  }
  const p = state.account?.profile;
  if (!p) return '<p class="muted">Memeriksa akun Claude Code…</p>';
  const actions = state.accountAuth
    ? p.loggedIn
      ? `<button class="ghost" data-act="login">⇄ Ganti akun</button><button class="danger" data-act="logout">⏻ Logout</button>`
      : `<button class="primary" data-act="login">🔑 Login dengan akun Claude</button><button class="ghost" data-act="login-console">Login via Console (API)</button>`
    : '<p class="muted small" title="Buka kantor lewat alamat Tailscale, atau lakukan dari laptop.">Login/logout dari HP hanya lewat Tailscale (koneksi terenkripsi).</p>';
  if (!p.loggedIn) {
    return `<div class="acct-empty"><p>Claude Code di laptop ini <b>belum login</b>. Login membuka halaman claude.ai di browser, sama seperti <code>claude auth login</code>.</p></div>
      <div class="acct-actions">${actions}</div><div id="acct-login"></div>`;
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
    : state.account?.billing
      ? billingHtml(state.account.billing)
      : state.account?.limits?.note && !account.loading
        ? // No "% used" windows and no rate-limit status yet: show what Claude Code's /usage said.
          `<p class="quota-note">${escapeHtml(state.account.limits.note)}</p>
           <p class="muted small">Akun ini tidak melaporkan kuota dalam persen. Di atas adalah pesan asli dari <code>/usage</code>.</p>`
        : `<p class="muted small">${account.loading ? 'Mengambil kuota…' : 'Belum ada data kuota.'}</p>`;
  return `<div class="acct-head">
      <span class="avatar big">${escapeHtml(accountInitial(p))}</span>
      <div><b>${escapeHtml(accountName(p))}</b><small>${escapeHtml(p.email ?? '')}</small></div>
      ${p.subscriptionType ? `<span class="plan-badge">${escapeHtml(p.subscriptionType)}</span>` : ''}
    </div>
    <dl class="acct-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
    <div class="acct-section"><div class="acct-title"><b>Kuota paket</b><button class="ghost icon" data-act="limits" title="Cek ulang kuota">↻</button></div>${quotaHtml}</div>
    ${state.account?.loginExpiry ? `<p class="acct-warn" role="status">⚠ ${escapeHtml(state.account.loginExpiry)}</p>` : ''}
    <div class="acct-section"><div class="acct-title"><b>Pemakaian token akun ini</b><button class="ghost" data-act="report">📊 Laporan</button></div>${usageTable(account.usage)}
      <p class="muted small">Dihitung dari sesi web & CLI sejak fitur ini aktif, hanya untuk akun yang sedang login.</p></div>
    <div class="acct-actions">${actions}</div>
    <div id="acct-login"></div>
    <div class="acct-actions"><button type="button" class="ghost" data-act="claude-disable" title="OpenCode tetap jalan; data dan sesi Claude tidak dihapus">⏸ Nonaktifkan Claude Code</button></div>`;
}

async function loadAccount(force = false) {
  try {
    const data = await api('/api/account', { force });
    account.usage = data.usage;
    state.account = { ...state.account, ...data };
    renderAccountButton();
    renderClaudeSection(); // Claude only: the provider half is never rebuilt by a quota refresh
    if (!data.profile?.loggedIn) return;
    account.loading = true;
    renderClaudeSection();
    state.account.limits = await api('/api/account/limits', { force });
    checkQuota(); // a fresh `/usage` (fetched for this dialog anyway) may cross a threshold
  } catch (err) {
    toast(err.message);
  } finally {
    account.loading = false;
    if (!$('#account-modal').hidden) renderClaudeSection();
  }
}

export function onAccountState(next) {
  const prevId = accountKeyOf(state.account?.profile);
  state.account = { ...state.account, ...next };
  renderAccountButton();
  const id = accountKeyOf(next.profile);
  if (next.login?.state === 'done' && account.loginState !== 'done') toast(`Login berhasil sebagai ${next.profile?.email ?? 'akun baru'}.`, 'ok');
  if ($('#account-modal').hidden) return;
  // Never redraw over a field the user is typing in (the Claude code box or a provider form): the values are kept,
  // but the focus would jump. A login-code box is redrawn only when its state changed.
  const focused = document.activeElement;
  const typing = focused && focused !== document.body && $('#account-body').contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName);
  if (prevId !== id) return loadAccount(true); // switched account: usage & quota belong to the new one
  if ((next.login?.state ?? null) !== account.loginState) {
    if (typing) return;
    account.loginState = next.login?.state ?? null;
    return renderLoginFlow();
  }
  if (!typing) renderClaudeSection();
}

/** Loads both sources (Claude + OpenCode providers): the page shows them together. */
function loadAccountPage({ force = false } = {}) {
  loadAccount(force);
  return loadOpenCode(renderOpenCodeSection);
}

/** Open 👤 Akun (the same path as the top-bar button): used by the chat's provider-error hint too. */
export function openAccount() {
  openModal('account-modal');
  renderAccount();
  loadAccountPage();
}

export function initAccount() {
  $('#btn-account').addEventListener('click', openAccount);
  $('#account-body').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    const act = el?.dataset.act;
    if (!act) return;
    try {
      if (act === 'audit-toggle') return toggleAudit();
      if (await onOpenCodeAction(act, el, renderOpenCodeSection)) return;
      if (act === 'claude-enable' || act === 'claude-disable') {
        const on = act === 'claude-enable';
        if (!on && !window.confirm('Nonaktifkan Claude Code? Model Claude disembunyikan dan project yang memakainya perlu memilih model OpenCode. Data, sesi, dan login Claude tetap tersimpan dan bisa diaktifkan lagi kapan saja.')) return;
        const out = await api('/api/engines/claude', { enabled: on });
        if (state.config?.engines?.claude) state.config.engines.claude = { ...state.config.engines.claude, enabled: out.enabled };
        toast(out.enabled ? 'Claude Code aktif lagi — model Claude tersedia kembali.' : 'Claude Code dinonaktifkan. OpenCode tetap jalan; data Claude tidak dihapus.', 'ok');
        renderAccount();
        renderComposer(); // the model list and the ladder follow the switch
        return;
      }
      if (act === 'login' || act === 'login-console') {
        if (!window.confirm(accountImpactText('claude-login'))) return;
        state.account = { ...state.account, login: await api('/api/account/login', { console: act === 'login-console' }) };
        renderLoginFlow();
      } else if (act === 'cancel-login') {
        await api('/api/account/login/cancel');
      } else if (act === 'logout') {
        const email = state.account?.profile?.email ?? 'akun ini';
        if (!window.confirm(accountImpactText('claude-logout', email))) return;
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
        renderClaudeSection();
        state.account.limits = await api('/api/account/limits', { force: true });
        checkQuota();
        account.loading = false;
        renderClaudeSection();
      } else if (act === 'report') {
        closeModal('account-modal');
        openReport();
      }
    } catch (err) {
      account.loading = false;
      toast(err.message);
    }
  });
  for (const type of ['input', 'change']) $('#account-body').addEventListener(type, (e) => onOpenCodeInput(e, renderAccount));
  $('#account-body').addEventListener('submit', async (e) => {
    if (await onOpenCodeSubmit(e, renderAccount)) return;
    if (e.target.id !== 'login-code') return;
    e.preventDefault();
    const code = $('#login-code-input').value.trim();
    if (!code) return;
    await api('/api/account/login/code', { code }).catch((err) => toast(err.message));
  });
}
