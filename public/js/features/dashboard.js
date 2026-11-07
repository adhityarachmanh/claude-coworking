// 🗂 Semua project: one screen to watch every project at once (header button, phone Kantor bar, the 🗂 button in
// the project picker, Ctrl+P "Semua project", /dashboard). Read-only: it only reads what the event stream already
// holds, so it works on a phone over plain WiFi too. Cards are updated in place (no full re-render per event);
// tapping one switches project like the picker does and jumps to its pending permission card.
// Rules (summary, order, counts): core/dashboard-rules.js.
import { api, toast } from '../core/api.js';
import { engineLabel, engineOf } from '../core/engine-caps.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { fmtTokens } from '../core/format.js';
import { DEMO_ID, projectName, READ_ONLY_HINT, state } from '../core/state.js';
import { announcement, countGroups, countsText, GROUP, matchesQuery, relTime, sortSummaries, summarize } from '../core/dashboard-rules.js';
import { roleName } from '../office/cast.js';
import { closeModal, openModal } from '../ui/modals.js';
import { setMobileView } from '../ui/layout.js';
import { loadAttention, renderAttention } from './attention.js';
import { revealChatMessage } from './chat.js';
import { selectProject } from './picker.js';
import { openQueue } from './queue.js';
import { stuck } from './stuck.js';

const TICK_MS = 30_000; // "2 mnt lalu" and stuck verdicts (no event of their own) while the dialog is open
const ANNOUNCE_GAP_MS = 3000; // aria-live: at most one announcement per gap, several changes merged
const TODAY_GAP_MS = 60_000; // "Hari ini" is a ledger read: one request per minute at most

export const dashboard = {
  cards: new Map(), // project id -> { node, parts: { main, body, actions, cls }, summary }
  query: '',
  frame: 0,
  filter: null, // GROUP value or null (all)
  timer: null,
  barText: '',
  pendingNotes: [],
  lastAnnounce: 0,
  announceTimer: null,
  today: { at: 0, data: null, loading: false },
  budgets: new Map(), // project id -> { usd, limit, window, state } when that project has its own limit
  budgetAt: 0,
  budgetLoading: false,
};

const isOpen = () => !$('#dash-modal').hidden;
const domId = (id) => `dash-d-${String(id).replace(/[^\w-]/g, '_')}`;

/** Stuck verdicts per project (read-only use of the detector's state; it may hold none). */
function stuckCounts() {
  const counts = new Map();
  const verdicts = stuck?.verdicts;
  if (!(verdicts instanceof Map)) return counts;
  for (const v of verdicts.values()) if (v?.project) counts.set(v.project, (counts.get(v.project) ?? 0) + 1);
  return counts;
}

/** Every project's summary, in card order. */
export function summaries() {
  const byProject = new Map();
  for (const a of state.approvals?.values?.() ?? []) {
    if (!byProject.has(a.project)) byProject.set(a.project, []);
    byProject.get(a.project).push(a);
  }
  const stuckBy = stuckCounts();
  return sortSummaries(
    state.projects.map((p) =>
      ({
        ...summarize(p, state.statuses[p.id] ?? {}, {
          chat: state.chats[p.id] ?? [],
          events: state.events[p.id] ?? [],
          approvals: byProject.get(p.id) ?? [],
          stuck: stuckBy.get(p.id) ?? 0,
          demo: p.id === DEMO_ID,
        }),
        budget: dashboard.budgets.get(p.id) ?? null,
      }),
    ),
  );
}

// ---------- card markup (every value from the server is escaped) ----------

