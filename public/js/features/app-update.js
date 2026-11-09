// ⬆ "Versi baru Adhitron tersedia" (server: src/app-update.js): a banner under the top bar with what is new and,
// on the laptop, "Update sekarang" (git pull --ff-only + clean restart; the page reconnects by itself). The same
// status sits in ⚙ with a "Cek update" button. A dismissed banner stays away until a newer commit arrives.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { state } from '../core/state.js';

const SEEN_KEY = 'office.appUpdateSeen';
const up = { view: null, running: false };

const seenHash = () => {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
};

function renderBanner() {
  const v = up.view;
  const box = $('#app-update-banner');
  const newest = v?.commits?.[0]?.hash;
  if (!v?.behind || !newest || seenHash() === newest) return box.replaceChildren();
  const desktop = v.mode === 'desktop';
  const list = v.commits.map((c) => `<li><code>${escapeHtml(c.hash)}</code> ${escapeHtml(c.subject)}</li>`).join('');
  const action = !state.local
    ? '<span class="cc-hint">Update dari laptop (⚙ → Update aplikasi).</span>'
    : v.dirty
      ? '<span class="cc-hint">Ada perubahan lokal di folder aplikasi: commit/stash dulu, atau jalankan update.cmd.</span>'
      : `<button type="button" class="primary" data-up="run"${up.running || v.updating ? ' disabled' : ''}>${up.running || v.updating ? 'Memperbarui…' : '⬆ Update sekarang'}</button>`;
  box.innerHTML = `<div class="cc-banner ok app-update">
    <span class="cc-text">⬆ ${desktop ? `Versi baru Adhitron ${escapeHtml(v.latestVersion ?? '')} tersedia (terpasang ${escapeHtml(v.currentVersion ?? '')}).` : `Versi baru Adhitron tersedia: ${v.behind} perubahan.`}</span>
    <details class="app-update-list"><summary>Lihat</summary><ul>${list}</ul></details>
    ${action}
    <button type="button" class="icon-btn cc-close" data-up="dismiss" aria-label="Tutup pemberitahuan update" title="Nanti saja">✕</button>
  </div>`;
}

function renderSection() {
  const v = up.view;
  const st = $('#app-update-status');
  if (!st) return;
  if (!v?.available) st.textContent = 'Folder aplikasi bukan repo git: update otomatis tidak tersedia.';
  else if (v.checking) st.textContent = 'Memeriksa GitHub…';
  else if (v.error) st.textContent = `⚠ ${v.error}`;
  else if (v.mode === 'desktop' && v.behind) st.textContent = `⬆ Versi ${v.latestVersion} tersedia (terpasang ${v.currentVersion}).`;
  else if (v.mode === 'desktop') st.textContent = v.checkedAt ? `✓ Versi terbaru ${v.currentVersion} · dicek ${new Date(v.checkedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}` : 'Dicek otomatis tiap 30 menit.';
  else if (v.behind) st.textContent = `⬆ ${v.behind} perubahan baru di ${v.upstream}.`;
  else st.textContent = v.checkedAt ? `✓ Sudah versi terbaru (${v.branch}) · dicek ${new Date(v.checkedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}` : 'Dicek otomatis tiap 30 menit.';
  $('#app-update-check').disabled = !state.local || !v?.available || v.checking;
  $('#app-update-run').hidden = !v?.behind;
  $('#app-update-run').disabled = !state.local || v.dirty || up.running || v.updating;
}

/** The server's config.appUpdate (snapshot or live `config` event). */
export function applyAppUpdate(view) {
  if (!view || typeof view !== 'object') return;
  up.view = view;
  renderBanner();
  renderSection();
}

async function runUpdate() {
  const desktop = up.view?.mode === 'desktop';
  const question = desktop
    ? `Update Adhitron ke versi ${up.view?.latestVersion}?\n\nInstaller akan diunduh, diverifikasi SHA-256, lalu dipasang. Server di-restart sendiri; halaman tersambung lagi.`
    : `Update Adhitron (${up.view?.behind ?? 0} perubahan)?\n\ngit pull lalu server di-restart dengan rapi (giliran yang berjalan dicatat dan bisa dilanjutkan). Halaman tersambung lagi sendiri.`;
  if (!window.confirm(question)) return;
  up.running = true;
  renderBanner();
  renderSection();
  try {
    const r = await api('/api/app-update/run');
    toast(desktop ? `Installer ${up.view?.latestVersion ?? ''} dijalankan. Server akan restart…` : `Update ${r.pulled} perubahan selesai. Server di-restart…`, 'ok');
    setTimeout(() => location.reload(), 12_000); // after the restart the new page (new JS/CSS) loads
  } catch (err) {
    toast(err.data?.error ?? err.message, 'warn');
    up.running = false;
    renderBanner();
    renderSection();
  }
}

export function initAppUpdate() {
  $('#app-update-banner').addEventListener('click', (e) => {
    const act = e.target.closest('[data-up]')?.dataset.up;
    if (act === 'run') return runUpdate();
    if (act === 'dismiss') {
      try {
        localStorage.setItem(SEEN_KEY, up.view?.commits?.[0]?.hash ?? '');
      } catch {}
      renderBanner();
    }
  });
  $('#app-update-check').addEventListener('click', async () => {
    try {
      applyAppUpdate(await api('/api/app-update/check'));
      if (!up.view?.behind && !up.view?.error) toast('Sudah versi terbaru.', 'ok');
    } catch (err) {
      toast(err.message);
    }
  });
  $('#app-update-run').addEventListener('click', runUpdate);
}
