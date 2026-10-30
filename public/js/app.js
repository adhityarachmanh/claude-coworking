// Claude Coworking web app: project picker, chat with Claude Code, approvals, live office.
import { renderMarkdown } from './markdown.js';
import { qrSvg } from './qr.js';
import { CAST, ROLE_ORDER, roleColor, roleName } from './office/cast.js';
import { Scene } from './office/scene.js';
import { avatarURL } from './office/sprites.js';
import { Stage, escapeHtml } from './office/stage.js';

const TOKEN = document.querySelector('meta[name="office-token"]').content;
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
    if (!$('#phone-modal').hidden) {
      phone.pairing = null; // a device just paired (codes are single-use) or settings changed
      refreshPairing();
    }
  });
  on('snapshot', (snap) => {
    // Opened from a paired phone: laptop-only settings are hidden (the server refuses them anyway).
    state.local = snap.client?.local !== false;
    document.body.classList.toggle('remote-client', !state.local);
    $('#btn-phone').hidden = !state.local;
    renderRoots(snap.config);
    state.projects = snap.projects;
    state.statuses = snap.statuses;
    state.chats = snap.chats;
    state.events = snap.events;
    state.approvals = new Map(snap.approvals.map((a) => [a.id, a]));
    scenes.clear();
    const remembered = location.hash.slice(1) || localStorage.getItem('office.active');
    selectProject(state.projects.some((p) => p.id === remembered) ? remembered : DEMO_ID);
  });
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
  if (p.id === DEMO_ID) return 4;
  if (st.pending) return 3;
  if (st.busy || st.cliBusy) return 2;
  if (st.alive) return 1;
  return 0;
}

function renderSidebar() {
  const q = state.search.toLowerCase();
  const list = state.projects
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.path ?? '').toLowerCase().includes(q))
    .sort((a, b) => projectRank(b) - projectRank(a) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || Number(b.sources.includes('claude')) - Number(a.sources.includes('claude')) || a.name.localeCompare(b.name));
  $('#project-list').innerHTML = list
    .map((p) => {
      const st = state.statuses[p.id] ?? {};
      const badge = st.pending
        ? `<span class="badge ask">${st.pending}</span>`
        : st.busy || st.cliBusy
          ? `${st.cliBusy ? '<span class="cli-tag">CLI</span>' : ''}<span class="spinner"></span>`
          : st.alive
            ? '<span class="dot live"></span>'
            : '';
      const icon = p.id === DEMO_ID ? '🎬' : p.sources.includes('claude') ? '✳' : '▢';
      return `<li class="${p.id === state.active ? 'active' : ''}" data-id="${p.id}" title="${escapeHtml(p.path ?? 'Simulasi tanpa Claude Code')}">
        <span class="p-icon">${icon}</span>
        <span class="p-text"><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.path ? p.path.replace(/^.*\/projects\//, '…/') : 'simulasi')}</small></span>
        ${badge}
        ${p.sources.includes('custom') ? '<button class="forget" title="Hapus dari daftar">×</button>' : ''}
      </li>`;
    })
    .join('');
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
  $('#sessions-panel').hidden = true;
  closeSuggest();
  changes.selected = null;
  $('#ch-diff').innerHTML = '';
  loadChanges();
  document.body.classList.remove('sidebar-open');
}

function renderHeader() {
  const p = state.projects.find((x) => x.id === state.active);
  $('#crumb').innerHTML = p ? `<b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.path ?? 'Demo — tidak menjalankan Claude Code')}</small>` : '';
}

