// 🌐 Semua antrian: one list across projects in the server's fair dispatch order (POST /api/queues, read-only —
// a phone on plain WiFi may look too). Buka opens that project's 📋 Antrian; Batal drops a waiting item.
// The dialog follows the `queue` SSE event (auto-refresh, only while it is open).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { READ_ONLY_HINT, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { openQueue } from './queue.js';

const view = { loading: false, loaded: false, again: false };
const isOpen = () => !$('#queue-all-modal').hidden;

export function openQueueAll() {
  openModal('queue-all-modal');
  load();
}

export function initQueueAll() {
  $('#queue-all-open').addEventListener('click', openQueueAll);
  $('#queue-all-refresh').addEventListener('click', () => load());
  $('#queue-all-list').addEventListener('click', onAction);
}

// Any project's queue changed (`queue` SSE event): wait for the burst to settle, then read once — but only while
// the dialog is open (a closed dialog costs nothing and reads the fresh list when it opens).
let refreshTimer = 0;
export function onQueueEvent() {
  if (!isOpen()) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = 0;
    if (isOpen()) load();
  }, 250);
}

async function load() {
  if (view.loading) {
    view.again = true; // a burst of events collapses into one more read after this one
    return;
  }
  view.loading = true;
  const list = $('#queue-all-list');
  const refresh = $('#queue-all-refresh');
  refresh.disabled = true;
  if (!view.loaded) {
    list.innerHTML = '<li class="muted">Memuat antrian…</li>';
    $('#queue-all-empty').hidden = true;
    $('#queue-all-summary').textContent = '';
  }
  try {
    render(await api('/api/queues'));
    view.loaded = true;
  } catch (err) {
    list.innerHTML = `<li class="state-error">Gagal memuat antrian: ${escapeHtml(err.message)}</li>`;
    $('#queue-all-empty').hidden = true;
    $('#queue-all-summary').textContent = '';
  } finally {
    view.loading = false;
    refresh.disabled = false;
    if (view.again) {
      view.again = false;
      load();
    }
  }
}

/** "N menunggu · M berjalan" (+ "· K antrian dijeda" when a project's queue is paused). */
function summaryText(waiting, running, paused) {
  return `${waiting} menunggu · ${running} berjalan${paused ? ` · ${paused} antrian dijeda` : ''}`;
}

/** The same wording the chat bubble uses, without the queue position in front. */
function etaText(ms) {
  return ms >= 60000 ? `±${Math.round(ms / 60000)} mnt` : 'sebentar';
}

/** Running first (oldest start), then waiting with a global position, then waiting without one (paused/busy). */
function compareRows(a, b) {
  const rank = (r) => (r.status === 'running' ? 0 : r.pos != null ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) {
    const sa = a.startedAt || Number.POSITIVE_INFINITY; // a start time we don't know goes last
    const sb = b.startedAt || Number.POSITIVE_INFINITY;
    return sa === sb ? 0 : sa - sb;
  }
  if (ra === 1) return a.pos - b.pos;
  return a.createdAt - b.createdAt;
}

/** Reads the payload defensively: only known statuses/numbers become a row, everything is escaped when drawn. */
function render(data) {
  const queues = Array.isArray(data?.queues) ? data.queues : [];
  const rows = [];
  let waiting = 0;
  let running = 0;
  let paused = 0;
  for (const q of queues) {
    if (!q || typeof q.project !== 'string' || !q.project) continue;
    const pausedQueue = q.paused === true;
    if (pausedQueue) paused += 1;
    const name = typeof q.name === 'string' && q.name ? q.name : q.project;
    for (const item of Array.isArray(q.items) ? q.items : []) {
      if (!item || typeof item !== 'object') continue;
      const status = item.status === 'running' ? 'running' : item.status === 'waiting' ? 'waiting' : null;
      if (!status) continue; // the endpoint only sends these two: never invent a row for anything else
      if (status === 'running') running += 1;
      else waiting += 1;
      rows.push({
        project: q.project,
        name,
        paused: pausedQueue,
        id: typeof item.id === 'string' ? item.id : '',
        text: typeof item.text === 'string' ? item.text : '',
        status,
        pos: status === 'waiting' && Number.isInteger(item.queuePosition) && item.queuePosition > 0 ? item.queuePosition : null,
        etaMs: status === 'waiting' && typeof item.etaMs === 'number' && Number.isFinite(item.etaMs) && item.etaMs >= 0 ? item.etaMs : null,
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
        startedAt: Number.isFinite(item.startedAt) ? item.startedAt : 0,
      });
    }
  }
  rows.sort(compareRows);
  $('#queue-all-summary').textContent = summaryText(waiting, running, paused);
  $('#queue-all-list').innerHTML = rows.map(rowHtml).join('');
  $('#queue-all-empty').hidden = rows.length > 0;
}

function rowHtml(row) {
  const pausedRow = row.paused && row.status === 'waiting'; // a paused queue's waiting items cannot start
  const pos = row.status === 'running' ? '▶' : row.pos != null ? `#${row.pos}` : pausedRow ? '⏸' : '—';
  const status = row.status === 'running' ? 'berjalan' : pausedRow ? 'dijeda' : 'menunggu';
  const statusClass = row.status === 'running' ? 'running' : pausedRow ? 'paused' : 'waiting';
  const eta = row.etaMs == null ? '' : `<span class="queue-all-eta">${etaText(row.etaMs)}</span>`;
  const cancel = row.status === 'waiting' && row.id
    ? `<button type="button" class="ghost" data-qa="cancel" data-item="${escapeHtml(row.id)}" title="${state.readOnly ? escapeHtml(READ_ONLY_HINT) : 'Batalkan item antrian ini'}"${state.readOnly ? ' disabled' : ''}>Batal</button>`
    : '';
  return `<li class="queue-all-row ${row.status}${pausedRow ? ' paused' : ''}" data-project="${escapeHtml(row.project)}">
    <span class="queue-all-pos" aria-hidden="true">${pos}</span>
    <div class="queue-all-main">
      <div class="queue-all-meta"><span class="queue-all-name">${escapeHtml(row.name)}</span><span class="queue-all-status ${statusClass}">${status}</span>${eta}</div>
      <div class="queue-all-text">${escapeHtml(row.text)}</div>
    </div>
    <div class="queue-all-actions"><button type="button" class="ghost" data-qa="open">Buka</button>${cancel}</div>
  </li>`;
}

async function onAction(e) {
  const button = e.target.closest('button[data-qa]');
  const row = button?.closest('.queue-all-row');
  if (!button || !row) return;
  const project = row.dataset.project;
  if (!project) return;
  if (button.dataset.qa === 'open') {
    closeModal('queue-all-modal');
    return openQueue({ project });
  }
  if (button.dataset.qa !== 'cancel') return;
  const itemId = button.dataset.item;
  if (!itemId) return;
  if (state.readOnly) return toast(`${READ_ONLY_HINT}.`);
  if (!window.confirm('Batalkan item antrian ini?')) return;
  button.disabled = true; // one request per click; the list is read again once the server answers
  try {
    await api(`/api/projects/${encodeURIComponent(project)}/queue-remove`, { itemId });
    toast('Item antrian dibatalkan.', 'ok');
    await load();
  } catch (err) {
    toast(`Gagal membatalkan: ${err.message}`);
    if (button.isConnected) button.disabled = false;
  }
}
