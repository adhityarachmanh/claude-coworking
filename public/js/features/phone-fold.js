// Mode baca on a phone (docs/design-mobile-chat.md §10): one tap folds the whole input area away — the composer,
// the status strip and the todo chip — so the chat fills the screen, and a floating pill brings it back. The
// choice is remembered per browser. Desktop never folds: every rule lives in the phone @media block
// (public/css/app.css) and both buttons carry `.phone-only`.
import { $ } from '../core/dom.js';
import { foldFlags } from '../core/fold-rules.js';
import { state } from '../core/state.js';
import { connection } from './connection.js';

const KEY = 'office.composerFolded';

/** The one piece of state: is the input area folded away right now? */
export const fold = { on: false };

/** Is a permission still waiting on this project? Folding must never hide that. */
const hasPending = () => [...state.approvals.values()].some((a) => a.status === 'pending' && a.project === state.active);

function apply() {
  document.body.classList.toggle('composer-folded', fold.on);
  const btn = $('#btn-fold');
  if (btn) btn.setAttribute('aria-expanded', String(!fold.on));
  renderFoldFlags();
}

/** Writes what the folded pill must keep showing: ✋ izin menunggu, ⚡ sambungan putus, ⏳ giliran berjalan. */
export function renderFoldFlags(st = state.statuses[state.active] ?? {}) {
  const box = $('#unfold-flags');
  const pill = $('#btn-unfold');
  if (!box || !pill) return;
  const flags = foldFlags({ pending: hasPending(), busy: Boolean(st.busy || st.cliBusy || st.compacting), online: connection.online });
  box.hidden = flags.length === 0;
  box.innerHTML = flags.map((f) => `<span title="${f.label}" aria-hidden="true">${f.icon}</span>`).join('');
  pill.setAttribute('aria-label', flags.length ? `Buka area input — ${flags.map((f) => f.label).join(', ')}` : 'Buka area input');
}

/** Folds/unfolds the input area and remembers it. `focus`: put the cursor in the box (one tap → type right away). */
export function setFold(on, focus = false) {
  fold.on = Boolean(on);
  try {
    localStorage.setItem(KEY, fold.on ? '1' : '0');
  } catch {}
  apply();
  const prompt = $('#prompt');
  if (!prompt) return;
  if (fold.on) prompt.blur(); // no keyboard hanging over the pill
  else if (focus) prompt.focus({ preventScroll: true });
}

export function initPhoneFold() {
  $('#btn-fold')?.addEventListener('click', () => setFold(true));
  $('#btn-unfold')?.addEventListener('click', () => setFold(false, true));
  let saved = '0';
  try {
    saved = localStorage.getItem(KEY) ?? '0';
  } catch {}
  setFold(saved === '1');
}
