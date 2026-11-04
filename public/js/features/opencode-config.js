// OpenCode config/agent editor (server: src/opencode-config.js): a form for model + agents, or the raw file text.
// Laptop only (the route is in LOCAL_ONLY). A save validates first and the server keeps a .bak-<time> copy.
import { api, toast } from '../core/api.js';
import { $, escapeHtml } from '../core/dom.js';
import { DEMO_ID, state } from '../core/state.js';
import { openModal } from '../ui/modals.js';

const editor = { scope: 'project', mode: 'form', view: null, busy: false };
const MODES = ['primary', 'subagent', 'all'];

const agentRow = (agent = {}) => {
  const name = agent.name ?? '';
  const mode = MODES.includes(agent.mode) ? agent.mode : '';
  return `<div class="oc-agent" data-agent-row>
    <div class="oc-agent-head"><b>Agent</b><button type="button" class="ghost danger-text" data-agent-remove aria-label="Hapus agent ${escapeHtml(name || 'baru')}">Hapus</button></div>
    <div class="oc-agent-grid">
      <label class="oc-field"><span>Nama</span><input data-agent="name" type="text" maxlength="64" autocomplete="off" spellcheck="false" value="${escapeHtml(name)}" placeholder="reviewer" /></label>
      <label class="oc-field"><span>Mode</span><select data-agent="mode">
        <option value=""${mode ? '' : ' selected'}>bawaan</option>
        <option value="primary"${mode === 'primary' ? ' selected' : ''}>primary</option>
        <option value="subagent"${mode === 'subagent' ? ' selected' : ''}>subagent</option>
        <option value="all"${mode === 'all' ? ' selected' : ''}>all</option>
      </select></label>
      <label class="oc-field"><span>Model</span><input data-agent="model" type="text" maxlength="200" autocomplete="off" spellcheck="false" value="${escapeHtml(agent.model ?? '')}" placeholder="provider/model (opsional)" /></label>
      <label class="oc-field"><span>Deskripsi</span><input data-agent="description" type="text" maxlength="500" autocomplete="off" value="${escapeHtml(agent.description ?? '')}" placeholder="opsional" /></label>
      <label class="oc-field oc-field-wide"><span>Prompt / system</span><textarea data-agent="prompt" rows="3" maxlength="20000" spellcheck="false" placeholder="Instruksi agent (opsional)">${escapeHtml(agent.prompt ?? '')}</textarea></label>
    </div>
  </div>`;
};

const renderAgents = (agents = []) => {
  $('#oc-agent-list').innerHTML = agents.length ? agents.map(agentRow).join('') : '<p class="muted small">Belum ada agent khusus.</p>';
};

const renderView = () => {
  const view = editor.view;
  if (!view) return;
  $('#oc-config-path').textContent = `${view.path} - ${view.exists ? view.format.toUpperCase() : 'file baru'}`;
  $('#oc-config-path').title = view.path;
  $('#oc-model').value = typeof view.config?.model === 'string' ? view.config.model : '';
  $('#oc-small-model').value = typeof view.config?.small_model === 'string' ? view.config.small_model : '';
  renderAgents(view.agents);
  $('#oc-json-text').value = view.text || '{\n}\n';
  $('#oc-config-error').textContent = view.parseError ?? '';
  if (view.parseError) setMode('json'); // the raw file is the only way to repair it
  const jsonc = view.format === 'jsonc';
  $('#oc-config-note').innerHTML = jsonc
    ? 'File ini JSONC: tab <b>JSON</b> mempertahankan komentar, simpan lewat <b>Form</b> menulis JSON biasa. File lama tetap dibackup.'
    : 'File lama disimpan sebagai <code>.bak-&lt;waktu&gt;</code> sebelum ditimpa.';
};

const setScope = (scope) => {
  editor.scope = scope;
  for (const [id, value] of [['#oc-scope-project', 'project'], ['#oc-scope-global', 'global']]) {
    const on = value === scope;
    $(id).classList.toggle('on', on);
    $(id).setAttribute('aria-selected', String(on));
  }
};

