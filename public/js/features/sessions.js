// Sessions: the session bar above the chat, the history dialog (/resume), starting a new session.
import { api, toast } from '../core/api.js';
import { $, escapeHtml, narrow } from '../core/dom.js';
import { engineBadge, engineLabel, engineOf } from '../core/engine-caps.js';
import { ago, DAY, fmtTokens } from '../core/format.js';
import { DEMO_ID, auth, projectName, READ_ONLY_HINT, state } from '../core/state.js';
import { closeModal, openModal } from '../ui/modals.js';
import { exportSessionMarkdown, exportTools } from './conversations.js';
import { saveBlob } from '../core/util.js';

const sessionTitles = new Map(); // Claude Code session id -> { title, source }
const titleTried = new Map(); // session id -> last lookup (a brand-new transcript may not exist yet)
const sessionsView = { project: null, list: [], current: null, selected: new Set(), tag: null, autoDays: 0, trash: [], trashDays: 0 }; // the open history dialog

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

/** Which conversation the chat continues (Claude Code or OpenCode, per project): shown above the messages. */
export function renderSessionBar() {
  const isDemo = state.active === DEMO_ID;
  $('#session-bar').hidden = isDemo;
  if (isDemo) {
    $('#head-sub').textContent = '';
    return;
  }
  const st = state.statuses[state.active] ?? {};
  const engine = engineOf(st, state.config);
  $('#btn-sessions').title = `Lihat dan lanjutkan sesi ${engineLabel(engine)} sebelumnya (dari terminal maupun web)`;
  $('#btn-new').title = `Mulai percakapan baru — ${engineLabel(engine)} tidak membawa konteks percakapan ini`;
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
    ? [engine === 'opencode' ? 'sesi OpenCode' : known?.source === 'cli' ? 'lanjutan sesi terminal' : 'sesi web', st.sessionId.slice(0, 8), st.activeModel]
    : [`pesan pertamamu memulai sesi ${engine === 'opencode' ? 'OpenCode' : 'Claude Code'} baru`];
  if (st.cliBusy) meta.push('terminal aktif');
  // 🔀 The project's engine first on the meta line: visible before a prompt is sent (its picker row has the same badge).
  const badge = `<span id="sb-engine" class="engine-badge" data-engine="${escapeHtml(engine)}" title="Mesin project ini: ${escapeHtml(engineLabel(engine))} — ganti di ⚙ Pengaturan → Mesin project" aria-label="Mesin project: ${escapeHtml(engineLabel(engine))}">${escapeHtml(engineBadge(engine))}</span>`;
  $('#sb-meta').innerHTML = badge + escapeHtml(meta.filter(Boolean).join(' · '));
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
  sessionsView.selected.clear();
  sessionsView.tag = null;
  $('#sessions-project').textContent = `· ${projectName(state.active)}`;
  $('#sessions-search').value = '';
  $('#sessions-range').value = 'all';
  $('#sessions-list').innerHTML = '<p class="muted">Memuat riwayat…</p>';
  $('#sessions-bulk').hidden = true;
  // Import is OpenCode-only, but of THIS project's engine (an OpenCode project under a Claude default still gets it).
  $('#sessions-import').hidden = engineOf(state.statuses[state.active] ?? {}, state.config) !== 'opencode' || !state.local || state.readOnly;
  openModal('sessions-modal');
  try {
    const { sessions, current, autoArchiveDays } = await api(`/api/projects/${sessionsView.project}/sessions`);
    rememberSessions(sessions);
    Object.assign(sessionsView, { list: sessions, current, autoDays: Number(autoArchiveDays) || 0 });
    const auto = $('#sessions-auto-archive');
    if (auto) {
      auto.value = String(sessionsView.autoDays);
      auto.disabled = state.readOnly;
      auto.title = state.readOnly ? READ_ONLY_HINT : 'Sesi yang tidak dipakai lebih dari waktu ini masuk arsip (masih bisa dibuka)';
    }
    renderSessionList();
    renderSessionBar();
    loadTrash(); // 🗑 what was deleted (Claude Code keeps it in data/trash), separately from the list
    if (!narrow.matches) $('#sessions-search').focus();
  } catch (err) {
    $('#sessions-list').innerHTML = `<p class="state-error">Gagal memuat riwayat: ${escapeHtml(err.message)}</p>`;
  }
}

