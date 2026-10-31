// Adhit Office web app: project picker, chat with Claude Code, approvals, live office.
import { renderMarkdown } from './markdown.js';
import { qrSvg } from './qr.js';
import { CAST, DEFAULT_NAMES, ROLE_ORDER, applyTeamNames, roleColor, roleName } from './office/cast.js';
import { Scene } from './office/scene.js';
import { avatarURL } from './office/sprites.js';
import { Stage, escapeHtml } from './office/stage.js';

const TOKEN = document.querySelector('meta[name="office-token"]').content;
const APP_NAME = 'Adhit Office';
const DEMO_ID = 'demo';
const $ = (sel) => document.querySelector(sel);

const state = {
  projects: [],
  statuses: {},
  chats: {},
  events: {},
  approvals: new Map(),
  active: null,
  search: '',
  tab: 'chat',
};
const scenes = new Map();
const stage = new Stage($('#stage'));

// ---------- api ----------

async function api(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Office-Token': TOKEN },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function toast(message, tone = 'error') {
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status'); // errors interrupt a screen reader, the rest wait
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 4000);
}

// ---------- scenes ----------

function sceneFor(id) {
  let scene = scenes.get(id);
  if (!scene) {
    scene = new Scene();
    for (const evt of state.events[id] ?? []) scene.handle(evt, false);
    if (state.statuses[id]) scene.setStatus(state.statuses[id]);
    for (const approval of state.approvals.values()) if (approval.project === id && approval.status === 'pending') scene.restorePending(approval);
    scenes.set(id, scene);
  }
  return scene;
}

// ---------- event stream ----------

function connect() {
  const source = new EventSource('/stream');
  const conn = $('#conn');
  source.addEventListener('open', () => {
    conn.textContent = 'terhubung';
    conn.className = 'pill ok';
  });
  source.addEventListener('error', () => {
    conn.textContent = 'server mati — jalankan start-office';
    conn.className = 'pill bad';
  });
  const on = (type, fn) => source.addEventListener(type, (msg) => fn(JSON.parse(msg.data)));

  on('config', (config) => {
    renderRoots(config);
    applyNames(config);
    if (!$('#phone-modal').hidden) {
      phone.pairing = null; // a device just paired (codes are single-use) or settings changed
      refreshPairing();
    }
  });
  on('snapshot', (snap) => {
    // Opened from a paired phone: laptop-only settings are hidden (the server refuses them anyway).
    state.local = snap.client?.local !== false;
    state.accountAuth = snap.client?.accountAuth ?? state.local; // laptop, or a phone over Tailscale
    document.body.classList.toggle('remote-client', !state.local);
    $('#btn-phone').hidden = !state.local;
    $('#btn-settings').hidden = !state.local;
    state.account = snap.account ?? null;
    renderRoots(snap.config);
    applyTeamNames(snap.config?.teamNames); // before the first render, so nothing shows the old names
    state.projects = snap.projects;
    state.statuses = snap.statuses;
    state.chats = snap.chats;
    state.events = snap.events;
    state.approvals = new Map(snap.approvals.map((a) => [a.id, a]));
    scenes.clear();
    const remembered = location.hash.slice(1) || localStorage.getItem('office.active');
    selectProject(state.projects.some((p) => p.id === remembered) ? remembered : DEMO_ID);
    renderAccountButton(); // after the core UI, so a profile quirk can never blank the office
  });
  on('account', onAccountState);
  on('account-alert', onAccountAlert);
  on('projects', (projects) => {
    state.projects = projects;
    renderSidebar();
  });
  on('status', (status) => {
    state.statuses[status.project] = status;
    scenes.get(status.project)?.setStatus(status);
    renderSidebar();
    if (status.project === state.active) renderComposer();
    updateTitle();
  });
  on('office', (evt) => {
    (state.events[evt.project] ??= []).push(evt);
    scenes.get(evt.project)?.handle(evt, true);
    if (evt.project === state.active) {
      appendActivity(evt, true);
      if (['tool_end', 'stop'].includes(evt.kind)) scheduleChanges();
    }
  });
  on('chat', (msg) => {
    (state.chats[msg.project] ??= []).push(msg);
    if (msg.project === state.active) appendChat(msg);
    if (msg.kind === 'result') {
      notify(msg.ok ? 'done' : 'error', msg.ok ? `✓ Tugas selesai — ${projectName(msg.project)}` : `■ Tugas berhenti — ${projectName(msg.project)}`, msg.ok ? 'Tim sudah menyelesaikan permintaanmu.' : msg.text || 'Cek chat untuk detailnya.', msg.project);
    } else if (msg.kind === 'error') {
      notify('error', `⚠ Ada kendala — ${projectName(msg.project)}`, msg.text.slice(0, 120), msg.project);
    }
    renderSidebar();
  });
  on('chat_update', ({ project, id, patch }) => {
    const msg = state.chats[project]?.findLast((m) => m.id === id);
    if (!msg) return;
    Object.assign(msg, patch);
    if (project === state.active) replaceChat(msg);
  });
  on('approval', (approval) => {
    if (approval.status === 'pending' && !state.approvals.has(approval.id)) {
      notify('ask', `✋ ${roleName(approval.role)} minta izin — ${projectName(approval.project)}`, approval.label, approval.project);
    }
    state.approvals.set(approval.id, approval);
    if (approval.project === state.active) {
      const msg = state.chats[approval.project]?.findLast((m) => m.approvalId === approval.id);
      if (msg) replaceChat(msg);
    }
    updateTitle();
    renderSidebar();
  });
}

// ---------- sidebar ----------

function projectRank(p) {
  const st = state.statuses[p.id] ?? {};
  if (p.id === DEMO_ID) return -1; // the demo sits at the bottom
  if (st.pending) return 3;
  if (st.busy || st.cliBusy) return 2;
  if (st.alive) return 1;
  return 0;
}

// ---------- dialogs ----------

function openModal(id) {
  $(`#${id}`).hidden = false;
}

function closeModal(id) {
  $(`#${id}`).hidden = true;
}

// ✕ buttons and clicks on the dimmed backdrop close the dialog.
document.querySelectorAll('.modal').forEach((modal) =>
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-close]')) modal.hidden = true;
  }),
);

// Focus follows the dialogs: into a dialog when it opens, back to where it was when the last one closes.
// Dialogs open and close from many places (openModal, Esc, backdrop, ✕, direct `hidden` writes),
// so this watches the `hidden` attribute instead of hooking each of them.
const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
const openModals = () => [...document.querySelectorAll('.modal')].filter((m) => !m.hidden);
const focusablesIn = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && !el.closest('[hidden]') && el.getClientRects().length);
let focusBeforeModal = null;
document.addEventListener('focusin', (e) => {
  if (!e.target.closest?.('.modal')) focusBeforeModal = e.target;
});
// Focus leaving to nowhere (iOS keyboard dismissed, Safari taps that don't focus buttons) forgets the origin,
// so closing a dialog never re-focuses a stale #prompt and pops the phone keyboard unasked.
document.addEventListener('focusout', (e) => {
  if (!e.relatedTarget && !e.target.closest?.('.modal')) focusBeforeModal = null;
});
// The origin may have been re-rendered while the dialog was open (team cards every 500ms): find its replacement.
function focusOrigin() {
  const el = focusBeforeModal;
  if (!el || el.isConnected) return el;
  if (el.dataset?.role) return document.querySelector(`#team .member[data-role="${CSS.escape(el.dataset.role)}"]`);
  if (el.dataset?.path) return [...document.querySelectorAll('#ch-files li[data-path]')].find((li) => li.dataset.path === el.dataset.path) ?? null;
  return null;
}
const modalObserver = new MutationObserver((records) => {
  const changed = new Map(); // modal -> was it hidden before this batch
  for (const r of records) if (!changed.has(r.target)) changed.set(r.target, r.oldValue !== null);
  for (const [modal, wasHidden] of changed) {
    if (wasHidden === modal.hidden) continue; // re-setting the same value (e.g. closing a closed dialog)
    const active = document.activeElement;
    if (!modal.hidden) {
      // A caller that already placed focus (project search, a team member's name field) wins.
      if (!modal.contains(active)) focusablesIn(modal)[0]?.focus({ preventScroll: true });
    } else if (!openModals().length && (!active || active === document.body || modal.contains(active))) {
      const origin = focusOrigin();
      if (origin?.getClientRects().length) origin.focus({ preventScroll: true });
    }
  }
});
document.querySelectorAll('.modal').forEach((modal) => modalObserver.observe(modal, { attributeFilter: ['hidden'], attributeOldValue: true }));

// Tab stays inside the topmost open dialog.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const modal = openModals().at(-1);
  if (!modal) return;
  const items = focusablesIn(modal);
  if (!items.length) return;
  const first = items[0];
  const last = items.at(-1);
  const active = document.activeElement;
  if (!modal.contains(active) || (e.shiftKey && active === first) || (!e.shiftKey && active === last)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
});

// ---------- project picker (Ctrl+K) ----------

const picker = { cursor: 0, visible: [] };

function renderSidebar() {
  const q = state.search.toLowerCase();
  const list = state.projects
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.path ?? '').toLowerCase().includes(q))
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || projectRank(b) - projectRank(a) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || Number(b.sources.includes('claude')) - Number(a.sources.includes('claude')) || a.name.localeCompare(b.name));
  picker.visible = list.map((p) => p.id);
  picker.cursor = Math.min(picker.cursor, Math.max(0, list.length - 1));
  const grouped = list.some((p) => p.favorite);
  $('#project-list').innerHTML = list
    .map((p, i) => {
      // Section titles only when there are favourites to separate from the rest.
      const head = !grouped ? '' : i === 0 ? '<li class="group">★ Favorit</li>' : !p.favorite && list[i - 1].favorite ? '<li class="group">Semua project</li>' : '';
      const star = p.id === DEMO_ID ? '' : `<button class="fav ${p.favorite ? 'on' : ''}" title="${p.favorite ? 'Hapus dari favorit' : 'Jadikan favorit (selalu di atas)'}" aria-pressed="${Boolean(p.favorite)}">${p.favorite ? '★' : '☆'}</button>`;
      const st = state.statuses[p.id] ?? {};
      const badge = st.pending
        ? `<span class="badge ask">${st.pending}</span>`
        : st.busy || st.cliBusy
          ? `${st.cliBusy ? '<span class="cli-tag">CLI</span>' : ''}<span class="spinner"></span>`
          : st.alive
            ? '<span class="dot live"></span>'
            : '';
      const icon = p.id === DEMO_ID ? '🎬' : p.sources.includes('claude') ? '✳' : '▢';
      return `${head}<li class="${p.id === state.active ? 'active' : ''} ${i === picker.cursor ? 'cursor' : ''}" data-id="${p.id}" title="${escapeHtml(p.path ?? 'Simulasi tanpa Claude Code')}">
        <span class="p-icon">${icon}</span>
        <span class="p-text"><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.path ? p.path.replace(/^.*\/projects\//, '…/') : 'simulasi')}</small></span>
        ${badge}
        ${star}
        ${p.sources.includes('custom') ? '<button class="forget" title="Hapus dari daftar" aria-label="Hapus dari daftar">×</button>' : ''}
      </li>`;
    })
    .join('');
  renderHeader();
}

function selectProject(id) {
  state.active = id;
  location.hash = id;
  localStorage.setItem('office.active', id);
  stage.setScene(sceneFor(id));
  renderSidebar();
  renderHeader();
  renderChat();
  renderActivity();
  renderComposer();
  closeModal('sessions-modal');
  closeSuggest();
  changes.selected = null;
  $('#ch-diff').innerHTML = '';
  loadChanges();
  closeModal('project-modal');
}

let crumbHtml = '';

