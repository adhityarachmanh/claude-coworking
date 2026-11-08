// 🩺 "Kesehatan sistem" (⚙ → Sistem): one report of the server's own checks, the first-run checklist, the size of
// the app data and the errors of the last 24 hours. POST /api/health is a laptop/Tailscale route (a plain-WiFi
// phone is refused), so its opener is hidden there and opening the dialog is guarded here too.
// No polling: one request when the dialog opens (and one per ↻). The last good report stays in memory, so
// reopening shows it at once and refreshes in the background; every field from the server is validated and escaped.
import { api, canCall } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { engineLabel } from '../core/engine-caps.js';
import { state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { budgetHealthHtml, loadBudgetView } from './budget.js';
import { downloadDiagnostics } from './diagnostics.js';

const PATH = '/api/health';
const MAX_TEXT = 300; // one line of a check/detail/hint
const MAX_LAST = 240; // the last error is truncated: a stack trace must not push the dialog around
const NUM = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });

/** Last good report (memory only), whether a request is in flight, and the inline error that keeps the old report. */
const health = { report: null, loading: false, error: null };

const text = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);

/** Only the fields the dialog shows, the way it shows them (the server's answer is not trusted). */
export function normalizeHealth(raw) {
  const r = raw && typeof raw === 'object' ? raw : null;
  if (!r) return null;
  const app = r.app && typeof r.app === 'object' ? r.app : {};
  const errors = r.errors && typeof r.errors === 'object' ? r.errors : {};
  const data = r.data && typeof r.data === 'object' ? r.data : {};
  return {
    app: {
      version: text(app.version, 40),
      engine: text(app.engine, 30),
      uptimeSec: num(app.uptimeSec),
      port: num(app.port),
      pid: num(app.pid),
    },
    checks: (Array.isArray(r.checks) ? r.checks : [])
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        id: text(c.id, 60),
        label: text(c.label, 160) || text(c.id, 60) || 'Pemeriksaan',
        ok: c.ok === true,
        warn: c.ok !== true && c.warn === true,
        // A check only counts against "Siap dipakai" unless the server says it is a nice-to-have.
        essential: c.essential !== false,
        detail: text(c.detail),
        hint: text(c.hint),
      })),
    checklist: (Array.isArray(r.checklist) ? r.checklist : [])
      .filter((c) => c && typeof c === 'object')
      .map((c) => ({
        id: text(c.id, 60),
        label: text(c.label, 160) || text(c.id, 60) || 'Langkah',
        done: c.done === true,
        hint: text(c.hint),
      })),
    errors: { count24h: num(errors.count24h), last: text(errors.last, 600) },
    data: { bytes: num(data.bytes), files: num(data.files), dir: text(data.dir) },
  };
}

/** `Siap dipakai (5/6)` when enough of the checklist is done and no essential check fails; else `Perlu perhatian`. */
export function healthSummary(report) {
  const checks = report?.checks ?? [];
  const checklist = report?.checklist ?? [];
  const done = checklist.filter((c) => c.done).length;
  // "At least 4 done" — or all of them when the checklist is shorter than that.
  const enough = done >= Math.min(4, checklist.length);
  const blocking = checks.some((c) => !c.ok && !c.warn && c.essential !== false);
  return { ready: enough && !blocking, done, total: checklist.length };
}

/** 12,3 MB (1024-based, Indonesian decimal comma); "512 B" under 1 KB. */
export function fmtBytes(bytes) {
  const n = num(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  if (i === 0) return `${NUM.format(value)} ${units[i]}`;
  return `${NUM.format(Math.round(value * 10) / 10)} ${units[i]}`;
}

/** "45 dtk", "12 mnt", "3 jam 5 mnt", "2 hari 3 jam". */
export function fmtUptime(seconds) {
  const s = num(seconds);
  if (s < 60) return `${s} dtk`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} mnt`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam ${m % 60} mnt`;
  return `${Math.floor(h / 24)} hari ${h % 24} jam`;
}

const TONE = (c) => (c.ok ? 'ok' : c.warn ? 'warn' : 'bad');
const TONE_TEXT = { ok: 'lulus', warn: 'peringatan', bad: 'gagal' };

function checkHtml(c) {
  const tone = TONE(c);
  return `<li class="health-check ${tone}">
    <span class="health-dot" aria-hidden="true"></span>
    <div class="health-check-main">
      <b>${escapeHtml(c.label)}</b>
      ${c.detail ? `<span class="health-detail">${escapeHtml(c.detail)}</span>` : ''}
      ${c.hint ? `<small class="muted">${escapeHtml(c.hint)}</small>` : ''}
    </div>
    <span class="sr-only">${TONE_TEXT[tone]}</span>
  </li>`;
}

function todoHtml(item) {
  return `<li class="health-todo${item.done ? ' done' : ''}">
    <span class="health-mark" aria-hidden="true">${item.done ? '✓' : '○'}</span>
    <div><b>${escapeHtml(item.label)}</b>${item.hint ? `<small class="muted">${escapeHtml(item.hint)}</small>` : ''}</div>
    <span class="sr-only">${item.done ? 'selesai' : 'belum selesai'}</span>
  </li>`;
}

function metaLine(app) {
  const parts = [];
  if (app.version) parts.push(`v${app.version}`);
  parts.push(engineLabel(app.engine || 'claude'));
  parts.push(`aktif ${fmtUptime(app.uptimeSec)}`);
  if (app.port) parts.push(`port ${app.port}`);
  return parts.map(escapeHtml).join(' · ');
}