/** " · 1.2k token · $0.50" under a session (only what the ledger recorded for that session id). */
function usageText(usage) {
  if (!usage || (!usage.tokens && !usage.usd)) return '';
  const parts = [];
  if (usage.tokens) parts.push(`${fmtTokens(usage.tokens)} token`);
  if (usage.usd) parts.push(`$${usage.usd.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

/** 🏷 The tags in use, as chips: one click narrows the list (and "Semua" clears it). */
function renderTagChips() {
  const box = $('#sessions-tags');
  if (!box) return;
  const counts = new Map();
  for (const s of sessionsView.list) if (s.tag) counts.set(s.tag, (counts.get(s.tag) ?? 0) + 1);
  if (!counts.size) {
    sessionsView.tag = null;
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  if (sessionsView.tag && !counts.has(sessionsView.tag)) sessionsView.tag = null;
  const active = sessionsView.tag;
  const chip = (value, label, count) =>
    `<button type="button" class="s-tag-chip${active === value ? ' active' : ''}" data-filter-tag="${escapeHtml(value)}" aria-pressed="${active === value}">${label}${count ? ` <span class="count">${count}</span>` : ''}</button>`;
  box.hidden = false;
  box.innerHTML =
    [
      chip('', 'Semua', 0),
      ...[...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([tag, n]) => chip(tag, `🏷 ${escapeHtml(tag)}`, n)),
    ].join('') + (state.readOnly ? '' : '<button type="button" class="s-tag-chip manage" data-tag-manage="1" title="Ganti nama atau hapus tag">✎ Kelola tag</button>');
}

function renderSessionList() {
  const box = $('#sessions-list');
  const bulk = $('#sessions-bulk');
  if (bulk) bulk.hidden = true; // shown again only when there is something to pick
  const opencode = engineOf(state.statuses[sessionsView.project] ?? {}, state.config) === 'opencode';
  renderTagChips();
  if (!sessionsView.list.length) {
    box.innerHTML = `<div class="s-empty"><b>Belum ada sesi</b><p class="muted">Sesi ${opencode ? 'OpenCode' : 'Claude Code'} dari terminal atau web untuk project ini akan muncul di sini.</p></div>`;
    return;
  }
  const q = $('#sessions-search').value.trim().toLowerCase();
  const range = $('#sessions-range').value;
  const showArchived = range === 'archived';
  const days = showArchived ? 0 : Number(range) || 0;
  const since = days ? Date.now() - days * 86_400_000 : 0;
  const list = sessionsView.list.filter(
    (s) =>
      (!sessionsView.tag || s.tag === sessionsView.tag) &&
      (showArchived ? s.archived === true : !s.archived) &&
      (!since || s.updated >= since) &&
      (!q || s.title.toLowerCase().includes(q) || (s.tag ?? '').toLowerCase().includes(q) || s.id.startsWith(q)),
  );
  if (!list.length) {
    box.innerHTML = showArchived
      ? '<div class="s-empty"><p class="muted">Belum ada sesi diarsipkan. Pakai 📦 pada sesi untuk menyembunyikannya dari daftar.</p></div>'
      : `<div class="s-empty"><p class="muted">Tidak ada sesi yang cocok${days ? ' dalam rentang ini' : ''}.</p></div>`;
    return;
  }
  // A session still running in a terminal must not be continued here too: both would write one transcript.
  const st = state.statuses[sessionsView.project] ?? {};
  const liveInTerminal = st.cliBusy ? st.cliSession : null;
  const deletable = (s) => s.id !== sessionsView.current && s.id !== liveInTerminal;
  // Only the rows on screen can be picked; a filter change drops whatever scrolled out of the selection.
  const pickable = new Set(list.filter(deletable).map((s) => s.id));
  for (const id of sessionsView.selected) if (!pickable.has(id)) sessionsView.selected.delete(id);
  if (bulk) bulk.hidden = state.readOnly || !pickable.size; // read-only gets no checkboxes either
  let group = null;
  // OpenCode exports its own JSON (no Claude tool-summary option).
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
      const pick =
        state.readOnly || !deletable(s)
          ? ''
          : `<label class="s-pick"><input type="checkbox" data-pick="${escapeHtml(s.id)}" ${sessionsView.selected.has(s.id) ? 'checked' : ''} aria-label="Pilih sesi: ${escapeHtml(s.title)}" /></label>`;
      return `${head}<div class="s-item ${current ? 'current' : ''} ${sessionsView.selected.has(s.id) ? 'picked' : ''}">
        ${pick}
        <div class="s-main">
          <span class="s-title">${escapeHtml(s.title)}</span>
          <span class="s-meta"><span class="src src-${s.source}">${s.source === 'web' ? 'Web' : s.source === 'opencode' ? 'OpenCode' : 'Terminal'}</span>${s.tag ? `<span class="s-tag" title="Tag sesi">🏷 ${escapeHtml(s.tag)}</span>` : ''}${ago(s.updated)} · <code>${s.id.slice(0, 8)}</code>${usageText(s.usage)}</span>
        </div>
        <span class="s-tools">
          ${`<button type="button" class="ghost icon" data-tag="${escapeHtml(s.id)}" title="${s.tag ? 'Ganti tag' : 'Beri tag'}" aria-label="Beri tag: ${escapeHtml(s.title)}" ${ro}>🏷</button>`}
          ${`<button type="button" class="ghost icon" data-archive="${escapeHtml(s.id)}" data-on="${s.archived ? '1' : '0'}" data-auto="${s.autoArchived ? '1' : '0'}" title="${s.archived ? (s.autoArchived ? `Diarsipkan otomatis setelah ${sessionsView.autoDays} hari — klik untuk menyimpannya di daftar utama` : 'Keluarkan dari arsip') : 'Arsipkan: sembunyikan dari daftar utama'}" aria-label="${s.archived ? 'Keluarkan dari arsip' : 'Arsipkan'}: ${escapeHtml(s.title)}" ${ro}>${s.archived ? '↩' : '📦'}</button>`}
          ${`<button type="button" class="ghost icon" data-rename="${escapeHtml(s.id)}" title="Ganti nama" aria-label="Ganti nama: ${escapeHtml(s.title)}" ${ro}>✎</button>`}
          <button type="button" class="ghost icon" data-fork="${escapeHtml(s.id)}" title="Cabangkan: lanjutkan salinannya, sesi asli tetap utuh" aria-label="Cabangkan: ${escapeHtml(s.title)}" ${ro}>⑂</button>
          <button type="button" class="ghost s-export" data-export="${escapeHtml(s.id)}" title="${opencode ? 'Unduh sesi ini (JSON OpenCode, bisa diimpor lagi)' : 'Unduh sesi ini sebagai Markdown (.md)'}" aria-label="Export: ${escapeHtml(s.title)}">⬇ ${opencode ? '.json' : '.md'}</button>
          ${current || s.id === liveInTerminal ? '' : `<button type="button" class="ghost icon danger-text" data-delete="${escapeHtml(s.id)}" title="Hapus sesi ini" aria-label="Hapus: ${escapeHtml(s.title)}" ${ro}>🗑</button>`}
        </span>
        ${action}
      </div>`;
    })
    .join('');
  syncBulk();
}

/** Keeps "Pilih semua", the count on the delete button and the picked row tint in sync with the checkboxes. */
function syncBulk() {
  const boxes = [...document.querySelectorAll('#sessions-list [data-pick]')];
  const picked = boxes.filter((b) => b.checked).length;
  const all = $('#sessions-select-all');
  if (all) {
    all.checked = boxes.length > 0 && picked === boxes.length;
    all.indeterminate = picked > 0 && picked < boxes.length;
  }
  const btn = $('#sessions-delete-selected');
  if (btn) {
    btn.disabled = !picked;
    btn.textContent = picked ? `Hapus ${picked} sesi` : 'Hapus sesi';
  }
  const exp = $('#sessions-export-selected');
  if (exp) {
    exp.disabled = !picked;
    exp.textContent = picked ? `⬇ Export ${picked}` : '⬇ Export';
  }
  const tagBtn = $('#sessions-tag-selected');
  if (tagBtn) {
    tagBtn.disabled = !picked;
    tagBtn.textContent = picked ? `🏷 Tag ${picked}` : '🏷 Tag';
  }
  const arch = $('#sessions-archive-selected');
  if (arch) {
    const ids = [...sessionsView.selected];
    const allArchived = ids.length > 0 && ids.every((id) => sessionsView.list.find((s) => s.id === id)?.archived);
    arch.disabled = !picked;
    arch.textContent = picked ? (allArchived ? `↩ Keluarkan ${picked}` : `📦 Arsipkan ${picked}`) : '📦 Arsipkan';
  }
  for (const b of boxes) b.closest('.s-item')?.classList.toggle('picked', b.checked);
}

/** ⬇ Export N sesi: one .zip with the selected transcripts (Claude .md, OpenCode .json). */
async function exportSelected() {
  const ids = [...sessionsView.selected].slice(0, 25);
  if (!ids.length) return;
  if (sessionsView.selected.size > 25) toast('Maksimal 25 sesi per export; sisanya dilewati.', 'warn');
  const btn = $('#sessions-export-selected');
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = `Menyiapkan ${ids.length}…`;
  }
  try {
    const res = await fetch(`/api/projects/${sessionsView.project}/sessions-export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Office-Token': auth.token },
      body: JSON.stringify({ sessionIds: ids, tools: exportTools() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'sesi.zip';
    saveBlob(name, await res.blob());
    toast(`${ids.length} sesi diekspor.`, 'ok');
  } catch (err) {
    toast(`Export gagal: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = !sessionsView.selected.size;
      btn.textContent = label;
    }
  }
}

/** 🗑 Hapus N sesi: one confirmation, then the same per-session route as the row button (skips failures). */
async function deleteSelected() {
  const ids = [...sessionsView.selected];
  if (!ids.length) return;
  const project = sessionsView.project;
  const opencode = engineOf(state.statuses[project] ?? {}, state.config) === 'opencode';
  const where = opencode
    ? 'dari OpenCode (sama seperti opencode session delete)'
    : 'ke folder data/trash aplikasi (bisa dikembalikan manual)';
  if (!window.confirm(`Hapus ${ids.length} sesi?\n\nSesi dipindahkan/dihapus ${where}. Sesi yang sedang dibuka tidak ikut.`)) return;
  const btn = $('#sessions-delete-selected');
  let done = 0;
  let failed = 0;
  for (const [i, id] of ids.entries()) {
    if (btn) btn.textContent = `Menghapus ${i + 1}/${ids.length}…`;
    try {
      await api(`/api/projects/${project}/session-delete`, { sessionId: id });
      sessionsView.selected.delete(id);
      done += 1;
    } catch (err) {
      failed += 1;
      toast(`Gagal menghapus ${titleOf(id)}: ${err.message}`, 'warn');
    }
  }
  toast(failed ? `${done} sesi dihapus, ${failed} gagal.` : `${done} sesi dihapus.`, failed ? 'warn' : 'ok');
  await openSessions();
}

/** 🏷 Give every selected session the same tag (empty removes it). */
async function tagSelected() {
  const ids = [...sessionsView.selected];
  if (!ids.length) return;
  const known = [...new Set(sessionsView.list.map((s) => s.tag).filter(Boolean))];
  const hint = known.length ? `\nTag yang sudah dipakai: ${known.slice(0, 8).join(', ')}` : '';
  const tag = window.prompt(`Tag untuk ${ids.length} sesi (kosongkan untuk menghapus):${hint}`, '');
  if (tag === null) return;
  const project = sessionsView.project;
  const btn = $('#sessions-tag-selected');
  if (btn) btn.disabled = true;
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await api(`/api/projects/${project}/session-meta`, { sessionId: id, tag });
      done += 1;
    } catch (err) {
      failed += 1;
      toast(`Gagal menandai ${titleOf(id)}: ${err.message}`, 'warn');
    }
  }
  toast(failed ? `${done} sesi ditandai, ${failed} gagal.` : `${done} sesi ditandai.`, failed ? 'warn' : 'ok');
  await openSessions();
}

/** ✎ Rename (or remove) one tag everywhere in this project. */
async function manageTags() {
  const known = [...new Set(sessionsView.list.map((s) => s.tag).filter(Boolean))].sort();
  const from = window.prompt(`Tag yang diubah (${known.join(', ')}):`, known[0] ?? '');
  if (!from) return;
  const to = window.prompt(`Nama baru untuk "${from}" (kosongkan untuk menghapus tag):`, from);
  if (to === null) return;
  try {
    const { changed } = await api(`/api/projects/${sessionsView.project}/session-tags`, { from, to });
    toast(to.trim() ? `Tag diganti di ${changed} sesi.` : `Tag dihapus dari ${changed} sesi.`, 'ok');
    await openSessions();
  } catch (err) {
    toast(err.message, 'warn');
  }
}

/** 📦 Archive (or un-archive) every selected session in one go. */
async function archiveSelected() {
  const ids = [...sessionsView.selected];
  if (!ids.length) return;
  const allArchived = ids.every((id) => sessionsView.list.find((s) => s.id === id)?.archived);
  const target = !allArchived;
  const project = sessionsView.project;
  const btn = $('#sessions-archive-selected');
  if (btn) btn.disabled = true;
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    // Un-archiving an automatically archived session pins it (age alone will not archive it again).
    const auto = sessionsView.list.find((s) => s.id === id)?.autoArchived;
    const patch = target ? { archived: true, pinned: false } : { archived: false, ...(auto ? { pinned: true } : {}) };
    try {
      await api(`/api/projects/${project}/session-meta`, { sessionId: id, ...patch });
      done += 1;
    } catch (err) {
      failed += 1;
      toast(`Gagal mengarsipkan ${titleOf(id)}: ${err.message}`, 'warn');
    }
  }
  toast(failed ? `${done} sesi diubah, ${failed} gagal.` : target ? `${done} sesi diarsipkan.` : `${done} sesi dikeluarkan dari arsip.`, failed ? 'warn' : 'ok');
  await openSessions();
}

const titleOf = (id) => sessionsView.list?.find((s) => s.id === id)?.title ?? id.slice(0, 8);

/** ↘ Trashed sessions of a Claude project: loaded with the history, hidden when empty/read-only/OpenCode. */
async function loadTrash() {
  const box = $('#sessions-trash');
  sessionsView.trash = [];
  if (state.readOnly || engineOf(state.statuses[sessionsView.project] ?? {}, state.config) === 'opencode') {
    box.hidden = true;
    return;
  }
  try {
    const data = await api(`/api/projects/${sessionsView.project}/session-trash`);
    sessionsView.trash = Array.isArray(data?.sessions) ? data.sessions : [];
    sessionsView.trashDays = Number(data?.retentionDays) || 0;
  } catch {
    sessionsView.trash = []; // an older server or a transient error: no trash section
  }
  renderTrash();
}

function renderTrash() {
  const box = $('#sessions-trash');
  const items = sessionsView.trash ?? [];
  box.hidden = !items.length || state.readOnly;
  $('#sessions-trash-count').textContent = items.length ? `(${items.length})` : '';
  $('#sessions-trash-retention').textContent = sessionsView.trashDays ? `· otomatis dibersihkan setelah ${sessionsView.trashDays} hari` : '';
  $('#sessions-trash-list').innerHTML = items
    .map(
      (s) => `<div class="s-item">
        <div class="s-main">
          <span class="s-title">${escapeHtml(s.title)}</span>
          <span class="s-meta"><span class="src src-${s.source === 'web' ? 'web' : 'cli'}">${s.source === 'web' ? 'Web' : 'Terminal'}</span>Dihapus ${ago(s.trashedAt)} · ${Math.max(1, Math.round(s.size / 1024))} KB</span>
        </div>
        <button type="button" class="primary s-restore" data-restore="${escapeHtml(s.sessionId)}" aria-label="Pulihkan: ${escapeHtml(s.title)}">↩ Pulihkan</button>
      </div>`,
    )
    .join('');
}

/** ↩ Puts a trashed transcript back in the history. */
async function restoreTrash(id) {
  try {
    await api(`/api/projects/${sessionsView.project}/session-restore`, { sessionId: id });
    toast('Sesi dipulihkan.', 'ok');
    await openSessions();
    $('#sessions-trash').open = true; // stay in the section the reader is using
  } catch (err) {
    toast(err.message, 'warn');
  }
}

/** ⑂ Cabangkan, 🗑 Hapus, ✎ Ganti nama (OpenCode) from Riwayat sesi. */
async function sessionAction(btn) {
  const project = sessionsView.project;
  try {
    if (btn.dataset.delete) {
      const id = btn.dataset.delete;
      const where =
        engineOf(state.statuses[project] ?? {}, state.config) === 'opencode'
          ? 'dari OpenCode (sama seperti opencode session delete)'
          : 'ke folder data/trash aplikasi (bisa dikembalikan manual)';
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
    if (btn.dataset.tag !== undefined) {
      const id = btn.dataset.tag;
      const current = sessionsView.list.find((s) => s.id === id)?.tag ?? '';
      const known = [...new Set(sessionsView.list.map((s) => s.tag).filter(Boolean))];
      const hint = known.length ? `\nTag yang sudah dipakai: ${known.slice(0, 8).join(', ')}` : '';
      const tag = window.prompt(`Tag sesi (kosongkan untuk menghapus):${hint}`, current);
      if (tag === null) return;
      await api(`/api/projects/${project}/session-meta`, { sessionId: id, tag });
      toast(tag.trim() ? 'Tag sesi disimpan.' : 'Tag sesi dihapus.', 'ok');
      return openSessions();
    }
    if (btn.dataset.archive !== undefined) {
      const id = btn.dataset.archive;
      const archived = btn.dataset.on !== '1';
      // Un-archiving an automatically archived session pins it, so age alone does not archive it again.
      const patch = archived ? { archived: true, pinned: false } : { archived: false, ...(btn.dataset.auto === '1' ? { pinned: true } : {}) };
      await api(`/api/projects/${project}/session-meta`, { sessionId: id, ...patch });
      toast(archived ? 'Sesi diarsipkan.' : 'Sesi dikeluarkan dari arsip.', 'ok');
      return openSessions();
    }
  } catch (err) {
    toast(err.message, 'warn');
  }
}

/** ⬇ .json: an OpenCode session as OpenCode's own export (re-import with `opencode session import`). */
export async function exportOpenCodeJson(projectId, sessionId) {
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

async function importOpenCodeJson(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('File JSON tidak valid.', 'warn');
    return;
  }
  if (!window.confirm(`Import sesi OpenCode dari "${file.name}"?\n\nSesi baru ditambahkan ke Riwayat sesi; sesi yang ada tidak diubah.`)) return;
  try {
    const r = await api(`/api/projects/${sessionsView.project}/session-import-json`, { data });
    toast(r.sessionId ? `Sesi OpenCode diimpor (${r.sessionId.slice(0, 8)}).` : 'Sesi OpenCode diimpor.', 'ok');
    await openSessions();
  } catch (err) {
    toast(err.message, 'warn');
  }
}

export function initSessions() {
  $('#sessions-import').addEventListener('click', () => $('#sessions-import-file').click());
  $('#sessions-import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await importOpenCodeJson(file);
  });

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
  $('#sessions-range').addEventListener('change', renderSessionList);
  $('#sessions-tags').addEventListener('click', (e) => {
    if (e.target.closest('[data-tag-manage]')) return manageTags();
    const chip = e.target.closest('[data-filter-tag]');
    if (!chip) return;
    sessionsView.tag = chip.dataset.filterTag || null;
    renderSessionList();
  });
  $('#sessions-auto-archive').addEventListener('change', async (e) => {
    e.target.disabled = true;
    try {
      await api(`/api/projects/${sessionsView.project}/session-auto-archive`, { days: Number(e.target.value) || 0 });
      toast(Number(e.target.value) ? `Arsip otomatis: ${e.target.value} hari.` : 'Arsip otomatis dimatikan.', 'ok');
      await openSessions();
    } catch (err) {
      e.target.disabled = false;
      toast(err.message, 'warn');
    }
  });
  $('#sessions-list').addEventListener('click', async (e) => {
    const exp = e.target.closest('[data-export]');
    if (exp) {
      // Each session belongs to its project's engine: export its own format, whatever the app-wide default is.
      const opencode = engineOf(state.statuses[sessionsView.project] ?? {}, state.config) === 'opencode';
      return opencode ? exportOpenCodeJson(sessionsView.project, exp.dataset.export) : exportSessionMarkdown(sessionsView.project, exp.dataset.export);
    }
    const act = e.target.closest('[data-fork], [data-delete], [data-rename], [data-tag], [data-archive]');
    if (act) return sessionAction(act);
    const btn = e.target.closest('[data-resume]');
    if (btn && (await resumeSession(sessionsView.project, btn.dataset.resume, btn))) closeModal('sessions-modal');
  });
  $('#sessions-list').addEventListener('change', (e) => {
    const box = e.target.closest('[data-pick]');
    if (!box) return;
    if (box.checked) sessionsView.selected.add(box.dataset.pick);
    else sessionsView.selected.delete(box.dataset.pick);
    syncBulk();
  });
  $('#sessions-select-all').addEventListener('change', (e) => {
    const on = e.target.checked;
    for (const box of document.querySelectorAll('#sessions-list [data-pick]')) {
      box.checked = on;
      if (on) sessionsView.selected.add(box.dataset.pick);
      else sessionsView.selected.delete(box.dataset.pick);
    }
    syncBulk();
  });
  $('#sessions-delete-selected').addEventListener('click', deleteSelected);
  $('#sessions-tag-selected').addEventListener('click', tagSelected);
  $('#sessions-archive-selected').addEventListener('click', archiveSelected);
  $('#sessions-export-selected').addEventListener('click', exportSelected);
  $('#sessions-trash-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-restore]');
    if (btn) restoreTrash(btn.dataset.restore);
  });
  $('#sessions-new').addEventListener('click', () => {
    if (!confirmNew()) return;
    closeModal('sessions-modal');
    api(`/api/projects/${state.active}/reset`).catch((err) => toast(err.message));
  });
}
