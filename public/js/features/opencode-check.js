// OpenCode update detector (server: src/opencode-check.js): a banner under the top bar after a check of a new
// OpenCode version, and ⚙ → 🧩 Kompatibilitas OpenCode (status, manual run, the auto-check switch; laptop only).
// Shown only when OpenCode is installed (view.available). The view arrives with the config (snapshot + `config`
// events): applyOpenCodeCheck is called from core/stream.js. Same look as features/claude-check.js.
import { api, toast } from '../core/api.js';
import { openCodeCheckBanner, openCodeCheckStatus, staleRunReply } from '../core/claude-check-rules.js';
import { $, escapeHtml } from '../core/dom.js';
import { shortDate } from '../core/format.js';
import { state } from '../core/state.js';

const SEEN_KEY = 'office.opencodeCheck.seen'; // the banner this browser already dismissed or saw auto-hide
const oc = { view: null, shown: null, timer: null, manual: false, busy: false, plugins: null, pluginsLoading: false };

const seen = () => {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
};
const markSeen = (key) => {
  try {
    localStorage.setItem(SEEN_KEY, key);
  } catch {}
};

function hideBanner() {
  clearTimeout(oc.timer);
  oc.timer = null;
  oc.shown = null;
  $('#oc-banner')?.replaceChildren();
}

/** Fills (or empties) the always-present live region under the top bar. */
function renderBanner() {
  const banner = oc.view?.available ? openCodeCheckBanner(oc.view, { readOnly: state.readOnly, seen: seen() }) : null;
  if (!banner) {
    if (oc.timer) return; // an auto-hiding banner stays until its timer
    return hideBanner();
  }
  if (banner.key === oc.shown) return;
  hideBanner();
  const box = document.createElement('div');
  box.className = `cc-banner ${banner.tone}${banner.passive ? ' passive' : ''}`;
  box.dataset.key = banner.key;
  const text = document.createElement('span');
  text.className = 'cc-text';
  text.textContent = banner.text;
  box.append(text);
  if (banner.hintCommand) {
    const hint = document.createElement('span');
    hint.className = 'cc-hint';
    const code = document.createElement('code');
    code.textContent = banner.hintCommand;
    hint.append('Jalankan ', code, ' untuk detail.');
    box.append(hint);
  }
  if (banner.dismissible) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn cc-close';
    close.setAttribute('aria-label', 'Tutup pemberitahuan OpenCode');
    close.title = 'Tutup';
    close.textContent = '✕';
    close.addEventListener('click', () => {
      markSeen(banner.key);
      hideBanner();
    });
    box.append(close);
  }
  $('#oc-banner').replaceChildren(box);
  oc.shown = banner.key;
  if (banner.autoHideMs) {
    markSeen(banner.key); // seen once is enough: not again after a reload
    oc.timer = setTimeout(hideBanner, banner.autoHideMs);
  }
}

function renderPlugins() {
  const box = $('#oc-plugin-list');
  if (!box) return;
  if (oc.pluginsLoading) return void (box.innerHTML = '<p class="muted small">Memuat plugin OpenCode…</p>');
  if (oc.plugins == null) return void (box.innerHTML = '<p class="muted small">Buka Pengaturan untuk memuat plugin…</p>');
  if (!oc.plugins.length) return void (box.innerHTML = '<p class="muted small">Belum ada plugin OpenCode.</p>');
  box.innerHTML = oc.plugins
    .map(
      (p) => `<div class="oc-plugin-row"><div><b>${escapeHtml(p.id)}</b> <small>v${escapeHtml(p.version)} · ${escapeHtml(p.source)}</small></div><span><button type="button" class="ghost" data-plugin-update="${escapeHtml(p.source)}">Update</button> <button type="button" class="ghost danger-text" data-plugin-remove="${escapeHtml(p.source)}">Hapus</button></span></div>`,
    )
    .join('');
}

async function loadPlugins(force = false) {
  if (!oc.view?.available || state.local === false || state.readOnly) return;
  if (oc.pluginsLoading || (!force && oc.plugins != null)) return;
  oc.pluginsLoading = true;
  renderPlugins();
  try {
    const r = await api('/api/opencode-plugins/list');
    oc.plugins = Array.isArray(r.plugins) ? r.plugins : [];
  } catch (err) {
    oc.plugins = null;
    const status = $('#oc-plugin-status');
    if (status) status.textContent = err.message;
  } finally {
    oc.pluginsLoading = false;
    renderPlugins();
  }
}

async function pluginAction(kind, spec = '') {
  if (oc.busy) return false;
  const label = kind === 'add' ? 'Tambahkan plugin' : kind === 'remove' ? 'Hapus plugin' : kind === 'update' ? 'Update plugin' : 'Cek update plugin';
  if (!window.confirm(`${label}${spec ? ` "${spec}"` : ''}?\n\nPlugin menjalankan kode di OpenCode. Lanjutkan hanya untuk sumber yang kamu percaya.`)) return false;
  oc.busy = true;
  renderSection();
  const status = $('#oc-plugin-status');
  if (status) status.textContent = `${label}…`;
  try {
    const path = kind === 'add' ? 'add' : kind === 'remove' ? 'remove' : kind === 'update' ? 'update' : 'check';
    const r = await api(`/api/opencode-plugins/${path}`, spec ? { spec } : {});
    const out = $('#oc-plugin-output');
    if (out) {
      out.hidden = !r.output;
      out.textContent = r.output ?? '';
    }
    if (status) status.textContent = r.output || `${label} selesai.`;
    toast(`${label} selesai.`, 'ok');
    oc.plugins = null;
    await loadPlugins(true);
    return true;
  } catch (err) {
    if (status) status.textContent = err.message;
    toast(err.message, 'warn');
    return false;
  } finally {
    oc.busy = false;
    renderSection();
  }
}

