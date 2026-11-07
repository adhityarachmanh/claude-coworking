// 🔎 Cari percakapan: full-text search over this project's (or every project's) Claude Code transcripts
// (POST /api/projects/:id/search), and ⬇ Export sesi: one session as Markdown built from its transcript
// (POST /api/projects/:id/export-session). Both are read-only, so they work over WiFi too.
// Everything the server sends is checked and escaped before it reaches the page.
import { api, toast } from '../core/api.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { engineLabel, engineOf } from '../core/engine-caps.js';
import { ago } from '../core/format.js';
import { DEMO_ID, projectName, READ_ONLY_HINT, state } from '../core/state.js';
import { saveBlob } from '../core/util.js';
import { closeModal, openModal } from '../ui/modals.js';
import { guardCap } from './engine.js';
import { selectProject } from './picker.js';
import { exportOpenCodeJson, resumeSession } from './sessions.js';

const TOOLS_KEY = 'office.exportTools';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ses_[\w-]{1,100})$/i;
const MIN_QUERY = 2;
const MAX_QUERY = 200;

const finder = { seq: 0, results: [], project: null };

// ---------- export ----------

/** "Sertakan ringkasan tool" (remembered per browser, shared by every export button). */
export function exportTools() {
  try {
    return localStorage.getItem(TOOLS_KEY) === '1';
  } catch {
    return false;
  }
}

function setExportTools(on) {
  try {
    localStorage.setItem(TOOLS_KEY, on ? '1' : '0');
  } catch {
    // not remembered; this page still uses it
  }
  for (const box of document.querySelectorAll('.export-tools-opt')) box.checked = on;
}

/** Downloads one session as `.md` (built server-side from the transcript: no thinking, no raw tool output). */
export async function exportSessionMarkdown(projectId, sessionId, { tools = exportTools() } = {}) {
  if (!projectId || projectId === DEMO_ID) return toast('Pilih project dulu untuk mengekspor sesi.');
  if (!UUID.test(String(sessionId ?? ''))) return toast('Belum ada sesi untuk diekspor. Kirim pesan dulu atau pilih dari 🕘 Riwayat sesi.');
  try {
    const data = await api(`/api/projects/${projectId}/export-session`, { sessionId, tools: Boolean(tools) });
    if (typeof data.markdown !== 'string') throw new Error('jawaban server tidak valid');
    // The name comes from the session title: keep it a plain file name whatever the server sent.
    const base = String(data.filename ?? '').replace(/\.md$/i, '').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);
    saveBlob(`${base || `sesi-${sessionId.slice(0, 8)}`}.md`, new Blob([data.markdown], { type: 'text/markdown' }));
    toast(data.truncated ? 'Sesi diekspor, tapi dipotong karena terlalu besar.' : 'Sesi diekspor ke Markdown.', data.truncated ? 'warn' : 'ok');
  } catch (err) {
    toast(`Gagal mengekspor sesi: ${err.message}`);
  }
}

/** `/export [tools]`, ⋯ menu, palette: the session the chat is continuing. */
export function exportActiveSession(arg = '') {
  if (guardCap('exportSession')) return;
  const st = state.statuses[state.active] ?? {};
  const tools = /\btools?\b|\balat\b/i.test(arg) || (!arg.trim() && exportTools());
  return exportSessionMarkdown(state.active, st.sessionId, { tools });
}

// ---------- search ----------

export function openSearch(query = '') {
  if (guardCap('search')) return;
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu untuk mencari percakapan.');
  finder.project = state.active;
  $('#search-project').textContent = `· ${projectName(state.active)}`;
  const input = $('#search-q');
  input.value = String(query ?? '').slice(0, MAX_QUERY);
  input.removeAttribute('aria-invalid');
  $('#search-error').textContent = '';
  if (!finder.results.length || query) {
    $('#search-status').textContent = '';
    $('#search-results').innerHTML = '<li class="s-empty"><p class="muted">Ketik minimal 2 huruf, lalu Enter. Mencari di pesanmu dan balasan Claude (bukan output tool).</p></li>';
  }
  openModal('search-modal');
  if (!narrow.matches || query) input.focus();
  if (query) runSearch();
}

async function runSearch() {
  const input = $('#search-q');
  const q = input.value.replace(/\s+/g, ' ').trim();
  if (q.length < MIN_QUERY) {
    input.setAttribute('aria-invalid', 'true');
    $('#search-error').textContent = `Kata kunci minimal ${MIN_QUERY} huruf.`;
    input.focus();
    return;
  }
  input.removeAttribute('aria-invalid');
  $('#search-error').textContent = '';
  const all = $('#search-all').checked;
  const seq = ++finder.seq;
  const list = $('#search-results');
  list.setAttribute('aria-busy', 'true');
  $('#search-status').textContent = 'Mencari Claude + OpenCode…';
  try {
    const data = await api(`/api/projects/${finder.project}/search`, { q, all });
    if (seq !== finder.seq) return; // a newer search is on its way
    finder.results = (Array.isArray(data.results) ? data.results : []).filter((r) => SESSION_ID.test(String(r?.sessionId ?? '')) && typeof r.projectId === 'string');
    const n = finder.results.length;
    const where = all ? 'semua project' : 'project ini';
    $('#search-status').textContent = n
      ? `${n} hasil di ${where}${data.truncated ? ' · dibatasi, perjelas kata kunci untuk hasil lain' : ''}`
      : `Tidak ada yang cocok di ${where}.`;
    renderResults(all);
  } catch (err) {
    if (seq !== finder.seq) return;
    finder.results = [];
    $('#search-status').textContent = '';
    list.innerHTML = `<li class="state-error">Gagal mencari: ${escapeHtml(err.message)}</li>`;
  } finally {
    if (seq === finder.seq) list.removeAttribute('aria-busy');
  }
}

