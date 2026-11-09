// ⚠ Perlu perhatian: approvals, paused queues, budget stops, interrupted turns, and failed schedules in one place.
// The list is shown at the top of 🗂 Semua project; the header badge is the quiet nudge.
import { api } from '../core/api.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { state } from '../core/state.js';
import { setMobileView } from '../ui/layout.js';
import { closeModal, openModal } from '../ui/modals.js';
import { budgetView, loadBudgetView } from './budget.js';
import { revealChatMessage } from './chat.js';
import { selectProject } from './picker.js';
import { openQueue } from './queue.js';
import { selectSettingsTab } from './settings.js';

const attention = { items: [], count: 0, loading: false, at: 0 };
const MIN_GAP_MS = 5000;
let timer = null;

const projectName = (id) => state.projects.find((p) => p.id === id)?.name ?? 'project';
const ICON = { approval: '✋', plan: '📋', question: '❓', budget: '💰', queue: '📋', interrupted: '▶', routine: '⏰' };

// ⏰ Tunda: hide one item for an hour without touching the server. The list only reflects it; the state behind
// it (a pending approval, a paused queue) is unchanged. Stored per browser, so a reload keeps the quiet.
const SNOOZE_KEY = 'office.attention.snooze';
const SNOOZE_MS = 60 * 60 * 1000;

/** What identifies an item across polls (the server sends `id`; an older server: derive one from the item). */
const itemKey = (item) => item.id || `${item.kind}:${item.project ?? item.scope ?? 'global'}:${item.chatId ?? item.label ?? ''}`;

/** Stored snoozes that have not expired yet (expired ones are dropped). */
function loadSnoozes() {
  try {
    const raw = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    const now = Date.now();
    return Object.fromEntries(Object.entries(raw).filter(([, until]) => Number.isFinite(until) && until > now));
  } catch {
    return {};
  }
}

function saveSnoozes(list) {
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable (private mode): the click still hides it until the next render
  }
}

/** ⏰: one hour without this item in the list or the badge. */
function snoozeItem(item) {
  saveSnoozes({ ...loadSnoozes(), [itemKey(item)]: Date.now() + SNOOZE_MS });
  renderAttention();
}

/** "Tampilkan": every snoozed item comes back at once. */
function restoreSnoozes() {
  try {
    localStorage.removeItem(SNOOZE_KEY);
  } catch {
    // nothing stored
  }
  renderAttention();
}

export function renderAttention() {
  const box = $('#dash-attention');
  if (!box) return;
  const now = Date.now();
  const snoozes = loadSnoozes();
  const visible = attention.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !(snoozes[itemKey(item)] > now));
  const snoozed = attention.items.length - visible.length;
  const count = Math.max(0, attention.count - snoozed);
  box.hidden = !visible.length && !snoozed; // all snoozed: still show the way back
  $('#attention-count').hidden = !count;
  $('#attention-count').textContent = count > 99 ? '99+' : String(count);
  $('#dash-attention-count').textContent = visible.length ? `(${visible.length})` : '';
  $('#dash-attention-list').innerHTML = visible
    .map(
      ({ item, index }) => `<li class="att-row"><button type="button" class="att-open" data-attention="${index}">
        <span class="att-ico" aria-hidden="true">${ICON[item.kind] ?? '⚠'}</span>
        <span class="att-main"><b>${escapeHtml(projectName(item.project) === 'project' && item.projectName ? item.projectName : projectName(item.project))}</b><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.detail ?? '')}</small></span>
      </button><button type="button" class="att-snooze" data-snooze="${index}" title="Tunda 1 jam" aria-label="Tunda 1 jam: ${escapeHtml(item.label)}">⏰</button></li>`,
    )
    .join('');
  const note = $('#dash-attention-note');
  if (note) {
    note.hidden = !snoozed;
    note.innerHTML = snoozed ? `${snoozed} ditunda 1 jam · <button type="button" data-attention-restore>Tampilkan</button>` : '';
  }
}

export async function loadAttention({ force = false } = {}) {
  // The list can name tools/files and is laptop/Tailscale-only; a read-only WiFi page must not even try.
  if (state.readOnly) return;
  if (attention.loading) return;
  if (!force && Date.now() - attention.at < MIN_GAP_MS) return;
  attention.loading = true;
  attention.at = Date.now();
  try {
    const data = await api('/api/attention');
    attention.items = Array.isArray(data?.items) ? data.items : [];
    attention.count = Number.isFinite(data?.count) ? data.count : attention.items.length;
  } catch {
    attention.items = []; // WiFi phone or an older server: no badge, the dashboard still works
    attention.count = 0;
  } finally {
    attention.loading = false;
    renderAttention();
  }
}

export function scheduleAttention() {
  clearTimeout(timer);
  timer = setTimeout(() => loadAttention({ force: true }), 800);
}

function go(item) {
  closeModal('dash-modal');
  if (item.project && item.project !== state.active) selectProject(item.project);
  if (narrow.matches) setMobileView('chat');
  if (item.kind === 'queue') return openQueue();
  if (item.kind === 'budget') {
    budgetView.scope = item.project ?? '';
    budgetView.data = null;
    budgetView.fieldsKey = null;
    openModal('settings-modal');
    selectSettingsTab('umum');
    loadBudgetView({ force: true, scope: budgetView.scope });
    return;
  }
  if (item.kind === 'routine') {
    openModal('settings-modal');
    selectSettingsTab('jadwal');
    return;
  }
  if (!item.chatId) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const node = revealChatMessage(item.chatId);
      node?.scrollIntoView({ block: 'center' });
      node?.setAttribute('tabindex', '-1');
      node?.focus({ preventScroll: true });
    }),
  );
}

export function initAttention() {
  $('#dash-attention-list')?.addEventListener('click', (e) => {
    const snooze = e.target.closest('[data-snooze]');
    if (snooze) {
      const item = attention.items[Number(snooze.dataset.snooze)];
      if (item) snoozeItem(item);
      return;
    }
    const btn = e.target.closest('[data-attention]');
    if (btn) go(attention.items[Number(btn.dataset.attention)]);
  });
  $('#dash-attention-note')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-attention-restore]')) restoreSnoozes();
  });
  // The first load waits for the snapshot (state.readOnly), so a WiFi page never sends a refused request.
  setInterval(() => loadAttention(), 60_000).unref?.();
}
