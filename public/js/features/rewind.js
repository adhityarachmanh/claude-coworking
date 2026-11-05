// Rewind (Esc Esc, /rewind): Claude Code's checkpoints, or OpenCode's session revert (conversation ± its file snapshots).
// A code rewind also keeps a redo bundle: the uncommitted code changes it just restored can be re-applied from there.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { shortDate } from '../core/format.js';
import { DEMO_ID, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { loadChanges } from './changes.js';
import { fillComposer } from './composer.js';

const rewindView = {
  project: null,
  points: [],
  selected: null,
  preview: null,
  bundles: [], // ready redo bundles from redo-list (newest first)
  redoBundle: null, // the bundle on offer: { id, createdAt, files }
  redoPreview: null, // redo-preview answer for redoBundle
  redoLoading: false,
  redoBusy: false,
  redoError: '',
  overwrite: false,
};

const asArray = (value) => (Array.isArray(value) ? value : []);
const asCount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
/** Epoch millis, or an ISO string the server may send instead. */
const asTime = (value) => {
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : 0;
};
const shortPath = (f) => String(f).split(/[\\/]/).slice(-2).join('/');

function setRewindError(message = '') {
  $('#rewind-error').textContent = message;
}

/** Only what the dialog can show: a string id, a timestamp, plain file paths; "ready" bundles only. */
function normalizeBundles(res) {
  return asArray(res?.bundles)
    .filter((b) => b && typeof b.id === 'string' && b.id && b.status === 'ready')
    .map((b) => {
      const files = asArray(b.files).filter((f) => typeof f === 'string');
      return { id: b.id, createdAt: asTime(b.createdAt), files, count: Array.isArray(b.files) ? files.length : asCount(b.files) };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** A preview row, or a bare path from the rewind answer, becomes { path, action, conflict }. */
function normalizeRedoFiles(source) {
  return asArray(source?.files)
    .map((f) => {
      if (typeof f === 'string') return { path: f, action: 'restore', conflict: false };
      return {
        path: typeof f?.path === 'string' ? f.path : '',
        action: f?.action === 'delete' ? 'delete' : 'restore',
        conflict: f?.conflict === true,
      };
    })
    .filter((f) => f.path);
}

function conflictCount(preview, files) {
  if (Array.isArray(preview?.conflicts)) return preview.conflicts.length;
  if (Number.isFinite(preview?.conflicts)) return Math.max(0, Math.floor(preview.conflicts));
  return files.filter((f) => f.conflict).length; // a preview without the count still marks each file
}

function unsupportedFiles(preview) {
  return asArray(preview?.unsupported).filter((f) => typeof f === 'string');
}

function resetRedo() {
  Object.assign(rewindView, { redoBundle: null, redoPreview: null, redoLoading: false, redoBusy: false, redoError: '', overwrite: false });
}

export async function openRewind() {
  if (state.active === DEMO_ID || state.readOnly) return;
  if ((state.statuses[state.active] ?? {}).busy) return toast('Tim masih bekerja. Tekan Esc untuk menghentikan dulu, lalu Esc Esc.', 'warn');
  const project = state.active;
  Object.assign(rewindView, { project, points: [], selected: null, preview: null, bundles: [] });
  resetRedo();
  $('#rewind-list').innerHTML = '<li class="muted">Memuat percakapan…</li>';
  $('#rewind-detail').hidden = true;
  $('#rewind-redo').hidden = true;
  $('#rewind-redo').innerHTML = '';
  setRewindError('');
  openModal('rewind-modal');
  // Both are independent reads: a broken redo list must never hide the rewind points (and vice versa).
  const [points, bundles] = await Promise.allSettled([
    api(`/api/projects/${project}/rewind-points`),
    api(`/api/projects/${project}/redo-list`),
  ]);
  if (rewindView.project !== project) return; // another project was opened meanwhile
  if (points.status === 'fulfilled') {
    rewindView.points = asArray(points.value?.points).filter((p) => p && typeof p.uuid === 'string');
    renderRewindList();
  } else {
    $('#rewind-list').innerHTML = `<li class="muted"><div class="state-error">${escapeHtml(points.reason?.message ?? 'Gagal memuat percakapan.')}</div></li>`;
  }
  if (bundles.status === 'fulfilled') {
    rewindView.bundles = normalizeBundles(bundles.value);
    renderRedo();
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
  resetRedo();
  setRewindError('');
  renderRewindList();
  renderRewindDetail();
  renderRedo();
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
  const files = Array.isArray(pv?.filesChanged) ? pv.filesChanged : [];
  // OpenCode: a prompt older than the scanned messages has an unknown file list, its files still come back
  const unknown = pv?.filesUnknown === true;
  const codeOk = Boolean(pv?.canRewind && (files.length || unknown));
  const codeOnlyOk = codeOk && pv?.codeOnly !== false; // OpenCode reverts files only together with the conversation
  // +/− only when the engine counts them (Claude's checkpoints do, OpenCode's preview doesn't)
  const counts = Number.isFinite(pv?.insertions) || Number.isFinite(pv?.deletions) ? ` <span class="add">+${pv.insertions ?? 0}</span> <span class="del">−${pv.deletions ?? 0}</span>` : '';
  let summary;
  if (!pv) summary = '<span class="muted">Memeriksa perubahan file…</span>';
  else if (codeOk && files.length) {
    summary = `<b>${files.length} file</b> kembali seperti sebelum pesan ini${counts}<ul class="rw-files">${files
      .slice(0, 8)
      .map((f) => `<li title="${escapeHtml(f)}">${escapeHtml(shortPath(f))}</li>`)
      .join('')}${files.length > 8 ? `<li class="muted">+${files.length - 8} lainnya</li>` : ''}</ul>`;
  } else if (codeOk) summary = '<span class="muted">Pesan ini terlalu lama untuk dilihat daftar filenya; file yang diubah sejak pesan ini tetap dikembalikan.</span>';
  else summary = `<span class="muted">${pv.canRewind ? 'Tidak ada file yang diubah sejak pesan ini.' : `Kode tidak bisa dikembalikan: ${escapeHtml(pv.error ?? 'tidak ada checkpoint untuk pesan ini')}`}</span>`;
  const note = typeof pv?.note === 'string' && pv.note ? `<div class="rw-note muted">${escapeHtml(pv.note.slice(0, 400))}</div>` : '';
  const codeOnlyTitle = pv?.codeOnly === false ? ' title="Mesin ini hanya bisa mengembalikan kode bersama percakapannya"' : '';
  box.innerHTML = `<div class="rw-head">Kembali ke sebelum: <i>“${escapeHtml(point.text.slice(0, 200))}”</i></div><div class="rw-summary">${summary}</div>${note}
    <div class="rw-actions">
      <button class="primary" data-rw="both" ${codeOk ? '' : 'disabled'}>⏪ Kode &amp; percakapan</button>
      <button data-rw="conversation">💬 Percakapan saja</button>
      <button data-rw="code" ${codeOnlyOk ? '' : 'disabled'}${codeOnlyTitle}>📄 Kode saja</button>
    </div>`;
}

/** Keeps the section's controls in sync without re-rendering it (focus would be lost between clicks). */
function setRedoBusy(busy) {
  rewindView.redoBusy = busy;
  $('#rewind-redo')
    .querySelectorAll('button, input')
    .forEach((el) => (el.disabled = busy));
}

function renderRedo() {
  const box = $('#rewind-redo');
  if (!box) return;
  const bundle = rewindView.redoBundle;
  if (!bundle) {
    const recent = rewindView.bundles[0];
    if (!recent) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = `<button type="button" class="rw-redo-recent" data-redo-recent="${escapeHtml(recent.id)}">
      <span>↩ Ulangi rewind terakhir</span>
      <small>${recent.count} file · ${escapeHtml(shortDate(recent.createdAt))}</small>
    </button>`;
    return;
  }

  const pv = rewindView.redoPreview;
  const files = normalizeRedoFiles(pv ?? { files: bundle.files });
  const conflicts = conflictCount(pv, files);
  const unsupported = unsupportedFiles(pv);
  const busy = rewindView.redoBusy;
  const canRun = !busy && !rewindView.redoLoading && files.length > 0;
  const shown = files.slice(0, 200);
  const list = files.length
    ? `<ul class="rw-redo-files" aria-label="File yang terpengaruh redo">${shown
        .map(
          (f) =>
            `<li><span class="rw-mk ${f.action}">${f.action === 'delete' ? '✕ hapus' : '↩ kembalikan'}</span><span class="rw-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>${f.conflict ? '<span class="rw-conflict">⚠ bentrok</span>' : ''}</li>`,
        )
        .join('')}${files.length > shown.length ? `<li class="muted">+${files.length - shown.length} file lainnya</li>` : ''}</ul>`
    : '<p class="muted">Tidak ada file kode yang bisa dikembalikan dari rewind ini.</p>';
  const loading = rewindView.redoLoading ? '<p class="muted small rw-redo-loading">Memeriksa file…</p>' : '';
  const overwrite = conflicts
    ? `<p class="rw-redo-conflicts">${conflicts} file sudah kamu ubah setelah rewind dan akan dilewati.</p>
       <label class="rw-redo-overwrite"><input type="checkbox" data-redo-overwrite ${rewindView.overwrite ? 'checked' : ''} ${busy ? 'disabled' : ''} /><span>Timpa file yang sudah saya ubah</span></label>`
    : '';
  const unsupportedNote = unsupported.length ? `<p class="muted small rw-redo-unsupported">${unsupported.length} file tidak didukung redo dan tidak akan diubah.</p>` : '';
  const error = rewindView.redoError ? `<p class="field-error rw-redo-error" role="alert">${escapeHtml(rewindView.redoError)}</p>` : '';
  box.hidden = false;
  box.innerHTML = `<div class="rw-redo-head"><b id="rewind-redo-title">↩ Ulangi perubahan (redo)</b><small>${escapeHtml(shortDate(bundle.createdAt))}</small></div>
    <p class="muted rw-redo-note">Redo hanya mengembalikan perubahan kode yang belum di-commit — percakapan tidak berubah. File yang kamu ubah setelah rewind dilewati, kecuali kamu mencentang “Timpa file yang sudah saya ubah”. Cadangan rewind tetap disimpan.</p>
    ${loading}${list}${overwrite}${unsupportedNote}${error}
    <div class="rw-actions">
      <button type="button" data-redo="cancel" ${busy ? 'disabled' : ''}>Batal</button>
      <button type="button" class="primary" data-redo="run" ${canRun ? '' : 'disabled'}>↩ Ulangi</button>
    </div>`;
}

/** Shows one bundle and asks the server what it would do, so the confirmation names the real files and conflicts. */
async function offerRedo(bundle) {
  Object.assign(rewindView, {
    redoBundle: { id: bundle.id, createdAt: asTime(bundle.createdAt), files: asArray(bundle.files).filter((f) => typeof f === 'string') },
    redoPreview: null,
    redoLoading: true,
    redoBusy: false,
    redoError: '',
    overwrite: false,
  });
  setRewindError('');
  renderRedo();
  try {
    const preview = await api(`/api/projects/${rewindView.project}/redo-preview`, { id: bundle.id });
    if (rewindView.redoBundle?.id !== bundle.id) return;
    rewindView.redoPreview = preview && typeof preview === 'object' ? preview : null;
  } catch (err) {
    if (rewindView.redoBundle?.id !== bundle.id) return;
    // The files from the rewind answer still name what will change; the redo itself skips conflicts.
    rewindView.redoError = `Pratinjau gagal dimuat: ${err.message}`;
  }
  if (rewindView.redoBundle?.id !== bundle.id) return;
  rewindView.redoLoading = false;
  renderRedo();
}

async function runRedo() {
  const bundle = rewindView.redoBundle;
  if (!bundle || rewindView.redoBusy) return;
  const pv = rewindView.redoPreview;
  const files = normalizeRedoFiles(pv ?? { files: bundle.files });
  if (!files.length) return;
  const body = { id: bundle.id };
  // Only ask to overwrite when the user opted in; the server skips conflicts otherwise.
  if (rewindView.overwrite && conflictCount(pv, files) > 0) body.overwrite = true;
  rewindView.redoError = '';
  setRedoBusy(true);
  try {
    const res = await api(`/api/projects/${rewindView.project}/redo`, body);
    closeModal('rewind-modal');
    toast(`${asCount(res?.restored)} file dikembalikan, ${asCount(res?.skipped)} dilewati.`, 'ok');
    loadChanges(); // the working tree changed: the Changes tab and ⎇ git bar follow
  } catch (err) {
    setRedoBusy(false);
    rewindView.redoError = err?.message || 'Redo gagal.';
    renderRedo();
  }
}

function closeRedo() {
  closeModal('rewind-modal');
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
    // OpenCode: files not listed (too far back to scan in time) still come back: say so once more before doing it
    if (how === 'both' && rewindView.preview?.filesUnknown === true && !window.confirm('Daftar file untuk pesan ini tidak diketahui.\n\nSemua file yang diubah OpenCode sejak pesan ini tetap dikembalikan dari snapshot-nya (perubahanmu sendiri di file itu ikut tertimpa), dan pesan ini beserta sesudahnya dihapus dari sesi OpenCode.\n\nLanjutkan?')) return;
    const body = { uuid: rewindView.selected, code: how !== 'conversation', conversation: how !== 'code' };
    setRewindError('');
    $('#rewind-detail').querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const res = await api(`/api/projects/${rewindView.project}/rewind`, body);
      const text = typeof res?.text === 'string' ? res.text : '';
      // As in the CLI, the rewound prompt comes back into the box to edit and resend.
      if (body.conversation && text) fillComposer(text);
      if (body.code) loadChanges(); // the working tree changed: the Changes tab and ⎇ git bar follow
      toast(body.conversation ? 'Dikembalikan. Pesanmu ada di kotak pesan untuk diedit.' : 'Kode dikembalikan.', 'ok');
      const redo = res?.redo;
      if (body.code && redo && typeof redo.id === 'string' && redo.id) {
        // Keep the dialog open: the code changes this rewind restored can still be undone from its bundle.
        await offerRedo({ id: redo.id, createdAt: Date.now(), files: asArray(redo.files) });
      } else {
        closeModal('rewind-modal');
      }
    } catch (err) {
      // 409 (not a git repo / no snapshot) and any other refusal stay inline; there is no automatic retry.
      setRewindError(err?.message || 'Rewind gagal.');
      renderRewindDetail();
    }
  });

  const redoBox = $('#rewind-redo');
  redoBox.addEventListener('change', (e) => {
    if (e.target.matches('[data-redo-overwrite]')) rewindView.overwrite = e.target.checked;
  });
  redoBox.addEventListener('click', (e) => {
    const recent = e.target.closest('[data-redo-recent]');
    if (recent) {
      const bundle = rewindView.bundles.find((b) => b.id === recent.dataset.redoRecent);
      if (bundle) offerRedo(bundle);
      return;
    }
    const btn = e.target.closest('[data-redo]');
    if (!btn || btn.disabled) return;
    if (btn.dataset.redo === 'cancel') closeRedo();
    else if (btn.dataset.redo === 'run') runRedo();
  });
}
