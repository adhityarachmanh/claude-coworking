// 📋 Antrian: prompts lined up for a project, sent one by one by the server whenever the session is idle
// (server: src/queue.js). Opened from the 📋 chip in the session bar, the 📋 button next to Kirim / Alt+Enter in the
// composer (adds what is typed) or /antrian. Reading works everywhere; every change is an action (the WiFi gate
// refuses it, so a read-only phone gets the list without the buttons).
import { api, toast } from '../core/api.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { ago, fmtShort } from '../core/format.js';
import { DEMO_ID, projectName, READ_ONLY_HINT, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { setMobileView } from '../ui/layout.js';
import { autosize, updateBashMode } from './composer.js';
import { scheduleDraftSave } from './draft.js';

const STATUS_LABEL = { waiting: 'Menunggu', running: 'Berjalan', done: 'Selesai', failed: 'Gagal' };
const REASON_LABEL = {
  user: 'dijeda olehmu',
  restart: 'dijeda karena server di-restart — periksa urutannya, lalu lanjutkan',
  failed: 'dijeda karena item terakhir gagal / dihentikan',
  rate_limit: 'dijeda karena batas pemakaian akun Claude tercapai',
  budget: 'dijeda karena batas token/biaya antrian tercapai',
};
/** Pauses the user didn't ask for: announced once with a toast. */
const WARN_REASONS = new Set(['failed', 'rate_limit', 'budget']);
/** Budget ranges, same as the server's (src/queue.js); the server stays the judge. */
const BUDGET_RANGE = { tokensOut: [1000, 100_000_000], costUsd: [0.01, 10_000] };
/** The open dialog: which project, its queue as last fetched, the item being edited, the budget the fields show. */
export const queueView = { project: null, data: null, editing: null, rev: -1, loading: false, budgetKey: null, budgetOpened: false };
const lastReason = new Map(); // project -> pause reason last seen (a new failure/limit pause gets a toast)

const canEdit = () => !state.readOnly;

// ---------- session bar chip ----------

/** The 📋 chip: shown while the project has a queue (waiting count, or ⏸ when paused). Called from renderComposer. */
export function renderQueueChip(st) {
  const s = state.active === DEMO_ID ? null : st?.taskQueue;
  const chip = $('#sb-queue');
  const show = Boolean(s && (s.waiting || s.running || s.failed || s.paused)); // only finished items: nothing to show
  chip.hidden = !show;
  $('#session-bar').classList.toggle('has-queue', show);
  noticePause(state.active, s);
  if (show) {
    const left = s.waiting + s.running;
    $('#sb-queue-n').textContent = s.paused ? `⏸ ${left}` : String(left);
    chip.classList.toggle('paused', Boolean(s.paused));
    const paused = !s.paused ? '' : s.reason === 'budget' ? ', dijeda karena batas token/biaya tercapai' : ', dijeda';
    chip.setAttribute('aria-label', `Antrian: ${left} belum selesai${paused} — buka antrian`);
  }
  // The dialog follows the server: a new revision (an item finished, someone reordered) is fetched again.
  if (!$('#queue-modal').hidden && queueView.project === state.active && s && s.rev !== queueView.rev && !queueView.loading) loadQueue();
}

/** A pause the user didn't ask for (failure, usage limit, budget) is announced once. */
function noticePause(project, s) {
  const reason = s?.paused ? s.reason : null;
  const prev = lastReason.get(project);
  lastReason.set(project, reason);
  if (prev === undefined || reason === prev || !WARN_REASONS.has(reason)) return;
  toast(`📋 Antrian ${projectName(project)} ${REASON_LABEL[reason]}.`, 'warn');
}

// ---------- dialog ----------

export async function openQueue({ focusAdd = false } = {}) {
  if (state.active === DEMO_ID) return toast('Pilih project dulu — demo tidak punya antrian.');
  queueView.project = state.active;
  queueView.editing = null;
  queueView.budgetKey = null; // prefill the budget fields again
  queueView.budgetOpened = false;
  setBudgetOpen(false);
  showBudgetError('');
  $('#queue-project').textContent = `· ${projectName(state.active)}`;
  openModal('queue-modal');
  await loadQueue();
  if (focusAdd && canEdit()) $('#queue-new').focus();
}

async function loadQueue() {
  const project = queueView.project;
  queueView.loading = true;
  try {
    const { queue } = await api(`/api/projects/${project}/queue`);
    if (project !== queueView.project) return;
    show(queue);
  } catch (err) {
    $('#queue-list').innerHTML = `<li class="state-error">Gagal memuat antrian: ${escapeHtml(err.message)}</li>`;
  } finally {
    queueView.loading = false;
  }
}

function show(queue) {
  queueView.data = queue;
  queueView.rev = state.statuses[queue.project]?.taskQueue?.rev ?? queueView.rev;
  renderQueue();
}

/** Sends one change; the answer is the queue as the server has it now. */
async function change(op, body = {}) {
  if (!canEdit()) return toast(`${READ_ONLY_HINT}.`);
  try {
    const { queue } = await api(`/api/projects/${queueView.project}/queue-${op}`, body);
    show(queue);
    return true;
  } catch (err) {
    toast(err.message);
    if (/berubah|tidak ditemukan/.test(err.message)) loadQueue(); // stale list: take the server's
    return false;
  }
}

const waitingIds = () => queueView.data.items.filter((i) => i.status === 'waiting').map((i) => i.id);

function move(itemId, to) {
  const order = waitingIds().filter((id) => id !== itemId);
  order.splice(Math.max(0, Math.min(order.length, to)), 0, itemId);
  return change('reorder', { order });
}

function renderQueue() {
  const q = queueView.data;
  if (!q) return;
  const st = state.statuses[q.project] ?? {};
  const waiting = q.items.filter((i) => i.status === 'waiting');
  const running = q.items.some((i) => i.status === 'running');
  const edit = canEdit();

  // State line + pause/resume
  let line;
  if (q.paused) line = `⏸ ${REASON_LABEL[q.reason] ?? 'dijeda'}.`;
  else if (running) line = '▶ Menjalankan item berikutnya otomatis setiap kali giliran selesai.';
  else if (!waiting.length) line = 'Antrian kosong. Tambahkan prompt di bawah: dijalankan satu per satu saat tim tidak sibuk.';
  else if (st.interrupted) line = '⏳ Menunggu: ada giliran yang terputus — pilih “Lanjutkan” atau tutup pemberitahuannya di chat.';
  else if (st.pending) line = '⏳ Menunggu izinmu dijawab di chat.';
  else if (st.busy || st.cliBusy || st.queue) line = '⏳ Menunggu tim selesai, lalu item berikutnya dikirim.';
  else line = '▶ Item berikutnya segera dikirim.';
  $('#queue-state').textContent = line;
  $('#queue-state').classList.toggle('warn', Boolean(q.paused && q.reason !== 'user'));
  const toggle = $('#queue-toggle');
  toggle.textContent = q.paused ? '▶ Lanjutkan' : '⏸ Jeda';
  toggle.hidden = !q.paused && !waiting.length && !running;
  toggle.disabled = !edit;
  $('#queue-clear').hidden = !q.items.some((i) => i.status === 'done' || i.status === 'failed');
  $('#queue-clear').disabled = !edit;
  $('#queue-count').textContent = `${waiting.length + (running ? 1 : 0)}/${q.limits.items} belum selesai`;

  const list = $('#queue-list');
  if (!q.items.length) {
    list.innerHTML = '<li class="queue-empty muted">Belum ada item.</li>';
  } else {
    list.innerHTML = q.items.map((item) => itemHtml(item, waiting, edit)).join('');
  }
  for (const id of ['#queue-new', '#queue-add']) {
    $(id).disabled = !edit;
    $(id).title = edit ? '' : READ_ONLY_HINT;
  }
  renderBudget(q, edit);
}

// ---------- budget (Batas antrian) ----------

/** A count from the server: a finite number >= 0, else null (never trust the payload blindly). */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const usd = (n) => `$${n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The budget as shown: limits (null = not set, 0 counts as not set) and what was spent since it was set. */
function readBudget(b) {
  return { tokensOut: num(b?.tokensOut) || null, costUsd: num(b?.costUsd) || null, spentTokensOut: num(b?.spentTokensOut) ?? 0, spentCostUsd: num(b?.spentCostUsd) ?? 0 };
}

/** "12,3 rb / 50 rb token output · $0,42 / $5,00" and the highest spent/limit ratio; null without any limit. */
export function budgetUsage(raw) {
  const b = readBudget(raw);
  const parts = [];
  const ratios = [];
  if (b.tokensOut) {
    parts.push(`${fmtShort(b.spentTokensOut)} / ${fmtShort(b.tokensOut)} token output`);
    ratios.push(b.spentTokensOut / b.tokensOut);
  }
  if (b.costUsd) {
    parts.push(`${usd(b.spentCostUsd)} / ${usd(b.costUsd)}`);
    ratios.push(b.spentCostUsd / b.costUsd);
  }
  return parts.length ? { text: parts.join(' · '), ratio: Math.max(...ratios) } : null;
}

/**
 * The two fields → the POST body, or why it can't be sent. An empty field = no limit of that kind.
 * `bad` flags a field the browser couldn't read as a number (an input type=number then reports "").
 */
export function parseBudget(tokensText, costText, bad = {}) {
  const tok = String(tokensText ?? '').trim();
  const cost = String(costText ?? '').trim();
  const [tMin, tMax] = BUDGET_RANGE.tokensOut;
  const [cMin, cMax] = BUDGET_RANGE.costUsd;
  const tokensOut = tok === '' ? null : Number(tok);
  const costUsd = cost === '' ? null : Number(cost);
  if (bad.tokens || (tokensOut !== null && !(Number.isInteger(tokensOut) && tokensOut >= tMin && tokensOut <= tMax))) {
    return { field: 'tokens', error: `Maks token output harus bilangan bulat ${tMin.toLocaleString('id-ID')}–${tMax.toLocaleString('id-ID')}.` };
  }
  if (bad.cost || (costUsd !== null && !(Number.isFinite(costUsd) && costUsd >= cMin && costUsd <= cMax))) {
    return { field: 'cost', error: `Maks biaya harus antara ${usd(cMin)} dan ${usd(cMax)}.` };
  }
  if (tokensOut === null && costUsd === null) return { field: 'tokens', error: 'Isi minimal satu batas, atau pakai “Hapus batas”.' };
  return { body: { tokensOut, costUsd: costUsd === null ? null : Math.round(costUsd * 100) / 100 } };
}

/** Disclosure for the budget form (a button + `hidden`, not <details>: the modal Tab trap skips [hidden] content). */
function setBudgetOpen(open) {
  $('#qb-body').hidden = !open;
  $('#qb-toggle').setAttribute('aria-expanded', String(open));
}

function showBudgetError(message, field) {
  const box = $('#qb-error');
  box.textContent = message;
  box.hidden = !message;
  $('#qb-tokens').setAttribute('aria-invalid', String(Boolean(message) && field === 'tokens'));
  $('#qb-cost').setAttribute('aria-invalid', String(Boolean(message) && field === 'cost'));
}

function renderBudget(q, edit) {
  const b = readBudget(q.budget);
  const usage = budgetUsage(b);
  const label = $('#qb-usage');
  const bar = $('#qb-bar');
  const level = !usage ? '' : usage.ratio >= 1 ? 'over' : usage.ratio >= 0.8 ? 'warn' : '';
  label.textContent = usage ? usage.text : 'tanpa batas';
  label.classList.toggle('muted', !level);
  for (const n of [label, bar]) {
    n.classList.toggle('warn', level === 'warn');
    n.classList.toggle('over', level === 'over');
  }
  bar.hidden = !usage;
  if (usage) {
    const pct = Math.min(100, Math.round(usage.ratio * 100)); // aria-valuenow must stay within min..max
    bar.setAttribute('aria-valuenow', String(pct));
    bar.setAttribute('aria-valuetext', `${Math.round(usage.ratio * 100)}% dari batas${level === 'over' ? ' (terlampaui)' : ''}`);
    bar.firstElementChild.style.width = `${pct}%`;
  }
  // Prefill when the limits differ from what the fields last showed, but never while the user is typing in them.
  const key = `${b.tokensOut}|${b.costUsd}`;
  const typing = document.activeElement?.matches?.('#qb-tokens, #qb-cost');
  if (key !== queueView.budgetKey && !typing) {
    queueView.budgetKey = key;
    $('#qb-tokens').value = b.tokensOut ?? '';
    $('#qb-cost').value = b.costUsd ?? '';
  }
  // Paused by the budget: open the section once so the limit can be raised (or removed) right away.
  const budgetPause = Boolean(q.paused && q.reason === 'budget');
  if (budgetPause && !queueView.budgetOpened) setBudgetOpen(true);
  queueView.budgetOpened = budgetPause;
  for (const id of ['#qb-tokens', '#qb-cost', '#qb-save', '#qb-clear']) {
    $(id).disabled = !edit || (id === '#qb-clear' && !usage);
    $(id).title = edit ? '' : READ_ONLY_HINT;
  }
}

async function saveBudget(e) {
  e.preventDefault();
  const tokens = $('#qb-tokens');
  const cost = $('#qb-cost');
  const parsed = parseBudget(tokens.value, cost.value, { tokens: tokens.validity.badInput, cost: cost.validity.badInput });
  if (parsed.error) {
    showBudgetError(parsed.error, parsed.field);
    return (parsed.field === 'cost' ? cost : tokens).focus();
  }
  showBudgetError('');
  queueView.budgetKey = null; // the fields take the saved values back from the server
  if (await change('budget', parsed.body)) toast('💰 Batas antrian disimpan — hitungan dimulai dari nol.', 'ok');
}

async function clearBudget() {
  showBudgetError('');
  queueView.budgetKey = null;
  if (await change('budget', { tokensOut: null, costUsd: null })) toast('💰 Batas antrian dihapus.', 'ok');
}

function itemHtml(item, waiting, edit) {
  const pos = waiting.findIndex((w) => w.id === item.id);
  const isWaiting = item.status === 'waiting';
  const editing = queueView.editing === item.id;
  const meta = [];
  if (item.status === 'running' && item.startedAt) meta.push(`mulai ${ago(item.startedAt)}`);
  if ((item.status === 'done' || item.status === 'failed') && item.endedAt) meta.push(ago(item.endedAt));
  if (item.meta?.durationMs) meta.push(`${Math.max(1, Math.round(item.meta.durationMs / 1000))} dtk`);
  if (item.meta?.costUsd) meta.push(`$${item.meta.costUsd.toFixed(2)}`);
  const act = (name, label, title, extra = '') => `<button type="button" class="ghost icon" data-act="${name}" title="${title}" aria-label="${title}"${extra}>${label}</button>`;
  const actions = [];
  if (isWaiting && edit && !editing) {
    actions.push(act('up', '↑', 'Naikkan', pos <= 0 ? ' disabled' : ''), act('down', '↓', 'Turunkan', pos >= waiting.length - 1 ? ' disabled' : ''), act('edit', '✎', 'Ubah'), act('remove', '🗑', 'Hapus'));
  }
  if (item.status === 'failed' && edit) actions.push(`<button type="button" class="ghost" data-act="retry" title="Kembalikan ke depan antrian">↻ Ulangi</button>`);
  if ((item.status === 'done' || item.status === 'failed') && edit) actions.push(act('remove', '🗑', 'Hapus dari daftar'));
  if (item.chatId) actions.push(`<button type="button" class="ghost" data-act="open" title="Lihat prompt dan hasilnya di chat">💬 Lihat hasil</button>`);
  const body = editing
    ? `<textarea class="queue-edit" rows="4" maxlength="${queueView.data.limits.text}" aria-label="Ubah prompt">${escapeHtml(item.text)}</textarea>
       <div class="queue-edit-actions"><button type="button" class="ghost" data-act="cancel">Batal</button><button type="button" class="primary" data-act="save">Simpan</button></div>`
    : `<div class="queue-text">${escapeHtml(item.text)}</div>`;
  return `<li class="queue-item ${item.status}" data-id="${item.id}"${isWaiting && edit && !editing && !narrow.matches ? ' draggable="true"' : ''}>
    <span class="queue-pos" aria-hidden="true">${isWaiting ? pos + 1 : item.status === 'running' ? '▶' : item.status === 'done' ? '✓' : '✕'}</span>
    <div class="queue-main">
      ${body}
      <div class="queue-meta"><span class="queue-badge ${item.status}">${STATUS_LABEL[item.status]}</span>${meta.length ? ` <span class="muted">${escapeHtml(meta.join(' · '))}</span>` : ''}${item.error ? ` <span class="queue-error">${escapeHtml(item.error)}</span>` : ''}</div>
    </div>
    <div class="queue-actions">${actions.join('')}</div>
  </li>`;
}

/** "💬 Lihat hasil": the prompt's bubble in the chat (its reply follows it). */
function openInChat(item) {
  $('#queue-modal').hidden = true;
  if (narrow.matches) setMobileView('chat');
  const node = [...document.querySelectorAll('#chat [data-id]')].find((n) => n.dataset.id === item.chatId);
  if (!node) return toast('Pesan itu sudah di luar jendela chat. Lihat lewat 🕘 Riwayat sesi.', 'warn');
  node.scrollIntoView({ block: 'start', behavior: 'smooth' });
  node.classList.add('queue-flash');
  setTimeout(() => node.classList.remove('queue-flash'), 2000);
}

async function addNew() {
  const input = $('#queue-new');
  const text = input.value.trim();
  if (!text) return input.focus();
  if (await change('add', { text })) {
    input.value = '';
    input.focus();
  }
}

// ---------- from the composer ----------

/** 📋 next to Kirim / Alt+Enter: what is typed goes into the queue instead of being sent now. Empty box: open the list. */
export async function queueFromComposer() {
  if (state.readOnly || state.active === DEMO_ID) return;
  const input = $('#prompt');
  const text = input.value.trim();
  if (!text) return openQueue({ focusAdd: true });
  if (text.startsWith('!') || /^\/[\w-]+/.test(text)) return toast('Perintah ! dan /command tidak bisa diantrekan — kirim langsung saja.');
  try {
    const { queue } = await api(`/api/projects/${state.active}/queue-add`, { text });
    input.value = '';
    autosize();
    updateBashMode();
    scheduleDraftSave();
    const left = queue.items.filter((i) => i.status === 'waiting').length;
    toast(`📋 Ditambahkan ke antrian (${left} menunggu${queue.paused ? ', antrian sedang dijeda' : ''}).`, 'ok');
  } catch (err) {
    toast(`Gagal menambah ke antrian: ${err.message}`);
  }
}

export function initQueue() {
  $('#sb-queue').addEventListener('click', () => openQueue());
  $('#btn-queue-add').addEventListener('click', queueFromComposer);
  // Alt+Enter in the prompt box: add to the queue (Enter sends, Shift+Enter is a new line). Registered before the
  // composer's own keydown (app.js order) and stops it, so the composer never also sends the text.
  $('#prompt').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    queueFromComposer();
  });
  $('#queue-add').addEventListener('click', addNew);
  $('#queue-new').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.altKey)) {
      e.preventDefault();
      addNew();
    }
  });
  $('#queue-toggle').addEventListener('click', () => change('pause', { paused: !queueView.data?.paused }));
  $('#queue-clear').addEventListener('click', () => change('clear'));
  $('#qb-toggle').addEventListener('click', () => setBudgetOpen($('#qb-body').hidden));
  $('#qb-form').addEventListener('submit', saveBudget);
  $('#qb-clear').addEventListener('click', clearBudget);
  for (const id of ['#qb-tokens', '#qb-cost']) $(id).addEventListener('input', () => showBudgetError(''));

  const list = $('#queue-list');
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    const li = btn?.closest('li[data-id]');
    if (!btn || !li || !queueView.data) return;
    const item = queueView.data.items.find((i) => i.id === li.dataset.id);
    if (!item) return;
    const pos = waitingIds().indexOf(item.id);
    switch (btn.dataset.act) {
      case 'up':
        return move(item.id, pos - 1).then(() => list.querySelector(`li[data-id="${item.id}"] [data-act="up"]:not(:disabled)`)?.focus());
      case 'down':
        return move(item.id, pos + 1).then(() => list.querySelector(`li[data-id="${item.id}"] [data-act="down"]:not(:disabled)`)?.focus());
      case 'edit':
        queueView.editing = item.id;
        renderQueue();
        return list.querySelector('.queue-edit')?.focus();
      case 'cancel':
        queueView.editing = null;
        return renderQueue();
      case 'save': {
        const text = list.querySelector('.queue-edit').value;
        return change('update', { itemId: item.id, text }).then((ok) => {
          if (ok) {
            queueView.editing = null;
            renderQueue();
          }
        });
      }
      case 'remove':
        return change('remove', { itemId: item.id });
      case 'retry':
        return change('retry', { itemId: item.id });
      case 'open':
        return openInChat(item);
    }
  });
  list.addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('queue-edit')) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.target.closest('li').querySelector('[data-act="save"]').click();
    }
  });

  // Drag to reorder (desktop; phones use ↑↓): only between waiting items.
  let dragged = null;
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('li[draggable="true"]');
    if (!li) return;
    dragged = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged);
  });
  list.addEventListener('dragover', (e) => {
    const li = e.target.closest('li.waiting');
    if (!dragged || !li) return;
    e.preventDefault();
    for (const n of list.querySelectorAll('.drop-before, .drop-after')) n.classList.remove('drop-before', 'drop-after');
    const box = li.getBoundingClientRect();
    li.classList.add(e.clientY < box.top + box.height / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('drop', (e) => {
    const li = e.target.closest('li.waiting');
    if (!dragged || !li) return;
    e.preventDefault();
    const after = li.classList.contains('drop-after');
    const order = waitingIds().filter((id) => id !== dragged);
    let at = order.indexOf(li.dataset.id);
    if (at < 0) at = order.length;
    else if (after) at += 1;
    move(dragged, at);
  });
  list.addEventListener('dragend', () => {
    dragged = null;
    for (const n of list.querySelectorAll('.dragging, .drop-before, .drop-after')) n.classList.remove('dragging', 'drop-before', 'drop-after');
  });
}
