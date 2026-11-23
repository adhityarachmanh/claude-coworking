// 📈 Pola kerja: the usage ledger as one screen — cost/tokens, the projects and models that spend them, and the
// busiest hours. Read-only; the server aggregates (src/insights.js).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { fmtNum, fmtUsd } from '../core/format.js';
import { copyText } from '../core/util.js';
import { state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

const hourText = (h) => `${String(h).padStart(2, '0')}.00–${String(h + 1).padStart(2, '0')}.00`;

const rowsHtml = (rows, label) => {
  if (!rows.length) return `<p class="muted small">Belum ada ${label} pada rentang ini.</p>`;
  return `<table class="ins-table"><thead><tr><th>${escapeHtml(label)}</th><th>Biaya</th><th>Token</th><th>Permintaan</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${escapeHtml(r.name ?? r.model)}</td><td>${fmtUsd(r.costUsd)}</td><td>${fmtNum(r.tokens)}</td><td>${fmtNum(r.requests)}</td></tr>`)
    .join('')}</tbody></table>`;
};

function render(d) {
  const body = $('#insights-body');
  const busiest = d.busiestHour == null ? 'belum ada data' : `${hourText(d.busiestHour)} (${d.hours[d.busiestHour]} permintaan)`;
  body.innerHTML = `
    <div class="ins-grid">
      <div><small>Biaya</small><b>${fmtUsd(d.costUsd)}</b></div>
      <div><small>Token</small><b>${fmtNum(d.tokens)}</b></div>
      <div><small>Permintaan</small><b>${fmtNum(d.requests)}</b></div>
      <div><small>Sesi</small><b>${fmtNum(d.sessions)}</b></div>
      <div><small>Project aktif</small><b>${fmtNum(d.activeProjects)}</b></div>
      <div><small>Jam tersibuk</small><b>${escapeHtml(busiest)}</b></div>
    </div>
    <h3 class="ins-head">Project</h3>
    ${rowsHtml(d.projects, 'Project')}
    <h3 class="ins-head">Model</h3>
    ${rowsHtml(d.models, 'Model')}`;
}

async function load() {
  const body = $('#insights-body');
  body.innerHTML = '<p class="muted"><span class="spinner" aria-hidden="true"></span> Menghitung…</p>';
  try {
    render(await api('/api/insights', { days: Number($('#insights-days').value) || 30 }));
  } catch (err) {
    body.innerHTML = `<div class="state-error">${escapeHtml(err.message)}</div>`;
  }
}

export function openInsights() {
  if (state.readOnly) return toast('Pola kerja hanya bisa dibuka dari laptop atau lewat Tailscale.', 'warn');
  openModal('insights-modal');
  load();
}

export function initInsights() {
  $('#insights-days').addEventListener('change', load);
  $('#insights-digest').addEventListener('click', async () => {
    const out = $('#insights-digest-out');
    out.hidden = false;
    out.textContent = 'Menyusun rekap…';
    try {
      const data = await api('/api/digest');
      out.textContent = String(data.markdown ?? '');
      $('#insights-copy').hidden = !out.textContent;
    } catch (err) {
      out.textContent = err.message;
      $('#insights-copy').hidden = true;
    }
  });
  $('#insights-copy').addEventListener('click', () => copyText($('#insights-digest-out').textContent));
}
