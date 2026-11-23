// 💡 Claude's predicted next prompt (--prompt-suggestions, status.suggestion): it fills the composer when clicked and
// is never sent by itself. The server clears it when the next prompt goes out; ✕ hides the current text for good.
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';

let dismissed = '';

export function renderPromptSuggestion(st) {
  const bar = $('#prompt-suggestion');
  const text = typeof st?.suggestion?.text === 'string' ? st.suggestion.text : '';
  const show = Boolean(text) && text !== dismissed && !state.readOnly;
  bar.hidden = !show;
  if (!show) return;
  const button = $('#prompt-suggestion-text');
  button.textContent = text;
  button.title = `Isi kotak pesan dengan saran ini: ${text}`; // the row cuts long text with an ellipsis
}

export function initPromptSuggestion() {
  $('#prompt-suggestion-text').addEventListener('click', () => {
    const text = $('#prompt-suggestion-text').textContent.trim();
    if (!text) return;
    const input = $('#prompt');
    // An existing draft is kept; the suggestion lands on its own line instead of replacing what was typed.
    input.value = input.value.trim() ? `${input.value.replace(/\s+$/, '')}\n${text}` : text;
    input.dispatchEvent(new Event('input', { bubbles: true })); // autosize, draft save and autocomplete react as if typed
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    dismissed = text;
    $('#prompt-suggestion').hidden = true;
  });
  $('#prompt-suggestion-dismiss').addEventListener('click', () => {
    dismissed = $('#prompt-suggestion-text').textContent;
    $('#prompt-suggestion').hidden = true;
  });
}
