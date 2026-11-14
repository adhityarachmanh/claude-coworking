// Background task monitor (/tasks, Ctrl+B, the ⧗ chip, a busy character in the office):
// Bash commands and subagents Claude Code runs. List of tasks (running first) + a live detail:
// an agent's steps from its transcript (task-detail), a shell's output (task-output), polled every 2 s
// only while the dialog is open, the tab visible and the task still running.
import { api, toast } from '../core/api.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { fmtTokens } from '../core/format.js';
import { sceneFor } from '../core/scenes.js';
import { OUTPUT_POLL_MS, fetchTaskOutput, nearBottom, truncatedNote } from '../core/task-output.js';
import { DEMO_ID, READ_ONLY_HINT, state } from '../core/state.js';
import { copyText, flashButton } from '../core/util.js';
import { renderMarkdown } from '../markdown.js';
import { CAST } from '../office/cast.js';
import { W, room } from '../office/world.js';
import { openModal } from '../ui/modals.js';

const POLL_MS = OUTPUT_POLL_MS;
const TASK_STATE = { running: 'berjalan', completed: 'selesai', failed: 'gagal', stopped: 'dihentikan', killed: 'dihentikan', paused: 'dijeda', pending: 'menunggu' };

export const tasksView = {
  project: null,
  selected: null, // task id shown in the detail
  outputs: new Map(), // shell task id -> { text, truncated }
  details: new Map(), // agent task id -> task-detail answer
  errors: new Map(), // task id -> last fetch error
  pollTimer: null,
  tickTimer: null,
  othersTimer: null, // ⧗ OpenCode shells of other sessions in this folder (read-only, every 15 s)
  others: [],
  inflight: false,
  gen: 0, // bumped on every selection change / close: late answers for an old selection are dropped
  stick: true, // keep the detail scrolled to the newest line (off while the user reads further up)
  keys: { list: '', head: '', body: '' },
  lastStatus: null, // status of the selected task at the last render (running → done fetches once more)
};

// ---------- helpers ----------

const isRunning = (t) => t?.status === 'running' || t?.status === 'pending';
const isOpen = () => !$('#tasks-modal').hidden;

/** Running first, then finished ones, newest first. */
export function tasksOf(project) {
  const tasks = [...(state.statuses[project]?.tasks ?? [])];
  return tasks.sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0));
}

export const runningCount = (st) => (st?.tasks ?? []).filter(isRunning).length;

/** The newest running task of a role (the one a click on that character opens). Background ones first. */
export function taskForRole(project, role) {
  const mine = tasksOf(project).filter((t) => isRunning(t) && t.role === role);
  return mine.find((t) => t.background) ?? mine[0] ?? null;
}

/** "45 dtk", "2 mnt 13 dtk", "1 jam 5 mnt". */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} dtk`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt ${s % 60} dtk`;
  return `${Math.floor(s / 3600)} jam ${Math.floor((s % 3600) / 60)} mnt`;
}
const durationOf = (t) => (t.startedAt ? fmtDuration((t.endedAt ?? Date.now()) - t.startedAt) : '');
const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const stateLabel = (t) => (isRunning(t) ? (t.background ? 'berjalan di latar' : 'berjalan') : (TASK_STATE[t.status] ?? t.status ?? ''));
const icon = (t) => (t.kind === 'agent' ? '🤖' : '🖥');
const who = (t) => (t.role && CAST[t.role] ? CAST[t.role] : null);
const counts = (t) => [t.tokens ? `${fmtTokens(t.tokens)} token` : '', t.toolUses ? `${t.toolUses} langkah` : ''].filter(Boolean);
const selectedTask = () => tasksOf(tasksView.project).find((t) => t.id === tasksView.selected) ?? null;

// ---------- open / close ----------

