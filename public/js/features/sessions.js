// Sessions: the session bar above the chat, the history dialog (/resume), starting a new session.
import { api, toast } from '../core/api.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { ago, DAY } from '../core/format.js';
import { DEMO_ID, projectName, READ_ONLY_HINT, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { exportSessionMarkdown } from './conversations.js';
import { saveBlob } from '../core/util.js';

const sessionTitles = new Map(); // Claude Code session id -> { title, source }
const titleTried = new Map(); // session id -> last lookup (a brand-new transcript may not exist yet)
const sessionsView = { project: null, list: [], current: null }; // the open history dialog

function rememberSessions(sessions) {
  for (const s of sessions) sessionTitles.set(s.id, { title: s.title, source: s.source });
}

function lookupSessionTitle(projectId, sessionId) {
  if (Date.now() - (titleTried.get(sessionId) ?? 0) < 15_000) return;
  titleTried.set(sessionId, Date.now());
  api(`/api/projects/${projectId}/sessions`)
    .then(({ sessions }) => {
      rememberSessions(sessions);
      if (state.active === projectId) renderSessionBar();
    })
    .catch(() => {});
}

/** Which Claude Code conversation the chat continues: shown above the messages. */
export function renderSessionBar() {
  const isDemo = state.active === DEMO_ID;
  $('#session-bar').hidden = isDemo;
  if (isDemo) {
    $('#head-sub').textContent = '';
    return;
  }
  const st = state.statuses[state.active] ?? {};
  const known = st.sessionId ? sessionTitles.get(st.sessionId) : null;
  if (st.sessionId && !known) lookupSessionTitle(state.active, st.sessionId);
  // A name set with /rename (or by clicking the title) wins, as in the CLI's /resume list.
  $('#sb-title').textContent = st.sessionId ? (st.title ?? known?.title ?? `Sesi ${st.sessionId.slice(0, 8)}`) : 'Percakapan baru';
  $('#sb-title').title = st.sessionId ? 'Klik untuk mengganti nama sesi (/rename)' : '';
  const title = $('#sb-title');
  title.classList.toggle('renamable', Boolean(st.sessionId));
  // Renamable: reachable by keyboard like a button (Enter/Space handled by the delegated listener).
  if (st.sessionId) {
    title.setAttribute('role', 'button');
    title.tabIndex = 0;
  } else {
    title.removeAttribute('role');
    title.removeAttribute('tabindex');
  }
  const meta = st.sessionId
    ? [(state.config?.engine ?? st.engine) === 'opencode' ? 'sesi OpenCode' : known?.source === 'cli' ? 'lanjutan sesi terminal' : 'sesi web', st.sessionId.slice(0, 8), st.activeModel]
    : [`pesan pertamamu memulai sesi ${(state.config?.engine ?? st.engine) === 'opencode' ? 'OpenCode' : 'Claude Code'} baru`];
  if (st.cliBusy) meta.push('terminal aktif');
  $('#sb-meta').textContent = meta.filter(Boolean).join(' · ');
  // Phone header: the session bar is hidden there, its title and the turn's state sit under the project name.
  const status = st.pending ? 'menunggu izin' : st.busy || st.cliBusy ? 'bekerja…' : '';
  $('#head-sub').textContent = [$('#sb-title').textContent, status].filter(Boolean).join(' · ');
}

function dayGroup(ts) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t = today.getTime();
  if (ts >= t) return 'Hari ini';
  if (ts >= t - DAY) return 'Kemarin';
  if (ts >= t - 6 * DAY) return '7 hari terakhir';
  return 'Lebih lama';
}

export async function openSessions() {
  if (state.active === DEMO_ID) return;
  sessionsView.project = state.active;
  $('#sessions-project').textContent = `· ${projectName(state.active)}`;
  $('#sessions-search').value = '';
  $('#sessions-list').innerHTML = '<p class="muted">Memuat riwayat…</p>';
  openModal('sessions-modal');
  try {
    const { sessions, current } = await api(`/api/projects/${sessionsView.project}/sessions`);
    rememberSessions(sessions);
    Object.assign(sessionsView, { list: sessions, current });
    renderSessionList();
    renderSessionBar();
    if (!narrow.matches) $('#sessions-search').focus();
  } catch (err) {
    $('#sessions-list').innerHTML = `<p class="state-error">Gagal memuat riwayat: ${escapeHtml(err.message)}</p>`;
  }
}

