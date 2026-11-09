// Token usage report per account: preview, chart, PDF.
import { api, toast } from '../core/api.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { DAY, fmtNum, fmtShort, fmtUsd } from '../core/format.js';
import { auth } from '../core/state.js';
import { saveBlob } from '../core/util.js';
import { openModal } from '../ui/modals.js';

const UNIT_NAME = { day: 'hari', week: 'minggu', month: 'bulan' };
// What the dialog shows; the preview and the PDF always use this same state.
const report = { period: '7', unit: 'day', accounts: [], seq: 0, last: null, allRows: false };
const REPORT_ROWS = 7; // newest periods shown before "Tampilkan semua"
// A scope, not an account: one report with every account (Claude + OpenCode), so "Per mesin" can show both engines.
const ALL_ACCOUNTS = 'all';
const ALL_SCOPE = 'Semua akun · Claude + OpenCode';

const startOfDay = (ts) => new Date(ts).setHours(0, 0, 0, 0);
const fmtDay = (ts, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(ts).toLocaleDateString('id-ID', opts);
const capitalize = (s) => s[0].toUpperCase() + s.slice(1);
const selectedAccountId = () => $('#report-account').value;
const isAllAccounts = () => selectedAccountId() === ALL_ACCOUNTS;
const reportAccount = () => report.accounts.find((a) => a.id === selectedAccountId()) ?? null;

/** First record of the selection: the account's own, or the oldest across accounts for "Semua akun". */
function reportFirst() {
  if (!isAllAccounts()) return reportAccount()?.first ?? 0;
  const firsts = report.accounts.map((a) => a.first).filter((t) => Number.isFinite(t));
  return firsts.length ? Math.min(...firsts) : 0;
}

function reportRange() {
  const now = Date.now();
  const today = startOfDay(now);
  if (report.period === 'today') return { from: today, to: now };
  if (report.period === 'month') return { from: new Date(today).setDate(1), to: now };
  // "Semua" starts at the first record of the selection, so the chart doesn't begin in 1970.
  if (report.period === 'all') return { from: reportFirst(), to: now };
  if (report.period === 'custom') {
    const from = $('#report-from').valueAsDate;
    const to = $('#report-to').valueAsDate;
    // <input type=date> gives UTC midnight: shift to local day bounds.
    const local = (d) => d.getTime() + d.getTimezoneOffset() * 60_000;
    return { from: from ? local(from) : reportFirst(), to: to ? local(to) + DAY - 1 : now };
  }
  return { from: today - (Number(report.period) - 1) * DAY, to: now };
}

function reportQuery() {
  return { accountId: selectedAccountId(), groupBy: report.unit, ...reportRange() };
}

// Same calendar rules as src/usage.js (periodStart/nextPeriod): local day, Monday week, calendar month.
function periodStartOf(ts, unit) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (unit === 'month') d.setDate(1);
  return d.getTime();
}

function nextPeriodOf(start, unit) {
  const d = new Date(start);
  if (unit === 'month') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + (unit === 'week' ? 7 : 1));
  return d.getTime();
}

/** How many days/weeks/months the range touches (capped; only "one" vs "many" really matters). */
function bucketCount({ from, to }, unit) {
  let n = 0;
  for (let s = periodStartOf(from || to, unit); s <= to && n < 500; s = nextPeriodOf(s, unit)) n++;
  return n;
}

/** The natural granularity for a range: days up to a month, then weeks, then months. */
function naturalUnit(range) {
  const days = bucketCount(range, 'day');
  return days <= 31 ? 'day' : days <= 180 ? 'week' : 'month';
}

/**
 * Week/month only make sense when the range spans at least two of them (otherwise they'd just
 * repeat the totals), so those buttons are disabled with the reason in their tooltip.
 */
