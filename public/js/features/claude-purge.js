// 🧹 Bersihkan data Claude Code per project (`claude purge`): the dry-run plan first, then the workspace path typed back
// before the destructive call (server: src/claude-admin.js, src/routes/extensions.js).
import { api, toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { projectEngine } from './engine.js';

let target = ''; // the folder the server will purge (a worktree when one is active); typed back to confirm

export async function openPurge() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (state.readOnly) return toast('Bersihkan data Claude hanya bisa dijalankan dari laptop.', 'warn');
  if (projectEngine() !== 'claude') return toast('Bersihkan data hanya tersedia saat model Claude aktif.', 'warn');
  const id = state.active;
  target = state.projects.find((p) => p.id === id)?.path ?? '';
  openModal('purge-modal');
  $('#purge-title').textContent = `Bersihkan data Claude · ${projectName(id)}`;
  $('#purge-path').textContent = target ? `Folder kerja: ${target}` : '';
  $('#purge-plan').textContent = 'Memuat rencana…';
  $('#purge-confirm').value = '';
  $('#purge-error').textContent = '';
  $('#purge-run').disabled = true;
  try {
    const plan = await api(`/api/projects/${id}/claude-purge/plan`);
    if (id !== state.active) return; // the dialog now belongs to another project
    target = plan.path || target;
    $('#purge-path').textContent = target ? `Folder kerja: ${target}` : '';
    $('#purge-plan').textContent = plan.output || 'Tidak ada data Claude Code untuk folder ini.';
  } catch (err) {
    $('#purge-plan').textContent = '';
    $('#purge-error').textContent = err.message;
  }
}

async function runPurge() {
  if (!target || $('#purge-confirm').value !== target) {
    $('#purge-error').textContent = 'Ketik path folder kerja persis untuk mengonfirmasi.';
    return;
  }
  $('#purge-run').disabled = true;
  $('#purge-error').textContent = '';
  try {
    await api(`/api/projects/${state.active}/claude-purge`, { confirm: target });
    toast('Data Claude Code untuk folder ini sudah dihapus.', 'ok');
    $('#purge-modal [data-close]')?.click();
  } catch (err) {
    $('#purge-error').textContent = err.message;
    $('#purge-run').disabled = false;
  }
}

export function initPurge() {
  $('#purge-run').addEventListener('click', runPurge);
  // The button unlocks only once the path matches: a stray Enter never deletes anything.
  $('#purge-confirm').addEventListener('input', () => {
    $('#purge-run').disabled = !target || $('#purge-confirm').value !== target;
  });
}