function cardParts(s, now) {
  const icon = s.demo ? '🎬' : s.favorite ? '★' : '';
  const active = s.id === state.active ? '<span class="dash-here">aktif</span>' : '';
  const main = `<span class="dash-name">${icon ? `<span class="dash-ico" aria-hidden="true">${icon}</span>` : ''}${escapeHtml(s.name)}</span>${active}<span class="dash-pill k-${s.pill.kind}">${escapeHtml(s.pill.text)}${s.cli ? ' <small>CLI</small>' : ''}</span>`;

  const meta = [];
  const when = relTime(s.lastActivity, now);
  if (when) meta.push(`<span>🕘 ${escapeHtml(when)}</span>`);
  if (s.model) meta.push(`<span>🧠 ${escapeHtml(s.model)}</span>`);
  if (s.contextPct != null) meta.push(`<span class="${s.contextPct >= 80 ? 'dash-warn' : ''}">konteks ${s.contextPct}%</span>`);
  if (s.budget) {
    const when = { day: 'harian', week: 'mingguan', month: 'bulanan' }[s.budget.window] ?? '';
    meta.push(`<span class="dash-budget ${escapeHtml(s.budget.state)}" title="Budget ${escapeHtml(when)}">💰 ${money(s.budget.usd)} / ${money(s.budget.limit)}</span>`);
  }
  let line = '';
  if (s.waitingLabel) line = `<p class="dash-line dash-wait">Menunggu: ${escapeHtml(s.waitingLabel)}</p>`;
  else if (s.busy && (s.roles.length || s.task)) {
    const who = s.roles.map((r) => escapeHtml(roleName(r))).join(', ');
    line = `<p class="dash-line dash-work">${who ? `<b>${who}</b>` : ''}${who && s.task ? ' · ' : ''}${s.task ? escapeHtml(s.task) : ''}</p>`;
  }
  const snippetEngine = engineLabel(engineOf({ engine: s.engine }, state.config));
  const snippet = s.snippet ? `<p class="dash-snip"><span class="dash-who">${s.snippet.who === 'user' ? 'Kamu' : escapeHtml(snippetEngine)}:</span> ${escapeHtml(s.snippet.text)}</p>` : '<p class="dash-snip muted">Belum ada percakapan.</p>';
  const body = `${meta.length ? `<p class="dash-meta">${meta.join('')}</p>` : ''}${line}${snippet}`;

  const acts = [];
  if (s.approvalChatId) acts.push(`<button type="button" class="dash-act" data-dash-approval="${escapeHtml(s.approvalChatId)}">✋ Lihat izin</button>`);
  if (!s.demo && s.queue.open) acts.push(`<button type="button" class="dash-act" data-dash-queue="${escapeHtml(s.id)}">📋 Antrian ${s.queue.open}${s.queue.paused ? ' ⏸' : ''}</button>`);
  if (!s.demo && s.busy) {
    acts.push(`<button type="button" class="dash-act dash-stop" data-dash-stop="${escapeHtml(s.id)}" ${state.readOnly ? `disabled title="${READ_ONLY_HINT}"` : ''}>■ Hentikan</button>`);
  }
  const actions = acts.join('');
  const cls = `dash-card g-${s.group} k-${s.pill.kind}${s.id === state.active ? ' is-active' : ''}`;
  return { main, body, actions, cls };
}

function createCard(s) {
  const li = document.createElement('li');
  li.dataset.id = s.id;
  li.innerHTML = `<button type="button" class="dash-open" aria-describedby="${domId(s.id)}"></button><div class="dash-body" id="${domId(s.id)}"></div><div class="dash-actions"></div>`;
  return li;
}

// ---------- drawing ----------

function renderBar(list) {
  const bar = $('#dash-bar');
  if (!bar) return;
  const c = countGroups(list);
  const text = countsText(c);
  if (text === dashboard.barText) return;
  dashboard.barText = text;
  $('#dash-bar-sum').textContent = text;
  bar.classList.toggle('needs', c.needs > 0);
}

