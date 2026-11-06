// 💰 Budget pemakaian global: a USD limit per day/week/month and what the recorded costs used in each window.
// Shown in ⚙ Pengaturan → Umum (editable) and, compactly, at the top of 🩺 Kesehatan sistem (read-only).
// POST /api/budget answers the view, POST /api/budget/save takes the three limits and answers the same view.
// Both are laptop/Tailscale routes: a plain-WiFi phone neither sees the section nor calls them.
// No polling: one request when the section opens (or after a save), the view is kept in memory, and a request
// already in flight is never doubled. Every number from the server is validated and the percent/tone is
// recomputed here, so a bad payload cannot draw a lying bar.
import { api, canCall, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { READ_ONLY_HINT, state } from '../core/state.js';

const VIEW = '/api/budget';
const SAVE = '/api/budget/save';
const AUDIT = '/api/budget/audit';
const MAX_USD = 10_000;
const WARN_AT = 0.8; // 80% of the limit: amber; 100%: red

/** The three windows in display order; `field` is the save-body key, `input` the field in ⚙ → Umum. */
const WINDOWS = [
  { key: 'day', label: 'Harian', field: 'dailyUsd', input: '#budget-daily' },
  { key: 'week', label: 'Mingguan', field: 'weeklyUsd', input: '#budget-weekly' },
  { key: 'month', label: 'Bulanan', field: 'monthlyUsd', input: '#budget-monthly' },
];

const AMOUNT = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const WHOLE = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
const usdText = (n) => `$${AMOUNT.format(n)}`;
const limitText = (n) => (Number.isInteger(n) ? `$${WHOLE.format(n)}` : usdText(n));

/** The last good view (memory only), the inline error, the in-flight request, and the limits last drawn. */
export const budgetView = { data: null, global: null, scope: '', error: null, loading: false, promise: null, fieldsKey: null, saving: false, auditLoaded: false };

const budgetAvailable = () => !state.readOnly && canCall(VIEW);

/** A USD amount from the server: finite, >= 0 and not absurd; anything else is null (unknown). */
const amount = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10_000_000 ? v : null);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Only what the UI shows, with percent and tone recomputed from limit + spent (the server's are not trusted). */
export function normalizeBudgetView(raw) {
  const view = raw && typeof raw === 'object' ? raw : {};
  const limits = view.budget && typeof view.budget === 'object' ? view.budget : {};
  const spend = view.spend && typeof view.spend === 'object' ? view.spend : {};
  const windows = view.windows && typeof view.windows === 'object' ? view.windows : {};
  const rows = {};
  for (const w of WINDOWS) {
    const win = windows[w.key] && typeof windows[w.key] === 'object' ? windows[w.key] : {};
    const spentWindow = spend[w.key] && typeof spend[w.key] === 'object' ? spend[w.key] : {};
    const limit = amount(win.limit) ?? amount(limits[w.field]) ?? 0;
    const used = amount(win.usd) ?? amount(spentWindow.usd) ?? 0;
    const percent = limit > 0 ? used / limit : null;
    const tone = limit <= 0 ? 'off' : percent >= 1 ? 'over' : percent >= WARN_AT ? 'warn' : 'ok';
    rows[w.key] = { label: w.label, limit, usd: used, percent, tone, records: count(win.rows ?? spentWindow.rows) };
  }
  return { rows, note: typeof view.note === 'string' ? view.note.trim().slice(0, 300) : '' };
}

/** "sisa $7,70" while there is room, "lewat $2,40" once the limit is passed. */
function restText(row) {
  const left = row.limit - row.usd;
  return left >= 0 ? `sisa ${usdText(left)}` : `lewat ${usdText(-left)}`;
}

/** The windows at/over their limit, and the one line that explains the hard stop. */
function stopState(view = budgetView.data) {
  const over = WINDOWS.filter((w) => view?.rows[w.key]?.tone === 'over');
  if (!over.length) return { over, text: '' };
  const detail = over.map((w) => `${w.label.toLowerCase()} ${usdText(view.rows[w.key].usd)} / ${limitText(view.rows[w.key].limit)}`).join(' · ');
  return { over, text: `⛔ Pengiriman prompt dihentikan: budget ${detail} sudah tercapai. Naikkan atau kosongkan batasnya untuk melanjutkan.` };
}

/** The summary rows (also used by 🩺): a thin green/amber/red bar, the amounts, the percent and what is left. */
export function budgetRowsHtml(view = budgetView.data) {
  if (!view) return '';
  const items = WINDOWS.map((w) => {
    const row = view.rows[w.key];
    if (!row || row.limit <= 0) {
      // No limit: the spend is still worth showing, the rest is "tanpa batas".
      return `<li class="budget-row off"><span class="budget-window">${w.label}</span><span class="budget-amount muted">${usdText(row?.usd ?? 0)} tercatat · tanpa batas</span></li>`;
    }
    const pct = Math.round(row.percent * 100);
    const width = Math.min(100, Math.max(0, pct)); // aria-valuenow must stay within min..max
    return `<li class="budget-row ${row.tone}">
      <span class="budget-window">${w.label}</span>
      <span class="budget-main">
        <span class="budget-amount">${usdText(row.usd)} / ${limitText(row.limit)} <span class="budget-pct">(${pct}%)</span></span>
        <span class="budget-bar ${row.tone}" role="progressbar" aria-label="${w.label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}" aria-valuetext="${pct}% dari batas ${w.label.toLowerCase()}, ${restText(row)}"><span class="budget-fill" style="width:${width}%"></span></span>
        <span class="budget-rest">${restText(row)}</span>
      </span>
    </li>`;
  });
  return `<ul class="budget-rows">${items.join('')}</ul>`;
}

/** The compact copy at the top of the health dialog: the same rows, no editable fields. */
export function budgetHealthHtml() {
  if (!budgetAvailable()) return '';
  const view = budgetView.global;
  const error = budgetView.error ? `<p class="field-error" role="alert">${escapeHtml(budgetView.error)}</p>` : '';
  const stop = stopState(view);
  const stopLine = stop.text ? `<p class="field-error" role="alert">${escapeHtml(stop.text)}</p>` : '';
  const body = view
    ? `${stopLine}${budgetRowsHtml(view)}<p class="muted small">Biaya tercatat memakai harga list; OpenCode Go itu langganan, jadi biayanya sering tercatat $0.</p>`
    : `<p class="muted small">${budgetView.loading ? 'Memuat budget…' : 'Belum ada data budget.'}</p>`;
  return `<section class="health-section health-budget" aria-labelledby="health-budget-title">
    <h3 id="health-budget-title">Budget pemakaian</h3>
    ${error}${body}
  </section>`;
}

function showBudgetError(message, field = null) {
  budgetView.error = message || null;
  for (const w of WINDOWS) $(w.input)?.setAttribute('aria-invalid', String(Boolean(message) && field === $(w.input)));
  const box = $('#budget-error');
  if (box) box.textContent = budgetView.error ?? '';
}

/** Hides the section (and its fields) on a page that may not call the route; disables them while saving. */
export function syncBudgetSection() {
  const section = $('#budget-section');
  if (!section) return;
  const scope = $('#budget-project');
  if (scope) {
    const projects = (state.projects ?? []).filter((p) => p && p.id !== 'demo');
    const keep = budgetView.scope;
    scope.innerHTML = `<option value="">Global (semua project)</option>${projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}`;
    scope.value = projects.some((p) => p.id === keep) ? keep : '';
    budgetView.scope = scope.value;
  }
  const blocked = !budgetAvailable();
  section.hidden = blocked;
  const disabled = blocked || budgetView.saving;
  for (const w of WINDOWS) {
    const el = $(w.input);
    if (!el) continue;
    el.disabled = disabled;
    el.title = blocked ? READ_ONLY_HINT : '';
  }
  const btn = $('#budget-save');
  if (btn) {
    btn.disabled = disabled;
    btn.textContent = budgetView.saving ? '⏳ Menyimpan…' : 'Simpan';
    btn.title = blocked ? READ_ONLY_HINT : '';
  }
}

function renderBudget() {
  const box = $('#budget-rows');
  if (box) {
    box.setAttribute('aria-busy', String(budgetView.loading));
    box.innerHTML = budgetView.data
      ? budgetRowsHtml()
      : `<li class="muted small">${budgetView.loading ? 'Memuat budget…' : 'Belum ada data budget.'}</li>`;
  }
  const error = $('#budget-error');
  if (error) error.textContent = budgetView.error ?? '';
  // The server's own coverage sentence ("9 dari 9 catatan punya biaya"), shown as text, never as markup.
  const coverage = $('#budget-coverage');
  if (coverage) {
    coverage.textContent = budgetView.data?.note ?? '';
    coverage.hidden = !coverage.textContent;
  }
  const stop = $('#budget-stop');
  const stopInfo = stopState();
  if (stop) {
    stop.textContent = stopInfo.text;
    stop.hidden = !stopInfo.text;
  }
  const override = $('#budget-override');
  if (override) override.hidden = !stopInfo.text;
  // Fill the fields with the saved limits once per view (and after a save), never while the user is typing.
  const key = budgetView.data ? WINDOWS.map((w) => budgetView.data.rows[w.key].limit).join('|') : '';
  if (budgetView.data && key !== budgetView.fieldsKey && !document.activeElement?.matches?.('#budget-form input')) {
    budgetView.fieldsKey = key;
    for (const w of WINDOWS) {
      const el = $(w.input);
      if (el) el.value = budgetView.data.rows[w.key].limit > 0 ? String(budgetView.data.rows[w.key].limit) : '';
    }
  }
  syncBudgetSection();
}

/** One request at a time; the in-memory view is reused unless `force` (a first open with no data asks once). */
export function loadBudgetView({ force = false, scope = budgetView.scope } = {}) {
  if (budgetView.promise) return budgetView.promise;
  if (budgetView.scope !== scope) {
    budgetView.scope = scope;
    budgetView.data = null;
    budgetView.fieldsKey = null;
    force = true;
  }
  if (!force && budgetView.data && !budgetView.error) {
    renderBudget();
    return Promise.resolve();
  }
  if (!budgetAvailable()) {
    budgetView.error = null;
    renderBudget();
    return Promise.resolve();
  }
  budgetView.loading = true;
  budgetView.error = null;
  renderBudget();
  const task = api(VIEW, scope ? { projectId: scope } : {})
    .then((data) => {
      budgetView.data = normalizeBudgetView(data?.budget);
      if (!scope) budgetView.global = budgetView.data;
      budgetView.fieldsKey = null;
    })
    .catch((err) => {
      budgetView.error = `Gagal memuat budget: ${err?.message ?? 'tidak diketahui'}`;
    })
    .finally(() => {
      budgetView.loading = false;
      budgetView.promise = null;
      renderBudget();
    });
  budgetView.promise = task;
  return task;
}

/** The three fields → the save body, or an Error carrying the field to focus (`0`/empty = no limit). */
function readLimits() {
  const body = {};
  for (const w of WINDOWS) {
    const el = $(w.input);
    const text = String(el?.value ?? '').trim();
    if (el?.validity?.badInput) throw Object.assign(new Error(`${w.label} harus angka $0–$10.000.`), { field: el });
    if (text === '') {
      body[w.field] = 0; // "tanpa batas": the server reads 0 as off
      continue;
    }
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0 || n > MAX_USD) throw Object.assign(new Error(`${w.label} harus angka $0–$10.000 (0 = tanpa batas).`), { field: el });
    if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) throw Object.assign(new Error(`${w.label} maksimal 2 angka desimal.`), { field: el });
    body[w.field] = Math.round(n * 100) / 100;
  }
  return body;
}