/** Opens the monitor; `taskId` (or the running task of `role`) is shown right away. */
export function openTasks({ taskId = null, role = null } = {}) {
  if (state.active === DEMO_ID || !state.active) return;
  if (tasksView.project !== state.active) {
    tasksView.outputs.clear();
    tasksView.details.clear();
    tasksView.errors.clear();
  }
  tasksView.project = state.active;
  const tasks = tasksOf(state.active);
  const pick = (taskId && tasks.find((t) => t.id === taskId)) || (role && taskForRole(state.active, role)) || null;
  // Desktop shows list and detail side by side: start on the first task. A phone starts on the list.
  select(pick?.id ?? (narrow.matches ? null : (tasks[0]?.id ?? null)), { focus: false });
  openModal('tasks-modal');
  startTicker();
  startOthers();
  if (pick && narrow.matches) $('#td-back').focus({ preventScroll: true });
}

function stopAll() {
  clearTimeout(tasksView.pollTimer);
  clearInterval(tasksView.tickTimer);
  clearInterval(tasksView.othersTimer);
  tasksView.pollTimer = tasksView.tickTimer = tasksView.othersTimer = null;
  tasksView.gen++;
}

/** ⧗ OpenCode shells of other sessions in the project folder: visible (read-only), never selectable or stoppable. */
async function loadOtherShells() {
  if (!isOpen() || state.readOnly) return;
  const project = tasksView.project;
  try {
    const data = await api(`/api/projects/${project}/shells`);
    if (project !== tasksView.project || !isOpen()) return;
    tasksView.others = (Array.isArray(data?.shells) ? data.shells : []).filter((s) => s && !s.tracked);
  } catch {
    tasksView.others = []; // an older server or a read-only device: no extra section
  }
  renderTasks();
}

function startOthers() {
  clearInterval(tasksView.othersTimer);
  tasksView.others = [];
  loadOtherShells();
  tasksView.othersTimer = setInterval(() => {
    if (!isOpen()) return stopAll();
    loadOtherShells();
  }, 15_000);
}

function select(taskId, { focus = true } = {}) {
  tasksView.selected = taskId;
  tasksView.gen++;
  tasksView.stick = true;
  tasksView.keys = { list: '', head: '', body: '' };
  tasksView.lastStatus = selectedTask()?.status ?? null;
  clearTimeout(tasksView.pollTimer);
  tasksView.pollTimer = null;
  renderTasks();
  if (taskId) poll(0);
  if (focus && taskId && narrow.matches) $('#td-back').focus({ preventScroll: true });
}

// ---------- polling ----------

function poll(delay = POLL_MS) {
  clearTimeout(tasksView.pollTimer);
  tasksView.pollTimer = setTimeout(fetchSelected, delay);
}

async function fetchSelected() {
  tasksView.pollTimer = null;
  const task = selectedTask();
  if (!task || !isOpen() || document.hidden) return;
  if (tasksView.inflight) return poll(); // the previous answer is still on its way
  const gen = tasksView.gen;
  const project = tasksView.project;
  tasksView.inflight = true;
  try {
    if (task.kind === 'agent') {
      tasksView.details.set(task.id, await api(`/api/projects/${project}/task-detail`, { taskId: task.id }));
    } else {
      tasksView.outputs.set(task.id, await fetchTaskOutput(project, task.id));
    }
    tasksView.errors.delete(task.id);
  } catch (err) {
    tasksView.errors.set(task.id, err.message);
  } finally {
    tasksView.inflight = false;
  }
  if (gen !== tasksView.gen || !isOpen()) return;
  renderDetail();
  if (isRunning(selectedTask())) poll();
}

// ---------- rendering ----------

/** The ⧗ chip in the session bar: how many tasks are running; hidden at 0. */
export function renderTaskChip(st) {
  const n = state.active === DEMO_ID ? 0 : runningCount(st);
  const chip = $('#sb-tasks');
  chip.hidden = n === 0;
  $('#session-bar').classList.toggle('has-tasks', n > 0);
  if (!n) return;
  $('#sb-tasks-n').textContent = String(n);
  chip.setAttribute('aria-label', `${n} tugas berjalan — buka monitor tugas latar`);
}

