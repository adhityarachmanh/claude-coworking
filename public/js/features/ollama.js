// 🦙 Ollama (model lokal): read-only status in Settings. OpenCode does the model discovery; this only shows what is
// installed, what is running, and how much of it sits in VRAM (GPU vs CPU).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { state } from '../core/state.js';
import { copyText } from '../core/util.js';

const gb = (bytes) => `${(Number(bytes) / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;

function render(data) {
  const status = $('#ollama-status');
  const list = $('#ollama-models');
  const hint = $('#ollama-hint');
  if (!data.available) {
    status.textContent = data.error ?? 'Ollama tidak berjalan.';
    status.classList.add('warn');
    list.innerHTML = '';
    hint.textContent = 'Pasang Ollama dari ollama.com, jalankan, lalu `ollama pull <model>`; OpenCode akan mendeteksinya.';
    return;
  }
  status.classList.remove('warn');
  const running = new Map((data.running ?? []).map((m) => [m.name, m]));
  status.textContent = `Ollama ${data.version || ''} · ${data.baseUrl} · ${data.models.length} model${data.running.length ? ` · ${data.running.length} berjalan` : ''}`.replace(/\s+/g, ' ').trim();
  if (!data.models.length) {
    list.innerHTML = '<li class="muted small">Belum ada model. Jalankan <code>ollama pull qwen2.5-coder:7b</code> (atau model lain), lalu periksa lagi.</li>';
  } else {
    list.innerHTML = data.models
      .map((m) => {
        const run = running.get(m.name);
        const stateText = run ? `<span class="pill ${run.gpuPercent >= 99 ? 'ok' : 'warn'}">${run.gpuPercent >= 99 ? 'GPU' : `GPU ${run.gpuPercent}%`}</span>` : '';
        const meta = [m.parameterSize, m.quantization, gb(m.size)].filter(Boolean).map(escapeHtml).join(' · ');
        return `<li data-model="${escapeHtml(m.name)}"><div><b>${escapeHtml(m.name)}</b> ${stateText}<small class="muted">${meta}</small></div><div class="ext-actions"><button type="button" class="ghost" data-copy-model="${escapeHtml(m.name)}">Salin nama</button></div></li>`;
      })
      .join('');
  }
  const gpu = (data.running ?? []).filter((m) => m.gpuPercent >= 99).length;
  const partial = (data.running ?? []).filter((m) => m.gpuPercent > 0 && m.gpuPercent < 99).length;
  hint.textContent = data.running.length
    ? `${gpu} model penuh di GPU${partial ? `, ${partial} sebagian di GPU (sisanya CPU)` : ''}. Model dengan GPU < 100% akan lebih lambat; pertimbangkan model lebih kecil atau VRAM lebih besar.`
    : 'Belum ada model yang berjalan. Untuk memakai di Adhitron: project OpenCode → pemilih model → pilih ollama/<nama>. Model pertama kali dimuat saat dipakai.';
}

export async function loadOllama() {
  const section = $('#ollama-section');
  if (!section) return;
  section.hidden = state.readOnly;
  if (state.readOnly) return;
  const status = $('#ollama-status');
  status.classList.remove('warn');
  status.textContent = 'Memeriksa Ollama…';
  try {
    render(await api('/api/ollama/status', {}));
  } catch (err) {
    status.classList.add('warn');
    status.textContent = `Status Ollama tidak terbaca: ${err.message}`;
    $('#ollama-models').innerHTML = '';
  }
}

export function initOllama() {
  $('#ollama-refresh')?.addEventListener('click', loadOllama);
  $('#btn-settings')?.addEventListener('click', loadOllama);
  $('#ollama-models')?.addEventListener('click', (e) => {
    const button = e.target.closest('[data-copy-model]');
    if (!button) return;
    copyText(`ollama/${button.dataset.copyModel}`);
    toast('Nama model disalin — pilih di pemilih model OpenCode.', 'ok');
  });
}
