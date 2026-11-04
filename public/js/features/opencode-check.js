// OpenCode update detector (server: src/opencode-check.js): a banner under the top bar after a check of a new
// OpenCode version, and ⚙ → 🧩 Kompatibilitas OpenCode (status, manual run, the auto-check switch; laptop only).
// Shown only when OpenCode is installed (view.available). The view arrives with the config (snapshot + `config`
// events): applyOpenCodeCheck is called from core/stream.js. Same look as features/claude-check.js.
import { api, toast } from '../core/api.js';
import { openCodeCheckBanner, openCodeCheckStatus, staleRunReply } from '../core/claude-check-rules.js';
import { $ } from '../core/dom.js';
import { shortDate } from '../core/format.js';
import { state } from '../core/state.js';

const SEEN_KEY = 'office.opencodeCheck.seen'; // the banner this browser already dismissed or saw auto-hide
const oc = { view: null, shown: null, timer: null, manual: false, busy: false };

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
