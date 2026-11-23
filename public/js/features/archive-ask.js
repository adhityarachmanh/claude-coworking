// 💬 Tanya arsip: one question across old transcripts, answered only from the excerpts (server: src/archive-ask.js).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { fmtUsd } from '../core/format.js';
import { renderMarkdown } from '../markdown.js';
import { state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { resumeSearchResult } from './conversations.js';
import { selectProject } from './picker.js';

let sources = [];

function render(data) {
  sources = Array.isArray(data.sources) ? data.sources : [];
  const cost = Number.isFinite(data.costUsd) ? ` · ${fmtUsd(data.costUsd)}` : '';
  $('#archive-answer').innerHTML = `<p class="muted small">Jawaban dari kutipan arsip${escapeHtml(cost)}</p><div class="md">${renderMarkdown(String(data.answer ?? ''))}</div>`;
  $('#archive-sources').innerHTML = sources
    .map(
      (s) => `<li><button type="button" class="ghost" data-archive-open="${s.n}"><b>[${s.n}]</b> ${escapeHtml(s.projectName)} · ${escapeHtml(s.title)}</button></li>`,
    )
    .join('');
  for (const button of document.querySelectorAll('[data-archive-open]')) {
    button.addEventListener('click', async () => {
      const source = sources.find((s) => String(s.n) === button.dataset.archiveOpen);
      if (!source) return;
      closeModal('archive-modal');
      selectProject(source.projectId);
      await resumeSearchResult({ projectId: source.projectId, sessionId: source.sessionId, title: source.title, engine: 'claude' });
    });
  }
}

async function run() {
  const question = $('#archive-q').value.trim();
  if (question.length < 2) return ($('#archive-error').textContent = 'Tulis pertanyaan minimal 2 karakter.');
  $('#archive-error').textContent = '';
  $('#archive-answer').innerHTML = '<p class="muted"><span class="spinner" aria-hidden="true"></span> Mencari arsip dan menyusun jawaban…</p>';
  $('#archive-sources').innerHTML = '';
  $('#archive-run').disabled = true;
  try {
    render(await api('/api/archive/ask', { question, project: state.active }));
  } catch (err) {
    $('#archive-answer').innerHTML = '';
    $('#archive-error').textContent = err.message;
  } finally {
    $('#archive-run').disabled = false;
  }
}

export function openArchiveAsk() {
  if (state.readOnly) return toast('Tanya arsip hanya bisa dari laptop atau lewat Tailscale.', 'warn');
  openModal('archive-modal');
  $('#archive-error').textContent = '';
  $('#archive-answer').innerHTML = '';
  $('#archive-sources').innerHTML = '';
  $('#archive-q').value = $('#prompt').value.trim().slice(0, 500);
}

export function initArchiveAsk() {
  $('#archive-run').addEventListener('click', run);
}
