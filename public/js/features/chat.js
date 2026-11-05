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
import { attachmentChip, attachmentPayload, putBackAttachments, recallSent, rememberSent } from './attachments.js';
import { fillComposer } from './composer.js';
import { fileLinkHtml, linkifyPaths } from './file-viewer.js';
import { afterRowRender, isLiveShell, liveBlock, liveTail, resetLiveOutput, saveLiveScroll } from './live-output.js';
import { openSessions } from './sessions.js';
import { stuckChip } from './stuck.js';

// ---------- chat ----------

const chatEl = $('#chat');

// One click fills the composer with a ready-made request (still editable before sending).
const STARTERS = [
  ['🧭', 'Jelaskan', 'Jelaskan struktur, teknologi, dan alur utama project ini secara singkat.'],
  ['🐞', 'Cari bug', 'Cari bug atau potensi masalah di project ini, urutkan dari yang paling berisiko, lalu usulkan perbaikannya.'],
  ['🧪', 'Tambah test', 'Tulis test untuk bagian penting yang belum punya test, lalu jalankan.'],
  ['🔍', 'Review', 'Review perubahan yang belum di-commit: cari bug, risiko keamanan, dan bagian yang bisa dirapikan.'],
];

// The row shown for each message id (the newest wins: chats stored before ids were unique across server
// restarts can hold one id twice, and live updates always belong to the newest), and the message behind each row.
const rows = new Map();
const rowMsg = new WeakMap();

export function renderChat() {
  chatEl.innerHTML = '';
  rows.clear();
  resetLiveOutput();
  pendingReplace.clear();
  const messages = state.chats[state.active] ?? [];
  if (!messages.length) {
    chatEl.innerHTML = state.active === DEMO_ID
      ? '<div class="empty"><div class="empty-icon">🎬</div><b>Demo kantor</b><p>Klik <b>▶ Jalankan demo</b> untuk melihat tim bekerja. Demo tidak menjalankan Claude Code.</p></div>'
      : `<div class="empty">
          <div class="empty-icon">✳</div>
          <b>Mulai kerja di ${escapeHtml(projectName(state.active))}</b>
          <p>Claude Code berjalan di folder ini. Izin muncul sebagai kartu di chat.</p>
          <div class="starters">${STARTERS.map(([icon, label, text]) => `<button data-starter="${escapeHtml(text)}" title="${escapeHtml(text)}"><span>${icon}</span>${label}</button>`).join('')}</div>
          <div class="empty-links"><button class="text-btn" data-open-history>🕘 Lanjutkan sesi sebelumnya</button><button class="text-btn" data-open-help>❓ Panduan &amp; shortcut</button></div>
        </div>`;
  }
  for (const msg of messages) appendChat(msg, false);
  if (messages.length) scrollChat(true);
  else {
    chatEl.scrollTop = 0; // the welcome card reads from the top
    pinnedTop = Infinity; // nothing pinned: a scroll here is judged by position alone
    $('#jump-latest').hidden = true;
  }
}

// Chat follows the newest message unless the user scrolls up to read; "↓ Terbaru" resumes following.
let followChat = true;
// Where the chat was last put at the bottom (by us, or by the user scrolling there). A scroll event that is not at
// the bottom yet not above this point was not the user scrolling up: the bottom moved under us. That happens on
// every renderChat (project switch): the rebuild resets scrollTop, and rows with `content-visibility: auto` are
// laid out at an 80px estimate first, so "bottom" grows a frame later and the scroll event lands mid-chat.
let pinnedTop = 0;
const distanceFromBottom = () => chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;

function pinToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
  pinnedTop = chatEl.scrollTop;
}

/** The chat area changed size (phone keyboard): stay at the newest message if that is where the user was. */
export function keepChatPinned() {
  if (followChat && !chatEl.querySelector('.empty')) pinToBottom(); // the welcome card reads from the top
}

export function scrollChat(force) {
  if (force) followChat = true;
  if (!followChat) {
    $('#jump-latest').hidden = false;
    return;
  }
  pinToBottom();
  // Again after layout settles (markdown, images, expanded details).
  requestAnimationFrame(() => followChat && pinToBottom());
  $('#jump-latest').hidden = true;
}

