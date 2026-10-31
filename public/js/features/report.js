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

const startOfDay = (ts) => new Date(ts).setHours(0, 0, 0, 0);
const fmtDay = (ts, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(ts).toLocaleDateString('id-ID', opts);
const capitalize = (s) => s[0].toUpperCase() + s.slice(1);
const reportAccount = () => report.accounts.find((a) => a.id === $('#report-account').value) ?? null;

function reportRange() {
  const now = Date.now();
  const today = startOfDay(now);
  if (report.period === 'today') return { from: today, to: now };
  if (report.period === 'month') return { from: new Date(today).setDate(1), to: now };
  // "Semua" starts at this account's first record, so the chart doesn't begin in 1970.
  if (report.period === 'all') return { from: reportAccount()?.first ?? 0, to: now };
  if (report.period === 'custom') {
    const from = $('#report-from').valueAsDate;
    const to = $('#report-to').valueAsDate;
    // <input type=date> gives UTC midnight: shift to local day bounds.
    const local = (d) => d.getTime() + d.getTimezoneOffset() * 60_000;
    return { from: from ? local(from) : (reportAccount()?.first ?? 0), to: to ? local(to) + DAY - 1 : now };
  }
  return { from: today - (Number(report.period) - 1) * DAY, to: now };
}

function reportQuery() {
  return { accountId: $('#report-account').value, groupBy: report.unit, ...reportRange() };
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
    select.innerHTML = accounts.length
      ? accounts.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.email)}${a.org ? ` — ${escapeHtml(a.org)}` : ''}${a.id === current ? ' (aktif)' : ''}</option>`).join('')
      : '<option value="">Belum ada data</option>';
    // The logged-in account may have no usage yet: only pick an account that is in the list.
    select.value = [keep, current, accounts[0]?.id].find((id) => accounts.some((a) => a.id === id)) ?? '';
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
  const first = reportAccount()?.first;
  const note = $('#report-note');
  note.hidden = !(first && startOfDay(first) > range.from);
  if (!note.hidden) note.innerHTML = `ℹ Pencatatan token akun ini baru dimulai <b>${escapeHtml(fmtDay(first))}</b>. Sebelum tanggal itu grafik kosong karena belum tercatat, bukan karena tidak dipakai.`;
}

function renderReportKpis(t, records) {
  const main = [
    ['Total token', fmtShort(t.total)],
    ['Output', fmtShort(t.output)],
    ['Cache hit', `${Math.round(t.cacheHitRate * 100)}%`],
    ['Estimasi biaya', fmtUsd(t.costUsd)],
  ];
  $('#report-kpis').innerHTML = main.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
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
  $('#report-chart-caption').textContent = `${periods.length} ${name} · ${used.length} ada pemakaian · tertinggi ${fmtShort(max)} token per ${name}. ${capitalize(name)} tanpa pemakaian tidak masuk tabel.`;
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
    .map((m) => `<tr><td>${escapeHtml(m.key ?? '-')}</td><td>${fmtShort(m.input)}</td><td>${fmtShort(m.output)}</td><td>${fmtShort(m.cacheRead)}</td><td><b>${fmtShort(m.total)}</b></td></tr>`)
    .join('');
  $('#report-models').innerHTML = `<table class="usage-table"><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Footer line next to the PDF button: exactly what the PDF will contain. */
function renderReportScope(q, range) {
  const scope = $('#report-scope');
  if (!q.accountId) return void (scope.textContent = '');
  const account = $('#report-account').selectedOptions[0]?.textContent.replace(/ \(aktif\)$/, '') ?? '';
  scope.innerHTML = `PDF berisi persis yang tampil di atas: <b>${escapeHtml(account)}</b> · <b>${escapeHtml(rangeText(range))}</b> · per <b>${UNIT_NAME[q.groupBy]}</b>. Ditambah rincian per project, sumber (web/CLI) dan sesi teratas.`;
}

async function previewReport() {
  const range = reportRange();
  syncUnits(range);
  const q = reportQuery();
  $('#report-range').textContent = `📅 ${rangeText(range)}${report.period === 'all' && range.from ? ' (sejak catatan pertama)' : ''}`;
  renderReportNote(range);
  renderReportScope(q, range);
  if (!q.accountId) {
    showReportMessage('Belum ada pemakaian yang tercatat. Data mulai dikumpulkan sejak fitur ini aktif.');
    $('#report-pdf').disabled = true;
    return;
  }
  const seq = ++report.seq; // a slow answer must not overwrite a newer choice
  const box = $('#report-preview');
  box.classList.add('loading');
  try {
    const s = await api('/api/report/summary', q);
    if (seq !== report.seq) return;
    $('#report-pdf').disabled = false;
    if (!s.records) return showReportMessage('Tidak ada pemakaian di periode ini untuk akun tersebut.');
    showReportMessage(null);
    report.last = s;
    renderReportKpis(s.totals, s.records);
    renderTrend(s);
    renderReportModels(s.byModel);
  } catch (err) {
    if (seq === report.seq) showReportMessage(err.message, true);
  } finally {
    if (seq === report.seq) box.classList.remove('loading');
  }
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
}
