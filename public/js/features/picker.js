// Project picker (Ctrl+K): the project list, the header crumb, switching projects.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { engineBadge, engineLabel, engineOf } from '../core/engine-caps.js';
import { sceneFor, stage } from '../core/scenes.js';
import { DEMO_ID, READ_ONLY_HINT, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { renderActivity } from './activity.js';
import { changes, loadChanges } from './changes.js';
import { renderChat } from './chat.js';
import { renderComposer } from './composer.js';
import { scheduleDashboard } from './dashboard.js';
import { restoreDraft } from './draft.js';
import { closeSuggest } from './suggest.js';

function projectRank(p) {
  const st = state.statuses[p.id] ?? {};
  if (p.id === DEMO_ID) return -1; // the demo sits at the bottom
  if (st.pending) return 3;
  if (st.busy || st.cliBusy) return 2;
  if (st.alive) return 1;
  return 0;
}

// ---------- project picker (Ctrl+K) ----------

const picker = { cursor: 0, visible: [] };

export function renderSidebar() {
  const q = state.search.toLowerCase();
  const list = state.projects
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.path ?? '').toLowerCase().includes(q))
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || projectRank(b) - projectRank(a) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || Number(b.sources.includes('claude')) - Number(a.sources.includes('claude')) || a.name.localeCompare(b.name));
  picker.visible = list.map((p) => p.id);
  picker.cursor = Math.min(picker.cursor, Math.max(0, list.length - 1));
  const grouped = list.some((p) => p.favorite);
  $('#project-list').innerHTML = list
    .map((p, i) => {
      // Section titles only when there are favourites to separate from the rest.
      const head = !grouped ? '' : i === 0 ? '<li class="group">★ Favorit</li>' : !p.favorite && list[i - 1].favorite ? '<li class="group">Semua project</li>' : '';
      const favTitle = state.readOnly ? READ_ONLY_HINT : p.favorite ? 'Hapus dari favorit' : 'Jadikan favorit (selalu di atas)';
      const star = p.id === DEMO_ID ? '' : `<button class="fav ${p.favorite ? 'on' : ''}" title="${favTitle}" aria-pressed="${Boolean(p.favorite)}" ${state.readOnly ? 'disabled' : ''}>${p.favorite ? '★' : '☆'}</button>`;
      const st = state.statuses[p.id] ?? {};
      const badge = st.pending
        ? `<span class="badge ask">${st.pending}</span>`
        : st.busy || st.cliBusy
          ? `${st.cliBusy ? '<span class="cli-tag">CLI</span>' : ''}<span class="spinner"></span>`
          : st.alive
            ? '<span class="dot live"></span>'
            : '';
      const icon = p.id === DEMO_ID ? '🎬' : p.sources.includes('claude') ? '✳' : '▢';
      // 🔀 Each row names the engine that project runs on: visible before opening it (Claude vs OpenCode).
      const engine = p.id === DEMO_ID ? null : engineOf(st, state.config);
      const engineTag = engine
        ? `<span class="engine-badge" data-engine="${engine}" title="Mesin project: ${escapeHtml(engineLabel(engine))}" aria-label="Mesin: ${escapeHtml(engineLabel(engine))}">${escapeHtml(engineBadge(engine))}</span>`
        : '';
      // A project whose folder is gone can be purged safely: the action never deletes a folder, only the app's data.
      const missingTag = p.missing ? '<span class="badge missing" title="Folder project tidak ditemukan">folder hilang</span>' : '';
      const purge = p.missing && p.id !== DEMO_ID
        ? `<button class="purge" title="${state.readOnly ? READ_ONLY_HINT : 'Hapus data project ini (foldernya sudah tidak ada)'}" aria-label="Hapus data project ${escapeHtml(p.name)}" ${state.readOnly ? 'disabled' : ''}>🗑</button>`
        : '';
      return `${head}<li class="${p.id === state.active ? 'active' : ''} ${i === picker.cursor ? 'cursor' : ''}" data-id="${p.id}" title="${escapeHtml(p.path ?? 'Simulasi tanpa Claude Code')}">
        <span class="p-icon">${icon}</span>
        <span class="p-text"><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.path ? p.path.replace(/^.*\/projects\//, '…/') : 'simulasi')}</small></span>
        ${engineTag}
        ${missingTag}
        ${badge}
        ${star}
        ${purge}
        ${p.sources.includes('custom') ? '<button class="forget" title="Hapus dari daftar" aria-label="Hapus dari daftar">×</button>' : ''}
      </li>`;
    })
    .join('');
  renderHeader();
  scheduleDashboard(); // runs after every status/chat/approval/projects event: 🗂 Semua project follows live
}