function renderSessionList() {
  const box = $('#sessions-list');
  if (!sessionsView.list.length) {
    box.innerHTML = '<div class="s-empty"><b>Belum ada sesi</b><p class="muted">Sesi Claude Code dari terminal atau web untuk project ini akan muncul di sini.</p></div>';
    return;
  }
  const q = $('#sessions-search').value.trim().toLowerCase();
  const list = sessionsView.list.filter((s) => !q || s.title.toLowerCase().includes(q) || s.id.startsWith(q));
  if (!list.length) {
    box.innerHTML = '<div class="s-empty"><p class="muted">Tidak ada sesi yang cocok.</p></div>';
    return;
  }
  // A session still running in a terminal must not be continued here too: both would write one transcript.
  const st = state.statuses[sessionsView.project] ?? {};
  const liveInTerminal = st.cliBusy ? st.cliSession : null;
  let group = null;
  const opencode = state.config?.engine === 'opencode';
  const opt = document.querySelector('#sessions-modal .export-opt');
  if (opt) opt.hidden = opencode; // OpenCode exports its own JSON (no tool-summary option)
  const ro = state.readOnly ? `disabled title="${READ_ONLY_HINT}"` : '';
  box.innerHTML = list
    .map((s) => {
      const g = dayGroup(s.updated);
      const head = g !== group ? `<div class="s-group">${g}</div>` : '';
      group = g;
      const current = s.id === sessionsView.current;
      const action = current
        ? '<span class="s-current">● Sedang dibuka</span>'
        : s.id === liveInTerminal
          ? '<span class="s-live" title="Selesaikan atau tutup dulu di terminal sebelum melanjutkannya di sini">● Berjalan di terminal</span>'
          : `<button class="primary s-resume" data-resume="${escapeHtml(s.id)}" ${state.readOnly ? `disabled title="${READ_ONLY_HINT}"` : ''}>Lanjutkan</button>`;
      return `${head}<div class="s-item ${current ? 'current' : ''}">
        <div class="s-main">
          <span class="s-title">${escapeHtml(s.title)}</span>
          <span class="s-meta"><span class="src src-${s.source}">${s.source === 'web' ? 'Web' : s.source === 'opencode' ? 'OpenCode' : 'Terminal'}</span>${ago(s.updated)} · <code>${s.id.slice(0, 8)}</code></span>
        </div>
        <span class="s-tools">
          ${opencode ? `<button type="button" class="ghost icon" data-rename="${escapeHtml(s.id)}" title="Ganti nama" aria-label="Ganti nama: ${escapeHtml(s.title)}" ${ro}>✎</button>` : ''}
          <button type="button" class="ghost icon" data-fork="${escapeHtml(s.id)}" title="Cabangkan: lanjutkan salinannya, sesi asli tetap utuh" aria-label="Cabangkan: ${escapeHtml(s.title)}" ${ro}>⑂</button>
          <button type="button" class="ghost s-export" data-export="${escapeHtml(s.id)}" title="${opencode ? 'Unduh sesi ini (JSON OpenCode, bisa diimpor lagi)' : 'Unduh sesi ini sebagai Markdown (.md)'}" aria-label="Export: ${escapeHtml(s.title)}">⬇ ${opencode ? '.json' : '.md'}</button>
          ${current || s.id === liveInTerminal ? '' : `<button type="button" class="ghost icon danger-text" data-delete="${escapeHtml(s.id)}" title="Hapus sesi ini" aria-label="Hapus: ${escapeHtml(s.title)}" ${ro}>🗑</button>`}
        </span>
        ${action}
      </div>`;
    })
    .join('');
}

const titleOf = (id) => sessionsView.list?.find((s) => s.id === id)?.title ?? id.slice(0, 8);