export function appendChat(msg, scroll = true) {
  const welcome = chatEl.querySelector('.empty');
  welcome?.remove();
  const node = document.createElement('div');
  node.dataset.id = msg.id;
  fillChat(node, msg);
  chatEl.append(node);
  rows.set(msg.id, node);
  rowMsg.set(node, msg);
  if (msg.kind === 'user') markLatestUser();
  // Your own prompt, anything waiting for your decision, and the first message always come into view.
  const mustSee = msg.kind === 'approval' || (msg.kind === 'user' && msg.source === 'web') || Boolean(welcome);
  if (scroll) scrollChat(mustSee);
}

export function replaceChat(msg) {
  pendingReplace.delete(msg.id);
  const node = rows.get(msg.id);
  if (!node?.isConnected) {
    // A message of the open chat without a row (never drawn): draw the chat again rather than drop the update.
    if (msg.project === state.active && state.chats[state.active]?.includes(msg)) renderChat();
    return;
  }
  rowMsg.set(node, msg);
  fillChat(node, msg);
  if (msg.kind === 'user') markLatestUser();
  scrollChat(msg.kind === 'approval' && msg.status === 'pending');
}

// Live updates (streamed text every ~80 ms, tool status, …) are drawn once per frame: several updates of one
// message arriving together (a backlog after a busy moment, a hidden tab) cost one render, not one each.
const pendingReplace = new Map();
let replaceFrame = 0;

export function scheduleReplace(msg) {
  pendingReplace.set(msg.id, msg);
  replaceFrame ||= requestAnimationFrame(() => {
    replaceFrame = 0;
    const batch = [...pendingReplace.values()];
    pendingReplace.clear();
    for (const m of batch) if (m.project === state.active) replaceChat(m);
  });
}

// ---------- ↻ Ulangi / Edit with 📎 attachments ----------

const LOST_ATTACHMENTS = 'Lampiran tidak ikut: muat ulang halaman menghapusnya';

/**
 * The files a sent prompt carried, from browser memory (attachments.js keeps the last few per project).
 * @returns {{ files: object[], lost: boolean }} lost: it had files, but a reload emptied the memory
 */
function sentFiles(msg) {
  const chips = Array.isArray(msg.attachments) ? msg.attachments : [];
  const files = chips.length ? recallSent(state.active, chips) : null;
  return { files: files ?? [], lost: (chips.length > 0 || msg.images > 0) && !files };
}

/** ↻ Ulangi: the same text, with the same files while they are still in memory (else text only, and it says so). */
async function resendPrompt(msg) {
  const project = state.active;
  const { files, lost } = sentFiles(msg);
  try {
    await api(`/api/projects/${project}/prompt`, { text: msg.text, attachments: attachmentPayload(files) });
    if (files.length) rememberSent(project, files);
    if (lost) toast(`Dikirim ulang tanpa lampiran. ${LOST_ATTACHMENTS}.`, 'warn');
  } catch (err) {
    toast(`Gagal mengirim: ${err.message}`);
  }
}

/** Edit: the text back in the box, and its files back as chips (when still in memory). */
function editPrompt(msg) {
  fillComposer(msg.text);
  if (state.readOnly) return;
  const { files, lost } = sentFiles(msg);
  if (files.length) putBackAttachments(files);
  else if (lost) toast(`${LOST_ATTACHMENTS}.`, 'warn');
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
  // The path opens the file viewer (at the line read, for a Read with an offset).
  if (input.file) parts.push(`<div class="kv"><span>file</span>${fileLinkHtml(input.file, `<code>${escapeHtml(input.file)}</code>`, { line: input.line })}${input.range ? ` <small>${escapeHtml(input.range)}</small>` : ''}</div>`);
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
  } else if (isLiveShell(msg)) parts.push(liveBlock(msg));
  else if (msg.status === 'running') parts.push('<div class="muted">Sedang berjalan…</div>');
  return parts.join('') || '<div class="muted">Tidak ada detail.</div>';
}

const STATUS_ICON = { running: '<span class="spinner"></span>', ok: '<span class="ok">✓</span>', fail: '<span class="fail">✗</span>', cancel: '<span class="muted">–</span>' };

const AUTO_EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' };