function renderResults(all) {
  const list = $('#search-results');
  if (!finder.results.length) {
    list.innerHTML = '<li class="s-empty"><b>Tidak ditemukan</b><p class="muted">Coba kata lain, atau centang “Semua project”.</p></li>';
    return;
  }
  list.innerHTML = finder.results
    .map((r, i) => {
      const snip = r.snippet ?? {};
      const engine = r.engine === 'opencode' ? 'opencode' : 'claude';
      const current = r.sessionId === state.statuses[r.projectId]?.sessionId;
      const title = String(r.title ?? `Sesi ${r.sessionId.slice(0, 8)}`);
      const action = current
        ? '<span class="s-current">● Sedang dibuka</span>'
        : `<button type="button" class="primary s-resume" data-resume="${i}" aria-label="Lanjutkan sesi ${escapeHtml(title)}" ${state.readOnly ? `disabled title="${READ_ONLY_HINT}"` : ''}>Lanjutkan</button>`;
      const ts = Number(r.ts);
      const source = engine === 'opencode' ? (r.source === 'cli' ? 'OpenCode (terminal)' : 'OpenCode') : r.source === 'web' ? 'Web' : 'Terminal';
      const sourceClass = engine === 'opencode' ? 'opencode' : r.source === 'web' ? 'web' : 'cli';
      const role = r.role === 'assistant' ? (engine === 'opencode' ? 'OpenCode' : 'Claude') : 'Kamu';
      const exportBtn = engine === 'opencode'
        ? `<button type="button" class="ghost s-export" data-export-json="${i}" title="Unduh sesi ini sebagai JSON OpenCode" aria-label="Export JSON: ${escapeHtml(title)}">⬇ .json</button>`
        : `<button type="button" class="ghost s-export" data-export="${i}" title="Unduh sesi ini sebagai Markdown (.md)" aria-label="Export .md: ${escapeHtml(title)}">⬇ .md</button>`;
      return `<li class="s-item sr-item ${current ? 'current' : ''}">
        <div class="s-main">
          <span class="s-title">${escapeHtml(title)}</span>
          <p class="sr-snippet"><span class="sr-role">${role}:</span> ${escapeHtml(snip.before)}<mark>${escapeHtml(snip.match)}</mark>${escapeHtml(snip.after)}</p>
          <span class="s-meta">${all ? `<span class="sr-project">${escapeHtml(projectName(r.projectId))}</span>` : ''}<span class="src src-${sourceClass}">${source}</span>${Number.isFinite(ts) && ts > 0 ? ago(ts) : ''} · <code>${escapeHtml(r.sessionId.slice(0, 8))}</code></span>
        </div>
        <div class="sr-actions">
          ${exportBtn}
          ${action}
        </div>
      </li>`;
    })
    .join('');
}

async function resumeResult(r, btn) {
  if (!state.projects.some((p) => p.id === r.projectId)) return toast('Project hasil ini sudah tidak ada di daftar.');
  const engine = r.engine === 'opencode' ? 'opencode' : 'claude';
  // Stage 1: the result belongs to a project whose engine may differ. Switch THAT project only (never the default).
  const currentEngine = engineOf(state.statuses[r.projectId] ?? {}, state.config);
  if (engine !== currentEngine) {
    const label = engineLabel(engine);
    if (!window.confirm(`Hasil ini dari ${label}. Project ${projectName(r.projectId)} sekarang memakai ${engineLabel(currentEngine)}.\n\nGanti mesin project itu ke ${label} untuk melanjutkan sesi? Project lain tidak terpengaruh.`)) return;
    try {
      await api(`/api/projects/${encodeURIComponent(r.projectId)}/engine`, { engine });
      toast(`Project ini sekarang memakai ${label}.`, 'ok');
    } catch (err) {
      return toast(err.message, 'warn');
    }
  }
  if (r.projectId !== state.active) selectProject(r.projectId);
  if (await resumeSession(r.projectId, r.sessionId, btn)) closeModal('search-modal');
}

export async function resumeSearchResult(r) {
  return resumeResult(r, null);
}

export function initConversations() {
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch();
  });
  $('#search-q').addEventListener('input', () => {
    if ($('#search-q').value.trim().length >= MIN_QUERY) {
      $('#search-q').removeAttribute('aria-invalid');
      $('#search-error').textContent = '';
    }
  });
  $('#search-all').addEventListener('change', () => {
    if ($('#search-q').value.trim().length >= MIN_QUERY) runSearch();
  });
  $('#search-results').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-export], [data-export-json], [data-resume]');
    const r = btn && finder.results[Number(btn.dataset.export ?? btn.dataset.exportJson ?? btn.dataset.resume)];
    if (!r) return;
    if (btn.dataset.export !== undefined) exportSessionMarkdown(r.projectId, r.sessionId);
    else if (btn.dataset.exportJson !== undefined) exportOpenCodeJson(r.projectId, r.sessionId);
    else resumeResult(r, btn);
  });
  for (const box of document.querySelectorAll('.export-tools-opt')) {
    box.checked = exportTools();
    box.addEventListener('change', () => setExportTools(box.checked));
  }
}