function renderHeader() {
  const p = state.projects.find((x) => x.id === state.active);
  const icon = !p ? '📁' : p.id === DEMO_ID ? '🎬' : p.sources.includes('claude') ? '✳' : '📁';
  // The project list lives in a dialog, so the switcher itself tells you when another project needs you.
  const others = state.projects.filter((x) => x.id !== state.active).map((x) => state.statuses[x.id] ?? {});
  const waiting = others.reduce((n, st) => n + (st.pending ?? 0), 0);
  const working = others.filter((st) => st.busy || st.cliBusy).length;
  const badge = waiting
    ? `<span class="badge ask" title="${waiting} permintaan izin menunggu di project lain">${waiting}</span>`
    : working
      ? `<span class="crumb-busy" title="${working} project lain sedang bekerja"><span class="spinner"></span>${working}</span>`
      : '';
  const current = p
    ? `<span class="p-icon">${icon}</span><span class="crumb-text"><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.path ?? 'Demo — tidak menjalankan Claude Code')}</small></span>`
    : '<span class="crumb-text"><b>Pilih project</b></span>';
  const html = `${current}${badge}<kbd>Ctrl K</kbd><svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  // Runs on every status/chat event: only touch the DOM when something changed (keeps the spinner smooth).
  if (html !== crumbHtml) $('#crumb').innerHTML = crumbHtml = html;
}

function openProjects() {
  state.search = '';
  $('#project-search').value = '';
  picker.cursor = 0;
  renderSidebar();
  openModal('project-modal');
  $('#project-search').focus();
}

function moveCursor(delta) {
  if (!picker.visible.length) return;
  picker.cursor = (picker.cursor + delta + picker.visible.length) % picker.visible.length;
  renderSidebar();
  $('#project-list .cursor')?.scrollIntoView({ block: 'nearest' });
}

$('#crumb').addEventListener('click', openProjects);
$('#project-search').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveCursor(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const id = picker.visible[picker.cursor];
    if (id) selectProject(id);
  }
});
const isTyping = (el) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openProjects();
  } else if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
    e.preventDefault();
    openModal('help-modal');
  } else if (e.key === 'Escape') {
    // Esc closes the topmost menu/dialog first; only with nothing open does it stop a running turn.
    if (!$('#more-menu').hidden) {
      toggleMoreMenu(false);
      e.stopImmediatePropagation();
      return;
    }
    const open = [...document.querySelectorAll('.modal')].filter((m) => !m.hidden).at(-1);
    if (open) {
      open.hidden = true;
      e.stopImmediatePropagation();
    }
  }
}, true);

// Clickable non-buttons (file rows, tool rows, team cards, the session title) carry role="button":
// Enter/Space runs the same click handler a mouse would, through one delegated listener.
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target;
  if (!(el instanceof HTMLElement) || el.tagName === 'BUTTON' || el.getAttribute('role') !== 'button') return;
  e.preventDefault(); // Space would scroll the list
  el.click();
});

function updateTitle() {
  const pending = [...state.approvals.values()].filter((a) => a.status === 'pending').length;
  document.title = pending ? `(${pending}) Menunggu izin — ${APP_NAME}` : APP_NAME;
  const badge = $('#nav-badge-chat');
  badge.hidden = !pending;
  badge.textContent = pending;
}

// ---------- phone layout: bottom navigation between full-screen views ----------

function setMobileView(view) {
  document.body.dataset.view = view === 'office' ? 'office' : 'panel';
  if (view !== 'office') document.querySelector(`.tabs button[data-tab="${view}"]`)?.click();
  document.querySelectorAll('#mobile-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

$('#mobile-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) setMobileView(btn.dataset.view);
});

// A shorter hint fits a phone-width composer on one line.
const narrow = matchMedia('(max-width: 760px)');
const applyPlaceholder = () => {
  $('#prompt').placeholder = narrow.matches ? 'Ketik pesan…  ( / command · @file )' : 'Minta sesuatu ke tim…   ( / command · @file · ! shell · Shift+Enter baris baru )';
  $('#prompt').rows = narrow.matches ? 1 : 3;
  autosize();
};
// On a phone the composer starts at one line and grows with the text, like a chat app.
function autosize() {
  const input = $('#prompt');
  input.style.height = '';
  if (narrow.matches) input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}
$('#prompt').addEventListener('input', autosize);
narrow.addEventListener('change', applyPlaceholder);
applyPlaceholder();

// ---------- chat ----------

const chatEl = $('#chat');

// One click fills the composer with a ready-made request (still editable before sending).
const STARTERS = [
  ['🧭', 'Jelaskan project ini', 'Jelaskan struktur, teknologi, dan alur utama project ini secara singkat.'],
  ['🐞', 'Cari bug', 'Cari bug atau potensi masalah di project ini, urutkan dari yang paling berisiko, lalu usulkan perbaikannya.'],
  ['🧪', 'Tambah test', 'Tulis test untuk bagian penting yang belum punya test, lalu jalankan.'],
  ['🔍', 'Review perubahan', 'Review perubahan yang belum di-commit: cari bug, risiko keamanan, dan bagian yang bisa dirapikan.'],
];

function renderChat() {
  chatEl.innerHTML = '';
  const messages = state.chats[state.active] ?? [];
  if (!messages.length) {
    chatEl.innerHTML = state.active === DEMO_ID
      ? '<div class="empty"><div class="empty-icon">🎬</div><b>Demo kantor</b><p>Klik <b>▶ Jalankan demo</b> untuk melihat tim bekerja: delegasi, layar monitor, error, sampai minta izin. Demo tidak menjalankan Claude Code.</p></div>'
      : `<div class="empty">
          <div class="empty-icon">✳</div>
          <b>Mulai kerja di ${escapeHtml(projectName(state.active))}</b>
          <p>Claude Code berjalan langsung di folder project ini. Setiap aksi yang butuh izin muncul sebagai kartu di chat.</p>
          <div class="starters">${STARTERS.map(([icon, label, text]) => `<button data-starter="${escapeHtml(text)}"><span>${icon}</span>${label}</button>`).join('')}</div>
          <div class="empty-links"><button class="text-btn" data-open-history>🕘 Lanjutkan sesi sebelumnya</button><button class="text-btn" data-open-help>❓ Panduan &amp; shortcut</button></div>
        </div>`;
  }
  for (const msg of messages) appendChat(msg, false);
  if (messages.length) scrollChat(true);
  else {
    chatEl.scrollTop = 0; // the welcome card reads from the top
    $('#jump-latest').hidden = true;
  }
}

// Chat follows the newest message unless the user scrolls up to read; "↓ Terbaru" resumes following.
let followChat = true;
const distanceFromBottom = () => chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;

function scrollChat(force) {
  if (force) followChat = true;
  if (!followChat) {
    $('#jump-latest').hidden = false;
    return;
  }
  chatEl.scrollTop = chatEl.scrollHeight;
  // Again after layout settles (markdown, images, expanded details).
  requestAnimationFrame(() => followChat && (chatEl.scrollTop = chatEl.scrollHeight));
  $('#jump-latest').hidden = true;
}

// We only ever scroll to the very bottom, so a scroll that leaves the bottom is the user's.
chatEl.addEventListener('scroll', () => {
  followChat = distanceFromBottom() < 60;
  $('#jump-latest').hidden = followChat;
});

function appendChat(msg, scroll = true) {
  const welcome = chatEl.querySelector('.empty');
  welcome?.remove();
  const node = document.createElement('div');
  node.dataset.id = msg.id;
  fillChat(node, msg);
  chatEl.append(node);
  if (msg.kind === 'user') markLatestUser();
  // Your own prompt, anything waiting for your decision, and the first message always come into view.
  const mustSee = msg.kind === 'approval' || (msg.kind === 'user' && msg.source === 'web') || Boolean(welcome);
  if (scroll) scrollChat(mustSee);
}

function replaceChat(msg) {
  const node = chatEl.querySelector(`[data-id="${msg.id}"]`);
  if (!node) return;
  fillChat(node, msg);
  if (msg.kind === 'user') markLatestUser();
  scrollChat(msg.kind === 'approval' && msg.status === 'pending');
}

/** Puts text in the composer to edit before sending (starters, "Edit" on a sent prompt). */
function fillComposer(text) {
  if (narrow.matches) setMobileView('chat');
  const input = $('#prompt');
  input.value = text;
  input.focus();
  input.setSelectionRange(text.length, text.length);
  autosize();
  updateBashMode();
}

/** The Clipboard API needs a secure context; a phone on http://100.x… falls back to execCommand. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function flashButton(btn, text) {
  const label = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = label;
    btn.disabled = false;
  }, 1400);
}

/** Only the newest prompt offers "Ulangi", so an old one is never re-sent by a stray tap. */
function markLatestUser() {
  const users = chatEl.querySelectorAll('.msg.user');
  users.forEach((node, i) => node.classList.toggle('latest', i === users.length - 1));
}

chatEl.addEventListener('click', async (e) => {
  const starter = e.target.closest('[data-starter]');
  if (starter) return fillComposer(starter.dataset.starter);
  if (e.target.closest('[data-open-history]')) return openSessions();
  if (e.target.closest('[data-open-help]')) return openModal('help-modal');
  const codeBtn = e.target.closest('[data-copy-code]');
  if (codeBtn) return flashButton(codeBtn, (await copyText(codeBtn.closest('pre').querySelector('code').textContent)) ? '✓ Tersalin' : 'Gagal');
  const act = e.target.closest('[data-msg-act]');
  if (!act) return;
  const msg = state.chats[state.active]?.find((m) => m.id === act.closest('[data-id]')?.dataset.id);
  if (!msg) return;
  if (act.dataset.msgAct === 'copy') flashButton(act, (await copyText(msg.text)) ? '✓ Tersalin' : 'Gagal');
  else if (act.dataset.msgAct === 'edit') fillComposer(msg.text);
  else if (act.dataset.msgAct === 'resend') api(`/api/projects/${state.active}/prompt`, { text: msg.text }).catch((err) => toast(`Gagal mengirim: ${err.message}`));
});

// Tool/delegate rows the user has expanded stay open across live updates.
const expanded = new Set();
chatEl.addEventListener('click', (e) => {
  const head = e.target.closest('.expandable > .row');
  if (!head) return;
  const node = head.parentElement;
  const id = node.dataset.id;
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  const msg = state.chats[state.active]?.find((m) => m.id === id);
  if (!msg) return;
  // Reading a tool's detail is a deliberate look back: pause following and keep the row in view.
  if (expanded.has(id) && node !== chatEl.lastElementChild) followChat = false;
  fillChat(node, msg);
});

const fmtTokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

function diffBlock(oldText, newText) {
  const lines = (text, sign) => String(text ?? '').split('\n').map((l) => `<span class="${sign === '-' ? 'del' : 'add'}">${sign} ${escapeHtml(l)}</span>`).join('\n');
  return `<pre class="diff">${oldText ? `${lines(oldText, '-')}\n` : ''}${lines(newText, '+')}</pre>`;
}

/** Expanded body of a tool row: what was asked (command, diff, query…) and what came back. */
function toolDetail(msg) {
  const input = msg.input ?? {};
  const parts = [];
  if (input.file) parts.push(`<div class="kv"><span>file</span><code>${escapeHtml(input.file)}</code>${input.range ? ` <small>${escapeHtml(input.range)}</small>` : ''}</div>`);
  if (input.command) parts.push(`<pre class="cmd">$ ${escapeHtml(input.command)}</pre>${input.description ? `<div class="muted">${escapeHtml(input.description)}</div>` : ''}`);
  if (input.old != null || input.new != null) parts.push(diffBlock(input.old, input.new));
  if (input.edits) for (const edit of input.edits) parts.push(diffBlock(edit.old, edit.new));
  if (input.content != null) parts.push(diffBlock('', input.content));
  for (const key of ['pattern', 'path', 'glob', 'query', 'url', 'prompt']) {
    if (input[key] && !(msg.kind === 'delegate' && key === 'prompt')) parts.push(`<div class="kv"><span>${key}</span><code>${escapeHtml(input[key])}</code></div>`);
  }
  if (input.todos) parts.push(`<ul class="todos">${input.todos.map((t) => `<li class="st-${t.status}">${t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '▶' : '○'} ${escapeHtml(t.content)}</li>`).join('')}</ul>`);
  if (input.json) parts.push(`<pre>${escapeHtml(input.json)}</pre>`);
  if (msg.kind === 'delegate' && input.prompt) parts.push(`<div class="label">Instruksi dari ${escapeHtml(roleName(msg.from ?? 'claude'))}</div><div class="md sub">${renderMarkdown(input.prompt)}</div>`);
  if (msg.output) {
    parts.push(msg.kind === 'delegate'
      ? `<div class="label">Laporan ${escapeHtml(roleName(msg.role))}</div><div class="md sub">${renderMarkdown(msg.output)}</div>`
      : `<div class="label">${msg.status === 'fail' ? 'Error' : 'Output'}</div><pre class="out ${msg.status === 'fail' ? 'fail' : ''}">${escapeHtml(msg.output)}</pre>`);
  } else if (msg.status === 'running') parts.push('<div class="muted">Sedang berjalan…</div>');
  return parts.join('') || '<div class="muted">Tidak ada detail.</div>';
}

const STATUS_ICON = { running: '<span class="spinner"></span>', ok: '<span class="ok">✓</span>', fail: '<span class="fail">✗</span>', cancel: '<span class="muted">–</span>' };
const time = (ts) => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

function who(role) {
  const look = CAST[role]?.look ?? CAST.claude.look;
  return `<img class="ava" src="${avatarURL(look)}" alt=""><b style="color:${roleColor(role)}">${roleName(role)}</b>`;
}

function fillChat(node, msg) {
  // Re-rendering replaces the row: keep keyboard focus on it (toggle via Enter, live status updates).
  const refocusRow = node.contains(document.activeElement) && document.activeElement.classList.contains('row');
  fillChatBody(node, msg);
  if (refocusRow) node.querySelector(':scope > .row')?.focus({ preventScroll: true });
}

function fillChatBody(node, msg) {
  switch (msg.kind) {
    case 'user': {
      const tags = [
        msg.source === 'demo' ? 'demo' : '',
        msg.source === 'cli' ? 'dari terminal' : '',
        msg.history ? 'riwayat' : '',
        msg.images ? `🖼 ${msg.images} gambar` : '',
        msg.queued ? 'antre' : '',
        msg.cancelled ? 'dibatalkan' : '',
      ].filter(Boolean);
      // Re-sending a prompt typed in the terminal would run it in the web session, so only web prompts offer it.
      const actions = msg.source === 'demo'
        ? ''
        : `<span class="msg-actions"><button data-msg-act="copy" title="Salin teks prompt">Salin</button><button data-msg-act="edit" title="Salin ke kotak pesan untuk diedit lalu dikirim">Edit</button>${msg.source === 'cli' ? '' : '<button class="resend" data-msg-act="resend" title="Kirim prompt ini sekali lagi">↻ Ulangi</button>'}</span>`;
      node.className = `msg user ${msg.source === 'cli' ? 'cli' : ''} ${msg.history ? 'history' : ''}`;
      node.innerHTML = `<div class="body">${escapeHtml(msg.text).replace(/\n/g, '<br>')}</div><div class="meta">${actions}${tags.map((t) => `<span class="tag">${t}</span>`).join('')}${time(msg.ts)}</div>`;
      break;
    }
    case 'assistant':
      if (!msg.text && !msg.streaming) {
        node.className = 'hidden-msg';
        node.innerHTML = '';
        break;
      }
      node.className = `msg assistant ${msg.streaming ? 'streaming' : ''} ${msg.history ? 'history' : ''}`;
      node.innerHTML = `<div class="who">${who('claude')}${msg.source === 'cli' ? '<span class="cli-tag">CLI</span>' : ''}${msg.history ? '<span class="tag">riwayat</span>' : ''}<span>${time(msg.ts)}</span>${msg.streaming ? '' : '<button class="msg-copy" data-msg-act="copy" title="Salin jawaban (Markdown)">Salin</button>'}</div><div class="body md">${renderMarkdown(msg.text)}</div>`;
      break;
    case 'tool': {
      const open = expanded.has(msg.id);
      node.className = `line tool expandable st-${msg.status} ${open ? 'open' : ''} ${msg.sub ? 'sub' : ''}`;
      node.innerHTML = `<div class="row" role="button" tabindex="0" aria-expanded="${open}" title="Klik untuk detail"><span class="chev">${open ? '▾' : '▸'}</span><span class="dot" style="background:${roleColor(msg.role)}"></span><span class="who-s" title="${escapeHtml(roleName(msg.role))}">${escapeHtml(roleName(msg.role))}</span><span class="txt">${escapeHtml(msg.text)}</span>${elapsedTag(msg)}${STATUS_ICON[msg.status] ?? ''}</div>${open ? `<div class="detail">${toolDetail(msg)}</div>` : ''}`;
      break;
    }
    case 'delegate': {
      const open = expanded.has(msg.id);
      node.className = `line delegate expandable st-${msg.status} ${open ? 'open' : ''}`;
      node.innerHTML = `<div class="row" role="button" tabindex="0" aria-expanded="${open}" title="Klik untuk instruksi & laporan"><span class="chev">${open ? '▾' : '▸'}</span><img class="ava sm" src="${avatarURL(CAST[msg.role]?.look ?? CAST.claude.look)}" alt=""><span class="txt"><b style="color:${roleColor(msg.role)}">${roleName(msg.role)}</b> ditugaskan${msg.from && msg.from !== 'claude' ? ` oleh ${escapeHtml(roleName(msg.from))}` : ''}: ${escapeHtml(msg.text)}</span>${elapsedTag(msg)}${STATUS_ICON[msg.status] ?? ''}</div>${open ? `<div class="detail">${toolDetail(msg)}</div>` : ''}`;
      break;
    }
    case 'thinking': {
      // Collapsed like the CLI's "✻ Thinking…"; streams while open.
      const open = expanded.has(msg.id);
      node.className = `line thinking expandable ${open ? 'open' : ''} ${msg.streaming ? 'streaming' : ''}`;
      const preview = String(msg.text ?? '').replace(/\s+/g, ' ').trim();
      node.innerHTML = `<div class="row" role="button" tabindex="0" aria-expanded="${open}" title="Klik untuk lihat proses berpikir"><span class="chev">${open ? '▾' : '▸'}</span><span class="think-ico">✻</span><span class="txt">${msg.streaming ? 'Berpikir…' : 'Berpikir'} <i>${escapeHtml(msg.streaming ? preview.slice(-200) : preview.slice(0, 200))}</i></span>${msg.streaming ? STATUS_ICON.running : ''}</div>${open ? `<div class="detail"><div class="md sub">${renderMarkdown(msg.text || '…')}</div></div>` : ''}`;
      break;
    }
    case 'shell': {
      // `!command` (bash mode): command and output always visible, like the CLI.
      node.className = `line shell st-${msg.status}`;
      const exit = msg.status === 'fail' && msg.exitCode != null ? ` <small>exit ${msg.exitCode}</small>` : '';
      node.innerHTML = `<div class="row"><span class="bang">!</span><span class="txt">${escapeHtml(msg.text)}</span>${exit}${STATUS_ICON[msg.status] ?? ''}</div>${msg.output ? `<pre class="out ${msg.status === 'fail' ? 'fail' : ''}">${escapeHtml(msg.output)}</pre>` : ''}`;
      break;
    }
    case 'approval':
      fillApproval(node, msg);
      break;
    case 'result': {
      const m = msg.meta ?? {};
      const parts = [
        m.durationMs ? `${Math.round(m.durationMs / 1000)} dtk` : '',
        m.turns ? `${m.turns} langkah` : '',
        m.tokensIn ? `konteks ${fmtTokens(m.tokensIn)}` : '',
        m.tokensOut ? `output ${fmtTokens(m.tokensOut)} token` : '',
        m.denials ? `${m.denials} ditolak` : '',
      ].filter(Boolean);
      node.className = `result ${msg.ok ? 'ok' : 'fail'}`;
      node.innerHTML = msg.ok ? `✓ Selesai · ${parts.join(' · ')}` : `■ Berhenti${msg.text ? `: ${escapeHtml(msg.text)}` : ''}`;
      break;
    }
    case 'error':
      node.className = 'msg error';
      node.innerHTML = `<div class="body md">${renderMarkdown(msg.text)}</div>`;
      break;
    case 'divider':
      node.className = 'divider';
      node.innerHTML = `<span>${escapeHtml(msg.text)}</span>`;
      break;
    default:
      node.className = `info ${msg.level ?? ''}`; // warning / notice from Claude Code (retries, fallbacks…)
      node.textContent = msg.text;
  }
  // Rewound: no longer part of the conversation Claude sees, still readable.
  if (msg.rewound) node.classList.add('rewound');
}

/** "Running… (12s)" on a long tool call, as the CLI shows it. */
const elapsedTag = (msg) => (msg.status === 'running' && msg.elapsed ? `<small class="elapsed">${msg.elapsed >= 60 ? `${Math.floor(msg.elapsed / 60)} mnt ${msg.elapsed % 60} dtk` : `${msg.elapsed} dtk`}</small>` : '');

// ---------- approvals ----------

function fillApproval(node, msg) {
  const approval = state.approvals.get(msg.approvalId);
  const status = approval?.status ?? msg.status;
  node.className = `approval ${status}`;
  const head = `<div class="ap-head">${who(msg.role)}<span>minta izin · ${escapeHtml(approval?.tool ?? '')}</span></div>`;
  if (status !== 'pending' || !approval) {
    const label = { allowed: '✓ Diizinkan', denied: '✗ Ditolak', cancelled: '– Dibatalkan', pending: '… Menunggu' }[status] ?? status;
    node.innerHTML = `${head}<div class="ap-label">${escapeHtml(msg.text)}</div><div class="ap-status">${label}</div>`;
    return;
  }
  const input = approval.input ?? {};
  let body = '';
  let actions = '';
  if (approval.kind === 'question') {
    // Every question also takes a typed answer, like the CLI's "Other" option.
    body = (input.questions ?? [])
      .map((q, qi) => `<div class="q"><b>${escapeHtml(q.question)}</b><div class="opts">${(q.options ?? [])
        .map((o) => `<label><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q${qi}" value="${escapeHtml(o.label)}"> <span><b>${escapeHtml(o.label)}</b>${o.description ? ` — ${escapeHtml(o.description)}` : ''}</span></label>`)
        .join('')}</div><input class="other-text" data-q="${qi}" placeholder="Atau tulis jawaban sendiri…" aria-label="Jawaban sendiri"></div>`)
      .join('');
    actions = '<button class="primary" data-act="answer">Kirim jawaban</button><button data-act="deny">Lewati</button>';
  } else if (approval.kind === 'plan') {
    // The CLI's plan dialog: approve and choose how edits are handled, or keep planning with feedback.
    body = `<div class="plan md">${renderMarkdown(input.plan ?? '')}</div><input class="feedback" placeholder="Catatan revisi (untuk Minta revisi)" aria-label="Catatan revisi rencana">`;
    actions =
      '<button class="primary" data-act="allow" data-mode="acceptEdits" title="Mode berubah ke ✏️ Auto-edit file">✓ Setujui, auto-edit</button><button data-act="allow" data-mode="manual" title="Mode berubah ke 🛡️ Tanya dulu">✓ Setujui, tanya tiap edit</button><button data-act="deny">Minta revisi</button>';
  } else {
    if (input.command) body = `<pre>${escapeHtml(input.command)}</pre>${input.description ? `<p class="muted">${escapeHtml(input.description)}</p>` : ''}`;
    else if (input.content != null) body = `<p class="path">${escapeHtml(input.file_path)}</p><pre>${escapeHtml(input.content)}</pre>`;
    else if (input.old_string != null) body = `<p class="path">${escapeHtml(input.file_path)}</p><pre class="del">${escapeHtml(input.old_string)}</pre><pre class="add">${escapeHtml(input.new_string)}</pre>`;
    else if (input.url) body = `<pre>${escapeHtml(input.url)}</pre>`;
    else body = `<pre>${escapeHtml(input.json ?? JSON.stringify(input, null, 2))}</pre>`;
    // "No, and tell Claude what to do differently": the note goes back to Claude with the refusal.
    body += '<input class="feedback" placeholder="Kalau menolak: beri tahu Claude harus bagaimana (opsional)" aria-label="Alasan menolak (opsional)">';
    actions = `<button class="primary" data-act="allow">Izinkan</button>${approval.canAlways ? '<button data-act="always" title="Simpan aturan izin agar tidak ditanya lagi">Izinkan selalu</button>' : ''}<button data-act="all" title="Semua aksi berikutnya di sesi ini otomatis diizinkan">Izinkan semua (sesi ini)</button><button class="danger" data-act="deny">Tolak</button>`;
  }
  node.innerHTML = `${head}<div class="ap-label">${escapeHtml(approval.description || msg.text)}</div>${body}<div class="ap-actions">${actions}</div>`;
  node.querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', () => decide(approval, btn.dataset.act, node, btn.dataset.mode)),
  );
}

async function decide(approval, act, node, mode) {
  const body = { allow: act !== 'deny' };
  if (act === 'always') body.always = true;
  if (act === 'all') body.allowAll = true;
  if (mode) body.mode = mode; // plan approved: the mode the work continues in
  if (act === 'deny') body.message = node.querySelector('.feedback')?.value || undefined;
  if (act === 'answer') {
    const answers = {};
    (approval.input.questions ?? []).forEach((q, qi) => {
      const picked = [...node.querySelectorAll(`input[name="q${qi}"]:checked`)].map((i) => i.value);
      const own = node.querySelector(`.other-text[data-q="${qi}"]`)?.value.trim();
      // A typed answer replaces a single choice and joins multiple ones.
      if (own) picked.splice(0, q.multiSelect ? 0 : picked.length, own);
      if (picked.length) answers[q.question] = picked.join(', ');
    });
    body.answers = answers;
  }
  node.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    await api(`/api/approvals/${approval.id}`, body);
  } catch (err) {
    toast(`Gagal mengirim keputusan: ${err.message}`);
    node.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

// ---------- activity ----------

const KIND_ICON = { prompt: '💬', delegate: '➜', agent_stop: '✓', tool_start: '•', tool_fail: '✗', ask: '✋', ask_done: '👍', stop: '🎉', error: '⚠', say: '💭', tests: '🧪', huddle: '🗣' };

/** "dari Adhit - Tech Lead " when a specialist (not the lead) handed the work over. */
const fromPrefix = (from) => (from && from !== 'claude' ? `dari ${roleName(from)} ` : '');

function appendActivity(evt, prepend) {
  if (!KIND_ICON[evt.kind]) return;
  const li = document.createElement('li');
  li.className = `k-${evt.kind}`;
  const text = evt.kind === 'delegate' ? `${fromPrefix(evt.from)}→ ${evt.agentType}: ${evt.label}` : evt.kind === 'say' ? evt.text : evt.label ?? '';
  li.innerHTML = `<time>${time(evt.ts)}</time><span class="dot" style="background:${roleColor(evt.role)}"></span><span><b>${roleName(evt.role)}</b> ${KIND_ICON[evt.kind]} ${escapeHtml(text)}</span>`;
  const list = $('#activity');
  list.querySelector('.activity-empty')?.remove();
  if (prepend) list.prepend(li);
  else list.append(li);
  while (list.children.length > 200) list.lastElementChild.remove();
}

function renderActivity() {
  const list = $('#activity');
  list.innerHTML = '';
  for (const evt of [...(state.events[state.active] ?? [])].reverse()) appendActivity(evt, false);
  if (!list.children.length) list.innerHTML = '<li class="activity-empty">Belum ada aktivitas di project ini.</li>';
}

// ---------- team strip ----------

let teamHtml = '';

function renderTeam() {
  const scene = scenes.get(state.active);
  if (!scene) return;
  const now = performance.now();
  const html = ROLE_ORDER.map((id) => {
    const p = scene.people[id];
    const [cls, text] = p.asking
      ? ['ask', 'Menunggu izinmu']
      : now < p.flashUntil
        ? ['err', 'Ketemu error']
        : p.isBusy(now)
          ? ['work', `${p.seated ? 'Bekerja' : 'Menuju meja'}${p.agentCount > 1 ? ` (${p.agentCount} tugas paralel)` : ''}`]
          : p.onSofa || p.x > 440
            ? ['idle', 'Istirahat ☕']
            : p.plan.length
              ? ['idle', 'Jalan-jalan']
              : ['idle', 'Standby'];
    const tip = `${CAST[id].name} — ${CAST[id].title}\n${text}${p.task ? `\n${p.task}` : ''}\n(klik untuk ganti nama)`;
    return `<div class="member ${cls}" data-role="${id}" role="button" tabindex="0" style="--c:${CAST[id].color}" title="${escapeHtml(tip)}">
      <img src="${avatarURL(CAST[id].look)}" alt="">
      <div><b>${escapeHtml(CAST[id].name)}</b><small>${CAST[id].title}</small><span class="st">${p.task && cls !== 'idle' ? escapeHtml(p.task) : text}</span></div>
    </div>`;
  }).join('');
  // Runs every 500 ms: only touch the DOM on a change, and keep keyboard focus on the same card.
  if (html === teamHtml) return;
  const focused = document.activeElement?.closest?.('#team .member')?.dataset.role;
  $('#team').innerHTML = teamHtml = html;
  if (focused) $(`#team .member[data-role="${focused}"]`)?.focus({ preventScroll: true });
}

