// ⎇ Worktree: list, create, enter, leave and remove this project's git worktrees (src/routes/worktree.js). A worktree
// is an attribute of the project — the session runs in its folder, but the project, ledger and history stay the same.
import { api, laptopBlocked, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, projectName, READ_ONLY_HINT, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

const view = { project: null, busy: false };

/** The server's error codes as the user sees them; an unknown one falls back to the server's own message. */
const MESSAGES = {
  'no-repo': 'Folder project ini bukan repository git, jadi belum bisa punya worktree.',
  'invalid-name': 'Nama worktree hanya boleh huruf kecil, angka, dan tanda hubung (1–64 karakter).',
  exists: 'Worktree dengan nama itu sudah ada.',
  dirty: 'Worktree itu masih punya perubahan yang belum di-commit. Hapus paksa akan membuang perubahan tersebut.',
  busy: 'Masih ada giliran yang berjalan. Tunggu selesai dulu, lalu coba lagi.',
  'not-found': 'Worktree itu sudah tidak ada. Muat ulang daftarnya.',
};

const messageFor = (err) => MESSAGES[err?.data?.code] ?? err.message;

/** Opens the dialog and loads the list for the active project. */
export async function openWorktree() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu untuk mengelola worktree.');
  view.project = state.active;
  $('#worktree-project').textContent = `· ${projectName(state.active)}`;
  $('#worktree-sum').textContent = 'Memuat…';
  $('#worktree-list').innerHTML = '';
  $('#worktree-exit').hidden = true;
  openModal('worktree-modal');
  await refresh();
}

async function refresh() {
  const project = view.project;
  if (!project) return;
  try {
    const data = await api(`/api/projects/${project}/worktrees`);
    if (view.project !== project) return;
    render(data);
  } catch (err) {
    if (view.project !== project) return;
    $('#worktree-sum').textContent = '';
    $('#worktree-list').innerHTML = `<li class="state-error">Gagal memuat worktree: ${escapeHtml(messageFor(err))}</li>`;
  }
}

function render(data) {
  const list = Array.isArray(data?.worktrees) ? data.worktrees : [];
  const active = data?.active ?? null;
  $('#worktree-sum').textContent = active ? `Aktif: ${active} · sesi berjalan di sana` : 'Sesi berjalan di folder project.';
  $('#worktree-exit').hidden = !active;
  const ro = Boolean(state.readOnly);
  const laptop = laptopBlocked('/api/projects/contoh/worktree-create');
  const blocked = ro || laptop;
  $('#worktree-list').innerHTML = list
    .map((w) => {
      const name = w.name ?? '';
      const isActive = !w.isMain && active === name;
      const branch = w.branch ? `<small class="muted">${escapeHtml(w.branch)}</small>` : '';
      const badge = w.isMain ? '<span class="wt-badge">repo utama</span>' : isActive ? '<span class="wt-badge on">aktif</span>' : '';
      const actions = w.isMain
        ? ''
        : `<span class="wt-actions">${isActive ? '' : `<button type="button" class="ghost" data-wt="enter"${blocked ? ' disabled' : ''} title="${ro ? READ_ONLY_HINT : 'Jalankan sesi berikutnya di worktree ini'}">Masuk</button>`}<button type="button" class="ghost danger-text" data-wt="remove"${blocked ? ' disabled' : ''} title="${ro ? READ_ONLY_HINT : 'Hapus folder worktree ini'}">Hapus</button></span>`;
      return `<li data-name="${escapeHtml(name)}" data-main="${w.isMain}" data-active="${isActive}"${isActive ? ' class="active"' : ''}><span class="wt-name"><b>${escapeHtml(name)}</b>${branch}</span>${badge}${actions}</li>`;
    })
    .join('');
  const btn = $('#worktree-create');
  btn.disabled = blocked || view.busy;
  btn.title = ro ? READ_ONLY_HINT : 'Buat worktree baru dari commit saat ini';
  $('#worktree-name').disabled = blocked;
  const exit = $('#worktree-exit');
  exit.disabled = blocked || view.busy;
  exit.title = ro ? READ_ONLY_HINT : 'Sesi berikutnya kembali berjalan di folder project';
  const note = $('#worktree-laptop-note');
  if (note) note.hidden = !laptop;
}

/**
 * One write action: the same busy guard, error translation and refresh for all four routes. A rejected `dirty`
 * remove is offered as a forced one, so the user decides in the same flow instead of hunting for a flag.
 * Resolves true when the action landed (used by the create form to clear its input).
 */
async function act(path, body, okText) {
  if (view.busy || state.readOnly) return false;
  const project = view.project;
  view.busy = true;
  $('#worktree-create').disabled = true;
  let ok = false;
  try {
    await api(`/api/projects/${project}${path}`, body);
    if (view.project !== project) return false;
    toast(okText, 'ok');
    ok = true;
  } catch (err) {
    if (view.project !== project) return false;
    if (err?.data?.code === 'dirty' && path === '/worktree-remove') {
      if (!window.confirm(`${messageFor(err)}\n\nHapus paksa dan buang perubahan itu?`)) return false;
      try {
        await api(`/api/projects/${project}${path}`, { ...body, force: true });
        if (view.project === project) {
          toast(okText, 'ok');
          ok = true;
        }
      } catch (again) {
        if (view.project === project) toast(messageFor(again));
      }
    } else {
      toast(messageFor(err));
    }
  } finally {
    view.busy = false;
    if (view.project === project) await refresh(); // never leave stale rows behind, success or failure
  }
  return ok;
}

let wired = false;

export function initWorktree() {
  if (wired) return;
  wired = true;
  $('#worktree-create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#worktree-name').value.trim();
    if (!name) return toast('Tulis nama worktree dulu.');
    // Only a landed create clears the field: a rejected name (invalid, exists) stays for the user to fix.
    if (await act('/worktree-create', { name }, `Worktree ${name} dibuat.`)) $('#worktree-name').value = '';
  });
  $('#worktree-exit').addEventListener('click', () => act('/worktree-exit', {}, 'Keluar dari worktree — sesi berikutnya kembali di folder project.'));
  $('#worktree-list').addEventListener('click', async (e) => {
    const row = e.target.closest('li[data-name]');
    const action = e.target.closest('[data-wt]')?.dataset.wt;
    if (!row || !action) return;
    const name = row.dataset.name;
    if (action === 'enter') return act('/worktree-enter', { name }, `Worktree ${name} aktif — sesi berikutnya berjalan di sana.`);
    if (!window.confirm(`Hapus worktree "${name}"?\n\nFolder salinannya dibuang. Perubahan yang belum di-commit akan ditanyakan lagi sebelum dibuang.`)) return;
    await act('/worktree-remove', { name }, `Worktree ${name} dihapus.`);
  });
  // The chip in the session bar is the shortcut back to the dialog.
  $('#sb-worktree').addEventListener('click', openWorktree);
}