const setMode = (mode) => {
  editor.mode = mode;
  const form = mode === 'form';
  $('#oc-form-panel').hidden = !form;
  $('#oc-json-panel').hidden = form;
  for (const [id, value] of [['#oc-mode-form', 'form'], ['#oc-mode-json', 'json']]) {
    const on = value === mode;
    $(id).classList.toggle('on', on);
    $(id).setAttribute('aria-selected', String(on));
  }
};

const setBusy = (busy) => {
  editor.busy = busy;
  $('#oc-config-save').disabled = busy || !editor.view;
  $('#oc-config-reload').disabled = busy;
  $('#oc-scope-project').disabled = busy || !state.active || state.active === DEMO_ID;
  $('#oc-scope-global').disabled = busy;
  $('#oc-agent-add').disabled = busy;
};

async function load() {
  if (editor.busy) return;
  if (editor.scope === 'project' && (!state.active || state.active === DEMO_ID)) {
    setScope('global');
    return load();
  }
  setBusy(true);
  $('#oc-config-error').textContent = '';
  $('#oc-config-path').textContent = 'Memuat config…';
  try {
    editor.view = await api('/api/opencode-config', { scope: editor.scope, projectId: state.active });
    renderView();
  } catch (err) {
    editor.view = null;
    $('#oc-config-path').textContent = 'Gagal memuat config.';
    $('#oc-config-error').textContent = err.message;
  } finally {
    setBusy(false);
  }
}

const collectAgents = () => {
  const out = [];
  for (const row of document.querySelectorAll('#oc-agent-list .oc-agent')) {
    const value = (key) => row.querySelector(`[data-agent="${key}"]`)?.value ?? '';
    const agent = {
      name: value('name').trim(),
      mode: value('mode').trim(),
      model: value('model').trim(),
      description: value('description').trim(),
      prompt: value('prompt'),
    };
    if (!agent.name && !agent.mode && !agent.model && !agent.description && !agent.prompt.trim()) continue;
    out.push(agent);
  }
  return out;
};

async function save() {
  if (editor.busy || !editor.view) return;
  setBusy(true);
  $('#oc-config-error').textContent = '';
  const body = { scope: editor.scope, projectId: state.active, mode: editor.mode };
  if (editor.mode === 'form') {
    body.form = {
      model: $('#oc-model').value.trim(),
      smallModel: $('#oc-small-model').value.trim(),
      agents: collectAgents(),
    };
  } else {
    body.text = $('#oc-json-text').value;
  }
  try {
    const reply = await api('/api/opencode-config/save', body);
    editor.view = reply;
    renderView();
    toast(`Config OpenCode disimpan${reply.backup ? ' (backup dibuat)' : ''}.${reply.restarted ? ` ${reply.restarted} sesi OpenCode idle dimuat ulang.` : ''}`, 'ok');
  } catch (err) {
    $('#oc-config-error').textContent = err.message;
  } finally {
    setBusy(false);
  }
}

export function initOpenCodeConfig() {
  $('#oc-config-open').addEventListener('click', async () => {
    setScope(state.active && state.active !== DEMO_ID ? 'project' : 'global');
    setMode('form');
    openModal('oc-config-modal');
    await load();
  });
  $('#oc-scope-project').addEventListener('click', async () => {
    if (editor.busy || !state.active || state.active === DEMO_ID) return;
    setScope('project');
    await load();
  });
  $('#oc-scope-global').addEventListener('click', async () => {
    if (editor.busy) return;
    setScope('global');
    await load();
  });
  $('#oc-mode-form').addEventListener('click', () => setMode('form'));
  $('#oc-mode-json').addEventListener('click', () => setMode('json'));
  $('#oc-agent-add').addEventListener('click', () => {
    if (editor.busy) return;
    const list = $('#oc-agent-list');
    if (list.querySelector('.muted')) list.innerHTML = '';
    list.insertAdjacentHTML('beforeend', agentRow());
    list.querySelector('.oc-agent:last-child [data-agent="name"]')?.focus();
  });
  $('#oc-agent-list').addEventListener('click', (e) => {
    const remove = e.target.closest('[data-agent-remove]');
    if (!remove || editor.busy) return;
    const row = remove.closest('.oc-agent');
    row?.remove();
    if (!document.querySelector('#oc-agent-list .oc-agent')) renderAgents([]);
  });
  $('#oc-config-reload').addEventListener('click', load);
  $('#oc-config-save').addEventListener('click', save);
}
