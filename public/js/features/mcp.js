// MCP servers (/mcp): headless Claude Code has no /mcp dialog, so it lives here.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

const mcpView = { project: null, servers: [], login: null, poll: null };
const MCP_STATUS = { configured: ['⚙ terdaftar', ''], connected: ['✓ tersambung', 'ok'], 'needs-auth': ['🔑 perlu login', 'warn'], failed: ['✗ gagal', 'bad'], pending: ['… menyambung', ''], disabled: ['⏸ nonaktif', ''] };
const MCP_ORDER = ['needs-auth', 'failed', 'pending', 'connected', 'configured', 'disabled'];
const isOpenCode = () => state.config?.engine === 'opencode';

export async function openMcp() {
  if (state.active === DEMO_ID || state.readOnly) return; // asking for the status starts Claude Code
  mcpView.project = state.active;
  $('#mcp-callback').hidden = true;
  $('#mcp-add').hidden = true;
  $('#mcp-add-toggle').hidden = !state.local; // adding writes config and runs the server's command: laptop only
  $('#mcp-engine-note').textContent = isOpenCode()
    ? 'OpenCode: server dari opencode.json (global + project) dengan status langsung dari OpenCode. ▶ / ⏸ berlaku sampai OpenCode dimulai ulang (config tidak diubah).'
    : 'Status langsung dari Claude Code. ＋ Tambah memakai claude mcp add.';
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
    $('#mcp-list').innerHTML = `<li class="muted">Belum ada server MCP. Tambahkan dengan ＋ Tambah server${isOpenCode() ? '' : ' atau sebuah plugin'}.</li>`;
    return;
  }
  $('#mcp-list').innerHTML = servers
    .map((s) => {
      const [label, tone] = MCP_STATUS[s.status] ?? [s.status, ''];
      // OpenCode: actions only for servers its service reports (a merely configured one has no live state)
      const live = !isOpenCode() || s.status !== 'configured';
      const actions = !live ? [] : [
        s.status === 'needs-auth' ? '<button class="primary" data-mcp="login">🔑 Login</button>' : '',
        s.status !== 'disabled' ? '<button data-mcp="reconnect">↻ Sambungkan ulang</button>' : '',
        s.status === 'disabled' ? '<button data-mcp="enable">▶ Aktifkan</button>' : '<button data-mcp="disable">⏸ Nonaktifkan</button>',
      ].join('');
      const meta = [s.scope, s.type, s.tools != null ? `${s.tools} tool` : '', s.detail, s.error].filter(Boolean).map(escapeHtml).join(' · ');
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

/** ＋ Tambah server: a local command or a remote URL, through the engine's own `mcp add`. */
async function addServer(e) {
  e.preventDefault();
  const f = e.target;
  const remote = f.elements.kind.value === 'remote';
  const body = {
    name: f.elements.name.value.trim(),
    kind: remote ? 'remote' : 'local',
    command: f.elements.command.value.trim(),
    url: f.elements.url.value.trim(),
    env: f.elements.env.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    scope: f.elements.scope.value,
  };
  const btn = f.querySelector('button.primary');
  btn.disabled = true;
  try {
    await api(`/api/projects/${mcpView.project}/mcp-add`, body);
    toast(`Server MCP ${body.name} ditambahkan. Dipakai mulai pesan berikutnya.`, 'ok');
    f.reset();
    syncAddForm();
    $('#mcp-add').hidden = true;
    loadMcp();
  } catch (err) {
    toast(err.message, 'warn');
  } finally {
    btn.disabled = false;
  }
}

function syncAddForm() {
  const f = $('#mcp-add');
  const remote = f.elements.kind.value === 'remote';
  f.querySelector('.mcp-local').hidden = remote;
  f.querySelector('.mcp-remote').hidden = !remote;
}

export function initMcp() {
  $('#mcp-add-toggle').addEventListener('click', () => {
    $('#mcp-add').hidden = !$('#mcp-add').hidden;
    syncAddForm();
    if (!$('#mcp-add').hidden) $('#mcp-add').elements.name.focus();
  });
  $('#mcp-add').addEventListener('change', syncAddForm);
  $('#mcp-add').addEventListener('submit', addServer);
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
      // OpenCode "code" logins always need the code pasted (also on the laptop)
      $('#mcp-callback').hidden = !(r.callbackExpected && (!state.local || isOpenCode()));
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
}
