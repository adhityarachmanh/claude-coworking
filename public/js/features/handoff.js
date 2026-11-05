// 🔁 Lanjutkan dari mesin lain (/lanjut, ⋯ menu): carries a project's context from the other engine's workspace
// (Claude Code ↔ OpenCode) into this one as an opening message the user reviews first (server: src/handoff.js).
// Two modes: Cepat (free, from the stored chat) and Pintar (the ACTIVE engine writes the note from that stored
// transcript; costs a few thousand tokens of the active engine, never the parked source engine).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { engineLabel, engineOf } from '../core/engine-caps.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { fillComposer } from './composer.js';

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
  body.innerHTML = `<p>Bawa konteks percakapan <b>${escapeHtml(i.label)}</b> project ini (${i.messages} pesan${when ? `, terakhir ${escapeHtml(when)}` : ''}) ke <b>${escapeHtml(target)}</b>. Hasilnya masuk ke kotak pesan sebagai pembuka; kamu bisa membaca dan mengeditnya sebelum dikirim. Riwayat asli tidak diubah.</p>
    <div class="handoff-modes" role="radiogroup" aria-label="Mode">
      <label class="handoff-mode"><input type="radio" name="ho-mode" value="quick" checked>
        <span><b>⚡ Cepat</b> <small class="pill ok">gratis</small><br><small class="muted">Disusun aplikasi dari riwayat chat: tujuan awal, ${Math.min(i.messages, 30)} pesan terakhir (dipadatkan), langkah terakhir, dan file yang berubah (git). Instan, tanpa token. Detail yang hanya ada di kepala ${escapeHtml(i.label)} (alasan keputusan, isi file yang dibaca) tidak ikut.</small></span></label>
      <label class="handoff-mode${i.hasSession ? '' : ' disabled'}"><input type="radio" name="ho-mode" value="smart"${i.hasSession ? '' : ' disabled'}>
        <span><b>🧠 Pintar</b> <small class="pill warn">pakai token mesin aktif</small><br><small class="muted">${escapeHtml(i.toLabel)} menulis catatan handoff dari riwayat percakapan ${escapeHtml(i.label)}: tujuan, yang sudah dikerjakan, keputusan & alasannya, status, langkah berikutnya. Paling lengkap. <b>Memakai token akun ${escapeHtml(i.toLabel)}</b> — mesin yang sedang aktif, bukan ${escapeHtml(i.label)} (biasanya beberapa ribu token, sekitar 30–90 detik). File project tidak diubah.</small></span></label>
    </div>
    <div class="acct-actions"><button type="button" class="primary" data-ho="make"${ho.busy ? ' disabled' : ''}>${ho.busy ? '<span class="spinner"></span> Menyusun…' : 'Susun konteks'}</button></div>
    <div id="handoff-preview" hidden>
      <label class="oc-field"><span>Pratinjau (bisa diedit)</span><textarea id="handoff-text" rows="12" class="memory-text"></textarea></label>
      <div class="acct-actions"><button type="button" class="primary" data-ho="use">Masukkan ke kotak pesan</button></div>
    </div>`;
}

export async function openHandoff() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (state.readOnly) return toast('Hanya dari laptop atau lewat Tailscale.', 'warn');
  ho.info = null;
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

async function make() {
  const mode = document.querySelector('input[name="ho-mode"]:checked')?.value ?? 'quick';
  if (mode === 'smart' && !window.confirm(`Mode Pintar memakai token akun ${ho.info.toLabel} (mesin aktif; biasanya beberapa ribu token). Lanjutkan?`)) return;
  ho.busy = true;
  render();
  document.querySelector(`input[name="ho-mode"][value="${mode}"]`).checked = true;
  try {
    const r = await api(`/api/projects/${state.active}/handoff`, { mode });
    ho.busy = false;
    render();
    document.querySelector(`input[name="ho-mode"][value="${mode}"]`).checked = true;
    $('#handoff-preview').hidden = false;
    $('#handoff-text').value = r.text;
    $('#handoff-text').focus();
  } catch (err) {
    ho.busy = false;
    render();
    toast(err.data?.error ?? err.message, 'warn');
  }
}

export function initHandoff() {
  $('#handoff-body').addEventListener('click', (e) => {
    const act = e.target.closest('[data-ho]')?.dataset.ho;
    if (act === 'make') return make();
    if (act === 'use') {
      const text = $('#handoff-text').value.trim();
      if (!text) return;
      closeModal('handoff-modal');
      document.querySelector('.tabs button[data-tab="chat"]')?.click();
      fillComposer(text);
      toast('Konteks ada di kotak pesan. Tambahkan permintaanmu di bawahnya, lalu kirim.', 'ok');
    }
  });
}
