// ⚖️ Bandingkan dua model Claude pada pertanyaan yang sama (server: src/compare.js). Laptop only, paid tokens.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { fmtUsd } from '../core/format.js';
import { state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

function useAnswer(text) {
  const input = $('#prompt');
  input.value = input.value.trim() ? `${input.value.replace(/\s+$/, '')}\n${text}` : text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  $('#compare-modal [data-close]')?.click();
}

function render(results) {
  $('#cmp-results').innerHTML = results
    .map((r) => {
      const meta = r.error ? 'gagal' : [r.costUsd != null ? fmtUsd(r.costUsd) : '', r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)} dtk` : ''].filter(Boolean).join(' · ');
      return `<div class="cmp-col"><b>${escapeHtml(r.model)}</b><small class="muted">${escapeHtml(meta)}</small><pre class="cc-output">${escapeHtml(r.error ?? r.text)}</pre>${
        r.error ? '' : `<button type="button" class="ghost" data-cmp-use="${escapeHtml(r.model)}">Pakai jawaban ini</button>`
      }</div>`;
    })
    .join('');
  for (const button of document.querySelectorAll('[data-cmp-use]')) {
    button.addEventListener('click', () => {
      const result = results.find((r) => r.model === button.dataset.cmpUse);
      if (result?.text) useAnswer(result.text);
    });
  }
}

async function run() {
  const a = $('#cmp-a').value.trim();
  const b = $('#cmp-b').value.trim();
  const prompt = $('#cmp-prompt').value.trim();
  if (!a || !b) return ($('#cmp-error').textContent = 'Isi dua model.');
  if (!prompt) return ($('#cmp-error').textContent = 'Tulis pertanyaan dulu.');
  $('#cmp-error').textContent = '';
  $('#cmp-run').disabled = true;
  $('#cmp-results').innerHTML = '<p class="muted"><span class="spinner" aria-hidden="true"></span> Menjalankan dua model…</p>';
  try {
    const data = await api('/api/compare', { project: state.active, prompt, models: [a, b] });
    render(Array.isArray(data.results) ? data.results : []);
  } catch (err) {
    $('#cmp-results').innerHTML = '';
    $('#cmp-error').textContent = err.message;
  } finally {
    $('#cmp-run').disabled = false;
  }
}

export function openCompare() {
  if (!state.local) return toast('Bandingkan model hanya bisa dijalankan dari laptop.', 'warn');
  openModal('compare-modal');
  $('#cmp-error').textContent = '';
  $('#cmp-results').innerHTML = '';
  $('#cmp-prompt').value = $('#prompt').value.trim();
}

export function initCompare() {
  $('#cmp-run').addEventListener('click', run);
}