function syncUnits(range) {
  const counts = Object.fromEntries(Object.keys(UNIT_NAME).map((u) => [u, bucketCount(range, u)]));
  const usable = (u) => u === 'day' || counts[u] >= 2;
  if (!usable(report.unit)) report.unit = naturalUnit(range);
  for (const btn of document.querySelectorAll('#report-units [data-unit]')) {
    const u = btn.dataset.unit;
    btn.disabled = !usable(u);
    btn.title = btn.disabled ? `Periode ini masih di dalam 1 ${UNIT_NAME[u]}` : `${counts[u]} ${UNIT_NAME[u]}`;
    btn.classList.toggle('active', u === report.unit);
    btn.setAttribute('aria-pressed', String(u === report.unit));
  }
}

function choosePeriod(period) {
  report.period = period;
  for (const btn of document.querySelectorAll('#report-periods [data-period]')) {
    btn.classList.toggle('active', btn.dataset.period === period);
    btn.setAttribute('aria-pressed', String(btn.dataset.period === period));
  }
  $('#report-modal .custom-range').hidden = period !== 'custom';
  if (period === 'custom' && !$('#report-from').value) {
    const iso = (ms) => new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    $('#report-from').value = iso(Date.now() - 6 * DAY);
    $('#report-to').value = iso(Date.now());
  }
  // A new period gets a sensible grain: "Semua" per hari could be hundreds of bars.
  const range = reportRange();
  if (bucketCount(range, report.unit) > 62) report.unit = naturalUnit(range);
  previewReport();
}

