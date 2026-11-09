// Help, laptop settings (auto-start, shutdown), project folders, the project's engine and adding a project.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { engineLabel, engineOf } from '../core/engine-caps.js';
import { APP_NAME, DEMO_ID, projectName, READ_ONLY_HINT, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { loadBudgetView, syncBudgetSection } from './budget.js';
import { syncHealthButton } from './health.js';
import { selectProject } from './picker.js';
import { openRoutines } from './routines.js';

// The dialog shows one section at a time on both laptop and phone (the phone scrolls the tab bar sideways).
let settingsTab = (() => {
  try {
    return sessionStorage.getItem('office.settingsTab') || 'umum';
  } catch {
    return 'umum';
  }
})();

let settingsQuery = '';

/** Clears the search presentation (inline display + hit outlines) without changing the active tab. */
function resetSearchView() {
  for (const panel of document.querySelectorAll('#settings-modal [data-settings-panel]')) {
    panel.style.display = '';
    panel.classList.remove('search-hit');
  }
}

/** Shows every panel that contains `query` and scrolls to the first one; empty restores the normal tabs. */
function applySettingsSearch(query) {
  settingsQuery = query.trim().toLowerCase();
  if (!settingsQuery) {
    resetSearchView();
    selectSettingsTab();
    return;
  }
  const body = document.querySelector('#settings-modal .settings-body');
  let first = null;
  for (const panel of document.querySelectorAll('#settings-modal [data-settings-panel]')) {
    const fields = [...panel.querySelectorAll('input, select, textarea')].map((el) => `${el.placeholder ?? ''} ${el.getAttribute('aria-label') ?? ''}`).join(' ');
    const hit = `${panel.textContent} ${fields}`.toLowerCase().includes(settingsQuery);
    panel.style.display = hit ? 'flex' : 'none';
    panel.classList.toggle('search-hit', hit);
    if (hit && !first) first = panel;
  }
  if (first && body) body.scrollTop = Math.max(0, first.offsetTop - 8);
}

function syncSpotifyTab() {
  const sps = $('#sps');
  const tab = $('#settings-tab-spotify');
  if (sps && tab) tab.hidden = sps.hidden;
}

/** Shows one settings panel and remembers it for this browser session. */
export function selectSettingsTab(tab = settingsTab) {
  if (settingsQuery) {
    settingsQuery = '';
    const search = $('#settings-search');
    if (search) search.value = '';
    resetSearchView();
  }
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
  // 💰 One request when the budget panel is shown; the view is cached.
  if (!$('#settings-modal')?.hidden && tab === 'umum') loadBudgetView();
  // ⏰ Tugas terjadwal: refresh the project list and the stored schedules when its tab is shown.
  if (!$('#settings-modal')?.hidden && tab === 'jadwal') openRoutines();
}

// ---------- ⚡ Batas giliran bersamaan (POST /api/concurrency/save, laptop only) ----------

let concurrencySaving = false;
let concurrencyDirty = false; // the user typed here: a config push must not overwrite it before Simpan

/** The saved turn limit; anything malformed reads as the server default (3). */
function configConcurrencyLimit() {
  const n = Number(state.config?.concurrency?.maxConcurrent ?? 3);
  return Number.isInteger(n) && n >= 0 && n <= 8 ? n : 3;
}

/** Names of the projects working right now (the demo office never counts; CLI-only turns are not limited). */
function busyProjectNames() {
  return state.projects
    .filter((p) => p && p.id !== DEMO_ID && state.statuses[p.id]?.busy)
    .map((p) => String(p.name || projectName(p.id)));
}

/** "Saat ini 2 dari 3 project sedang bekerja." — the queue still waits when the limit is reached. */
function syncConcurrencyHint() {
  const hint = $('#max-concurrent-hint');
  if (!hint || $('#settings-modal')?.hidden) return;
  const limit = configConcurrencyLimit();
  const text = limit > 0 ? `Saat ini ${busyProjectNames().length} dari ${limit} project sedang bekerja.` : 'Tanpa batas — semua project boleh bekerja bersamaan.';
  if (hint.textContent !== text) hint.textContent = text; // only touch the DOM when the sentence really changed
}

/** Writes the saved limit into the field, never over what the user is typing. */
function fillConcurrencyInput() {
  const input = $('#max-concurrent');
  if (!input || concurrencyDirty || document.activeElement === input) return;
  const value = String(configConcurrencyLimit());
  if (input.value !== value) input.value = value;
}

/**
 * Shows/hides the section (a phone on plain WiFi may not save it) and refreshes the hint. `fill` also writes the
 * saved value into the field: only when the config arrives or the dialog opens, not on every status tick.
 */
export function syncConcurrencySection({ fill = false } = {}) {
  const section = $('#concurrency-section');
  if (!section) return;
  const blocked = Boolean(state.readOnly);
  section.hidden = blocked;
  const input = $('#max-concurrent');
  if (input) {
    input.disabled = blocked || concurrencySaving;
    input.title = blocked ? READ_ONLY_HINT : '';
  }
  const btn = $('#max-concurrent-save');
  if (btn) {
    btn.disabled = blocked || concurrencySaving;
    const label = concurrencySaving ? '⏳ Menyimpan…' : 'Simpan';
    if (btn.textContent !== label) btn.textContent = label;
    btn.title = blocked ? READ_ONLY_HINT : '';
  }
  if (fill) fillConcurrencyInput();
  syncConcurrencyHint();
}

/** The field as an integer 0..8, or null when it is empty, fractional or out of range. */
function readConcurrencyLimit() {
  const raw = String($('#max-concurrent')?.value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 8 ? n : null;
}

async function saveConcurrencyLimit() {
  if (state.readOnly) return toast(READ_ONLY_HINT, 'warn');
  if (concurrencySaving) return;
  const n = readConcurrencyLimit();
  if (n == null) return toast('Maksimal giliran harus angka bulat 0 sampai 8.', 'warn');
  concurrencySaving = true;
  syncConcurrencySection();
  try {
    const res = await api('/api/concurrency/save', { maxConcurrent: n });
    const saved = Number(res?.maxConcurrent);
    const value = Number.isInteger(saved) && saved >= 0 && saved <= 8 ? saved : n;
    state.config = { ...(state.config ?? {}), concurrency: { ...(state.config?.concurrency ?? {}), maxConcurrent: value } };
    concurrencyDirty = false;
    toast(value > 0 ? `Batas giliran bersamaan disimpan: ${value} project.` : 'Batas giliran bersamaan disimpan: tanpa batas.', 'ok');
  } catch (err) {
    toast(err.message);
  } finally {
    concurrencySaving = false;
    syncConcurrencySection({ fill: true });
  }
}

// ---------- 🔀 Mesin project (Stage 1: one engine per project) ----------

// Engines the selector offers. The server validates too (400 for anything else): never send an id we don't know.
const PROJECT_ENGINES = ['claude', 'opencode'];
const ENGINE_SWITCH_NOTE = 'Riwayat tiap mesin disimpan terpisah. Berganti mesin hanya menampilkan riwayat mesin itu.';

/** Last engine drawn + the inline 409 message, so a status tick never wipes the reason the user just got. */
let engineShown = { key: '', error: '' };
/** One request at a time: both buttons are disabled (and drawn disabled) until the server answers. */
let engineSwitching = false;

function setEngineError(message = '') {
  engineShown.error = message;
  const box = $('#project-engine-error');
  if (box) box.textContent = message;
}

/** Why the project's engine cannot be switched right now (demo, read-only, older server, busy), or ''. */
function engineLockReason(id) {
  if (!state.config?.engines) return 'Server ini belum bisa mengganti mesin per project.';
  if (!id || id === DEMO_ID) return 'Pilih project nyata dulu untuk mengatur mesinnya.';
  if (state.readOnly) return `${READ_ONLY_HINT}.`;
  if (!state.projects.some((p) => p.id === id)) return 'Project ini tidak ada lagi di daftar.';
  // The server refuses these too (409); say it BEFORE the click so the button never looks like it worked.
  const st = state.statuses[id] ?? {};
  if (st.busy) return 'Project ini sedang bekerja. Tunggu giliran selesai atau hentikan dulu, lalu ganti mesin.';
  if (st.pending) return 'Masih ada permintaan izin yang menunggu jawaban. Jawab dulu, lalu ganti mesin.';
  if (st.queue) return '📋 Antrian project ini masih berisi item. Selesaikan atau hapus dulu, lalu ganti mesin.';
  if (st.interrupted) return 'Ada giliran terputus ("Lanjutkan"). Lanjutkan atau abaikan dulu, lalu ganti mesin.';
  return '';
}

/**
 * Draws the "Mesin project" section from the active project's status (statuses[id].engine). Called when ⚙ opens and
 * on every status/config event while it is open; it never writes state itself (the SSE status does, after a switch).
 */
export function syncProjectEngine() {
  const box = $('#project-engine');
  const rule = $('#project-engine-rule');
  if (!box) return;
  const config = state.config;
  const id = state.active;
  const hidden = !config?.engines; // older server: the per-project route may not exist
  box.hidden = hidden;
  if (rule) rule.hidden = hidden;
  if (hidden) return;
  const engine = engineOf(state.statuses[id] ?? {}, config);
  const key = `${id}|${engine}`;
  if (engineShown.key !== key) {
    engineShown = { key, error: '' };
    $('#project-engine-error').textContent = '';
  }
  const locked = engineLockReason(id);
  const hint = $('#project-engine-hint');
  const current = engineLabel(engine);
  const currentMissing = engine !== 'claude' && config.engines?.[engine]?.available === false;
  if (locked) hint.textContent = locked;
  else if (currentMissing) hint.textContent = `${current} tidak terpasang di laptop ini. Pasang lalu restart server (README: Memakai OpenCode), atau pilih Claude Code untuk project ini.`;
  else hint.textContent = `Project ini memakai ${current}. Mesin dipilih per project; project lain tidak terpengaruh.`;
  hint.title = hint.textContent;
  $('#project-engine-desc').textContent = ENGINE_SWITCH_NOTE;
  const html = PROJECT_ENGINES.map((e) => {
    const on = e === engine;
    const available = e === 'claude' || config.engines?.[e]?.available !== false;
    const version = typeof config.engines?.[e]?.version === 'string' ? config.engines[e].version.slice(0, 40) : '';
    const off = e !== 'claude' && !available;
    const title = off
      ? `${engineLabel(e)} belum terpasang di laptop ini. Pasang lalu restart server (lihat README: Memakai OpenCode).`
      : locked || (on ? 'Sedang dipakai project ini' : `Pakai ${engineLabel(e)} untuk project ini`);
    return `<button type="button" class="engine-opt${on ? ' on' : ''}" data-project-engine="${e}" aria-pressed="${on}" title="${escapeHtml(title)}"${locked || off || engineSwitching ? ' disabled' : ''}>${escapeHtml(engineLabel(e))}${
      off ? ' <small>(tidak terpasang)</small>' : version ? ` <small class="muted">v${escapeHtml(version)}</small>` : ''
    }</button>`;
  }).join('');
  const opts = $('#project-engine-opts');
  opts.setAttribute('aria-busy', String(engineSwitching));
  if (opts.dataset.html !== html) {
    opts.innerHTML = html;
    opts.dataset.html = html;
  }
}

/** Confirms, then switches ONLY this project's engine; a 409 stays inline and the shown value does not move. */
async function switchProjectEngine(engine) {
  const id = state.active;
  if (!PROJECT_ENGINES.includes(engine)) return;
  const locked = engineLockReason(id);
  if (locked) return setEngineError(locked);
  const config = state.config;
  if (engine === engineOf(state.statuses[id] ?? {}, config)) return;
  if (engine !== 'claude' && config?.engines?.[engine]?.available === false) return setEngineError(`${engineLabel(engine)} belum terpasang di laptop ini.`);
  const ok = window.confirm(`Ganti mesin project ini ke ${engineLabel(engine)}?\n\n${ENGINE_SWITCH_NOTE} Project lain tidak terpengaruh.`);
  if (!ok) return;
  setEngineError('');
  engineSwitching = true;
  syncProjectEngine(); // draws both buttons disabled until the answer
  try {
    await api(`/api/projects/${encodeURIComponent(id)}/engine`, { engine });
    toast(`Project ini sekarang memakai ${engineLabel(engine)}.`, 'ok');
  } catch (err) {
    const message = err?.message || 'Gagal mengganti mesin project.';
    setEngineError(message);
    toast(message, 'warn');
  } finally {
    engineSwitching = false;
    syncProjectEngine(); // still the old value until the server's status arrives (a 409 changes nothing)
  }
}

export function renderRoots(config) {
  if (!config) return;
  state.config = config;
  $('#autostart-row').hidden = !config.autostart?.supported;
  $('#autostart').checked = Boolean(config.autostart?.enabled);
  syncConcurrencySection({ fill: true }); // ⚡ a config push (this or another device) shows the saved limit
  if (!$('#settings-modal').hidden) return; // don't clobber what the user is typing
  $('#roots-input').value = config.roots.join('\n');
  $('#roots-hint').textContent = config.usingDefault
    ? `Belum diatur — sekarang memakai folder default: ${config.defaultRoot}`
    : 'Disimpan di device ini. Folder yang pernah dibuka Claude Code juga ikut tampil.';
}

export function initSettings() {
  $('#btn-help').addEventListener('click', () => openModal('help-modal'));
  $('#settings-search').addEventListener('input', (e) => applySettingsSearch(e.target.value));
  $('#settings-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.target.value = '';
      applySettingsSearch('');
    }
  });

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
    settingsQuery = '';
    $('#settings-search').value = '';
    resetSearchView();
    syncHealthButton(); // a WiFi phone may not call /api/health: the opener is hidden, not broken
    syncBudgetSection(); // same for the 💰 budget section (read-only page: hidden)
    syncProjectEngine(); // 🔀 the active project's engine, before the dialog is painted
    openModal('settings-modal');
    concurrencyDirty = false; // a fresh open shows the saved limit, not a leftover draft
    syncConcurrencySection({ fill: true }); // ⚡ the saved turn limit + who is working right now (needs the dialog open)
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

  $('#max-concurrent').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveConcurrencyLimit();
    }
  });
  $('#max-concurrent').addEventListener('input', () => {
    concurrencyDirty = true;
  });
  $('#max-concurrent-save').addEventListener('click', saveConcurrencyLimit);

  $('#project-engine-opts').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-project-engine]');
    if (btn && !btn.disabled) switchProjectEngine(btn.dataset.projectEngine);
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
