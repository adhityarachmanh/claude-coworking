// 👤 Akun → tab OpenCode: provider logins and usage. OpenCode has no single account: every model provider
// (OpenCode Zen/Go, Anthropic, OpenAI, GitHub Copilot…) logs in on its own (API key or OAuth), the same store
// `opencode auth login|logout|list` uses (src/opencode-auth.js). The tab is information only: it never switches an
// engine (the model picked in Pengaturan giliran does that).
import { accountImpactText } from '../core/account-impact.js';
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { fmtNum, fmtShort, fmtUsd } from '../core/format.js';
import { state } from '../core/state.js';

const POLL_MS = 2000;
const POLL_LIMIT_MS = 10 * 60_000; // an OAuth attempt the user never finishes stops being watched

/** OpenCode's Akun state: providers (null = not loaded), the provider/method being logged in, a running OAuth attempt,
 *  and the ＋ Provider kustom form (custom = null while closed). */
const oc = { providers: null, loading: false, error: null, picking: false, filter: '', provider: null, method: null, attempt: null, busy: false, logoutError: null, showAllGo: false, custom: null };
let pollTimer = null;

/** The app-wide engine (config.engine; old servers: Claude Code). */
export const activeEngine = () => (state.config?.engine === 'opencode' ? 'opencode' : 'claude');

let reloading = false;
/** The server switched workspaces (this tab or another device did it): start fresh from its snapshot. */
export function reloadSoon() {
  if (reloading) return;
  reloading = true;
  setTimeout(() => location.reload(), 300);
}

// ---------- OpenCode providers ----------

/** The account button when OpenCode is the engine: how many providers are connected. */
export function openCodeButton() {
  const n = oc.providers?.connected.length;
  return { avatar: 'OC', label: n == null ? 'OpenCode' : n ? `OpenCode · ${n} provider` : 'OpenCode · belum login', loggedIn: n == null || n > 0 };
}

let triedOnce = false;
/** The account button's "· N provider" without opening Akun: one quiet load per page (laptop/Tailscale only). */
export function ensureOpenCodeLoaded(rerender) {
  if (triedOnce || !state.accountAuth) return;
  triedOnce = true;
  loadOpenCode(rerender);
}

const waitingRenders = new Set(); // everyone who asked while a load ran (the button, the open dialog)
export async function loadOpenCode(rerender) {
  waitingRenders.add(rerender);
  if (oc.loading) return;
  if (!state.accountAuth) {
    oc.error = 'Login provider OpenCode hanya dari laptop atau lewat Tailscale.';
    return rerender();
  }
  oc.loading = true;
  rerender();
  try {
    oc.providers = await api('/api/opencode/providers');
    oc.error = null;
  } catch (err) {
    oc.error = err.message;
  } finally {
    oc.loading = false;
    const renders = [...waitingRenders];
    waitingRenders.clear();
    for (const fn of renders) fn();
  }
}

const connectionHtml = (p, c) =>
  c.type === 'credential'
    ? `<li><span>${escapeHtml(c.label)} <small class="muted">${c.method === 'oauth' ? 'OAuth' : 'API key'}</small></span><button class="ghost danger-text" data-act="oc-logout" data-cred="${escapeHtml(c.id)}" data-name="${escapeHtml(p.name)}">Logout</button></li>`
    : `<li><span>${escapeHtml(c.label)} <small class="muted">variabel lingkungan</small></span><small class="muted" title="Diatur di environment Windows, bukan dari aplikasi">diatur di luar app</small></li>`;

/** Three cards for one range, plus the exact per-model table when the console provided it. */
function usageCards(label, u) {
  if (!u) return '';
  const full = `${fmtNum(u.tokens)} token · input ${fmtNum(u.inputTokens)} · output ${fmtNum(u.outputTokens)} · cache read ${fmtNum(u.cacheReadTokens)} · cache write ${fmtNum(u.cacheWriteTokens)}`;
  const models = Array.isArray(u.models) ? u.models : [];
  const rows = models
    .map((m) => `<tr><td>${escapeHtml(m.model)}${m.provider ? `<small class="muted"> ${escapeHtml(m.provider)}</small>` : ''}</td><td>${fmtNum(m.requests)}</td><td>${fmtShort(m.inputTokens)}</td><td>${fmtShort(m.cacheReadTokens)}</td><td>${m.cacheWriteTokens ? fmtShort(m.cacheWriteTokens) : '—'}</td><td>${fmtShort(m.outputTokens)}</td><td>${fmtUsd(m.costUsd)}</td></tr>`)
    .join('');
  return `<b class="oc-usage-period">${escapeHtml(label)}</b>
    <div class="oc-usage-grid">
      <div><small>Biaya</small><b>${fmtUsd(u.costUsd)}</b><span>estimasi provider</span></div>
      <div><small>Request</small><b>${fmtNum(u.requests)}</b><span>API request</span></div>
      <div><small>Token</small><b title="${escapeHtml(full)}">${fmtShort(u.tokens)}</b><span title="${escapeHtml(full)}">input + output + cache</span></div>
    </div>
    ${rows ? `<details class="oc-usage-models"><summary>Rincian per model (${models.length})</summary><div class="oc-usage-scroll"><table class="usage-table"><thead><tr><th>Model</th><th>Request</th><th>Input</th><th>Cache read</th><th>Cache write</th><th>Output</th><th>Biaya</th></tr></thead><tbody>${rows}</tbody></table></div></details>` : ''}`;
}