function updateTitle() {
  const pending = [...state.approvals.values()].filter((a) => a.status === 'pending').length;
  document.title = pending ? `(${pending}) Menunggu izin — Claude Coworking` : 'Claude Coworking';
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

// Tapping outside the project drawer closes it.
document.addEventListener('click', (e) => {
  if (document.body.classList.contains('sidebar-open') && !e.target.closest('.sidebar, #toggle-sidebar')) {
    document.body.classList.remove('sidebar-open');
  }
});

// A shorter hint fits a phone-width composer on one line.
const narrow = matchMedia('(max-width: 760px)');
const applyPlaceholder = () => {
  $('#prompt').placeholder = narrow.matches ? 'Ketik pesan…  ( / command · @file )' : 'Minta sesuatu ke tim…   ( / command · @file · Shift+Enter baris baru )';
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

function renderChat() {
  chatEl.innerHTML = '';
  const messages = state.chats[state.active] ?? [];
  if (!messages.length) {
    chatEl.innerHTML = state.active === DEMO_ID
      ? '<div class="empty"><b>Demo kantor</b><p>Klik <b>▶ Jalankan demo</b> untuk melihat tim bekerja: delegasi, layar monitor, error, sampai minta izin.</p></div>'
      : '<div class="empty"><b>Mulai kerja di project ini</b><p>Ketik permintaan di bawah. Claude Code berjalan langsung di folder project ini, dan setiap aksi yang butuh izin muncul sebagai kartu di sini.</p></div>';
  }
  for (const msg of messages) appendChat(msg, false);
  scrollChat(true);
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
  chatEl.querySelector('.empty')?.remove();
  const node = document.createElement('div');
  node.dataset.id = msg.id;
  fillChat(node, msg);
  chatEl.append(node);
  // Your own prompt and anything waiting for your decision always come into view.
  const mustSee = msg.kind === 'approval' || (msg.kind === 'user' && msg.source === 'web');
  if (scroll) scrollChat(mustSee);
}

function replaceChat(msg) {
  const node = chatEl.querySelector(`[data-id="${msg.id}"]`);
  if (!node) return;
  fillChat(node, msg);
  scrollChat(msg.kind === 'approval' && msg.status === 'pending');
}

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

const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

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
  if (msg.kind === 'delegate' && input.prompt) parts.push(`<div class="label">Instruksi dari Claude</div><div class="md sub">${renderMarkdown(input.prompt)}</div>`);
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
      node.className = `msg user ${msg.source === 'cli' ? 'cli' : ''} ${msg.history ? 'history' : ''}`;
      node.innerHTML = `<div class="body">${escapeHtml(msg.text).replace(/\n/g, '<br>')}</div><div class="meta">${tags.map((t) => `<span class="tag">${t}</span>`).join('')}${time(msg.ts)}</div>`;
      break;
    }
    case 'assistant':
      if (!msg.text && !msg.streaming) {
        node.className = 'hidden-msg';
        node.innerHTML = '';
        break;
      }
      node.className = `msg assistant ${msg.streaming ? 'streaming' : ''} ${msg.history ? 'history' : ''}`;
      node.innerHTML = `<div class="who">${who('claude')}${msg.source === 'cli' ? '<span class="cli-tag">CLI</span>' : ''}${msg.history ? '<span class="tag">riwayat</span>' : ''}<span>${time(msg.ts)}</span></div><div class="body md">${renderMarkdown(msg.text)}</div>`;
      break;
    case 'tool': {
      const open = expanded.has(msg.id);
      node.className = `line tool expandable st-${msg.status} ${open ? 'open' : ''} ${msg.sub ? 'sub' : ''}`;
      node.innerHTML = `<div class="row" title="Klik untuk detail"><span class="chev">${open ? '▾' : '▸'}</span><span class="dot" style="background:${roleColor(msg.role)}"></span><span class="who-s">${roleName(msg.role)}</span><span class="txt">${escapeHtml(msg.text)}</span>${STATUS_ICON[msg.status] ?? ''}</div>${open ? `<div class="detail">${toolDetail(msg)}</div>` : ''}`;
      break;
    }
    case 'delegate': {
      const open = expanded.has(msg.id);
      node.className = `line delegate expandable st-${msg.status} ${open ? 'open' : ''}`;
      node.innerHTML = `<div class="row" title="Klik untuk instruksi & laporan"><span class="chev">${open ? '▾' : '▸'}</span><img class="ava sm" src="${avatarURL(CAST[msg.role]?.look ?? CAST.claude.look)}" alt=""><span class="txt"><b style="color:${roleColor(msg.role)}">${roleName(msg.role)}</b> ditugaskan: ${escapeHtml(msg.text)}</span>${STATUS_ICON[msg.status] ?? ''}</div>${open ? `<div class="detail">${toolDetail(msg)}</div>` : ''}`;
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
      node.className = 'info';
      node.textContent = msg.text;
  }
}

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
    body = (input.questions ?? [])
      .map((q, qi) => `<div class="q"><b>${escapeHtml(q.question)}</b><div class="opts">${(q.options ?? [])
        .map((o) => `<label><input type="${q.multiSelect ? 'checkbox' : 'radio'}" name="q${qi}" value="${escapeHtml(o.label)}"> <span><b>${escapeHtml(o.label)}</b>${o.description ? ` — ${escapeHtml(o.description)}` : ''}</span></label>`)
        .join('')}</div></div>`)
      .join('');
    actions = '<button class="primary" data-act="answer">Kirim jawaban</button><button data-act="deny">Lewati</button>';
  } else if (approval.kind === 'plan') {
    body = `<div class="plan md">${renderMarkdown(input.plan ?? '')}</div><input class="feedback" placeholder="Catatan revisi (opsional, untuk Tolak)">`;
    actions = '<button class="primary" data-act="allow">Setujui rencana</button><button data-act="deny">Minta revisi</button>';
  } else {
    if (input.command) body = `<pre>${escapeHtml(input.command)}</pre>${input.description ? `<p class="muted">${escapeHtml(input.description)}</p>` : ''}`;
    else if (input.content != null) body = `<p class="path">${escapeHtml(input.file_path)}</p><pre>${escapeHtml(input.content)}</pre>`;
    else if (input.old_string != null) body = `<p class="path">${escapeHtml(input.file_path)}</p><pre class="del">${escapeHtml(input.old_string)}</pre><pre class="add">${escapeHtml(input.new_string)}</pre>`;
    else if (input.url) body = `<pre>${escapeHtml(input.url)}</pre>`;
    else body = `<pre>${escapeHtml(input.json ?? JSON.stringify(input, null, 2))}</pre>`;
    actions = `<button class="primary" data-act="allow">Izinkan</button>${approval.canAlways ? '<button data-act="always" title="Simpan aturan izin agar tidak ditanya lagi">Izinkan selalu</button>' : ''}<button data-act="all" title="Semua aksi berikutnya di sesi ini otomatis diizinkan">Izinkan semua (sesi ini)</button><button class="danger" data-act="deny">Tolak</button>`;
  }
  node.innerHTML = `${head}<div class="ap-label">${escapeHtml(approval.description || msg.text)}</div>${body}<div class="ap-actions">${actions}</div>`;
  node.querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', () => decide(approval, btn.dataset.act, node)),
  );
}