/** "25 Okt 2026 – 31 Okt 2026 · 7 hari" (or one day for "Hari ini"). */
function rangeText(range) {
  if (!range.from) return 'Semua data';
  if (startOfDay(range.from) === startOfDay(range.to)) return fmtDay(range.from, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `${fmtDay(range.from)} – ${fmtDay(range.to)} · ${bucketCount(range, 'day')} hari`;
}

export async function openReport() {
  openModal('report-modal');
  showReportMessage('Memuat…');
  try {
    const { accounts, current } = await api('/api/report/accounts');
    report.accounts = accounts;
    const select = $('#report-account');
    const keep = select.value;
    // "Semua akun" is always available: a report with Claude + OpenCode together, also before any usage exists.
    select.innerHTML =
      `<option value="${ALL_ACCOUNTS}">Semua akun (Claude + OpenCode)</option>` +
      (accounts.length
        ? accounts.map((a, i) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.email ?? `Akun Claude ${i + 1}`)}${a.org ? ` — ${escapeHtml(a.org)}` : ''}${a.id === current ? ' (aktif)' : ''}</option>`).join('')
        : '<option value="">Belum ada data</option>');
    // The logged-in account may have no usage yet: only pick an account that is in the list (default: the current one).
    select.value = [keep, current, accounts[0]?.id].find((id) => id === ALL_ACCOUNTS || accounts.some((a) => a.id === id)) ?? '';
    choosePeriod(report.period);
  } catch (err) {
    showReportMessage(err.message, true);
  }
}

/** Same labels as the PDF: "Sab, 31 Okt 2026", "26 Okt – 1 Nov 2026", "Oktober 2026". */
function periodLabel({ start, end }, unit) {
  if (unit === 'month') return fmtDay(start, { month: 'long', year: 'numeric' });
  if (unit === 'week' && startOfDay(start) !== startOfDay(end)) return `${fmtDay(start, { day: 'numeric', month: 'short' })} – ${fmtDay(end)}`;
  return fmtDay(start, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Short tick under a bar: "31/10" for a day or week start, "Okt" for a month. */
function tickLabel({ start }, unit) {
  const d = new Date(start);
  return unit === 'month' ? fmtDay(start, { month: 'short' }) : `${d.getDate()}/${d.getMonth() + 1}`;
}

/** A message instead of the preview body (loading, no data, error); null shows the body again. */
function showReportMessage(message, isError = false) {
  const box = $('#report-empty');
  box.hidden = !message;
  box.textContent = message ?? '';
  box.className = isError ? 'warn' : 'muted';
  $('#report-body').hidden = Boolean(message);
}

/** Says why the start of the chart is empty: the ledger only exists since the feature was turned on. */
function renderReportNote(range) {
  const first = reportFirst();
  const note = $('#report-note');
  note.hidden = !(first && startOfDay(first) > range.from);
  if (note.hidden) return;
  // "Semua akun" has no single start: the note then explains the earliest record of the selection.
  const start = isAllAccounts()
    ? `Catatan terlama dimulai <b>${escapeHtml(fmtDay(first))}</b>`
    : `Pencatatan token akun ini baru dimulai <b>${escapeHtml(fmtDay(first))}</b>`;
  note.innerHTML = `ℹ ${start}. Sebelum tanggal itu grafik kosong karena belum tercatat, bukan karena tidak dipakai.`;
}

/** "vs the previous, equally long period": token and cost deltas in percent (hidden without a previous period). */
function renderReportCompare(previous, current = {}) {
  const box = $('#report-compare');
  if (!box) return;
  const before = previous && Number.isFinite(previous.total) ? previous : null;
  if (!before || !before.total) {
    box.hidden = true;
    return;
  }
  const delta = (now, old) => (old > 0 ? Math.round(((now - old) / old) * 100) : null);
  const parts = [];
  const tokens = delta(current.total ?? 0, before.total);
  if (tokens != null) parts.push(`token ${tokens >= 0 ? '+' : ''}${tokens}%`);
  if (current.costUsd != null && before.costUsd != null) {
    const cost = delta(current.costUsd, before.costUsd);
    if (cost != null) parts.push(`biaya ${cost >= 0 ? '+' : ''}${cost}%`);
  }
  box.textContent = parts.length ? `Dibanding periode sebelumnya (sama panjang): ${parts.join(' · ')}.` : '';
  box.hidden = !parts.length;
}

function renderReportKpis(t, records) {
  // Only part of the records may carry a cost: the estimate would otherwise look like the whole bill.
  // The hint stays inside the same card (a 5th card would change the 4×1 / 2×2 layout).
  const coverage = Number.isFinite(t.costCoverage) ? Math.min(1, Math.max(0, t.costCoverage)) : null;
  const costHint = coverage == null || coverage >= 1 ? '' : coverage ? `${Math.floor(coverage * 100)}% catatan punya biaya` : 'belum ada biaya tercatat';
  const main = [
    ['Total token', fmtShort(t.total), ''],
    ['Output', fmtShort(t.output), ''],
    ['Cache hit', `${Math.round(t.cacheHitRate * 100)}%`, ''],
    ['Estimasi biaya', fmtUsd(t.costUsd), costHint],
  ];
  $('#report-kpis').innerHTML = main
    .map(([k, v, hint]) => `<div><small>${k}</small><b>${v}</b>${hint ? `<span class="kpi-hint">${hint}</span>` : ''}</div>`)
    .join('');
  $('#report-kpi-more').textContent = `Input ${fmtShort(t.input)} · Cache read ${fmtShort(t.cacheRead)} · Cache write ${fmtShort(t.cacheWrite)} · ${fmtNum(t.requests)} request API · ${fmtNum(records)} catatan`;
}

/** One bar per day/week/month (empty ones included, so gaps show) + the periods with usage, newest first. */
function renderTrend(s) {
  const unit = s.groupBy;
  const name = UNIT_NAME[unit];
  const periods = s.byPeriod ?? [];
  const max = periods.reduce((m, p) => Math.max(m, p.total), 1);
  const every = Math.ceil(periods.length / (narrow.matches ? 6 : 12)); // ticks counted back from the newest bar
  $('#report-chart').innerHTML = periods
    .map((p, i) => {
      const tip = `${periodLabel(p, unit)}: ${p.total ? `${fmtShort(p.total)} token` : 'tidak ada pemakaian'}`;
      const tick = (periods.length - 1 - i) % every === 0 ? tickLabel(p, unit) : '';
      const height = p.total ? Math.max(4, (p.total / max) * 100) : 0;
      return `<div class="tb${p.total ? '' : ' zero'}" title="${escapeHtml(tip)}"><div class="tb-col"><i style="height:${height.toFixed(1)}%"></i></div><small>${escapeHtml(tick)}</small></div>`;
    })
    .join('');
  const used = periods.filter((p) => p.total);
  $('#report-chart-caption').textContent = `${periods.length} ${name} · ${used.length} terpakai · tertinggi ${fmtShort(max)} token/${name}.`;
  const newest = [...used].reverse();
  const rows = (report.allRows ? newest : newest.slice(0, REPORT_ROWS))
    .map((p) => `<tr><td>${escapeHtml(periodLabel(p, unit))}</td><td>${fmtShort(p.input)}</td><td>${fmtShort(p.output)}</td><td>${fmtShort(p.cacheRead)}</td><td><b>${fmtShort(p.total)}</b></td><td>${fmtUsd(p.costUsd)}</td></tr>`)
    .join('');
  const more = newest.length > REPORT_ROWS
    ? `<button type="button" class="text-btn" data-act="all-rows">${report.allRows ? 'Tampilkan lebih sedikit' : `Tampilkan semua ${newest.length} ${name}`}</button>`
    : '';
  $('#report-period-table').innerHTML = `<table class="usage-table"><thead><tr><th>${capitalize(name)}</th><th>Input</th><th>Output</th><th>Cache read</th><th>Total</th><th>Biaya</th></tr></thead><tbody>${rows}</tbody></table>${more}`;
}

function renderReportModels(byModel) {
  const rows = byModel
    .slice(0, 5)
    .map((m) => `<tr><td>${escapeHtml(m.key ?? '-')}</td><td>${fmtShort(m.input)}</td><td>${fmtShort(m.output)}</td><td>${fmtShort(m.cacheRead)}</td><td><b>${fmtShort(m.total)}</b></td><td>${engineCostText(m)}</td></tr>`)
    .join('');
  $('#report-models').innerHTML = `<table class="usage-table"><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Total</th><th>Biaya</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** 🧩 Per role (estimate) below the models; a server without byRole (or no transcript) hides the block. */
function renderReportRoles(byRole) {
  const box = $('#report-roles');
  if (!box) return;
  const roles = Array.isArray(byRole?.roles) ? byRole.roles.filter((r) => Number(r?.tokens) > 0) : [];
  if (!roles.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const total = Number(byRole.totalTokens) || roles.reduce((n, r) => n + (Number(r.tokens) || 0), 0);
  const coverage = byRole.coverage
    ? `<p class="muted small">Cakupan: ${Math.round((Number(byRole.coverage.percent) || 0) * 100)}% token (${fmtNum(byRole.coverage.sessionsWithTranscript ?? 0)} dari ${fmtNum(byRole.coverage.sessions ?? 0)} sesi) punya rincian role. "OpenCode (tanpa rincian role)" dan "Tanpa rincian role" mencakup sesi yang tidak ditemukan di store OpenCode atau transcript Claude.</p>`
    : '';
  const rows = roles
    .slice(0, 12)
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.label ?? r.role ?? '-')}</td><td><b>${fmtShort(r.tokens)}</b></td><td>${reportShare(r.tokens, total)}</td><td>${engineCostText(r)}</td><td>${fmtNum(r.delegations ?? 0)}</td></tr>`,
    )
    .join('');
  box.innerHTML = `<h4 class="report-sub">Per role <span class="muted">(perkiraan)</span></h4>
    ${coverage}
    <table class="usage-table"><thead><tr><th>Role</th><th>Token</th><th>%</th><th>Biaya</th><th>Delegasi</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted small">${escapeHtml(byRole.note ?? '')}</p>`;
  box.hidden = false;
}

// "Per mesin" labels: the same words as the PDF (the data keys stay claude/opencode, web/cli).
const ENGINE_LABEL = { claude: 'Claude', opencode: 'OpenCode' };
const SOURCE_LABEL = { web: 'Web', cli: 'Terminal' };
const UNKNOWN_LABEL = 'Tidak diketahui';
const ENGINE_ORDER = ['claude:web', 'claude:cli', 'opencode:web', 'opencode:cli'];

/** Share of the report total: "50%", and "<1%" instead of a 0% that would read as nothing. */
function reportShare(part, whole) {
  if (!(whole > 0)) return '—';
  const pct = ((Number(part) || 0) / whole) * 100;
  if (pct <= 0) return '0%';
  return `${pct < 1 ? '&lt;1' : Math.round(pct)}%`;
}

/** Same cost rules as the PDF: "—" without a cost, plus "(N%)" when only part of the records has one. */
function engineCostText({ costUsd, costCoverage }) {
  if (costUsd == null && !costCoverage) return '— (belum ada biaya)';
  const usd = fmtUsd(costUsd);
  return Number.isFinite(costCoverage) && costCoverage < 1 ? `${usd} (${Math.floor(costCoverage * 100)}%)` : usd;
}

/**
 * "Per mesin" below the models: one row per engine × source (4 at most), from `byEngineSource`.
 * Rows with `records: 0` are dropped (a summary without `records` falls back to `total > 0`), a fixed
 * order keeps the labels from jumping between periods, and a server that doesn't send `byEngineSource`
 * at all hides the block. Requests/turns stay out on purpose: they are only recorded on one surface
 * each, so a per-engine split would look like missing data.
 */
function renderReportEngines(rows, total) {
  let box = $('#report-engines');
  if (!box) {
    // The dialog markup is static: the block is created next to the model list the first time it renders.
    box = document.createElement('div');
    box.id = 'report-engines';
    $('#report-models').after(box);
  }
  const list = (Array.isArray(rows) ? rows : [])
    .map((r, i) => {
      const [keyEngine, keySource] = String(r.key ?? '').split(':');
      const engine = r.engine ?? keyEngine;
      const source = r.source ?? keySource;
      const order = ENGINE_ORDER.indexOf(`${engine}:${source}`);
      return {
        i,
        label: `${ENGINE_LABEL[engine] ?? UNKNOWN_LABEL} · ${SOURCE_LABEL[source] ?? UNKNOWN_LABEL}`,
        order: order === -1 ? ENGINE_ORDER.length : order,
        total: r.total,
        costUsd: r.costUsd,
        costCoverage: r.costCoverage,
        used: r.records == null ? Number(r.total) > 0 : Number(r.records) > 0,
      };
    })
    .filter((r) => r.used)
    .sort((a, b) => a.order - b.order || a.i - b.i);
  box.hidden = !list.length;
  if (!list.length) {
    box.innerHTML = '';
    return;
  }
  const body = list
    .map((r) => `<tr><td>${escapeHtml(r.label)}</td><td><b>${fmtShort(r.total)}</b></td><td>${reportShare(r.total, total)}</td><td>${escapeHtml(engineCostText(r))}</td></tr>`)
    .join('');
  box.innerHTML = `<h4 class="report-sub">Per mesin</h4><table class="usage-table"><thead><tr><th>Mesin · sumber</th><th>Total</th><th>%</th><th>Biaya</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** OpenCode Go provider data (account-wide, official console). Hidden when the report has none. */
function renderReportProvider(go) {
  const box = $('#report-provider');
  if (!box) return;
  if (!go || typeof go !== 'object') {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const plan = { go: 'Go', plus: 'Go Plus', teams: 'Go Teams' }[go.plan] ?? go.product ?? 'OpenCode Go';
  const active = go.activeUntil ? new Date(go.activeUntil).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const meters = (Array.isArray(go.meters) ? go.meters : [])
    .map((m) => {
      const percent = m.percent == null ? null : Math.min(100, Math.round(m.percent * 1000) / 10);
      return `<tr><td>${escapeHtml(m.label)}</td><td>${fmtUsd(m.usedUsd)} / ${fmtUsd(m.limitUsd)}</td><td>${percent == null ? '—' : `${percent}%`}</td><td>${escapeHtml(m.resetsAt ? new Date(m.resetsAt).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')}</td></tr>`;
    })
    .join('');
  const totals = go.totals ?? { costUsd: 0, tokens: 0, requests: 0 };
  const daily = Array.isArray(go.daily) ? go.daily : [];
  const dailyRows = daily
    .map((d) => `<tr><td>${escapeHtml(d.date)}</td><td>${fmtUsd(d.costUsd)}</td><td>${fmtShort(d.tokens)}</td><td>${fmtNum(d.requests)}</td></tr>`)
    .join('');
  const models = (Array.isArray(go.models) ? go.models : []).slice(0, 20);
  const modelRows = models.map((m) => `<tr><td>${escapeHtml(m.model)}</td><td>${fmtNum(m.requests)}</td></tr>`).join('');
  const sessions = Array.isArray(go.sessions) ? go.sessions : [];
  const sessionRows = sessions
    .map((s) => `<tr><td>${escapeHtml(s.project ?? '-')} · ${escapeHtml(String(s.sessionId ?? '').slice(0, 8))}</td><td>${fmtNum(s.requests)}</td><td>${fmtShort(s.tokens)}</td><td>${fmtUsd(s.costUsd)}${s.truncated ? ' (sebagian)' : ''}</td></tr>`)
    .join('');
  box.hidden = false;
  box.innerHTML = `<h4 class="report-sub">OpenCode Go — data provider</h4>
    <p class="muted small"><b>${escapeHtml(plan)}</b>${active ? ` · aktif sampai ${escapeHtml(active)}` : ''} · sumber: OpenCode Console</p>
    ${meters ? `<table class="usage-table"><thead><tr><th>Jendela</th><th>Terpakai / batas</th><th>%</th><th>Reset</th></tr></thead><tbody>${meters}</tbody></table>` : ''}
    <p class="muted small">Periode ${daily.length ? `${escapeHtml(daily[0].date)} — ${escapeHtml(daily.at(-1).date)}` : 'tanpa aktivitas'}: <b>${fmtUsd(totals.costUsd)}</b> · ${fmtShort(totals.tokens)} token · ${fmtNum(totals.requests)} request.</p>
    ${dailyRows ? `<details class="report-provider-daily"><summary>Pemakaian harian (${daily.length})</summary><table class="usage-table"><thead><tr><th>Tanggal</th><th>Biaya</th><th>Token</th><th>Request</th></tr></thead><tbody>${dailyRows}</tbody></table></details>` : ''}
    ${modelRows ? `<details class="report-provider-daily"><summary>Model (${models.length})</summary><table class="usage-table"><thead><tr><th>Model</th><th>Request</th></tr></thead><tbody>${modelRows}</tbody></table></details>` : ''}
    ${sessionRows ? `<details class="report-provider-daily"><summary>Sesi teratas (${sessions.length})</summary><table class="usage-table"><thead><tr><th>Project · sesi</th><th>Request</th><th>Token</th><th>Biaya provider</th></tr></thead><tbody>${sessionRows}</tbody></table><p class="muted small">Dari awal periode sampai sekarang, maksimal 5 sesi OpenCode; “sebagian” berarti pagination terpotong.</p></details>` : ''}
    <p class="muted small">Data provider mencakup seluruh pemakaian akun OpenCode, termasuk perangkat lain; tidak dijumlahkan ke tabel per project/role.</p>`;
}

/** Footer line next to the PDF button: exactly what the PDF will contain. */
function renderReportScope(q, range) {
  const scope = $('#report-scope');
  if (!q.accountId) return void (scope.textContent = '');
  const all = q.accountId === ALL_ACCOUNTS;
  const account = $('#report-account').selectedOptions[0]?.textContent.replace(/ \(aktif\)$/, '') ?? '';
  // "Semua akun" has no email to show: the scope names both engines instead.
  const who = all ? `<b>Semua akun</b> · <b>Claude + OpenCode</b>` : `<b>${escapeHtml(account)}</b>`;
  scope.innerHTML = `PDF berisi persis yang tampil di atas: ${who} · <b>${escapeHtml(rangeText(range))}</b> · per <b>${UNIT_NAME[q.groupBy]}</b>. Ditambah rincian per mesin, per project, sumber (web/CLI) dan sesi teratas.`;
  if (all || q.accountId === 'opencode') scope.innerHTML += ' <span class="muted">Pemakaian lokal OpenCode (web + terminal); bagian OpenCode Go memakai data provider bila tersedia.</span>';
}

async function previewReport() {
  const range = reportRange();
  syncUnits(range);
  const q = reportQuery();
  // The scope above the preview: for "Semua akun" it replaces the email with both engines.
  const scopeName = isAllAccounts() ? `${ALL_SCOPE} · ` : '';
  const perUnit = isAllAccounts() ? ` · per ${UNIT_NAME[report.unit]}` : '';
  $('#report-range').textContent = `📅 ${scopeName}${rangeText(range)}${perUnit}${report.period === 'all' && range.from ? ' (sejak catatan pertama)' : ''}`;
  renderReportNote(range);
  renderReportScope(q, range);
  if (!q.accountId) {
    showReportMessage('Belum ada pemakaian yang tercatat. Data mulai dikumpulkan sejak fitur ini aktif.');
    $('#report-pdf').disabled = true;
    $('#report-csv').disabled = true;
    return;
  }
  const seq = ++report.seq; // a slow answer must not overwrite a newer choice
  const box = $('#report-preview');
  box.classList.add('loading');
  try {
    const s = await api('/api/report/summary', q);
    if (seq !== report.seq) return;
    $('#report-pdf').disabled = false;
    $('#report-csv').disabled = false;
    if (!s.records) return showReportMessage('Tidak ada pemakaian di periode ini untuk akun tersebut.');
    showReportMessage(null);
    report.last = s;
    renderReportKpis(s.totals, s.records);
    renderReportCompare(s.previous, s.totals);
    renderTrend(s);
    renderReportModels(s.byModel);
    renderReportEngines(s.byEngineSource, s.totals?.total ?? 0);
    renderReportRoles(s.byRole);
    renderReportProvider(s.opencodeGo);
  } catch (err) {
    if (seq === report.seq) showReportMessage(err.message, true);
  } finally {
    if (seq === report.seq) box.classList.remove('loading');
  }
}

/** One CSV field: quoted when needed, and never allowed to start a spreadsheet formula. */
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** ⬇ CSV: the same per-period numbers, for a spreadsheet (BOM so Excel reads the Indonesian commas). */
function downloadCsv() {
  const s = report.last;
  if (!s) return;
  const periods = (s.byPeriod ?? []).filter((p) => p.total);
  const head = ['Periode', 'Input', 'Output', 'Cache read', 'Total token', 'Biaya USD'];
  const meta = [
    ['Laporan', 'Adhitron'],
    ['Dari', new Date(s.from).toLocaleString('id-ID')],
    ['Sampai', new Date(s.to).toLocaleString('id-ID')],
    ['Total token', s.totals?.total ?? 0],
    ['Estimasi biaya USD', s.totals?.costUsd == null ? '' : s.totals.costUsd.toFixed(6)],
  ];
  const lines = [
    ...meta.map((r) => r.map(csvCell).join(',')),
    '',
    head.map(csvCell).join(','),
    ...periods.map((p) => [periodLabel(p, s.groupBy), p.input, p.output, p.cacheRead, p.total, p.costUsd == null ? '' : p.costUsd.toFixed(6)].map(csvCell).join(',')),
  ];
  // 🧩 The same per-role estimate the preview/PDF show, at the end of the spreadsheet.
  const roles = Array.isArray(s.byRole?.roles) ? s.byRole.roles.filter((r) => Number(r.tokens) > 0) : [];
  if (roles.length) {
    lines.push('', ['Per role (perkiraan)', 'Token', '%', 'Biaya USD', 'Delegasi'].map(csvCell).join(','));
    for (const r of roles) {
      lines.push([r.label ?? r.role ?? '', r.tokens ?? 0, r.share == null ? '' : (r.share * 100).toFixed(1), r.costUsd == null ? '' : Number(r.costUsd).toFixed(6), r.delegations ?? 0].map(csvCell).join(','));
    }
  }
  // OpenCode Go provider data (account-wide; never mixed into the ledger rows above).
  const go = s.opencodeGo;
  if (go && typeof go === 'object') {
    lines.push('', ['OpenCode Go (data provider)', 'Nilai'].map(csvCell).join(','));
    lines.push([`Paket ${go.plan ?? go.product ?? 'OpenCode Go'}`, go.activeUntil ? `aktif sampai ${go.activeUntil}` : ''].map(csvCell).join(','));
    for (const m of Array.isArray(go.meters) ? go.meters : []) {
      lines.push([`Kuota ${m.label}`, `${m.usedUsd ?? ''} / ${m.limitUsd ?? ''}`, m.percent == null ? '' : `${(m.percent * 100).toFixed(1)}%`, m.resetsAt ?? ''].map(csvCell).join(','));
    }
    lines.push(['Total biaya provider USD', (go.totals?.costUsd ?? 0).toFixed(6), 'Token', go.totals?.tokens ?? 0, 'Request', go.totals?.requests ?? 0].map(csvCell).join(','));
    for (const d of Array.isArray(go.daily) ? go.daily : []) lines.push([d.date, d.costUsd ?? 0, d.tokens ?? 0, d.requests ?? 0].map(csvCell).join(','));
    for (const m of Array.isArray(go.models) ? go.models : []) lines.push([`Model ${m.model}`, '', '', m.requests ?? 0].map(csvCell).join(','));
    for (const s of Array.isArray(go.sessions) ? go.sessions : []) {
      lines.push([`Sesi ${s.project ?? '-'} · ${String(s.sessionId ?? '').slice(0, 8)}`, s.costUsd ?? 0, s.tokens ?? 0, s.requests ?? 0].map(csvCell).join(','));
    }
  }
  const name = `laporan-token-${new Date(s.from).toLocaleDateString('sv-SE')}-${new Date(s.to).toLocaleDateString('sv-SE')}.csv`;
  saveBlob(name, new Blob([`\uFEFF${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }));
}

async function downloadReport() {
  const btn = $('#report-pdf');
  btn.disabled = true;
  btn.textContent = 'Membuat PDF…';
  try {
    const res = await fetch('/api/report/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Office-Token': auth.token },
      body: JSON.stringify(reportQuery()),
    });
    if (res.ok) {
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'laporan-token.pdf';
      saveBlob(name, await res.blob());
      toast('PDF diunduh.', 'ok');
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 501 && data.html) {
      // No Edge/Chrome for headless printing: let the browser print the same report.
      const win = window.open('', '_blank');
      if (!win) throw new Error('Pop-up diblokir — izinkan pop-up untuk mencetak laporan.');
      win.document.write(data.html);
      win.document.close();
      win.addEventListener('load', () => win.print());
      return;
    }
    throw new Error(data.error ?? `HTTP ${res.status}`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇ Unduh PDF';
  }
}

export function initReport() {
  $('#btn-report').addEventListener('click', openReport);
  $('#report-account').addEventListener('change', previewReport);
  $('#report-periods').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-period]');
    if (btn) choosePeriod(btn.dataset.period);
  });
  $('#report-units').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-unit]');
    if (!btn || btn.disabled || btn.dataset.unit === report.unit) return;
    report.unit = btn.dataset.unit;
    previewReport();
  });
  $('#report-period-table').addEventListener('click', (e) => {
    if (!e.target.closest('[data-act="all-rows"]') || !report.last) return;
    report.allRows = !report.allRows;
    renderTrend(report.last);
  });
  for (const id of ['#report-from', '#report-to']) $(id).addEventListener('change', previewReport);
  $('#report-pdf').addEventListener('click', downloadReport);
  $('#report-csv').addEventListener('click', downloadCsv);
}