/** Official OpenCode usage (usage/summary); falls back to the local ledger cards when it is unavailable. */
function usageHtml() {
  const go = oc.providers?.go;
  const usage = go?.console?.usage;
  if (usage && (usage.today || usage.week)) {
    const fetched = go.console?.fetchedAt ? new Date(go.console.fetchedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="acct-section oc-usage"><div class="acct-title"><b>Pemakaian OpenCode</b><span class="badge">Data resmi OpenCode</span></div>
      <p class="muted small">Dari OpenCode Console${fetched ? ` · diperbarui ${escapeHtml(fetched)}` : ''}. Angka provider, bukan perkiraan ledger. Data diambil memakai kredensial login OpenCode; token tidak disimpan di aplikasi dan tidak dikirim ke browser.</p>
      ${usageCards('Hari ini', usage.today)}
      ${usageCards('7 hari', usage.week)}
      <div class="acct-actions"><button type="button" class="ghost" data-oc-requests title="Lihat request OpenCode terbaru">📡 Request terbaru</button></div>
      <div id="account-requests" class="acct-requests" hidden>
        <div class="acct-requests-head"><b>📡 Request terbaru</b><button type="button" class="icon-btn" data-request-close title="Tutup request" aria-label="Tutup request">✕</button></div>
        <p id="account-requests-meta" class="muted small" aria-live="polite"></p>
        <div class="requests-table-wrap">
          <table class="usage-table requests-table">
            <thead><tr><th>Waktu</th><th>Model</th><th>App</th><th>Durasi</th><th>TTFT</th><th>Token</th><th>Biaya</th><th>Status</th></tr></thead>
            <tbody id="account-requests-list"></tbody>
          </table>
        </div>
        <div class="requests-actions"><button type="button" id="account-requests-more" class="ghost" data-request-more hidden>Muat lebih banyak</button></div>
        <p class="muted small">Tanpa isi prompt, header, atau lokasi. Token OpenCode Console tidak dikirim ke browser.</p>
      </div>
    </div>`;
  }
  return localUsageHtml();
}

/** Token/cost rows recorded for OpenCode (web turns + terminal mirror); the fallback when console usage is unavailable. */
function localUsageHtml() {
  const u = oc.providers?.usage;
  if (!u) return '';
  const cost = (x) => (x.costUsd == null ? 'biaya belum tersedia' : fmtUsd(x.costUsd));
  const coverage = u.week.costCoverage;
  return `<div class="acct-section oc-usage"><div class="acct-title"><b>Pemakaian lokal OpenCode</b></div>
    <p class="muted small">Dari sesi web dan terminal OpenCode yang tercatat di aplikasi. Angka ini pemakaian lokal, bukan batas langganan; data kuota resmi provider ditampilkan terpisah bila tersedia.</p>
    <div class="oc-usage-grid">
      <div><small>Hari ini</small><b>${fmtShort(u.today.total)} token</b><span>${cost(u.today)}</span></div>
      <div><small>7 hari</small><b>${fmtShort(u.week.total)} token</b><span>${cost(u.week)}</span></div>
    </div>
    ${coverage > 0 && coverage < 1 ? `<p class="muted small">Biaya tercatat untuk ${Math.round(coverage * 100)}% pemakaian; sisanya provider tidak memberi biaya.</p>` : ''}
  </div>`;
}

// ---------- OpenCode Go quota ----------
// The server estimates usage from recorded tokens × list prices and compares it to the Go plan's official allowance
// (5h = 20% of the monthly limit, 7d = 50%, 30d = 100%); limits are per model, so the numbers are an estimate, never
// a provider quota. The ratios are derived from used/limit here instead of the payload's `percent*` fields: the same
// numbers, but independent of whether those fields carry a 0..1 ratio or a 0..100 percentage. Every field is
// re-validated: a bad payload must degrade, not print "NaN"/"undefined".

/** The three official Go windows, in row order, with each window's share of the monthly limit. */
const GO_WINDOWS = [
  { key: '5h', label: '5 jam', share: 0.2 },
  { key: '7d', label: '7 hari', share: 0.5 },
  { key: '30d', label: '30 hari', share: 1 },
];
const GO_ROWS = 8; // the list stays short; "Tampilkan semua" reveals the rest
// The server validates the same ids; the price only fills the tooltip (the note says it in full).
const GO_PLAN_OPTIONS = [
  { id: 'go', label: 'Go', price: '$10/bulan' },
  { id: 'plus', label: 'Go Plus', price: '$40/bulan' },
  { id: 'teams', label: 'Go Teams', price: '$20/anggota/bulan' },
];

const goNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const goTone = (ratio) => (ratio > 0.9 ? 'bad' : ratio >= 0.7 ? 'warn' : 'ok');

/** One model row: a name, a monthly used/limit pair and the three ratios (0..1+), computed from what was spent. */
function goRow(m) {
  if (!m || typeof m !== 'object') return null;
  const model = typeof m.model === 'string' ? m.model.trim().slice(0, 120) : '';
  if (!model) return null;
  const limit = goNumber(m.limit);
  const unlimited = m.unlimited === true; // a free model: nothing to spend (no limit to show)
  const used30d = goNumber(m.used30d);
  const remaining = goNumber(m.remaining) ?? (limit != null && limit > 0 && used30d != null ? Math.max(0, limit - used30d) : null);
  const windows = GO_WINDOWS.map((w) => {
    const used = goNumber(m[`used${w.key}`]) ?? 0;
    return { label: w.label, ratio: limit != null && limit > 0 ? Math.max(0, used / (limit * w.share)) : 0 };
  });
  return { model, unlimited, limit, used30d, remaining, windows };
}

function goWindowHtml(row, w) {
  const pct = Math.round(w.ratio * 100);
  const width = Math.round(Math.min(100, w.ratio * 100));
  const label = `${row.model} · ${w.label} · ${pct}%`;
  return `<div class="oc-go-win">
      <span class="oc-go-win-label">${w.label}</span>
      <div class="bar oc-go-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, pct)}" aria-valuetext="${pct}%" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i class="${goTone(w.ratio)}" style="width:${width}%"></i></div>
      <b class="oc-go-pct">${pct}%</b>
    </div>`;
}

function goRowHtml(row) {
  const used = fmtUsd(row.used30d);
  const money = row.unlimited
    ? `terpakai ${used} / tak terbatas · sisa tak terbatas`
    : row.limit == null
      ? `terpakai ${used} / batas belum diketahui`
      : `terpakai ${used} / ${fmtUsd(row.limit)} · sisa ${fmtUsd(row.remaining)}`;
  return `<li class="oc-go-row">
    <div class="oc-go-head"><b class="oc-go-model">${escapeHtml(row.model)}</b><span class="oc-go-money">${escapeHtml(money)}</span></div>
    <div class="oc-go-wins">${row.windows.map((w) => goWindowHtml(row, w)).join('')}</div>
  </li>`;
}

/** "30 Nov 2026, 14.05" for a console timestamp (local time). */
function dateText(iso) {
  if (typeof iso !== 'string') return '';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const PLAN_LABEL = Object.fromEntries(GO_PLAN_OPTIONS.map((p) => [p.id, p.label]));

/** "2 jam 35 mnt" / "6 hari 22 jam" from the console's reset timestamp. */
function resetIn(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'Reset tidak diketahui';
  const ms = at - Date.now();
  if (ms <= 0) return 'Reset sedang berlangsung';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `Reset dalam ${days} hari ${hours} jam`;
  if (hours) return `Reset dalam ${hours} jam ${minutes} mnt`;
  return `Reset dalam ${Math.max(1, minutes)} mnt`;
}

const consoleLabel = (key, fallback) => ({ fiveHour: 'Rolling', week: 'Weekly', month: 'Monthly' })[key] ?? fallback;

/** One console meter in the same shape as OpenCode's account page: name, reset countdown, bar, percentage. */
function consoleMeterHtml(m) {
  const pct = m.percent == null ? null : Math.round(m.percent * 100);
  const width = pct == null ? 0 : Math.round(Math.min(100, pct));
  const label = consoleLabel(m.key, m.label);
  const reset = resetIn(m.resetsAt);
  const text = `${label}: ${pct == null ? 'persentase tidak diketahui' : `${pct}% terpakai`}, ${reset}`;
  return `<div class="oc-go-meter">
    <div class="oc-go-meter-main"><b>${escapeHtml(label)}</b><small>${escapeHtml(reset)}</small></div>
    <div class="bar oc-go-bar oc-go-meter-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct == null ? 0 : Math.min(100, pct)}" aria-valuetext="${escapeHtml(text)}" aria-label="${escapeHtml(text)}" title="${escapeHtml(text)}"><i class="${pct != null && pct > 90 ? 'bad' : pct != null && pct >= 70 ? 'warn' : 'ok'}" style="width:${width}%"></i></div>
    <b class="oc-go-meter-pct">${pct == null ? '—' : `${pct}%`}</b>
  </div>`;
}

/** Exact data from OpenCode Console, in the same three-bar shape as the provider's account page. */
function consoleQuotaHtml(go) {
  const c = go.console;
  const plan = PLAN_LABEL[go.plan] ?? c.product ?? 'OpenCode Go';
  const renewal = dateText(c.activeUntil || c.meters?.find?.((m) => m.key === 'month')?.resetsAt);
  const meters = (Array.isArray(c.meters) ? c.meters : []).map(consoleMeterHtml).join('');
  return `<div class="acct-section oc-go"><div class="acct-title"><b>Kuota OpenCode Go</b><span class="badge">Data resmi OpenCode</span></div>
    <div class="oc-go-plan-line"><b>${escapeHtml(plan)}</b>${renewal ? `<span class="muted small">Perpanjangan ${escapeHtml(renewal.split(',')[0])}</span>` : ''}</div>
    <div class="oc-go-console">${meters}</div>
    <p class="muted small oc-go-source">Sumber: OpenCode Console${c.fetchedAt ? ` · diperbarui ${escapeHtml(new Date(c.fetchedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }))}` : ''}.</p>
  </div>`;
}

/** The old estimated rows, reused inside the console panel and as the fallback when console is unavailable. */
function estimateRowsHtml(estimate) {
  const rows = (Array.isArray(estimate?.models) ? estimate.models : []).map(goRow).filter(Boolean);
  if (!rows.length) return '<p class="muted small">Belum ada pemakaian OpenCode Go yang tercatat.</p>';
  const visible = oc.showAllGo ? rows : rows.slice(0, GO_ROWS);
  return `<ul class="oc-go-list" id="oc-go-models">${visible.map(goRowHtml).join('')}</ul>
    ${rows.length > GO_ROWS ? `<button type="button" class="ghost oc-go-toggle" data-act="oc-go-all" aria-expanded="${oc.showAllGo}" aria-controls="oc-go-models">${oc.showAllGo ? 'Tampilkan lebih sedikit' : `Tampilkan semua (${rows.length})`}</button>` : ''}`;
}

/** "Kuota OpenCode Go": exact console data when available, otherwise the local estimate. */
function goQuotaHtml() {
  const go = oc.providers?.go;
  if (!go || typeof go !== 'object' || go.available === false) return '';
  if (go.source === 'console' && go.console) return consoleQuotaHtml(go);
  const estimate = go.estimate ?? go;
  const plan = GO_PLAN_OPTIONS.some((p) => p.id === go.plan) ? go.plan : 'go';
  const planButtons = GO_PLAN_OPTIONS.map(
    (p) => `<button type="button" class="engine-opt${p.id === plan ? ' on' : ''}" data-act="oc-go-plan" data-plan="${p.id}" aria-pressed="${p.id === plan}" title="${escapeHtml(`Paket ${p.label}: ${p.price}`)}"${state.accountAuth ? '' : ' disabled'}>${escapeHtml(p.label)}</button>`,
  ).join('');
  const note = typeof go.note === 'string' && go.note.trim() ? go.note : 'Perkiraan dari pemakaian yang tercatat × harga list model.';
  return `<div class="acct-section oc-go"><div class="acct-title"><b>Kuota OpenCode Go</b></div>
    <div class="engine-opts oc-go-plan" role="group" aria-label="Paket OpenCode Go"><span class="muted small">Paket</span>${planButtons}</div>
    <p class="muted small oc-go-note">${escapeHtml(note)}</p>
    ${estimateRowsHtml(estimate)}</div>`;
}

function connectedHtml() {
  if (oc.error && !oc.providers) return `<p class="warn">${escapeHtml(oc.error)}</p>`;
  if (!oc.providers) return '<p class="muted small">Memeriksa provider OpenCode…</p>';
  const list = oc.providers.connected;
  if (!list.length) return '<p>OpenCode <b>belum login</b> ke provider mana pun. Tanpa provider OpenCode tidak bisa menjawab: login minimal satu di bawah.</p>';
  return `<ul class="oc-providers">${list
    .map((p) => `<li class="oc-provider"><b>${escapeHtml(p.name)}</b> <small class="muted">${escapeHtml(p.id)}</small><ul class="oc-conns">${p.connections.map((c) => connectionHtml(p, c)).join('')}</ul></li>`)
    .join('')}</ul>`;
}

/** Fields of a login method's form (Azure resource, GitHub Enterprise URL…), shown when their `when` holds. */
function formFields(method, answers) {
  return method.form
    .filter((f) => !f.hidden)
    .filter((f) => !f.when || f.when.every((w) => (w.op === 'eq' ? answers[w.key] === w.value : answers[w.key] !== w.value)))
    .map((f) => {
      const id = escapeHtml(`oc-f-${f.key}`);
      const value = answers[f.key] ?? f.default ?? '';
      const input = f.options
        ? `<select id="${id}" data-field="${escapeHtml(f.key)}">${f.options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`
        : `<input id="${id}" data-field="${escapeHtml(f.key)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(f.placeholder)}" autocomplete="off" spellcheck="false"${f.required ? ' required' : ''} />`;
      return `<label class="oc-field" for="${id}"><span>${escapeHtml(f.title)}${f.required ? ' *' : ''}</span>${input}</label>`;
    })
    .join('');
}

function readAnswers(method) {
  const answers = {};
  for (const f of method.form) if (f.hidden && f.default) answers[f.key] = String(f.default);
  for (const el of document.querySelectorAll('#oc-login [data-field]')) if (el.value.trim()) answers[el.dataset.field] = el.value.trim();
  return answers;
}

function loginHtml() {
  if (!oc.providers || !state.accountAuth) return '';
  if (oc.attempt) {
    const a = oc.attempt;
    return `<div id="oc-login" class="login-flow">
      <p>Login <b>${escapeHtml(oc.provider.name)}</b>: ${escapeHtml(a.instructions || 'selesaikan login di browser.')}</p>
      ${a.url ? `<a class="primary link-btn" href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">🔑 Buka halaman login</a>` : ''}
      ${a.mode === 'code' ? `<form id="oc-code" class="login-code"><input id="oc-code-input" placeholder="Tempel kode dari browser" aria-label="Kode login" autocomplete="off" spellcheck="false" /><button class="primary"${oc.busy ? ' disabled' : ''}>Kirim</button></form>` : '<p class="muted small"><span class="spinner"></span> Menunggu login selesai…</p>'}
      <button type="button" class="ghost" data-act="oc-cancel">Batal</button></div>`;
  }
  if (oc.custom) return customLoginHtml();
  if (!oc.picking)
    return '<div class="acct-actions"><button class="primary" data-act="oc-pick">＋ Login provider</button><button type="button" class="ghost" data-act="oc-custom">＋ Provider kustom</button></div>';
  const q = oc.filter.toLowerCase();
  const matches = oc.providers.available.filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q));
  const p = oc.provider;
  const method = oc.method;
  const methodPicker = p
    ? p.methods.length > 1
      ? `<div class="oc-methods" role="group" aria-label="Metode login">${p.methods.map((m) => `<button type="button" class="engine-opt${m === method ? ' on' : ''}" data-act="oc-method" data-method="${escapeHtml(m.id)}">${escapeHtml(m.type === 'oauth' ? `🔑 ${m.label}` : `🗝️ ${m.label}`)}</button>`).join('')}</div>`
      : ''
    : '';
  const form = method
    ? `<form id="oc-login-form" class="oc-form">${formFields(method, oc.answers ?? {})}
        ${method.type === 'key' ? `<label class="oc-field" for="oc-key"><span>API key *</span><input id="oc-key" type="password" autocomplete="off" spellcheck="false" required placeholder="Tempel API key ${escapeHtml(p.name)}" /></label>` : ''}
        <button class="primary"${oc.busy ? ' disabled' : ''}>${method.type === 'key' ? 'Simpan API key' : 'Mulai login'}</button></form>`
    : '';
  return `<div id="oc-login" class="login-flow">
    <label class="oc-field" for="oc-filter"><span>Provider</span><input id="oc-filter" value="${escapeHtml(oc.filter)}" placeholder="Cari: OpenCode, Anthropic, OpenAI, Copilot…" autocomplete="off" spellcheck="false" /></label>
    <select id="oc-provider" size="6" aria-label="Pilih provider">${matches.slice(0, 200).map((m) => `<option value="${escapeHtml(m.id)}"${m.id === p?.id ? ' selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}</select>
    ${methodPicker}${form}
    <p class="muted small">Disimpan oleh OpenCode di laptop ini (sama seperti <code>opencode auth login</code>). API key tidak dicatat di log aplikasi.</p>
    <button type="button" class="ghost" data-act="oc-close">Tutup</button></div>`;
}

// ---------- ＋ Provider kustom: any OpenAI-style base URL + key, into OpenCode's own auth store ----------

/** Light client guards only (the server validates for real); plain HTTP stays allowed for loopback dev endpoints. */
const CUSTOM_ID_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const CUSTOM_URL_RE = /^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$))/i;

/** The check answer as checkbox rows: `["id"]` and `[{ id, name }]` entries both, capped like the provider picker. */
function normalizeCustomModels(data) {
  return (Array.isArray(data?.models) ? data.models : [])
    .map((m) => (typeof m === 'string' ? { id: m.trim(), name: m.trim() } : { id: String(m?.id ?? '').trim(), name: String(m?.name ?? m?.id ?? '').trim() }))
    .filter((m) => m.id)
    .slice(0, 200);
}

function customLoginHtml() {
  const c = oc.custom;
  const models = c.models ?? [];
  return `<div id="oc-login" class="login-flow">
    <form id="oc-custom-form" class="oc-form">
      <label class="oc-field" for="oc-custom-id"><span>ID *</span><input id="oc-custom-id" data-custom="id" value="${escapeHtml(c.form.id)}" placeholder="river" autocomplete="off" spellcheck="false" required /><small class="muted">huruf/angka, - . _</small></label>
      <label class="oc-field" for="oc-custom-name"><span>Nama tampilan *</span><input id="oc-custom-name" data-custom="name" value="${escapeHtml(c.form.name)}" placeholder="River AI" autocomplete="off" spellcheck="false" required /></label>
      <label class="oc-field" for="oc-custom-base"><span>Base URL *</span><input id="oc-custom-base" data-custom="baseURL" value="${escapeHtml(c.form.baseURL)}" placeholder="https://api.river.ai/v1" autocomplete="off" spellcheck="false" required /></label>
      <label class="oc-field" for="oc-custom-key"><span>API key *</span><input id="oc-custom-key" type="password" data-custom="key" value="${escapeHtml(c.form.key)}" placeholder="Tempel API key" autocomplete="off" spellcheck="false" required /></label>
      <button type="button" class="ghost" data-act="oc-check"${c.checking ? ' disabled' : ''}>${c.checking ? 'Memeriksa…' : 'Cek model'}</button>
      ${c.checkError ? `<p class="warn small" role="alert">${escapeHtml(c.checkError)}</p>` : ''}
      ${c.models ? (models.length ? `<div class="oc-custom-models"><small class="muted">${models.length} model ditemukan</small>${models
        .map((m) => `<label class="oc-custom-model"><input type="checkbox" name="oc-custom-model" value="${escapeHtml(m.id)}"${c.picked.has(m.id) ? ' checked' : ''} /> <span>${escapeHtml(m.name)}</span><small class="muted">${escapeHtml(m.id)}</small></label>`)
        .join('')}</div>` : '<p class="muted small">Tidak ada model ditemukan. Periksa base URL dan API key.</p>') : ''}
      <button class="primary"${oc.busy ? ' disabled' : ''}>Simpan provider</button>
    </form>
    <p class="muted small">Provider apa pun dengan API ala OpenAI: OpenCode menyimpan API key-nya di laptop ini, sama seperti login provider resmi.</p>
    <button type="button" class="ghost" data-act="oc-close">Tutup</button></div>`;
}

/** Akun's body for OpenCode. */
export function openCodeBodyHtml() {
  return `${usageHtml()}${goQuotaHtml()}<div class="acct-section"><div class="acct-title"><b>Provider OpenCode</b><button class="ghost icon" data-act="oc-refresh" title="Cek ulang">↻</button></div>
    ${connectedHtml()}${oc.error && oc.providers ? `<p class="warn small">${escapeHtml(oc.error)}</p>` : ''}
    ${oc.logoutError ? `<p class="warn small" role="alert">${escapeHtml(oc.logoutError)}</p>` : ''}
    <p class="muted small">Provider ini dipakai saat model project berasal dari OpenCode. Project yang memakai model Claude Code memakai akun Claude (tab Claude), bukan provider di sini. Tab ini hanya informasi: tidak mengubah mesin project.</p></div>
    ${state.accountAuth ? loginHtml() : '<p class="muted small">Login/logout provider dari HP hanya lewat Tailscale (koneksi terenkripsi), atau lakukan dari laptop.</p>'}`;
}

const stopPolling = () => {
  clearTimeout(pollTimer);
  pollTimer = null;
};

function poll(rerender, started = Date.now()) {
  stopPolling();
  pollTimer = setTimeout(async () => {
    const a = oc.attempt;
    if (!a) return;
    try {
      const st = await api('/api/opencode/login/status', { provider: oc.provider.id, attemptID: a.attemptID });
      if (oc.attempt !== a) return;
      if (st.status === 'complete') return finishLogin(rerender, `Login ${oc.provider.name} berhasil.`);
      if (st.status === 'failed' || st.status === 'expired') {
        oc.attempt = null;
        toast(st.status === 'expired' ? 'Waktu login habis. Coba lagi.' : `Login gagal: ${st.message || 'ditolak'}`, 'warn');
        return rerender();
      }
    } catch (err) {
      if (oc.attempt !== a) return;
      oc.attempt = null;
      toast(`Login gagal: ${err.message}`, 'warn');
      return rerender();
    }
    if (Date.now() - started < POLL_LIMIT_MS) poll(rerender, started);
    else {
      api('/api/opencode/login/cancel', { provider: oc.provider.id, attemptID: a.attemptID }).catch(() => {});
      oc.attempt = null;
      toast('Login tidak selesai dalam 10 menit: dibatalkan.', 'warn');
      rerender();
    }
  }, POLL_MS);
}

function finishLogin(rerender, message) {
  stopPolling();
  Object.assign(oc, { attempt: null, picking: false, provider: null, method: null, answers: null, filter: '', busy: false });
  toast(message, 'ok');
  loadOpenCode(rerender);
}

/** Clicks inside Akun's body; returns true when it handled `act`. */
export async function onOpenCodeAction(act, el, rerender) {
  switch (act) {
    case 'oc-refresh':
      oc.logoutError = null;
      await loadOpenCode(rerender);
      return true;
    case 'oc-go-all':
      oc.showAllGo = !oc.showAllGo;
      rerender();
      return true;
    case 'oc-go-plan': {
      const plan = el.dataset.plan;
      if (!plan || plan === (oc.providers?.go?.plan ?? 'go')) return true;
      try {
        await api('/api/account/go-plan', { plan });
        await loadOpenCode(rerender);
      } catch (err) {
        toast(err.message, 'warn');
      }
      return true;
    }
    case 'oc-pick':
      oc.picking = true;
      rerender();
      $('#oc-filter')?.focus();
      return true;
    case 'oc-custom': {
      // A blank form, kept in memory so no rerender (a running check, a failed save) drops what was typed.
      Object.assign(oc, {
        picking: false,
        provider: null,
        method: null,
        answers: null,
        filter: '',
        custom: { form: { id: '', name: '', baseURL: '', key: '' }, checking: false, checkError: null, models: null, picked: new Set() },
      });
      rerender();
      $('#oc-custom-id')?.focus();
      return true;
    }
    case 'oc-check': {
      const c = oc.custom;
      if (!c || c.checking) return true;
      const baseURL = c.form.baseURL.trim();
      if (!CUSTOM_URL_RE.test(baseURL)) {
        c.checkError = 'Base URL harus mulai https:// atau http://localhost/127.0.0.1/[::1].';
        rerender();
        return true;
      }
      c.checking = true;
      c.checkError = null;
      rerender();
      try {
        c.models = normalizeCustomModels(await api('/api/opencode/custom/check', { baseURL, key: c.form.key.trim() }));
        c.picked = new Set(c.models.map((m) => m.id)); // everything pre-ticked; unticks survive a rerender
      } catch (err) {
        c.checkError = err.data?.error ?? err.message; // inline next to the button; the form keeps its values
      } finally {
        c.checking = false;
        rerender();
      }
      return true;
    }
    case 'oc-close':
      Object.assign(oc, { picking: false, provider: null, method: null, answers: null, filter: '', custom: null });
      rerender();
      return true;
    case 'oc-method':
      oc.method = oc.provider?.methods.find((m) => m.id === el.dataset.method) ?? null;
      oc.answers = {};
      rerender();
      return true;
    case 'oc-cancel': {
      const a = oc.attempt;
      stopPolling();
      oc.attempt = null;
      rerender();
      if (a) await api('/api/opencode/login/cancel', { provider: oc.provider.id, attemptID: a.attemptID }).catch(() => {});
      return true;
    }
    case 'oc-logout': {
      const name = el.dataset.name;
      const credentialID = el.dataset.cred;
      if (!credentialID) return true; // never send a logout without the credential it targets
      if (!window.confirm(accountImpactText('opencode-logout', name))) return true;
      oc.logoutError = null;
      try {
        // The server demands the confirmation word: a stray tap must not sign the laptop out.
        await api('/api/opencode/logout', { credentialID, confirm: 'LOGOUT' });
      } catch (err) {
        oc.logoutError = err.data?.error ?? err.message; // inline, next to the provider list
        rerender();
        return true;
      }
      toast(`Sudah logout dari ${name}.`, 'ok');
      await loadOpenCode(rerender);
      return true;
    }
    default:
      return false;
  }
}

/** Typing/choosing inside the login panel (no full rerender while the user types an API key). */
export function onOpenCodeInput(e, rerender) {
  // ＋ Provider kustom: typed fields and model ticks live in `oc.custom`, so no rerender loses them.
  if (oc.custom && e.target.dataset?.custom) {
    oc.custom.form[e.target.dataset.custom] = e.target.value;
    return true;
  }
  if (oc.custom && e.target.name === 'oc-custom-model') {
    oc.custom.picked ??= new Set((oc.custom.models ?? []).map((m) => m.id));
    if (e.target.checked) oc.custom.picked.add(e.target.value);
    else oc.custom.picked.delete(e.target.value);
    return true;
  }
  if (e.target.id === 'oc-filter') {
    oc.filter = e.target.value;
    const q = oc.filter.toLowerCase();
    const sel = $('#oc-provider');
    const matches = oc.providers.available.filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.includes(q));
    sel.innerHTML = matches.slice(0, 200).map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    return true;
  }
  if (e.target.id === 'oc-provider' && e.type === 'change') {
    oc.provider = oc.providers.available.find((p) => p.id === e.target.value) ?? null;
    oc.method = oc.provider?.methods.length === 1 ? oc.provider.methods[0] : (oc.provider?.methods.find((m) => m.type === 'oauth') ?? oc.provider?.methods[0] ?? null);
    oc.answers = {};
    rerender();
    return true;
  }
  if (e.target.dataset?.field && e.type === 'change' && oc.method?.form.some((f) => f.when)) {
    oc.answers = readAnswers(oc.method); // a choice can reveal another field (GitHub Enterprise URL)
    const key = $('#oc-key')?.value ?? ''; // typed API key survives the redraw
    rerender();
    if (key && $('#oc-key')) $('#oc-key').value = key;
    return true;
  }
  return false;
}

/** ＋ Provider kustom's submit: light client checks (the server validates for real), then /api/opencode/custom/add. */
async function submitCustom(rerender) {
  const c = oc.custom;
  if (!c) return true;
  const id = c.form.id.trim();
  const name = c.form.name.trim();
  const baseURL = c.form.baseURL.trim();
  const key = c.form.key.trim();
  const fail = (message) => toast(`Gagal: ${message}`, 'warn');
  if (!id || !name || !baseURL || !key) {
    fail('lengkapi ID, nama tampilan, base URL, dan API key.');
    return true;
  }
  if (!CUSTOM_ID_RE.test(id)) {
    fail('ID hanya boleh huruf, angka, titik, strip, dan garis bawah.');
    return true;
  }
  const models = [...document.querySelectorAll('#oc-custom-form input[name="oc-custom-model"]:checked')].map((b) => b.value);
  if (!models.length) {
    fail('pilih minimal satu model.');
    return true;
  }
  oc.busy = true;
  try {
    await api('/api/opencode/custom/add', { id, name, baseURL, key, models });
    oc.custom = null;
    toast(`Provider kustom ${name} tersimpan. API key disimpan ke OpenCode.`, 'ok');
    loadOpenCode(rerender);
  } catch (err) {
    toast(`Gagal: ${err.data?.error ?? err.message}`, 'warn'); // nothing cleared: fix and retry
  } finally {
    oc.busy = false;
  }
  return true;
}

/** Submits of the key form / OAuth start / OAuth code / custom provider. */
export async function onOpenCodeSubmit(e, rerender) {
  if (!['oc-login-form', 'oc-code', 'oc-custom-form'].includes(e.target.id)) return false;
  e.preventDefault();
  if (oc.busy) return true;
  if (e.target.id === 'oc-custom-form') return submitCustom(rerender);
  oc.busy = true;
  try {
    if (e.target.id === 'oc-code') {
      const code = $('#oc-code-input').value.trim();
      if (!code) return true;
      await api('/api/opencode/login/code', { provider: oc.provider.id, attemptID: oc.attempt.attemptID, code });
      finishLogin(rerender, `Login ${oc.provider.name} berhasil.`);
      return true;
    }
    const method = oc.method;
    const answer = readAnswers(method);
    if (method.type === 'key') {
      const key = $('#oc-key').value.trim();
      if (!key) return true;
      await api('/api/opencode/login/key', { provider: oc.provider.id, key, answer });
      $('#oc-key').value = '';
      finishLogin(rerender, `API key ${oc.provider.name} tersimpan.`);
    } else {
      oc.attempt = await api('/api/opencode/login/oauth', { provider: oc.provider.id, methodID: method.id, answer });
      if (oc.attempt.url) window.open(oc.attempt.url, '_blank', 'noopener');
      rerender();
      poll(rerender);
    }
  } catch (err) {
    toast(`Login gagal: ${err.data?.error ?? err.message}`, 'warn');
  } finally {
    oc.busy = false;
  }
  return true;
}

/** The dialog closed: an OAuth attempt still waiting keeps going (the user may be in the browser). */
export const openCodeProvidersLoaded = () => oc.providers != null;
