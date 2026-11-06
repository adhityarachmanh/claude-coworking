// 🔁 Lanjutkan dari mesin lain (/lanjut, ⋯ menu): one action. The app builds the free context from the other
// engine's stored chat and immediately sends a context-only prompt to this session, so the AI remembers it. Nothing
// is executed and no plan card is offered for that turn (server: src/handoff.js, src/routes/extensions.js).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { engineLabel, engineOf } from '../core/engine-caps.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';

const ho = { info: null, busy: false };

function render() {
  const i = ho.info;
  const body = $('#handoff-body');
  if (!i) return void (body.innerHTML = '<p class="muted">Memeriksa riwayat…</p>');
  // The project's engine receives the note: the answer's `to` when it is a known engine, else the project's status.
  const target = engineLabel(engineOf({ engine: i.to ?? state.statuses[state.active]?.engine }, state.config));
  if (!i.messages) {
    body.innerHTML = `<p>Belum ada percakapan <b>${escapeHtml(i.label)}</b> di project ini, jadi tidak ada konteks untuk dibawa.</p>`;
    return;
  }
  const when = i.lastAt ? new Date(i.lastAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  body.innerHTML = `<p>Bawa konteks percakapan <b>${escapeHtml(i.label)}</b> project ini (${i.messages} pesan${when ? `, terakhir ${escapeHtml(when)}` : ''}) ke <b>${escapeHtml(target)}</b>.</p>
    <p class="muted small">Konteks akan langsung dikirim ke sesi ini dan diingat AI. Turn ini hanya untuk konteks: tidak mengerjakan apa pun, tidak meminta izin, dan tidak memunculkan kartu rencana. Gratis dari riwayat chat; riwayat asli tidak diubah.</p>
    <div class="acct-actions"><button type="button" class="primary" data-ho="apply"${ho.busy ? ' disabled' : ''}>${ho.busy ? '<span class="spinner"></span> Menerapkan…' : 'Terapkan'}</button></div>`;
}

export async function openHandoff() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (state.readOnly) return toast('Hanya dari laptop atau lewat Tailscale.', 'warn');
  ho.info = null;
  ho.busy = false;
  $('#handoff-project').textContent = `· ${projectName(state.active)}`;
  openModal('handoff-modal');
  render();
  try {
    ho.info = await api(`/api/projects/${state.active}/handoff/info`);
  } catch (err) {
    $('#handoff-body').innerHTML = `<p class="state-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  render();
}

async function apply() {
  if (ho.busy || !ho.info?.messages) return;
  ho.busy = true;
  render();
  try {
    await api(`/api/projects/${state.active}/handoff/apply`);
    closeModal('handoff-modal');
    toast('Konteks diterapkan. AI akan mengingatnya di sesi ini.', 'ok');
  } catch (err) {
    ho.busy = false;
    render();
    toast(err.data?.error ?? err.message, 'warn');
  }
}

export function initHandoff() {
  $('#handoff-body').addEventListener('click', (e) => {
    if (e.target.closest('[data-ho="apply"]')) apply();
  });
}
