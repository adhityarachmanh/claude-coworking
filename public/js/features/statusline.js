// Above and below the composer: Claude's todo list and the status line (mode, model, context).
import { $, escapeHtml } from '../core/dom.js';
import { fmtTokens } from '../core/format.js';
import { DEMO_ID, state } from '../core/state.js';
import { openTasks } from './tasks.js';

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
  box.innerHTML = `<button class="todos-head" type="button" title="Sembunyikan / tampilkan daftar tugas">${collapsed ? '▸' : '▾'} Daftar tugas <small>${done}/${todos.length}</small></button>${
    collapsed
      ? ''
      : `<ul>${todos
          .map((t) => `<li class="st-${t.status}"><span>${mark[t.status] ?? '☐'}</span>${escapeHtml(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}</li>`)
          .join('')}</ul>`
  }`;
}

const MODE_LABEL = { manual: '🛡️ tanya dulu', acceptEdits: '✏️ auto-edit file', plan: '📋 rencana dulu', auto: '⚡ auto', dontAsk: '🚫 jangan tanya' };
export const MODE_CYCLE = ['manual', 'acceptEdits', 'plan', 'auto']; // Shift+Tab order, as in the CLI

/** Status line under the composer: permission mode, model, and how full the context is. */
export function renderStatusline(st) {
  const line = $('#statusline');
  if (state.active === DEMO_ID) {
    line.innerHTML = '';
    return;
  }
  const parts = [`<span class="sl-mode" title="Ganti dengan Shift+Tab">${MODE_LABEL[st.mode ?? 'manual']} <kbd>⇧Tab</kbd></span>`];
  const model = st.activeModel || st.model;
  if (model) parts.push(`<span>${escapeHtml(model)}</span>`);
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
  const running = (st.tasks ?? []).filter((t) => t.status === 'running' && t.background).length;
  if (running) parts.push(`<button type="button" class="sl-tasks" data-open-tasks title="Lihat tugas latar (/tasks)">⧗ ${running} tugas latar</button>`);
  line.innerHTML = parts.join('<span class="sep">·</span>');
}

export function initStatusline() {
  $('#todos').addEventListener('click', (e) => {
    if (!e.target.closest('.todos-head')) return;
    $('#todos').classList.toggle('collapsed');
    renderTodos(state.statuses[state.active] ?? {});
  });

  $('#statusline').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-tasks]')) openTasks();
  });
}
