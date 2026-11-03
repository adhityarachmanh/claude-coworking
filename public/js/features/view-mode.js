// 🧠 Mode Otak ↔ 🏢 Kantor: which view of the team the stage shows (office/brain.js), remembered per browser.
import { $ } from '../core/dom.js';
import { brain } from '../core/scenes.js';

const KEY = 'office.viewMode';

function apply(on) {
  brain.setOn(on);
  const btn = $('#view-mode');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? '🏢 Mode Kantor' : '🧠 Mode Otak';
}

export function initViewMode() {
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