/** Redraws what changed: called on every status update while the dialog is open. */
export function renderTasks() {
  const st = state.statuses[tasksView.project] ?? {};
  const tasks = tasksOf(tasksView.project);
  const running = tasks.filter(isRunning).length;
  $('#tasks-background').disabled = !st.busy || Boolean(state.readOnly);
  $('#tasks-summary').textContent = tasks.length ? `${running} berjalan · ${tasks.length - running} selesai` : '';
  if (tasksView.selected && !tasks.some((t) => t.id === tasksView.selected)) tasksView.selected = null; // cleaned up server-side
  // Desktop: list and detail side by side, so the detail is never left empty while there is a task to show.
  if (!tasksView.selected && tasks.length && !narrow.matches && isOpen()) return select(tasks[0].id, { focus: false });
  $('#tasks-body').classList.toggle('empty', !tasks.length);
  $('#tasks-body').classList.toggle('show-detail', Boolean(tasksView.selected));
  renderList(tasks);
  renderDetail();
  // The selected task just ended: one last fetch for its final steps / report / output.
  const task = selectedTask();
  if (task && tasksView.lastStatus !== task.status) {
    const ended = isRunning({ status: tasksView.lastStatus }) && !isRunning(task);
    tasksView.lastStatus = task.status;
    if (ended && isOpen()) poll(0);
  }
}

