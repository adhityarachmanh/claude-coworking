// Notifications: Windows notification + chime when a project needs you or finishes.
import { toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { selectProject } from './picker.js';

const notifyState = { on: localStorage.getItem('office.notify') === '1' };
let audioCtx = null;

function renderNotifyButton() {
  const btn = $('#btn-notify');
  btn.classList.toggle('on', notifyState.on);
  btn.querySelector('.ico').textContent = notifyState.on ? '🔔' : '🔕';
  btn.querySelector('.lbl').textContent = notifyState.on ? 'Notifikasi aktif' : 'Notifikasi';
  btn.title = notifyState.on ? 'Notifikasi aktif — klik untuk mematikan' : 'Aktifkan notifikasi & suara (izin, tugas selesai)';
}

/** Short synthesized chime: rising for "done", urgent triple for "needs you", low for errors. */
export function chime(kind) {
  try {
    audioCtx ??= new AudioContext();
    const notes = kind === 'ask' ? [880, 660, 880] : kind === 'error' ? [330, 247] : [523, 784];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const t = audioCtx.currentTime + i * 0.15;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
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
  if (!away && kind !== 'ask') return; // you're already looking at it
  chime(kind);
  if (away && 'Notification' in window && Notification.permission === 'granted') {
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
  chime('ask');
  if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, tag });
}

export function initNotify() {
  $('#btn-notify').addEventListener('click', async () => {
    if (!notifyState.on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    notifyState.on = !notifyState.on;
    localStorage.setItem('office.notify', notifyState.on ? '1' : '0');
    renderNotifyButton();
    if (notifyState.on) {
      chime('done');
      if ('Notification' in window && Notification.permission === 'denied') toast('Notifikasi Windows diblokir browser; yang aktif hanya suara.', 'ok');
    }
  });
  renderNotifyButton();
}
