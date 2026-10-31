// Tasks (/tasks, Ctrl+B): Bash commands and subagents Claude Code runs.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { fmtTokens } from '../core/format.js';
import { DEMO_ID, READ_ONLY_HINT, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

export const tasksView = { project: null, outputs: new Map() };
const TASK_STATE = { completed: 'selesai', failed: 'gagal', stopped: 'dihentikan', killed: 'dihentikan', paused: 'dijeda', pending: 'menunggu' };

export function openTasks() {
  if (state.active === DEMO_ID) return;
  tasksView.project = state.active;
  tasksView.outputs.clear();
  renderTasks();
  openModal('tasks-modal');
}

export function renderTasks() {
  const st = state.statuses[tasksView.project] ?? {};
  const tasks = st.tasks ?? [];
  $('#tasks-background').disabled = !st.busy || Boolean(state.readOnly);
  if (!tasks.length) {
    $('#tasks-list').innerHTML = '<li class="muted">Belum ada tugas di sesi ini. Tugas muncul saat Claude menjalankan perintah atau agent, misalnya dev server di latar belakang.</li>';
    return;
  }
  $('#tasks-list').innerHTML = tasks
    .map((t) => {
      const running = t.status === 'running';
      const meta = [t.agent, running ? (t.background ? 'berjalan di latar' : 'berjalan') : (TASK_STATE[t.status] ?? t.status), t.toolUses ? `${t.toolUses} langkah` : '', t.tokens ? `${fmtTokens(t.tokens)} token` : '']
        .filter(Boolean)
        .join(' · ');
      const out = tasksView.outputs.get(t.id);
      return `<li data-task="${escapeHtml(t.id)}"><div class="task-row">${t.kind === 'agent' ? '🤖' : '🖥'} <b>${escapeHtml(t.description || t.id)}</b>${running ? '<span class="spinner"></span>' : ''}</div><small class="muted">${escapeHtml(meta)}${t.summary ? ` — ${escapeHtml(t.summary)}` : ''}${t.error ? ` — ${escapeHtml(t.error)}` : ''}</small><div class="task-actions">${t.kind === 'shell' ? `<button data-task-act="output">📄 ${out != null ? 'Muat ulang output' : 'Lihat output'}</button>` : ''}${running ? `<button class="danger" data-task-act="stop" ${state.readOnly ? `disabled title="${READ_ONLY_HINT}"` : ''}>■ Hentikan</button>` : ''}</div>${out != null ? `<pre class="task-out">${escapeHtml(out || '(belum ada output)')}</pre>` : ''}</li>`;
    })
    .join('');
}

export function backgroundRunning() {
  api(`/api/projects/${state.active}/background`)
    .then(() => toast('Dipindahkan ke latar belakang. Kamu bisa lanjut chat.', 'ok'))
    .catch((err) => toast(err.message));
}

export function initTasks() {
  $('#tasks-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-task-act]');
    if (!btn) return;
    const taskId = btn.closest('[data-task]').dataset.task;
    btn.disabled = true;
    try {
      if (btn.dataset.taskAct === 'output') {
        const r = await api(`/api/projects/${tasksView.project}/task-output`, { taskId });
        tasksView.outputs.set(taskId, `${r.truncated ? '… (hanya 8 KB terakhir)\n' : ''}${r.output ?? ''}`);
      } else {
        await api(`/api/projects/${tasksView.project}/task-stop`, { taskId });
        toast('Tugas dihentikan.', 'ok');
      }
    } catch (err) {
      toast(err.message);
    }
    renderTasks();
  });

  $('#tasks-background').addEventListener('click', backgroundRunning);
}
