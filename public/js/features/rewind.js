// Rewind (Esc Esc, /rewind): Claude Code's checkpoints.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { shortDate } from '../core/format.js';
import { DEMO_ID, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { fillComposer } from './composer.js';

const rewindView = { project: null, points: [], selected: null, preview: null };

export async function openRewind() {
  if (state.active === DEMO_ID || state.readOnly) return;
  if ((state.statuses[state.active] ?? {}).busy) return toast('Tim masih bekerja. Tekan Esc untuk menghentikan dulu, lalu Esc Esc.', 'warn');
  Object.assign(rewindView, { project: state.active, points: [], selected: null, preview: null });
  $('#rewind-list').innerHTML = '<li class="muted">Memuat percakapan…</li>';
  $('#rewind-detail').hidden = true;
  openModal('rewind-modal');
  try {
    rewindView.points = (await api(`/api/projects/${state.active}/rewind-points`)).points;
    renderRewindList();
  } catch (err) {
    $('#rewind-list').innerHTML = `<li class="muted"><div class="state-error">${escapeHtml(err.message)}</div></li>`;
  }
}

function renderRewindList() {
  const list = $('#rewind-list');
  if (!rewindView.points.length) {
    list.innerHTML = '<li class="muted">Belum ada pesan di percakapan ini yang bisa di-rewind.</li>';
    return;
  }
  list.innerHTML = rewindView.points
    .map((p, i) => `<li><button type="button" class="${rewindView.selected === p.uuid ? 'active' : ''}" data-uuid="${escapeHtml(p.uuid)}"><span class="rw-text">${escapeHtml(p.text)}</span><small>${i === 0 ? 'pesan terakhir · ' : ''}${shortDate(p.ts)}</small></button></li>`)
    .join('');
}

async function selectRewind(uuid) {
  Object.assign(rewindView, { selected: uuid, preview: null });
  renderRewindList();
  renderRewindDetail();
  let preview;
  try {
    preview = await api(`/api/projects/${rewindView.project}/rewind-preview`, { uuid }); // dry run: which files would change back
  } catch (err) {
    preview = { canRewind: false, error: err.message };
  }
  if (rewindView.selected !== uuid) return;
  rewindView.preview = preview;
  renderRewindDetail();
}

function renderRewindDetail() {
  const box = $('#rewind-detail');
  const point = rewindView.points.find((p) => p.uuid === rewindView.selected);
  box.hidden = !point;
  if (!point) return;
  const pv = rewindView.preview;
  const files = pv?.filesChanged ?? [];
  const codeOk = Boolean(pv?.canRewind && files.length);
  const short = (f) => f.split(/[\\/]/).slice(-2).join('/');
  let summary;
  if (!pv) summary = '<span class="muted">Memeriksa perubahan file…</span>';
  else if (codeOk) {
    summary = `<b>${files.length} file</b> kembali seperti sebelum pesan ini <span class="add">+${pv.insertions ?? 0}</span> <span class="del">−${pv.deletions ?? 0}</span><ul class="rw-files">${files
      .slice(0, 8)
      .map((f) => `<li title="${escapeHtml(f)}">${escapeHtml(short(f))}</li>`)
      .join('')}${files.length > 8 ? `<li class="muted">+${files.length - 8} lainnya</li>` : ''}</ul>`;
  } else summary = `<span class="muted">${pv.canRewind ? 'Tidak ada file yang diubah sejak pesan ini.' : `Kode tidak bisa dikembalikan: ${escapeHtml(pv.error ?? 'tidak ada checkpoint untuk pesan ini')}`}</span>`;
  box.innerHTML = `<div class="rw-head">Kembali ke sebelum: <i>“${escapeHtml(point.text.slice(0, 200))}”</i></div><div class="rw-summary">${summary}</div>
    <div class="rw-actions">
      <button class="primary" data-rw="both" ${codeOk ? '' : 'disabled'}>⏪ Kode &amp; percakapan</button>
      <button data-rw="conversation">💬 Percakapan saja</button>
      <button data-rw="code" ${codeOk ? '' : 'disabled'}>📄 Kode saja</button>
    </div>`;
}

export function initRewind() {
  $('#rewind-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-uuid]');
    if (btn) selectRewind(btn.dataset.uuid);
  });

  $('#rewind-detail').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-rw]');
    if (!btn || !rewindView.selected) return;
    const how = btn.dataset.rw;
    const body = { uuid: rewindView.selected, code: how !== 'conversation', conversation: how !== 'code' };
    $('#rewind-detail').querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const { text } = await api(`/api/projects/${rewindView.project}/rewind`, body);
      closeModal('rewind-modal');
      // As in the CLI, the rewound prompt comes back into the box to edit and resend.
      if (body.conversation && text) fillComposer(text);
      toast(body.conversation ? 'Dikembalikan. Pesanmu ada di kotak pesan untuk diedit.' : 'Kode dikembalikan.', 'ok');
    } catch (err) {
      toast(err.message);
      renderRewindDetail();
    }
  });
}