/** ~70 characters of the classifier's answer: the badge stays one line (the full text stays in the tooltip). */
const autoReasonShort = (reason) => {
  const text = String(reason ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
};

/**
 * The Effort Auto tag on a prompt: the level, and — when the classifier explained itself — the reason as small muted
 * text too (not only in the tooltip). `source` is 'llm' or 'fallback'; `fallback: true` marks a level with no real
 * reason behind it. Everything from the server is escaped, and the tag truncates instead of overflowing its row.
 */
function autoEffortTag(auto) {
  if (auto?.skipped) return `<span class="tag auto-effort" title="${escapeHtml(auto.reason ?? '')}">Auto: turn berjalan</span>`;
  if (!auto?.level) return '';
  const label = `Auto: ${AUTO_EFFORT_LABEL[auto.level] ?? String(auto.level)}${auto.source === 'fallback' ? ' (fallback)' : ''}`;
  const reason = auto.source && auto.fallback !== true ? autoReasonShort(auto.reason) : '';
  const full = reason ? `${label} — ${reason}` : label;
  const why = reason ? ` <span class="auto-why">· ${escapeHtml(reason)}</span>` : '';
  return `<span class="tag auto-effort${auto.source === 'fallback' ? ' fallback' : ''}" title="${escapeHtml(full)}" aria-label="${escapeHtml(full)}">${escapeHtml(label)}${why}</span>`;
}

export function who(role) {
  const look = CAST[role]?.look ?? CAST.claude.look;
  return `<img class="ava orbable" style="--c:${role === 'claude' ? '#b9a8ff' : roleColor(role)}" src="${avatarURL(look)}" alt=""><b style="color:${roleColor(role)}">${escapeHtml(roleName(role))}</b>`;
}

function fillChat(node, msg) {
  // Re-rendering replaces the row: keep keyboard focus on it (toggle via Enter, live status updates).
  const refocusRow = node.contains(document.activeElement) && document.activeElement.classList.contains('row');
  // A focused button of the stuck chip (features/stuck.js) survives the redraw (e.g. an "elapsed" tick).
  const refocusAct = node.contains(document.activeElement) ? document.activeElement.dataset?.stuckAct : null;
  const liveTop = saveLiveScroll(node);
  try {
    fillChatBody(node, msg);
    if (msg.kind === 'tool') afterRowRender(node, msg, liveTop);
  } catch (err) {
    // A message that fails to render still shows its text (never an empty bubble).
    console.error('chat render', msg.kind, err);
    node.className = `msg ${msg.kind === 'assistant' ? 'assistant' : 'info'}`;
    node.textContent = String(msg.text ?? '');
  }
  if (refocusRow) node.querySelector(':scope > .row')?.focus({ preventScroll: true });
  else if (refocusAct) node.querySelector(`:scope > .stuck-chip [data-stuck-act="${CSS.escape(refocusAct)}"]`)?.focus({ preventScroll: true });
}

function fillChatBody(node, msg) {
  switch (msg.kind) {
    case 'user': {
      const tags = [
        msg.source === 'demo' ? 'demo' : '',
        msg.source === 'cli' ? 'dari terminal' : '',
        msg.history ? 'riwayat' : '',
        msg.images && !msg.attachments ? `🖼 ${msg.images} gambar` : '', // bubbles stored before 📎 Lampiran
        msg.queued ? 'antre' : '',
        msg.cancelled ? 'dibatalkan' : '',
      ].filter(Boolean);
      const autoTag = autoEffortTag(msg.autoEffort);
      // Re-sending a prompt typed in the terminal would run it in the web session, so only web prompts offer it.
      const actions = msg.source === 'demo'
        ? ''
        : `<span class="msg-actions"><button data-msg-act="copy" title="Salin teks prompt">Salin</button><button data-msg-act="edit" title="Salin ke kotak pesan untuk diedit lalu dikirim">Edit</button>${msg.source === 'cli' ? '' : '<button class="resend" data-msg-act="resend" title="Kirim prompt ini sekali lagi">↻ Ulangi</button>'}</span>`;
      node.className = `msg user ${msg.source === 'cli' ? 'cli' : ''} ${msg.history ? 'history' : ''}`;
      // 📎 Name + size chips only: the files' content went to Claude, not into the bubble.
      const files = Array.isArray(msg.attachments) && msg.attachments.length ? `<div class="msg-attachments">${msg.attachments.map((a) => attachmentChip(a)).join('')}</div>` : '';
      node.innerHTML = `<div class="body">${escapeHtml(msg.text).replace(/\n/g, '<br>')}</div>${files}<div class="meta">${actions}${autoTag}${tags.map((t) => `<span class="tag">${t}</span>`).join('')}${time(msg.ts)}</div>`;
      break;
    }
    case 'assistant':
      // A finished reply with no text (only whitespace, or a block that turned out empty) is not shown.
      if (!String(msg.text ?? '').trim() && !msg.streaming) {
        node.className = 'hidden-msg';
        node.innerHTML = '';
        break;
      }
      node.className = `msg assistant ${msg.streaming ? 'streaming' : ''} ${msg.history ? 'history' : ''}`;
      node.innerHTML = `<div class="who">${who('claude')}${msg.source === 'cli' ? '<span class="cli-tag">CLI</span>' : ''}${msg.history ? '<span class="tag">riwayat</span>' : ''}<span>${time(msg.ts)}</span>${msg.streaming ? '' : '<button class="msg-copy" data-msg-act="copy" title="Salin jawaban (Markdown)">Salin</button>'}</div><div class="body md">${renderMarkdown(msg.text)}</div>`;
      // Paths to project files (`src/x.js`, public/js/app.js:120) open the file viewer; not while streaming.
      if (!msg.streaming) linkifyPaths(node.querySelector('.body'));
      break;
    case 'tool': {
      const open = expanded.has(msg.id);
      node.className = `line tool expandable st-${msg.status} ${open ? 'open' : ''} ${msg.sub ? 'sub' : ''}`;
      node.innerHTML = `<div class="row" role="button" tabindex="0" aria-expanded="${open}" title="Klik untuk detail"><span class="chev">${open ? '▾' : '▸'}</span><span class="dot" style="background:${roleColor(msg.role)}"></span><span class="who-s" title="${escapeHtml(roleName(msg.role))}">${escapeHtml(roleName(msg.role))}</span><span class="txt">${escapeHtml(msg.text)}</span>${elapsedTag(msg)}${STATUS_ICON[msg.status] ?? ''}</div>${stuckChip(msg)}${open ? `<div class="detail">${toolDetail(msg)}</div>` : isLiveShell(msg) ? liveTail(msg) : ''}`;
      break;
    }
    case 'delegate': {
      const open = expanded.has(msg.id);
      node.className = `line delegate expandable st-${msg.status} ${open ? 'open' : ''}`;
      node.innerHTML = `<div class="row" role="button" tabindex="0" aria-expanded="${open}" title="Klik untuk instruksi & laporan"><span class="chev">${open ? '▾' : '▸'}</span><img class="ava sm orbable" style="--c:${msg.role === 'claude' ? '#b9a8ff' : roleColor(msg.role)}" src="${avatarURL(CAST[msg.role]?.look ?? CAST.claude.look)}" alt=""><span class="txt"><b style="color:${roleColor(msg.role)}">${escapeHtml(roleName(msg.role))}</b> ditugaskan${msg.from && msg.from !== 'claude' ? ` oleh ${escapeHtml(roleName(msg.from))}` : ''}: ${escapeHtml(msg.text)}</span>${elapsedTag(msg)}${STATUS_ICON[msg.status] ?? ''}</div>${stuckChip(msg)}${open ? `<div class="detail">${toolDetail(msg)}</div>` : ''}`;
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
  // We only ever scroll to the very bottom, so a scroll that moves up from there is the user's.
  chatEl.addEventListener('scroll', () => {
    const atBottom = distanceFromBottom() < 60;
    if (!atBottom && followChat && chatEl.scrollTop >= pinnedTop - 1) {
      pinToBottom(); // the content moved, not the user (see pinnedTop): keep following
    } else {
      followChat = atBottom;
      if (atBottom) pinnedTop = chatEl.scrollTop;
    }
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
    const msg = rowMsg.get(act.closest('[data-id]')); // the row's own message (ids of old chats may repeat)
    if (!msg) return;
    if (act.dataset.msgAct === 'copy') flashButton(act, (await copyText(msg.text)) ? '✓ Tersalin' : 'Gagal');
    else if (act.dataset.msgAct === 'edit') editPrompt(msg);
    else if (act.dataset.msgAct === 'resend') resendPrompt(msg);
  });

  chatEl.addEventListener('click', (e) => {
    const head = e.target.closest('.expandable > .row');
    if (!head) return;
    const node = head.parentElement;
    const id = node.dataset.id;
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    const msg = rowMsg.get(node);
    if (!msg) return;
    // Reading a tool's detail is a deliberate look back: pause following and keep the row in view.
    if (expanded.has(id) && node !== chatEl.lastElementChild) followChat = false;
    fillChat(node, msg);
  });

  $('#jump-latest').addEventListener('click', () => scrollChat(true));
}
