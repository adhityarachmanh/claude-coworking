// Help, laptop settings (auto-start, shutdown), project folders and adding a project.
import { api, apiGet, toast } from '../core/api.js';
import { $ } from '../core/dom.js';
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

// ---------- ⚙ Nyala otomatis (POST /api/autostart, laptop only) ----------

let autostartSaving = false;
let autologonSaving = false;

/** The autostart block of the last config (never trusted blindly: anything malformed reads as "no support"). */
function autostartStatus() {
  const status = state.config?.autostart;
  return status && typeof status === 'object' && !Array.isArray(status) ? status : {};
}

/** 'boot' = autologon + locked screen (installed when the `Adhitron Lock` task exists); 'login' = the old behaviour. */
function autostartMode() {
  return autostartStatus().mode === 'boot' ? 'boot' : 'login';
}

/**
 * Draws the auto-start switch and the 🔐 card. Only Windows' own answer (`autologon === 'on'`) counts as active:
 * a switch that was merely flipped must never make the dialog claim the server starts before login.
 */
function syncAutostartSection() {
  const status = autostartStatus();
  const supported = Boolean(status.supported);
  const row = $('#autostart-row');
  if (row) row.hidden = !supported;
  const box = $('#autostart');
  if (box) {
    box.checked = Boolean(status.enabled);
    box.disabled = Boolean(state.readOnly);
    box.title = state.readOnly ? READ_ONLY_HINT : '';
  }
  const on = status.autologon === 'on';
  const card = $('#autologon-card');
  if (card) card.hidden = !supported;
  const enable = $('#btn-autologon-enable');
  if (enable) {
    enable.hidden = on;
    enable.disabled = autologonSaving || Boolean(state.readOnly);
    const label = autologonSaving ? '⏳ Meminta izin Windows…' : 'Aktifkan';
    if (enable.textContent !== label) enable.textContent = label;
    enable.title = state.readOnly ? READ_ONLY_HINT : '';
  }
  const disable = $('#btn-autologon-disable');
  if (disable) {
    disable.hidden = !on;
    disable.disabled = autologonSaving || Boolean(state.readOnly);
    disable.title = state.readOnly ? READ_ONLY_HINT : '';
  }
  const line = $('#autologon-status');
  if (line) {
    const text = !supported
      ? ''
      : on
        ? 'Aktif: PC login sendiri setelah reboot, lalu layar terkunci otomatis 15 detik kemudian.'
        : status.needsElevation
          ? 'Belum aktif: mode sebelum login sudah terpasang, tetapi Windows belum diatur untuk login sendiri. Klik Aktifkan.'
          : 'Belum aktif: setelah reboot, server baru hidup ketika ada yang login ke Windows.';
    if (line.textContent !== text) line.textContent = text;
  }
  // The dangerous direction: Windows logs in by itself but nothing locks the screen. Say it even when auto-start
  // itself is off — the registry value survives that switch (clearing it needs an Administrator).
  const unsafe = $('#autologon-unsafe');
  if (unsafe) unsafe.hidden = !status.unsafeDesktop;
}

/** What the server answered, in one sentence: never a green "aktif" when the autologon is still missing. */
function autostartMessage(res) {
  // Autologon without the lock outlives every switch in this dialog: warn first, whatever was just saved.
  if (res?.unsafeDesktop) {
    return 'PERINGATAN: autologon Windows masih menyala tanpa pengunci layar. Klik Matikan di 🔐 Akses saat PC terkunci, lalu nyalakan lagi "Aktifkan".';
  }
  if (!res?.enabled) return 'Auto-start dimatikan.';
  if (res.mode !== 'boot') return 'Server akan menyala otomatis saat Windows login.';
  if (res.needsElevation) {
    return 'Mode sebelum login tersimpan, TAPI autologon Windows belum aktif: klik Aktifkan di 🔐 Akses saat PC terkunci. Tanpa itu server tetap baru hidup setelah login.';
  }
  return 'Server akan menyala sebelum login Windows, dan layar terkunci otomatis 15 detik setelah login.';
}

async function saveAutostart(enabled, mode) {
  if (state.readOnly) {
    syncAutostartSection();
    return toast(READ_ONLY_HINT, 'warn');
  }
  if (autostartSaving) return;
  autostartSaving = true;
  try {
    const res = await api('/api/autostart', { enabled, mode });
    applyAutostart(res);
    toast(autostartMessage(res), res?.needsElevation || res?.unsafeDesktop ? 'warn' : 'ok');
  } catch (err) {
    toast(err.message);
  } finally {
    autostartSaving = false;
    syncAutostartSection(); // the config (old or new) is the truth: a failed save puts the box back
  }
}