/** The status chips above the list: counts always reflect every project, the filter narrows the cards. */
function renderFilters(all) {
  const box = $('#dash-filters');
  if (!box) return;
  const c = countGroups(all);
  const chips = [
    ['all', 'Semua', all.length, null],
    ['needs', 'Butuh kamu', c.needs, GROUP.NEEDS],
    ['working', 'Bekerja', c.working, GROUP.WORKING],
    ['queue', 'Antrian', c.queue, GROUP.QUEUE],
    ['idle', 'Idle', c.idle, GROUP.IDLE],
  ];
  box.hidden = !all.length;
  box.innerHTML = chips
    .map(([key, label, n, group]) => {
      const on = dashboard.filter === group;
      return `<button type="button" class="dash-chip ${on ? 'on' : ''}" data-dash-filter="${key}" aria-pressed="${on}">${label} <span>${n}</span></button>`;
    })
    .join('');
}

function announce(notes) {
  if (!notes.length) return;
  dashboard.pendingNotes.push(...notes);
  const flush = () => {
    dashboard.announceTimer = null;
    const all = [...new Set(dashboard.pendingNotes)];
    dashboard.pendingNotes = [];
    if (!all.length) return;
    dashboard.lastAnnounce = Date.now();
    $('#dash-live').textContent = all.length > 3 ? `${all.slice(0, 3).join('. ')}. +${all.length - 3} lainnya` : all.join('. ');
  };
  const wait = dashboard.lastAnnounce + ANNOUNCE_GAP_MS - Date.now();
  if (wait <= 0) flush();
  else dashboard.announceTimer ??= setTimeout(flush, wait);
}

/** Draws (or updates in place) the cards; only parts that changed touch the DOM. */
export function renderDashboard() {
  const all = summaries();
  const list = dashboard.filter == null ? all : all.filter((s) => s.group === dashboard.filter);
  renderFilters(all);
  renderBar(all);
  if (!isOpen()) return;
  const ul = $('#dash-list');
  const now = Date.now();
  const loading = state.local === undefined && !state.projects.length; // before the first snapshot
  const focused = ul.contains(document.activeElement) ? document.activeElement : null;
  const notes = [];
  const seen = new Set();

  list.forEach((s, i) => {
    let card = dashboard.cards.get(s.id);
    if (!card) {
      card = { node: createCard(s), parts: {}, summary: null };
      dashboard.cards.set(s.id, card);
    } else {
      const note = announcement(card.summary, s);
      if (note) notes.push(note);
    }
    const parts = cardParts(s, now);
    const { node } = card;
    if (parts.main !== card.parts.main) node.querySelector('.dash-open').innerHTML = parts.main;
    if (parts.body !== card.parts.body) node.querySelector('.dash-body').innerHTML = parts.body;
    if (parts.actions !== card.parts.actions) node.querySelector('.dash-actions').innerHTML = parts.actions;
    if (parts.cls !== card.parts.cls) node.className = parts.cls;
    node.hidden = !matchesQuery(s, dashboard.query);
    card.parts = parts;
    card.summary = s;
    seen.add(s.id);
    // Moved only when out of place (moving a node drops its focus: restored below).
    if (ul.children[i] !== node) ul.insertBefore(node, ul.children[i] ?? null);
  });
  for (const [id, card] of dashboard.cards) {
    if (seen.has(id)) continue;
    card.node.remove();
    dashboard.cards.delete(id);
  }
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });

  const shown = list.filter((s) => matchesQuery(s, dashboard.query)).length;
  const empty = $('#dash-empty');
  empty.hidden = shown > 0;
  if (!shown) {
    empty.innerHTML = loading
      ? '<span class="spinner" aria-hidden="true"></span> Memuat project…'
      : list.length
        ? `Tidak ada project yang cocok dengan “${escapeHtml(dashboard.query.trim())}”.`
        : dashboard.filter == null
          ? 'Belum ada project. Tambahkan folder lewat pemilih project (<kbd>Ctrl K</kbd>).'
          : 'Tidak ada project di bagian ini.';
  }
  $('#dash-summary').textContent = loading ? '' : `${list.length}${dashboard.filter == null ? '' : ` dari ${all.length}`} project · ${countsText(countGroups(list))}`;
  announce(notes);
}

