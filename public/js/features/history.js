// Prompt history: ↑/↓ recall earlier prompts, like the CLI.
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { autosize, updateBashMode } from './composer.js';

export const recall = { project: null, index: -1, draft: '' };

/** This project's prompts, newest first, without repeats. */
export function promptHistory() {
  const seen = new Set();
  return (state.chats[state.active] ?? [])
    .filter((m) => (m.kind === 'user' || m.kind === 'shell') && m.text)
    .map((m) => (m.kind === 'shell' ? `!${m.text}` : m.text))
    .reverse()
    .filter((text) => !seen.has(text) && seen.add(text));
}

/** @param dir -1 = older (↑), +1 = newer (↓). Returns true when the key was used for history. */
export function recallPrompt(dir) {
  const input = $('#prompt');
  // Only from the first line (↑) or the last line (↓); elsewhere the arrows move the caret as usual.
  if (dir < 0 && input.value.slice(0, input.selectionStart).includes('\n')) return false;
  if (dir > 0 && input.value.slice(input.selectionEnd).includes('\n')) return false;
  if (recall.project !== state.active) Object.assign(recall, { project: state.active, index: -1, draft: '' });
  if (recall.index === -1) {
    if (dir > 0) return false;
    recall.draft = input.value; // what you were typing comes back after the newest prompt
  }
  const list = promptHistory();
  const next = recall.index - dir;
  if (next >= list.length) return list.length > 0; // already at the oldest
  recall.index = next;
  input.value = next === -1 ? recall.draft : list[next];
  input.setSelectionRange(input.value.length, input.value.length);
  autosize();
  updateBashMode();
  return true;
}

export function initPromptHistory() {
  $('#prompt').addEventListener('input', () => (recall.index = -1));
}