// ---------- team names (rename the people in the office) ----------

/** New names from the server: everything that prints a name is redrawn. */
function applyNames(config) {
  if (!applyTeamNames(config?.teamNames)) return;
  renderChat();
  renderActivity();
  renderTeam();
  if (!$('#team-modal').hidden) renderTeamForm();
}

function renderTeamForm() {
  $('#team-list').innerHTML = ROLE_ORDER.map((id) => `<label class="team-row">
      <img src="${avatarURL(CAST[id].look)}" alt="">
      <span class="team-role"><b style="color:${CAST[id].color}">${CAST[id].title}</b><small>bawaan: ${escapeHtml(DEFAULT_NAMES[id])}</small></span>
      <input name="${id}" value="${escapeHtml(CAST[id].name === DEFAULT_NAMES[id] ? '' : CAST[id].name)}" placeholder="${escapeHtml(DEFAULT_NAMES[id])}" maxlength="24" autocomplete="off" />
    </label>`).join('');
}

function openTeam(focusRole) {
  renderTeamForm();
  openModal('team-modal'); // visible first: a hidden input cannot take focus
  if (focusRole) $(`#team-list input[name="${focusRole}"]`)?.focus();
}

$('#team').addEventListener('click', (e) => {
  const card = e.target.closest('.member[data-role]');
  if (card) openTeam(card.dataset.role);
});
$('#btn-team-names').addEventListener('click', () => {
  closeModal('settings-modal');
  openTeam();
});
$('#team-reset').addEventListener('click', () => $('#team-list').querySelectorAll('input').forEach((input) => (input.value = '')));
$('#team-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const names = Object.fromEntries([...$('#team-list').querySelectorAll('input')].map((input) => [input.name, input.value.trim()]));
  try {
    await api('/api/team', { names });
    closeModal('team-modal');
    toast('Nama tim disimpan.', 'ok');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- composer ----------

function renderComposer() {
  const isDemo = state.active === DEMO_ID;
  const st = state.statuses[state.active] ?? {};
  $('#composer').classList.toggle('demo', isDemo);
  $('#btn-stop').hidden = isDemo || !(st.busy || st.queue);
  $('#mode').value = st.mode ?? 'manual';
  renderModelOptions(st.model ?? '');
  $('#effort').value = st.effort ?? '';
  $('#team-mode').checked = st.team ?? true;
  const hint = [];
  // As in the CLI, a message sent mid-turn reaches Claude at its next step instead of waiting for the end.
  if (st.busy) hint.push(st.queue ? `Tim sedang bekerja — ${st.queue} pesan antre, dibaca Claude di langkah berikutnya.` : 'Tim sedang bekerja — pesan baru dibaca Claude di langkah berikutnya.');
  if (st.cliBusy) hint.push('Sesi di terminal sedang berjalan (izinnya dijawab di terminal).');
  if (st.autoApprove) hint.push('⚠ Semua izin otomatis di sesi ini.');
  $('#composer-hint').textContent = hint.join('  ·  ');
  $('#typing').hidden = !(st.busy || st.cliBusy || st.compacting);
  $('#typing-text').textContent = st.compacting ? '✻ Memadatkan konteks percakapan…' : st.busy ? 'Tim sedang bekerja…' : 'Claude Code (terminal) sedang bekerja…';
  renderTodos(st);
  renderStatusline(st);
  renderSessionBar();
  if (!$('#tasks-modal').hidden && tasksView.project === state.active) renderTasks();
}

$('#sb-title').addEventListener('click', async () => {
  const st = state.statuses[state.active] ?? {};
  if (!st.sessionId || state.active === DEMO_ID) return;
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

/** Claude's todo list, pinned above the composer while there is work left (CLI: ☐ ◼ ☒). */
function renderTodos(st) {
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
  box.innerHTML = `<button class="todos-head" type="button" title="Sembunyikan / tampilkan daftar tugas">${collapsed ? '▸' : '▾'} Daftar tugas <small>${done}/${todos.length}</small></button>${
    collapsed
      ? ''
      : `<ul>${todos
          .map((t) => `<li class="st-${t.status}"><span>${mark[t.status] ?? '☐'}</span>${escapeHtml(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}</li>`)
          .join('')}</ul>`
  }`;
}
$('#todos').addEventListener('click', (e) => {
  if (!e.target.closest('.todos-head')) return;
  $('#todos').classList.toggle('collapsed');
  renderTodos(state.statuses[state.active] ?? {});
});

const MODE_LABEL = { manual: '🛡️ tanya dulu', acceptEdits: '✏️ auto-edit file', plan: '📋 rencana dulu', auto: '⚡ auto', dontAsk: '🚫 jangan tanya' };
const MODE_CYCLE = ['manual', 'acceptEdits', 'plan', 'auto']; // Shift+Tab order, as in the CLI

/** Status line under the composer: permission mode, model, and how full the context is. */
function renderStatusline(st) {
  const line = $('#statusline');
  if (state.active === DEMO_ID) {
    line.innerHTML = '';
    return;
  }
  const parts = [`<span class="sl-mode" title="Ganti dengan Shift+Tab">${MODE_LABEL[st.mode ?? 'manual']} <kbd>⇧Tab</kbd></span>`];
  const model = st.activeModel || st.model;
  if (model) parts.push(`<span>${escapeHtml(model)}</span>`);
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
  const running = (st.tasks ?? []).filter((t) => t.status === 'running' && t.background).length;
  if (running) parts.push(`<button type="button" class="sl-tasks" data-open-tasks title="Lihat tugas latar (/tasks)">⧗ ${running} tugas latar</button>`);
  line.innerHTML = parts.join('<span class="sep">·</span>');
}
$('#statusline').addEventListener('click', (e) => {
  if (e.target.closest('[data-open-tasks]')) openTasks();
});

/** The /model picker: the models Claude Code itself offers for this account (Fable, Opus, Sonnet…). */
function renderModelOptions(current) {
  const select = $('#model');
  const models = state.config?.models ?? [];
  if (models.length) {
    const def = models.find((m) => m.value === 'default');
    const opts = [`<option value="" title="${escapeHtml(def?.description ?? '')}">Default${def ? ` (${escapeHtml(def.description.split('·')[0].trim())})` : ''}</option>`];
    for (const m of models) if (m.value !== 'default') opts.push(`<option value="${escapeHtml(m.value)}" title="${escapeHtml(m.description)}">${escapeHtml(m.displayName)}</option>`);
    // A model set with /model that the picker doesn't list (e.g. opus[1m] or a full id) stays selectable.
    if (current && !models.some((m) => m.value === current)) opts.push(`<option value="${escapeHtml(current)}">${escapeHtml(current)}</option>`);
    const html = opts.join('');
    if (select.dataset.html !== html) {
      select.innerHTML = html;
      select.dataset.html = html;
    }
  }
  select.value = current;
  // Effort only for models that support it (as the CLI greys it out).
  const chosen = models.find((m) => m.value === (current || 'default'));
  const noEffort = Boolean(chosen && !chosen.efforts?.length);
  $('#effort').disabled = noEffort;
  $('#effort').title = noEffort ? 'Model ini tidak mendukung pengaturan effort' : '';
}

function cycleMode() {
  const select = $('#mode');
  select.value = MODE_CYCLE[(MODE_CYCLE.indexOf(select.value) + 1) % MODE_CYCLE.length];
  saveSettings();
}

// Commands this app runs itself: in headless mode Claude Code can't open its terminal dialogs
// (/resume, /rewind, /mcp, /tasks…), and /clear /model /effort must also move the app's own controls.
// Everything else (/usage, /context, /compact, /rename, skills…) goes to Claude Code and prints its output.
const LOCAL_COMMANDS = [
  { name: 'clear', description: 'Mulai percakapan baru (sesi baru)' },
  { name: 'model', argumentHint: '<model>', description: 'Ganti model, misalnya /model fable, /model opus[1m], /model default' },
  { name: 'effort', argumentHint: '<low|medium|high|xhigh|max|default>', description: 'Ganti effort (seberapa dalam Claude berpikir)' },
  { name: 'resume', description: 'Lanjutkan sesi Claude Code sebelumnya' },
  { name: 'rewind', description: 'Kembalikan kode dan/atau percakapan ke sebelum salah satu pesanmu (Esc Esc)' },
  { name: 'mcp', description: 'Server MCP: status, sambungkan ulang, aktif/nonaktif, login' },
  { name: 'tasks', description: 'Tugas latar: perintah & agent yang berjalan, output-nya, hentikan' },
  { name: 'memory', description: 'Buka CLAUDE.md project di VS Code' },
  { name: 'help', description: 'Panduan & shortcut keyboard' },
];

/** Returns true when `text` was one of LOCAL_COMMANDS (handled here, not sent to Claude). */
function localCommand(text) {
  const [, name, arg = ''] = text.match(/^\/([\w-]+)\s*(.*)$/s) ?? [];
  const value = arg.trim();
  const pick = (select, label, allowCustom) => {
    if (!value) {
      // No argument: show the picker, like the CLI's /model dialog.
      $(select).focus();
      $(select).showPicker?.();
      return;
    }
    const options = [...$(select).options].map((o) => o.value);
    const wanted = value.toLowerCase() === 'default' ? '' : value;
    if (!options.includes(wanted) && !allowCustom) return toast(`${label} "${value}" tidak dikenal. Pilihan: ${options.map((o) => o || 'default').join(', ')}`);
    if (!options.includes(wanted)) $(select).append(new Option(wanted, wanted)); // an alias or full id; the server checks it
    $(select).value = wanted;
    saveSettings();
  };
  switch (name) {
    case 'clear':
    case 'new':
    case 'reset':
      if (confirmNew()) api(`/api/projects/${state.active}/reset`).catch((err) => toast(err.message));
      return true;
    case 'model':
      pick('#model', 'Model', true);
      return true;
    case 'effort':
      pick('#effort', 'Effort', false);
      return true;
    case 'resume':
      openSessions();
      return true;
    case 'rewind':
    case 'checkpoint':
      openRewind();
      return true;
    case 'mcp':
      openMcp();
      return true;
    case 'tasks':
    case 'bashes':
      openTasks();
      return true;
    case 'memory':
      if (!state.local) toast('CLAUDE.md hanya bisa dibuka dari laptop.');
      else api(`/api/projects/${state.active}/open`, { app: 'code', file: 'CLAUDE.md' }).catch((err) => toast(err.message));
      return true;
    case 'help':
      openModal('help-modal');
      return true;
    default:
      return false;
  }
}

async function sendPrompt() {
  const input = $('#prompt');
  const text = input.value.trim();
  if ((!text && !attachments.length) || state.active === DEMO_ID) return;
  if (!attachments.length && (localCommand(text) || text.startsWith('!'))) {
    input.value = '';
    recall.index = -1;
    autosize();
    closeSuggest();
    updateBashMode();
    if (text.startsWith('!') && text.slice(1).trim()) {
      api(`/api/projects/${state.active}/shell`, { command: text.slice(1).trim() }).catch((err) => {
        input.value = text;
        updateBashMode();
        toast(`Gagal menjalankan: ${err.message}`);
      });
    }
    return;
  }
  const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  input.value = '';
  recall.index = -1;
  autosize();
  clearAttachments();
  closeSuggest();
  try {
    await api(`/api/projects/${state.active}/prompt`, { text, images });
  } catch (err) {
    input.value = text;
    toast(`Gagal mengirim: ${err.message}`);
  }
}

// ---------- image attachments (paste, drop, 📎) ----------

let attachments = [];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function renderAttachments() {
  const box = $('#attachments');
  box.hidden = !attachments.length;
  box.innerHTML = attachments
    .map((a, i) => `<div class="thumb"><img src="${a.url}" alt=""><button data-i="${i}" title="Hapus" aria-label="Hapus gambar ${i + 1}">×</button></div>`)
    .join('');
}

function clearAttachments() {
  attachments = [];
  renderAttachments();
}

function addImageFiles(files) {
  for (const file of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      toast('Hanya gambar PNG, JPEG, GIF, atau WebP.');
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast(`${file.name || 'Gambar'} lebih dari 5 MB.`);
      continue;
    }
    if (attachments.length >= 5) {
      toast('Maksimal 5 gambar per pesan.');
      break;
    }
    const reader = new FileReader();
    reader.onload = () => {
      attachments.push({ mediaType: file.type, data: String(reader.result).split(',')[1], url: reader.result });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
}

$('#attachments').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-i]');
  if (!btn) return;
  attachments.splice(Number(btn.dataset.i), 1);
  renderAttachments();
});
$('#btn-attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  addImageFiles([...e.target.files]);
  e.target.value = '';
});
$('#prompt').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    addImageFiles(files);
  }
});
const inputBox = document.querySelector('.input');
inputBox.addEventListener('dragover', (e) => {
  e.preventDefault();
  inputBox.classList.add('drop');
});
inputBox.addEventListener('dragleave', () => inputBox.classList.remove('drop'));
inputBox.addEventListener('drop', (e) => {
  e.preventDefault();
  inputBox.classList.remove('drop');
  addImageFiles([...e.dataTransfer.files]);
});

