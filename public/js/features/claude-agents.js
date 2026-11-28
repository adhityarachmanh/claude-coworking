// 🖥 Sesi latar Claude (agent view): the supervisor's sessions from `claude agents --json`, with stop/respawn/
// rm/logs/open-in-chat from the app. "Buka di chat" resumes a finished session in the normal chat; a full TUI attach
// (`claude attach`) still needs a terminal.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { selectProject } from './picker.js';
import { resumeSession } from './sessions.js';

const bg = { agents: [], loading: false, timer: null };
const STATE = { working: ['bekerja', ''], blocked: ['perlu jawaban', 'warn'], done: ['selesai', 'ok'], failed: ['gagal', 'bad'], stopped: ['dihentikan', ''] };
const fmt = (ts) => (Number.isFinite(ts) ? new Date(ts).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : '');

function render() {
  const agents = bg.agents;
  $('#bg-agents-status').textContent = agents.length ? `${agents.length} sesi` : 'Tidak ada sesi latar Claude.';
  $('#bg-agents-list').innerHTML = agents
    .map((a) => {
      const [label, tone] = STATE[a.state] ?? [a.state ?? 'aktif', ''];
      const waiting = a.waitingFor ? ` · menunggu ${escapeHtml(a.waitingFor)}` : '';
      const running = a.state === 'working' || a.state === 'blocked' || a.status === 'busy';
      const actions = state.local && a.kind === 'background' && a.id
        ? [
            running ? `<button type="button" class="ghost" data-bg="stop" data-id="${escapeHtml(a.id)}">⏹ Hentikan</button>` : '',
            !running ? `<button type="button" class="ghost" data-bg="respawn" data-id="${escapeHtml(a.id)}">↻ Mulai ulang</button>` : '',
            !running && a.sessionId ? `<button type="button" class="ghost" data-bg="open" data-id="${escapeHtml(a.id)}" title="Lanjutkan percakapan sesi ini di chat Adhitron (setara --resume)">💬 Buka di chat</button>` : '',
            `<button type="button" class="ghost" data-bg="logs" data-id="${escapeHtml(a.id)}">📄 Log</button>`,
            `<button type="button" class="ghost danger-text" data-bg="rm" data-id="${escapeHtml(a.id)}">Hapus</button>`,
          ].join('')
        : '';
      const meta = [a.kind === 'interactive' ? 'terminal interaktif' : 'latar', a.id, a.cwd, fmt(a.startedAt)].filter(Boolean).map(escapeHtml).join(' · ');
      return `<li data-agent="${escapeHtml(a.id ?? '')}"><div><b>${escapeHtml(a.name || a.id || 'sesi')}</b> <span class="pill ${tone}">${label}</span><small class="muted">${meta}${waiting}</small></div><div class="ext-actions">${actions}</div></li>`;
    })
    .join('');
}

async function load(quiet = false) {
  if (bg.loading) return;
  bg.loading = true;
  if (!quiet) $('#bg-agents-status').textContent = 'Memuat sesi latar…';
  try {
    bg.agents = (await api('/api/claude/background-agents', { all: $('#bg-agents-all').checked })).agents ?? [];
    render();
  } catch (err) {
    bg.agents = [];
    $('#bg-agents-list').innerHTML = '';
    $('#bg-agents-status').textContent = err.message;
  } finally {
    bg.loading = false;
  }
}

async function act(id, action) {
  if (action === 'rm' && !window.confirm(`Hapus sesi ${id} dari daftar? Transkripnya tetap ada dan bisa dilanjutkan dengan --resume.`)) return;
  if (action === 'stop' && !window.confirm(`Hentikan sesi ${id}? Pekerjaan yang sedang berjalan berhenti.`)) return;
  try {
    const r = await api('/api/claude/background-agents/action', { action, id });
    toast({ stop: `Sesi ${id} dihentikan.`, respawn: `Sesi ${id} dimulai ulang.`, rm: `Sesi ${id} dihapus dari daftar.` }[action] ?? r.message, 'ok');
    load();
  } catch (err) {
    $('#bg-agents-status').textContent = err.message;
  }
}

async function showLog(id) {
  const out = $('#bg-agents-log');
  out.hidden = false;
  out.textContent = 'Memuat log…';
  try {
    out.textContent = (await api('/api/claude/background-agents/logs', { ref: id })).text || '(belum ada output)';
  } catch (err) {
    out.textContent = err.message;
  }
}

/** The supervisor's own state (`claude daemon status`), shown once on open/refresh rather than every poll. */
async function loadDaemon() {
  const line = $('#bg-agents-daemon');
  if (!line) return;
  try {
    const d = await api('/api/claude/background-agents/daemon', {});
    const first = String(d.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).find((l) => /pid|not running/i.test(l)) ?? '';
    line.textContent = d.running ? `Daemon Claude: berjalan${first ? ` · ${first}` : ''}` : 'Daemon Claude: berhenti — sesi latar tidak akan berjalan sampai dipakai lagi.';
    line.title = String(d.text ?? '').slice(0, 800);
  } catch (err) {
    line.textContent = `Daemon Claude: status tidak terbaca (${err.message}).`;
  }
}