/** ⑂ Cabangkan, 🗑 Hapus, ✎ Ganti nama (OpenCode) from Riwayat sesi. */
async function sessionAction(btn) {
  const project = sessionsView.project;
  try {
    if (btn.dataset.delete) {
      const id = btn.dataset.delete;
      const where = state.config?.engine === 'opencode' ? 'dari OpenCode (sama seperti opencode session delete)' : 'ke folder data/trash aplikasi (bisa dikembalikan manual)';
      if (!window.confirm(`Hapus sesi "${titleOf(id)}"?

Sesi dipindahkan/dihapus ${where}.`)) return;
      await api(`/api/projects/${project}/session-delete`, { sessionId: id });
      toast('Sesi dihapus.', 'ok');
      return openSessions();
    }
    if (btn.dataset.fork) {
      const id = btn.dataset.fork;
      if (!window.confirm(`Cabangkan "${titleOf(id)}"?

Percakapan berlanjut di salinan baru; sesi aslinya tidak berubah.`)) return;
      await api(`/api/projects/${project}/session-fork`, { sessionId: id });
      toast('Sesi dicabangkan. Pesan berikutnya melanjutkan salinannya.', 'ok');
      return closeModal('sessions-modal');
    }
    if (btn.dataset.rename) {
      const id = btn.dataset.rename;
      const title = window.prompt('Nama sesi:', titleOf(id))?.trim();
      if (!title) return;
      await api(`/api/projects/${project}/session-rename`, { sessionId: id, title });
      toast('Nama sesi diganti.', 'ok');
      return openSessions();
    }
  } catch (err) {
    toast(err.message, 'warn');
  }
}

/** ⬇ .json: an OpenCode session as OpenCode's own export (re-import with `opencode session import`). */
async function exportOpenCodeJson(projectId, sessionId) {
  try {
    const { name, data } = await api(`/api/projects/${projectId}/session-export-json`, { sessionId });
    saveBlob(String(name).replace(/[^\w.-]+/g, '_'), new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    toast('Sesi OpenCode diekspor (JSON).', 'ok');
  } catch (err) {
    toast(`Gagal mengekspor: ${err.message}`);
  }
}

/** Continues a past session (Riwayat sesi, 🔎 Cari percakapan). True when it was resumed. */
export async function resumeSession(projectId, sessionId, btn = null) {
  const st = state.statuses[projectId] ?? {};
  const warnings = [
    st.busy ? 'Tim sedang bekerja di percakapan ini — pekerjaannya akan dihentikan.' : '',
    st.cliBusy ? 'Ada sesi yang sedang berjalan di terminal untuk project ini. Jangan lanjutkan sesi yang sama di dua tempat sekaligus.' : '',
  ].filter(Boolean);
  if (warnings.length && !window.confirm(`${warnings.join('\n\n')}\n\nTetap lanjutkan sesi ini?`)) return false;
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Membuka…';
  }
  try {
    await api(`/api/projects/${projectId}/resume`, { sessionId });
    toast('Sesi dilanjutkan — percakapan terakhirnya dimuat ke chat.', 'ok');
    return true;
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
    toast(err.message);
    return false;
  }
}

export function confirmNew() {
  const st = state.statuses[state.active] ?? {};
  if (!st.sessionId && !st.busy) return true;
  const busy = st.busy ? '\n\nTim sedang bekerja — pekerjaannya akan dihentikan.' : '';
  return window.confirm(`Mulai sesi baru?\n\nClaude tidak membawa konteks percakapan ini. Percakapan ini tetap bisa dilanjutkan lagi lewat 🕘 Riwayat sesi.${busy}`);
}

export function initSessions() {
  $('#sb-title').addEventListener('click', async () => {
    const st = state.statuses[state.active] ?? {};
    if (!st.sessionId || state.active === DEMO_ID || state.readOnly) return;
    const current = $('#sb-title').textContent;
    const title = window.prompt('Nama sesi (sama dengan /rename di Claude Code):', current)?.trim();
    if (!title || title === current) return;
    try {
      await api(`/api/projects/${state.active}/rename`, { title });
      sessionTitles.delete(st.sessionId); // the history list reads the new name next time
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-sessions').addEventListener('click', openSessions);
  $('#sessions-search').addEventListener('input', renderSessionList);
  $('#sessions-list').addEventListener('click', async (e) => {
    const exp = e.target.closest('[data-export]');
    if (exp) return state.config?.engine === 'opencode' ? exportOpenCodeJson(sessionsView.project, exp.dataset.export) : exportSessionMarkdown(sessionsView.project, exp.dataset.export);
    const act = e.target.closest('[data-fork], [data-delete], [data-rename]');
    if (act) return sessionAction(act);
    const btn = e.target.closest('[data-resume]');
    if (btn && (await resumeSession(sessionsView.project, btn.dataset.resume, btn))) closeModal('sessions-modal');
  });
  $('#sessions-new').addEventListener('click', () => {
    if (!confirmNew()) return;
    closeModal('sessions-modal');
    api(`/api/projects/${state.active}/reset`).catch((err) => toast(err.message));
  });
}
