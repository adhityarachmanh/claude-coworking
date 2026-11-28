// 🖼 Project media (`/media`): images/videos already in the project folder. The server only lists them; opening a
// row reuses the file viewer (images are previewed there).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { openFile } from './file-viewer.js';

const md = { project: null, media: [] };

const bytes = (n) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

function render() {
  $('#media-project').textContent = md.project ? `· ${projectName(md.project)}` : '';
  const body = $('#media-body');
  if (!md.media.length) {
    body.innerHTML = '<p class="muted small">Belum ada gambar atau video di folder project ini.</p>';
    return;
  }
  body.innerHTML = `<ul class="ext-list">${md.media
    .map((m, i) => `<li data-media="${i}" role="button" tabindex="0" title="Buka di penampil file"><div><b>${m.kind === 'video' ? '🎬' : '🖼'} ${escapeHtml(m.name)}</b> <small class="muted">${escapeHtml(m.path)} · ${bytes(m.size)}</small></div></li>`)
    .join('')}</ul>`;
}

export async function openMedia() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (state.readOnly) return toast('Media hanya bisa dibuka dari laptop atau lewat Tailscale.', 'warn');
  md.project = state.active;
  md.media = [];
  openModal('media-modal');
  render();
  $('#media-body').innerHTML = '<p class="muted"><span class="spinner" aria-hidden="true"></span> Mencari media…</p>';
  try {
    const data = await api(`/api/projects/${md.project}/media`);
    md.media = Array.isArray(data.media) ? data.media : [];
    render();
  } catch (err) {
    $('#media-body').innerHTML = `<p class="state-error">${escapeHtml(err.message)}</p>`;
  }
}

export function initMedia() {
  $('#media-body').addEventListener('click', (e) => {
    const row = e.target.closest('[data-media]');
    if (!row) return;
    const m = md.media[Number(row.dataset.media)];
    if (!m) return;
    $('#media-modal [data-close]')?.click();
    openFile(m.path);
  });
  $('#media-body').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-media]');
    if (!row) return;
    e.preventDefault();
    row.click();
  });
}
