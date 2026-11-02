// 🗂 Semua project: one screen to watch every project at once (header button, phone Kantor bar, the 🗂 button in
// the project picker, Ctrl+P "Semua project", /dashboard). Read-only: it only reads what the event stream already
// holds, so it works on a phone over plain WiFi too. Cards are updated in place (no full re-render per event);
// tapping one switches project like the picker does and jumps to its pending permission card.
// Rules (summary, order, counts): core/dashboard-rules.js.
import { $, escapeHtml, narrow } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { announcement, countGroups, countsText, matchesQuery, relTime, sortSummaries, summarize } from '../core/dashboard-rules.js';
import { roleName } from '../office/cast.js';
import { closeModal, openModal } from '../ui/modals.js';
import { setMobileView } from '../ui/layout.js';
import { selectProject } from './picker.js';
import { stuck } from './stuck.js';

const TICK_MS = 30_000; // "2 mnt lalu" and stuck verdicts (no event of their own) while the dialog is open
const ANNOUNCE_GAP_MS = 3000; // aria-live: at most one announcement per gap, several changes merged

export const dashboard = {
  cards: new Map(), // project id -> { node, parts: { main, body, actions, cls }, summary }
  query: '',
  frame: 0,
  timer: null,
  barText: '',
  pendingNotes: [],
  lastAnnounce: 0,
  announceTimer: null,
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
      summarize(p, state.statuses[p.id] ?? {}, {
        chat: state.chats[p.id] ?? [],
        events: state.events[p.id] ?? [],
        approvals: byProject.get(p.id) ?? [],
        stuck: stuckBy.get(p.id) ?? 0,
        demo: p.id === DEMO_ID,
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
  let line = '';
  if (s.waitingLabel) line = `<p class="dash-line dash-wait">Menunggu: ${escapeHtml(s.waitingLabel)}</p>`;
  else if (s.busy && (s.roles.length || s.task)) {
    const who = s.roles.map((r) => escapeHtml(roleName(r))).join(', ');
    line = `<p class="dash-line dash-work">${who ? `<b>${who}</b>` : ''}${who && s.task ? ' · ' : ''}${s.task ? escapeHtml(s.task) : ''}</p>`;
  }
  const snippet = s.snippet ? `<p class="dash-snip"><span class="dash-who">${s.snippet.who === 'user' ? 'Kamu' : 'Claude'}:</span> ${escapeHtml(s.snippet.text)}</p>` : '<p class="dash-snip muted">Belum ada percakapan.</p>';
  const body = `${meta.length ? `<p class="dash-meta">${meta.join('')}</p>` : ''}${line}${snippet}`;

  const actions = s.approvalChatId ? `<button type="button" class="dash-act" data-dash-approval="${escapeHtml(s.approvalChatId)}">✋ Lihat izin</button>` : '';
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
  const list = summaries();
  renderBar(list);
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
        : 'Belum ada project. Tambahkan folder lewat pemilih project (<kbd>Ctrl K</kbd>).';
  }
  $('#dash-summary').textContent = loading ? '' : `${list.length} project · ${countsText(countGroups(list))}`;
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

export function openDashboard() {
  closeModal('project-modal');
  openModal('dash-modal');
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
      const node = document.querySelector(`#chat > [data-id="${CSS.escape(chatId)}"]`);
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
  // The whole card is a target (the button carries the name for keyboards and screen readers).
  $('#dash-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const act = e.target.closest('[data-dash-approval]');
    openFromDashboard(li.dataset.id, act ? act.dataset.dashApproval : null);
  });
  narrow.addEventListener('change', () => narrow.matches && renderDashboard());
}