// ---------- autocomplete: /commands and @files ----------

const suggest = { items: [], index: 0, kind: null, start: 0, end: 0, timer: null, seq: 0 };

function closeSuggest() {
  suggest.items = [];
  suggest.kind = null;
  $('#suggest').hidden = true;
}

function showSuggest(kind, items, start, end) {
  suggest.kind = kind;
  suggest.items = items;
  suggest.index = 0;
  suggest.start = start;
  suggest.end = end;
  renderSuggest();
}

function renderSuggest() {
  const box = $('#suggest');
  if (!suggest.items.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const row = (item) => {
    if (suggest.kind === 'slash') {
      return `<b>/${escapeHtml(item.name)}</b>${item.argumentHint ? ` <span class="arg">${escapeHtml(item.argumentHint)}</span>` : ''}${item.description ? `<small>${escapeHtml(item.description)}</small>` : ''}`;
    }
    if (suggest.kind === 'history') return `<span class="at">↺</span> ${escapeHtml(item.replace(/\s+/g, ' '))}`;
    return `<span class="at">@</span>${escapeHtml(item)}`;
  };
  box.classList.toggle('described', suggest.kind === 'slash');
  box.innerHTML = suggest.items.map((item, i) => `<div class="opt ${i === suggest.index ? 'active' : ''}" data-i="${i}">${row(item)}</div>`).join('');
  box.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function applySuggest(i = suggest.index) {
  const input = $('#prompt');
  const item = suggest.items[i];
  if (item == null) return;
  if (suggest.kind === 'history') {
    // Ctrl+R: the picked prompt replaces what is in the box, as in the CLI's history search.
    input.value = item;
    input.setSelectionRange(item.length, item.length);
    input.focus();
    closeSuggest();
    autosize();
    updateBashMode();
    return;
  }
  const insert = suggest.kind === 'slash' ? `/${item.name} ` : `@${item} `;
  input.value = input.value.slice(0, suggest.start) + insert + input.value.slice(suggest.end);
  const caret = suggest.start + insert.length;
  input.setSelectionRange(caret, caret);
  input.focus();
  closeSuggest();
}

/** Every slash command with its description: the app's own first, then Claude Code's (built-in, skills, plugins). */
function slashCatalog() {
  const byName = new Map();
  for (const c of LOCAL_COMMANDS) byName.set(c.name, c);
  for (const c of state.config?.commands ?? []) if (!byName.has(c.name)) byName.set(c.name, c);
  for (const name of state.config?.slashCommands ?? []) if (!byName.has(name)) byName.set(name, { name });
  return [...byName.values()];
}

/** Ctrl+R: prompts from this project's history that contain what is typed. */
function searchHistory() {
  const input = $('#prompt');
  const q = input.value.trim().toLowerCase();
  const matches = promptHistory().filter((p) => p.toLowerCase().includes(q)).slice(0, 30);
  if (!matches.length) return toast(q ? `Tidak ada prompt yang berisi "${q}".` : 'Belum ada riwayat prompt.', 'warn');
  showSuggest('history', matches, 0, input.value.length);
}

function updateSuggest() {
  const input = $('#prompt');
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  if (suggest.kind === 'history') {
    // Ctrl+R search narrows as you type
    const q = input.value.trim().toLowerCase();
    const matches = promptHistory().filter((p) => p.toLowerCase().includes(q)).slice(0, 30);
    return matches.length ? showSuggest('history', matches, 0, input.value.length) : closeSuggest();
  }
  const slash = before.match(/^\/([\w:.-]*)$/);
  if (slash) {
    const q = slash[1].toLowerCase();
    const matchName = (c) => c.name.toLowerCase().includes(q) || c.aliases?.some((a) => a.toLowerCase().includes(q));
    const list = slashCatalog().filter(matchName);
    list.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
    return showSuggest('slash', list.slice(0, 40), 0, caret);
  }
  const at = before.match(/(^|\s)@([^\s@]*)$/);
  if (at && state.active !== DEMO_ID) {
    const start = caret - at[2].length - 1;
    clearTimeout(suggest.timer);
    const seq = ++suggest.seq;
    suggest.timer = setTimeout(async () => {
      try {
        const { files } = await api(`/api/projects/${state.active}/files`, { q: at[2] });
        if (seq === suggest.seq) showSuggest('file', files, start, caret);
      } catch {
        closeSuggest();
      }
    }, 120);
    return;
  }
  closeSuggest();
}

$('#prompt').addEventListener('input', updateSuggest);
$('#prompt').addEventListener('blur', () => setTimeout(closeSuggest, 150));
$('#suggest').addEventListener('mousedown', (e) => {
  const opt = e.target.closest('.opt');
  if (!opt) return;
  e.preventDefault();
  applySuggest(Number(opt.dataset.i));
});

// ---------- session bar + history ----------

const sessionTitles = new Map(); // Claude Code session id -> { title, source }
const titleTried = new Map(); // session id -> last lookup (a brand-new transcript may not exist yet)
const sessionsView = { project: null, list: [], current: null }; // the open history dialog

/** "baru saja", "12 menit lalu", "3 jam lalu", else a short date. */
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'baru saja';
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return new Date(ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

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
function renderSessionBar() {
  const isDemo = state.active === DEMO_ID;
  $('#session-bar').hidden = isDemo;
  if (isDemo) return;
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
    ? [known?.source === 'cli' ? 'lanjutan sesi terminal' : 'sesi web', st.sessionId.slice(0, 8), st.activeModel]
    : ['pesan pertamamu memulai sesi Claude Code baru'];
  if (st.cliBusy) meta.push('terminal aktif');
  $('#sb-meta').textContent = meta.filter(Boolean).join(' · ');
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

async function openSessions() {
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
          : `<button class="primary s-resume" data-resume="${s.id}">Lanjutkan</button>`;
      return `${head}<div class="s-item ${current ? 'current' : ''}">
        <div class="s-main">
          <span class="s-title">${escapeHtml(s.title)}</span>
          <span class="s-meta"><span class="src src-${s.source}">${s.source === 'web' ? 'Web' : 'Terminal'}</span>${ago(s.updated)} · <code>${s.id.slice(0, 8)}</code></span>
        </div>
        ${action}
      </div>`;
    })
    .join('');
}

$('#btn-sessions').addEventListener('click', openSessions);
$('#sessions-search').addEventListener('input', renderSessionList);
$('#sessions-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-resume]');
  if (!btn) return;
  const st = state.statuses[sessionsView.project] ?? {};
  const warnings = [
    st.busy ? 'Tim sedang bekerja di percakapan ini — pekerjaannya akan dihentikan.' : '',
    st.cliBusy ? 'Ada sesi yang sedang berjalan di terminal untuk project ini. Jangan lanjutkan sesi yang sama di dua tempat sekaligus.' : '',
  ].filter(Boolean);
  if (warnings.length && !window.confirm(`${warnings.join('\n\n')}\n\nTetap lanjutkan sesi ini?`)) return;
  btn.disabled = true;
  btn.textContent = 'Membuka…';
  try {
    await api(`/api/projects/${sessionsView.project}/resume`, { sessionId: btn.dataset.resume });
    closeModal('sessions-modal');
    toast('Sesi dilanjutkan — percakapan terakhirnya dimuat ke chat.', 'ok');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Lanjutkan';
    toast(err.message);
  }
});
$('#sessions-new').addEventListener('click', () => {
  if (!confirmNew()) return;
  closeModal('sessions-modal');
  api(`/api/projects/${state.active}/reset`).catch((err) => toast(err.message));
});
$('#jump-latest').addEventListener('click', () => scrollChat(true));

// ---------- ⋯ menu: export, continue in a terminal, open in VS Code / Explorer ----------

function toggleMoreMenu(open = $('#more-menu').hidden) {
  $('#more-menu').hidden = !open;
  $('#btn-more').setAttribute('aria-expanded', String(open));
}

function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The whole chat of the active project as Markdown: prompts, answers, tools, approvals, results. */
function exportChat() {
  const messages = state.chats[state.active] ?? [];
  if (!messages.length) return toast('Belum ada percakapan untuk diekspor.');
  const project = state.projects.find((p) => p.id === state.active);
  const st = state.statuses[state.active] ?? {};
  const stamp = (ts) => new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  const approvalLabel = { allowed: 'diizinkan', denied: 'ditolak', cancelled: 'dibatalkan', pending: 'menunggu' };
  const lines = [`# ${project?.name ?? 'Percakapan'}`, '', `Diekspor dari ${APP_NAME} · ${stamp(Date.now())}${st.sessionId ? ` · sesi \`${st.sessionId}\`` : ''}`];
  for (const m of messages) {
    if (m.kind === 'user') lines.push('', `## 🧑 Kamu${m.source === 'cli' ? ' (terminal)' : ''} · ${stamp(m.ts)}`, '', m.text);
    else if (m.kind === 'assistant' && m.text) lines.push('', `## ${roleName('claude')} · ${stamp(m.ts)}`, '', m.text);
    else if (m.kind === 'tool') lines.push(`- ${m.status === 'fail' ? '✗' : '✓'} **${roleName(m.role)}**: ${m.text}`);
    else if (m.kind === 'delegate') lines.push(`- ➜ **${roleName(m.role)}** ditugaskan: ${m.text}`);
    else if (m.kind === 'approval') lines.push(`- ✋ Izin: ${m.text} (${approvalLabel[state.approvals.get(m.approvalId)?.status ?? m.status] ?? 'menunggu'})`);
    else if (m.kind === 'result') lines.push('', `> ${m.ok ? '✓ Selesai' : `■ Berhenti${m.text ? `: ${m.text}` : ''}`}`);
    else if (m.kind === 'error') lines.push('', `> ⚠ ${m.text}`);
    else if (m.kind === 'divider') lines.push('', '---', '', `*${m.text}*`);
    else if (m.kind === 'shell') lines.push('', `\`\`\`\n$ ${m.text}\n${m.output ?? ''}\n\`\`\``);
  }
  const slug = (project?.name ?? 'chat').replace(/[^\w.-]+/g, '-');
  // sv-SE formats as YYYY-MM-DD in local time (toISOString would give yesterday's date before 07:00 in Jakarta).
  saveBlob(`${slug}-${new Date().toLocaleDateString('sv-SE')}.md`, new Blob([`${lines.join('\n')}\n`], { type: 'text/markdown' }));
  toast('Percakapan diekspor ke Markdown.', 'ok');
}

$('#btn-more').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMoreMenu();
});
document.addEventListener('click', (e) => {
  if (!$('#more-menu').hidden && !e.target.closest('#more-menu')) toggleMoreMenu(false);
});
$('#more-menu').addEventListener('click', async (e) => {
  const item = e.target.closest('[data-more]');
  if (!item) return;
  toggleMoreMenu(false);
  const project = state.projects.find((p) => p.id === state.active);
  const st = state.statuses[state.active] ?? {};
  try {
    if (item.dataset.more === 'export') exportChat();
    else if (item.dataset.more === 'terminal') {
      if (!st.sessionId) return toast('Belum ada sesi web. Kirim pesan dulu, lalu sesinya bisa dilanjutkan di terminal.');
      // Two lines work the same in PowerShell, cmd and Git Bash (no && vs ; differences).
      const dir = /^[A-Za-z]:\//.test(project.path) ? project.path.replace(/\//g, '\\') : project.path;
      const ok = await copyText(`cd "${dir}"\nclaude --resume ${st.sessionId}`);
      toast(ok ? 'Perintah disalin. Tempel di terminal untuk melanjutkan sesi ini di CLI.' : 'Gagal menyalin.', ok ? 'ok' : 'error');
    } else {
      await api(`/api/projects/${state.active}/open`, { app: item.dataset.more });
      toast(item.dataset.more === 'code' ? 'Membuka VS Code…' : 'Membuka folder project…', 'ok');
    }
  } catch (err) {
    toast(err.message);
  }
});

