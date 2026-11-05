// Help, laptop settings (auto-start, shutdown), project folders and adding a project.
import { api, toast } from '../core/api.js';
import { $, narrow } from '../core/dom.js';
import { APP_NAME, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { loadBudgetView, syncBudgetSection } from './budget.js';
import { syncHealthButton } from './health.js';
import { selectProject } from './picker.js';

// The laptop dialog shows one section at a time; the phone keeps every panel stacked (CSS).
let settingsTab = (() => {
  try {
    return sessionStorage.getItem('office.settingsTab') || 'umum';
  } catch {
    return 'umum';
  }
})();

function syncSpotifyTab() {
  const sps = $('#sps');
  const tab = $('#settings-tab-spotify');
  if (sps && tab) tab.hidden = sps.hidden;
}

/** Shows one settings panel and remembers it for this browser session. */
export function selectSettingsTab(tab = settingsTab) {
  syncSpotifyTab();
  const tabs = [...document.querySelectorAll('#settings-tabs [data-settings-tab]')].filter((b) => !b.hidden);
  if (!tabs.some((b) => b.dataset.settingsTab === tab)) tab = 'umum';
  settingsTab = tab;
  try {
    sessionStorage.setItem('office.settingsTab', tab);
  } catch {
    // private mode: the tab still switches, just isn't remembered
  }
  for (const b of tabs) {
    const on = b.dataset.settingsTab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('#settings-modal [data-settings-panel]')) panel.classList.toggle('on', panel.dataset.settingsPanel === tab);
  const body = document.querySelector('#settings-modal .settings-body');
  if (body) body.scrollTop = 0;
  // 💰 One request when the budget panel is shown (a phone shows every panel at once); the view is cached.
  if (!$('#settings-modal')?.hidden && (tab === 'umum' || narrow.matches)) loadBudgetView();
}

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
    syncHealthButton(); // a WiFi phone may not call /api/health: the opener is hidden, not broken
    syncBudgetSection(); // same for the 💰 budget section (read-only page: hidden)
    openModal('settings-modal');
    // After the other #btn-settings listeners (Spotify shows/hides its section): pick a tab that is available.
    requestAnimationFrame(() => selectSettingsTab());
  });

  $('#settings-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-settings-tab]');
    if (tab) selectSettingsTab(tab.dataset.settingsTab);
  });
  $('#settings-tabs').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = [...document.querySelectorAll('#settings-tabs [data-settings-tab]')].filter((b) => !b.hidden);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    selectSettingsTab(next.dataset.settingsTab);
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
