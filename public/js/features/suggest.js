// Composer autocomplete: /commands, @files and Ctrl+R history search.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { LOCAL_COMMANDS } from './commands.js';
import { autosize, updateBashMode } from './composer.js';
import { scheduleDraftSave } from './draft.js';
import { promptHistory } from './history.js';
import { openTemplates } from './templates.js';

// ---------- autocomplete: /commands and @files ----------

export const suggest = { items: [], index: 0, kind: null, start: 0, end: 0, timer: null, seq: 0 };

export function closeSuggest() {
  suggest.items = [];
  suggest.kind = null;
  $('#suggest').hidden = true;
}

function showSuggest(kind, items, start, end) {
  suggest.kind = kind;
  suggest.items = items;
  suggest.index = 0;
  suggest.start = start;
  suggest.end = end;
  renderSuggest();
}

export function renderSuggest() {
  const box = $('#suggest');
  if (!suggest.items.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const row = (item) => {
    if (suggest.kind === 'slash') {
      return `<b>/${escapeHtml(item.name)}</b>${item.argumentHint ? ` <span class="arg">${escapeHtml(item.argumentHint)}</span>` : ''}${item.description ? `<small>${escapeHtml(item.description)}</small>` : ''}`;
    }
    if (suggest.kind === 'history') return `<span class="at">↺</span> ${escapeHtml(item.replace(/\s+/g, ' '))}`;
    return `<span class="at">@</span>${escapeHtml(item)}`;
  };
  box.classList.toggle('described', suggest.kind === 'slash');
  box.innerHTML = suggest.items.map((item, i) => `<div class="opt ${i === suggest.index ? 'active' : ''}" data-i="${i}">${row(item)}</div>`).join('');
  box.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

export function applySuggest(i = suggest.index) {
  const input = $('#prompt');
  const item = suggest.items[i];
  if (item == null) return;
  if (suggest.kind === 'history') {
    // Ctrl+R: the picked prompt replaces what is in the box, as in the CLI's history search.
    input.value = item;
    input.setSelectionRange(item.length, item.length);
    input.focus();
    closeSuggest();
    autosize();
    updateBashMode();
    return;
  }
  if (suggest.kind === 'slash' && item.name === 'template') {
    // /t, /template: the typed command goes away and the picker opens; the template lands where it was.
    input.value = input.value.slice(0, suggest.start) + input.value.slice(suggest.end);
    const at = suggest.start;
    closeSuggest();
    autosize();
    scheduleDraftSave();
    openTemplates({ start: at, end: at });
    return;
  }
  const insert = suggest.kind === 'slash' ? `/${item.name} ` : `@${item} `;
  input.value = input.value.slice(0, suggest.start) + insert + input.value.slice(suggest.end);
  const caret = suggest.start + insert.length;
  input.setSelectionRange(caret, caret);
  input.focus();
  closeSuggest();
  scheduleDraftSave(); // an edit like typing (a prompt picked from history, like ↑/↓, is not a draft)
}

/** Every slash command with its description: the app's own first, then Claude Code's (built-in, skills, plugins). */
export function slashCatalog() {
  const byName = new Map();
  for (const c of LOCAL_COMMANDS) byName.set(c.name, c);
  for (const c of state.config?.commands ?? []) if (!byName.has(c.name)) byName.set(c.name, c);
  for (const name of state.config?.slashCommands ?? []) if (!byName.has(name)) byName.set(name, { name });
  return [...byName.values()];
}

/** Ctrl+R: prompts from this project's history that contain what is typed. */
export function searchHistory() {
  const input = $('#prompt');
  const q = input.value.trim().toLowerCase();
  const matches = promptHistory().filter((p) => p.toLowerCase().includes(q)).slice(0, 30);
  if (!matches.length) return toast(q ? `Tidak ada prompt yang berisi "${q}".` : 'Belum ada riwayat prompt.', 'warn');
  showSuggest('history', matches, 0, input.value.length);
}

function updateSuggest() {
  const input = $('#prompt');
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  if (suggest.kind === 'history') {
    // Ctrl+R search narrows as you type
    const q = input.value.trim().toLowerCase();
    const matches = promptHistory().filter((p) => p.toLowerCase().includes(q)).slice(0, 30);
    return matches.length ? showSuggest('history', matches, 0, input.value.length) : closeSuggest();
  }
  const slash = before.match(/^\/([\w:.-]*)$/);
  if (slash) {
    const q = slash[1].toLowerCase();
    const matchName = (c) => c.name.toLowerCase().includes(q) || c.aliases?.some((a) => a.toLowerCase().includes(q));
    const list = slashCatalog().filter(matchName);
    // An exact name or alias first (/t → /template), then names starting with what is typed.
    const exact = (c) => c.name.toLowerCase() === q || Boolean(c.aliases?.some((a) => a.toLowerCase() === q));
    list.sort((a, b) => Number(!exact(a)) - Number(!exact(b)) || Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
    return showSuggest('slash', list.slice(0, 40), 0, caret);
  }
  const at = before.match(/(^|\s)@([^\s@]*)$/);
  if (at && state.active !== DEMO_ID) {
    const start = caret - at[2].length - 1;
    clearTimeout(suggest.timer);
    const seq = ++suggest.seq;
    suggest.timer = setTimeout(async () => {
      try {
        const { files } = await api(`/api/projects/${state.active}/files`, { q: at[2] });
        if (seq === suggest.seq) showSuggest('file', files, start, caret);
      } catch {
        closeSuggest();
      }
    }, 120);
    return;
  }
  closeSuggest();
}

export function initSuggest() {
  $('#prompt').addEventListener('input', updateSuggest);
  $('#prompt').addEventListener('blur', () => setTimeout(closeSuggest, 150));
  $('#suggest').addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.opt');
    if (!opt) return;
    e.preventDefault();
    applySuggest(Number(opt.dataset.i));
  });
}
