// MCP servers (/mcp): headless Claude Code has no /mcp dialog, so it lives here.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { engineOf } from '../core/engine-caps.js';
import { DEMO_ID, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

const mcpView = { project: null, servers: [], login: null, poll: null, advanced: null };
const MCP_STATUS = { configured: ['⚙ terdaftar', ''], connected: ['✓ tersambung', 'ok'], 'needs-auth': ['🔑 perlu login', 'warn'], failed: ['✗ gagal', 'bad'], pending: ['… menyambung', ''], disabled: ['⏸ nonaktif', ''] };
const MCP_ORDER = ['needs-auth', 'failed', 'pending', 'connected', 'configured', 'disabled'];
// The advanced form fields of one OpenCode server; the same names the route reads and writes.
const ADV_FIELDS = ['disabled', 'codemode', 'pool', 'protocol', 'cwd', 'timeoutStartup', 'timeoutCatalog', 'timeoutExecution'];
// The engine of the project whose dialog is open (before openMcp assigns it: the active project).
const isOpenCode = () => engineOf(state.statuses[mcpView.project ?? state.active] ?? {}, state.config) === 'opencode';

export async function openMcp() {
  if (state.active === DEMO_ID || state.readOnly) return; // asking for the status starts Claude Code
  mcpView.project = state.active;
  $('#mcp-callback').hidden = true;
  $('#mcp-add').hidden = true;
  closeAdvanced();
  const local = state.local !== false;
  $('#mcp-add-toggle').hidden = !local; // adding writes config and runs the server's command: laptop only
  $('#mcp-add-note').hidden = local; // a phone gets the reason instead of a missing button
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
      let actions = !live ? [] : [
        s.status === 'needs-auth' ? '<button class="primary" data-mcp="login">🔑 Login</button>' : '',
        s.status !== 'disabled' ? '<button data-mcp="reconnect">↻ Sambungkan ulang</button>' : '',
        s.status === 'disabled' ? '<button data-mcp="enable">▶ Aktifkan</button>' : '<button data-mcp="disable">⏸ Nonaktifkan</button>',
      ].join('');
      // OpenCode only: the keys `opencode mcp add` cannot write (disabled/codemode/pool/protocol/cwd/timeout).
      if (isOpenCode()) actions += '<button data-mcp="advanced">⚙ Lanjutan</button>';
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
    headers: remote ? f.elements.headers.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [],
    transport: remote ? f.elements.transport.value : 'stdio',
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
  for (const el of f.querySelectorAll('.mcp-local')) el.hidden = remote;
  for (const el of f.querySelectorAll('.mcp-remote')) el.hidden = !remote;
  // OpenCode has only Streamable HTTP, so its transport choice (Claude's legacy SSE) is not shown there.
  const claude = !isOpenCode();
  for (const el of f.querySelectorAll('[data-mcp-claude]')) el.hidden = !claude || !remote;
}

/** ⚙ Lanjutan: reads where the server is defined and fills the form (OpenCode only, laptop only). */
async function openAdvanced(server) {
  const form = $('#mcp-advanced');
  if (!form) return;
  $('#mcp-adv-error').textContent = '';
  $('#mcp-add').hidden = true;
  form.hidden = false;
  $('#mcp-advanced-title').textContent = `⚙ Lanjutan · ${server}`;
  $('#mcp-advanced-note').textContent = 'Memuat pengaturan server…';
  try {
    const view = await api('/api/opencode-config/mcp-advanced', { projectId: mcpView.project, name: server });
    if (!view.found) {
      form.hidden = true;
      return toast(`${server} belum ada di config OpenCode project/global. Tambahkan dulu lewat ＋ Tambah server.`, 'warn');
    }
    mcpView.advanced = { name: server, scope: view.scope, hash: view.hash };
    for (const key of ADV_FIELDS) {
      const el = $(`#mcp-adv-${key}`);
      if (el) el.value = view.fields?.[key] ?? '';
    }
    const backup = view.format === 'jsonc' ? ' File ini JSONC: menyimpan lewat form menulis JSON biasa, jadi komentar hilang (backup dibuat).' : '';
    $('#mcp-advanced-note').textContent = `Tersimpan di config ${view.scope === 'global' ? 'global (semua project)' : 'project ini'} · ${view.path}.${backup}`;
    form.scrollIntoView?.({ block: 'nearest' });
  } catch (err) {
    form.hidden = true;
    toast(`Tidak bisa memuat pengaturan server: ${err.message}`, 'warn');
  }
}

function closeAdvanced() {
  const form = $('#mcp-advanced');
  if (form) form.hidden = true;
  mcpView.advanced = null;
}

async function saveAdvanced() {
  if (!mcpView.advanced) return;
  const fields = {};
  for (const key of ADV_FIELDS) fields[key] = $(`#mcp-adv-${key}`)?.value.trim() ?? '';
  $('#mcp-adv-save').disabled = true;
  $('#mcp-adv-error').textContent = '';
  try {
    await api('/api/opencode-config/mcp-advanced-save', {
      projectId: mcpView.project,
      scope: mcpView.advanced.scope,
      name: mcpView.advanced.name,
      fields,
      baseHash: mcpView.advanced.hash,
    });
    toast(`Pengaturan ${mcpView.advanced.name} tersimpan. Berlaku saat OpenCode menghubungkan server lagi.`, 'ok');
    closeAdvanced();
    loadMcp();
  } catch (err) {
    $('#mcp-adv-error').textContent = err.message;
  } finally {
    $('#mcp-adv-save').disabled = false;
  }
}

export function initMcp() {
  $('#mcp-add-toggle').addEventListener('click', () => {
    closeAdvanced();
    $('#mcp-add').hidden = !$('#mcp-add').hidden;
    syncAddForm();
    if (!$('#mcp-add').hidden) $('#mcp-add').elements.name.focus();
  });
  $('#mcp-add').addEventListener('change', syncAddForm);
  $('#mcp-add').addEventListener('submit', addServer);
  $('#mcp-adv-save')?.addEventListener('click', saveAdvanced);
  $('#mcp-adv-cancel')?.addEventListener('click', closeAdvanced);
  $('#mcp-refresh').addEventListener('click', () => loadMcp());
  $('#mcp-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-mcp]');
    if (!btn) return;
    const server = btn.closest('[data-server]').dataset.server;
    const action = btn.dataset.mcp;
    if (action === 'advanced') return openAdvanced(server);
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