/** Coalesces bursts of stream events into one update per frame. */
export function scheduleDashboard() {
  if (dashboard.frame) return;
  dashboard.frame = requestAnimationFrame(() => {
    dashboard.frame = 0;
    if (isOpen() || narrow.matches) renderDashboard();
  });
}

function startTick() {
  clearInterval(dashboard.timer);
  dashboard.timer = setInterval(() => {
    if (!isOpen()) {
      clearInterval(dashboard.timer);
      dashboard.timer = null;
      return;
    }
    renderDashboard();
  }, TICK_MS);
}

/** "Hari ini" from the ledger: cost (and how complete it is), turns, tokens, sessions and projects. */
async function loadToday() {
  if (state.readOnly || dashboard.today.loading || Date.now() - dashboard.today.at < TODAY_GAP_MS) return;
  dashboard.today.loading = true;
  dashboard.today.at = Date.now();
  try {
    const data = await api('/api/summary/today');
    dashboard.today.data = data?.today && typeof data.today === 'object' ? data.today : null;
  } catch {
    dashboard.today.data = null; // read-only phone or an older server: no section
  } finally {
    dashboard.today.loading = false;
    renderToday();
  }
}

const money = (n) => `$${Number(n).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A tiny SVG line for the last days' values (no axes: the caption carries the number). */
function sparkline(values, label) {
  const w = 104;
  const h = 24;
  const pad = 2;
  const max = Math.max(...values, 1e-9);
  const step = (w - pad * 2) / Math.max(values.length - 1, 1);
  const points = values.map((v, i) => [pad + i * step, h - pad - (v / max) * (h - pad * 2)]);
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const [lx, ly] = points.at(-1);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${escapeHtml(label)}"><path d="${line}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.2" fill="currentColor"/></svg>`;
}

/** "Hari ini" + 📈 the last 7 days' cost (the Ministry's trend, from the same ledger read). */
function todaySpark(t) {
  const trend = Array.isArray(t.trend) ? t.trend : [];
  const costs = trend.map((p) => Number(p.costUsd) || 0);
  if (trend.length < 2 || !costs.some((v) => v > 0)) return '';
  const week = costs.reduce((sum, v) => sum + v, 0);
  return `<span class="dash-spark">${sparkline(costs, `Biaya ${trend.length} hari terakhir`)}<small>${money(week)}</small></span>`;
}

function renderToday() {
  const box = $('#dash-today');
  if (!box) return;
  const t = dashboard.today.data;
  if (!t) {
    box.hidden = true;
    return;
  }
  const spark = todaySpark(t);
  if (!t.rows) {
    box.innerHTML = `<b>Hari ini</b> <span>belum ada aktivitas.</span>${spark}`;
    box.hidden = false;
    return;
  }
  const parts = [];
  if (Number.isFinite(t.costUsd)) {
    const coverage = Number(t.costCoverage);
    parts.push(`${money(t.costUsd)} tercatat${coverage > 0 && coverage < 1 ? ` (${Math.round(coverage * 100)}% berbiaya)` : ''}`);
  } else {
    parts.push('biaya belum tercatat');
  }
  if (t.turns > 0) parts.push(`${t.turns} giliran`);
  if (t.tokens > 0) parts.push(`${fmtTokens(t.tokens)} token`);
  if (t.sessions > 0) parts.push(`${t.sessions} sesi`);
  if (t.projects > 0) parts.push(`${t.projects} project`);
  if (Array.isArray(t.top) && t.top.length && t.top[0].projectId) {
    const names = t.top.slice(0, 2).map((p) => projectName(p.projectId));
    parts.push(`teratas: ${names.join(', ')}`);
  }
  box.innerHTML = `<b>Hari ini</b> <span>${escapeHtml(parts.join(' · '))}</span>${spark}`;
  box.hidden = false;
}

