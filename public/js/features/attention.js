// ⚠ Perlu perhatian: approvals, paused queues, budget stops, interrupted turns, and failed schedules in one place.
// The list is shown at the top of 🗂 Semua project; the header badge is the quiet nudge.
import { api } from '../core/api.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { state } from '../core/state.js';
import { setMobileView } from '../ui/layout.js';
import { closeModal, openModal } from '../ui/modals.js';
import { budgetView, loadBudgetView } from './budget.js';
import { selectProject } from './picker.js';
import { openQueue } from './queue.js';
import { selectSettingsTab } from './settings.js';

const attention = { items: [], count: 0, loading: false, at: 0 };
const MIN_GAP_MS = 5000;
let timer = null;

const projectName = (id) => state.projects.find((p) => p.id === id)?.name ?? 'project';
const ICON = { approval: '✋', plan: '📋', question: '❓', budget: '💰', queue: '📋', interrupted: '▶', routine: '⏰' };

export function renderAttention() {
  const box = $('#dash-attention');
  if (!box) return;
  const items = attention.items;
  box.hidden = !items.length;
  $('#attention-count').hidden = !attention.count;
  $('#attention-count').textContent = attention.count > 99 ? '99+' : String(attention.count);
  $('#dash-attention-count').textContent = items.length ? `(${items.length})` : '';
  $('#dash-attention-list').innerHTML = items
    .map(
      (item, i) => `<li><button type="button" data-attention="${i}">
        <span class="att-ico" aria-hidden="true">${ICON[item.kind] ?? '⚠'}</span>
        <span class="att-main"><b>${escapeHtml(projectName(item.project) === 'project' && item.projectName ? item.projectName : projectName(item.project))}</b><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.detail ?? '')}</small></span>
      </button></li>`,
    )
    .join('');
}

export async function loadAttention({ force = false } = {}) {
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
      const node = document.querySelector(`#chat > [data-id="${CSS.escape(item.chatId)}"]`);
      node?.scrollIntoView({ block: 'center' });
      node?.setAttribute('tabindex', '-1');
      node?.focus({ preventScroll: true });
    }),
  );
}

export function initAttention() {
  $('#dash-attention-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-attention]');
    if (btn) go(attention.items[Number(btn.dataset.attention)]);
  });
  loadAttention();
  setInterval(() => loadAttention(), 60_000).unref?.();
}
