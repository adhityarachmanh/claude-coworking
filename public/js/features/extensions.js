// 🧩 Ekstensi (/plugin, /agents, /hooks): Claude Code's plugins, your own subagents (.claude/agents) and the hooks in
// the settings files, without the terminal (server: src/routes/extensions.js, src/claude-admin.js).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

const ext = { tab: 'plugins', project: null, plugins: null, filter: '', agents: [], editing: null, hooks: [] };
const MAX_LIST = 60;

export function openExtensions(tab = 'plugins') {
  if (state.readOnly) return toast('Ekstensi hanya bisa dibuka dari laptop atau lewat Tailscale.', 'warn');
  ext.project = state.active && state.active !== DEMO_ID ? state.active : null;
  ext.tab = tab;
  ext.editing = null;
  openModal('ext-modal');
  render();
  load();
}

async function load(force = false) {
  try {
    if (ext.tab === 'plugins') {
      if (!ext.plugins || force) {
        $('#ext-body').innerHTML = '<p class="muted">Memuat daftar plugin… (marketplace bisa ribuan)</p>';
        ext.plugins = await api('/api/claude/plugins', { force });
      }
    } else if (!ext.project) {
      ext.agents = [];
      ext.hooks = [];
    } else if (ext.tab === 'agents') ext.agents = (await api(`/api/projects/${ext.project}/agents`)).agents;
    else ext.hooks = (await api(`/api/projects/${ext.project}/hooks`)).hooks;
  } catch (err) {
    $('#ext-body').innerHTML = `<p class="state-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  render();
}

function render() {
  for (const b of document.querySelectorAll('#ext-tabs [data-tab]')) {
    b.classList.toggle('on', b.dataset.tab === ext.tab);
    b.setAttribute('aria-pressed', String(b.dataset.tab === ext.tab));
  }
  $('#ext-project').textContent = ext.project ? `· ${projectName(ext.project)}` : '';
  const body = $('#ext-body');
  if (state.config?.engine === 'opencode' && ext.tab !== 'plugins') body.innerHTML = '<p class="muted small">Mesin aktif OpenCode: agent OpenCode diatur di opencode.json (dipilih di Pengaturan giliran → Agent). Tab ini mengelola milik Claude Code.</p>';
  else body.innerHTML = '';
  if (ext.tab === 'plugins') body.insertAdjacentHTML('beforeend', pluginsHtml());
  else if (!ext.project) body.insertAdjacentHTML('beforeend', '<p class="muted">Pilih project dulu.</p>');
  else if (ext.tab === 'agents') body.insertAdjacentHTML('beforeend', ext.editing ? agentFormHtml(ext.editing) : agentsHtml());
  else body.insertAdjacentHTML('beforeend', hooksHtml());
}

// ---------- plugins ----------

function pluginsHtml() {
  const p = ext.plugins;
  if (!p) return '<p class="muted">Memuat…</p>';
  const local = state.local;
  const installed = p.installed.length
    ? `<ul class="ext-list">${p.installed
        .map((x) => `<li data-id="${escapeHtml(x.id)}"><div><b>${escapeHtml(x.id)}</b> <small class="muted">v${escapeHtml(x.version)} · ${escapeHtml(x.scope)}</small></div><div class="ext-actions">${
          local ? `<button class="ghost" data-plugin="${x.enabled ? 'disable' : 'enable'}">${x.enabled ? '⏸ Nonaktifkan' : '▶ Aktifkan'}</button><button class="ghost danger-text" data-plugin="uninstall">Hapus</button>` : `<small class="muted">${x.enabled ? 'aktif' : 'nonaktif'}</small>`
        }</div></li>`)
        .join('')}</ul>`
    : '<p class="muted small">Belum ada plugin terpasang.</p>';
  const q = ext.filter.toLowerCase();
  const matches = q ? p.available.filter((x) => x.id.toLowerCase().includes(q) || x.description.toLowerCase().includes(q)) : p.available;
  const list = matches.slice(0, MAX_LIST);
  return `<h3 class="ext-h">Terpasang</h3>${installed}
    <h3 class="ext-h">Marketplace <small class="muted">${p.available.length} plugin</small></h3>
    <input id="ext-filter" type="search" value="${escapeHtml(ext.filter)}" placeholder="Cari plugin: github, sentry, test, review…" aria-label="Cari plugin" autocomplete="off" />
    <ul class="ext-list">${list
      .map((x) => `<li data-id="${escapeHtml(x.id)}"><div><b>${escapeHtml(x.name)}</b> <small class="muted">${escapeHtml(x.id.split('@')[1] ?? '')}</small><p class="muted small">${escapeHtml(x.description)}</p></div><div class="ext-actions">${local ? '<button class="primary" data-plugin="install">Pasang</button>' : ''}</div></li>`)
      .join('')}</ul>
    ${matches.length > MAX_LIST ? `<p class="muted small">${matches.length - MAX_LIST} lainnya: persempit pencarian.</p>` : ''}
    ${local ? '' : '<p class="muted small">Memasang/menghapus plugin hanya dari laptop (plugin menjalankan kode di laptop).</p>'}`;
}

async function pluginAct(btn) {
  const id = btn.closest('[data-id]').dataset.id;
  const action = btn.dataset.plugin;
  if (action === 'uninstall' && !window.confirm(`Hapus plugin ${id}?`)) return;
  let scope = 'user';
  if (action === 'install') {
    const ok = window.confirm(`Pasang plugin ${id}?\n\nPlugin bisa menambah command, agent, hooks dan server MCP yang berjalan di laptop ini. Pasang hanya dari sumber yang kamu percaya.\n\nOK = untuk semua project (user).`);
    if (!ok) return;
  }
  btn.disabled = true;
  try {
    let r = await api('/api/claude/plugins/action', { action, id, scope });
    if (r.needsConfirm) {
      if (!window.confirm(`Marketplace plugin ini meminta menjalankan perintah berikut di laptop:\n\n${r.command}\n\nJalankan?`)) return;
      r = await api('/api/claude/plugins/action', { action, id, scope, acceptCommand: r.sha256 });
    }
    toast({ install: `Plugin ${id} terpasang.`, uninstall: `Plugin ${id} dihapus.`, enable: `Plugin ${id} diaktifkan.`, disable: `Plugin ${id} dinonaktifkan.` }[action], 'ok');
    ext.plugins = null;
    load(true);
  } catch (err) {
    toast(err.message, 'warn');
  } finally {
    btn.disabled = false;
  }
}

// ---------- your own subagents ----------

function agentsHtml() {
  const rows = ext.agents.length
    ? `<ul class="ext-list">${ext.agents
        .map((a, i) => `<li><div><b>${escapeHtml(a.name)}</b> <small class="muted">${a.scope === 'user' ? 'semua project' : 'project ini'}${a.model ? ` · ${escapeHtml(a.model)}` : ''}</small><p class="muted small">${escapeHtml(a.description)}</p></div><div class="ext-actions"><button class="ghost" data-agent-edit="${i}">✎ Edit</button><button class="ghost danger-text" data-agent-del="${i}">Hapus</button></div></li>`)
        .join('')}</ul>`
    : '<p class="muted small">Belum ada subagent buatan sendiri.</p>';
  return `<p class="muted small">Subagent di <code>.claude/agents</code> (project) dan <code>~/.claude/agents</code> (semua project). Claude memanggilnya sesuai deskripsinya, seperti /agents di terminal. Role kantor (/team) terpisah.</p>
    ${rows}<div class="acct-actions"><button class="primary" data-agent-new>＋ Agent baru</button></div>`;
}

function agentFormHtml(a) {
  return `<form id="ext-agent-form" class="oc-form">
    <label class="oc-field"><span>Nama * (huruf kecil, angka, minus)</span><input name="name" value="${escapeHtml(a.name ?? '')}" required pattern="[a-z0-9][a-z0-9\\-]{0,49}" placeholder="code-reviewer" autocomplete="off" /></label>
    <label class="oc-field"><span>Berlaku untuk</span><select name="scope"><option value="project"${a.scope !== 'user' ? ' selected' : ''}>Project ini</option><option value="user"${a.scope === 'user' ? ' selected' : ''}>Semua project</option></select></label>
    <label class="oc-field"><span>Deskripsi * (kapan Claude memakainya)</span><input name="description" value="${escapeHtml(a.description ?? '')}" required placeholder="Review kode setelah perubahan selesai" /></label>
    <label class="oc-field"><span>Tools (kosong = semua)</span><input name="tools" value="${escapeHtml(a.tools ?? '')}" placeholder="Read, Grep, Glob" autocomplete="off" /></label>
    <label class="oc-field"><span>Model (kosong = ikut sesi)</span><input name="model" value="${escapeHtml(a.model ?? '')}" placeholder="sonnet, opus, haiku, inherit" autocomplete="off" /></label>
    <label class="oc-field"><span>Instruksi (system prompt) *</span><textarea name="prompt" rows="10" class="memory-text" required>${escapeHtml(a.prompt ?? '')}</textarea></label>
    <div class="acct-actions"><button type="button" class="ghost" data-agent-cancel>Batal</button><button class="primary">💾 Simpan</button></div>
  </form>`;
}

// ---------- hooks ----------

function hooksHtml() {
  if (!ext.hooks.length) return '<p class="muted small">Tidak ada hooks di settings.json (user, project, pribadi).</p>';
  return `<p class="muted small">Hooks berjalan otomatis di setiap sesi. Ubah lewat file settings-nya (Memory/editor), atau minta Claude mengubahnya.</p>
    <ul class="ext-list">${ext.hooks
      .map((h) => `<li><div><b>${escapeHtml(h.event)}</b> <small class="muted">${escapeHtml(h.matcher)} · ${escapeHtml(h.source)}</small>${h.commands.map((c) => `<pre class="cc-output">${escapeHtml(c)}</pre>`).join('')}</div></li>`)
      .join('')}</ul>`;
}

export function initExtensions() {
  $('#ext-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]')?.dataset.tab;
    if (!tab || tab === ext.tab) return;
    ext.tab = tab;
    ext.editing = null;
    render();
    load();
  });
  $('#ext-refresh').addEventListener('click', () => load(true));
  $('#ext-body').addEventListener('input', (e) => {
    if (e.target.id !== 'ext-filter') return;
    ext.filter = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const input = $('#ext-filter');
    input.focus();
    input.setSelectionRange(pos, pos);
  });
  $('#ext-body').addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-plugin]')) return pluginAct(t.closest('[data-plugin]'));
    if (t.closest('[data-agent-new]')) return (ext.editing = { scope: 'project' }), render();
    if (t.closest('[data-agent-cancel]')) return (ext.editing = null), render();
    const edit = t.closest('[data-agent-edit]');
    if (edit) return (ext.editing = { ...ext.agents[Number(edit.dataset.agentEdit)], previous: ext.agents[Number(edit.dataset.agentEdit)].name }), render();
    const del = t.closest('[data-agent-del]');
    if (del) {
      const a = ext.agents[Number(del.dataset.agentDel)];
      if (!window.confirm(`Hapus agent ${a.name}?`)) return;
      try {
        await api(`/api/projects/${ext.project}/agents/delete`, { scope: a.scope, name: a.name });
        toast(`Agent ${a.name} dihapus.`, 'ok');
        load();
      } catch (err) {
        toast(err.message, 'warn');
      }
    }
  });
  $('#ext-body').addEventListener('submit', async (e) => {
    if (e.target.id !== 'ext-agent-form') return;
    e.preventDefault();
    const f = e.target.elements;
    const body = { name: f.name.value.trim(), scope: f.scope.value, description: f.description.value, tools: f.tools.value.trim(), model: f.model.value.trim(), prompt: f.prompt.value, previous: ext.editing?.previous ?? null };
    try {
      await api(`/api/projects/${ext.project}/agents/save`, body);
      toast(`Agent ${body.name} tersimpan. Dipakai mulai pesan berikutnya.`, 'ok');
      ext.editing = null;
      load();
    } catch (err) {
      toast(err.message, 'warn');
    }
  });
}