/** Validates the fields and POSTs them; the answer is the fresh view, so the summary updates without a second call. */
export async function saveBudget() {
  if (budgetView.saving) return;
  if (!budgetAvailable()) return syncBudgetSection();
  let body;
  try {
    body = readLimits();
  } catch (err) {
    showBudgetError(err.message, err.field ?? null);
    err.field?.focus?.();
    return;
  }
  budgetView.saving = true;
  showBudgetError('');
  syncBudgetSection();
  try {
    const data = await api(SAVE, budgetView.scope ? { ...body, projectId: budgetView.scope } : body);
    budgetView.data = normalizeBudgetView(data?.budget);
    if (!budgetView.scope) budgetView.global = budgetView.data;
    budgetView.fieldsKey = null; // take the saved values back from the server
    budgetView.auditLoaded = false;
    if ($('#budget-audit')?.open) loadBudgetAudit();
    toast(budgetView.scope ? '💰 Budget project disimpan.' : '💰 Budget pemakaian global disimpan.', 'ok');
  } catch (err) {
    showBudgetError(err?.status === 400 ? err.message : `Gagal menyimpan budget: ${err?.message ?? 'tidak diketahui'}`);
  } finally {
    budgetView.saving = false;
    renderBudget();
  }
}

async function loadBudgetAudit() {
  if (!budgetAvailable() || budgetView.auditLoaded) return;
  const list = $('#budget-audit-list');
  if (!list) return;
  try {
    const data = await api(AUDIT, { limit: 20 });
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    list.innerHTML = entries.length
      ? entries
          .map((e) => {
            const at = new Date(e.ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            const what = e.action === 'override' ? 'Izinkan 1 giliran' : `${e.scope === 'project' ? 'Budget project' : 'Budget global'}`;
            return `<li><b>${escapeHtml(what)}</b> · ${escapeHtml(at)} · ${escapeHtml(e.actor ?? 'laptop')}${e.detail ? ` · ${escapeHtml(e.detail)}` : ''}</li>`;
          })
          .join('')
      : '<li class="muted small">Belum ada perubahan.</li>';
    budgetView.auditLoaded = true;
  } catch (err) {
    list.innerHTML = `<li class="field-error" role="alert">Gagal memuat riwayat: ${escapeHtml(err?.message ?? 'tidak diketahui')}</li>`;
  }
}

export function initBudget() {
  const save = $('#budget-save');
  if (!save) return;
  save.addEventListener('click', () => saveBudget());
  $('#budget-audit')?.addEventListener('toggle', (e) => {
    if (e.target.open) loadBudgetAudit();
  });
  $('#budget-project')?.addEventListener('change', (e) => {
    loadBudgetView({ force: true, scope: e.target.value });
  });
  $('#budget-override')?.addEventListener('click', async () => {
    try {
      await api('/api/budget/override', {});
      toast('Satu giliran diizinkan meski budget tercapai.', 'ok');
      budgetView.auditLoaded = false;
      if ($('#budget-audit')?.open) loadBudgetAudit();
      loadBudgetView({ force: true });
    } catch (err) {
      showBudgetError(`Gagal memberi izin satu giliran: ${err?.message ?? 'tidak diketahui'}`);
    }
  });
  for (const w of WINDOWS) {
    const el = $(w.input);
    if (!el) continue;
    // The fields live inside #roots-form (the project folders): Enter must save the budget, not the folders.
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      saveBudget();
    });
    el.addEventListener('input', () => showBudgetError(''));
  }
  syncBudgetSection();
}
