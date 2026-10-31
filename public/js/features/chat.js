// The chat log: messages, tool rows, follow-the-bottom scrolling.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { fmtTokens, time } from '../core/format.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { copyText, flashButton } from '../core/util.js';
import { renderMarkdown } from '../markdown.js';
import { CAST, roleColor, roleName } from '../office/cast.js';
import { avatarURL } from '../office/sprites.js';
import { openModal } from '../ui/modals.js';
import { fillApproval } from './approvals.js';
import { fillComposer } from './composer.js';
import { openSessions } from './sessions.js';

// ---------- chat ----------

const chatEl = $('#chat');

// One click fills the composer with a ready-made request (still editable before sending).
const STARTERS = [
  ['🧭', 'Jelaskan project ini', 'Jelaskan struktur, teknologi, dan alur utama project ini secara singkat.'],
  ['🐞', 'Cari bug', 'Cari bug atau potensi masalah di project ini, urutkan dari yang paling berisiko, lalu usulkan perbaikannya.'],
  ['🧪', 'Tambah test', 'Tulis test untuk bagian penting yang belum punya test, lalu jalankan.'],
  ['🔍', 'Review perubahan', 'Review perubahan yang belum di-commit: cari bug, risiko keamanan, dan bagian yang bisa dirapikan.'],
];

export function renderChat() {
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

export function scrollChat(force) {
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

export function appendChat(msg, scroll = true) {
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

export function replaceChat(msg) {
  const node = chatEl.querySelector(`[data-id="${msg.id}"]`);
  if (!node) return;
  fillChat(node, msg);
  if (msg.kind === 'user') markLatestUser();
  scrollChat(msg.kind === 'approval' && msg.status === 'pending');
}

/** Only the newest prompt offers "Ulangi", so an old one is never re-sent by a stray tap. */
function markLatestUser() {
  const users = chatEl.querySelectorAll('.msg.user');
  users.forEach((node, i) => node.classList.toggle('latest', i === users.length - 1));
}

// Tool/delegate rows the user has expanded stay open across live updates.
const expanded = new Set();

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

export function who(role) {
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

export function initChat() {
  // We only ever scroll to the very bottom, so a scroll that leaves the bottom is the user's.
  chatEl.addEventListener('scroll', () => {
    followChat = distanceFromBottom() < 60;
    $('#jump-latest').hidden = followChat;
  });

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

  $('#jump-latest').addEventListener('click', () => scrollChat(true));
}
