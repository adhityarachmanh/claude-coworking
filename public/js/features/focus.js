// 🎯 Mode fokus: the office (and 🧠 Mode Otak) is hidden and its animation paused, so the chat and the panels get
// the whole window — handy on a laptop and on a phone. Remembered per browser like the other view settings
// (features/view-mode.js), and shared with the app loop in public/js/app.js through `focusMode`.
import { $ } from '../core/dom.js';

const KEY = 'office.focus';

/** The app loop (public/js/app.js) reads this: while `on`, it runs no scene.update/stage.frame/brain.frame. */
export const focusMode = { on: false };

function apply(on) {
  document.body.classList.toggle('focus-mode', on);
  const exit = $('#focus-exit');
  if (exit) exit.hidden = !on; // the only way back out of the hidden office
}

/** Turns focus mode on/off and remembers it. Never throws when storage is unavailable (private mode). */
export function setFocus(on) {
  focusMode.on = Boolean(on);
  try {
    localStorage.setItem(KEY, focusMode.on ? '1' : '0');
  } catch {}
  apply(focusMode.on);
}

/** Flips the mode; returns the new state (the /fokus toast says which one it is). */
export function toggleFocus() {
  setFocus(!focusMode.on);
  return focusMode.on;
}

/** On load: the stored choice, applied before the first frame; the exit chip turns it off again. */
export function initFocus() {
  let on = false;
  try {
    on = localStorage.getItem(KEY) === '1';
  } catch {}
  focusMode.on = on;
  apply(on);
  $('#focus-exit')?.addEventListener('click', () => setFocus(false));
}
