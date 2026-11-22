// 📝 Commands OpenCode (server: src/routes/opencode-commands.js, src/opencode-commands.js): one Markdown file per
// slash command in `.opencode/commands` (project) or the global config folder. The dialog opens from the OpenCode
// config editor; a command for every project is written from the laptop only, like a global skill.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, projectName, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';
import { projectEngine } from './engine.js';

const oc = { project: null, commands: [], roots: [], editing: null, busy: false, error: '' };

const isLocal = () => state.local !== false;
const sourceLabel = (scope) => (scope === 'user' ? 'semua project' : 'project ini');

function render() {
  $('#oc-commands-project').textContent = oc.project ? `· ${projectName(oc.project)}` : '';
  $('#oc-commands-body').innerHTML = oc.editing ? formHtml() : listHtml();
}

function listHtml() {
  const rows = oc.commands.length
    ? `<ul class="ext-list" id="oc-command-list">${oc.commands
        .map(
          (command) => `<li data-cmd-row="${escapeHtml(command.id)}" data-cmd-scope="${escapeHtml(command.scope)}" data-cmd-source="${escapeHtml(command.source)}"><div><b>/${escapeHtml(command.id)}</b> <span class="pill">${escapeHtml(sourceLabel(command.scope))}</span><p class="muted small">${escapeHtml(command.description || '(tanpa deskripsi)')}${command.agent ? ` · agent ${escapeHtml(command.agent)}` : ''}${command.subagent === true ? ' · subagent' : ''}</p></div><div class="ext-actions">${
            isLocal() || command.scope !== 'user'
              ? `<button type="button" class="ghost" data-cmd-edit="${escapeHtml(command.id)}">✎ Edit</button><button type="button" class="ghost danger-text" data-cmd-delete="${escapeHtml(command.id)}">Hapus</button>`
              : '<small class="muted">ubah dari laptop</small>'
          }</div></li>`,
        )
        .join('')}</ul>`
    : '<p class="muted small">Belum ada command.</p>';
  return `<p class="muted small">Command = file Markdown di <code>.opencode/commands</code> (project) atau folder config OpenCode global (semua project). Nama file menjadi nama command; folder bersarang menjadi <code>/team/deploy</code>. Template memakai <code>$ARGUMENTS</code>, <code>$1</code>, … dan <code>!\`cmd\`</code>; OpenCode memuat ulang otomatis.</p>
    ${isLocal() ? '' : '<p class="muted small">🔒 Command untuk <b>semua project</b> hanya bisa diubah dari laptop; command project ini tetap bisa dari sini.</p>'}
    ${rows}<div class="acct-actions"><button type="button" class="primary" id="oc-command-new">＋ Command baru</button></div>`;
}

function formHtml() {
  const e = oc.editing;
  return `<form id="oc-command-form" class="oc-form">
    <p class="muted small">${e.id ? 'Ubah command. Mengganti nama memindahkan file-nya.' : 'Command baru disimpan sebagai file Markdown baru.'}</p>
    <div class="oc-form-grid">
      <label class="oc-field"><span>Nama command * (huruf/angka, -, _, titik; boleh <code>team/deploy</code>)</span><input id="oc-command-id" required maxlength="200" autocomplete="off" spellcheck="false" value="${escapeHtml(e.id ?? '')}" placeholder="review" /></label>
      <label class="oc-field"><span>Berlaku untuk</span><select id="oc-command-scope"${e.id ? ' disabled' : ''}>
        <option value="project"${e.scope !== 'user' ? ' selected' : ''}>Project ini</option>
        ${isLocal() ? `<option value="user"${e.scope === 'user' ? ' selected' : ''}>Semua project</option>` : ''}
      </select>${e.id ? '<small class="muted">Scope tidak bisa dipindah saat mengedit; buat command baru untuk scope lain.</small>' : ''}</label>
    </div>
    <label class="oc-field"><span>Deskripsi</span><input id="oc-command-description" maxlength="500" autocomplete="off" value="${escapeHtml(e.description ?? '')}" placeholder="Kapan command ini dipakai" /></label>
    <div class="oc-form-grid">
      <label class="oc-field"><span>Agent (opsional)</span><input id="oc-command-agent" maxlength="200" autocomplete="off" value="${escapeHtml(e.agent ?? '')}" placeholder="build" /></label>
      <label class="oc-field"><span>Model (opsional, <code>provider/model#variant</code>)</span><input id="oc-command-model" maxlength="200" autocomplete="off" value="${escapeHtml(e.model ?? '')}" placeholder="openai/gpt-5#high" /></label>
    </div>
    <label class="oc-field"><span>Jalankan sebagai subagent latar</span><input id="oc-command-subagent" type="checkbox"${e.subagent === true ? ' checked' : ''} /></label>
    <label class="oc-field"><span>Template *</span><textarea id="oc-command-template" class="memory-text" rows="10" spellcheck="false" required>${escapeHtml(e.template ?? '')}</textarea></label>
    <p class="muted small">Salinan lama disimpan di folder data aplikasi sebelum ditimpa.</p>
    <p id="oc-command-error" class="field-error" role="alert">${escapeHtml(oc.error)}</p>
    <div class="acct-actions"><button type="button" class="ghost" id="oc-command-cancel">Batal</button><button type="submit" class="primary" id="oc-command-save">💾 Simpan</button></div>
  </form>`;
}

