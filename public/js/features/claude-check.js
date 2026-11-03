// Claude Code update detector (server: src/claude-check.js): a banner under the top bar after a check of a new
// Claude Code version, and ⚙ → 🧩 Cek kompatibilitas Claude Code (status, manual run, two settings; laptop only).
// The view arrives with the config (snapshot + `config` events): applyClaudeCheck is called from core/stream.js.
import { api, toast } from '../core/api.js';
import { claudeCheckBanner, claudeCheckStatus, staleRunReply } from '../core/claude-check-rules.js';
import { $ } from '../core/dom.js';
import { shortDate } from '../core/format.js';
import { state } from '../core/state.js';

const SEEN_KEY = 'office.claudeCheck.seen'; // the banner this browser already dismissed or saw auto-hide
const cc = { view: null, shown: null, timer: null, manual: false };

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
  clearTimeout(cc.timer);
  cc.timer = null;
  cc.shown = null;
  $('#cc-banner').replaceChildren();
}

/** Fills (or empties) the always-present live region under the top bar. */
function renderBanner() {
  const banner = claudeCheckBanner(cc.view, { readOnly: state.readOnly, seen: seen() });
  if (!banner) {
    // An auto-hiding banner stays until its timer (it is already marked seen, so a later `config` event finds no
    // banner for it); anything else on screen goes (dismissed elsewhere, or a new check started).
    if (cc.timer) return;
    return hideBanner();
  }
  if (banner.key === cc.shown) return;
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
    close.setAttribute('aria-label', 'Tutup pemberitahuan Claude Code');
    close.title = 'Tutup';
    close.textContent = '✕';
    close.addEventListener('click', () => {
      markSeen(banner.key);
      hideBanner();
    });
    box.append(close);
  }
  $('#cc-banner').replaceChildren(box);
  cc.shown = banner.key;
  if (banner.autoHideMs) {
    markSeen(banner.key); // seen once is enough: not again after a reload
    cc.timer = setTimeout(hideBanner, banner.autoHideMs);
  }
}

/** ⚙ section: status line, switches, the run button. */
function renderSection() {
  const v = cc.view;
  if (!v || !$('#cc-status')) return;
  $('#cc-status').textContent = claudeCheckStatus(v, shortDate);
  $('#cc-status').classList.toggle('warn', v.result === 'warning' || v.result === 'failed');
  $('#cc-auto').checked = v.settings.autoCheck;
  $('#cc-model').checked = v.settings.allowModel;
  const laptop = state.local !== false;
  $('#cc-run').disabled = !laptop || !v.available || v.running;
  $('#cc-doctor').disabled = !laptop || cc.maintaining;
  $('#cc-update').disabled = !laptop || cc.maintaining || v.running;
  $('#cc-auto').disabled = !laptop;
  $('#cc-model').disabled = !laptop;
}

/** The server's config.claudeCheck (snapshot or live `config` event). */
export function applyClaudeCheck(view) {
  if (!view || typeof view !== 'object') return;
  const finished = cc.manual && cc.view?.running && !view.running;
  cc.view = view;
  renderBanner();
  renderSection();
  if (!finished) return;
  cc.manual = false;
  if (view.result === 'ok') toast(`Claude Code v${view.checkedVersion}: semua cek kontrak lulus.`, 'ok');
  else if (view.result) toast(`Claude Code v${view.checkedVersion}: ${view.failing.length} cek kontrak gagal.`, view.result === 'failed' ? 'error' : 'warn');
}

async function saveSetting(key, input) {
  try {
    applyClaudeCheck(await api('/api/claude-check/settings', { [key]: input.checked }));
  } catch (err) {
    input.checked = !input.checked;
    toast(err.message);
  }
}

/** 🩺 claude doctor / ⬆ claude update, run by the server; the output shows under the buttons. */
async function maintenance(name) {
  if (name === 'update' && !window.confirm('Update Claude Code ke versi terbaru?\n\nSama seperti `claude update` di terminal. Sesi yang menganggur memakai versi baru di pesan berikutnya.')) return;
  const out = $('#cc-output');
  cc.maintaining = true;
  renderSection();
  out.hidden = false;
  out.textContent = name === 'update' ? 'Memperbarui Claude Code… (bisa beberapa menit)' : 'Menjalankan claude doctor…';
  try {
    const r = await api(`/api/claude-check/${name}`);
    out.textContent = r.output || (r.ok ? 'Selesai.' : 'Gagal tanpa keterangan.');
    if (r.timedOut) toast(`claude ${name} tidak selesai tepat waktu.`, 'warn');
    else toast(r.ok ? (name === 'update' ? 'Update Claude Code selesai.' : 'Doctor selesai.') : `claude ${name} gagal.`, r.ok ? 'ok' : 'warn');
  } catch (err) {
    out.textContent = err.message;
    toast(err.message);
  } finally {
    cc.maintaining = false;
    renderSection();
  }
}

export function initClaudeCheck() {
  $('#cc-doctor').addEventListener('click', () => maintenance('doctor'));
  $('#cc-update').addEventListener('click', () => maintenance('update'));
  $('#cc-auto').addEventListener('change', (e) => saveSetting('autoCheck', e.target));
  $('#cc-model').addEventListener('change', (e) => saveSetting('allowModel', e.target));
  $('#cc-run').addEventListener('click', async () => {
    $('#cc-run').disabled = true;
    try {
      cc.manual = true;
      const reply = await api('/api/claude-check/run');
      if (staleRunReply(cc.view, reply)) {
        cc.manual = false; // finished already (its config events came first): the toast was shown then
        renderSection();
      } else applyClaudeCheck(reply);
    } catch (err) {
      cc.manual = false;
      toast(err.message);
      renderSection();
    }
  });
}