/** Takes the autostart block out of an answer, but only when it really is one: a stray body changes nothing. */
function applyAutostart(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  state.config = { ...(state.config ?? {}), autostart: raw };
  syncAutostartSection();
  return true;
}

// ---------- 🔐 Autologon lewat GUI (POST /api/autologon, /api/autologon/disable) ----------

function setAutologonError(text) {
  const box = $('#autologon-error');
  if (box && box.textContent !== text) box.textContent = text;
}

/** The submit button only lights up with something typed: an empty password never reaches the server. */
function syncAutologonSubmit() {
  const btn = $('#btn-autologon-submit');
  if (!btn) return;
  btn.disabled = !$('#autologon-password')?.value || autologonSaving;
  const label = autologonSaving ? '⏳ Meminta izin Windows…' : 'Aktifkan';
  if (btn.textContent !== label) btn.textContent = label;
}

/** Opens the password dialog with a clean field; the caret goes to the password, not to the ✕ button. */
function openAutologonModal() {
  if (state.readOnly) return toast(READ_ONLY_HINT, 'warn');
  const input = $('#autologon-password');
  if (input) input.value = '';
  setAutologonError('');
  syncAutologonSubmit();
  openModal('autologon-modal');
  input?.focus({ preventScroll: true });
}

async function submitAutologon(e) {
  e?.preventDefault?.();
  if (autologonSaving) return;
  const input = $('#autologon-password');
  const password = input?.value ?? '';
  if (!password) {
    setAutologonError('Sandi Windows masih kosong.');
    input?.focus();
    return;
  }
  autologonSaving = true;
  setAutologonError('');
  syncAutologonSubmit();
  syncAutostartSection();
  try {
    const res = await api('/api/autologon', { password });
    const applied = applyAutostart(res?.autostart);
    const on = applied && state.config.autostart?.autologon === 'on';
    closeModal('autologon-modal');
    toast(
      on ? 'Mode sebelum login aktif: PC login sendiri setelah reboot, lalu layar terkunci.' : 'Permintaan dikirim, tetapi Windows belum melaporkan autologon aktif. Cek status beberapa saat lagi.',
      on ? 'ok' : 'warn',
    );
  } catch (err) {
    // The dialog stays open: a mistyped password (401) or a refused change (409) is not a dead end. A 409 must show
    // the server's own reason - a cancelled UAC prompt says "Dibatalkan.", a refused Task Scheduler/registry change
    // says what was refused; collapsing both into "Dibatalkan." hid the real failure. An HTTP-less error (network
    // down) has no useful message of its own, so it gets the local wording instead of "Failed to fetch".
    const text = err?.status === 401
      ? 'Sandi Windows salah.'
      : err?.status ? err.message || 'Autologon tidak bisa diaktifkan.' : 'Autologon tidak bisa diaktifkan.';
    setAutologonError(text);
    input?.focus();
    input?.select?.();
  } finally {
    autologonSaving = false;
    syncAutologonSubmit();
    syncAutostartSection();
  }
}

async function disableAutologon() {
  if (autologonSaving) return;
  if (state.readOnly) return toast(READ_ONLY_HINT, 'warn');
  autologonSaving = true;
  syncAutostartSection();
  try {
    const res = await api('/api/autologon/disable');
    applyAutostart(res?.autostart);
    toast('Autologon Windows dimatikan: setelah reboot, server baru hidup ketika ada yang login.', 'ok');
  } catch (err) {
    toast(err.message);
  } finally {
    autologonSaving = false;
    syncAutostartSection();
  }
}

// ---------- 📱 PIN ke HP (GET /api/wa/status, POST /api/wa/link|unlink|test, laptop only) ----------

const WA_POLL_MS = 2000; // one read every 2 s, and only while ⚙ is open with the phone not linked yet
const WA_QR_MAX = 400_000; // a PNG data URL; anything longer is not a QR this card should render
const WA_QR_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const WA_STATES = new Set(['off', 'qr', 'connecting', 'linked']);

let waStatus = { state: 'off', qr: null, me: null };
let waChannel = 'code'; // "Kode 6 digit dari layar laptop" (no setup) unless the owner picks WhatsApp
let waPollTimer = 0;
let waPollGen = 0;
let waBusy = false;