/** ⚙ section: only when OpenCode is installed. */
function renderSection() {
  const v = oc.view;
  const section = $('#oc-section');
  if (!section) return;
  section.hidden = !v?.available;
  $('#oc-section-sep').hidden = section.hidden;
  if (!v?.available) return;
  $('#oc-status').textContent = openCodeCheckStatus(v, shortDate);
  $('#oc-status').classList.toggle('warn', v.result === 'warning' || v.result === 'failed');
  $('#oc-auto').checked = v.settings?.autoCheck !== false;
  const laptop = state.local !== false;
  const blocked = !laptop || v.running || oc.busy;
  $('#oc-run').disabled = blocked;
  $('#oc-auto').disabled = !laptop;
  $('#oc-update').disabled = blocked;
  $('#oc-restart').disabled = blocked;
  $('#oc-config-open').disabled = !laptop;
  for (const id of ['#oc-plugin-spec', '#oc-plugin-add', '#oc-plugin-check', '#oc-plugin-update-all']) {
    const el = $(id);
    if (el) el.disabled = !laptop || oc.busy;
  }
}

/** The server's config.opencodeCheck (snapshot or live `config` event). */
export function applyOpenCodeCheck(view) {
  if (!view || typeof view !== 'object') return;
  const finished = oc.manual && oc.view?.running && !view.running;
  oc.view = view;
  renderBanner();
  renderSection();
  if (!finished) return;
  oc.manual = false;
  if (view.result === 'ok') toast(`OpenCode v${view.checkedVersion}: semua cek kontrak lulus.`, 'ok');
  else if (view.result) toast(`OpenCode v${view.checkedVersion}: ${view.failing.length} cek kontrak gagal.`, view.result === 'failed' ? 'error' : 'warn');
}

async function runMaintenance(kind) {
  if (oc.busy) return;
  const update = kind === 'update';
  const question = update
    ? 'Update OpenCode sekarang?\n\nMenjalankan "opencode upgrade". Giliran yang sedang berjalan harus selesai dulu.'
    : 'Restart layanan OpenCode sekarang?\n\nMenjalankan "opencode service restart". Sesi terminal OpenCode yang sedang berjalan bisa terputus.';
  if (!window.confirm(question)) return;
  oc.busy = true;
  renderSection();
  try {
    const r = await api(`/api/opencode-check/${update ? 'update' : 'restart-service'}`);
    const out = $('#oc-output');
    out.hidden = !r.output;
    out.textContent = r.output ?? '';
    toast(update ? (r.ok ? 'Update OpenCode selesai. Cek kompatibilitas dimulai.' : 'Update OpenCode gagal — lihat output.') : r.ok ? 'Layanan OpenCode direstart.' : 'Restart layanan OpenCode gagal — lihat output.', r.ok ? 'ok' : 'warn');
    if (update && r.ok) {
      oc.manual = true;
      applyOpenCodeCheck(await api('/api/opencode-check/run'));
    }
  } catch (err) {
    toast(err.message, 'warn');
  } finally {
    oc.busy = false;
    renderSection();
  }
}

export function initOpenCodeCheck() {
  $('#btn-settings').addEventListener('click', () => loadPlugins());
  $('#oc-plugin-add').addEventListener('click', async () => {
    const input = $('#oc-plugin-spec');
    const spec = input.value.trim();
    if (!spec) return toast('Isi paket plugin dulu.', 'warn');
    if (await pluginAction('add', spec)) input.value = '';
  });
  $('#oc-plugin-spec').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    $('#oc-plugin-add').click();
  });
  $('#oc-plugin-check').addEventListener('click', () => pluginAction('check'));
  $('#oc-plugin-update-all').addEventListener('click', () => pluginAction('update'));
  $('#oc-plugin-list').addEventListener('click', (e) => {
    const update = e.target.closest('[data-plugin-update]');
    if (update) return pluginAction('update', update.dataset.pluginUpdate);
    const remove = e.target.closest('[data-plugin-remove]');
    if (remove) return pluginAction('remove', remove.dataset.pluginRemove);
  });
  $('#oc-update').addEventListener('click', () => runMaintenance('update'));
  $('#oc-restart').addEventListener('click', () => runMaintenance('restart-service'));
  $('#oc-auto').addEventListener('change', async (e) => {
    const input = e.target;
    try {
      applyOpenCodeCheck(await api('/api/opencode-check/settings', { autoCheck: input.checked }));
    } catch (err) {
      input.checked = !input.checked;
      toast(err.message);
    }
  });
  $('#oc-run').addEventListener('click', async () => {
    $('#oc-run').disabled = true;
    try {
      oc.manual = true;
      const reply = await api('/api/opencode-check/run');
      if (staleRunReply(oc.view, reply)) {
        oc.manual = false; // finished already (its config events came first): the toast was shown then
        renderSection();
      } else applyOpenCodeCheck(reply);
    } catch (err) {
      oc.manual = false;
      toast(err.message);
      renderSection();
    }
  });
}