/** Starts a new background session in the chosen project (`claude --bg`); it appears after the daemon registers it. */
async function startAgent() {
  const prompt = $('#bg-agent-prompt').value.trim();
  const name = $('#bg-agent-name').value.trim();
  const projectId = $('#bg-agent-project').value;
  if (!prompt) {
    $('#bg-agents-status').textContent = 'Isi prompt sesi latar dulu.';
    return;
  }
  $('#bg-agent-start').disabled = true;
  $('#bg-agents-status').textContent = 'Memulai sesi latar…';
  try {
    const r = await api('/api/claude/background-agents/start', { projectId, prompt, name });
    $('#bg-agent-prompt').value = '';
    $('#bg-agent-name').value = '';
    toast('Sesi latar dimulai.', 'ok');
    $('#bg-agents-status').textContent = r.output || 'Sesi latar dimulai.';
    setTimeout(() => {
      load();
      loadDaemon();
    }, 1500);
  } catch (err) {
    $('#bg-agents-status').textContent = err.message;
  } finally {
    $('#bg-agent-start').disabled = false;
  }
}

/** Normalize a path for the cwd comparison (Windows separators/case; a trailing slash does not matter). */
const normPath = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The project whose folder contains the session's cwd, or null (a folder Adhitron does not list as a project). */
function projectForCwd(cwd) {
  const dir = normPath(cwd);
  if (!dir) return null;
  return (state.projects ?? []).find((p) => {
    if (!p?.path || p.virtual || p.id === 'demo') return false;
    const root = normPath(p.path);
    return dir === root || dir.startsWith(`${root}/`);
  }) ?? null;
}

/**
 * Opens a finished background session in the normal chat (`claude --resume <sessionId>`), so replying no longer
 * needs the terminal. A session still working/blocked is refused: stop it first — the transcript is kept.
 */
async function openInChat(a) {
  if (!a?.sessionId) return toast('Sesi ini belum punya id percakapan untuk dilanjutkan.', 'warn');
  if (a.state === 'working' || a.state === 'blocked' || a.status === 'busy') {
    return toast('Sesi ini masih berjalan. Hentikan dulu dari panel ini, lalu buka di chat.', 'warn');
  }
  const project = projectForCwd(a.cwd);
  if (!project) return toast('Folder sesi ini bukan project di Adhitron. Tambahkan foldernya sebagai project dulu.', 'warn');
  if (project.id !== state.active) selectProject(project.id);
  const ok = await resumeSession(project.id, a.sessionId);
  if (!ok) return;
  $('#bg-agents-modal [data-close]')?.click();
  toast('Sesi latar dibuka di chat.', 'ok');
}

export function openClaudeAgents() {
  openModal('bg-agents-modal');
  // The new-session form is laptop-only; the list itself is readable from Tailscale.
  const form = $('#bg-agents-new');
  if (form) form.hidden = !state.local;
  const select = $('#bg-agent-project');
  if (select) {
    const projects = (state.projects ?? []).filter((p) => p && p.id !== 'demo');
    select.innerHTML = projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
    if (projects.some((p) => p.id === state.active)) select.value = state.active;
  }
  load();
  loadDaemon();
  clearInterval(bg.timer);
  bg.timer = setInterval(() => {
    if ($('#bg-agents-modal')?.hidden) return clearInterval(bg.timer);
    load(true);
  }, 8000);
}

/** The supervisor log's tail (`~/.claude/daemon.log`), shown when the list is not enough to explain a state. */
async function showDaemonLog() {
  const out = $('#bg-agents-log');
  out.hidden = false;
  out.textContent = 'Memuat log daemon…';
  try {
    const r = await api('/api/claude/background-agents/daemon-log', {});
    out.textContent = r.exists ? r.text || '(log kosong)' : 'Belum ada daemon.log — daemon Claude Code belum pernah berjalan.';
  } catch (err) {
    out.textContent = err.message;
  }
}

export function initClaudeAgents() {
  $('#bg-agents-refresh')?.addEventListener('click', () => {
    load();
    loadDaemon();
  });
  $('#bg-daemon-log')?.addEventListener('click', showDaemonLog);
  $('#bg-agents-all')?.addEventListener('change', () => load());
  $('#bg-agent-start')?.addEventListener('click', startAgent);
  $('#bg-agents-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bg]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.bg === 'logs') return showLog(id);
    if (btn.dataset.bg === 'open') return openInChat(bg.agents.find((a) => a.id === id));
    act(id, btn.dataset.bg);
  });
}