const settingsOpen = () => Boolean($('#settings-modal')) && !$('#settings-modal').hidden;

function setWaError(text) {
  const box = $('#wa-error');
  if (box && box.textContent !== text) box.textContent = text;
}

/** Whatever the server (or a redacted phone stream) sends, reduced to what this card may show. */
function cleanWaStatus(raw) {
  const state = WA_STATES.has(raw?.state) ? raw.state : 'off';
  const qr = typeof raw?.qr === 'string' && raw.qr.length <= WA_QR_MAX && WA_QR_RE.test(raw.qr) ? raw.qr : null;
  const number = typeof raw?.me?.number === 'string' ? raw.me.number.replace(/[^0-9+]/g, '').slice(0, 20) : '';
  const name = typeof raw?.me?.name === 'string' ? raw.me.name.trim().slice(0, 80) : '';
  return { state, qr, me: number ? { number, name } : null };
}

/** One line under the channel choice; it follows both the choice and the real state. */
function waHintText() {
  if (waChannel === 'wa') {
    return waStatus.state === 'linked' ? 'Nomor ini menerima kode masuk. Uji atau lepas kapan saja dari sini.' : 'Pindai kode sekali; sesinya disimpan terenkripsi di laptop ini.';
  }
  if (waStatus.state === 'linked') return 'WhatsApp sudah tertaut. Pilih opsi WhatsApp untuk menguji atau melepasnya.';
  if (waStatus.state === 'qr' || waStatus.state === 'connecting') return 'Tautan WhatsApp sedang disiapkan. Pilih opsi WhatsApp untuk melihat kodenya.';
  return 'Tanpa setup: saat HP meminta masuk, kode 6 digit tampil di layar laptop.';
}

/** Draws the card from the last status. Guarded writes: the 2 s poll must not churn the DOM (or the a11y test). */
function paintWa() {
  const panel = $('#wa-panel');
  if (!panel) return;
  panel.hidden = waChannel !== 'wa';
  const hint = $('#wa-hint');
  const hintText = waHintText();
  if (hint && hint.textContent !== hintText) hint.textContent = hintText;

  const { state: waState, qr, me } = waStatus;
  const stateText =
    waState === 'linked'
      ? 'Tertaut.'
      : waState === 'qr'
        ? qr
          ? 'Menunggu kode QR dipindai di HP.'
          : 'Kode QR sedang diperbarui…'
        : waState === 'connecting'
          ? 'Menghubungkan ke WhatsApp…'
          : 'Belum ditautkan.';
  const stateEl = $('#wa-state');
  if (stateEl && stateEl.textContent !== stateText) stateEl.textContent = stateText;

  const img = $('#wa-qr');
  const showQr = waState === 'qr' && Boolean(qr);
  if (img) {
    if (showQr && img.getAttribute('src') !== qr) img.src = qr;
    // The QR is a session credential: once it expires or the link is dropped it must leave the DOM, not just hide.
    if (!showQr && img.getAttribute('src')) img.removeAttribute('src');
    img.hidden = !showQr;
  }
  const qrHint = $('#wa-qr-hint');
  if (qrHint) qrHint.hidden = !showQr;

  const meEl = $('#wa-me');
  const meText = waState === 'linked' && me ? `Nomor: ${me.number}${me.name ? ` (${me.name})` : ''}` : '';
  if (meEl) {
    if (meEl.textContent !== meText) meEl.textContent = meText;
    meEl.hidden = !meText;
  }

  const link = $('#btn-wa-link');
  if (link) {
    link.hidden = waState === 'linked';
    // connecting can also be a reconnect of an ALREADY linked account: pressing Batal there would silently unlink.
    const label = waState === 'qr' || (waState === 'connecting' && !me) ? 'Batal' : 'Tautkan';
    if (link.textContent !== label) link.textContent = label;
    link.disabled = waBusy || Boolean(state.readOnly);
    link.title = state.readOnly ? READ_ONLY_HINT : '';
  }
  for (const id of ['#btn-wa-test', '#btn-wa-unlink']) {
    const btn = $(id);
    if (!btn) continue;
    btn.hidden = waState !== 'linked';
    btn.disabled = waBusy || Boolean(state.readOnly);
    btn.title = state.readOnly ? READ_ONLY_HINT : '';
  }
}

