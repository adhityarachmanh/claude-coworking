// 🧠 Mode Otak ↔ 🏢 Kantor: which view of the team the stage shows (office/brain.js), remembered per browser.
import { $ } from '../core/dom.js';
import { brain } from '../core/scenes.js';
import { state } from '../core/state.js';

const KEY = 'office.viewMode';

function apply(on) {
  brain.setOn(on);
  document.querySelector('.office')?.classList.toggle('brain-on', on); // the people grid turns into orbs too
  const btn = $('#view-mode');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? '🏢 Mode Kantor' : '🧠 Mode Otak';
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
  let on = false;
  try {
    on = localStorage.getItem(KEY) === 'brain';
  } catch {}
  apply(on);
  $('#view-mode').addEventListener('click', () => {
    const next = !brain.on;
    apply(next);
    try {
      localStorage.setItem(KEY, next ? 'brain' : 'office');
    } catch {}
  });
}
