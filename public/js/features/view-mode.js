// 🏢 Kantor · 🧠 Mode Otak · 💻 Mode Terminal: which view of the team the stage shows (office/brain.js,
// office/terminal.js), remembered per browser. Each button toggles its own view on and off (back to the office).
import { $ } from '../core/dom.js';
import { brain, terminal } from '../core/scenes.js';
import { state } from '../core/state.js';

const KEY = 'office.viewMode';

/** @param {'office'|'brain'|'terminal'} mode */
function apply(mode) {
  const on = mode === 'brain';
  brain.setOn(on);
  terminal.setOn(mode === 'terminal');
  document.querySelector('.office')?.classList.toggle('brain-on', on); // the people grid turns into orbs too
  document.body.classList.toggle('brain-on', on); // …and every other avatar (chat, edit-names, Kelola tim)
  const btn = $('#view-mode');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? '🏢 Mode Kantor' : '🧠 Mode Otak';
  const term = $('#view-terminal');
  term.setAttribute('aria-pressed', String(mode === 'terminal'));
  term.textContent = mode === 'terminal' ? '🏢 Mode Kantor' : '💻 Terminal';
}

const current = () => (brain.on ? 'brain' : terminal.on ? 'terminal' : 'office');
function choose(mode) {
  const next = current() === mode ? 'office' : mode;
  apply(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {}
}

/**
 * A neuron was clicked: a pending approval → its card in the chat; a role with background tasks → ⧗ Tugas latar;
 * otherwise the Aktivitas tab (what that role has been doing).
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
  apply(['brain', 'terminal'].includes(mode) ? mode : 'office');
  $('#view-mode').addEventListener('click', () => choose('brain'));
  $('#view-terminal').addEventListener('click', () => choose('terminal'));
}