/** Shows/hides the card for this client and redraws it from the last status (never a request of its own). */
function syncWaSection() {
  const section = $('#wa-section');
  if (!section) return;
  section.hidden = Boolean(state.readOnly);
  paintWa();
}

/** One status read. A failure keeps the last known state: the card never invents "linked" or "off". */
async function readWaStatus() {
  try {
    waStatus = cleanWaStatus(await apiGet('/api/wa/status'));
  } catch {
    // server restarting / refused read: keep showing what was last true
  }
  paintWa();
  return waStatus.state;
}

function stopWaPolling() {
  waPollGen += 1;
  clearTimeout(waPollTimer);
  waPollTimer = 0;
}

/** Polls only while ⚙ is open and the phone is not linked yet; linked (or a closed dialog) ends it. */
function startWaPolling() {
  stopWaPolling();
  const gen = waPollGen;
  const tick = async () => {
    waPollTimer = 0;
    if (gen !== waPollGen) return; // another start/stop replaced this loop while it was reading
    if (!settingsOpen()) return;
    const state = await readWaStatus();
    if (gen !== waPollGen) return;
    if (state === 'linked' || !settingsOpen()) return;
    waPollTimer = setTimeout(tick, WA_POLL_MS);
  };
  waPollTimer = setTimeout(tick, 0);
}

/** Tautkan / Batal: a pending scan is released with unlink (idempotent while nothing is linked yet). */
async function linkWa() {
  if (waBusy) return;
  waBusy = true;
  setWaError('');
  paintWa();
  try {
    const pending = waStatus.state === 'qr' || waStatus.state === 'connecting';
    const res = await api(pending ? '/api/wa/unlink' : '/api/wa/link');
    waStatus = typeof res?.state === 'string' ? cleanWaStatus(res) : cleanWaStatus(await apiGet('/api/wa/status'));
  } catch (err) {
    setWaError(err.message || 'WhatsApp tidak bisa dihubungi.');
  } finally {
    waBusy = false;
    paintWa();
    if (waStatus.state === 'linked') stopWaPolling();
    else if (settingsOpen()) startWaPolling();
  }
}

async function testWa() {
  if (waBusy) return;
  waBusy = true;
  setWaError('');
  paintWa();
  try {
    await api('/api/wa/test');
    toast('Pesan uji terkirim ke WhatsApp yang tertaut.', 'ok');
  } catch (err) {
    setWaError(err.message || 'Pesan uji gagal dikirim.');
  } finally {
    waBusy = false;
    paintWa();
  }
}

async function unlinkWa() {
  if (waBusy) return;
  waBusy = true;
  setWaError('');
  paintWa();
  try {
    await api('/api/wa/unlink');
    waStatus = cleanWaStatus(await apiGet('/api/wa/status').catch(() => ({ state: 'off' })));
    toast('WhatsApp dilepas dari laptop ini.', 'ok');
  } catch (err) {
    setWaError(err.message || 'WhatsApp tidak bisa dilepas.');
  } finally {
    waBusy = false;
    paintWa();
    if (waStatus.state !== 'linked' && settingsOpen()) startWaPolling();
  }
}