function reportHtml(report) {
  const summary = healthSummary(report);
  const checks = report.checks.length ? `<ul class="health-checks">${report.checks.map(checkHtml).join('')}</ul>` : '<p class="muted small">Tidak ada pemeriksaan.</p>';
  const todos = report.checklist.length ? `<ul class="health-todos">${report.checklist.map(todoHtml).join('')}</ul>` : '<p class="muted small">Tidak ada langkah persiapan.</p>';
  const size = `${fmtBytes(report.data.bytes)} · ${NUM.format(report.data.files)} file`;
  const last = report.errors.last;
  const shownLast = last.length > MAX_LAST ? `${last.slice(0, MAX_LAST)}…` : last;
  const errorText = report.errors.count24h ? `${NUM.format(report.errors.count24h)} error` : 'Tidak ada error';
  return `<div class="health-summary${summary.ready ? '' : ' warn'}">
      <b id="health-verdict">${summary.ready ? 'Siap dipakai' : 'Perlu perhatian'}${summary.total ? ` (${summary.done}/${summary.total})` : ''}</b>
      <p id="health-meta" class="muted small">${metaLine(report.app)}</p>
    </div>
    <section class="health-section" aria-labelledby="health-checks-title">
      <h3 id="health-checks-title">Pemeriksaan</h3>
      ${checks}
    </section>
    <details class="health-more">
      <summary>Detail &amp; persiapan${summary.total ? ` · ${summary.done}/${summary.total}` : ''}</summary>
      <section class="health-section" aria-labelledby="health-todos-title">
        <h3 id="health-todos-title">Persiapan${summary.total ? ` <span class="muted small">${summary.done}/${summary.total}</span>` : ''}</h3>
        ${todos}
      </section>
      <section class="health-section" aria-labelledby="health-data-title">
        <h3 id="health-data-title">Data aplikasi</h3>
        <p id="health-size" class="health-size">${escapeHtml(size)}</p>
        ${report.data.dir ? `<p class="muted small health-path">${escapeHtml(report.data.dir)}</p>` : ''}
      </section>
      <section class="health-section" aria-labelledby="health-errors-title">
        <h3 id="health-errors-title">Error 24 jam</h3>
        <p id="health-errors" class="health-size">${escapeHtml(errorText)}</p>
        ${shownLast ? `<code id="health-last" class="health-last" title="${escapeHtml(last)}">${escapeHtml(shownLast)}</code>` : ''}
      </section>
    </details>`;
}

function bodyHtml() {
  const error = health.error ? `<p id="health-error" class="field-error" role="alert">${escapeHtml(health.error)}</p>` : '';
  const budget = budgetHealthHtml(); // 💰 compact copy at the top (features/budget.js; no editable fields here)
  // The last good report stays on screen while a refresh is in flight or fails.
  if (health.report) return `${error}${budget}${reportHtml(health.report)}`;
  if (health.loading) return `${error}${budget}<p class="muted"><span class="spinner"></span> Memeriksa sistem…</p>`;
  return `${error}${budget}<p class="muted">Belum ada laporan.</p>`;
}

function renderHealth() {
  const body = $('#health-body');
  if (!body) return;
  body.innerHTML = bodyHtml();
  const btn = $('#health-refresh');
  if (!btn) return;
  btn.disabled = health.loading || state.readOnly || !canCall(PATH);
  btn.textContent = health.loading ? '⏳ Memeriksa…' : '↻ Periksa ulang';
}

/** One request at a time: a double click, a reopen during a slow check, or a stale answer never doubles it. */
async function loadHealth() {
  if (health.loading) return;
  if (state.readOnly || !canCall(PATH)) {
    health.error = 'Hanya bisa diperiksa dari laptop atau HP lewat Tailscale.';
    renderHealth();
    return;
  }
  health.loading = true;
  health.error = null;
  renderHealth();
  try {
    const data = await api(PATH);
    const report = normalizeHealth(data?.health);
    if (!report) throw new Error('jawaban server tidak berisi laporan kesehatan');
    health.report = report;
  } catch (err) {
    health.error = `Gagal memeriksa: ${err?.message ?? 'tidak diketahui'}`;
  } finally {
    health.loading = false;
    if (!$('#health-modal')?.hidden) renderHealth();
  }
}

/** On a plain-WiFi phone the route is refused: hide the opener instead of opening a dialog that cannot load. */
export function syncHealthButton() {
  const btn = $('#health-open');
  if (!btn) return;
  const blocked = Boolean(state.readOnly) || !canCall(PATH);
  btn.hidden = blocked;
  btn.disabled = blocked;
  const section = $('#health-section');
  if (section) section.hidden = blocked;
}

export function initHealth() {
  syncHealthButton();
  $('#health-open')?.addEventListener('click', () => {
    if (state.readOnly || !canCall(PATH)) return; // the server refuses it too
    openModal('health-modal');
    renderHealth(); // the cached report shows at once; loadHealth refreshes it in the background
    // 💰 the cached budget shows at once; a first open asks /api/budget once and redraws the dialog with its answer
    loadBudgetView({ force: true, scope: '' }).then(() => {
      if (!$('#health-modal')?.hidden) renderHealth();
    });
    loadHealth();
  });
  $('#health-refresh')?.addEventListener('click', () => loadHealth());
  $('#health-diagnostics')?.addEventListener('click', () => downloadDiagnostics());
}
