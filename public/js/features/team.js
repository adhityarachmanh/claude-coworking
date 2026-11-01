// Team strip under the office and the rename-the-team dialog.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { scenes } from '../core/scenes.js';
import { state } from '../core/state.js';
import { applyTeamNames, CAST, DEFAULT_NAMES } from '../office/cast.js';
import { teamOrder } from '../office/roster.js';
import { avatarURL } from '../office/sprites.js';
import { closeModal, openModal } from '../ui/modals.js';
import { renderActivity } from './activity.js';
import { renderChat } from './chat.js';
import { openTasks, tasksOf } from './tasks.js';

// ---------- team strip ----------

let teamHtml = '';

export function renderTeam() {
  const scene = scenes.get(state.active);
  if (!scene) return;
  const now = performance.now();
  // Running background tasks per role: a ⧗ badge on the card opens the task monitor (the card itself renames).
  const running = new Map();
  for (const t of tasksOf(state.active)) if ((t.status === 'running' || t.status === 'pending') && t.role) running.set(t.role, [...(running.get(t.role) ?? []), t]);
  // The active team only (👥 Kelola tim): the Lead, then every role with a desk.
  const members = teamOrder().filter((id) => scene.people[id]);
  const html = members.map((id) => {
    const p = scene.people[id];
    const [cls, text] = p.asking
      ? ['ask', 'Menunggu izinmu']
      : now < p.flashUntil
        ? ['err', 'Ketemu error']
        : p.isBusy(now)
          ? ['work', `${p.seated ? 'Bekerja' : 'Menuju meja'}${p.agentCount > 1 ? ` (${p.agentCount} tugas paralel)` : ''}`]
          : p.onSofa || p.x > 440
            ? ['idle', 'Istirahat ☕']
            : p.plan.length
              ? ['idle', 'Jalan-jalan']
              : ['idle', 'Standby'];
    const tip = `${CAST[id].name} — ${CAST[id].title}\n${text}${p.task ? `\n${p.task}` : ''}\n(klik untuk ganti nama)`;
    const tasks = running.get(id) ?? [];
    const label = `Lihat tugas latar ${CAST[id].name}: ${tasks.length} berjalan`;
    const list = `${tasks.map((t) => t.description || 'tugas latar').join('\n')}\n(klik untuk lihat detail)`;
    const badge = tasks.length
      ? `<button type="button" class="member-task" data-task-open="${escapeHtml(tasks[0].id)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(list)}"><span aria-hidden="true">⧗</span>${tasks.length > 1 ? tasks.length : ''}</button>`
      : '';
    return `<div class="member-cell"><div class="member ${cls}" data-role="${id}" role="button" tabindex="0" style="--c:${CAST[id].color}" title="${escapeHtml(tip)}">
      <img src="${avatarURL(CAST[id].look)}" alt="">
      <div><b>${escapeHtml(CAST[id].name)}</b><small>${CAST[id].title}</small><span class="st">${p.task && cls !== 'idle' ? escapeHtml(p.task) : text}</span></div>
    </div>${badge}</div>`;
  }).join('');
  // Runs every 500 ms: only touch the DOM on a change, and keep keyboard focus on the same card.
  if (html === teamHtml) return;
  const active = document.activeElement;
  const focused = active?.closest?.('#team .member')?.dataset.role;
  const focusedBadge = active?.closest?.('#team .member-task') ? active.closest('.member-cell')?.querySelector('.member')?.dataset.role : null;
  $('#team').innerHTML = teamHtml = html;
  if (focused) $(`#team .member[data-role="${focused}"]`)?.focus({ preventScroll: true });
  // The badge keeps focus while its role still has a task; else the card next to it takes it.
  if (focusedBadge) ($(`#team .member[data-role="${focusedBadge}"] + .member-task`) ?? $(`#team .member[data-role="${focusedBadge}"]`))?.focus({ preventScroll: true });
}

// ---------- team names (rename the people in the office) ----------

/** New names from the server: everything that prints a name is redrawn. */
export function applyNames(config) {
  if (!applyTeamNames(config?.teamNames)) return;
  renderChat();
  renderActivity();
  renderTeam();
  if (!$('#team-modal').hidden) renderTeamForm();
}

function renderTeamForm() {
  $('#team-list').innerHTML = teamOrder().map((id) => `<label class="team-row">
      <img src="${avatarURL(CAST[id].look)}" alt="">
      <span class="team-role"><b style="color:${CAST[id].color}">${CAST[id].title}</b><small>bawaan: ${escapeHtml(DEFAULT_NAMES[id] ?? CAST[id].name)}</small></span>
      <input name="${id}" value="${escapeHtml(CAST[id].name === DEFAULT_NAMES[id] ? '' : CAST[id].name)}" placeholder="${escapeHtml(DEFAULT_NAMES[id] ?? CAST[id].name)}" maxlength="24" autocomplete="off" ${state.readOnly ? 'disabled' : ''} />
    </label>`).join('');
}

function openTeam(focusRole) {
  renderTeamForm();
  openModal('team-modal'); // visible first: a hidden input cannot take focus
  if (focusRole) $(`#team-list input[name="${focusRole}"]`)?.focus();
}

export function initTeam() {
  $('#team').addEventListener('click', (e) => {
    const badge = e.target.closest('[data-task-open]');
    if (badge) return openTasks({ taskId: badge.dataset.taskOpen });
    const card = e.target.closest('.member[data-role]');
    if (card) openTeam(card.dataset.role);
  });
  $('#btn-team-names').addEventListener('click', () => {
    closeModal('settings-modal');
    openTeam();
  });
  $('#team-reset').addEventListener('click', () => $('#team-list').querySelectorAll('input').forEach((input) => (input.value = '')));
  $('#team-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const names = Object.fromEntries([...$('#team-list').querySelectorAll('input')].map((input) => [input.name, input.value.trim()]));
    try {
      await api('/api/team', { names });
      closeModal('team-modal');
      toast('Nama tim disimpan.', 'ok');
    } catch (err) {
      toast(err.message);
    }
  });
}
