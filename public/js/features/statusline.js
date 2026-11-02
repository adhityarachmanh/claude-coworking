// Above and below the composer: Claude's todo list and the status line (mode, model, context).
import { $, escapeHtml, narrow } from '../core/dom.js';
import { fmtTokens } from '../core/format.js';
import { DEMO_ID, state } from '../core/state.js';
import { connection } from './connection.js';
import { openQueue } from './queue.js';
import { openTasks, runningCount } from './tasks.js';

/** Claude's todo list, pinned above the composer while there is work left (CLI: ☐ ◼ ☒). */
export function renderTodos(st) {
  const box = $('#todos');
  const todos = state.active === DEMO_ID ? [] : (st.todos ?? []);
  const done = todos.filter((t) => t.status === 'completed').length;
  // Like the CLI: the list goes away once everything is done and the turn has ended.
  if (!todos.length || (done === todos.length && !st.busy)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const collapsed = box.classList.contains('collapsed');
  const mark = { completed: '☒', in_progress: '◼' };
  const now = todos.find((t) => t.status === 'in_progress');
  // Phone, folded: one line "◼ 2/5 Menulis test ▸" (what is being done right now).
  const head = narrow.matches && collapsed
    ? `<button class="todos-head" type="button" aria-expanded="false" aria-label="Daftar tugas ${done} dari ${todos.length} selesai${now ? `, sekarang: ${escapeHtml(now.activeForm || now.content)}` : ''} — tampilkan">◼ <small>${done}/${todos.length}</small> <span class="todos-now">${escapeHtml(now ? now.activeForm || now.content : 'Daftar tugas')}</span> ▸</button>`
    : `<button class="todos-head" type="button" title="Sembunyikan / tampilkan daftar tugas"${narrow.matches ? ' aria-expanded="true"' : ''}>${collapsed ? '▸' : '▾'} Daftar tugas <small>${done}/${todos.length}</small></button>`;
  box.innerHTML = `${head}${
    collapsed
      ? ''
      : `<ul>${todos
          .map((t) => `<li class="st-${t.status}"><span>${mark[t.status] ?? '☐'}</span>${escapeHtml(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}</li>`)
          .join('')}</ul>`
  }`;
}

/** Short labels for the phone's settings chip (features/composer.js). */
export const MODE_SHORT = { manual: '🛡️ Tanya dulu', acceptEdits: '✏️ Auto-edit', plan: '📋 Rencana', auto: '⚡ Auto', dontAsk: '🚫 Jangan tanya' };

const MODE_LABEL = { manual: '🛡️ tanya dulu', acceptEdits: '✏️ auto-edit file', plan: '📋 rencana dulu', auto: '⚡ auto', dontAsk: '🚫 jangan tanya' };
export const MODE_CYCLE = ['manual', 'acceptEdits', 'plan', 'auto']; // Shift+Tab order, as in the CLI

/** Status line under the composer: permission mode, model, and how full the context is. */
export function renderStatusline(st) {
  const line = $('#statusline');
  if (state.active === DEMO_ID) {
    line.innerHTML = '';
    line.classList.remove('has-chips');
    return;
  }
  const parts = [`<span class="sl-mode" title="Ganti dengan Shift+Tab">${MODE_LABEL[st.mode ?? 'manual']} <kbd>⇧Tab</kbd></span>`];
  const model = st.activeModel || st.model;
  if (model) parts.push(`<span class="sl-model">${escapeHtml(model)}</span>`);
  if (st.context?.used && !st.context.window) {
    // Window not reported yet (Claude Code tells it once the session runs): no guessed percentage.
    parts.push(`<span class="sl-ctx" title="Konteks terpakai: ${st.context.used.toLocaleString('id-ID')} token">konteks ${fmtTokens(st.context.used)}</span>`);
  } else if (st.context?.used) {
    const win = st.context.window; // as /context counts it
    const pct = Math.min(100, Math.round((st.context.used / win) * 100));
    // Warn like the CLI does: relative to where auto-compact kicks in, not the hard limit.
    const limit = st.context.autoCompactAt || win;
    const nearCompact = st.context.used / limit;
    const level = nearCompact >= 0.9 ? 'high' : nearCompact >= 0.7 ? 'mid' : '';
    const compactNote = st.context.autoCompactAt ? ` · auto-compact pada ${fmtTokens(st.context.autoCompactAt)}` : '';
    parts.push(
      `<span class="sl-ctx ${level}" title="Konteks terpakai: ${st.context.used.toLocaleString('id-ID')} dari ${win.toLocaleString('id-ID')} token${compactNote}${level ? ' · pertimbangkan /compact' : ''}"><span class="bar"><i style="width:${pct}%"></i></span>konteks ${pct}% · ${fmtTokens(st.context.used)}/${fmtTokens(win)}</span>`,
    );
  }
  const running = runningCount(st); // same count as the ⧗ chip in the session bar
  if (running) parts.push(`<button type="button" class="sl-tasks" data-open-tasks title="Buka monitor tugas latar (/tasks)">⧗ ${running} tugas berjalan</button>`);
  if (narrow.matches) return renderStrip(line, st, running);
  line.innerHTML = parts.join('<span class="sep">·</span>');
}

/** Phone: a strip of chips above the box, only with something to say (mode and model are on the settings chip). */
function renderStrip(line, st, running) {
  const chips = [];
  if (running) chips.push(`<button type="button" class="sl-chip sl-tasks" data-open-tasks aria-label="${running} tugas berjalan — buka monitor tugas latar">⧗ ${running}</button>`);
  const q = st.taskQueue;
  const waiting = q ? q.waiting + q.running : 0;
  if (waiting) chips.push(`<button type="button" class="sl-chip" data-open-queue aria-label="Antrian: ${waiting} belum selesai${q.paused ? ', dijeda' : ''} — buka antrian">📋 ${q.paused ? '⏸ ' : ''}${waiting}</button>`);
  if (st.pending) chips.push('<button type="button" class="sl-chip sl-ask" data-jump-approval>✋ Menunggu izinmu</button>');
  if (st.autoApprove) chips.push('<span class="sl-chip sl-warn">⚠ Semua izin otomatis</span>');
  if (!connection.online) chips.push('<span class="sl-chip sl-warn">⚡ Belum tersambung</span>');
  // Context only once it matters (≥ 70 % of where auto-compact starts), as text: the /compact tip stays in the title.
  const ctx = st.context;
  if (ctx?.used && ctx.window) {
    const near = ctx.used / (ctx.autoCompactAt || ctx.window);
    const pct = Math.min(100, Math.round((ctx.used / ctx.window) * 100));
    if (near >= 0.7) chips.push(`<span class="sl-chip sl-ctx ${near >= 0.9 ? 'high' : 'mid'}" title="Konteks terpakai ${pct}% · pertimbangkan /compact">konteks ${pct}%</span>`);
  }
  line.classList.toggle('has-chips', chips.length > 0);
  line.innerHTML = chips.join('');
}

/** ✋ chip: the newest waiting permission card, scrolled into view with its first answer button focused. */
function jumpToApproval() {
  const card = [...document.querySelectorAll('#chat .approval.pending')].at(-1);
  if (!card) return;
  card.scrollIntoView({ block: 'center' });
  card.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

export function initStatusline() {
  if (narrow.matches) $('#todos').classList.add('collapsed'); // phone: folded by default, the user's toggle then sticks
  narrow.addEventListener('change', () => {
    const st = state.statuses[state.active] ?? {};
    $('#statusline').classList.remove('has-chips');
    renderTodos(st);
    renderStatusline(st);
  });

  $('#todos').addEventListener('click', (e) => {
    if (!e.target.closest('.todos-head')) return;
    $('#todos').classList.toggle('collapsed');
    renderTodos(state.statuses[state.active] ?? {});
  });

  $('#statusline').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-tasks]')) openTasks();
    else if (e.target.closest('[data-open-queue]')) openQueue();
    else if (e.target.closest('[data-jump-approval]')) jumpToApproval();
  });
}
