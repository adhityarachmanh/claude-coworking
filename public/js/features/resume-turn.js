// A turn cut short by a server restart (status `interrupted`, see Hub.recoverTurns): a banner above the composer
// with "Lanjutkan" (continue in the same Claude Code session) and "Tutup". Nothing is sent without that click:
// continuing costs tokens, so the user decides.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, READ_ONLY_HINT, state } from '../core/state.js';

const REASON = {
  shutdown: 'Server di-restart saat Claude sedang bekerja — giliran terputus.',
  crash: 'Server berhenti mendadak saat Claude sedang bekerja — giliran terputus.',
  exit: 'Claude Code berhenti di tengah giliran — giliran terputus.',
};

const timeOf = (ts) => (ts ? new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '');

/** Called with the active project's status whenever it changes (from renderComposer). */
export function renderResumeTurn(st) {
  const box = $('#resume-turn');
  if (!box) return;
  const cut = state.active === DEMO_ID ? null : st?.interrupted;
  // While a turn runs (e.g. the user already typed something) the banner would only be noise.
  if (!cut || st.busy) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  // 📎 Continuing in the same session needs nothing more (the files are in that conversation already); a prompt
  // resent because there was no session yet goes out as text only (file contents are never stored on the server).
  const lost = !cut.sessionId && cut.attachments > 0;
  const what = cut.sessionId ? 'Lanjutkan di sesi yang sama' : lost ? 'Kirim ulang prompt tadi (tanpa lampiran)' : 'Kirim ulang prompt tadi';
  const disabled = state.readOnly ? `disabled title="${escapeHtml(READ_ONLY_HINT)}"` : '';
  box.hidden = false;
  box.innerHTML = `<div class="resume-text">⚠ ${escapeHtml(REASON[cut.reason] ?? REASON.shutdown)}${cut.at ? ` <small class="muted">(${timeOf(cut.at)})</small>` : ''}${
    cut.prompt ? `<small class="muted resume-prompt">Prompt: “${escapeHtml(cut.prompt)}”</small>` : ''
  }${lost ? `<small class="muted resume-attach">📎 ${cut.attachments} lampiran tidak ikut dikirim ulang — lampirkan lagi bila perlu.</small>` : ''}</div><div class="resume-actions"><button type="button" class="primary" data-resume="continue" title="${what}" ${disabled}>▶ Lanjutkan</button><button type="button" class="ghost" data-resume="dismiss" title="Abaikan pemberitahuan ini" ${disabled}>Tutup</button></div>`;
}

export function initResumeTurn() {
  // The banner sits right above the todo list in the composer (created here: no change to index.html needed).
  const box = document.createElement('div');
  box.id = 'resume-turn';
  box.className = 'resume-turn';
  box.hidden = true;
  box.setAttribute('role', 'status');
  $('#todos').before(box);

  box.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-resume]');
    if (!btn || !state.active) return;
    const dismiss = btn.dataset.resume === 'dismiss';
    for (const b of box.querySelectorAll('button')) b.disabled = true;
    try {
      const res = await api(`/api/projects/${state.active}/continue`, dismiss ? { dismiss: true } : {});
      if (!dismiss) toast(res?.lostAttachments > 0 ? `Prompt dikirim ulang tanpa ${res.lostAttachments} lampiran — lampirkan lagi bila perlu.` : 'Melanjutkan pekerjaan yang terputus…', res?.lostAttachments > 0 ? 'warn' : 'ok');
    } catch (err) {
      toast(err.message);
      for (const b of box.querySelectorAll('button')) b.disabled = Boolean(state.readOnly);
    }
  });
}