// ---------- help ----------

$('#btn-help').addEventListener('click', () => openModal('help-modal'));

async function saveSettings() {
  try {
    await api(`/api/projects/${state.active}/settings`, { mode: $('#mode').value, model: $('#model').value, effort: $('#effort').value, team: $('#team-mode').checked });
  } catch (err) {
    toast(err.message);
  }
}

// ---------- wiring ----------

$('#project-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (e.target.closest('.fav')) {
    const project = state.projects.find((p) => p.id === li.dataset.id);
    api(`/api/projects/${li.dataset.id}/favorite`, { on: !project?.favorite }).catch((err) => toast(err.message));
    return;
  }
  if (e.target.closest('.forget')) {
    if (window.confirm('Hapus folder ini dari daftar? (folder di disk tidak dihapus)')) {
      api(`/api/projects/${li.dataset.id}/forget`)
        .then(() => li.dataset.id === state.active && selectProject(DEMO_ID))
        .catch((err) => toast(err.message));
    }
    return;
  }
  selectProject(li.dataset.id);
});
$('#project-search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderSidebar();
});
// ---------- notifications (Windows notification + chime) ----------

const notifyState = { on: localStorage.getItem('office.notify') === '1' };
let audioCtx = null;

function renderNotifyButton() {
  const btn = $('#btn-notify');
  btn.classList.toggle('on', notifyState.on);
  btn.querySelector('.ico').textContent = notifyState.on ? '🔔' : '🔕';
  btn.querySelector('.lbl').textContent = notifyState.on ? 'Notifikasi aktif' : 'Notifikasi';
  btn.title = notifyState.on ? 'Notifikasi aktif — klik untuk mematikan' : 'Aktifkan notifikasi & suara (izin, tugas selesai)';
}

/** Short synthesized chime: rising for "done", urgent triple for "needs you", low for errors. */
function chime(kind) {
  try {
    audioCtx ??= new AudioContext();
    const notes = kind === 'ask' ? [880, 660, 880] : kind === 'error' ? [330, 247] : [523, 784];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const t = audioCtx.currentTime + i * 0.15;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  } catch {
    // audio unavailable
  }
}

function notify(kind, title, body, projectId) {
  if (!notifyState.on) return;
  const away = document.hidden || projectId !== state.active;
  if (!away && kind !== 'ask') return; // you're already looking at it
  chime(kind);
  if (away && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(title, { body, tag: `${projectId}-${kind}`, requireInteraction: kind === 'ask' });
    n.onclick = () => {
      window.focus();
      selectProject(projectId);
      n.close();
    };
  }
}

const projectName = (id) => state.projects.find((p) => p.id === id)?.name ?? 'project';

$('#btn-notify').addEventListener('click', async () => {
  if (!notifyState.on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  notifyState.on = !notifyState.on;
  localStorage.setItem('office.notify', notifyState.on ? '1' : '0');
  renderNotifyButton();
  if (notifyState.on) {
    chime('done');
    if ('Notification' in window && Notification.permission === 'denied') toast('Notifikasi Windows diblokir browser; yang aktif hanya suara.', 'ok');
  }
});
renderNotifyButton();

// ---------- changes panel (git) ----------

// project: whose files the list shows; diffFor: `${project}\n${file}` of the diff on screen (both drive the loading state)
const changes = { selected: null, timer: null, data: null, project: null, diffFor: null };
const LOADING = '<span class="spinner" aria-hidden="true"></span> Memuat…';

function renderDiff(diff) {
  return diff
    .split('\n')
    .map((line) => {
      const cls = line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
      return `<span class="${cls}">${escapeHtml(line) || ' '}</span>`;
    })
    .join('\n');
}

async function loadChanges() {
  clearTimeout(changes.timer);
  const project = state.active;
  const list = $('#ch-files');
  if (project === DEMO_ID) {
    changes.data = null;
    changes.project = project;
    $('#ch-branch').textContent = '';
    list.innerHTML = '<li class="empty-line">Demo tidak punya repository. Pilih project sungguhan.</li>';
    $('#ch-diff').innerHTML = '';
    $('#changes-count').hidden = true;
    $('#nav-badge-changes').hidden = true;
    return;
  }
  // Loading only when the list shows another project (or nothing yet): the auto-refresh after
  // every tool call keeps the current list in place instead of flickering.
  if (changes.project !== project) {
    list.innerHTML = `<li class="empty-line">${LOADING}</li>`;
    $('#ch-diff').innerHTML = '';
    changes.diffFor = null;
  }
  let data;
  try {
    data = await api(`/api/projects/${project}/changes`);
  } catch (err) {
    if (project !== state.active) return;
    // Nothing stale stays on screen: files, diff, branch and the commit box belong to the failed read.
    changes.data = null;
    changes.project = null;
    changes.diffFor = null;
    $('#ch-branch').textContent = '';
    $('#ch-diff').innerHTML = '';
    $('#ch-commit').hidden = true;
    $('#changes-count').hidden = true;
    $('#nav-badge-changes').hidden = true;
    list.innerHTML = `<li class="empty-line"><div class="state-error">Gagal membaca git: ${escapeHtml(err.message)}</div></li>`;
    return;
  }
  if (project !== state.active) return;
  changes.data = data;
  changes.project = project;
  const count = data.files?.length ?? 0;
  for (const badge of [$('#changes-count'), $('#nav-badge-changes')]) {
    badge.hidden = !count;
    badge.textContent = count;
  }
  if (!data.repo) {
    $('#ch-branch').textContent = '';
    list.innerHTML = `<li class="empty-line">${data.error ? `<div class="state-error">${escapeHtml(data.error)}</div>` : 'Folder ini bukan repository git. Jalankan <code>git init</code> untuk memakai panel ini.'}</li>`;
    $('#ch-diff').innerHTML = '';
    $('#ch-commit').hidden = true;
    return;
  }
  $('#ch-commit').hidden = !count;
  $('#ch-branch').innerHTML = `⎇ <b>${escapeHtml(data.branch || '(detached)')}</b> · ${count ? `${count} file berubah` : 'bersih'}${data.ahead ? ` · ${data.ahead} commit belum di-push` : ''}`;
  if (!count) {
    list.innerHTML = '<li class="empty-line">Tidak ada perubahan yang belum di-commit. ✓</li>';
    $('#ch-diff').innerHTML = '';
    changes.selected = null;
    return;
  }
  if (!data.files.some((f) => f.path === changes.selected)) changes.selected = data.files[0].path;
  const focused = document.activeElement?.closest?.('#ch-files li[data-path]')?.dataset.path; // survives the refresh
  // <bdi>: the row is rtl (ellipsis on the left), the path inside stays ltr so ".env" is not shown as "env."
  list.innerHTML = data.files
    .map((f) => `<li class="${f.path === changes.selected ? 'active' : ''}" data-path="${escapeHtml(f.path)}" role="button" tabindex="0" aria-current="${f.path === changes.selected}"><span class="st st-${f.code.trim()[0] === '?' ? 'A' : escapeHtml(f.code.trim()[0])}">${escapeHtml(f.status)}</span><span class="p"><bdi>${escapeHtml(f.path)}</bdi></span></li>`)
    .join('');
  if (focused) [...list.querySelectorAll('li[data-path]')].find((li) => li.dataset.path === focused)?.focus({ preventScroll: true });
  loadDiff(changes.selected);
}

async function loadDiff(file) {
  changes.selected = file;
  const project = state.active;
  const key = `${project}\n${file}`;
  const box = $('#ch-diff');
  // A newly picked file shows "Memuat…"; a background refresh of the same file keeps the old diff (and scroll).
  if (changes.diffFor !== key || !box.firstChild) box.innerHTML = `<div class="muted ch-loading">${LOADING}</div>`;
  try {
    const { diff, error, truncated } = await api(`/api/projects/${project}/diff`, { file });
    if (changes.selected !== file || state.active !== project) return; // a later pick won the race
    box.innerHTML = error && !diff ? `<div class="state-error">${escapeHtml(error)}</div>` : `<pre>${renderDiff(diff)}</pre>${truncated ? '<div class="muted">Diff dipotong (terlalu besar).</div>' : ''}`;
    changes.diffFor = key;
  } catch (err) {
    if (changes.selected !== file || state.active !== project) return;
    box.innerHTML = `<div class="state-error">${escapeHtml(err.message)}</div>`; // replaces the old diff
    changes.diffFor = null;
  }
}

/** Re-check git after edits/commands, a moment after the dust settles. */
function scheduleChanges() {
  clearTimeout(changes.timer);
  changes.timer = setTimeout(loadChanges, 1500);
}

$('#ch-files').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-path]');
  if (!li) return;
  const prev = $('#ch-files .active');
  prev?.classList.remove('active');
  prev?.setAttribute('aria-current', 'false');
  li.classList.add('active');
  li.setAttribute('aria-current', 'true');
  loadDiff(li.dataset.path);
});
$('#ch-refresh').addEventListener('click', loadChanges);
$('#ch-open').addEventListener('click', () =>
  api(`/api/projects/${state.active}/open`, { app: 'code', file: changes.selected || undefined })
    .then(() => toast('Membuka VS Code…', 'ok'))
    .catch((err) => toast(err.message)),
);
$('#ch-review').addEventListener('click', async () => {
  try {
    await api(`/api/projects/${state.active}/prompt`, {
      text: 'Minta subagent architect me-review semua perubahan yang belum di-commit (git status & git diff). Laporkan temuan berprioritas (blocker / sebaiknya diperbaiki / saran) dengan file:baris, lalu verdict: siap commit atau perlu perbaikan.',
    });
    document.querySelector('.tabs button[data-tab="chat"]').click();
  } catch (err) {
    toast(err.message);
  }
});
$('#ch-commit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('#ch-message').value.trim();
  if (!message) return toast('Tulis pesan commit dulu.');
  const n = changes.data?.files?.length ?? 0;
  if (!window.confirm(`Commit ${n} file dengan pesan:\n\n"${message}"\n\n(semua perubahan akan di-stage dengan git add -A)`)) return;
  try {
    const res = await api(`/api/projects/${state.active}/commit`, { message });
    $('#ch-message').value = '';
    toast(res.output.split('\n')[0] || 'Commit berhasil.', 'ok');
    loadChanges();
  } catch (err) {
    toast(`Commit gagal: ${err.message}`);
  }
});

// ---------- phone access (QR pairing) — laptop only ----------

const phone = { timer: null, pairing: null, ip: null };
const ADDRESS_LABEL = { lan: '📶 WiFi yang sama', tailscale: '🌐 Dari mana saja (Tailscale)' };

function renderPhone() {
  const info = state.config?.remote ?? { enabled: false, urls: [], devices: [] };
  $('#remote-enabled').checked = info.enabled;
  const body = $('#phone-body');
  if (!info.enabled) {
    body.innerHTML = `<p class="muted">Setelah dinyalakan, scan QR dengan kamera HP untuk membuka kantor ini dari HP. HP harus terhubung ke WiFi yang sama dengan laptop.</p>
      <p class="warn">Hanya nyalakan di jaringan yang kamu percaya (rumah/kantor). Siapa pun di jaringan tetap butuh kode dari layar laptop ini untuk masuk.</p>`;
    return;
  }
  const p = phone.pairing;
  const left = p ? Math.max(0, Math.round((p.expires - Date.now()) / 1000)) : 0;
  const devices = info.devices
    .map((d) => `<li><span>${escapeHtml(d.name)}<small>dipasangkan ${new Date(d.created).toLocaleDateString('id-ID')} · terakhir aktif ${new Date(d.lastSeen).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</small></span><button class="danger" data-revoke="${d.id}">Cabut</button></li>`)
    .join('');
  const viaTailscale = p?.addresses.find((a) => a.ip === p.ip)?.kind === 'tailscale';
  const chooser = p && p.addresses.length > 1
    ? `<div class="addr-tabs">${p.addresses.map((a) => `<button class="${a.ip === p.ip ? 'active' : ''}" data-ip="${a.ip}">${ADDRESS_LABEL[a.kind] ?? a.kind}<small>${a.ip}</small></button>`).join('')}</div>`
    : '';
  const tailscaleTip = info.tailscale
    ? ''
    : `<details class="tip"><summary>🌐 Mau buka dari luar rumah (beda jaringan)?</summary>
        <ol>
          <li>Pasang <b>Tailscale</b> (gratis) di laptop: <code>tailscale.com/download</code>, lalu login.</li>
          <li>Pasang aplikasi Tailscale di HP, login dengan akun yang sama.</li>
          <li>Buka lagi jendela ini — muncul pilihan <b>Dari mana saja (Tailscale)</b> dengan QR-nya.</li>
        </ol>
        <p class="muted small">Tailscale membuat jaringan pribadi terenkripsi antara laptop dan HP-mu. Laptop tidak terbuka ke internet publik.</p>
      </details>`;
  body.innerHTML = p
    ? `${chooser}<div class="pair">
        <div class="qr">${qrSvg(p.qrUrl)}</div>
        <div class="pair-info">
          <ol>
            <li>${viaTailscale ? 'Nyalakan Tailscale di HP (boleh pakai data seluler / WiFi mana saja).' : 'Sambungkan HP ke WiFi yang sama.'}</li>
            <li>Scan QR dengan kamera HP.</li>
            <li>Atau buka <code>${escapeHtml(p.url)}</code> lalu masukkan kode:</li>
          </ol>
          <div class="code">${p.code.slice(0, 3)} ${p.code.slice(3)}</div>
          <div class="muted">Berlaku ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · sekali pakai</div>
        </div>
      </div>
      <p class="muted small">Belum tersambung? Saat pertama kali, Windows mungkin menanyakan izin firewall untuk Node.js — pilih <b>Allow / Izinkan</b> (jaringan Private).</p>`
    : '<p class="muted">Menyiapkan kode…</p>';
  body.innerHTML += `<div class="devices"><b>Perangkat terhubung</b>${devices ? `<ul>${devices}</ul>` : '<p class="muted small">Belum ada.</p>'}</div>`;
  // Rendered apart from the per-second countdown so an opened <details> stays open.
  const tipBox = $('#phone-tip');
  if (tipBox.dataset.tailscale !== String(info.tailscale)) {
    tipBox.innerHTML = tailscaleTip;
    tipBox.dataset.tailscale = String(info.tailscale);
  }
}

async function refreshPairing() {
  clearTimeout(phone.timer);
  if ($('#phone-modal').hidden || !state.config?.remote?.enabled) return;
  try {
    if (!phone.pairing || Date.now() > phone.pairing.expires - 1000 || (phone.ip && phone.pairing.ip !== phone.ip)) {
      phone.pairing = await api('/api/remote/pairing', { ip: phone.ip });
    }
  } catch (err) {
    phone.pairing = null;
    $('#phone-body').innerHTML = `<p class="warn">${escapeHtml(err.message)}</p>`;
    return;
  }
  renderPhone();
  phone.timer = setTimeout(refreshPairing, 1000); // countdown + auto-rotate when expired
}

function openPhone() {
  $('#phone-modal').hidden = false;
  phone.pairing = null;
  renderPhone();
  refreshPairing();
}

$('#btn-phone').addEventListener('click', openPhone);
$('#phone-close').addEventListener('click', () => {
  $('#phone-modal').hidden = true;
  clearTimeout(phone.timer);
});
$('#phone-modal').addEventListener('click', (e) => {
  if (e.target.id === 'phone-modal') $('#phone-close').click();
});
$('#remote-enabled').addEventListener('change', async (e) => {
  try {
    await api('/api/remote', { enabled: e.target.checked });
    phone.pairing = null;
    setTimeout(refreshPairing, 300);
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message);
  }
});
$('#phone-body').addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-ip]');
  if (tab) {
    phone.ip = tab.dataset.ip; // same pairing code, QR for the other address
    refreshPairing();
    return;
  }
  const btn = e.target.closest('[data-revoke]');
  if (!btn || !window.confirm('Cabut akses perangkat ini? HP itu harus scan QR lagi untuk masuk.')) return;
  await api('/api/remote/revoke', { id: btn.dataset.revoke }).catch((err) => toast(err.message));
});

