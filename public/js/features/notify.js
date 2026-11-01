// Notifications: Windows notification + chime when a project needs you or finishes.
// 🔔 turns them on/off; 🔔 Pengaturan notifikasi (Ctrl+P / 🔎 on a phone, right-click / long-press 🔔, ⚙) tunes them per device:
// per event type, quiet hours, favourites only, volume. Rules live in core/notify-rules.js.
import { toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { NOTIFY_KINDS, cleanNotifySettings, notifyPlan, quietError } from '../core/notify-rules.js';
import { state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { selectProject } from './picker.js';

export const NOTIFY_KEY = 'office.notify';
export const NOTIFY_SETTINGS_KEY = 'office.notifySettings';
const PEAK_GAIN = 0.18; // the chime's loudness at volume 100 (what it always was)
const LONG_PRESS_MS = 500;

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked (private mode): defaults
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered; works for this page
  }
}

const notifyState = { on: false };
let audioCtx = null;

/** The current per-device settings (read each time: another tab may have changed them). */
export function notifySettings() {
  try {
    return cleanNotifySettings(JSON.parse(readStorage(NOTIFY_SETTINGS_KEY) ?? 'null'));
  } catch {
    return cleanNotifySettings(null);
  }
}

function saveNotifySettings(next) {
  writeStorage(NOTIFY_SETTINGS_KEY, JSON.stringify(cleanNotifySettings(next)));
}

const canPopup = () => 'Notification' in window && Notification.permission === 'granted';

function renderNotifyButton() {
  const btn = $('#btn-notify');
  btn.classList.toggle('on', notifyState.on);
  btn.querySelector('.ico').textContent = notifyState.on ? '🔔' : '🔕';
  btn.querySelector('.lbl').textContent = notifyState.on ? 'Notifikasi aktif' : 'Notifikasi';
  btn.title = `${notifyState.on ? 'Notifikasi aktif — klik untuk mematikan' : 'Aktifkan notifikasi & suara (izin, tugas selesai)'}. Klik kanan / tekan lama: pengaturan`;
}

/**
 * Short synthesized chime: rising for "done", urgent triple for "needs you", low for errors.
 * `volume` 0–100 scales the peak gain (default: the saved setting); 0 plays nothing.
 */
export function chime(kind, volume = notifySettings().volume) {
  const peak = PEAK_GAIN * (Math.min(100, Math.max(0, volume)) / 100);
  if (peak <= 0) return;
  try {
    audioCtx ??= new AudioContext();
    const notes = kind === 'ask' ? [880, 660, 880] : kind === 'error' ? [330, 247] : [523, 784];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const t = audioCtx.currentTime + i * 0.15;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + 0.02); // exponential ramps need > 0
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  } catch {
    // audio unavailable
  }
}

export function notify(kind, title, body, projectId) {
  if (!notifyState.on) return;
  const away = document.hidden || projectId !== state.active;
  const favorite = Boolean(state.projects.find((p) => p.id === projectId)?.favorite);
  const settings = notifySettings();
  const plan = notifyPlan(kind, settings, { away, favorite });
  if (plan.sound) chime(kind, settings.volume);
  if (plan.popup && canPopup()) {
    const n = new Notification(title, { body, tag: `${projectId}-${kind}`, requireInteraction: kind === 'ask' });
    n.onclick = () => {
      window.focus();
      selectProject(projectId);
      n.close();
    };
  }
}

/** An app-wide notice (not tied to a project), e.g. a quota warning: chime + notification, only when 🔔 is on. */
export function notifyNotice(title, body, tag) {
  if (!notifyState.on) return;
  const settings = notifySettings();
  const plan = notifyPlan('notice', settings, { away: true });
  if (plan.sound) chime('ask', settings.volume);
  if (plan.popup && canPopup()) new Notification(title, { body, tag });
}

