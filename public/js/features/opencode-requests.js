// 📡 OpenCode request log: recent inference requests, globally or for one session. The server only sends normalized
// safe fields (no prompt, headers, geo or personal ids); this module only draws them.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { fmtShort, fmtUsd } from '../core/format.js';
import { openModal } from '../ui/modals.js';

const view = { sessionId: null, title: '', cursor: null, loading: false, count: 0 };

const fmtMs = (ms) => (ms == null ? '—' : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} mnt` : `${(ms / 1000).toFixed(1)} dtk`);
const fmtCost = (n) => (n == null ? '—' : n > 0 && n < 0.01 ? `$${Number(n).toFixed(5)}` : fmtUsd(n));
const tokenTotal = (i) => (i.inputTokens ?? 0) + (i.outputTokens ?? 0) + (i.reasoningTokens ?? 0) + (i.cacheReadTokens ?? 0) + (i.cacheWriteTokens ?? 0);
const timeText = (ts) => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

function rowHtml(i) {
  const tokens = tokenTotal(i);
  const breakdown = `input ${i.inputTokens} · output ${i.outputTokens} · reasoning ${i.reasoningTokens} · cache read ${i.cacheReadTokens} · cache write ${i.cacheWriteTokens}`;
  const failed = i.outcome && i.outcome !== 'succeeded';
  const status = failed ? '✕' : i.outcome === 'succeeded' ? '✓' : '…';
  const retry = Number(i.attemptCount) > 1 ? ` ↻${i.attemptCount}` : '';
  const title = `${i.outcome || 'unknown'}${i.statusCode ? ` · HTTP ${i.statusCode}` : ''}${i.finishReason ? ` · ${i.finishReason}` : ''}`;
  return `<tr class="${failed ? 'bad' : ''}" title="${escapeHtml(title)}">
    <td>${escapeHtml(timeText(i.startedAt))}</td>
    <td>${escapeHtml(i.model)}</td>
    <td>${escapeHtml(i.app || '—')}</td>
    <td>${fmtMs(i.durationMs)}</td>
    <td>${fmtMs(i.ttftMs)}</td>
    <td title="${escapeHtml(breakdown)}">${fmtShort(tokens)}</td>
    <td>${fmtCost(i.costUsd)}</td>
    <td>${status}${retry}</td>
  </tr>`;
}

function setMeta(text) {
  const el = $('#requests-meta');
  if (el) el.textContent = text;
}

function setMore(show) {
  const btn = $('#requests-more');
  if (btn) btn.hidden = !show;
}

async function load(more = false) {
  if (view.loading) return;
  if (more && !view.cursor) return;
  view.loading = true;
  const btn = $('#requests-more');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Memuat…';
  }
  const list = $('#requests-list');
  try {
    const body = { limit: 50 };
    if (view.sessionId) body.sessionId = view.sessionId;
    if (view.cursor) body.cursor = view.cursor;
    const res = await api('/api/opencode/requests', body);
    if (!res?.available) {
      list.innerHTML = `<tr><td colspan="8" class="muted small">${escapeHtml(res?.state === 'expired' ? 'Sesi OpenCode Console kedaluwarsa. Login ulang untuk melihat request.' : 'Data request OpenCode belum tersedia.')}</td></tr>`;
      setMore(false);
      setMeta(view.sessionId ? 'Hanya sesi ini' : 'Request terbaru OpenCode');
      return;
    }
    const items = Array.isArray(res.items) ? res.items : [];
    const rows = items.map(rowHtml).join('');
    if (more) list.insertAdjacentHTML('beforeend', rows);
    else list.innerHTML = rows || '<tr><td colspan="8" class="muted small">Tidak ada request pada periode ini.</td></tr>';
    view.count = more ? view.count + items.length : items.length;
    view.cursor = res.nextCursor ?? null;
    setMore(Boolean(view.cursor));
    const retention = res.retentionDays ? ` · retensi ${res.retentionDays} hari` : '';
    const scope = view.sessionId ? (view.title ? `Sesi ${view.title}` : 'Sesi ini') : 'Semua sesi';
    setMeta(`${scope} · ${view.count} request · 7 hari terakhir${retention}`);
    if (!view.sessionId && !view.title) $('#requests-title').textContent = '📡 Request OpenCode';
  } catch (err) {
    list.innerHTML = `<tr><td colspan="8" class="state-error">Gagal memuat request: ${escapeHtml(err.message)}</td></tr>`;
    setMore(false);
    toast(err.message);
  } finally {
    view.loading = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Muat lebih banyak';
    }
  }
}

/** Opens the request log; sessionId filters to one OpenCode session, title is shown in the header. */
export function openOpenCodeRequests({ sessionId = null, title = '' } = {}) {
  view.sessionId = sessionId && /^ses_[A-Za-z0-9_-]{1,100}$/.test(sessionId) ? sessionId : null;
  view.title = title || '';
  view.cursor = null;
  view.count = 0;
  view.loading = false;
  $('#requests-title').textContent = view.sessionId ? `📡 Request — ${view.title || view.sessionId.slice(0, 8)}` : '📡 Request OpenCode';
  $('#requests-list').innerHTML = '';
  setMeta(view.sessionId ? 'Hanya sesi ini' : 'Memuat request terbaru…');
  setMore(false);
  openModal('requests-modal');
  load(false);
}

export function initOpenCodeRequests() {
  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-oc-requests]');
    if (open) {
      e.preventDefault();
      openOpenCodeRequests({ sessionId: open.dataset.ocRequests || null, title: open.dataset.requestTitle || '' });
    }
  });
  $('#requests-more')?.addEventListener('click', () => load(true));
}