async function decide(approval, act, node) {
  const body = { allow: act !== 'deny' };
  if (act === 'always') body.always = true;
  if (act === 'all') body.allowAll = true;
  if (act === 'deny') body.message = node.querySelector('.feedback')?.value || undefined;
  if (act === 'answer') {
    const answers = {};
    (approval.input.questions ?? []).forEach((q, qi) => {
      const picked = [...node.querySelectorAll(`input[name="q${qi}"]:checked`)].map((i) => i.value);
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

const KIND_ICON = { prompt: '💬', delegate: '➜', agent_stop: '✓', tool_start: '•', tool_fail: '✗', ask: '✋', ask_done: '👍', stop: '🎉', error: '⚠', say: '💭' };

function appendActivity(evt, prepend) {
  if (!KIND_ICON[evt.kind]) return;
  const li = document.createElement('li');
  li.className = `k-${evt.kind}`;
  const text = evt.kind === 'delegate' ? `→ ${evt.agentType}: ${evt.label}` : evt.kind === 'say' ? evt.text : evt.label ?? '';
  li.innerHTML = `<time>${time(evt.ts)}</time><span class="dot" style="background:${roleColor(evt.role)}"></span><span><b>${roleName(evt.role)}</b> ${KIND_ICON[evt.kind]} ${escapeHtml(text)}</span>`;
  const list = $('#activity');
  if (prepend) list.prepend(li);
  else list.append(li);
  while (list.children.length > 200) list.lastElementChild.remove();
}

function renderActivity() {
  $('#activity').innerHTML = '';
  for (const evt of [...(state.events[state.active] ?? [])].reverse()) appendActivity(evt, false);
}

// ---------- team strip ----------

function renderTeam() {
  const scene = scenes.get(state.active);
  if (!scene) return;
  const now = performance.now();
  $('#team').innerHTML = ROLE_ORDER.map((id) => {
    const p = scene.people[id];
    const [cls, text] = p.asking
      ? ['ask', 'Menunggu izinmu']
      : now < p.flashUntil
        ? ['err', 'Ketemu error']
        : p.isBusy(now)
          ? ['work', p.seated ? 'Bekerja' : 'Menuju meja']
          : p.onSofa || p.x > 440
            ? ['idle', 'Istirahat ☕']
            : p.plan.length
              ? ['idle', 'Jalan-jalan']
              : ['idle', 'Standby'];
    const tip = `${CAST[id].name} — ${CAST[id].title}\n${text}${p.task ? `\n${p.task}` : ''}`;
    return `<div class="member ${cls}" style="--c:${CAST[id].color}" title="${escapeHtml(tip)}">
      <img src="${avatarURL(CAST[id].look)}" alt="">
      <div><b>${CAST[id].name}</b><small>${CAST[id].title}</small><span class="st">${p.task && cls !== 'idle' ? escapeHtml(p.task) : text}</span></div>
    </div>`;
  }).join('');
}

// ---------- composer ----------

function renderComposer() {
  const isDemo = state.active === DEMO_ID;
  const st = state.statuses[state.active] ?? {};
  $('#composer').classList.toggle('demo', isDemo);
  $('#btn-stop').hidden = isDemo || !(st.busy || st.queue);
  $('#mode').value = st.mode ?? 'manual';
  $('#model').value = st.model ?? '';
  $('#team-mode').checked = st.team ?? true;
  const hint = [];
  if (st.busy) hint.push('Tim sedang bekerja — pesan baru akan masuk antrean.');
  if (st.cliBusy) hint.push('Sesi CLI sedang berjalan di terminal (izinnya dijawab di terminal).');
  if (st.autoApprove) hint.push('⚠ Semua izin otomatis di sesi ini.');
  if (st.sessionId) hint.push(`Sesi web ${st.sessionId.slice(0, 8)}${st.activeModel ? ` · ${st.activeModel}` : ''}`);
  $('#composer-hint').textContent = hint.join('  ·  ');
  $('#typing').hidden = !(st.busy || st.cliBusy);
  $('#typing-text').textContent = st.busy ? 'Tim sedang bekerja…' : 'Claude Code (terminal) sedang bekerja…';
}

async function sendPrompt() {
  const input = $('#prompt');
  const text = input.value.trim();
  if ((!text && !attachments.length) || state.active === DEMO_ID) return;
  const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  input.value = '';
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
    .map((a, i) => `<div class="thumb"><img src="${a.url}" alt=""><button data-i="${i}" title="Hapus">×</button></div>`)
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
  box.innerHTML = suggest.items
    .map((item, i) => `<div class="opt ${i === suggest.index ? 'active' : ''}" data-i="${i}">${suggest.kind === 'slash' ? `<b>/</b>${escapeHtml(item)}` : `<span class="at">@</span>${escapeHtml(item)}`}</div>`)
    .join('');
  box.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function applySuggest(i = suggest.index) {
  const input = $('#prompt');
  const item = suggest.items[i];
  if (item == null) return;
  const insert = suggest.kind === 'slash' ? `/${item} ` : `@${item} `;
  input.value = input.value.slice(0, suggest.start) + insert + input.value.slice(suggest.end);
  const caret = suggest.start + insert.length;
  input.setSelectionRange(caret, caret);
  input.focus();
  closeSuggest();
}

function updateSuggest() {
  const input = $('#prompt');
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const slash = before.match(/^\/([\w:.-]*)$/);
  if (slash) {
    const q = slash[1].toLowerCase();
    const list = (state.config?.slashCommands ?? []).filter((c) => c.toLowerCase().includes(q));
    list.sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)) || a.localeCompare(b));
    return showSuggest('slash', list.slice(0, 12), 0, caret);
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

// ---------- session history ----------

async function toggleSessions() {
  const panel = $('#sessions-panel');
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.innerHTML = '<div class="muted">Memuat riwayat sesi…</div>';
  try {
    const { sessions, current } = await api(`/api/projects/${state.active}/sessions`);
    panel.innerHTML = sessions.length
      ? `<div class="sessions-head">Lanjutkan sesi Claude Code di project ini</div>${sessions
          .map(
            (s) => `<button class="session ${s.id === current ? 'current' : ''}" data-id="${s.id}">
              <span class="s-title">${escapeHtml(s.title)}</span>
              <span class="s-meta"><span class="cli-tag">${s.source === 'web' ? 'WEB' : 'CLI'}</span> ${new Date(s.updated).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })}${s.id === current ? ' · <b>sesi aktif</b>' : ''}</span>
            </button>`,
          )
          .join('')}`
      : '<div class="muted">Belum ada sesi Claude Code untuk project ini.</div>';
  } catch (err) {
    panel.innerHTML = `<div class="muted">Gagal memuat: ${escapeHtml(err.message)}</div>`;
  }
}

$('#btn-sessions').addEventListener('click', toggleSessions);
$('#jump-latest').addEventListener('click', () => scrollChat(true));
$('#sessions-panel').addEventListener('click', async (e) => {
  const btn = e.target.closest('.session[data-id]');
  if (!btn || btn.classList.contains('current')) return;
  const st = state.statuses[state.active] ?? {};
  const warn = st.cliBusy ? '\n\nPerhatian: ada sesi CLI yang sedang berjalan di project ini. Jangan lanjutkan sesi yang sama di dua tempat sekaligus.' : '';
  if (!window.confirm(`Lanjutkan sesi ini dari web?${warn}`)) return;
  try {
    await api(`/api/projects/${state.active}/resume`, { sessionId: btn.dataset.id });
    $('#sessions-panel').hidden = true;
  } catch (err) {
    toast(err.message);
  }
});

async function saveSettings() {
  try {
    await api(`/api/projects/${state.active}/settings`, { mode: $('#mode').value, model: $('#model').value, team: $('#team-mode').checked });
  } catch (err) {
    toast(err.message);
  }
}

// ---------- wiring ----------

$('#project-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
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
  btn.textContent = notifyState.on ? '🔔' : '🔕';
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

const changes = { selected: null, timer: null, data: null };

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
    $('#ch-branch').textContent = '';
    list.innerHTML = '<li class="empty-line">Demo tidak punya repository. Pilih project sungguhan.</li>';
    $('#ch-diff').innerHTML = '';
    $('#changes-count').hidden = true;
    $('#nav-badge-changes').hidden = true;
    return;
  }
  let data;
  try {
    data = await api(`/api/projects/${project}/changes`);
  } catch (err) {
    list.innerHTML = `<li class="empty-line">Gagal membaca git: ${escapeHtml(err.message)}</li>`;
    return;
  }
  if (project !== state.active) return;
  changes.data = data;
  const count = data.files?.length ?? 0;
  for (const badge of [$('#changes-count'), $('#nav-badge-changes')]) {
    badge.hidden = !count;
    badge.textContent = count;
  }
  if (!data.repo) {
    $('#ch-branch').textContent = '';
    list.innerHTML = `<li class="empty-line">${data.error ? escapeHtml(data.error) : 'Folder ini bukan repository git. Jalankan <code>git init</code> untuk memakai panel ini.'}</li>`;
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
  list.innerHTML = data.files
    .map((f) => `<li class="${f.path === changes.selected ? 'active' : ''}" data-path="${escapeHtml(f.path)}"><span class="st st-${f.code.trim()[0] === '?' ? 'A' : escapeHtml(f.code.trim()[0])}">${escapeHtml(f.status)}</span><span class="p">${escapeHtml(f.path)}</span></li>`)
    .join('');
  loadDiff(changes.selected);
}

async function loadDiff(file) {
  changes.selected = file;
  const box = $('#ch-diff');
  try {
    const { diff, error, truncated } = await api(`/api/projects/${state.active}/diff`, { file });
    box.innerHTML = error && !diff ? `<div class="muted">${escapeHtml(error)}</div>` : `<pre>${renderDiff(diff)}</pre>${truncated ? '<div class="muted">Diff dipotong (terlalu besar).</div>' : ''}`;
  } catch (err) {
    box.innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
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
  $('#ch-files .active')?.classList.remove('active');
  li.classList.add('active');
  loadDiff(li.dataset.path);
});
$('#ch-refresh').addEventListener('click', loadChanges);
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
  if (!window.confirm('Matikan server Claude Coworking? Sesi Claude yang sedang berjalan ikut dihentikan.')) return;
  await api('/api/shutdown').catch(() => {});
  toast('Server dimatikan. Jalankan start-office.cmd untuk menyalakan lagi.', 'ok');
});

