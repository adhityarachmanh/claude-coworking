// 📂 Folder tambahan: folders outside the project Claude Code may read and write (CLI `--add-dir`). The list is an
// attribute of the project (settings.additionalDirectories); a change reaches the next Claude process.
// Reads are Tailscale/laptop; add and remove are laptop-only (src/routes/add-dirs.js).
import { api, laptopBlocked, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, projectName, READ_ONLY_HINT, state } from '../core/state.js';
import { projectEngine } from './engine.js';
import { openModal } from '../ui/modals.js';

const view = { project: null, busy: false };
const DEFAULT_MAX = 10;

const setError = (text) => {
  const el = $('#dirs-error');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
};

/** The folder's own name for the bold line; the full path goes underneath. */
const folderName = (dir) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;

/** Opens the dialog and loads the list for the active project. */
export function openAddDirs() {
  if (projectEngine() !== 'claude') return toast('Folder tambahan hanya tersedia saat model Claude aktif.', 'warn');
  // The list route is laptop/Tailscale only (not in the plain-WiFi read allowlist).
  if (state.readOnly) return toast('Folder tambahan hanya bisa dibuka dari laptop atau lewat Tailscale.', 'warn');
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu untuk mengelola folder tambahan.');
  view.project = state.active;
  $('#dirs-project').textContent = `· ${projectName(state.active)}`;
  $('#dirs-sum').textContent = 'Memuat…';
  $('#dirs-list').innerHTML = '';
  setError('');
  $('#dirs-path').value = '';
  openModal('dirs-modal');
  refresh();
}

async function refresh() {
  const project = view.project;
  if (!project) return;
  try {
    const data = await api(`/api/projects/${project}/dirs`);
    if (view.project !== project) return;
    render(data);
  } catch (err) {
    if (view.project !== project) return;
    $('#dirs-sum').textContent = '';
    $('#dirs-list').innerHTML = `<li class="state-error">Gagal memuat folder tambahan: ${escapeHtml(err.message)}</li>`;
  }
}

function render(data) {
  const list = Array.isArray(data?.dirs) ? data.dirs : [];
  const max = Number.isInteger(data?.max) ? data.max : DEFAULT_MAX;
  const ro = Boolean(state.readOnly);
  const laptop = laptopBlocked('/api/projects/contoh/dirs-add');
  const blocked = ro || laptop;
  $('#dirs-sum').textContent = list.length ? `${list.length} dari ${max} folder tambahan.` : 'Belum ada folder tambahan.';
  $('#dirs-list').innerHTML = list
    .map((entry) => {
      const dir = String(entry?.path ?? '');
      // A folder deleted outside the app stays listed (it can still be removed) but says so.
      const badge = entry?.exists === false ? '<span class="wt-badge">tidak ditemukan</span>' : '';
      return `<li data-dir="${escapeHtml(dir)}"><span class="wt-name"><b>${escapeHtml(folderName(dir))}</b><small class="muted">${escapeHtml(dir)}</small></span>${badge}<span class="wt-actions"><button type="button" class="ghost danger-text" data-dir-remove${blocked ? ' disabled' : ''} title="${ro ? READ_ONLY_HINT : 'Lepas folder ini dari daftar (foldernya tidak dihapus)'}">Lepas</button></span></li>`;
    })
    .join('');
  $('#dirs-path').disabled = blocked || view.busy;
  const add = $('#dirs-add');
  add.disabled = blocked || view.busy || list.length >= max;
  add.title = list.length >= max ? `Maksimal ${max} folder tambahan` : '';
  const note = $('#dirs-laptop-note');
  if (note) note.hidden = !laptop;
}

/** One write: the same busy guard and refresh for both routes. */
async function act(path, body, okText) {
  if (view.busy || state.readOnly) return false;
  const project = view.project;
  view.busy = true;
  $('#dirs-add').disabled = true;
  setError('');
  let ok = false;
  try {
    await api(`/api/projects/${project}${path}`, body);
    if (view.project !== project) return false;
    toast(okText, 'ok');
    ok = true;
  } catch (err) {
    if (view.project !== project) return false;
    // An add error belongs next to the field (the typed path stays); a remove error is just a toast.
    if (path === '/dirs-add') setError(err.message);
    else toast(err.message);
  } finally {
    view.busy = false;
    if (view.project === project) await refresh(); // never leave stale rows behind, success or failure
  }
  return ok;
}

let wired = false;

export function initAddDirs() {
  if (wired) return;
  wired = true;
  $('#dirs-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = $('#dirs-path').value.trim();
    if (!value) return setError('Tulis path folder dulu.');
    // Only a landed add clears the field: a rejected path stays for the user to fix.
    if (await act('/dirs-add', { path: value }, 'Folder tambahan ditambahkan. Berlaku pada pesan berikutnya.')) $('#dirs-path').value = '';
  });
  $('#dirs-list').addEventListener('click', async (e) => {
    const row = e.target.closest('li[data-dir]');
    if (!row || !e.target.closest('[data-dir-remove]')) return;
    const dir = row.dataset.dir;
    if (!window.confirm(`Lepas folder "${dir}" dari daftar?\n\nFolder dan isinya tidak dihapus; Claude hanya tidak lagi boleh membuka folder itu.`)) return;
    await act('/dirs-remove', { path: dir }, 'Folder tambahan dilepas.');
  });
}