/** 🔔 on/off (the header button and the dialog's switch). Asks for the browser permission on the way on. */
async function setNotifyOn(on) {
  if (on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  notifyState.on = on;
  writeStorage(NOTIFY_KEY, on ? '1' : '0');
  renderNotifyButton();
  syncNotifyForm();
  if (on) {
    chime('done');
    if ('Notification' in window && Notification.permission === 'denied') toast('Notifikasi Windows diblokir browser; yang aktif hanya suara.', 'ok');
  }
}

// ---------- 🔔 Pengaturan notifikasi (dialog) ----------

const eventInput = (kind, what) => $(`#ns-${kind}-${what}`);

function permissionText() {
  if (!('Notification' in window)) return 'Browser ini tidak mendukung notifikasi pop-up; yang berjalan hanya suara.';
  if (Notification.permission === 'denied') return 'Notifikasi pop-up diblokir browser (izinkan di pengaturan situs); yang berjalan hanya suara.';
  if (Notification.permission === 'default') return 'Izin notifikasi pop-up diminta saat notifikasi diaktifkan.';
  return '';
}

/** Puts the saved settings into the dialog (on open, after a reset, after 🔔 is toggled). */
export function syncNotifyForm() {
  const s = notifySettings();
  $('#ns-on').checked = notifyState.on;
  for (const kind of NOTIFY_KINDS) {
    eventInput(kind, 'popup').checked = s.events[kind].popup;
    eventInput(kind, 'sound').checked = s.events[kind].sound;
  }
  $('#ns-quiet').checked = s.quiet.enabled;
  $('#ns-from').value = s.quiet.from;
  $('#ns-to').value = s.quiet.to;
  $('#ns-quiet-ask').checked = s.quiet.allowAsk;
  $('#ns-fav').checked = s.favoritesOnly;
  $('#ns-volume').value = String(s.volume);
  setQuietError(null);
  renderFormState(s.volume);
  $('#ns-perm').textContent = permissionText();
}

/** Disabled-ness and the volume readout follow the switches (no save). */
function renderFormState(volume) {
  const quietOn = $('#ns-quiet').checked;
  const fixing = Boolean($('#ns-quiet-error').textContent); // an error shown: the times must stay fixable
  for (const id of ['#ns-from', '#ns-to']) $(id).disabled = !quietOn && !fixing;
  $('#ns-quiet-ask').disabled = !quietOn;
  $('#ns-volume-val').textContent = `${volume}%`;
  $('#ns-volume').setAttribute('aria-valuetext', `${volume}%`);
}

function setQuietError(text) {
  $('#ns-quiet-error').textContent = text ?? '';
  for (const id of ['#ns-from', '#ns-to']) $(id).setAttribute('aria-invalid', String(Boolean(text)));
}

/** Saves every field at once; an invalid quiet-hours range keeps the stored times (and says why). */
function saveNotifyForm(target) {
  const prev = notifySettings();
  const events = {};
  for (const kind of NOTIFY_KINDS) events[kind] = { popup: eventInput(kind, 'popup').checked, sound: eventInput(kind, 'sound').checked };
  const from = $('#ns-from').value;
  const to = $('#ns-to').value;
  const enabled = $('#ns-quiet').checked;
  const allowAsk = $('#ns-quiet-ask').checked;
  const error = enabled ? quietError(from, to) : null;
  setQuietError(error);
  // Switching quiet hours on with bad times: the switch goes back (the times stay editable, see renderFormState).
  if (error && target?.id === 'ns-quiet') $('#ns-quiet').checked = prev.quiet.enabled;
  const volume = Number($('#ns-volume').value);
  saveNotifySettings({
    events,
    quiet: error ? { ...prev.quiet, allowAsk } : { enabled, from: from || prev.quiet.from, to: to || prev.quiet.to, allowAsk },
    favoritesOnly: $('#ns-fav').checked,
    volume,
  });
  renderFormState(volume);
}

export function openNotifySettings() {
  syncNotifyForm();
  openModal('notify-modal');
}

export function initNotify() {
  notifyState.on = readStorage(NOTIFY_KEY) === '1';
  const btn = $('#btn-notify');
  // Right-click (contextmenu) or a long press on touch: the settings dialog. The long press has its own timer,
  // because iOS Safari fires no contextmenu on a long press; the click that ends it must not also toggle 🔔.
  const press = { timer: 0, x: 0, y: 0, fired: false };
  const cancelPress = () => clearTimeout(press.timer);
  btn.addEventListener('pointerdown', (e) => {
    press.fired = false;
    if (e.pointerType === 'mouse') return;
    Object.assign(press, { x: e.clientX, y: e.clientY });
    cancelPress();
    press.timer = setTimeout(() => {
      press.fired = true;
      openNotifySettings();
    }, LONG_PRESS_MS);
  });
  btn.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress(); // a scroll / drag, not a press
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(type, cancelPress);
  btn.addEventListener('click', () => {
    if (press.fired) return void (press.fired = false); // the end of a long press
    setNotifyOn(!notifyState.on);
  });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!press.fired) openNotifySettings(); // Android fires both: open once
  });
  $('#btn-notify-settings').addEventListener('click', openNotifySettings);

  const form = $('#notify-form');
  form.addEventListener('submit', (e) => e.preventDefault()); // Enter in a time field must not reload anything
  $('#ns-on').addEventListener('change', (e) => setNotifyOn(e.target.checked));
  form.addEventListener('change', (e) => {
    if (e.target.id === 'ns-on') return;
    saveNotifyForm(e.target);
  });
  // The readout follows the slider while dragging; the value is saved on release (change).
  $('#ns-volume').addEventListener('input', (e) => renderFormState(Number(e.target.value)));
  $('#ns-test').addEventListener('click', () => {
    const volume = Number($('#ns-volume').value);
    if (!volume) return toast('Volume 0% — tidak ada suara.', 'ok');
    chime('done', volume);
  });
  $('#ns-reset').addEventListener('click', () => {
    saveNotifySettings(null);
    syncNotifyForm();
    toast('Pengaturan notifikasi kembali ke bawaan.', 'ok');
  });
  renderNotifyButton();
}
