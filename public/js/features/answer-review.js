// 🧪 Nilai jawaban terakhir: a second model reviews the last answer (server: src/answer-review.js). The browser sends
// only text it already shows; no session or project file is touched.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { fmtUsd } from '../core/format.js';
import { renderMarkdown } from '../markdown.js';
import { DEMO_ID, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

let target = { answer: '', question: '' };

const lastAnswer = () => {
  const list = state.chats[state.active] ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m.kind !== 'assistant' || typeof m.text !== 'string' || !m.text.trim()) continue;
    let question = '';
    for (let j = i - 1; j >= 0; j -= 1) {
      if (list[j].kind === 'user' && typeof list[j].text === 'string') {
        question = list[j].text;
        break;
      }
    }
    return { answer: m.text.trim(), question: question.trim() };
  }
  return null;
};

async function run() {
  $('#answer-review-error').textContent = '';
  $('#answer-review-body').innerHTML = '<p class="muted"><span class="spinner" aria-hidden="true"></span> Reviewer membaca jawaban…</p>';
  $('#answer-review-run').disabled = true;
  try {
    const data = await api('/api/answer-review', {
      project: state.active,
      answer: target.answer,
      question: target.question,
      focus: $('#answer-review-focus').value.trim(),
      model: $('#answer-review-model').value.trim(),
    });
    const cost = Number.isFinite(data.costUsd) ? ` · ${fmtUsd(data.costUsd)}` : '';
    $('#answer-review-body').innerHTML = `<p class="muted small">Penilaian${escapeHtml(cost)}</p><div class="md">${renderMarkdown(String(data.review ?? ''))}</div>`;
  } catch (err) {
    $('#answer-review-body').innerHTML = '';
    $('#answer-review-error').textContent = err.message;
  } finally {
    $('#answer-review-run').disabled = false;
  }
}

export function openAnswerReview() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (state.readOnly) return toast('Nilai jawaban hanya bisa dari laptop atau lewat Tailscale.', 'warn');
  const found = lastAnswer();
  if (!found) return toast('Belum ada jawaban asisten untuk dinilai.', 'warn');
  target = found;
  openModal('answer-review-modal');
  $('#answer-review-error').textContent = '';
  $('#answer-review-body').innerHTML = '';
  $('#answer-review-focus').value = '';
  $('#answer-review-model').value = '';
  $('#answer-review-excerpt').textContent = found.answer.slice(0, 1200) + (found.answer.length > 1200 ? '…' : '');
}

export function initAnswerReview() {
  $('#answer-review-run').addEventListener('click', run);
}