export function renderRoots(config) {
  if (!config) return;
  state.config = config;
  syncAutostartSection();
  syncWaSection(); // 📱 the card follows the client (hidden on a read-only phone), never a request
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

  $('#autostart').addEventListener('change', (e) => {
    // Turning the whole thing off also drops the boot-only pieces (lock task + autologon).
    saveAutostart(e.target.checked, e.target.checked ? autostartMode() : 'login');
  });
  // 🔐 The one path to autologon: a password dialog, then one UAC prompt. No file to run by hand.
  $('#btn-autologon-enable').addEventListener('click', openAutologonModal);
  $('#btn-autologon-disable').addEventListener('click', disableAutologon);
  $('#autologon-form').addEventListener('submit', submitAutologon);
  $('#btn-autologon-cancel').addEventListener('click', () => closeModal('autologon-modal'));
  $('#autologon-password').addEventListener('input', () => {
    setAutologonError('');
    syncAutologonSubmit();
  });
  // 📱 PIN ke HP: the channel choice is a view of this dialog only — the QR/controls belong to the WhatsApp one.
  for (const radio of document.querySelectorAll('input[name="wa-channel"]')) {
    radio.addEventListener('change', (e) => {
      if (!e.target.checked) return;
      waChannel = e.target.value === 'wa' ? 'wa' : 'code';
      setWaError('');
      paintWa();
    });
  }
  $('#btn-wa-link').addEventListener('click', linkWa);
  $('#btn-wa-test').addEventListener('click', testWa);
  $('#btn-wa-unlink').addEventListener('click', unlinkWa);
  // Polling is tied to the dialog itself, not to one opener: every way of opening ⚙ starts it, every close stops it.
  const settingsModal = $('#settings-modal');
  if (settingsModal) {
    new MutationObserver(() => {
      if (settingsModal.hidden) stopWaPolling();
      else startWaPolling();
    }).observe(settingsModal, { attributes: true, attributeFilter: ['hidden'] });
  }
  // The password must not linger in the DOM after the dialog closes (Esc, ✕, a successful save).
  const autologonModal = $('#autologon-modal');
  if (autologonModal) {
    new MutationObserver(() => {
      if (!autologonModal.hidden) return;
      const input = $('#autologon-password');
      if (input) input.value = '';
      setAutologonError('');
      syncAutologonSubmit();
    }).observe(autologonModal, { attributes: true, attributeFilter: ['hidden'] });
  }
  $('#btn-shutdown').addEventListener('click', async () => {
    const pc = $('#rp-shutdown-pc')?.checked === true;
    if (!window.confirm(pc ? `Matikan server ${APP_NAME} dan Windows PC-nya? Sesi Claude yang sedang berjalan dihentikan dengan rapi, lalu Windows shutdown. Listrik Bardi tidak diputus otomatis — halaman jembatan terbuka untuk memutus arus.` : `Matikan server ${APP_NAME}? Sesi Claude yang sedang berjalan ikut dihentikan.`)) return;
    const out = await api('/api/shutdown', { pc }).catch(() => {});
    // ⏻ Handoff ke halaman jembatan (countdown pemutusan listrik): TAB YANG SAMA, tanpa toast — halaman berganti.
    if (pc && out?.handoffUrl) {
      window.location.href = out.handoffUrl;
      return;
    }
    toast(pc ? 'Windows dimatikan: server ditutup rapi. Putuskan listrik Bardi dari halaman jembatan.' : 'Server dimatikan. Buka aplikasi Adhitron lagi untuk menyalakannya.', 'ok');
  });
  // ⚡ Remote power (opsional): the self-hosted bridge that boots/cuts the PC when away.
  const rpFill = (rp) => {
    $('#rp-url').value = rp?.bridgeUrl ?? '';
    $('#rp-token').value = rp?.token ?? '';
    $('#rp-delay').value = String(rp?.offDelaySec ?? 120);
  };

  $('#rp-save').addEventListener('click', async () => {
    const status = $('#rp-result');
    try {
      await api('/api/remote-power/settings', { bridgeUrl: $('#rp-url').value.trim(), token: $('#rp-token').value.trim(), offDelaySec: Number($('#rp-delay').value) || 120 });
      status.textContent = '✅ Setelan disimpan.';
    } catch (err) {
      status.textContent = `⚠ ${err.message}`;
    }
  });
  $('#rp-test').addEventListener('click', async () => {
    const status = $('#rp-result');
    status.textContent = '⏳ Menguji jembatan…';
    try {
      const r = await api('/api/remote-power/test');
      status.textContent = r.ok ? `✅ Jembatan hidup — plug: ${r.plug ?? '?'}` : `⚠ ${r.error}`;
    } catch (err) {
      status.textContent = `⚠ ${err.message}`;
    }
  });

  $('#btn-settings').addEventListener('click', () => {
    $('#roots-input').value = state.config?.roots.join('\n') ?? '';
    settingsQuery = '';
    $('#settings-search').value = '';
    resetSearchView();
    syncHealthButton(); // a WiFi phone may not call /api/health: the opener is hidden, not broken
    syncAutostartSection(); // ⚙ the boot switch + "run as Administrator" hint follow the last config
    syncBudgetSection(); // same for the 💰 budget section (read-only page: hidden)
    openModal('settings-modal');
    concurrencyDirty = false; // a fresh open shows the saved limit, not a leftover draft
    syncConcurrencySection({ fill: true }); // ⚡ the saved turn limit + who is working right now (needs the dialog open)
    // ⚡ Remote power: prefill the saved bridge config when the dialog opens.
    api('/api/remote-power/get').then((r) => rpFill(r.remotePower)).catch(() => {});
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
