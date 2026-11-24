// 🧩 Ekstensi (/plugin, /agents, /hooks): Claude Code's plugins, your own subagents (.claude/agents) and the hooks in
// the settings files, without the terminal (server: src/routes/extensions.js, src/claude-admin.js).
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { engineOf } from '../core/engine-caps.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { guardCap } from './engine.js';
import { loadOpenCodePlugins } from './opencode-check.js';

const ext = { tab: 'plugins', project: null, plugins: null, marketplaces: null, filter: '', agents: [], editing: null, hooks: [], hookEvents: [], hookEditing: null, view: null };
const MAX_LIST = 60;

export function openExtensions(tab = 'plugins') {
  const opencode = engineOf(state.statuses[state.active] ?? {}, state.config) === 'opencode';
  // OpenCode has its own plugin manager (npm/Git) but no Claude plugins/agents/hooks; `plugins` is true for both.
  if (opencode && (tab === 'agents' || tab === 'hooks')) return toast('Agent OpenCode diatur di Pengaturan giliran → Agent; hooks hanya untuk Claude Code.', 'warn');
  if (guardCap(opencode ? 'plugins' : 'extensions')) return;
  if (state.readOnly) return toast('Ekstensi hanya bisa dibuka dari laptop atau lewat Tailscale.', 'warn');
  ext.project = state.active && state.active !== DEMO_ID ? state.active : null;
  ext.tab = opencode ? 'plugins' : tab;
  ext.editing = null;
  ext.view = null;
  openModal('ext-modal');
  render();
  load();
}

