// 👥 Kelola tim (⚙, ⋯, Ctrl+P, /team): which built-in roles have a desk in the office. Only the server's role
// catalog can be picked (no free-form roles); the Lead is always there and the freelancer (the generalist every
// fallback ends at) is always on. Anyone may look; saving is an action (refused over plain WiFi).
// A change re-lays the office and rebuilds the scenes without a page reload, like a theme switch.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { sceneFor, scenes, stage } from '../core/scenes.js';
import { state } from '../core/state.js';
import { CAST } from '../office/cast.js';
import { DEFAULT_TEAM, LEAD, roster, setRoster } from '../office/roster.js';
import { avatarURL } from '../office/sprites.js';
import { layoutDesks } from '../office/world.js';
import { closeModal, openModal } from '../ui/modals.js';
import { renderTeam } from './team.js';

// The roles ticked in the open dialog (a Set of ids), not saved yet.
const draft = { enabled: null, saving: false };

const APPLIED = {
  restarted: 'Sesi Claude yang sedang diam dimulai ulang dengan tim baru.',
  pending: 'Berlaku setelah giliran / tugas latar yang berjalan selesai.',
  none: 'Berlaku saat Claude Code berikutnya dijalankan.',
};

const isOpen = () => !$('#roster-modal').hidden;

/**
 * `config.team` from the server (snapshot or a live config event). When the active roles changed, the desks
 * are laid out again and the stage resized; `rebuild` also rebuilds the open scenes (a snapshot rebuilds them itself).
 */
export function applyRoster(team, { rebuild = true } = {}) {
  const changed = setRoster(team);
  if (changed) {
    layoutDesks(roster.enabled);
    stage.refreshLayout();
    if (rebuild) {
      scenes.clear(); // rebuilt from the replayed events, with a person per active role
      if (state.active) stage.setScene(sceneFor(state.active));
      renderTeam();
    }
  }
  // Someone else saved meanwhile: the dialog shows the team as it is now.
  if (isOpen() && !draft.saving && (changed || !draft.enabled)) {
    draft.enabled = new Set(roster.enabled);
    renderRoster();
  }
  return changed;
}

/** Who takes a role's work while it is off, in the team being edited (mirrors resolveRole). */
function coverOf(id, enabled) {
  const byId = new Map(roster.catalog.map((r) => [r.id, r]));
  const seen = new Set();
  const walk = (role) => {
    if (seen.has(role)) return null;
    seen.add(role);
    for (const next of byId.get(role)?.fallback ?? []) {
      if (enabled.has(next)) return next;
      const deeper = walk(next);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(id) ?? (enabled.has('freelancer') ? 'freelancer' : LEAD);
}

const nameOf = (id) => CAST[id]?.name ?? id;

function renderCount() {
  const n = draft.enabled.size;
  $('#roster-count').textContent = `${n}/${roster.max} meja`;
  const changed = [...draft.enabled].sort().join() !== [...roster.enabled].sort().join();
  $('#roster-save').disabled = state.readOnly || draft.saving || !changed || n > roster.max;
}

function renderRoster() {
  const ro = state.readOnly;
  const enabled = draft.enabled;
  const lead = CAST[LEAD];
  const leadRow = `<li class="roster-row locked">
      <img src="${avatarURL(lead.look)}" alt="">
      <span class="roster-text"><b style="color:${lead.color}">${escapeHtml(lead.name)}</b><small>${escapeHtml(lead.title)} · selalu ada di ruang kaca</small></span>
      <span class="roster-state">🔒 Lead</span>
    </li>`;
  const rows = roster.catalog.map((role) => {
    const cast = CAST[role.id];
    const on = enabled.has(role.id);
    const id = `roster-${role.id}`;
    const note = role.locked
      ? 'Selalu aktif: pengganti generalis untuk subagent di luar spesialis.'
      : on
        ? role.description
        : `${role.description} Nonaktif → dikerjakan ${nameOf(coverOf(role.id, enabled))}.`;
    return `<li class="roster-row${on ? ' on' : ''}${role.locked ? ' locked' : ''}">
      <img src="${avatarURL(cast.look)}" alt="">
      <label class="roster-text" for="${id}"><b style="color:${cast.color}">${escapeHtml(cast.name)}</b><small>${escapeHtml(cast.title)}${role.optional ? ' · <span class="roster-new">baru</span>' : ''}</small><span id="${id}-desc" class="roster-desc">${escapeHtml(note)}</span></label>
      <input id="${id}" type="checkbox" role="switch" data-role="${role.id}" aria-describedby="${id}-desc" ${on ? 'checked' : ''} ${role.locked || ro ? 'disabled' : ''} />
    </li>`;
  });
  $('#roster-list').innerHTML = leadRow + rows.join('');
  renderCount();
}

export function openRoster() {
  closeModal('settings-modal'); // opened from ⚙: one dialog at a time
  draft.enabled = new Set(roster.enabled);
  $('#roster-error').textContent = '';
  $('#roster-ro').hidden = !state.readOnly;
  $('#roster-default').hidden = state.readOnly;
  $('#roster-save').hidden = state.readOnly;
  renderRoster();
  openModal('roster-modal');
  // The config already carries the team; this read (allowed over WiFi too) only picks up a change missed meanwhile.
  api('/api/team/roster')
    .then((team) => applyRoster(team))
    .catch(() => {});
}

async function saveRoster(e) {
  e.preventDefault();
  if (state.readOnly || draft.saving) return;
  draft.saving = true;
  renderCount();
  $('#roster-error').textContent = '';
  try {
    const result = await api('/api/team/roster/save', { enabled: [...draft.enabled] });
    draft.saving = false;
    applyRoster(result);
    closeModal('roster-modal');
    toast(`Tim disimpan: ${result.enabled.length} role aktif. ${APPLIED[result.applied] ?? APPLIED.none}`, 'ok');
  } catch (err) {
    draft.saving = false;
    $('#roster-error').textContent = err.message;
    renderCount();
  }
}

export function initRoster() {
  $('#roster-list').addEventListener('change', (e) => {
    const input = e.target.closest('input[data-role]');
    if (!input || state.readOnly) return;
    if (input.checked) draft.enabled.add(input.dataset.role);
    else draft.enabled.delete(input.dataset.role);
    // Redraw (the "Nonaktif → dikerjakan …" notes depend on the whole team), keeping focus on the same switch.
    renderRoster();
    $(`#roster-${input.dataset.role}`)?.focus();
  });
  $('#roster-default').addEventListener('click', () => {
    draft.enabled = new Set(DEFAULT_TEAM);
    renderRoster();
  });
  $('#roster-form').addEventListener('submit', saveRoster);
  $('#btn-roster').addEventListener('click', openRoster);
}