// ---------- Claude account: profile, plan quota, login/logout ----------

const fmtNum = (n) => Number(n ?? 0).toLocaleString('id-ID');
const fmtShort = (n) => new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 }).format(n ?? 0);
const fmtUsd = (n) => (n == null ? '—' : `$${n.toFixed(2)}`);
const LOGIN_TEXT = {
  starting: 'Membuka halaman login di browser…',
  waiting_code: 'Selesaikan login di browser. Kalau diminta, salin kode dari halaman itu lalu tempel di sini.',
  verifying: 'Memverifikasi kode…',
  done: 'Login berhasil.',
  cancelled: 'Login dibatalkan.',
};
const account = { usage: null, loading: false, loginState: null };

function accountName(p) {
  // Profiles can hold blank names (a full name of " "), so take the first field with real text.
  return [p?.fullName, p?.displayName, p?.email].map((v) => v?.trim()).find(Boolean) ?? 'Akun Claude';
}
const accountInitial = (p) => accountName(p)[0].toUpperCase();

function renderAccountButton() {
  const p = state.account?.profile;
  const btn = $('#btn-account');
  btn.classList.toggle('logged-out', !p?.loggedIn);
  $('#account-avatar').textContent = p?.loggedIn ? accountInitial(p) : '!';
  $('#account-label').textContent = p ? (p.loggedIn ? p.email : 'Belum login') : 'Akun';
  btn.title = p?.loggedIn ? `${p.email}${p.orgName ? ` · ${p.orgName}` : ''} — profil, kuota & login` : 'Belum login ke Claude — klik untuk login';
}

/** Quota bars: `/usage` text when fetched, else the structured rate-limit info from a running session. */
/** `/usage` prints English labels; show them in the app's language. */
const quotaLabel = (label) =>
  label
    .replace(/^Current session$/i, 'Sesi saat ini (5 jam)')
    .replace(/^Current week \((.+)\)$/i, (_, m) => `Minggu ini (${/^all models$/i.test(m) ? 'semua model' : m})`);

function quotaRows() {
  const limits = state.account?.limits;
  if (limits?.windows?.length) return limits.windows.map((w) => ({ ...w, label: quotaLabel(w.label) }));
  const win = state.account?.rateLimit?.unifiedWindows ?? {};
  const label = { five_hour: 'Sesi 5 jam', seven_day: 'Minggu ini' };
  return Object.entries(win)
    .filter(([, w]) => w?.utilization != null)
    .map(([k, w]) => ({ label: label[k] ?? k, percent: Math.round(w.utilization * 100), resets: w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : null }));
}

function usageTable(usage) {
  if (!usage) return '<p class="muted small">Memuat…</p>';
  const row = (label, t) => `<tr><th>${label}</th><td>${fmtShort(t.input)}</td><td>${fmtShort(t.output)}</td><td>${fmtShort(t.cacheRead)}</td><td>${fmtShort(t.cacheWrite)}</td><td><b>${fmtShort(t.total)}</b></td></tr>`;
  return `<table class="usage-table">
    <thead><tr><th></th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Total</th></tr></thead>
    <tbody>${row('Hari ini', usage.today)}${row('7 hari', usage.week)}</tbody>
  </table>`;
}

function renderLoginFlow() {
  const box = $('#acct-login');
  if (!box) return;
  const login = state.account?.login;
  const active = login && ['starting', 'waiting_code', 'verifying'].includes(login.state);
  account.loginState = login?.state ?? null;
  if (!active) {
    box.innerHTML = login?.state === 'error' ? `<p class="warn">Login gagal: ${escapeHtml(login.error ?? 'tidak diketahui')}</p>` : '';
    return;
  }
  box.innerHTML = `<div class="login-flow">
      <p>${LOGIN_TEXT[login.state]}</p>
      ${login.url ? `<a class="primary link-btn" href="${escapeHtml(login.url)}" target="_blank" rel="noopener noreferrer">🔑 Buka halaman login Claude</a>` : '<span class="spinner"></span>'}
      <form id="login-code" class="login-code">
        <input id="login-code-input" placeholder="Tempel kode dari browser (jika diminta)" aria-label="Kode login dari browser" autocomplete="off" spellcheck="false" ${login.state === 'verifying' ? 'disabled' : ''} />
        <button class="primary" ${login.state === 'verifying' ? 'disabled' : ''}>Kirim</button>
      </form>
      <button type="button" class="ghost" data-act="cancel-login">Batal</button>
    </div>`;
}

/** The laptop is told whenever a phone starts a login or logs out. */
function onAccountAlert({ action, device, email }) {
  if (!state.local) return;
  const text = action === 'logout' ? `HP "${device}" me-logout Claude Code${email ? ` (${email})` : ''}.` : `HP "${device}" memulai login/ganti akun Claude Code.`;
  toast(text, 'warn');
  chime('ask');
  if ('Notification' in window && Notification.permission === 'granted') new Notification('Adhit Office: akun Claude', { body: text, tag: 'account-alert' });
}

function renderAccount() {
  const body = $('#account-body');
  const p = state.account?.profile;
  if (!p) {
    body.innerHTML = '<p class="muted">Memeriksa akun Claude Code…</p>';
    return;
  }
  const actions = state.accountAuth
    ? p.loggedIn
      ? `<button class="ghost" data-act="login">⇄ Ganti akun</button><button class="danger" data-act="logout">⏻ Logout</button>`
      : `<button class="primary" data-act="login">🔑 Login dengan akun Claude</button><button class="ghost" data-act="login-console">Login via Console (API)</button>`
    : '<p class="muted small">Login/logout dari HP hanya lewat Tailscale (koneksi terenkripsi). Buka kantor lewat alamat Tailscale, atau lakukan dari laptop.</p>';
  if (!p.loggedIn) {
    body.innerHTML = `<div class="acct-empty"><p>Claude Code di laptop ini <b>belum login</b>. Login membuka halaman claude.ai di browser, sama seperti <code>claude auth login</code>.</p></div>
      <div class="acct-actions">${actions}</div><div id="acct-login"></div>`;
    renderLoginFlow();
    return;
  }
  const facts = [
    ['Email', p.email],
    ['Organisasi', p.orgName],
    ['Paket', p.subscriptionType],
    ['Peran', p.role],
    ['Seat', p.seatTier],
    ['Metode login', p.authMethod],
    ['Tier rate limit', p.rateLimitTier],
    ['ID akun', p.accountUuid],
  ].filter(([, v]) => v);
  const quota = quotaRows();
  const quotaHtml = quota.length
    ? quota
        .map((w) => {
          const tone = w.percent >= 90 ? 'bad' : w.percent >= 70 ? 'warn' : 'ok';
          return `<div class="quota"><div class="quota-head"><span>${escapeHtml(w.label)}</span><b>${w.percent}%</b></div>
            <div class="bar"><i class="${tone}" style="width:${Math.min(100, w.percent)}%"></i></div>
            ${w.resets ? `<small class="muted">reset ${escapeHtml(w.resets)}</small>` : ''}</div>`;
        })
        .join('')
    : `<p class="muted small">${account.loading ? 'Mengambil kuota…' : 'Belum ada data kuota.'}</p>`;
  body.innerHTML = `<div class="acct-head">
      <span class="avatar big">${escapeHtml(accountInitial(p))}</span>
      <div><b>${escapeHtml(accountName(p))}</b><small>${escapeHtml(p.email ?? '')}</small></div>
      ${p.subscriptionType ? `<span class="plan-badge">${escapeHtml(p.subscriptionType)}</span>` : ''}
    </div>
    <dl class="acct-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>
    <div class="acct-section"><div class="acct-title"><b>Kuota paket</b><button class="ghost icon" data-act="limits" title="Cek ulang kuota">↻</button></div>${quotaHtml}</div>
    <div class="acct-section"><div class="acct-title"><b>Pemakaian token akun ini</b><button class="ghost" data-act="report">📊 Laporan</button></div>${usageTable(account.usage)}
      <p class="muted small">Dihitung dari sesi web & CLI sejak fitur ini aktif, hanya untuk akun yang sedang login.</p></div>
    <div class="acct-actions">${actions}</div>
    <div id="acct-login"></div>`;
  renderLoginFlow();
}

async function loadAccount(force = false) {
  try {
    const data = await api('/api/account', { force });
    account.usage = data.usage;
    state.account = { ...state.account, ...data };
    renderAccountButton();
    renderAccount();
    if (!data.profile?.loggedIn) return;
    account.loading = true;
    renderAccount();
    state.account.limits = await api('/api/account/limits', { force });
  } catch (err) {
    toast(err.message);
  } finally {
    account.loading = false;
    if (!$('#account-modal').hidden) renderAccount();
  }
}

function onAccountState(next) {
  const prevId = state.account?.profile?.accountUuid ?? state.account?.profile?.email;
  state.account = { ...state.account, ...next };
  renderAccountButton();
  const id = next.profile?.accountUuid ?? next.profile?.email;
  if (next.login?.state === 'done' && account.loginState !== 'done') toast(`Login berhasil sebagai ${next.profile?.email ?? 'akun baru'}.`, 'ok');
  if ($('#account-modal').hidden) return;
  if (prevId !== id) return loadAccount(true); // switched account: usage & quota belong to the new one
  // Keep what the user is typing in the code box: only redraw the flow when its state changes.
  if ((next.login?.state ?? null) !== account.loginState) renderLoginFlow();
  if (!$('#login-code-input')) renderAccount();
}

$('#btn-account').addEventListener('click', () => {
  openModal('account-modal');
  renderAccount();
  loadAccount();
});
$('#account-body').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  try {
    if (act === 'login' || act === 'login-console') {
      state.account = { ...state.account, login: await api('/api/account/login', { console: act === 'login-console' }) };
      renderLoginFlow();
    } else if (act === 'cancel-login') {
      await api('/api/account/login/cancel');
    } else if (act === 'logout') {
      const email = state.account?.profile?.email ?? 'akun ini';
      if (!window.confirm(`Logout dari ${email}?\n\nClaude Code di laptop ini (termasuk terminal/CLI) ikut logout. Giliran yang sedang berjalan di web dibiarkan selesai dulu.`)) return;
      // From a phone, a second step: type LOGOUT (the server checks it too).
      let confirm;
      if (!state.local) {
        confirm = window.prompt('Logout dari HP akan mengeluarkan Claude Code di laptop.\nKetik LOGOUT untuk melanjutkan:')?.trim().toUpperCase();
        if (confirm !== 'LOGOUT') return toast('Logout dibatalkan.', 'ok');
      }
      await api('/api/account/logout', { confirm });
      account.usage = null;
      toast('Sudah logout.', 'ok');
      loadAccount(true);
    } else if (act === 'limits') {
      account.loading = true;
      renderAccount();
      state.account.limits = await api('/api/account/limits', { force: true });
      account.loading = false;
      renderAccount();
    } else if (act === 'report') {
      closeModal('account-modal');
      openReport();
    }
  } catch (err) {
    account.loading = false;
    toast(err.message);
  }
});
$('#account-body').addEventListener('submit', async (e) => {
  if (e.target.id !== 'login-code') return;
  e.preventDefault();
  const code = $('#login-code-input').value.trim();
  if (!code) return;
  await api('/api/account/login/code', { code }).catch((err) => toast(err.message));
});

// ---------- token usage report (PDF, per account) ----------

const DAY = 86_400_000;
const UNIT_NAME = { day: 'hari', week: 'minggu', month: 'bulan' };
// What the dialog shows; the preview and the PDF always use this same state.
const report = { period: '7', unit: 'day', accounts: [], seq: 0, last: null, allRows: false };
const REPORT_ROWS = 7; // newest periods shown before "Tampilkan semua"

const startOfDay = (ts) => new Date(ts).setHours(0, 0, 0, 0);
const fmtDay = (ts, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(ts).toLocaleDateString('id-ID', opts);
const capitalize = (s) => s[0].toUpperCase() + s.slice(1);
const reportAccount = () => report.accounts.find((a) => a.id === $('#report-account').value) ?? null;

function reportRange() {
  const now = Date.now();
  const today = startOfDay(now);
  if (report.period === 'today') return { from: today, to: now };
  if (report.period === 'month') return { from: new Date(today).setDate(1), to: now };
  // "Semua" starts at this account's first record, so the chart doesn't begin in 1970.
  if (report.period === 'all') return { from: reportAccount()?.first ?? 0, to: now };
  if (report.period === 'custom') {
    const from = $('#report-from').valueAsDate;
    const to = $('#report-to').valueAsDate;
    // <input type=date> gives UTC midnight: shift to local day bounds.
    const local = (d) => d.getTime() + d.getTimezoneOffset() * 60_000;
    return { from: from ? local(from) : (reportAccount()?.first ?? 0), to: to ? local(to) + DAY - 1 : now };
  }
  return { from: today - (Number(report.period) - 1) * DAY, to: now };
}

function reportQuery() {
  return { accountId: $('#report-account').value, groupBy: report.unit, ...reportRange() };
}

// Same calendar rules as src/usage.js (periodStart/nextPeriod): local day, Monday week, calendar month.
function periodStartOf(ts, unit) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (unit === 'month') d.setDate(1);
  return d.getTime();
}

function nextPeriodOf(start, unit) {
  const d = new Date(start);
  if (unit === 'month') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + (unit === 'week' ? 7 : 1));
  return d.getTime();
}

/** How many days/weeks/months the range touches (capped; only "one" vs "many" really matters). */
function bucketCount({ from, to }, unit) {
  let n = 0;
  for (let s = periodStartOf(from || to, unit); s <= to && n < 500; s = nextPeriodOf(s, unit)) n++;
  return n;
}

/** The natural granularity for a range: days up to a month, then weeks, then months. */
function naturalUnit(range) {
  const days = bucketCount(range, 'day');
  return days <= 31 ? 'day' : days <= 180 ? 'week' : 'month';
}

/**
 * Week/month only make sense when the range spans at least two of them (otherwise they'd just
 * repeat the totals), so those buttons are disabled with the reason in their tooltip.
 */
function syncUnits(range) {
  const counts = Object.fromEntries(Object.keys(UNIT_NAME).map((u) => [u, bucketCount(range, u)]));
  const usable = (u) => u === 'day' || counts[u] >= 2;
  if (!usable(report.unit)) report.unit = naturalUnit(range);
  for (const btn of document.querySelectorAll('#report-units [data-unit]')) {
    const u = btn.dataset.unit;
    btn.disabled = !usable(u);
    btn.title = btn.disabled ? `Periode ini masih di dalam 1 ${UNIT_NAME[u]}` : `${counts[u]} ${UNIT_NAME[u]}`;
    btn.classList.toggle('active', u === report.unit);
    btn.setAttribute('aria-pressed', String(u === report.unit));
  }
}

function choosePeriod(period) {
  report.period = period;
  for (const btn of document.querySelectorAll('#report-periods [data-period]')) {
    btn.classList.toggle('active', btn.dataset.period === period);
    btn.setAttribute('aria-pressed', String(btn.dataset.period === period));
  }
  $('#report-modal .custom-range').hidden = period !== 'custom';
  if (period === 'custom' && !$('#report-from').value) {
    const iso = (ms) => new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    $('#report-from').value = iso(Date.now() - 6 * DAY);
    $('#report-to').value = iso(Date.now());
  }
  // A new period gets a sensible grain: "Semua" per hari could be hundreds of bars.
  const range = reportRange();
  if (bucketCount(range, report.unit) > 62) report.unit = naturalUnit(range);
  previewReport();
}

