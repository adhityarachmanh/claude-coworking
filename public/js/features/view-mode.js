// 🎛 Mode tampilan: which view of the team the stage shows — 🏢 Kantor (pixel office), 🧠 Otak (office/brain.js),
// 💻 Terminal (office/terminal.js), 🛰 Mission Control (office/mission.js) or 🎼 Orkestra (office/orchestra.js).
// One button opens a dialog with the five;
// the choice is remembered per browser.
import { $ } from '../core/dom.js';
import { brain, mission, orchestra, terminal } from '../core/scenes.js';
import { state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';

const KEY = 'office.viewMode';
export const VIEW_MODES = ['office', 'brain', 'terminal', 'mission', 'orchestra'];
const LABEL = { office: '🏢 Kantor', brain: '🧠 Otak', terminal: '💻 Terminal', mission: '🛰 Mission Control', orchestra: '🎼 Orkestra' };

/** The view on screen now. */
export const currentView = () => (brain.on ? 'brain' : terminal.on ? 'terminal' : mission.on ? 'mission' : orchestra.on ? 'orchestra' : 'office');

/** @param {'office'|'brain'|'terminal'|'mission'|'orchestra'} mode */
function apply(mode) {
  const on = mode === 'brain';
  brain.setOn(on);
  terminal.setOn(mode === 'terminal');
  mission.setOn(mode === 'mission');
  orchestra.setOn(mode === 'orchestra');
  document.querySelector('.office')?.classList.toggle('brain-on', on); // the people grid turns into orbs too
  document.body.classList.toggle('brain-on', on); // …and every other avatar (chat, edit-names, Kelola tim)
  const btn = $('#view-mode');
  btn.dataset.view = mode;
  btn.textContent = `🎛 Mode: ${LABEL[mode].replace(/^\S+ /, '')} ▾`;
  for (const opt of document.querySelectorAll('#view-modal [data-view]')) opt.setAttribute('aria-pressed', String(opt.dataset.view === mode));
}

/** Shows `mode` and remembers it (also used by the dialog's cards). */
export function setView(mode) {
  const next = VIEW_MODES.includes(mode) ? mode : 'office';
  apply(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {}
}

/**
 * A neuron / station / panel was clicked: a pending approval → its card in the chat; a role with background tasks →
 * ⧗ Tugas latar; otherwise the Aktivitas tab (what that role has been doing).
 */
async function onNeuron(role) {
  const pending = document.querySelector('#chat .approval.pending');
  document.querySelector('.tabs button[data-tab="chat"]')?.click();
  if (pending) {
    pending.scrollIntoView({ block: 'center', behavior: 'smooth' });
    pending.classList.add('flash');
    setTimeout(() => pending.classList.remove('flash'), 1500);
    return;
  }
  const st = state.statuses[state.active] ?? {};
  if ((st.tasks ?? []).some((t) => t.role === role && (t.status === 'running' || t.status === 'pending'))) {
    const { openTasks } = await import('./tasks.js');
    return openTasks({ role });
  }
  document.querySelector('.tabs button[data-tab="activity"]')?.click();
}

export function initViewMode() {
  $('#stage').addEventListener('brain-neuron', (e) => onNeuron(e.detail.role));
  let mode = 'office';
  try {
    mode = localStorage.getItem(KEY) ?? 'office';
  } catch {}
  apply(VIEW_MODES.includes(mode) ? mode : 'office');
  $('#view-mode').addEventListener('click', () => openModal('view-modal'));
  $('#view-modal').addEventListener('click', (e) => {
    const opt = e.target.closest('[data-view]');
    if (!opt) return;
    setView(opt.dataset.view);
    closeModal('view-modal');
  });
}
