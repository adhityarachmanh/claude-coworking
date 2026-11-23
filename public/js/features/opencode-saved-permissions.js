// 🛡️ Izin tersimpan OpenCode ("Allow always", permission.saved.*): review and forget durable allows from the app.
// Reading is open to laptop/Tailscale; the server refuses removal from anything but the laptop.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { projectEngine } from './engine.js';

let rows = [];

function render() {
  const list = $('#oc-perm-list');
  if (!rows.length) {
    list.innerHTML = '<li class="muted">Belum ada izin tersimpan.</li>';
    return;
  }
  list.innerHTML = rows
    .map((p) => `<li data-id="${escapeHtml(p.id)}"><code>${escapeHtml(p.action)}</code> ${escapeHtml(p.resource)}${state.local ? '<button type="button" class="ghost danger-text" data-oc-perm="remove" title="Hapus izin ini">🗑 Hapus</button>' : ''}</li>`)
    .join('');
}

export async function openSavedPermissions() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (projectEngine() !== 'opencode') return toast('Izin tersimpan ini hanya untuk project OpenCode.', 'warn');
  openModal('oc-perm-modal');
  $('#oc-perm-error').textContent = '';
  $('#oc-perm-list').innerHTML = '<li class="muted">Memuat…</li>';
  try {
    const data = await api('/api/opencode-permissions/saved');
    rows = Array.isArray(data.permissions) ? data.permissions : [];
    render();
  } catch (err) {
    rows = [];
    $('#oc-perm-list').innerHTML = '';
    $('#oc-perm-error').textContent = err.message;
  }
}

export function initSavedPermissions() {
  $('#oc-perm-list').addEventListener('click', async (e) => {
    const button = e.target.closest('[data-oc-perm="remove"]');
    const id = button?.closest('li')?.dataset.id;
    if (!id) return;
    button.disabled = true;
    try {
      await api('/api/opencode-permissions/remove', { id });
      rows = rows.filter((p) => p.id !== id);
      render();
      toast('Izin dihapus. Permintaan berikutnya akan bertanya lagi.', 'ok');
    } catch (err) {
      button.disabled = false;
      $('#oc-perm-error').textContent = err.message;
    }
  });
}