/** "25 Okt 2026 – 31 Okt 2026 · 7 hari" (or one day for "Hari ini"). */
function rangeText(range) {
  if (!range.from) return 'Semua data';
  if (startOfDay(range.from) === startOfDay(range.to)) return fmtDay(range.from, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `${fmtDay(range.from)} – ${fmtDay(range.to)} · ${bucketCount(range, 'day')} hari`;
}

async function openReport() {
  openModal('report-modal');
  showReportMessage('Memuat…');
  try {
    const { accounts, current } = await api('/api/report/accounts');
    report.accounts = accounts;
    const select = $('#report-account');
    const keep = select.value;
    select.innerHTML = accounts.length
      ? accounts.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.email)}${a.org ? ` — ${escapeHtml(a.org)}` : ''}${a.id === current ? ' (aktif)' : ''}</option>`).join('')
      : '<option value="">Belum ada data</option>';
    // The logged-in account may have no usage yet: only pick an account that is in the list.
    select.value = [keep, current, accounts[0]?.id].find((id) => accounts.some((a) => a.id === id)) ?? '';
    choosePeriod(report.period);
  } catch (err) {
    showReportMessage(err.message, true);
  }
}

/** Same labels as the PDF: "Sab, 31 Okt 2026", "26 Okt – 1 Nov 2026", "Oktober 2026". */
function periodLabel({ start, end }, unit) {
  if (unit === 'month') return fmtDay(start, { month: 'long', year: 'numeric' });
  if (unit === 'week' && startOfDay(start) !== startOfDay(end)) return `${fmtDay(start, { day: 'numeric', month: 'short' })} – ${fmtDay(end)}`;
  return fmtDay(start, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Short tick under a bar: "31/10" for a day or week start, "Okt" for a month. */
function tickLabel({ start }, unit) {
  const d = new Date(start);
  return unit === 'month' ? fmtDay(start, { month: 'short' }) : `${d.getDate()}/${d.getMonth() + 1}`;
}

/** A message instead of the preview body (loading, no data, error); null shows the body again. */
function showReportMessage(message, isError = false) {
  const box = $('#report-empty');
  box.hidden = !message;
  box.textContent = message ?? '';
  box.className = isError ? 'warn' : 'muted';
  $('#report-body').hidden = Boolean(message);
}

/** Says why the start of the chart is empty: the ledger only exists since the feature was turned on. */
function renderReportNote(range) {
  const first = reportAccount()?.first;
  const note = $('#report-note');
  note.hidden = !(first && startOfDay(first) > range.from);
  if (!note.hidden) note.innerHTML = `ℹ Pencatatan token akun ini baru dimulai <b>${escapeHtml(fmtDay(first))}</b>. Sebelum tanggal itu grafik kosong karena belum tercatat, bukan karena tidak dipakai.`;
}

function renderReportKpis(t, records) {
  const main = [
    ['Total token', fmtShort(t.total)],
    ['Output', fmtShort(t.output)],
    ['Cache hit', `${Math.round(t.cacheHitRate * 100)}%`],
    ['Estimasi biaya', fmtUsd(t.costUsd)],
  ];
  $('#report-kpis').innerHTML = main.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('');
  $('#report-kpi-more').textContent = `Input ${fmtShort(t.input)} · Cache read ${fmtShort(t.cacheRead)} · Cache write ${fmtShort(t.cacheWrite)} · ${fmtNum(t.requests)} request API · ${fmtNum(records)} catatan`;
}

/** One bar per day/week/month (empty ones included, so gaps show) + the periods with usage, newest first. */
function renderTrend(s) {
  const unit = s.groupBy;
  const name = UNIT_NAME[unit];
  const periods = s.byPeriod ?? [];
  const max = periods.reduce((m, p) => Math.max(m, p.total), 1);
  const every = Math.ceil(periods.length / (narrow.matches ? 6 : 12)); // ticks counted back from the newest bar
  $('#report-chart').innerHTML = periods
    .map((p, i) => {
      const tip = `${periodLabel(p, unit)}: ${p.total ? `${fmtShort(p.total)} token` : 'tidak ada pemakaian'}`;
      const tick = (periods.length - 1 - i) % every === 0 ? tickLabel(p, unit) : '';
      const height = p.total ? Math.max(4, (p.total / max) * 100) : 0;
      return `<div class="tb${p.total ? '' : ' zero'}" title="${escapeHtml(tip)}"><div class="tb-col"><i style="height:${height.toFixed(1)}%"></i></div><small>${escapeHtml(tick)}</small></div>`;
    })
    .join('');
  const used = periods.filter((p) => p.total);
  $('#report-chart-caption').textContent = `${periods.length} ${name} · ${used.length} ada pemakaian · tertinggi ${fmtShort(max)} token per ${name}. ${capitalize(name)} tanpa pemakaian tidak masuk tabel.`;
  const newest = [...used].reverse();
  const rows = (report.allRows ? newest : newest.slice(0, REPORT_ROWS))
    .map((p) => `<tr><td>${escapeHtml(periodLabel(p, unit))}</td><td>${fmtShort(p.input)}</td><td>${fmtShort(p.output)}</td><td>${fmtShort(p.cacheRead)}</td><td><b>${fmtShort(p.total)}</b></td><td>${fmtUsd(p.costUsd)}</td></tr>`)
    .join('');
  const more = newest.length > REPORT_ROWS
    ? `<button type="button" class="text-btn" data-act="all-rows">${report.allRows ? 'Tampilkan lebih sedikit' : `Tampilkan semua ${newest.length} ${name}`}</button>`
    : '';
  $('#report-period-table').innerHTML = `<table class="usage-table"><thead><tr><th>${capitalize(name)}</th><th>Input</th><th>Output</th><th>Cache read</th><th>Total</th><th>Biaya</th></tr></thead><tbody>${rows}</tbody></table>${more}`;
}

function renderReportModels(byModel) {
  const rows = byModel
    .slice(0, 5)
    .map((m) => `<tr><td>${escapeHtml(m.key ?? '-')}</td><td>${fmtShort(m.input)}</td><td>${fmtShort(m.output)}</td><td>${fmtShort(m.cacheRead)}</td><td><b>${fmtShort(m.total)}</b></td></tr>`)
    .join('');
  $('#report-models').innerHTML = `<table class="usage-table"><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Footer line next to the PDF button: exactly what the PDF will contain. */
function renderReportScope(q, range) {
  const scope = $('#report-scope');
  if (!q.accountId) return void (scope.textContent = '');
  const account = $('#report-account').selectedOptions[0]?.textContent.replace(/ \(aktif\)$/, '') ?? '';
  scope.innerHTML = `PDF berisi persis yang tampil di atas: <b>${escapeHtml(account)}</b> · <b>${escapeHtml(rangeText(range))}</b> · per <b>${UNIT_NAME[q.groupBy]}</b>. Ditambah rincian per project, sumber (web/CLI) dan sesi teratas.`;
}

async function previewReport() {
  const range = reportRange();
  syncUnits(range);
  const q = reportQuery();
  $('#report-range').textContent = `📅 ${rangeText(range)}${report.period === 'all' && range.from ? ' (sejak catatan pertama)' : ''}`;
  renderReportNote(range);
  renderReportScope(q, range);
  if (!q.accountId) {
    showReportMessage('Belum ada pemakaian yang tercatat. Data mulai dikumpulkan sejak fitur ini aktif.');
    $('#report-pdf').disabled = true;
    return;
  }
  const seq = ++report.seq; // a slow answer must not overwrite a newer choice
  const box = $('#report-preview');
  box.classList.add('loading');
  try {
    const s = await api('/api/report/summary', q);
    if (seq !== report.seq) return;
    $('#report-pdf').disabled = false;
    if (!s.records) return showReportMessage('Tidak ada pemakaian di periode ini untuk akun tersebut.');
    showReportMessage(null);
    report.last = s;
    renderReportKpis(s.totals, s.records);
    renderTrend(s);
    renderReportModels(s.byModel);
  } catch (err) {
    if (seq === report.seq) showReportMessage(err.message, true);
  } finally {
    if (seq === report.seq) box.classList.remove('loading');
  }
}

async function downloadReport() {
  const btn = $('#report-pdf');
  btn.disabled = true;
  btn.textContent = 'Membuat PDF…';
  try {
    const res = await fetch('/api/report/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Office-Token': TOKEN },
      body: JSON.stringify(reportQuery()),
    });
    if (res.ok) {
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'laporan-token.pdf';
      saveBlob(name, await res.blob());
      toast('PDF diunduh.', 'ok');
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 501 && data.html) {
      // No Edge/Chrome for headless printing: let the browser print the same report.
      const win = window.open('', '_blank');
      if (!win) throw new Error('Pop-up diblokir — izinkan pop-up untuk mencetak laporan.');
      win.document.write(data.html);
      win.document.close();
      win.addEventListener('load', () => win.print());
      return;
    }
    throw new Error(data.error ?? `HTTP ${res.status}`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇ Unduh PDF';
  }
}

$('#btn-report').addEventListener('click', openReport);
$('#report-account').addEventListener('change', previewReport);
$('#report-periods').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-period]');
  if (btn) choosePeriod(btn.dataset.period);
});
$('#report-units').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-unit]');
  if (!btn || btn.disabled || btn.dataset.unit === report.unit) return;
  report.unit = btn.dataset.unit;
  previewReport();
});
$('#report-period-table').addEventListener('click', (e) => {
  if (!e.target.closest('[data-act="all-rows"]') || !report.last) return;
  report.allRows = !report.allRows;
  renderTrend(report.last);
});
for (const id of ['#report-from', '#report-to']) $(id).addEventListener('change', previewReport);
$('#report-pdf').addEventListener('click', downloadReport);

// ---------- server settings: auto-start, shutdown ----------

$('#autostart').addEventListener('change', async (e) => {
  try {
    const res = await api('/api/autostart', { enabled: e.target.checked });
    toast(res.enabled ? 'Server akan menyala otomatis saat Windows login.' : 'Auto-start dimatikan.', 'ok');
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message);
  }
});
$('#btn-shutdown').addEventListener('click', async () => {
  if (!window.confirm(`Matikan server ${APP_NAME}? Sesi Claude yang sedang berjalan ikut dihentikan.`)) return;
  await api('/api/shutdown').catch(() => {});
  toast('Server dimatikan. Jalankan start-office.cmd untuk menyalakan lagi.', 'ok');
});

// ---------- project folders (per device) ----------

function renderRoots(config) {
  if (!config) return;
  state.config = config;
  $('#autostart-row').hidden = !config.autostart?.supported;
  $('#autostart').checked = Boolean(config.autostart?.enabled);
  if (!$('#settings-modal').hidden) return; // don't clobber what the user is typing
  $('#roots-input').value = config.roots.join('\n');
  $('#roots-hint').textContent = config.usingDefault
    ? `Belum diatur — sekarang memakai folder default: ${config.defaultRoot}`
    : 'Disimpan di device ini. Folder yang pernah dibuka Claude Code juga ikut tampil.';
}

$('#btn-settings').addEventListener('click', () => {
  $('#roots-input').value = state.config?.roots.join('\n') ?? '';
  openModal('settings-modal');
});
$('#roots-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const roots = $('#roots-input').value.split('\n').map((r) => r.trim()).filter(Boolean);
  try {
    await api('/api/config', { roots });
    closeModal('settings-modal');
    toast(`Folder disimpan, ${roots.length || 1} folder dipindai.`, 'ok');
  } catch (err) {
    toast(err.message);
  }
});

$('#refresh-projects').addEventListener('click', () => api('/api/projects/refresh').catch((err) => toast(err.message)));
$('#add-project').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#add-project-path');
  try {
    const project = await api('/api/projects', { path: input.value.trim() });
    input.value = '';
    selectProject(project.id);
  } catch (err) {
    toast(err.message);
  }
});
// ---------- prompt history: ↑/↓ recall earlier prompts, like the CLI ----------

const recall = { project: null, index: -1, draft: '' };

/** This project's prompts, newest first, without repeats. */
function promptHistory() {
  const seen = new Set();
  return (state.chats[state.active] ?? [])
    .filter((m) => (m.kind === 'user' || m.kind === 'shell') && m.text)
    .map((m) => (m.kind === 'shell' ? `!${m.text}` : m.text))
    .reverse()
    .filter((text) => !seen.has(text) && seen.add(text));
}

/** @param dir -1 = older (↑), +1 = newer (↓). Returns true when the key was used for history. */
function recallPrompt(dir) {
  const input = $('#prompt');
  // Only from the first line (↑) or the last line (↓); elsewhere the arrows move the caret as usual.
  if (dir < 0 && input.value.slice(0, input.selectionStart).includes('\n')) return false;
  if (dir > 0 && input.value.slice(input.selectionEnd).includes('\n')) return false;
  if (recall.project !== state.active) Object.assign(recall, { project: state.active, index: -1, draft: '' });
  if (recall.index === -1) {
    if (dir > 0) return false;
    recall.draft = input.value; // what you were typing comes back after the newest prompt
  }
  const list = promptHistory();
  const next = recall.index - dir;
  if (next >= list.length) return list.length > 0; // already at the oldest
  recall.index = next;
  input.value = next === -1 ? recall.draft : list[next];
  input.setSelectionRange(input.value.length, input.value.length);
  autosize();
  updateBashMode();
  return true;
}

$('#prompt').addEventListener('input', () => (recall.index = -1));

$('#prompt').addEventListener('keydown', (e) => {
  const plainArrow = (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
  if (plainArrow && !suggest.items.length && recallPrompt(e.key === 'ArrowUp' ? -1 : 1)) {
    e.preventDefault();
    return;
  }
  if (suggest.items.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      suggest.index = (suggest.index + (e.key === 'ArrowDown' ? 1 : -1) + suggest.items.length) % suggest.items.length;
      renderSuggest();
      return;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      applySuggest();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSuggest();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendPrompt();
    return;
  }
  // Ctrl+R: search the prompt history (the browser's reload is not what you want while typing).
  if (e.key.toLowerCase() === 'r' && e.ctrlKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    searchHistory();
  }
});
// Ctrl+B anywhere: the running Bash commands / subagents carry on in the background, as in the CLI.
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'b' || !e.ctrlKey || e.shiftKey || e.altKey || state.active === DEMO_ID) return;
  if (!(state.statuses[state.active] ?? {}).busy) return;
  e.preventDefault();
  backgroundRunning();
});
// Esc stops the running turn, like in the CLI; Esc Esc when idle clears the box, or opens Rewind when it is empty.
let lastEsc = 0;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || suggest.items.length || state.active === DEMO_ID) return;
  if (document.querySelector('.modal:not([hidden])')) return; // Esc closes the dialog instead
  const st = state.statuses[state.active] ?? {};
  if (st.busy || st.queue) {
    api(`/api/projects/${state.active}/stop`).catch((err) => toast(err.message));
    return;
  }
  const now = Date.now();
  if (now - lastEsc > 500) {
    lastEsc = now;
    return;
  }
  lastEsc = 0;
  const input = $('#prompt');
  if (input.value.trim()) {
    input.value = '';
    autosize();
    updateBashMode();
    input.focus();
  } else openRewind();
});
// Shift+Tab cycles the permission mode, like in the CLI (only from the prompt box, so Tab navigation still works elsewhere).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !e.shiftKey || e.defaultPrevented || state.active === DEMO_ID) return; // defaultPrevented: Tab picked an autocomplete item
  if (e.target !== $('#prompt') && e.target !== document.body) return;
  e.preventDefault();
  cycleMode();
});
// Bash mode: a prompt starting with ! runs as a shell command; the box shows it.
function updateBashMode() {
  $('#composer').classList.toggle('bash-mode', $('#prompt').value.startsWith('!'));
}
$('#prompt').addEventListener('input', updateBashMode);
$('#btn-send').addEventListener('click', sendPrompt);
$('#btn-stop').addEventListener('click', () => api(`/api/projects/${state.active}/stop`).catch((err) => toast(err.message)));
$('#btn-new').addEventListener('click', () => {
  if (confirmNew()) api(`/api/projects/${state.active}/reset`).catch((err) => toast(err.message));
});
$('#btn-demo').addEventListener('click', () => api('/api/demo').catch((err) => toast(err.message)));
for (const id of ['#mode', '#model', '#effort', '#team-mode']) $(id).addEventListener('change', saveSettings);
document.querySelectorAll('.tabs button').forEach((btn) =>
  btn.addEventListener('click', () => {
    state.tab = btn.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    document.body.dataset.tab = state.tab; // phone layout shows the composer only on the chat tab
    $('.chat-wrap').hidden = state.tab !== 'chat';
    $('#changes').hidden = state.tab !== 'changes';
    if (state.tab === 'chat') scrollChat(true);
    if (state.tab === 'changes') loadChanges();
    $('#activity').hidden = state.tab !== 'activity';
  }),
);

function confirmNew() {
  const st = state.statuses[state.active] ?? {};
  if (!st.sessionId && !st.busy) return true;
  const busy = st.busy ? '\n\nTim sedang bekerja — pekerjaannya akan dihentikan.' : '';
  return window.confirm(`Mulai sesi baru?\n\nClaude tidak membawa konteks percakapan ini. Percakapan ini tetap bisa dilanjutkan lagi lewat 🕘 Riwayat sesi.${busy}`);
}