async function load(force = false) {
  if (engineOf(state.statuses[ext.project ?? state.active] ?? {}, state.config) === 'opencode') {
    loadOpenCodePlugins(force); // the OpenCode block loads itself; no Claude marketplace request
    return;
  }
  try {
    if (ext.tab === 'plugins') {
      if (!ext.plugins || force) {
        $('#ext-body').innerHTML = '<p class="muted">Memuat daftar plugin… (marketplace bisa ribuan)</p>';
        ext.plugins = await api('/api/claude/plugins', { force });
      }
      ext.marketplaces = (await api('/api/claude/plugins/marketplaces')).marketplaces ?? [];
    } else if (!ext.project) {
      ext.agents = [];
      ext.hooks = [];
    } else if (ext.tab === 'agents') ext.agents = (await api(`/api/projects/${ext.project}/agents`)).agents;
    else {
      const data = await api(`/api/projects/${ext.project}/hooks`);
      ext.hooks = data.hooks;
      ext.hookEvents = data.events ?? ext.hookEvents;
    }
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
  const opencode = engineOf(state.statuses[ext.project ?? state.active] ?? {}, state.config) === 'opencode';
  // One dialog, two engines: title, tabs and panel follow the project's engine.
  $('#ext-title-text').textContent = opencode ? 'Ekstensi OpenCode' : 'Ekstensi Claude Code';
  $('#ext-tabs').hidden = opencode; // agents/hooks are Claude-only; OpenCode has its own Agent editor
  const ocPlugins = $('#ext-oc-plugins');
  if (ocPlugins) ocPlugins.hidden = !opencode;
  if (opencode) {
    body.innerHTML = '<p class="muted small">Project ini memakai OpenCode. Agent OpenCode diatur di Pengaturan giliran → Agent; plugin di bawah berlaku untuk semua project.</p>';
    loadOpenCodePlugins();
    return;
  }
  body.innerHTML = '';
  if (ext.tab === 'plugins') body.insertAdjacentHTML('beforeend', ext.view ? pluginViewHtml() : pluginsHtml());
  else if (!ext.project) body.insertAdjacentHTML('beforeend', '<p class="muted">Pilih project dulu.</p>');
  else if (ext.tab === 'agents') body.insertAdjacentHTML('beforeend', ext.editing ? agentFormHtml(ext.editing) : agentsHtml());
  else body.insertAdjacentHTML('beforeend', hooksHtml());
}

/** ℹ details or ⚙ userConfig options of one plugin, inside the same dialog (with a way back). */
function pluginViewHtml() {
  const v = ext.view;
  const back = `<div class="acct-actions"><button type="button" class="ghost" data-plugin-back>← Kembali</button><b>${escapeHtml(v.id)}</b></div>`;
  if (v.mode === 'details') return `${back}<pre class="cc-output">${escapeHtml(v.details || 'Memuat detail…')}</pre>`;
  if (!v.options) return `${back}<p class="muted">Memuat opsi…</p>`;
  const schema = v.options.schema && typeof v.options.schema === 'object' ? v.options.schema : {};
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const keys = Object.keys(props).slice(0, 50);
  if (!keys.length) return `${back}<p class="muted small">Plugin ini tidak punya opsi yang bisa diatur.</p>`;
  const choices = v.options.choices && typeof v.options.choices === 'object' ? v.options.choices : {};
  const inputs = v.options.inputs && typeof v.options.inputs === 'object' ? v.options.inputs : {};
  const configured = Array.isArray(v.options.configured) ? v.options.configured : [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = keys
    .map((key) => {
      const def = props[key] && typeof props[key] === 'object' ? props[key] : {};
      const set = configured.includes(key);
      const value = typeof inputs[key] === 'string' ? inputs[key] : '';
      const opts = Array.isArray(choices[key]) ? choices[key] : Array.isArray(def.enum) ? def.enum : null;
      const control = opts
        ? `<select data-opt="${escapeHtml(key)}">${opts
            .map((o) => {
              const val = typeof o === 'object' ? String(o.value ?? o.name ?? '') : String(o);
              const label = typeof o === 'object' ? String(o.label ?? o.name ?? val) : val;
              return `<option value="${escapeHtml(val)}"${val === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
            })
            .join('')}</select>`
        : `<input data-opt="${escapeHtml(key)}" value="${escapeHtml(value)}" placeholder="${set ? 'sudah diset (kosong = biarkan)' : required.has(key) ? 'wajib' : 'opsional'}" autocomplete="off" spellcheck="false" />`;
      return `<label class="oc-field"><span>${escapeHtml(def.title ?? key)}${required.has(key) ? ' *' : ''}${set ? ' · sudah diset' : ''}</span>${control}${def.description ? `<small class="muted">${escapeHtml(String(def.description).slice(0, 300))}</small>` : ''}</label>`;
    })
    .join('');
  const missing = Array.isArray(v.options.unconfigured) && v.options.unconfigured.length ? `<p class="muted small">Belum diset: ${v.options.unconfigured.map(escapeHtml).join(', ')}</p>` : '';
  return `${back}${missing}<form id="ext-plugin-config" class="oc-form">${fields}<p class="muted small">Nilai yang dikosongkan tidak diubah. Nilai sensitif yang sudah diset tidak pernah ditampilkan.</p><div class="acct-actions"><button class="primary">💾 Simpan opsi</button></div></form>`;
}

// ---------- plugins ----------

function pluginsHtml() {
  const p = ext.plugins;
  if (!p) return '<p class="muted">Memuat…</p>';
  const local = state.local;
  const installed = p.installed.length
    ? `<ul class="ext-list">${p.installed
        .map((x) => `<li data-id="${escapeHtml(x.id)}"><div><b>${escapeHtml(x.id)}</b> <small class="muted">v${escapeHtml(x.version)} · ${escapeHtml(x.scope)}</small></div><div class="ext-actions">${
          local ? `<button class="ghost" data-plugin-detail="${escapeHtml(x.id)}">ℹ Detail</button>${x.hasUserConfig ? `<button class="ghost" data-plugin-config="${escapeHtml(x.id)}">⚙ Opsi</button>` : ''}<button class="ghost" data-plugin="update" title="Perbarui ke versi terbaru dari marketplace">⬆ Update</button><button class="ghost" data-plugin="${x.enabled ? 'disable' : 'enable'}">${x.enabled ? '⏸ Nonaktifkan' : '▶ Aktifkan'}</button><button class="ghost danger-text" data-plugin="uninstall">Hapus</button>` : `<small class="muted">${x.enabled ? 'aktif' : 'nonaktif'}</small>`
        }</div></li>`)
        .join('')}</ul>`
    : '<p class="muted small">Belum ada plugin terpasang.</p>';
  const q = ext.filter.toLowerCase();
  const matches = q ? p.available.filter((x) => x.id.toLowerCase().includes(q) || x.description.toLowerCase().includes(q)) : p.available;
  const list = matches.slice(0, MAX_LIST);
  const marketplaces = (ext.marketplaces ?? [])
    .map((m) => `<li data-mp="${escapeHtml(m.name)}"><div><b>${escapeHtml(m.name)}</b> <small class="muted">${escapeHtml(m.repo || m.source || '')}</small></div><div class="ext-actions">${local ? `<button class="ghost" data-mp-update="${escapeHtml(m.name)}">↻ Update</button><button class="ghost danger-text" data-mp-remove="${escapeHtml(m.name)}">Hapus</button>` : ''}</div></li>`)
    .join('');
  return `<h3 class="ext-h">Terpasang</h3>${installed}
    <h3 class="ext-h">Marketplace terdaftar <small class="muted">${ext.marketplaces?.length ?? 0}</small></h3>
    ${marketplaces ? `<ul class="ext-list">${marketplaces}</ul>` : '<p class="muted small">Memuat marketplace…</p>'}
    ${local ? `<div class="acct-actions ext-mp-add"><input id="ext-mp-source" maxlength="500" placeholder="owner/repo atau https://…/marketplace.json" aria-label="Sumber marketplace baru" autocomplete="off" spellcheck="false" /><button type="button" class="ghost" data-mp-add>＋ Tambah marketplace</button></div>` : ''}
    <h3 class="ext-h">Katalog plugin <small class="muted">${p.available.length} plugin</small></h3>
    <input id="ext-filter" type="search" value="${escapeHtml(ext.filter)}" placeholder="Cari plugin: github, sentry, test, review…" aria-label="Cari plugin" autocomplete="off" />
    <ul class="ext-list">${list
      .map((x) => `<li data-id="${escapeHtml(x.id)}"><div><b>${escapeHtml(x.name)}</b> <small class="muted">${escapeHtml(x.id.split('@')[1] ?? '')}</small><p class="muted small">${escapeHtml(x.description)}</p></div><div class="ext-actions">${local ? '<button class="primary" data-plugin="install">Pasang</button>' : ''}</div></li>`)
      .join('')}</ul>
    ${matches.length > MAX_LIST ? `<p class="muted small">${matches.length - MAX_LIST} lainnya: persempit pencarian.</p>` : ''}
    ${local ? '' : '<p class="muted small">Memasang/menghapus plugin hanya dari laptop (plugin menjalankan kode di laptop).</p>'}`;
}

/** ℹ component inventory + token cost of one plugin (text from the CLI). */
async function openPluginDetails(id) {
  ext.view = { id, mode: 'details', details: '' };
  render();
  try {
    ext.view.details = (await api('/api/claude/plugins/details', { id })).text;
  } catch (err) {
    ext.view.details = err.message;
  }
  render();
}

/** ⚙ userConfig options; saving sends only the fields the user filled in (empty = keep). */
async function openPluginConfig(id) {
  ext.view = { id, mode: 'config', options: null };
  render();
  try {
    ext.view.options = await api('/api/claude/plugins/configure', { id });
  } catch (err) {
    ext.view = null;
    toast(err.message, 'warn');
  }
  render();
}

/** 🏪 add / remove / update one marketplace; the returned list replaces the rendered one. */
async function marketplaceAct(action, { source = '', name = '' } = {}) {
  if (action === 'remove' && !window.confirm(`Hapus marketplace ${name}? Plugin yang sudah terpasang tetap ada.`)) return;
  if (action === 'add') {
    source = $('#ext-mp-source')?.value.trim() ?? source;
    if (!source) return toast('Isi URL atau owner/repo marketplace dulu.', 'warn');
    if (!window.confirm(`Tambah marketplace ${source}?\n\nMarketplace menentukan plugin yang bisa dipasang; pasang hanya dari sumber yang kamu percaya.`)) return;
  }
  try {
    const r = await api('/api/claude/plugins/marketplace-action', { action, source, name });
    ext.marketplaces = r.marketplaces ?? [];
    ext.plugins = null; // the catalog may have changed
    toast(`Marketplace ${action === 'add' ? 'ditambahkan' : action === 'remove' ? 'dihapus' : 'diperbarui'}.`, 'ok');
    load(true);
  } catch (err) {
    toast(err.message, 'warn');
  }
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
    toast({ install: `Plugin ${id} terpasang.`, uninstall: `Plugin ${id} dihapus.`, enable: `Plugin ${id} diaktifkan.`, disable: `Plugin ${id} dinonaktifkan.`, update: `Plugin ${id} diperbarui.` }[action], 'ok');
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
  // A user-scope subagent lives in ~/.claude/agents and steers every project: routes/extensions.js refuses to write
  // it from anything but the laptop. A paired phone may still manage this project's own agents.
  const local = state.local !== false;
  const rows = ext.agents.length
    ? `<ul class="ext-list">${ext.agents
        .map((a, i) => `<li><div><b>${escapeHtml(a.name)}</b> <small class="muted">${a.scope === 'user' ? 'semua project' : 'project ini'}${a.model ? ` · ${escapeHtml(a.model)}` : ''}</small><p class="muted small">${escapeHtml(a.description)}</p></div><div class="ext-actions">${
          local || a.scope !== 'user'
            ? `<button class="ghost" data-agent-edit="${i}">✎ Edit</button><button class="ghost danger-text" data-agent-del="${i}">Hapus</button>`
            : '<small class="muted">ubah dari laptop</small>'
        }</div></li>`)
        .join('')}</ul>`
    : '<p class="muted small">Belum ada subagent buatan sendiri.</p>';
  return `<p class="muted small">Subagent di <code>.claude/agents</code> (project) dan <code>~/.claude/agents</code> (semua project). Claude memanggilnya sesuai deskripsinya, seperti /agents di terminal. Role kantor (/team) terpisah.</p>
    ${local ? '' : '<p class="muted small">🔒 Subagent untuk <b>semua project</b> hanya bisa diubah dari laptop; subagent project ini tetap bisa dari sini.</p>'}
    ${rows}<div class="acct-actions"><button class="primary" data-agent-new>＋ Agent baru</button></div>`;
}

function agentFormHtml(a) {
  const local = state.local !== false;
  return `<form id="ext-agent-form" class="oc-form">
    <label class="oc-field"><span>Nama * (huruf kecil, angka, minus)</span><input name="name" value="${escapeHtml(a.name ?? '')}" required pattern="[a-z0-9][a-z0-9\\-]{0,49}" placeholder="code-reviewer" autocomplete="off" /></label>
    <label class="oc-field"><span>Berlaku untuk</span><select name="scope">${
      local
        ? `<option value="project"${a.scope !== 'user' ? ' selected' : ''}>Project ini</option><option value="user"${a.scope === 'user' ? ' selected' : ''}>Semua project</option>`
        : '<option value="project" selected>Project ini</option>'
    }</select>${local ? '' : '<small class="muted">Subagent semua project diubah dari laptop.</small>'}</label>
    <label class="oc-field"><span>Deskripsi * (kapan Claude memakainya)</span><input name="description" value="${escapeHtml(a.description ?? '')}" required placeholder="Review kode setelah perubahan selesai" /></label>
    <label class="oc-field"><span>Tools (kosong = semua)</span><input name="tools" value="${escapeHtml(a.tools ?? '')}" placeholder="Read, Grep, Glob" autocomplete="off" /></label>
    <label class="oc-field"><span>Model (kosong = ikut sesi)</span><input name="model" value="${escapeHtml(a.model ?? '')}" placeholder="sonnet, opus, haiku, inherit" autocomplete="off" /></label>
    <label class="oc-field"><span>Instruksi (system prompt) *</span><textarea name="prompt" rows="10" class="memory-text" required>${escapeHtml(a.prompt ?? '')}</textarea></label>
    <div class="acct-actions"><button type="button" class="ghost" data-agent-cancel>Batal</button><button class="primary">💾 Simpan agent</button></div>
  </form>`;
}

// ---------- hooks ----------

const FALLBACK_HOOK_EVENTS = ['SessionStart', 'Setup', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd', 'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'FileChanged', 'CwdChanged', 'DirectoryAdded'];
const isLocal = () => state.local !== false;
const hookEventOptions = () => (ext.hookEvents.length ? ext.hookEvents : FALLBACK_HOOK_EVENTS);
const flatHooks = () => ext.hooks.flatMap((h) => (h.handlers ?? []).map((handler) => ({ ...h, ...handler })));

function hooksHtml() {
  if (ext.hookEditing) return hookFormHtml(ext.hookEditing);
  const rows = flatHooks();
  const list = rows.length
    ? `<ul class="ext-list">${rows
        .map((h, i) => {
          const command = h.type === 'command';
          const label = command ? `<pre class="cc-output">${escapeHtml(h.command)}${h.timeout !== undefined ? ` <small class="muted">· ${h.timeout} dtk</small>` : ''}</pre>` : `<p class="muted small">${escapeHtml(h.label ?? h.type)} — atur handler ini lewat editor JSON.</p>`;
          const actions = command && (isLocal() || h.scope !== 'user')
            ? `<button type="button" class="ghost" data-hook-edit="${i}">✎ Edit</button><button type="button" class="ghost danger-text" data-hook-del="${i}">Hapus</button>`
            : command
              ? '<small class="muted">ubah dari laptop</small>'
              : '';
          return `<li><div><b>${escapeHtml(h.event)}${h.matcher ? ` <small class="muted">${escapeHtml(h.matcher)}</small>` : ''}</b> <small class="muted">${escapeHtml(h.source)}</small>${label}</div><div class="ext-actions">${actions}</div></li>`;
        })
        .join('')}</ul>`
    : '<p class="muted small">Belum ada hooks di settings.json (user, project, pribadi).</p>';
  return `<p class="muted small">Hooks menjalankan perintah otomatis di titik tertentu (mis. sebelum tool dipakai). Berlaku mulai sesi berikutnya.</p>
    ${isLocal() ? '' : '<p class="muted small">🔒 Hook untuk <b>semua project</b> hanya bisa diubah dari laptop.</p>'}
    ${list}<div class="acct-actions"><button type="button" class="primary" id="hook-new">＋ Hook</button></div>`;
}

function hookFormHtml(h) {
  return `<form id="hook-form" class="oc-form">
    <div class="oc-form-grid">
      <label class="oc-field"><span>Event</span><input name="event" list="hook-events" required value="${escapeHtml(h.event ?? '')}" placeholder="PreToolUse" autocomplete="off" /></label>
      <label class="oc-field"><span>Matcher (opsional)</span><input name="matcher" maxlength="200" value="${escapeHtml(h.matcher ?? '')}" placeholder="Edit" autocomplete="off" /></label>
    </div>
    <label class="oc-field"><span>Berlaku untuk</span><select name="scope">
      <option value="local"${h.scope === 'local' ? ' selected' : ''}>Project ini, pribadi (settings.local.json)</option>
      <option value="project"${h.scope === 'project' ? ' selected' : ''}>Project ini, bersama (settings.json)</option>
      ${isLocal() ? `<option value="user"${h.scope === 'user' ? ' selected' : ''}>Semua project (~/.claude)</option>` : ''}
    </select></label>
    <label class="oc-field"><span>Perintah</span><textarea name="command" rows="3" required>${escapeHtml(h.command ?? '')}</textarea></label>
    <label class="oc-field"><span>Timeout (detik, opsional)</span><input name="timeout" type="number" min="0" max="3600" step="1" value="${h.timeout ?? ''}" /></label>
    <datalist id="hook-events">${hookEventOptions().map((e) => `<option value="${e}"></option>`).join('')}</datalist>
    <div class="acct-actions"><button type="button" class="ghost" data-hook-cancel>Batal</button><button type="submit" class="primary">💾 Simpan hook</button></div>
  </form>`;
}

export function initExtensions() {
  // Settings → 🧩 Plugin: the same dialog as /plugin, on whichever engine the active project runs.
  $('#plugins-open')?.addEventListener('click', () => openExtensions('plugins'));
  $('#ext-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]')?.dataset.tab;
    if (!tab || tab === ext.tab) return;
    ext.tab = tab;
    ext.editing = null;
    ext.view = null;
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
    if (t.closest('[data-mp-add]')) return marketplaceAct('add');
    const mpUpdate = t.closest('[data-mp-update]');
    if (mpUpdate) return marketplaceAct('update', { name: mpUpdate.dataset.mpUpdate });
    const mpRemove = t.closest('[data-mp-remove]');
    if (mpRemove) return marketplaceAct('remove', { name: mpRemove.dataset.mpRemove });
    const detail = t.closest('[data-plugin-detail]');
    if (detail) return openPluginDetails(detail.dataset.pluginDetail);
    const config = t.closest('[data-plugin-config]');
    if (config) return openPluginConfig(config.dataset.pluginConfig);
    if (t.closest('[data-plugin-back]')) {
      ext.view = null;
      render();
      return;
    }
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
    if (t.closest('#hook-new')) return (ext.hookEditing = { scope: 'local', event: '', matcher: '', command: '', timeout: '' }), render();
    if (t.closest('[data-hook-cancel]')) return (ext.hookEditing = null), render();
    const hookEdit = t.closest('[data-hook-edit]');
    if (hookEdit) return (ext.hookEditing = flatHooks()[Number(hookEdit.dataset.hookEdit)]), render();
    const hookDel = t.closest('[data-hook-del]');
    if (hookDel) {
      const h = flatHooks()[Number(hookDel.dataset.hookDel)];
      if (!window.confirm(`Hapus hook ${h.event}${h.matcher ? `:${h.matcher}` : ''}?\n\n${h.command}`)) return;
      try {
        await api(`/api/projects/${ext.project}/hooks/delete`, { scope: h.scope, event: h.event, matcher: h.matcher, command: h.command });
        toast(`Hook ${h.event} dihapus.`, 'ok');
        load();
      } catch (err) {
        toast(err.message, 'warn');
      }
    }
  });
  $('#ext-body').addEventListener('submit', async (e) => {
    if (e.target.id === 'ext-plugin-config') {
      e.preventDefault();
      const id = ext.view?.id;
      if (!id) return;
      const values = {};
      for (const el of e.target.querySelectorAll('[data-opt]')) if (el.value !== '') values[el.dataset.opt] = el.value;
      try {
        const r = await api('/api/claude/plugins/configure', { id, values });
        toast(`Opsi ${id} disimpan${r.unconfigured?.length ? ` · belum diset: ${r.unconfigured.join(', ')}` : ''}. Berlaku setelah Claude Code dimulai ulang.`, 'ok');
        await openPluginConfig(id);
      } catch (err) {
        toast(err.message, 'warn');
      }
      return;
    }
    if (e.target.id === 'hook-form') {
      e.preventDefault();
      const f = e.target.elements;
      const body = { scope: f.scope.value, event: f.event.value.trim(), matcher: f.matcher.value.trim(), command: f.command.value.trim(), timeout: f.timeout.value };
      try {
        await api(`/api/projects/${ext.project}/hooks/save`, body);
        toast(`Hook ${body.event} tersimpan. Berlaku mulai sesi berikutnya.`, 'ok');
        ext.hookEditing = null;
        load();
      } catch (err) {
        toast(err.message, 'warn');
      }
      return;
    }
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
