// Help, laptop settings (auto-start, shutdown), project folders and adding a project.
import { api, toast } from '../core/api.js';
import { $ } from '../core/dom.js';
import { APP_NAME, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { selectProject } from './picker.js';

export function renderRoots(config) {
  if (!config) return;
  state.config = config;
  $('#autostart-row').hidden = !config.autostart?.supported;
  $('#autostart').checked = Boolean(config.autostart?.enabled);
  if (!$('#settings-modal').hidden) return; // don't clobber what the user is typing
  $('#roots-input').value = config.roots.join('\n');
  $('#roots-hint').textContent = config.usingDefault
    ? `Belum diatur — sekarang memakai folder default: ${config.defaultRoot}`
    : 'Disimpan di device ini. Folder yang pernah dibuka Claude Code juga ikut tampil.';
}

export function initSettings() {
  $('#btn-help').addEventListener('click', () => openModal('help-modal'));

  $('#autostart').addEventListener('change', async (e) => {
    try {
      const res = await api('/api/autostart', { enabled: e.target.checked });
      toast(res.enabled ? 'Server akan menyala otomatis saat Windows login.' : 'Auto-start dimatikan.', 'ok');
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message);
    }
  });
  $('#btn-shutdown').addEventListener('click', async () => {
    if (!window.confirm(`Matikan server ${APP_NAME}? Sesi Claude yang sedang berjalan ikut dihentikan.`)) return;
    await api('/api/shutdown').catch(() => {});
    toast('Server dimatikan. Jalankan start-office.cmd untuk menyalakan lagi.', 'ok');
  });

  $('#btn-settings').addEventListener('click', () => {
    $('#roots-input').value = state.config?.roots.join('\n') ?? '';
    openModal('settings-modal');
  });
  $('#roots-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const roots = $('#roots-input').value.split('\n').map((r) => r.trim()).filter(Boolean);
    try {
      await api('/api/config', { roots });
      closeModal('settings-modal');
      toast(`Folder disimpan, ${roots.length || 1} folder dipindai.`, 'ok');
    } catch (err) {
      toast(err.message);
    }
  });

  $('#refresh-projects').addEventListener('click', () => api('/api/projects/refresh').catch((err) => toast(err.message)));
  $('#add-project').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#add-project-path');
    try {
      const project = await api('/api/projects', { path: input.value.trim() });
      input.value = '';
      selectProject(project.id);
    } catch (err) {
      toast(err.message);
    }
  });
}
