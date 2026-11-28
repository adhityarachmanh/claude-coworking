// ✉️ Kirim pesan ke project lain: the message lands as a normal prompt in that project (queue/budget/izinnya
// berlaku). App-level, no terminal; complements Claude's cross-session messaging for the human side.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

export function openSendMessage() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (state.readOnly) return toast('Kirim pesan hanya bisa dari laptop atau lewat Tailscale.', 'warn');
  const targets = (state.projects ?? []).filter((p) => p && !p.virtual && p.id !== DEMO_ID && p.id !== state.active);
  if (!targets.length) return toast('Belum ada project lain untuk dituju.', 'warn');
  $('#send-message-project').innerHTML = targets.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  $('#send-message-text').value = '';
  $('#send-message-error').textContent = '';
  openModal('send-message-modal');
  $('#send-message-text').focus();
}

async function send() {
  const to = $('#send-message-project').value;
  const text = $('#send-message-text').value.trim();
  if (!to || !text) return ($('#send-message-error').textContent = 'Pilih project dan isi pesan.');
  $('#send-message-send').disabled = true;
  try {
    await api(`/api/projects/${encodeURIComponent(to)}/prompt`, { text: text.slice(0, 4000) });
    $('#send-message-modal [data-close]')?.click();
    toast('Pesan dikirim sebagai prompt di project tujuan.', 'ok');
  } catch (err) {
    $('#send-message-error').textContent = err.message;
  } finally {
    $('#send-message-send').disabled = false;
  }
}

export function initSendMessage() {
  $('#send-message-send').addEventListener('click', send);
}