// ---------- project folders (per device) ----------

function renderRoots(config) {
  if (!config) return;
  state.config = config;
  $('#autostart-row').hidden = !config.autostart?.supported;
  $('#autostart').checked = Boolean(config.autostart?.enabled);
  if (!$('#roots-form').hidden) return; // don't clobber what the user is typing
  $('#roots-input').value = config.roots.join('\n');
  $('#roots-hint').textContent = config.usingDefault
    ? `Belum diatur — sekarang memakai folder default: ${config.defaultRoot}`
    : 'Disimpan di device ini. Folder yang pernah dibuka Claude Code juga ikut tampil.';
}

$('#toggle-roots').addEventListener('click', () => {
  const form = $('#roots-form');
  form.hidden = !form.hidden;
  if (!form.hidden) {
    $('#roots-input').value = state.config?.roots.join('\n') ?? '';
    $('#roots-input').focus();
  }
});
$('#roots-cancel').addEventListener('click', () => ($('#roots-form').hidden = true));
$('#roots-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const roots = $('#roots-input').value.split('\n').map((r) => r.trim()).filter(Boolean);
  try {
    await api('/api/config', { roots });
    $('#roots-form').hidden = true;
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
$('#prompt').addEventListener('keydown', (e) => {
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
  }
});
// Esc stops the running turn, like in the CLI.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || suggest.items.length || state.active === DEMO_ID) return;
  const st = state.statuses[state.active] ?? {};
  if (st.busy || st.queue) api(`/api/projects/${state.active}/stop`).catch((err) => toast(err.message));
});
$('#btn-send').addEventListener('click', sendPrompt);
$('#btn-stop').addEventListener('click', () => api(`/api/projects/${state.active}/stop`).catch((err) => toast(err.message)));
$('#btn-new').addEventListener('click', () => {
  if (confirmNew()) api(`/api/projects/${state.active}/reset`).catch((err) => toast(err.message));
});
$('#btn-demo').addEventListener('click', () => api('/api/demo').catch((err) => toast(err.message)));
for (const id of ['#mode', '#model', '#team-mode']) $(id).addEventListener('change', saveSettings);
$('#toggle-sidebar').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
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
  return !st.sessionId || window.confirm('Mulai sesi baru? Claude tidak akan mengingat percakapan sebelumnya di project ini.');
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