/** The budget badge data for every project that set its own limit (one request per minute at most). */
async function loadBudgets() {
  if (state.readOnly || dashboard.budgetLoading || Date.now() - dashboard.budgetAt < TODAY_GAP_MS) return;
  dashboard.budgetLoading = true;
  dashboard.budgetAt = Date.now();
  try {
    const data = await api('/api/budget');
    const list = data?.budget?.projects;
    dashboard.budgets = new Map(
      (Array.isArray(list) ? list : [])
        .filter((p) => p && typeof p.projectId === 'string')
        .map((p) => [p.projectId, { usd: Number(p.usd) || 0, limit: Number(p.limit) || 0, window: p.window, state: p.state }]),
    );
  } catch {
    dashboard.budgets = new Map(); // read-only phone or an older server
  } finally {
    dashboard.budgetLoading = false;
    renderDashboard();
  }
}

export function openDashboard() {
  closeModal('project-modal');
  openModal('dash-modal');
  renderAttention();
  loadAttention({ force: true });
  loadToday();
  loadBudgets();
  renderDashboard();
  startTick();
  // Laptop: type to filter right away. Phone: no keyboard popping up; the dialog focuses its first control.
  if (!narrow.matches) $('#dash-search').focus();
}

/** Switches to `id` (like the picker) and brings its pending permission card into view. */
export function openFromDashboard(id, approvalChatId = null) {
  if (!state.projects.some((p) => p.id === id)) return;
  closeModal('dash-modal');
  if (id !== state.active) selectProject(id);
  if (narrow.matches) setMobileView('chat');
  const chatId = approvalChatId ?? dashboard.cards.get(id)?.summary?.approvalChatId;
  if (!chatId) return;
  // After the chat's own scroll-to-bottom (renderChat schedules it for the next frame).
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const node = revealChatMessage(chatId);
      if (!node) return;
      node.scrollIntoView({ block: 'center' });
      node.setAttribute('tabindex', '-1');
      node.focus({ preventScroll: true });
    }),
  );
}

export function initDashboard() {
  $('#btn-dashboard').addEventListener('click', openDashboard);
  $('#dash-bar').addEventListener('click', openDashboard);
  $('#project-dash').addEventListener('click', openDashboard);
  $('#dash-search').addEventListener('input', (e) => {
    dashboard.query = e.target.value;
    renderDashboard();
  });
  $('#dash-search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const first = [...$('#dash-list').children].find((li) => !li.hidden);
    if (first) openFromDashboard(first.dataset.id);
  });
  $('#dash-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-dash-filter]');
    if (!chip) return;
    const key = { all: null, needs: GROUP.NEEDS, working: GROUP.WORKING, queue: GROUP.QUEUE, idle: GROUP.IDLE }[chip.dataset.dashFilter];
    dashboard.filter = dashboard.filter === key ? null : key; // clicking the active chip clears it
    renderDashboard();
  });
  // The whole card is a target (the button carries the name for keyboards and screen readers).
  $('#dash-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const queue = e.target.closest('[data-dash-queue]');
    if (queue) {
      closeModal('dash-modal');
      return openQueue({ project: li.dataset.id });
    }
    const stop = e.target.closest('[data-dash-stop]');
    if (stop) {
      if (state.readOnly) return toast(READ_ONLY_HINT, 'warn');
      stop.disabled = true;
      stop.textContent = '■ Menghentikan…';
      return api(`/api/projects/${li.dataset.id}/stop`).catch((err) => toast(err.message));
    }
    const act = e.target.closest('[data-dash-approval]');
    openFromDashboard(li.dataset.id, act ? act.dataset.dashApproval : null);
  });
  narrow.addEventListener('change', () => narrow.matches && renderDashboard());
}
