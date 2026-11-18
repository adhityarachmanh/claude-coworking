// Above and below the composer: Claude's todo list and the status line (mode, model, context).
import { $, escapeHtml, narrow } from '../core/dom.js';
import { engineDown, normalizeMode } from '../core/engine-caps.js';
import { fmtTokens } from '../core/format.js';
import { freshnessText } from '../core/freshness.js';
import { requestResync } from '../core/resync.js';
import { DEMO_ID, state } from '../core/state.js';
import { progressLabel, turnProgress } from '../core/turn-progress.js';
import { api, toast } from '../core/api.js';
import { openCompact } from './compact.js';
import { connection, lastEventAgeSec } from './connection.js';
import { openQueue } from './queue.js';
import { fmtDuration, openTasks, runningCount } from './tasks.js';

/** Claude's todo list, pinned above the composer while there is work left (CLI: ☐ ◼ ☒). */
export function renderTodos(st) {
  const box = $('#todos');
  const todos = state.active === DEMO_ID ? [] : (st.todos ?? []);
  const done = todos.filter((t) => t.status === 'completed').length;
  // Like the CLI: the list goes away once everything is done and the turn has ended.
  if (!todos.length || (done === todos.length && !st.busy)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const collapsed = box.classList.contains('collapsed');
  const mark = { completed: '☒', in_progress: '◼' };
  const now = todos.find((t) => t.status === 'in_progress');
  // Phone, folded: one line "◼ 2/5 Menulis test ▸" (what is being done right now).
  const head = narrow.matches && collapsed
    ? `<button class="todos-head" type="button" aria-expanded="false" aria-label="Daftar tugas ${done} dari ${todos.length} selesai${now ? `, sekarang: ${escapeHtml(now.activeForm || now.content)}` : ''} — tampilkan">◼ <small>${done}/${todos.length}</small> <span class="todos-now">${escapeHtml(now ? now.activeForm || now.content : 'Daftar tugas')}</span> ▸</button>`
    : `<button class="todos-head" type="button" title="Sembunyikan / tampilkan daftar tugas"${narrow.matches ? ' aria-expanded="true"' : ''}>${collapsed ? '▸' : '▾'} Daftar tugas <small>${done}/${todos.length}</small></button>`;
  box.innerHTML = `${head}${
    collapsed
      ? ''
      : `<ul>${todos
          .map((t) => `<li class="st-${t.status}"><span>${mark[t.status] ?? '☐'}</span>${escapeHtml(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}</li>`)
          .join('')}</ul>`
  }`;
}

/** Short labels for the phone's settings chip (features/composer.js). One vocabulary for both engines. */
export const MODE_SHORT = { build: '🔨 Build', plan: '📋 Plan' };

const MODE_LABEL = { build: '🔨 build · edit otomatis', plan: '📋 plan dulu' };
export const MODE_CYCLE = ['build', 'plan']; // Shift+Tab: Build ⇄ Plan
export const modeShort = (mode) => MODE_SHORT[normalizeMode(mode)];
export const modeLabel = (mode) => MODE_LABEL[normalizeMode(mode)];

/** 🧹 Ringkas konteks: only with a real project that has a session, never only-lihat (the dialog itself re-checks). */
const compactReady = (st) => Boolean(state.active) && state.active !== DEMO_ID && !state.readOnly && Boolean(st?.sessionId || st?.context?.used);

/** "45 dtk tanpa kabar" when the open stream stopped delivering events (including the server's 15 s ping). */
const staleText = () => (connection.online ? freshnessText(lastEventAgeSec()) : '');

/** "⚠ OpenCode berhenti (exit 7) · ▶ Mulai ulang" — the code only when the server reported one. */
const downText = (down) => `⚠ OpenCode berhenti${down.exit != null ? ` (exit ${down.exit})` : ''} · ▶ Mulai ulang`;

/**
 * The turn's progress chip: "⏳ 4 mnt · 9 langkah · 2 berjalan" while running, "✓ Selesai · …" once the result is
 * in. A finished chip stays for two hours or until the next prompt — the answer to "is it done?" without asking.
 */
function turnChip(st) {
  const p = turnProgress(state.chats[state.active] ?? [], {
    now: Date.now(),
    busy: Boolean(st.busy || st.cliBusy),
    background: runningCount(st),
  });
  if (!p || (!p.total && !p.finished)) return null;
  if (p.finished && Date.now() - p.startedAt > 2 * 60 * 60_000) return null; // yesterday's turn is not news
  return { text: progressLabel(p, fmtDuration), finished: p.finished, ok: p.ok };
}

/** Status line under the composer: permission mode, model, and how full the context is. */
export function renderStatusline(st) {
  const line = $('#statusline');
  if (state.active === DEMO_ID) {
    line.innerHTML = '';
    line.classList.remove('has-chips');
    return;
  }
  const parts = [`<span class="sl-mode" title="Ganti dengan Shift+Tab">${modeLabel(st.mode)} <kbd>⇧Tab</kbd></span>`];
  const model = st.activeModel || st.model;
  if (model) parts.push(`<span class="sl-model">${escapeHtml(model)}</span>`);
  if (st.handoffReady) parts.push('<span class="sl-handoff" title="Konteks dari sumber sebelumnya ikut pada pesan berikutnya">🧠 Konteks sesi siap</span>');
  const down = engineDown(st, state.config);
  if (down && !state.readOnly) parts.push(`<button type="button" class="sl-down" data-engine-start title="Proses OpenCode berhenti sendiri. Ketuk untuk menyalakannya lagi — percakapan tetap sama.">${escapeHtml(downText(down))}</button>`);
  if (st.context?.used && !st.context.window) {
    // Window not reported yet (Claude Code tells it once the session runs): no guessed percentage.
    parts.push(`<span class="sl-ctx" title="Konteks terpakai: ${st.context.used.toLocaleString('id-ID')} token">konteks ${fmtTokens(st.context.used)}</span>`);
  } else if (st.context?.used) {
    const win = st.context.window; // as /context counts it
    const pct = Math.min(100, Math.round((st.context.used / win) * 100));
    // Warn like the CLI does: relative to where auto-compact kicks in, not the hard limit.
    const limit = st.context.autoCompactAt || win;
    const nearCompact = st.context.used / limit;
    const level = nearCompact >= 0.9 ? 'high' : nearCompact >= 0.7 ? 'mid' : '';
    const compactNote = st.context.autoCompactAt ? ` · auto-compact pada ${fmtTokens(st.context.autoCompactAt)}` : '';
    parts.push(
      `<span class="sl-ctx ${level}" title="Konteks terpakai: ${st.context.used.toLocaleString('id-ID')} dari ${win.toLocaleString('id-ID')} token${compactNote}${level ? ' · pertimbangkan /compact' : ''}"><span class="bar"><i style="width:${pct}%"></i></span>konteks ${pct}% · ${fmtTokens(st.context.used)}/${fmtTokens(win)}</span>`,
    );
  }
  if (compactReady(st)) parts.push('<button type="button" class="sl-compact" data-compact title="Ringkas konteks percakapan untuk menghemat token (memakai token; riwayat app tidak berubah) — /ringkas">🧹 Ringkas konteks</button>');
  const stale = staleText();
  if (stale) parts.push(`<button type="button" class="sl-stale" data-resync title="Sambungan tampak hidup, tetapi tidak ada kabar dari laptop — ketuk untuk menyegarkan">⟳ ${escapeHtml(stale)}</button>`);
  const running = runningCount(st); // same count as the ⧗ chip in the session bar
  if (running) parts.push(`<button type="button" class="sl-tasks" data-open-tasks title="Buka monitor tugas latar (/tasks)">⧗ ${running} tugas berjalan</button>`);
  const turn = turnChip(st);
  if (turn) parts.push(`<span class="sl-turn ${turn.finished ? (turn.ok === false ? 'stop' : 'done') : 'live'}" title="Progres giliran terakhir">${escapeHtml(turn.text)}</span>`);
  if (narrow.matches) return renderStrip(line, st, running);
  line.innerHTML = parts.join('<span class="sep">·</span>');
}

/** Phone: a strip of chips above the box, only with something to say (mode and model are on the settings chip). */
function renderStrip(line, st, running) {
  const chips = [];
  if (st.handoffReady) chips.push('<span class="sl-chip sl-handoff" title="Konteks dari sumber sebelumnya ikut pada pesan berikutnya">🧠 Konteks siap</span>');
  if (engineDown(st, state.config) && !state.readOnly) chips.push('<button type="button" class="sl-chip sl-warn sl-down" data-engine-start aria-label="OpenCode berhenti — ketuk untuk menyalakannya lagi">⚠ OpenCode · ▶</button>');
  if (running) chips.push(`<button type="button" class="sl-chip sl-tasks" data-open-tasks aria-label="${running} tugas berjalan — buka monitor tugas latar">⧗ ${running}</button>`);
  const q = st.taskQueue;
  const waiting = q ? q.waiting + q.running : 0;
  if (waiting) chips.push(`<button type="button" class="sl-chip" data-open-queue aria-label="Antrian: ${waiting} belum selesai${q.paused ? ', dijeda' : ''} — buka antrian">📋 ${q.paused ? '⏸ ' : ''}${waiting}</button>`);
  if (st.pending) chips.push('<button type="button" class="sl-chip sl-ask" data-jump-approval>✋ Menunggu izinmu</button>');
  if (st.autoApprove) chips.push('<span class="sl-chip sl-warn">⚠ Semua izin otomatis</span>');
  if (!connection.online) chips.push('<span class="sl-chip sl-warn">⚡ Belum tersambung</span>');
  const turn = turnChip(st);
  if (turn) chips.push(`<span class="sl-chip sl-turn ${turn.finished ? (turn.ok === false ? 'stop' : 'done') : 'live'}" title="Progres giliran terakhir">${escapeHtml(turn.text)}</span>`);
  const stale = staleText();
  if (stale) chips.push(`<button type="button" class="sl-chip sl-stale" data-resync aria-label="${escapeHtml(stale)} — ketuk untuk menyegarkan">⟳ ${escapeHtml(stale)}</button>`);
  // Context only once it matters (≥ 70 % of where auto-compact starts), as text: the /compact tip stays in the title.
  const ctx = st.context;
  if (ctx?.used && ctx.window) {
    const near = ctx.used / (ctx.autoCompactAt || ctx.window);
    const pct = Math.min(100, Math.round((ctx.used / ctx.window) * 100));
    if (near >= 0.7) chips.push(`<span class="sl-chip sl-ctx ${near >= 0.9 ? 'high' : 'mid'}" title="Konteks terpakai ${pct}% · pertimbangkan /compact">konteks ${pct}%</span>`);
  }
  if (compactReady(st)) chips.push('<button type="button" class="sl-chip sl-compact" data-compact aria-label="Ringkas konteks percakapan" title="/ringkas">🧹 Ringkas</button>');
  line.classList.toggle('has-chips', chips.length > 0);
  line.innerHTML = chips.join('');
}

/** ▶ The engine process died on its own: start it again for this project (same session, no prompt). */
async function startEngine() {
  if (state.readOnly) return toast('Mode hanya-lihat: tidak bisa menyalakan OpenCode dari sini.', 'warn');
  const project = state.active;
  toast('Menyalakan OpenCode…', 'ok');
  try {
    await api(`/api/projects/${project}/engine-start`);
    toast('OpenCode dinyalakan lagi.', 'ok');
  } catch (err) {
    toast(err.message, 'warn');
  }
}

/** ✋ chip: the newest waiting permission card, scrolled into view with its first answer button focused. */
function jumpToApproval() {
  const card = [...document.querySelectorAll('#chat .approval.pending')].at(-1);
  if (!card) return;
  card.scrollIntoView({ block: 'center' });
  card.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

export function initStatusline() {
  if (narrow.matches) $('#todos').classList.add('collapsed'); // phone: folded by default, the user's toggle then sticks
  narrow.addEventListener('change', () => {
    const st = state.statuses[state.active] ?? {};
    $('#statusline').classList.remove('has-chips');
    renderTodos(st);
    renderStatusline(st);
  });

  $('#todos').addEventListener('click', (e) => {
    if (!e.target.closest('.todos-head')) return;
    $('#todos').classList.toggle('collapsed');
    renderTodos(state.statuses[state.active] ?? {});
  });

  $('#statusline').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-tasks]')) openTasks();
    else if (e.target.closest('[data-open-queue]')) openQueue();
    else if (e.target.closest('[data-jump-approval]')) jumpToApproval();
    else if (e.target.closest('[data-compact]')) openCompact();
    else if (e.target.closest('[data-engine-start]')) startEngine();
    else if (e.target.closest('[data-resync]')) {
      requestResync();
      toast('Menyegarkan sambungan…', 'ok');
    }
  });

  // While the page is visible, a stream that has gone quiet for three pings asks for a fresh snapshot by itself;
  // coming back from a long sleep (or another app) does the same instead of showing yesterday's screen.
  setInterval(() => {
    if (document.hidden || !connection.online) return;
    const st = state.statuses[state.active] ?? {};
    const p = turnProgress(state.chats[state.active] ?? [], { now: Date.now(), busy: Boolean(st.busy || st.cliBusy), background: runningCount(st) });
    if (staleText() || (p && !p.finished)) renderStatusline(st);
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && connection.online && staleText()) requestResync();
  });
}