export function selectProject(id) {
  state.active = id;
  location.hash = id;
  localStorage.setItem('office.active', id);
  stage.setScene(sceneFor(id));
  renderSidebar();
  renderHeader();
  renderChat();
  renderActivity();
  restoreDraft(); // before renderComposer, which sizes the box
  renderComposer();
  closeModal('sessions-modal');
  closeSuggest();
  changes.selected = null;
  $('#ch-diff').innerHTML = '';
  loadChanges();
  closeModal('project-modal');
}

let crumbHtml = '';

function renderHeader() {
  const p = state.projects.find((x) => x.id === state.active);
  const icon = !p ? '📁' : p.id === DEMO_ID ? '🎬' : p.sources.includes('claude') ? '✳' : '📁';
  // The project list lives in a dialog, so the switcher itself tells you when another project needs you.
  const others = state.projects.filter((x) => x.id !== state.active).map((x) => state.statuses[x.id] ?? {});
  const waiting = others.reduce((n, st) => n + (st.pending ?? 0), 0);
  const working = others.filter((st) => st.busy || st.cliBusy).length;
  const badge = waiting
    ? `<span class="badge ask" title="${waiting} permintaan izin menunggu di project lain">${waiting}</span>`
    : working
      ? `<span class="crumb-busy" title="${working} project lain sedang bekerja"><span class="spinner"></span>${working}</span>`
      : '';
  const current = p
    ? `<span class="p-icon">${icon}</span><span class="crumb-text"><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.path ?? 'Demo — tidak menjalankan Claude Code')}</small></span>`
    : '<span class="crumb-text"><b>Pilih project</b></span>';
  const html = `${current}${badge}<kbd>Ctrl K</kbd><svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  // Runs on every status/chat event: only touch the DOM when something changed (keeps the spinner smooth).
  if (html !== crumbHtml) $('#crumb').innerHTML = crumbHtml = html;
}

export function openProjects() {
  state.search = '';
  $('#project-search').value = '';
  picker.cursor = 0;
  renderSidebar();
  openModal('project-modal');
  $('#project-search').focus();
}

function moveCursor(delta) {
  if (!picker.visible.length) return;
  picker.cursor = (picker.cursor + delta + picker.visible.length) % picker.visible.length;
  renderSidebar();
  $('#project-list .cursor')?.scrollIntoView({ block: 'nearest' });
}

export function initPicker() {
  $('#crumb').addEventListener('click', openProjects);
  $('#project-search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveCursor(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const id = picker.visible[picker.cursor];
      if (id) selectProject(id);
    }
  });

  $('#project-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (e.target.closest('.fav')) {
      if (state.readOnly) return;
      const project = state.projects.find((p) => p.id === li.dataset.id);
      api(`/api/projects/${li.dataset.id}/favorite`, { on: !project?.favorite }).catch((err) => toast(err.message));
      return;
    }
    if (e.target.closest('.purge')) {
      if (state.readOnly) return;
      const project = state.projects.find((p) => p.id === li.dataset.id);
      if (!project?.missing) return;
      if (window.confirm(`Folder project "${project.name}" sudah tidak ada. Hapus data project ini dari aplikasi?\n\nPengaturan, riwayat chat, antrian, dan baris laporan token project ini ikut dihapus. File backup di folder cadangan tidak terhapus, dan folder di disk tidak disentuh (memang sudah tidak ada).`)) {
        api(`/api/projects/${li.dataset.id}/purge`, { confirm: li.dataset.id })
          .then(() => {
            toast('Data project dihapus.', 'ok');
            if (li.dataset.id === state.active) selectProject(DEMO_ID);
          })
          .catch((err) => toast(err.message));
      }
      return;
    }
    if (e.target.closest('.forget')) {
      if (window.confirm('Hapus folder ini dari daftar? (folder di disk tidak dihapus)')) {
        api(`/api/projects/${li.dataset.id}/forget`)
          .then(() => li.dataset.id === state.active && selectProject(DEMO_ID))
          .catch((err) => toast(err.message));
      }
      return;
    }
    selectProject(li.dataset.id);
  });
  $('#project-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderSidebar();
  });
}
