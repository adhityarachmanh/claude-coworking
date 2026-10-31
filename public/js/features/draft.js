// Unsent prompt drafts: what is typed in the composer survives a reload, a lost connection or a server restart.
// One draft per project in localStorage. Text only: attached images are never stored (size, and screenshots
// can be private). A read-only phone (plain WiFi) can't type, so it neither stores nor restores drafts.
import { $ } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { autosize, updateBashMode } from './composer.js';

const KEY_PREFIX = 'office.draft.';
const MAX_CHARS = 20_000; // ~20 KB; a bigger paste (a whole log) is not kept rather than kept cut off
const SAVE_DELAY_MS = 300;

const draft = {
  project: null, // the project whose draft the composer box holds
  timer: 0, // pending debounced save
  kept: true, // the box's text is safely stored (or empty): switching project may replace it
};

const usable = (project) => Boolean(project) && project !== DEMO_ID && !state.readOnly;
const key = (project) => KEY_PREFIX + project;

function readDraft(project) {
  try {
    return localStorage.getItem(key(project)) ?? '';
  } catch {
    return ''; // storage blocked (private mode, policy)
  }
}

/** Stores a project's draft (empty = removed). Returns false when the text could not be kept. */
function writeDraft(project, text) {
  try {
    if (!text.trim() || text.length > MAX_CHARS) localStorage.removeItem(key(project));
    else localStorage.setItem(key(project), text);
    return text.length <= MAX_CHARS;
  } catch {
    return false; // quota exceeded or storage blocked
  }
}

/** Debounced save of the box; on every edit (typing, paste, Edit/Rewind filling it, Esc Esc clearing it). */
export function scheduleDraftSave() {
  if (!usable(state.active)) return;
  draft.project = state.active;
  clearTimeout(draft.timer);
  draft.timer = setTimeout(flushDraft, SAVE_DELAY_MS);
}

/**
 * Writes a pending save now. Without one, storage already holds the last edit, so nothing is written: that keeps
 * the draft while a sent prompt waits for the server (the box is already empty then, see draftSent).
 */
export function flushDraft() {
  if (!draft.timer) return;
  clearTimeout(draft.timer);
  draft.timer = 0;
  if (usable(draft.project)) draft.kept = writeDraft(draft.project, $('#prompt').value);
}

/** The server accepted `text`: its draft goes, unless something new was typed in the meantime. */
export function draftSent(project, text) {
  if (!usable(project)) return;
  if (readDraft(project).trim() === text.trim()) writeDraft(project, '');
}

/** After selectProject: the box shows the chosen project's draft. Same project again (a reconnect) = untouched. */
export function restoreDraft() {
  if (state.readOnly || draft.project === state.active) return;
  const input = $('#prompt');
  flushDraft();
  // Text that could not be stored (too long, storage full) stays in the box rather than vanish.
  const replaceable = !input.value.trim() || (draft.kept && usable(draft.project));
  draft.project = state.active;
  draft.kept = true;
  if (!replaceable) return;
  const text = usable(state.active) ? readDraft(state.active) : '';
  if (input.value === text) return;
  input.value = text;
  autosize();
  updateBashMode();
}

export function initDraft() {
  $('#prompt').addEventListener('input', scheduleDraftSave);
  // A reload or closing the tab inside the debounce window still keeps the last keystrokes.
  window.addEventListener('pagehide', flushDraft);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushDraft());
}