function renderList(tasks) {
  const others = tasksView.others ?? [];
  const key = JSON.stringify([
    tasks.map((t) => [t.id, t.status, t.background, t.description, t.role, t.tokens, t.toolUses, t.endedAt]),
    others.map((s) => [s.id, s.status, s.command, s.startedAt]),
    tasksView.selected,
    Object.values(CAST).map((c) => c.name),
  ]);
  if (key === tasksView.keys.list) return;
  tasksView.keys.list = key;
  const list = $('#tasks-list');
  if (!tasks.length && !others.length) {
    list.innerHTML = '<li class="tasks-empty muted">Belum ada tugas di sesi ini. Tugas muncul saat mesin AI menjalankan perintah atau agent, misalnya dev server atau agent di latar belakang.</li>';
    return;
  }
  const focused = document.activeElement?.closest?.('#tasks-list [data-task]')?.dataset.task;
  // Live vs done at a glance: running keeps its spinner (and its live ⏱), a finished row gets its own mark.
  const stateMark = (t) => ({ completed: ['✓', 'ok'], failed: ['✗', 'bad'], stopped: ['■', 'muted'], killed: ['■', 'bad'], paused: ['⏸', 'muted'] }[t.status] ?? ['•', 'muted']);
  const item = (t) => {
    const c = who(t);
    const meta = [stateLabel(t), ...counts(t)];
    const live = isRunning(t);
    const mark = stateMark(t);
    return `<li><button type="button" class="task-item st-${escapeHtml(t.status)}" data-task="${escapeHtml(t.id)}" aria-current="${t.id === tasksView.selected}">
      <span class="ti-ico" aria-hidden="true">${icon(t)}</span>
      <span class="ti-main">
        <span class="ti-title">${escapeHtml(t.description || t.command || t.id)}</span>
        <span class="ti-meta">${c ? `<span class="ti-role" style="--c:${c.color}">${escapeHtml(c.name)}</span>` : ''}<span>${escapeHtml(meta.join(' · '))}</span><span class="ti-dur" data-dur="${escapeHtml(t.id)}">${durationOf(t)}</span></span>
      </span>
      ${live ? '<span class="spinner" aria-hidden="true"></span>' : `<span class="ti-state st-${escapeHtml(t.status)} ${mark[1]}" aria-label="${escapeHtml(stateLabel(t))}" title="${escapeHtml(stateLabel(t))}">${mark[0]}</span>`}
    </button></li>`;
  };
  const running = tasks.filter(isRunning);
  const done = tasks.filter((t) => !isRunning(t));
  // A completed turn with subagents still working: the live count stays visible in the group header.
  const agentsLive = running.filter((t) => t.kind === 'agent').length;
  const liveBadge = agentsLive ? `<span class="tasks-live" title="Tugas latar masih berjalan meski jawaban sudah selesai — ⧗ memantau">⏳ ${escapeHtml(String(agentsLive))} masih bekerja</span>` : '';
  // Shell of another OpenCode session in the same folder: shown for awareness only (no row to click, no Stop).
  const otherItem = (s) =>
    `<li><div class="task-item task-other st-${escapeHtml(s.status ?? 'running')}" title="Shell sesi OpenCode lain di folder ini — hanya lihat">
      <span class="ti-ico" aria-hidden="true">🖥</span>
      <span class="ti-main">
        <span class="ti-title">${escapeHtml(s.command || 'perintah')}</span>
        <span class="ti-meta"><span>sesi lain · ${escapeHtml(TASK_STATE[s.status] ?? s.status ?? 'berjalan')}</span>${s.startedAt ? `<span class="ti-dur">${fmtDuration(Date.now() - s.startedAt)}</span>` : ''}</span>
      </span>
      ${s.status === 'running' ? '<span class="spinner" aria-hidden="true"></span>' : ''}
    </div></li>`;
  list.innerHTML = [
    running.length ? `<li class="tasks-group">Berjalan (${running.length})${liveBadge}</li>${running.map(item).join('')}` : '',
    done.length ? `<li class="tasks-group">Selesai</li>${done.map(item).join('')}` : '',
    others.length ? `<li class="tasks-group">Shell lain di folder ini (${others.length}, hanya lihat)</li>${others.map(otherItem).join('')}` : '',
  ].join('');
  if (focused) list.querySelector(`[data-task="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

function renderDetail() {
  const section = $('#task-detail');
  const task = selectedTask();
  section.hidden = !task && (narrow.matches || !tasksOf(tasksView.project).length);
  if (!task) {
    if (tasksView.keys.head !== 'none') {
      tasksView.keys = { ...tasksView.keys, head: 'none', body: '' };
      $('#td-title').textContent = 'Pilih tugas';
      $('#td-info').textContent = '';
      $('#td-meta').textContent = '';
      $('#td-actions').innerHTML = '';
      $('#td-body').innerHTML = '<p class="muted small">Pilih tugas di daftar untuk melihat apa yang sedang dikerjakan.</p>';
    }
    return;
  }
  renderHead(task);
  renderBody(task);
}

function renderHead(task) {
  const c = who(task);
  const detail = tasksView.details.get(task.id);
  const out = tasksView.outputs.get(task.id);
  const canCopy = task.kind === 'agent' ? Boolean(detail?.result || detail?.steps?.length) : Boolean(out?.text);
  const key = JSON.stringify([task.id, task.status, task.description, task.summary, task.error, task.tokens, task.toolUses, c?.name, canCopy, state.readOnly]);
  if (key === tasksView.keys.head) return;
  tasksView.keys.head = key;
  $('#td-title').innerHTML = `<span aria-hidden="true">${icon(task)}</span> ${escapeHtml(task.description || task.command || task.id)}`;
  $('#td-info').innerHTML = [
    c ? `<span class="ti-role" style="--c:${c.color}">${escapeHtml(c.name)}</span>` : '',
    task.agent ? `<span>${escapeHtml(task.agent)}</span>` : '',
    `<span>${task.kind === 'agent' ? 'agent' : 'perintah'}</span>`,
    `<span title="Durasi">⏱ <span data-dur="${escapeHtml(task.id)}">${durationOf(task)}</span></span>`,
    ...counts(task).map((x) => `<span>${escapeHtml(x)}</span>`),
  ]
    .filter(Boolean)
    .join('<span class="sep" aria-hidden="true">·</span>');
  // The live region only changes with the status (not every second), so a screen reader hears each change once.
  $('#td-meta').innerHTML = `<span class="td-state st-${escapeHtml(task.status)}">${escapeHtml(stateLabel(task))}</span>${task.summary ? ` — ${escapeHtml(task.summary)}` : ''}${task.error ? ` — <span class="err-text">${escapeHtml(task.error)}</span>` : ''}`;
  const ro = state.readOnly ? `disabled title="${READ_ONLY_HINT}"` : '';
  $('#td-actions').innerHTML = [
    isRunning(task) ? `<button type="button" class="danger" data-task-act="stop" ${ro}>■ Hentikan</button>` : '',
    `<button type="button" data-task-act="copy" ${canCopy ? '' : 'disabled'}>📋 ${task.kind === 'agent' ? 'Salin laporan' : 'Salin output'}</button>`,
  ].join('');
}

function stepHtml(s) {
  const time = s.ts ? `<time datetime="${new Date(s.ts).toISOString()}">${clock(s.ts)}</time>` : '<time></time>';
  if (s.type === 'text') return `<li class="step text">${time}<span class="step-ico" aria-hidden="true">💬</span><span class="step-main">${escapeHtml(s.text)}</span></li>`;
  const mark = { ok: ['✓', 'berhasil'], error: ['✗', 'gagal'], running: ['⋯', 'berjalan'] }[s.status] ?? ['•', ''];
  return `<li class="step tool ${escapeHtml(s.status ?? '')}">${time}<span class="step-ico" title="${mark[1]}"><span aria-hidden="true">${mark[0]}</span><span class="sr-only">${mark[1]}</span></span><span class="step-main"><span class="step-label">${escapeHtml(s.label ?? s.tool)}</span>${s.detail && s.detail !== s.label?.replace(/^\$ /, '') ? `<code class="step-detail">${escapeHtml(s.detail)}</code>` : ''}</span></li>`;
}

function agentBody(task) {
  const d = tasksView.details.get(task.id);
  const err = tasksView.errors.get(task.id);
  if (!d) return err ? `<p class="state-error">Gagal memuat langkah: ${escapeHtml(err)}</p>` : '<p class="muted small"><span class="spinner" aria-hidden="true"></span> Memuat langkah…</p>';
  const parts = [];
  if (err) parts.push(`<p class="state-error">Gagal memperbarui: ${escapeHtml(err)}</p>`);
  if (!d.found) {
    parts.push(`<p class="muted small">Transcript agent ini belum ditemukan${isRunning(task) ? ' — biasanya muncul setelah langkah pertamanya.' : '.'}</p>`);
  } else {
    if (d.prompt) parts.push(`<details class="td-prompt"><summary>Instruksi untuk agent</summary><p>${escapeHtml(d.prompt)}</p></details>`);
    if (d.truncated) parts.push('<p class="muted small">… hanya langkah terakhir yang ditampilkan.</p>');
    parts.push(d.steps.length ? `<ol class="td-steps">${d.steps.map(stepHtml).join('')}</ol>` : '<p class="muted small">Belum ada langkah.</p>');
  }
  const result = d.result ?? (!isRunning(task) ? task.summary : null);
  if (result) parts.push(`<section class="td-result" aria-label="Laporan akhir"><h4>📝 Laporan akhir</h4><div class="md">${renderMarkdown(result)}</div></section>`);
  else if (isRunning(task) && d.found) parts.push('<p class="td-live muted small"><span class="spinner" aria-hidden="true"></span> Masih bekerja…</p>');
  return parts.join('');
}

function shellBody(task) {
  const out = tasksView.outputs.get(task.id);
  const err = tasksView.errors.get(task.id);
  return [
    task.command ? `<div class="td-cmd"><span class="muted small">Perintah</span><pre class="td-command">$ ${escapeHtml(task.command)}</pre></div>` : '',
    err ? `<p class="state-error">Gagal memuat output: ${escapeHtml(err)}</p>` : '',
    truncatedNote(out),
    out ? `<pre class="task-out td-out">${escapeHtml(out.text || '(belum ada output)')}</pre>` : err ? '' : '<p class="muted small"><span class="spinner" aria-hidden="true"></span> Memuat output…</p>',
  ].join('');
}

function renderBody(task) {
  const body = $('#td-body');
  const d = tasksView.details.get(task.id);
  const out = tasksView.outputs.get(task.id);
  const key = JSON.stringify([task.id, task.status, task.summary, tasksView.errors.get(task.id), task.kind === 'agent' ? [d?.steps?.length, d?.steps?.at(-1), d?.result, d?.found, d?.truncated] : [out?.text.length, out?.text.slice(-200), task.command]]);
  if (key === tasksView.keys.body) return;
  tasksView.keys.body = key;
  const top = body.scrollTop;
  const openPrompt = body.querySelector('.td-prompt')?.open;
  body.innerHTML = task.kind === 'agent' ? agentBody(task) : shellBody(task);
  if (openPrompt) body.querySelector('.td-prompt')?.setAttribute('open', '');
  // New lines arrive at the bottom: follow them unless the user scrolled up to read.
  body.scrollTop = tasksView.stick ? body.scrollHeight : top;
}

/** Live durations, once a second while the dialog is open (text only, no re-render). */
function startTicker() {
  clearInterval(tasksView.tickTimer);
  tasksView.tickTimer = setInterval(() => {
    if (!isOpen()) return stopAll();
    const byId = new Map(tasksOf(tasksView.project).map((t) => [t.id, t]));
    for (const el of document.querySelectorAll('#tasks-modal [data-dur]')) {
      const t = byId.get(el.dataset.dur);
      if (t && isRunning(t)) el.textContent = durationOf(t);
    }
  }, 1000);
}

export function backgroundRunning() {
  api(`/api/projects/${state.active}/background`)
    .then(() => toast('Dipindahkan ke latar belakang. Kamu bisa lanjut chat.', 'ok'))
    .catch((err) => toast(err.message));
}

// ---------- the office: click a character at work on a task ----------

/** The person under a click on the office canvas (world coordinates), or null. */
function personAt(canvas, clientX, clientY) {
  const scene = state.active ? sceneFor(state.active) : null;
  const rect = canvas.getBoundingClientRect();
  if (!scene || !rect.width) return null;
  const x = ((clientX - rect.left) / rect.width) * W;
  const y = ((clientY - rect.top) / rect.height) * room.h;
  // Front-most first (larger y is drawn on top).
  const people = scene.actors().filter((a) => CAST[a.id] && Math.abs(a.x - x) <= 9 && y >= a.headTop() - 3 && y <= a.y + 3);
  return people.sort((a, b) => b.y - a.y)[0] ?? null;
}

function initOfficeClicks() {
  const canvas = $('#stage canvas');
  canvas.addEventListener('click', (e) => {
    const person = personAt(canvas, e.clientX, e.clientY);
    const task = person && taskForRole(state.active, person.id);
    if (task) openTasks({ taskId: task.id });
  });
  // A pointer over someone with a running task: show that the click does something.
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const person = personAt(canvas, e.clientX, e.clientY);
    const task = person && state.active !== DEMO_ID ? taskForRole(state.active, person.id) : null;
    canvas.style.cursor = task ? 'pointer' : '';
    canvas.title = task ? `${CAST[person.id].name}: ${task.description || 'tugas latar'} — klik untuk lihat` : '';
  });
}

// ---------- wiring ----------

export function initTasks() {
  $('#tasks-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-task]');
    if (item) select(item.dataset.task);
  });

  $('#td-back').addEventListener('click', () => {
    const was = tasksView.selected;
    select(null, { focus: false });
    if (was) $(`#tasks-list [data-task="${CSS.escape(was)}"]`)?.focus({ preventScroll: true });
  });

  $('#td-actions').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-task-act]');
    const task = selectedTask();
    if (!btn || !task) return;
    if (btn.dataset.taskAct === 'copy') {
      const d = tasksView.details.get(task.id);
      const text =
        task.kind === 'agent'
          ? (d?.result ?? (d?.steps ?? []).map((s) => `${clock(s.ts)} ${s.type === 'text' ? s.text : s.label}`).join('\n'))
          : (tasksView.outputs.get(task.id)?.text ?? '');
      flashButton(btn, (await copyText(text)) ? '✓ Disalin' : 'Gagal menyalin');
      return;
    }
    btn.disabled = true;
    try {
      await api(`/api/projects/${tasksView.project}/task-stop`, { taskId: task.id });
      toast('Tugas dihentikan.', 'ok');
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });

  $('#td-body').addEventListener('scroll', () => {
    const el = $('#td-body');
    tasksView.stick = nearBottom(el);
  });

  $('#tasks-background').addEventListener('click', backgroundRunning);
  $('#sb-tasks').addEventListener('click', () => openTasks());

  // Closed (Esc, ✕, backdrop, anything that sets `hidden`): stop polling and the clock.
  new MutationObserver(() => {
    if (!isOpen()) stopAll();
  }).observe($('#tasks-modal'), { attributeFilter: ['hidden'] });

  // A hidden tab doesn't poll; coming back fetches right away.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(tasksView.pollTimer);
    else if (isOpen() && selectedTask()) poll(0);
  });

  // Phone ↔ desktop width: one column with a back button, or list and detail side by side.
  narrow.addEventListener('change', () => isOpen() && renderTasks());

  initOfficeClicks();
}
