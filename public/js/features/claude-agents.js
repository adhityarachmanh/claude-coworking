// 🖥 Sesi latar Claude (agent view): the supervisor's sessions from `claude agents --json`, with stop/respawn/
// rm/logs from the app. Attach and replying still need a terminal (Claude Code's own TUI), so it is not offered.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

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

export function openClaudeAgents() {
  openModal('bg-agents-modal');
  load();
  loadDaemon();
  clearInterval(bg.timer);
  bg.timer = setInterval(() => {
    if ($('#bg-agents-modal')?.hidden) return clearInterval(bg.timer);
    load(true);
  }, 8000);
}

export function initClaudeAgents() {
  $('#bg-agents-refresh')?.addEventListener('click', () => {
    load();
    loadDaemon();
  });
  $('#bg-agents-all')?.addEventListener('change', () => load());
  $('#bg-agents-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bg]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.bg === 'logs') return showLog(id);
    act(id, btn.dataset.bg);
  });
}
