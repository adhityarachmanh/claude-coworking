// 🧹 Ringkas konteks (/ringkas, alias /compact, the status line): asks the engine to compact the conversation
// context. Everything here is about the engine's context; the app's own chat/history is left untouched
// (server: POST /api/projects/:id/compact).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { engineLabel, engineOf } from '../core/engine-caps.js';
import { fmtTokens } from '../core/format.js';
import { DEMO_ID, READ_ONLY_HINT, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';

const MAX_FOCUS = 300; // same limit as the input's maxlength
const co = { busy: false, error: '' };

const engineNow = (st) => engineOf(st ?? state.statuses[state.active] ?? {}, state.config);

/** The context usage reported for this session, validated: only finite positive numbers are shown (never trusted). */
function usage(st) {
  const used = Number(st?.context?.used);
  if (!Number.isFinite(used) || used <= 0) return null;
  const win = Number(st?.context?.window);
  const known = Number.isFinite(win) && win > 0;
  return { used, win: known ? win : null, pct: known ? Math.min(100, Math.round((used / win) * 100)) : null };
}

function summary(st) {
  const u = usage(st);
  const parts = [
    u
      ? u.win
        ? `Konteks terpakai: <b>${escapeHtml(fmtTokens(u.used))}</b> dari <b>${escapeHtml(fmtTokens(u.win))}</b> token (<b>${u.pct}%</b>)`
        : `Konteks terpakai: <b>${escapeHtml(fmtTokens(u.used))}</b> token`
      : 'Belum ada data konteks untuk sesi ini.',
    `Mesin: <b>${escapeHtml(engineLabel(engineNow(st)))}</b>`,
  ];
  return parts.join(' · ');
}

function render() {
  const st = state.statuses[state.active] ?? {};
  const engine = engineNow(st);
  $('#compact-summary').innerHTML = summary(st);
  // Only Claude Code takes a focus note; OpenCode ignores it (the server says so too: ignoredFocus).
  $('#compact-opencode-note').hidden = engine !== 'opencode';
  $('#compact-error').textContent = co.error;
  const send = $('#compact-send');
  send.disabled = co.busy;
  send.innerHTML = co.busy ? '<span class="spinner"></span> Meringkas…' : 'Ringkas';
  $('#compact-cancel').disabled = co.busy;
  $('#compact-focus').disabled = co.busy;
}

/** Opens the dialog. `prefill` comes from a /ringkas <fokus> argument. */
export function openCompact(prefill = '') {
  if (!state.active) return toast('Pilih project dulu.', 'warn');
  if (state.active === DEMO_ID) return toast('Ringkas konteks tidak tersedia di demo.', 'warn');
  if (state.readOnly) return toast(`${READ_ONLY_HINT}.`, 'warn');
  co.busy = false;
  co.error = '';
  const input = $('#compact-focus');
  input.value = String(prefill ?? '').slice(0, MAX_FOCUS);
  render();
  openModal('compact-modal');
  input.focus();
}

function fail(message) {
  co.error = message;
  render();
}

async function submit() {
  if (co.busy) return;
  const focus = $('#compact-focus').value.trim();
  if (focus.length > MAX_FOCUS) return fail(`Fokus maksimal ${MAX_FOCUS} karakter.`);
  if (!state.active) return fail('Pilih project dulu.');
  if (state.active === DEMO_ID) return fail('Ringkas konteks tidak tersedia di demo.');
  if (state.readOnly) return fail(`${READ_ONLY_HINT}.`);
  const project = state.active;
  co.busy = true;
  co.error = '';
  render();
  try {
    // No empty key on the wire: an absent focus is what the server expects.
    const r = await api(`/api/projects/${project}/compact`, focus ? { focus } : {});
    co.busy = false;
    closeModal('compact-modal');
    const engine = r?.engine === 'opencode' || r?.engine === 'claude' ? r.engine : engineNow();
    toast(engine === 'opencode' ? 'Ringkas konteks dikirim ke OpenCode…' : 'Konteks sedang diringkas…', 'ok');
  } catch (err) {
    // A 409 (turn running, rewind active, pending approval, /compact unsupported) stays in the dialog as-is:
    // the server's Indonesian reason is the message, and the request is never retried on its own.
    co.busy = false;
    co.error = err?.message || 'Gagal meringkas konteks.';
    render();
  }
}

export function initCompact() {
  $('#compact-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  // An Enter that picks an IME candidate must not submit the form.
  $('#compact-focus').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.isComposing) e.preventDefault();
  });
}