// ---------- rewind (Esc Esc, /rewind): Claude Code's checkpoints ----------

const rewindView = { project: null, points: [], selected: null, preview: null };
const shortDate = (ts) => (ts ? new Date(ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

async function openRewind() {
  if (state.active === DEMO_ID) return;
  if ((state.statuses[state.active] ?? {}).busy) return toast('Tim masih bekerja. Tekan Esc untuk menghentikan dulu, lalu Esc Esc.', 'warn');
  Object.assign(rewindView, { project: state.active, points: [], selected: null, preview: null });
  $('#rewind-list').innerHTML = '<li class="muted">Memuat percakapan…</li>';
  $('#rewind-detail').hidden = true;
  openModal('rewind-modal');
  try {
    rewindView.points = (await api(`/api/projects/${state.active}/rewind-points`)).points;
    renderRewindList();
  } catch (err) {
    $('#rewind-list').innerHTML = `<li class="muted"><div class="state-error">${escapeHtml(err.message)}</div></li>`;
  }
}

function renderRewindList() {
  const list = $('#rewind-list');
  if (!rewindView.points.length) {
    list.innerHTML = '<li class="muted">Belum ada pesan di percakapan ini yang bisa di-rewind.</li>';
    return;
  }
  list.innerHTML = rewindView.points
    .map((p, i) => `<li><button type="button" class="${rewindView.selected === p.uuid ? 'active' : ''}" data-uuid="${p.uuid}"><span class="rw-text">${escapeHtml(p.text)}</span><small>${i === 0 ? 'pesan terakhir · ' : ''}${shortDate(p.ts)}</small></button></li>`)
    .join('');
}

$('#rewind-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-uuid]');
  if (btn) selectRewind(btn.dataset.uuid);
});

async function selectRewind(uuid) {
  Object.assign(rewindView, { selected: uuid, preview: null });
  renderRewindList();
  renderRewindDetail();
  let preview;
  try {
    preview = await api(`/api/projects/${rewindView.project}/rewind-preview`, { uuid }); // dry run: which files would change back
  } catch (err) {
    preview = { canRewind: false, error: err.message };
  }
  if (rewindView.selected !== uuid) return;
  rewindView.preview = preview;
  renderRewindDetail();
}

function renderRewindDetail() {
  const box = $('#rewind-detail');
  const point = rewindView.points.find((p) => p.uuid === rewindView.selected);
  box.hidden = !point;
  if (!point) return;
  const pv = rewindView.preview;
  const files = pv?.filesChanged ?? [];
  const codeOk = Boolean(pv?.canRewind && files.length);
  const short = (f) => f.split(/[\\/]/).slice(-2).join('/');
  let summary;
  if (!pv) summary = '<span class="muted">Memeriksa perubahan file…</span>';
  else if (codeOk) {
    summary = `<b>${files.length} file</b> kembali seperti sebelum pesan ini <span class="add">+${pv.insertions ?? 0}</span> <span class="del">−${pv.deletions ?? 0}</span><ul class="rw-files">${files
      .slice(0, 8)
      .map((f) => `<li title="${escapeHtml(f)}">${escapeHtml(short(f))}</li>`)
      .join('')}${files.length > 8 ? `<li class="muted">+${files.length - 8} lainnya</li>` : ''}</ul>`;
  } else summary = `<span class="muted">${pv.canRewind ? 'Tidak ada file yang diubah sejak pesan ini.' : `Kode tidak bisa dikembalikan: ${escapeHtml(pv.error ?? 'tidak ada checkpoint untuk pesan ini')}`}</span>`;
  box.innerHTML = `<div class="rw-head">Kembali ke sebelum: <i>“${escapeHtml(point.text.slice(0, 200))}”</i></div><div class="rw-summary">${summary}</div>
    <div class="rw-actions">
      <button class="primary" data-rw="both" ${codeOk ? '' : 'disabled'}>⏪ Kode &amp; percakapan</button>
      <button data-rw="conversation">💬 Percakapan saja</button>
      <button data-rw="code" ${codeOk ? '' : 'disabled'}>📄 Kode saja</button>
    </div>`;
}

$('#rewind-detail').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-rw]');
  if (!btn || !rewindView.selected) return;
  const how = btn.dataset.rw;
  const body = { uuid: rewindView.selected, code: how !== 'conversation', conversation: how !== 'code' };
  $('#rewind-detail').querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const { text } = await api(`/api/projects/${rewindView.project}/rewind`, body);
    closeModal('rewind-modal');
    // As in the CLI, the rewound prompt comes back into the box to edit and resend.
    if (body.conversation && text) fillComposer(text);
    toast(body.conversation ? 'Dikembalikan. Pesanmu ada di kotak pesan untuk diedit.' : 'Kode dikembalikan.', 'ok');
  } catch (err) {
    toast(err.message);
    renderRewindDetail();
  }
});

// ---------- MCP servers (/mcp): headless Claude Code has no /mcp dialog, so it lives here ----------

const mcpView = { project: null, servers: [], login: null, poll: null };
const MCP_STATUS = { connected: ['✓ tersambung', 'ok'], 'needs-auth': ['🔑 perlu login', 'warn'], failed: ['✗ gagal', 'bad'], pending: ['… menyambung', ''], disabled: ['⏸ nonaktif', ''] };
const MCP_ORDER = ['needs-auth', 'failed', 'pending', 'connected', 'disabled'];

async function openMcp() {
  if (state.active === DEMO_ID) return;
  mcpView.project = state.active;
  $('#mcp-callback').hidden = true;
  openModal('mcp-modal');
  $('#mcp-list').innerHTML = '<li class="muted">Menanyakan status ke Claude Code…</li>';
  await loadMcp();
}

async function loadMcp(quiet = false, attempt = 0) {
  try {
    mcpView.servers = (await api(`/api/projects/${mcpView.project}/mcp`)).servers;
    renderMcp();
  } catch (err) {
    if (!quiet) $('#mcp-list').innerHTML = `<li class="muted"><div class="state-error">${escapeHtml(err.message)}</div></li>`;
    return;
  }
  // Servers still connecting right after Claude Code started: look again shortly, as /mcp updates live.
  clearTimeout(mcpView.again);
  if (attempt < 8 && mcpView.servers.some((s) => s.status === 'pending')) mcpView.again = setTimeout(() => !$('#mcp-modal').hidden && loadMcp(true, attempt + 1), 2500);
}

function renderMcp() {
  const rank = (s) => (MCP_ORDER.indexOf(s.status) + 1 || MCP_ORDER.length + 1);
  const servers = [...mcpView.servers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const count = (st) => servers.filter((s) => s.status === st).length;
  $('#mcp-summary').textContent = servers.length
    ? `· ${servers.length} server · ${count('connected')} tersambung${count('needs-auth') ? ` · ${count('needs-auth')} perlu login` : ''}${count('failed') ? ` · ${count('failed')} gagal` : ''}`
    : '';
  if (!servers.length) {
    $('#mcp-list').innerHTML = '<li class="muted">Belum ada server MCP. Tambahkan lewat <code>claude mcp add</code> atau sebuah plugin.</li>';
    return;
  }
  $('#mcp-list').innerHTML = servers
    .map((s) => {
      const [label, tone] = MCP_STATUS[s.status] ?? [s.status, ''];
      const actions = [
        s.status === 'needs-auth' ? '<button class="primary" data-mcp="login">🔑 Login</button>' : '',
        s.status !== 'disabled' ? '<button data-mcp="reconnect">↻ Sambungkan ulang</button>' : '',
        s.status === 'disabled' ? '<button data-mcp="enable">▶ Aktifkan</button>' : '<button data-mcp="disable">⏸ Nonaktifkan</button>',
      ].join('');
      const meta = [s.scope, s.tools != null ? `${s.tools} tool` : '', s.error].filter(Boolean).map(escapeHtml).join(' · ');
      return `<li data-server="${escapeHtml(s.name)}"><div class="mcp-main"><div class="mcp-row"><b>${escapeHtml(s.name)}</b><span class="pill ${tone}">${label}</span></div>${meta ? `<small class="muted">${meta}</small>` : ''}</div><div class="mcp-actions">${actions}</div></li>`;
    })
    .join('');
}

/** After a login, watch until the server is connected (the OAuth tab finishes on its own). */
function pollMcp(server) {
  clearInterval(mcpView.poll);
  let left = 40;
  mcpView.poll = setInterval(async () => {
    if ($('#mcp-modal').hidden || --left <= 0) return clearInterval(mcpView.poll);
    await loadMcp(true);
    if (mcpView.servers.find((s) => s.name === server)?.status === 'connected') {
      clearInterval(mcpView.poll);
      $('#mcp-callback').hidden = true;
      toast(`${server} tersambung.`, 'ok');
    }
  }, 3000);
}

$('#mcp-refresh').addEventListener('click', () => loadMcp());
$('#mcp-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-mcp]');
  if (!btn) return;
  const server = btn.closest('[data-server]').dataset.server;
  const action = btn.dataset.mcp;
  // Opened inside the click, or the browser blocks the pop-up; it gets its address once Claude Code answers.
  const tab = action === 'login' ? window.open('', '_blank') : null;
  btn.disabled = true;
  try {
    const r = await api(`/api/projects/${mcpView.project}/mcp-action`, { server, action });
    if (action !== 'login') {
      toast({ reconnect: `${server} disambungkan ulang.`, enable: `${server} diaktifkan.`, disable: `${server} dinonaktifkan.` }[action], 'ok');
      return loadMcp();
    }
    if (!r.authUrl) {
      tab?.close();
      toast(`${server} tidak perlu login lagi.`, 'ok');
      return loadMcp();
    }
    if (tab) {
      tab.opener = null;
      tab.location.href = r.authUrl;
    } else window.open(r.authUrl, '_blank', 'noopener');
    mcpView.login = server;
    // On the laptop the OAuth redirect to localhost reaches Claude Code by itself; on a phone it can't, so paste it.
    $('#mcp-callback').hidden = !(r.callbackExpected && !state.local);
    toast('Selesaikan login di tab yang terbuka. Status diperbarui otomatis.', 'warn');
    pollMcp(server);
  } catch (err) {
    tab?.close();
    toast(err.message);
    btn.disabled = false;
  }
});
$('#mcp-callback-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const callbackUrl = $('#mcp-callback-url').value.trim();
  if (!callbackUrl || !mcpView.login) return;
  try {
    await api(`/api/projects/${mcpView.project}/mcp-action`, { server: mcpView.login, action: 'callback', callbackUrl });
    $('#mcp-callback-url').value = '';
    $('#mcp-callback').hidden = true;
    pollMcp(mcpView.login);
  } catch (err) {
    toast(err.message);
  }
});

// ---------- tasks (/tasks, Ctrl+B): Bash commands and subagents Claude Code runs ----------

const tasksView = { project: null, outputs: new Map() };
const TASK_STATE = { completed: 'selesai', failed: 'gagal', stopped: 'dihentikan', killed: 'dihentikan', paused: 'dijeda', pending: 'menunggu' };

function openTasks() {
  if (state.active === DEMO_ID) return;
  tasksView.project = state.active;
  tasksView.outputs.clear();
  renderTasks();
  openModal('tasks-modal');
}

function renderTasks() {
  const st = state.statuses[tasksView.project] ?? {};
  const tasks = st.tasks ?? [];
  $('#tasks-background').disabled = !st.busy;
  if (!tasks.length) {
    $('#tasks-list').innerHTML = '<li class="muted">Belum ada tugas di sesi ini. Tugas muncul saat Claude menjalankan perintah atau agent, misalnya dev server di latar belakang.</li>';
    return;
  }
  $('#tasks-list').innerHTML = tasks
    .map((t) => {
      const running = t.status === 'running';
      const meta = [t.agent, running ? (t.background ? 'berjalan di latar' : 'berjalan') : (TASK_STATE[t.status] ?? t.status), t.toolUses ? `${t.toolUses} langkah` : '', t.tokens ? `${fmtTokens(t.tokens)} token` : '']
        .filter(Boolean)
        .join(' · ');
      const out = tasksView.outputs.get(t.id);
      return `<li data-task="${escapeHtml(t.id)}"><div class="task-row">${t.kind === 'agent' ? '🤖' : '🖥'} <b>${escapeHtml(t.description || t.id)}</b>${running ? '<span class="spinner"></span>' : ''}</div><small class="muted">${escapeHtml(meta)}${t.summary ? ` — ${escapeHtml(t.summary)}` : ''}${t.error ? ` — ${escapeHtml(t.error)}` : ''}</small><div class="task-actions">${t.kind === 'shell' ? `<button data-task-act="output">📄 ${out != null ? 'Muat ulang output' : 'Lihat output'}</button>` : ''}${running ? '<button class="danger" data-task-act="stop">■ Hentikan</button>' : ''}</div>${out != null ? `<pre class="task-out">${escapeHtml(out || '(belum ada output)')}</pre>` : ''}</li>`;
    })
    .join('');
}

$('#tasks-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-task-act]');
  if (!btn) return;
  const taskId = btn.closest('[data-task]').dataset.task;
  btn.disabled = true;
  try {
    if (btn.dataset.taskAct === 'output') {
      const r = await api(`/api/projects/${tasksView.project}/task-output`, { taskId });
      tasksView.outputs.set(taskId, `${r.truncated ? '… (hanya 8 KB terakhir)\n' : ''}${r.output ?? ''}`);
    } else {
      await api(`/api/projects/${tasksView.project}/task-stop`, { taskId });
      toast('Tugas dihentikan.', 'ok');
    }
  } catch (err) {
    toast(err.message);
  }
  renderTasks();
});

function backgroundRunning() {
  api(`/api/projects/${state.active}/background`)
    .then(() => toast('Dipindahkan ke latar belakang. Kamu bisa lanjut chat.', 'ok'))
    .catch((err) => toast(err.message));
}
$('#tasks-background').addEventListener('click', backgroundRunning);

// ---------- resizable chat panel (desktop) ----------

const PANEL_MIN = 340; // narrower and the composer controls wrap badly
const PANEL_MAX = 960;
const OFFICE_MIN = 480; // the office keeps at least this much room
const panelBounds = () => [PANEL_MIN, Math.max(PANEL_MIN, Math.min(PANEL_MAX, window.innerWidth - OFFICE_MIN))];

function setPanelWidth(px, persist = true) {
  const layout = $('.layout');
  if (px == null) {
    layout.style.removeProperty('--panel-w'); // back to the CSS default (410px / 380px)
    if (persist) try { localStorage.removeItem('office.panelWidth'); } catch {}
    return;
  }
  const [min, max] = panelBounds();
  const width = Math.round(Math.min(max, Math.max(min, px)));
  layout.style.setProperty('--panel-w', `${width}px`);
  if (persist) try { localStorage.setItem('office.panelWidth', String(width)); } catch {}
}

{
  const resizer = $('#panel-resizer');
  const saved = (() => { try { return Number(localStorage.getItem('office.panelWidth')); } catch { return 0; } })();
  if (saved) setPanelWidth(saved, false);

  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    // The panel sits on the right, so its width is the distance from the pointer to the window's right edge.
    const onMove = (ev) => setPanelWidth(window.innerWidth - ev.clientX, false);
    const onUp = () => {
      resizer.removeEventListener('pointermove', onMove);
      document.body.classList.remove('resizing');
      setPanelWidth($('.panel').getBoundingClientRect().width);
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onUp, { once: true });
    resizer.addEventListener('pointercancel', onUp, { once: true });
  });
  resizer.addEventListener('dblclick', () => setPanelWidth(null));
  resizer.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 20;
    const width = $('.panel').getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') setPanelWidth(width + step);
    else if (e.key === 'ArrowRight') setPanelWidth(width - step);
    else return;
    e.preventDefault();
  });
  // Re-clamp a saved width when the window shrinks, without overwriting the preference.
  window.addEventListener('resize', () => {
    const want = (() => { try { return Number(localStorage.getItem('office.panelWidth')); } catch { return 0; } })();
    if (want) setPanelWidth(want, false);
  });
}

// ---------- main loop ----------

let last = performance.now();
let lastTeam = 0;
function loop(t) {
  const dt = Math.min((t - last) / 1000, 0.05);
  last = t;
  for (const scene of scenes.values()) scene.update(dt, t);
  stage.frame(t);
  if (t - lastTeam > 500) {
    renderTeam();
    lastTeam = t;
  }
  requestAnimationFrame(loop);
}

connect();
requestAnimationFrame(loop);