async function load() {
  try {
    const data = await api(`/api/projects/${oc.project}/opencode-commands`);
    oc.commands = data.commands ?? [];
    oc.roots = data.roots ?? [];
    oc.error = '';
    render();
  } catch (err) {
    $('#oc-commands-body').innerHTML = `<p class="state-error">${escapeHtml(err.message)}</p>`;
  }
}

export async function openOpenCodeCommands() {
  if (!state.active || state.active === DEMO_ID) return toast('Pilih project dulu.');
  if (state.readOnly) return toast('Commands OpenCode hanya bisa dibuka dari laptop atau lewat Tailscale.', 'warn');
  if (projectEngine() !== 'opencode') return toast('Commands OpenCode hanya tersedia saat OpenCode aktif.', 'warn');
  oc.project = state.active;
  oc.commands = [];
  oc.editing = null;
  oc.error = '';
  openModal('oc-commands-modal');
  render();
  await load();
}

async function edit(id, scope, source) {
  try {
    const { command: full } = await api(`/api/projects/${oc.project}/opencode-commands/read`, { scope, source, id });
    oc.editing = { ...full, previous: full.id, scope, source };
    oc.error = '';
    render();
  } catch (err) {
    toast(err.message, 'warn');
  }
}

async function remove(command) {
  if (!window.confirm(`Hapus command /${command.id}? Salinan lama disimpan di folder data aplikasi.`)) return;
  try {
    await api(`/api/projects/${oc.project}/opencode-commands/delete`, { scope: command.scope, source: command.source, id: command.id, mtime: command.mtime });
    toast(`Command /${command.id} dihapus.`, 'ok');
    await load();
  } catch (err) {
    toast(err.message, 'warn');
  }
}

async function save() {
  if (oc.busy || !oc.editing) return;
  const id = $('#oc-command-id').value.trim();
  const scope = $('#oc-command-scope').value === 'user' ? 'user' : 'project';
  const body = {
    scope,
    source: oc.editing.source,
    id,
    previous: oc.editing.previous ?? null,
    description: $('#oc-command-description').value,
    agent: $('#oc-command-agent').value,
    model: $('#oc-command-model').value,
    subagent: $('#oc-command-subagent').checked,
    template: $('#oc-command-template').value,
    mtime: oc.editing.previous ? oc.editing.mtime : null,
  };
  oc.busy = true;
  oc.error = '';
  try {
    await api(`/api/projects/${oc.project}/opencode-commands/save`, body);
    toast(`Command "${id}" tersimpan.`, 'ok');
    oc.editing = null;
    await load();
  } catch (err) {
    oc.error = err.message;
    $('#oc-command-error').textContent = err.message;
  } finally {
    oc.busy = false;
  }
}

export function initOpenCodeCommands() {
  $('#oc-commands-open').addEventListener('click', openOpenCodeCommands);
  $('#oc-commands-refresh').addEventListener('click', load);
  $('#oc-commands-body').addEventListener('click', (e) => {
    const editButton = e.target.closest('[data-cmd-edit]');
    if (editButton) {
      const row = editButton.closest('li');
      return edit(editButton.dataset.cmdEdit, row?.dataset.cmdScope, row?.dataset.cmdSource);
    }
    const del = e.target.closest('[data-cmd-delete]');
    if (del) {
      const row = del.closest('li');
      const command = oc.commands.find((entry) => entry.id === del.dataset.cmdDelete && entry.scope === row?.dataset.cmdScope);
      if (command) return remove(command);
    }
    if (e.target.closest('#oc-command-new')) {
      oc.editing = { id: '', scope: 'project', source: undefined, description: '', agent: '', model: '', subagent: false, template: '', previous: null, mtime: null };
      oc.error = '';
      return render();
    }
    if (e.target.closest('#oc-command-cancel')) {
      oc.editing = null;
      oc.error = '';
      return render();
    }
  });
  $('#oc-commands-body').addEventListener('submit', (e) => {
    if (e.target.id !== 'oc-command-form') return;
    e.preventDefault();
    save();
  });
}
